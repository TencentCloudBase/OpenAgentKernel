/**
 * CloudBase 内置 MCP 工具集（PR #6.5）
 *
 * 在已 acquire 的沙箱实例内：
 *   1. PUT /api/workspace/env  注入用户租户凭证
 *   2. bash 跑 `mcporter list cloudbase --schema --output json`  发现工具
 *   3. JSON Schema → zod raw shape  转换
 *   4. 用 createSdkMcpServer / sdkTool 包装  暴露为 `mcp__cloudbase__*`
 *   5. 工具调用时：bash 跑 `mcporter call cloudbase.{tool} '{...args}'`
 *   6. 检测到凭证错误 → 重新注入凭证 → 重试一次
 *
 * 不做（业务层职责）：
 *   - cron 定时任务（依赖业务 DB + 调度器单例）
 *   - publishMiniprogram（依赖业务私钥存储）
 *   - artifact 持久化（依赖业务 UI / DB）
 *   - login 工具（用自动重试代替）
 *
 * 协议参考：OpenVibeCoding feature/stateful-infra
 *   packages/server/src/sandbox/stateful/stateful-mcp-client.ts
 */

import { createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { SandboxError } from '../internal/errors.js'
import type { SandboxInstance } from './types.js'

/** 沙箱内默认工作目录（参考 stateful-infra STATEFUL_WORKSPACE_ROOT） */
const DEFAULT_WORKSPACE_ROOT = '/home/user'

/** 拉取 cloudbase 工具 schema 的 bash 超时 */
const SCHEMA_DISCOVERY_TIMEOUT_MS = 30_000

/** 单次 mcporter call 的默认超时 */
const DEFAULT_MCPORTER_TIMEOUT_MS = 60_000

/** schema 拉取重试次数（沙箱启动早期可能 mcporter 还没就绪） */
const SCHEMA_DISCOVERY_MAX_ATTEMPTS = 3
const SCHEMA_DISCOVERY_RETRY_DELAY_MS = 3000

// ─── Public types ─────────────────────────────────────────────────────

/**
 * 用户租户的 CloudBase 凭证。
 * 与 SandboxUserCredentials 同构，但内部独立避免循环依赖。
 */
export interface CloudBaseUserCredentials {
  envId: string
  secretId: string
  secretKey: string
  sessionToken?: string
}

export interface CreateCloudBaseMcpOptions {
  /** 沙箱实例（已 acquire） */
  sandbox: SandboxInstance
  /**
   * 异步获取用户凭证。每次需要注入或重试时调用一次（业务可在这里换最新凭证）。
   */
  getCredentials: () => Promise<CloudBaseUserCredentials>
  /** 沙箱内工作目录（用于 INTEGRATION_IDE / WORKSPACE_FOLDER_PATHS 等环境变量） */
  workspaceFolderPaths?: string
  /** 透传给沙箱里 cloudbase-mcp 的 INTEGRATION_IDE 标识，默认 'open-agent-kernel' */
  integrationIde?: string
  /** 诊断日志回调（不传则按 OAK_DEBUG=1 走 console.error） */
  log?: (msg: string) => void
}

export interface CloudBaseMcpBundle {
  /** 进程内 SDK MCP server，可直接放到 Claude SDK options.mcpServers */
  server: ReturnType<typeof createSdkMcpServer>
  /** 实际注册的 cloudbase 工具数（0 表示 degraded 模式） */
  toolCount: number
  /** degraded 原因（toolCount === 0 时给出） */
  degradedReason?: string
}

// ─── JSON Schema → zod raw shape ──────────────────────────────────────

interface JsonSchemaProperty {
  type?: string
  description?: string
  enum?: string[]
  items?: JsonSchemaProperty
  properties?: Record<string, JsonSchemaProperty>
  required?: string[]
}

interface JsonSchemaObject {
  type?: string
  properties?: Record<string, JsonSchemaProperty>
  required?: string[]
}

/**
 * 把 cloudbase-mcp 返回的 JSON Schema 转为 zod raw shape。
 *
 * 直接照搬 stateful-infra 的实现，cloudbase 工具的 schema 都是简单类型（string / number /
 * boolean / array / object / enum），不涉及复杂组合式校验，转换成本低。
 */
function jsonSchemaToZodRawShape(schema: JsonSchemaObject | undefined): Record<string, z.ZodTypeAny> {
  if (!schema || schema.type !== 'object' || !schema.properties) return {}
  const shape: Record<string, z.ZodTypeAny> = {}
  const required = new Set(schema.required ?? [])
  for (const [key, propSchema] of Object.entries(schema.properties)) {
    let zodType = jsonSchemaPropertyToZod(propSchema)
    if (!required.has(key)) zodType = zodType.optional()
    shape[key] = zodType
  }
  return shape
}

function jsonSchemaPropertyToZod(propSchema: JsonSchemaProperty | undefined): z.ZodTypeAny {
  if (!propSchema) return z.any()
  const { type, description, enum: enumValues, items, properties, required } = propSchema
  let zodType: z.ZodTypeAny
  if (enumValues && Array.isArray(enumValues) && enumValues.length > 0) {
    zodType = z.enum(enumValues as [string, ...string[]])
  } else if (type === 'string') {
    zodType = z.string()
  } else if (type === 'number' || type === 'integer') {
    zodType = z.number()
  } else if (type === 'boolean') {
    zodType = z.boolean()
  } else if (type === 'array') {
    zodType = z.array(items ? jsonSchemaPropertyToZod(items) : z.any())
  } else if (type === 'object') {
    if (properties) {
      const shape: Record<string, z.ZodTypeAny> = {}
      const reqSet = new Set(required ?? [])
      for (const [k, v] of Object.entries(properties)) {
        let propType = jsonSchemaPropertyToZod(v)
        if (!reqSet.has(k)) propType = propType.optional()
        shape[k] = propType
      }
      zodType = z.object(shape)
    } else {
      zodType = z.record(z.string(), z.any())
    }
  } else {
    zodType = z.any()
  }
  if (description) zodType = zodType.describe(description)
  return zodType
}

// ─── Helpers ──────────────────────────────────────────────────────────

interface ToolApiResponse<T = unknown> {
  success: boolean
  result?: T
  error?: string
}

interface BashResult {
  stdout?: string
  stderr?: string
  exitCode?: number
  output?: string
  exit_code?: number
}

/**
 * 调沙箱 `/api/tools/{name}` 端点（与 sandbox-tools.ts 中的 apiCall 同语义，
 * 这里独立维护避免反向依赖）。
 */
async function apiCall<T = unknown>(
  sandbox: SandboxInstance,
  toolName: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs + 5_000)
  let res: Response
  try {
    res = await sandbox.request(`/api/tools/${toolName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new SandboxError(`${toolName} HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  let data: ToolApiResponse<T>
  try {
    data = (await res.json()) as ToolApiResponse<T>
  } catch (err) {
    throw new SandboxError(`${toolName} response is not JSON`, err)
  }
  if (!data.success) {
    throw new SandboxError(`${toolName} failed: ${data.error ?? '<no error>'}`)
  }
  return data.result as T
}

async function bashCall(
  sandbox: SandboxInstance,
  command: string,
  timeoutMs = DEFAULT_MCPORTER_TIMEOUT_MS,
): Promise<BashResult> {
  return apiCall<BashResult>(sandbox, 'bash', { command, timeout: timeoutMs }, timeoutMs)
}

/**
 * Shell 单引号转义：把字符串包成 bash 单引号字面量。
 *
 * mcporter call 的参数最终拼成 `mcporter call cloudbase.x(a: "v", b: 1)`，
 * 整个表达式作为一个参数传给 mcporter，所以外层用单引号包住整个表达式即可。
 */
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * 把 args 序列化成 mcporter call 的 fn-call 表达式：
 *   listDocuments(envId: "x", collection: "users")
 */
function serializeFnCall(toolName: string, args: Record<string, unknown>): string {
  const entries = Object.entries(args ?? {})
  if (entries.length === 0) return `cloudbase.${toolName}()`
  const parts = entries
    .map(([k, v]) => {
      if (v === undefined || v === null) return null
      if (typeof v === 'string') return `${k}: ${JSON.stringify(v)}`
      if (typeof v === 'boolean' || typeof v === 'number') return `${k}: ${v}`
      // object / array → JSON 字面量（mcporter 内部会 JSON.parse）
      return `${k}: ${JSON.stringify(v)}`
    })
    .filter((p): p is string => p !== null)
    .join(', ')
  return `cloudbase.${toolName}(${parts})`
}

/**
 * 检测 mcporter 输出是否是凭证错误。
 *
 * cloudbase-mcp 在凭证缺失/过期时会带这些关键字（参考 stateful-infra
 * stateful-mcp-client.ts isCredentialError）。
 */
function isCredentialError(output: string): boolean {
  return (
    output.includes('AUTH_REQUIRED') ||
    output.includes('The SecretId is not found') ||
    output.includes('SecretId is not found') ||
    output.includes('InvalidParameter.SecretIdNotFound') ||
    output.includes('AuthFailure')
  )
}

function defaultLog(msg: string): void {
  if (process.env.OAK_DEBUG === '1') {
    // eslint-disable-next-line no-console
    console.error(`[oak][cloudbase-mcp] ${msg}`)
  }
}

// ─── Credential injection ─────────────────────────────────────────────

async function injectCredentials(args: {
  sandbox: SandboxInstance
  credentials: CloudBaseUserCredentials
  workspaceFolderPaths: string
  integrationIde: string
}): Promise<void> {
  const { sandbox, credentials, workspaceFolderPaths, integrationIde } = args
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30_000)
  try {
    const res = await sandbox.request('/api/workspace/env', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        CLOUDBASE_ENV_ID: credentials.envId,
        TENCENTCLOUD_SECRETID: credentials.secretId,
        TENCENTCLOUD_SECRETKEY: credentials.secretKey,
        TENCENTCLOUD_SESSIONTOKEN: credentials.sessionToken ?? '',
        INTEGRATION_IDE: integrationIde,
        WORKSPACE_FOLDER_PATHS: workspaceFolderPaths,
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new SandboxError(`inject credentials HTTP ${res.status}: ${text.slice(0, 300)}`)
    }
    const data = (await res.json().catch(() => ({}))) as ToolApiResponse
    if (!data.success) {
      throw new SandboxError(`inject credentials failed: ${data.error ?? '<no error>'}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

// ─── Schema discovery ────────────────────────────────────────────────

interface CloudBaseToolDef {
  name: string
  description?: string
  inputSchema?: JsonSchemaObject
}

async function discoverCloudBaseTools(
  sandbox: SandboxInstance,
  log: (msg: string) => void,
): Promise<CloudBaseToolDef[]> {
  // 1. 先把 mcporter schema 写到 workspace 临时文件（不能用 /tmp，
  //    /api/tools/* 端点对绝对路径有 path traversal 拦截）
  // 2. 用 `dd | base64` 分段读回——为什么不用 /api/tools/read？
  //    - read 端点把每行加上 "N: " 行号前缀（破坏 JSON）
  //    - read 端点单次响应 50KB 截断
  //    - mcporter 输出的 JSON 内有 description 字段会"truncate to 2000 chars"，
  //      这个截断点恰好能打断 \\n 这样的 JSON 转义序列；走行号文本路径会污染合并逻辑
  //    用 base64 + 二进制分块读最干净。
  const tmpFile = '.oak-cb-schema.json'
  const writeRes = await bashCall(
    sandbox,
    `mcporter list cloudbase --schema --output json > ${tmpFile} 2>&1 && wc -c < ${tmpFile}`,
    SCHEMA_DISCOVERY_TIMEOUT_MS,
  )
  const sizeStr = String(writeRes.stdout ?? writeRes.output ?? '').trim()
  const totalBytes = parseInt(sizeStr, 10)
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    throw new SandboxError(`mcporter schema file size invalid: ${sizeStr.slice(0, 200)}`)
  }
  log(`mcporter schema size: ${totalBytes} bytes`)

  // 每块 22500 字节明文 → ~30000 字节 base64（< bash stdout 截断 ~45KB 限制）
  const CHUNK_BYTES = 22500
  const chunks: string[] = []
  for (let offset = 0; offset < totalBytes; offset += CHUNK_BYTES) {
    // dd skip/count 单位由 bs 决定。这里 bs=1 字节级精度，count=CHUNK_BYTES。
    // status=none 抑制 dd 自身写到 stderr 的统计信息，避免污染 stdout。
    // 把 base64 用 -w0 输出成单行，方便我们直接拼接。
    const cmd = `dd if=${tmpFile} bs=1 skip=${offset} count=${CHUNK_BYTES} status=none 2>/dev/null | base64 -w0`
    const r = await bashCall(sandbox, cmd, SCHEMA_DISCOVERY_TIMEOUT_MS)
    const b64 = String(r.stdout ?? r.output ?? '').trim()
    if (!b64) {
      throw new SandboxError(`schema chunk at offset ${offset} returned empty stdout`)
    }
    chunks.push(b64)
  }

  // 拼接 + base64 解码 → 完整 JSON 文本
  const decoded = Buffer.from(chunks.join(''), 'base64').toString('utf-8').trim()
  if (!decoded) {
    throw new SandboxError('mcporter schema decoded to empty string')
  }
  const jsonStart = decoded.indexOf('{')
  if (jsonStart < 0) {
    throw new SandboxError(`mcporter schema is not JSON: ${decoded.slice(0, 200)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(decoded.slice(jsonStart))
  } catch (err) {
    throw new SandboxError('mcporter schema is not valid JSON', err)
  }
  const tools = (parsed as { tools?: unknown }).tools
  if (!Array.isArray(tools)) {
    throw new SandboxError('mcporter schema missing "tools" array')
  }
  log(`discovered ${tools.length} cloudbase tools (${decoded.length} bytes decoded)`)
  return tools as CloudBaseToolDef[]
}

// ─── Tool wrapping ───────────────────────────────────────────────────

/**
 * 默认跳过的工具（业务层做或 kernel 不该越界）。
 */
const SKIP_TOOLS = new Set([
  'logout', // 不暴露：会清掉沙箱里凭证，与 kernel 自动注入冲突
  'login', // 不暴露：用自动重试机制代替
  'interactiveDialog', // 不暴露：依赖业务 UI
])

interface CallCloudBaseToolArgs {
  sandbox: SandboxInstance
  toolName: string
  args: Record<string, unknown>
  reInjectCredentials: () => Promise<void>
  log: (msg: string) => void
}

/**
 * 调一次 cloudbase 工具：
 *   1. mcporter call → 取 stdout
 *   2. 凭证错误检测 → re-inject → 再调一次
 *   3. 仍失败则把 stdout 原样返回，让模型看到错误描述
 */
async function callCloudBaseTool(args: CallCloudBaseToolArgs): Promise<string> {
  const { sandbox, toolName, args: toolArgs, reInjectCredentials, log } = args
  const expr = serializeFnCall(toolName, toolArgs)
  const cmd = `mcporter call ${shellSingleQuote(expr)} 2>&1`

  const exec = async (): Promise<string> => {
    const r = await bashCall(sandbox, cmd, DEFAULT_MCPORTER_TIMEOUT_MS)
    return String(r.stdout ?? r.output ?? '')
  }

  let output = await exec()
  if (isCredentialError(output)) {
    log(`credential error for ${toolName}, re-injecting and retrying once`)
    try {
      await reInjectCredentials()
      output = await exec()
    } catch (err) {
      throw new SandboxError(`cloudbase tool ${toolName} re-inject failed: ${(err as Error).message}`)
    }
  }
  return output
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * 在已 acquire 的沙箱内构造 CloudBase MCP server。
 *
 * 失败策略：
 *   - 凭证注入失败 / schema 拉取失败 → degraded 模式（toolCount=0），
 *     不抛异常，让 kernel 上层决定是否要用（默认是放弃 cloudbase tools 但保留 sandbox tools）。
 *   - 工具运行时错误 → 在 tool callback 里返回 `isError: true`，模型继续。
 */
export async function createCloudBaseMcpServer(options: CreateCloudBaseMcpOptions): Promise<CloudBaseMcpBundle> {
  const {
    sandbox,
    getCredentials,
    workspaceFolderPaths = DEFAULT_WORKSPACE_ROOT,
    integrationIde = 'open-agent-kernel',
    log = defaultLog,
  } = options

  // 创建一个空 server 作为兜底（degraded 模式也返回它，避免上层调用方做空判断）
  const buildEmptyServer = (reason: string): CloudBaseMcpBundle => {
    log(`degraded: ${reason}`)
    return {
      server: createSdkMcpServer({
        name: 'cloudbase',
        version: '1.0.0',
        tools: [],
      }),
      toolCount: 0,
      degradedReason: reason,
    }
  }

  // ── Step 1: inject credentials（首次 + 后续重试都用这个） ──
  const reInjectCredentials = async (): Promise<void> => {
    const creds = await getCredentials()
    await injectCredentials({
      sandbox,
      credentials: creds,
      workspaceFolderPaths,
      integrationIde,
    })
  }

  try {
    await reInjectCredentials()
    log('credentials injected')
  } catch (err) {
    return buildEmptyServer(`inject credentials failed: ${(err as Error).message}`)
  }

  // ── Step 2: discover schema（带退避重试，沙箱起早期 mcporter 可能还没就绪） ──
  let toolDefs: CloudBaseToolDef[] = []
  let lastErr: unknown
  for (let attempt = 1; attempt <= SCHEMA_DISCOVERY_MAX_ATTEMPTS; attempt++) {
    try {
      toolDefs = await discoverCloudBaseTools(sandbox, log)
      lastErr = undefined
      break
    } catch (err) {
      lastErr = err
      log(`schema discovery attempt ${attempt}/${SCHEMA_DISCOVERY_MAX_ATTEMPTS} failed: ${(err as Error).message}`)
      if (attempt < SCHEMA_DISCOVERY_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, SCHEMA_DISCOVERY_RETRY_DELAY_MS))
      }
    }
  }
  if (lastErr) {
    return buildEmptyServer(`schema discovery failed: ${(lastErr as Error).message}`)
  }

  // ── Step 3: wrap each tool as sdkTool ──
  const tools = toolDefs
    .filter((t) => t.name && !SKIP_TOOLS.has(t.name))
    .map((t) => {
      const zodShape = jsonSchemaToZodRawShape(t.inputSchema)
      return sdkTool(
        t.name,
        (t.description ?? `CloudBase tool: ${t.name}`) +
          '\n\nNOTE: localPath refers to paths inside the sandbox workspace.',
        zodShape,
        async (callArgs: Record<string, unknown>) => {
          try {
            const output = await callCloudBaseTool({
              sandbox,
              toolName: t.name,
              args: callArgs,
              reInjectCredentials,
              log,
            })
            return {
              content: [{ type: 'text', text: output }],
              ...(isCredentialError(output) ? { isError: true } : {}),
            }
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: err instanceof Error ? err.message : String(err),
                },
              ],
              isError: true,
            }
          }
        },
      )
    })

  log(`registered ${tools.length} cloudbase tools (skipped ${toolDefs.length - tools.length})`)

  return {
    server: createSdkMcpServer({
      name: 'cloudbase',
      version: '1.0.0',
      tools,
    }),
    toolCount: tools.length,
  }
}
