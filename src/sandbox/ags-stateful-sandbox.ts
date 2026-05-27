/**
 * AGS Stateful Sandbox（腾讯云 Agent Sandbox 产品）适配。
 *
 * 改写自 OpenVibeCoding `feature/stateful-infra` 分支的 stateful-provider，
 * 精简为 PR #6A 必需的最小子集：
 *   - acquire：ensureTool（按 envId 派生稳定 ToolName）→ StartSandboxInstance → warmup probe
 *   - request：数据面 HTTP（baseUrl + 3 个固定 header）
 *   - release：PauseSandboxInstance（让 AGS 资源自动回收）
 *
 * 不做（留给 PR #6B）：
 *   - shared 模式（多 session 复用同一实例）
 *   - DB 持久化的 ToolId 缓存（PR #6A 用进程内内存 cache）
 *   - 显式 snapshot / 端口路由 / preview proxy
 *
 * 协议参考：
 *   - 控制面：腾讯云 AGS OpenAPI（@cloudbase/manager-node CloudService('ags')）
 *   - 数据面：TRW HTTP gateway，3 个 header：
 *       X-Cloudbase-Authorization: Bearer {TCB_API_KEY}
 *       E2b-Sandbox-Id: {InstanceId}
 *       E2b-Sandbox-Port: 9000  (TRW 默认端口)
 */

import { SandboxError } from '../internal/errors.js'
import type { SandboxAcquireContext, SandboxInstance, SandboxRuntime } from './types.js'

// ─── Constants ──────────────────────────────────────────────────────────

const TRW_SERVICE_PORT = 9000
const READY_TIMEOUT_MS = 120_000
const READY_POLL_INTERVAL_MS = 3000

/**
 * CreateSandboxTool 之后的镜像 warmup 等待（参考 stateful-infra 一条龙 #24）。
 * 平台需要拉镜像，这段时间内立即 StartSandboxInstance 会拿到 InternalError /
 * "tool is CREATING" 等错误。死等一段时间再 start 是最稳的做法。
 */
const TOOL_WARMUP_POLL_MS = 10_000
const TOOL_WARMUP_POLL_MAX = 6 // 总共 ~60s
const HEALTH_TIMEOUT_MS = 5000

/** 默认沙箱镜像（OpenVibeCoding 团队公开 TCR） */
const DEFAULT_SANDBOX_IMAGE =
  process.env.OAK_SANDBOX_IMAGE ??
  'ccr.ccs.tencentyun.com/tcb-sandbox-public-cbe88d/tcb-sandbox-public-cbe88d:260521-1705-vibecoding'

const DEFAULT_TOOL_ROLE_ARN = process.env.OAK_SANDBOX_TOOL_ROLE_ARN ?? 'qcs::cam::uin/691612481:roleName/agent-sandbox'

// ─── Configuration / Credentials ────────────────────────────────────────

export interface AgsStatefulSandboxOptions {
  /**
   * AGS 数据面认证用的长期 JWT。
   * 默认从 `process.env.TCB_API_KEY` 读取。
   */
  apiKey?: string
  /**
   * 控制面（AGS OpenAPI）的 secretId。
   * 默认按以下优先级读：TCB_SECRET_ID → TENCENTCLOUD_SECRET_ID → TENCENT_SECRET_ID
   */
  secretId?: string
  /**
   * 控制面 secretKey。
   * 默认按以下优先级读：TCB_SECRET_KEY → TENCENTCLOUD_SECRET_KEY → TENCENT_SECRET_KEY
   */
  secretKey?: string
  /** 临时凭证 token（可选）：TCB_TOKEN / TENCENTCLOUD_SESSIONTOKEN */
  sessionToken?: string
  /** 容器镜像（不传走默认公开 TCR） */
  image?: string
  /** AGS Tool 关联的 RoleArn */
  toolRoleArn?: string
  /** 实例默认超时（AGS Timeout 字段，例 '30m'） */
  defaultTimeout?: string
  /** 数据面 gateway URL（不传按 envId 派生） */
  gatewayBaseUrl?: string
}

interface ResolvedCredentials {
  apiKey: string
  secretId: string
  secretKey: string
  sessionToken?: string
  image: string
  toolRoleArn: string
  defaultTimeout: string
  gatewayBaseUrl?: string
}

