/**
 * Agent builder: AgentConfig → Claude Agent SDK query() options
 *
 * 已支持（PR #2/#3/#4/#5/#6/#7.0）：
 *   - envId / model 派生 baseUrl + apiKey，通过 env 注入到 SDK
 *   - 显式禁用本地文件依赖：settingSources: [], strictMcpConfig: true
 *   - systemPrompt 透传
 *   - 透传 abortController
 *   - sessionStore 注入（PR #4）
 *   - mcpServers 注入（PR #5，对齐 Claude SDK 4 种形态）
 *   - sandbox MCP / cloudbase MCP 注入（PR #6/#6.5）
 *   - permissions HITL（PR #7.0）：requireApproval + PreToolUse hook 注入 + permissionMode 处理
 *
 * 未支持（后续 PR 接入）：
 *   - canUseTool / 更复杂权限策略（PR #7.1+）
 *   - hooks 业务旁路（PR #8）
 *   - handoffs / agents 注入                    → PR #2+ 后续
 */

import type {
  HookCallback as SdkHookCallback,
  Options as ClaudeOptions,
  McpServerConfig as SdkMcpServerConfig,
  SessionStore,
} from '@anthropic-ai/claude-agent-sdk'
import { createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk'
import { InvalidConfigError } from '../internal/errors.js'
import {
  createPreToolUsePermissionHook,
  OAK_CLIENT_TOOL_RESULT_KEY,
  type PreToolUseHookLocalState,
} from '../permissions/hooks.js'
import type { AgentConfig, ToolDefinition } from '../public/types.js'
import { createSandboxMcpServer } from '../sandbox/sandbox-tools.js'
import type { SandboxInstance } from '../sandbox/types.js'
import { resolveCredential, type ResolvedCredential } from './credential-factory.js'

/**
 * 默认 API 超时（10 分钟）。
 * TokenHub 官方推荐值，避免长输出时被默认超时打断。
 * 参考：https://cloud.tencent.com/document/product/1823/130079
 */
const DEFAULT_API_TIMEOUT_MS = 600_000

/**
 * 当启用 sessionStore 时，SDK 仍要求子进程做"本地双写"。
 * 我们把 CLAUDE_CONFIG_DIR 指到操作系统临时目录，避免污染用户 HOME。
 * 启用 sessionStore 时设置 OAK_SESSION_LOCAL_DIR 可覆盖。
 */
function getSessionLocalDir(): string {
  return process.env.OAK_SESSION_LOCAL_DIR ?? process.env.TMPDIR ?? '/tmp'
}

export interface BuiltClaudeQueryParams {
  /** Claude SDK query() 的 options */
  options: ClaudeOptions
  /** 派生出的凭证信息，调试/日志用 */
  credential: ResolvedCredential
}

/**
 * 把 kernel 的 AgentConfig 翻译为 Claude Agent SDK query() 的 options。
 *
 * 调用方在拿到结果后，应 `import { query } from '@anthropic-ai/claude-agent-sdk'`，
 * 然后 `query({ prompt: '...', options })` 启动一个 agent run。
 *
 * @param sandboxInstance 已经 acquire 好的沙箱实例（PR #6A）。
 *   如果传入，kernel 会自动把 bash/read/write 工具作为 MCP server 注入给 SDK，
 *   工具名为 `mcp__sandbox__bash` / `mcp__sandbox__read` / `mcp__sandbox__write`。
 * @param extraMcpServers 已构造好的额外 SDK MCP server map（PR #6.5：cloudbase MCP）。
 *   按 key 注入到 mcpServers，工具名前缀为 `mcp__{key}__*`。
 * @param conversationId 当前 session 的 conversationId（PR #7.0：用于审批 hook）。
 * @param hookLocalState PR #7.0：一次 SDK query 内的本地状态（防同轮多 interrupt 等）。
 */
export function buildClaudeQueryOptions(
  config: AgentConfig,
  extra: {
    sandboxInstance?: SandboxInstance
    extraMcpServers?: Record<string, SdkMcpServerConfig>
    conversationId?: string
    hookLocalState?: PreToolUseHookLocalState
    /** PR #7.1: names of user-defined client-side tools (for hook routing). */
    clientToolNames?: ReadonlySet<string>
    /** PR #7.1: store for client-supplied tool results (in-memory by default). */
    clientToolStore?: import('../permissions/hooks.js').ClientToolResultStore
  } = {},
): BuiltClaudeQueryParams {
  const credential = resolveCredential({
    envId: config.envId,
    model: config.model,
    resources: config.resources,
  })

  // ── 决定是否启用 SDK 持久化 ──────────────────────────────────────
  // 注入 sessionStore 时，SDK 强制要求 persistSession=true（dual-write 模式：
  // 子进程仍写本地 JSONL，store 收到 mirror 副本）。
  const sessionStore = extractSessionStore(config)
  const enablePersist = sessionStore !== null

  // 透传给 SDK 子进程的环境变量
  const env: Record<string, string | undefined> = {
    ...process.env,
    ANTHROPIC_BASE_URL: credential.baseUrl,
    ANTHROPIC_AUTH_TOKEN: credential.apiKey,
    ANTHROPIC_API_KEY: undefined,
    API_TIMEOUT_MS: String(DEFAULT_API_TIMEOUT_MS),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_AGENT_SDK_CLIENT_APP: '@cloudbase/open-agent-kernel/0.1.0-alpha.0',
    // 启用 sessionStore 时把本地 dual-write 路径指到临时目录
    ...(enablePersist ? { CLAUDE_CONFIG_DIR: getSessionLocalDir() } : {}),
  }

  // 诊断日志（OAK_DEBUG=1 时打开）
  if (process.env.OAK_DEBUG === '1') {
    const keyPreview =
      credential.apiKey.length > 12 ? `${credential.apiKey.slice(0, 8)}...${credential.apiKey.slice(-4)}` : '***'
    // eslint-disable-next-line no-console
    console.error('[oak] credential resolved:', {
      modelId: credential.modelId,
      baseUrl: credential.baseUrl,
      apiKeySource: credential.apiKeySource,
      apiKeyPreview: keyPreview,
      sessionStore: enablePersist ? 'enabled' : 'disabled',
    })
  }

  // ── 决定权限模式（PR #7.0 / PR #7.1）─────────────────────────
  // PreToolUse hook 启用条件：
  //   - 用户配了 permissions.requireApproval（PR #7.0 审批流），或
  //   - 用户声明了 config.tools[]（PR #7.1 client-side 工具流），或
  //   - 上述任一并提供了 conversationId + hookLocalState（runtime 必须配齐）
  const hasClientTools = Boolean(config.tools && config.tools.length > 0)
  const hasApproval = config.permissions !== undefined && config.permissions.requireApproval !== undefined
  const userHasApprovalConfig =
    (hasApproval || hasClientTools) && Boolean(extra.conversationId) && Boolean(extra.hookLocalState)

  // ── 合并 mcpServers：用户配置 + 沙箱 MCP（PR #6A）+ 内置 cloudbase MCP（PR #6.5）─
  // 沙箱实例由 create-agent 在 send 前 acquire 好后传入，这里只是注入。
  const mergedMcpServers: Record<string, SdkMcpServerConfig> | undefined = (() => {
    const userServers = config.mcpServers ? validateMcpServers(config.mcpServers) : undefined
    const merged: Record<string, SdkMcpServerConfig> = { ...(userServers ?? {}) }
    if (extra.sandboxInstance) {
      // key 'sandbox' 决定工具名前缀：mcp__sandbox__bash 等
      merged.sandbox = createSandboxMcpServer(extra.sandboxInstance)
    }
    if (extra.extraMcpServers) {
      // PR #6.5：cloudbase MCP（mcp__cloudbase__*）等额外内置 server
      Object.assign(merged, extra.extraMcpServers)
    }
    // ── 用户自定义 ToolDefinition[] → SDK MCP server 'custom' (mcp__custom__*)
    // SDK 的 query() 不接受 tools 数组——所有工具必须打包成 MCP server 注入。
    // 用 'custom' 作为 server key（而不是 'kernel'）：模型看到的工具名前缀
    // mcp__custom__<name> 在语义上明确告诉调用链"这是用户声明的、由 client/上层
    // 业务代码实现的工具"，与 mcp__sandbox__* / mcp__cloudbase__* 区分开。
    if (config.tools && config.tools.length > 0) {
      merged.custom = wrapKernelToolsAsMcpServer(config.tools)
    }
    return Object.keys(merged).length > 0 ? merged : undefined
  })()

  // ── PR #7.0：构造 PreToolUse hook（审批桥接）──
  const hooks: ClaudeOptions['hooks'] = (() => {
    if (!userHasApprovalConfig) return undefined
    // permissions config is optional when only client-tools are configured.
    const permissionsForHook = config.permissions ?? { requireApproval: undefined }
    const preToolUseHook = createPreToolUsePermissionHook({
      conversationId: extra.conversationId!,
      permissions: permissionsForHook,
      localState: extra.hookLocalState!,
      ...(extra.clientToolNames ? { clientToolNames: extra.clientToolNames } : {}),
      ...(extra.clientToolStore ? { clientToolStore: extra.clientToolStore } : {}),
    })
    return {
      PreToolUse: [
        {
          // matcher 不传 → 匹配所有工具；hook 内部按 requireApproval 规则筛选
          // 类型断言：hook 内部用宽入参 + 运行时收窄来兼容 SDK 的 HookCallback 联合签名
          hooks: [preToolUseHook as unknown as SdkHookCallback],
        },
      ],
    }
  })()

  const options: ClaudeOptions = {
    model: credential.modelId,
    env,
    // ── 关键：禁用本地配置文件依赖（kernel 是云服务，不依赖本机 ~/.claude 配置） ──
    settingSources: [],
    strictMcpConfig: true,
    // 持久化策略：注入 store 时必须 true（SDK 强制约束）
    persistSession: enablePersist,
    ...(sessionStore ? { sessionStore } : {}),
    ...(config.session?.flush ? { sessionStoreFlush: config.session.flush } : {}),
    // ── 系统提示 ──
    ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
    // ── MCP servers（PR #5 + PR #6A） ──
    ...(mergedMcpServers ? { mcpServers: mergedMcpServers } : {}),
    // ── PR #7.0：审批 hooks ──
    ...(hooks ? { hooks } : {}),
    // ── 权限模式：始终 bypass SDK 内置权限系统 ──
    // SDK 自带的 permissionMode 会对所有工具要求"用户在终端授权"，
    // 在服务端程序化场景下无人可授权 → 全部被拒绝。
    // 我们的 PreToolUse Hook 已经完整实现了审批逻辑：
    //   - 不匹配 requireApproval 的工具 → Hook 返回 {} → 直接放行
    //   - 匹配 requireApproval 的工具 → Hook 触发 HITL 流程
    // 因此始终 bypass SDK 的内置权限系统，让 Hook 全权负责。
    permissionMode: 'bypassPermissions' as const,
    allowDangerouslySkipPermissions: true,
    // ── 内置工具默认全部禁用（沙箱能力通过上面的 mcpServers 提供） ──
    tools: [],
  }

  return { options, credential }
}

// ─── 辅助 ────────────────────────────────────────────────────────

/**
 * Wrap user-supplied ToolDefinition[] as a single SDK MCP server. The Claude
 * Agent SDK exposes user-provided tools only via `mcpServers` (its query()
 * options has no `tools` array). We pack all of AgentConfig.tools[] into a
 * single in-process server keyed `custom`, which makes them visible to the
 * model as `mcp__custom__<name>`. The 'custom' name signals "user-declared
 * tool, not a kernel-provided builtin like sandbox/cloudbase".
 *
 * The user-facing tool name (config.tools[i].name) is preserved as the
 * MCP-server-tool name. Consumers see `mcp__custom__<name>` in tool_call
 * events — they should match against that prefix when needed (e.g. the
 * stop-and-resume pump in a runtime that needs to distinguish client-side
 * custom tools from sandbox tools).
 *
 * Each kernel tool's execute() is wrapped to:
 *   - parse the input through its Zod schema (kernel does this anyway)
 *   - call the user's execute()
 *   - format the return value as { content: [{type:'text', text:...}] }
 *     because the SDK's MCP transport requires that wire format.
 *   - propagate thrown errors as is (PR #7.0 sentinel for HITL flows still
 *     bubbles up; client-side tool sentinels also bubble up unchanged).
 */
function wrapKernelToolsAsMcpServer(tools: ToolDefinition[]): ReturnType<typeof createSdkMcpServer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdkTools: any[] = tools.map((t) =>
    sdkTool(
      t.name,
      t.description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      t.parameters as any,
      async (input: Record<string, unknown>) => {
        // PR #7.1: client-side tool fast path. The PreToolUse hook injects
        // a host-supplied result via `updatedInput.__oak_client_tool_result__`
        // when resuming after the host called session.respondToolUse(). We
        // detect the magic key and return its content directly — the user's
        // execute() is never invoked. Since the hook only allows the call
        // when the result is present, every legitimate execution comes
        // through here; bare invocations (no key) mean the hook didn't fire
        // (i.e. host forgot to wire client tools), in which case calling
        // execute() would just throw the stub sentinel and abort the turn.
        const injected = input?.[OAK_CLIENT_TOOL_RESULT_KEY] as { output?: unknown; isError?: boolean } | undefined
        if (injected !== undefined && injected !== null) {
          const text = typeof injected.output === 'string' ? injected.output : JSON.stringify(injected.output)
          return {
            content: [{ type: 'text', text }],
            isError: !!injected.isError,
          }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const out = await (t.execute as any)(input, {
          toolUseId: '',
          conversationId: '',
          userId: '',
          envId: '',
          signal: new AbortController().signal,
        })
        const text = typeof out === 'string' ? out : JSON.stringify(out)
        return { content: [{ type: 'text', text }] }
      },
    ),
  )
  return createSdkMcpServer({
    name: 'custom',
    version: '1.0.0',
    tools: sdkTools,
  })
}

/**
 * 校验 mcpServers：在交给 SDK 前做一些显而易见的预检，
 * 让用户在 createAgent 时就能拿到清晰错误，而不是 SDK 启动后才报。
 *
 * - stdio：必须有 command（type 可省略）
 * - http / sse：必须有 url
 * - sdk：必须有 instance + name
 *
 * 校验通过后原样透传给 SDK，**不做任何改写或封装**。
 */
function validateMcpServers(servers: Record<string, SdkMcpServerConfig>): Record<string, SdkMcpServerConfig> {
  for (const [name, config] of Object.entries(servers)) {
    if (config === null || typeof config !== 'object') {
      throw new InvalidConfigError(`mcpServers["${name}"] must be an object (got ${typeof config})`)
    }
    const type = (config as { type?: string }).type ?? 'stdio'
    switch (type) {
      case 'stdio': {
        const c = config as { command?: unknown }
        if (typeof c.command !== 'string' || c.command.length === 0) {
          throw new InvalidConfigError(`mcpServers["${name}"]: stdio server requires a non-empty "command"`)
        }
        break
      }
      case 'http':
      case 'sse': {
        const c = config as { url?: unknown }
        if (typeof c.url !== 'string' || c.url.length === 0) {
          throw new InvalidConfigError(`mcpServers["${name}"]: ${type} server requires a non-empty "url"`)
        }
        break
      }
      case 'sdk': {
        const c = config as { name?: unknown; instance?: unknown }
        if (typeof c.name !== 'string' || c.name.length === 0) {
          throw new InvalidConfigError(`mcpServers["${name}"]: sdk server requires a non-empty "name"`)
        }
        if (c.instance === null || typeof c.instance !== 'object') {
          throw new InvalidConfigError(
            `mcpServers["${name}"]: sdk server requires an "instance" (use createSdkMcpServer())`,
          )
        }
        break
      }
      default:
        throw new InvalidConfigError(`mcpServers["${name}"]: unknown type "${type}" (expected stdio/http/sse/sdk)`)
    }
  }
  return servers
}

/**
 * 从 AgentConfig.session.store 提取 SDK SessionStore 对象。
 *
 * 公共 API 故意把类型设为 `unknown`（避免类型层依赖 SDK 类型），
 * 这里做结构性检查后再传给 SDK。
 */
function extractSessionStore(config: AgentConfig): SessionStore | null {
  const raw = config.session?.store
  if (raw === undefined || raw === null) return null

  if (typeof raw !== 'object') {
    throw new Error('AgentConfig.session.store must be an object implementing the SessionStore interface')
  }

  const candidate = raw as Record<string, unknown>
  if (typeof candidate.append !== 'function' || typeof candidate.load !== 'function') {
    throw new Error(
      'AgentConfig.session.store does not implement the SessionStore interface ' +
        '(append/load methods missing). Use CloudBaseSessionStore or implement the protocol.',
    )
  }

  return raw as SessionStore
}