function resolveCredentials(opts: AgsStatefulSandboxOptions): ResolvedCredentials {
  const apiKey = opts.apiKey ?? process.env.TCB_API_KEY ?? ''
  const secretId =
    opts.secretId ??
    process.env.TCB_SECRET_ID ??
    process.env.TENCENTCLOUD_SECRET_ID ??
    process.env.TENCENT_SECRET_ID ??
    ''
  const secretKey =
    opts.secretKey ??
    process.env.TCB_SECRET_KEY ??
    process.env.TENCENTCLOUD_SECRET_KEY ??
    process.env.TENCENT_SECRET_KEY ??
    ''
  const sessionToken = opts.sessionToken ?? process.env.TCB_TOKEN ?? process.env.TENCENTCLOUD_SESSIONTOKEN ?? undefined

  if (!apiKey) {
    throw new SandboxError(
      'AgsStatefulSandbox requires TCB_API_KEY (long-lived JWT for data-plane auth). ' +
        'Set process.env.TCB_API_KEY or pass options.apiKey.',
    )
  }
  if (!secretId || !secretKey) {
    throw new SandboxError(
      'AgsStatefulSandbox requires TCB_SECRET_ID / TCB_SECRET_KEY for control-plane (AGS OpenAPI). ' +
        'Set the env vars or pass options.secretId / options.secretKey.',
    )
  }

  return {
    apiKey,
    secretId,
    secretKey,
    sessionToken,
    image: opts.image ?? DEFAULT_SANDBOX_IMAGE,
    toolRoleArn: opts.toolRoleArn ?? DEFAULT_TOOL_ROLE_ARN,
    defaultTimeout: opts.defaultTimeout ?? '30m',
    gatewayBaseUrl: opts.gatewayBaseUrl,
  }
}

function resolveGatewayUrl(envId: string, override?: string): string {
  if (override) return override.replace(/\/$/, '')
  if (!envId) {
    throw new SandboxError('Missing envId to derive AGS gateway URL')
  }
  return `https://${envId}.api.tcloudbasegateway.com/v1/sandbox/-`
}

/**
 * 解析镜像的 ImageRegistryType（AGS API 仅接受 enterprise / personal / system）。
 *
 * 默认根据 host 推断：
 *   - ccr.ccs.tencentyun.com（公开 CCR）→ personal
 *   - 其他（含租户私有 TCR）→ personal（保守默认）
 *
 * 用户可通过 OAK_SANDBOX_IMAGE_REGISTRY_TYPE 显式覆盖。
 */
function resolveImageRegistryType(image: string): string {
  const explicit = process.env.OAK_SANDBOX_IMAGE_REGISTRY_TYPE?.trim()
  if (explicit) return explicit
  // ccr.ccs.tencentyun.com / 租户私有 TCR 都属于 personal
  void image
  return 'personal'
}

function statefulToolNameForEnv(envId: string): string {
  const slug = envId.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 48)
  return `oak-${slug || 'default'}`
}

// ─── AGS Manager API（控制面）─────────────────────────────────────────

/**
 * 调用 AGS OpenAPI（CreateSandboxTool / StartSandboxInstance / Pause / 等）。
 *
 * @cloudbase/manager-node 是 optional peer dep，使用时按需 require。
 */
async function callAgsApi(
  action: string,
  param: Record<string, unknown>,
  cred: ResolvedCredentials,
  envId: string,
): Promise<Record<string, unknown>> {
  let managerModule: unknown
  let managerUtilsModule: unknown
  try {
    managerModule = await import('@cloudbase/manager-node')
    managerUtilsModule = await import(
      // @ts-expect-error manager-node ships utils without types
      '@cloudbase/manager-node/lib/utils'
    )
  } catch (err) {
    throw new SandboxError(
      'AgsStatefulSandbox requires @cloudbase/manager-node. ' + 'Install it: pnpm add @cloudbase/manager-node',
      err,
    )
  }

  type CloudBaseCtor = new (config: Record<string, unknown>) => {
    context: unknown
  }
  type CloudServiceCtor = new (
    ctx: unknown,
    service: string,
    version: string,
  ) => {
    request(action: string, param: Record<string, unknown>): Promise<Record<string, unknown>>
  }

  const mm = managerModule as { default?: unknown } & Record<string, unknown>
  const um = managerUtilsModule as { default?: { CloudService?: unknown }; CloudService?: unknown }
  const CloudBase = (mm.default ?? mm) as unknown as CloudBaseCtor
  const CloudService = (um.CloudService ?? um.default?.CloudService) as unknown as CloudServiceCtor

  const app = new CloudBase({
    secretId: cred.secretId,
    secretKey: cred.secretKey,
    token: cred.sessionToken,
    envId,
  })
  const ags = new CloudService(app.context, 'ags', '2025-09-20')
  return ags.request(action, param)
}

interface AgsToolInfo {
  toolId: string
  toolName: string
  status: string
}

function extractToolSet(resp: Record<string, unknown>): Array<Record<string, unknown>> {
  const direct = resp.SandboxToolSet
  if (Array.isArray(direct)) return direct
  const nested = (resp.data as Record<string, unknown> | undefined)?.SandboxToolSet
  return Array.isArray(nested) ? nested : []
}

async function findToolByName(toolName: string, cred: ResolvedCredentials, envId: string): Promise<AgsToolInfo | null> {
  // 优先用 Filter 一次查询命中
  try {
    const resp = await callAgsApi(
      'DescribeSandboxToolList',
      { Filters: [{ Name: 'ToolName', Values: [toolName] }], Limit: 20 },
      cred,
      envId,
    )
    const set = extractToolSet(resp)
    const hit = pickToolByName(set, toolName)
    if (hit) return hit
  } catch {
    // 部分版本不支持 Filter，降级到分页扫
  }

  let offset = 0
  const limit = 100
  for (let page = 0; page < 10; page++) {
    const resp = await callAgsApi('DescribeSandboxToolList', { Offset: offset, Limit: limit }, cred, envId)
    const set = extractToolSet(resp)
    const hit = pickToolByName(set, toolName)
    if (hit) return hit
    const total = typeof resp.TotalCount === 'number' ? resp.TotalCount : 0
    offset += limit
    if (set.length < limit || offset >= total) break
  }
  return null
}

function pickToolByName(tools: Array<Record<string, unknown>>, toolName: string): AgsToolInfo | null {
  const matches = tools.filter((t) => t.ToolName === toolName && typeof t.ToolId === 'string')
  if (!matches.length) return null
  const active = matches.find((t) => t.Status === 'ACTIVE') ?? matches[0]
  return {
    toolId: active.ToolId as string,
    toolName: toolName,
    status: String(active.Status ?? ''),
  }
}

async function createTool(envId: string, cred: ResolvedCredentials): Promise<string> {
  const resp = await callAgsApi(
    'CreateSandboxTool',
    {
      ToolName: statefulToolNameForEnv(envId),
      ToolType: 'custom',
      RoleArn: cred.toolRoleArn,
      CustomConfiguration: {
        Image: cred.image,
        ImageRegistryType: resolveImageRegistryType(cred.image),
        Command: ['/init'],
        Resources: { CPU: '2', Memory: '2Gi' },
        Ports: [
          { Name: 'trw', Protocol: 'TCP', Port: TRW_SERVICE_PORT },
          { Name: 'envd', Protocol: 'TCP', Port: 49983 },
          { Name: 'vite', Protocol: 'TCP', Port: 5173 },
          { Name: 'ttyd', Protocol: 'TCP', Port: 7681 },
        ],
        Probe: {
          HttpGet: { Path: '/health', Port: TRW_SERVICE_PORT, Scheme: 'HTTP' },
          ReadyTimeoutMs: 25_000,
          ProbeTimeoutMs: 5000,
          ProbePeriodMs: 3000,
          SuccessThreshold: 1,
          FailureThreshold: 7,
        },
      },
      NetworkConfiguration: { NetworkMode: 'PUBLIC' },
      DefaultTimeout: cred.defaultTimeout,
      Description: `open-agent-kernel sandbox for env ${envId}`,
    },
    cred,
    envId,
  )

  const toolId =
    (resp?.ToolId as string) || ((resp?.data as Record<string, unknown> | undefined)?.ToolId as string) || ''
  if (!toolId) {
    throw new SandboxError(`CreateSandboxTool returned no ToolId: ${JSON.stringify(resp).slice(0, 300)}`)
  }
  return toolId
}

async function startInstance(
  toolId: string,
  cred: ResolvedCredentials,
  envId: string,
  defaultTimeout: string,
): Promise<string> {
  const resp = await callAgsApi(
    'StartSandboxInstance',
    {
      ToolId: toolId,
      Timeout: defaultTimeout,
      AuthMode: 'NONE',
    },
    cred,
    envId,
  )
  const data = resp?.data as Record<string, unknown> | undefined
  const inst = resp?.Instance as Record<string, unknown> | undefined
  const instanceId = String(resp?.InstanceId || inst?.InstanceId || data?.InstanceId || '') || ''
  if (!instanceId) {
    throw new SandboxError(`StartSandboxInstance returned no InstanceId: ${JSON.stringify(resp).slice(0, 300)}`)
  }
  return instanceId
}

async function pauseInstance(instanceId: string, cred: ResolvedCredentials, envId: string): Promise<void> {
  await callAgsApi('PauseSandboxInstance', { InstanceId: instanceId }, cred, envId)
}

async function resumeInstance(instanceId: string, cred: ResolvedCredentials, envId: string): Promise<void> {
  await callAgsApi('ResumeSandboxInstance', { InstanceId: instanceId }, cred, envId)
}

async function stopInstance(instanceId: string, cred: ResolvedCredentials, envId: string): Promise<void> {
  await callAgsApi('StopSandboxInstance', { InstanceId: instanceId }, cred, envId)
}

interface AgsInstanceStatus {
  instanceId: string
  status: string
  toolId: string | null
}

async function describeInstances(
  cred: ResolvedCredentials,
  envId: string,
  opts: { toolId?: string; instanceIds?: string[] } = {},
): Promise<AgsInstanceStatus[]> {
  const resp = await callAgsApi(
    'DescribeSandboxInstanceList',
    {
      ...(opts.toolId ? { ToolId: opts.toolId } : {}),
      ...(opts.instanceIds?.length ? { InstanceIds: opts.instanceIds } : {}),
      Limit: 100,
    },
    cred,
    envId,
  )
  const data = resp?.data as Record<string, unknown> | undefined
  const rows = (resp?.InstanceSet || data?.InstanceSet || []) as Array<Record<string, unknown>>
  return rows.map((it) => ({
    instanceId: String(it.InstanceId || ''),
    status: String(it.Status || ''),
    toolId: it.ToolId ? String(it.ToolId) : null,
  }))
}

function pickPrimaryInstance(candidates: AgsInstanceStatus[]): AgsInstanceStatus | null {
  // 复用优先级：RUNNING（立即可用）> PAUSED（resume 后可用）> RESUME_FAILED（重试有可能成功）
  const byPriority = ['RUNNING', 'PAUSED', 'RESUME_FAILED']
  for (const status of byPriority) {
    const hit = candidates.find((c) => c.status === status)
    if (hit) return hit
  }
  return null
}

/**
 * Shared 模式：同 envId/toolId 下复用单个实例。
 *
 * - 找到 RUNNING → 直接复用
 * - 找到 PAUSED → 先 Resume 再复用
 * - 找到多个 active → 保留 primary，其余 best-effort Stop（避免实例漂移）
 * - 都没找到 → StartSandboxInstance 新建一个
 *
 * 注意：调用方在 release 时**不要 pause**——其他 session 可能还在用同一实例。
 *      AGS 会按 DefaultTimeout 自动回收。
 */
async function ensureSharedInstance(
  toolId: string,
  cred: ResolvedCredentials,
  envId: string,
  onProgress?: (msg: { phase: string; message: string }) => void,
): Promise<{ instanceId: string; reused: boolean }> {
  const all = await describeInstances(cred, envId, { toolId })
  const active = all.filter((it) => ['RUNNING', 'PAUSED', 'RESUME_FAILED'].includes(it.status))
  const primary = pickPrimaryInstance(active)

  if (!primary) {
    onProgress?.({
      phase: 'instance_start',
      message: 'starting shared sandbox instance...',
    })
    const instanceId = await startInstanceWithRetry({
      toolId,
      cred,
      envId,
      defaultTimeout: cred.defaultTimeout,
      onProgress,
    })
    return { instanceId, reused: false }
  }

  // 同 toolId 下保留一个实例：多余的 best-effort 停掉，避免漂移
  const redundant = active.filter((it) => it.instanceId !== primary.instanceId)
  for (const item of redundant) {
    try {
      await stopInstance(item.instanceId, cred, envId)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[ags] failed to stop redundant instance', item.instanceId, (err as Error).message)
    }
  }

  if (primary.status !== 'RUNNING') {
    onProgress?.({
      phase: 'instance_resume',
      message: `resuming shared sandbox instance ${primary.instanceId}...`,
    })
    await resumeInstance(primary.instanceId, cred, envId)
  } else {
    onProgress?.({
      phase: 'instance_reuse',
      message: `reusing shared sandbox instance ${primary.instanceId}`,
    })
  }

  return { instanceId: primary.instanceId, reused: true }
}

// ─── Data plane ────────────────────────────────────────────────────────

function buildDataPlaneHeaders(args: { apiKey: string; instanceId: string; port: number }): Record<string, string> {
  return {
    'X-Cloudbase-Authorization': `Bearer ${args.apiKey}`,
    'E2b-Sandbox-Id': args.instanceId,
    'E2b-Sandbox-Port': String(args.port),
  }
}

/** 等待 TRW 服务 /health 返回 OK */
async function waitForReady(args: {
  baseUrl: string
  headers: Record<string, string>
  onProgress?: (msg: { phase: string; message: string }) => void
}): Promise<void> {
  const { baseUrl, headers, onProgress } = args
  const start = Date.now()
  let attempt = 0
  while (Date.now() - start < READY_TIMEOUT_MS) {
    attempt++
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS)
      const res = await fetch(`${baseUrl}/health`, {
        method: 'GET',
        headers,
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      if (res.ok) {
        onProgress?.({ phase: 'instance_ready', message: 'sandbox is ready' })
        return
      }
    } catch {
      // 网络错误是正常的（实例还没起来）
    }
    onProgress?.({
      phase: 'instance_warmup',
      message: `waiting for sandbox readiness (attempt ${attempt})...`,
    })
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS))
  }
  throw new SandboxError(`Sandbox readiness timeout after ${READY_TIMEOUT_MS}ms`)
}

// ─── ToolId cache（进程内）────────────────────────────────────────────
// PR #6A：内存 cache，避免每次 acquire 都调一遍 DescribeSandboxToolList。
// PR #6B 起可考虑外部持久化（比如复用 SessionStore driver 写入 DB）。

const toolIdCache = new Map<string, string>()

async function ensureTool(
  envId: string,
  cred: ResolvedCredentials,
  onProgress?: (msg: { phase: string; message: string }) => void,
): Promise<{ toolId: string; justCreated: boolean }> {
  const cached = toolIdCache.get(envId)
  if (cached) return { toolId: cached, justCreated: false }

  const toolName = statefulToolNameForEnv(envId)
  onProgress?.({ phase: 'tool_lookup', message: `looking up sandbox tool ${toolName}` })

  const existing = await findToolByName(toolName, cred, envId)
  if (existing) {
    toolIdCache.set(envId, existing.toolId)
    return { toolId: existing.toolId, justCreated: false }
  }

  onProgress?.({
    phase: 'tool_create',
    message: `creating sandbox tool ${toolName} (first run, ~30s)`,
  })
  const toolId = await createTool(envId, cred)
  toolIdCache.set(envId, toolId)
  return { toolId, justCreated: true }
}

/**
 * CreateSandboxTool 之后死等镜像 warmup（参考 stateful-infra）。
 *
 * 平台拉镜像需要时间，立即 StartSandboxInstance 会失败（CREATING / InternalError）。
 */
async function waitToolWarmup(onProgress?: (msg: { phase: string; message: string }) => void): Promise<void> {
  for (let round = 1; round <= TOOL_WARMUP_POLL_MAX; round++) {
    onProgress?.({
      phase: 'template_warmup',
      message: `tool image warmup (${round}/${TOOL_WARMUP_POLL_MAX})...`,
    })
    await new Promise((r) => setTimeout(r, TOOL_WARMUP_POLL_MS))
  }
}

/**
 * 判断 AGS 错误是否可重试。
 *
 * 涵盖：
 *   - "is not active, current status: CREATING"（Tool 还在拉镜像）
 *   - "internal error has occurred"（一条龙 #24）
 *   - "ResourceInsufficient"
 */
function isAgsRetryableError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? ''
  return (
    /is not active/i.test(msg) ||
    /CREATING/i.test(msg) ||
    /internal error has occurred/i.test(msg) ||
    /ResourceInsufficient/i.test(msg)
  )
}

/**
 * 调 startInstance 时遇到 Tool 还没就绪等可重试错误就退避重试。
 */
async function startInstanceWithRetry(args: {
  toolId: string
  cred: ResolvedCredentials
  envId: string
  defaultTimeout: string
  onProgress?: (msg: { phase: string; message: string }) => void
}): Promise<string> {
  const { toolId, cred, envId, defaultTimeout, onProgress } = args
  let lastErr: unknown
  for (let attempt = 1; attempt <= TOOL_WARMUP_POLL_MAX; attempt++) {
    try {
      return await startInstance(toolId, cred, envId, defaultTimeout)
    } catch (err) {
      lastErr = err
      if (!isAgsRetryableError(err) || attempt >= TOOL_WARMUP_POLL_MAX) {
        throw err
      }
      onProgress?.({
        phase: 'instance_start_retry',
        message: `instance start retryable error, retry ${attempt}/${TOOL_WARMUP_POLL_MAX}...`,
      })
      await new Promise((r) => setTimeout(r, TOOL_WARMUP_POLL_MS))
    }
  }
  throw lastErr
}

// ─── Public class ──────────────────────────────────────────────────────

export class AgsStatefulSandbox implements SandboxRuntime {
  readonly backend = 'ags-stateful'
  private readonly options: AgsStatefulSandboxOptions

  constructor(options: AgsStatefulSandboxOptions = {}) {
    this.options = options
  }

  async acquire(ctx: SandboxAcquireContext): Promise<SandboxInstance> {
    const cred = resolveCredentials(this.options)
    const baseUrl = resolveGatewayUrl(ctx.envId, cred.gatewayBaseUrl)
    const scope = ctx.scope ?? 'session'

    const { toolId, justCreated } = await ensureTool(ctx.envId, cred, ctx.onProgress)

    // 新建 Tool 后必须等镜像 warmup（参考 stateful-infra 一条龙 #24），
    // 否则 StartSandboxInstance 立即返回 "is not active, current status: CREATING"
    if (justCreated) {
      await waitToolWarmup(ctx.onProgress)
    }

    // 按 scope 分流
    let instanceId: string
    let isShared: boolean
    if (scope === 'shared') {
      const result = await ensureSharedInstance(toolId, cred, ctx.envId, ctx.onProgress)
      instanceId = result.instanceId
      isShared = true
    } else {
      ctx.onProgress?.({
        phase: 'instance_start',
        message: 'starting sandbox instance (isolated)...',
      })
      instanceId = await startInstanceWithRetry({
        toolId,
        cred,
        envId: ctx.envId,
        defaultTimeout: cred.defaultTimeout,
        onProgress: ctx.onProgress,
      })
      isShared = false
    }

    const headers = buildDataPlaneHeaders({
      apiKey: cred.apiKey,
      instanceId,
      port: TRW_SERVICE_PORT,
    })

    await waitForReady({ baseUrl, headers, onProgress: ctx.onProgress })

    return {
      id: instanceId,
      async request(p: string, init?: RequestInit): Promise<Response> {
        return fetch(`${baseUrl}${p.startsWith('/') ? p : '/' + p}`, {
          ...init,
          headers: {
            ...headers,
            ...((init?.headers as Record<string, string> | undefined) ?? {}),
          },
        })
      },
      async release(): Promise<void> {
        // shared 模式不 pause——其他 session 可能还在用同一实例，
        // 由 AGS 按 DefaultTimeout 自动回收。
        if (isShared) return
        try {
          await pauseInstance(instanceId, cred, ctx.envId)
        } catch (err) {
          // release 失败不阻塞业务，只打 warning
          // eslint-disable-next-line no-console
          console.warn('[ags] failed to pause instance', instanceId, (err as Error).message)
        }
      },
    }
  }
}
