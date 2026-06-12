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

import { randomBytes } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {
  HookCallback as SdkHookCallback,
  Options as ClaudeOptions,
  McpServerConfig as SdkMcpServerConfig,
  SessionStore,
  SettingSource,
} from '@anthropic-ai/claude-agent-sdk'
import { ClaudeHomeSyncEngine, CloudBaseCosClaudeHomeStore, deriveClaudeConfigDir } from '../claude-home/index.js'
import { ConfigError, InvalidConfigError } from '../internal/errors.js'
import { createPreToolUsePermissionHook, type PreToolUseHookLocalState } from '../permissions/hooks.js'
import type { AgentConfig, SandboxConfig } from '../public/types.js'
import { createSandboxMcpServer } from '../sandbox/sandbox-tools.js'
import type { SandboxInstance, SandboxRuntime } from '../sandbox/types.js'
import { WorkspaceSnapshotEngine } from '../sandbox/workspace-snapshot/index.js'
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
  /**
   * 当 userMemory.enabled = true 时返回的同步引擎。
   * 调用方(create-agent.ts)负责挂到 session.send 两端:
   *   send-start → syncEngine.pullOnSendStart()
   *   send-end (含 abort) → syncEngine.pushOnSendEnd()
   */
  syncEngine?: ClaudeHomeSyncEngine
  /**
   * Spec B 新增。当 sandbox.workspaceSnapshot 解析为启用时返回。
   * 调用方(create-agent.ts Task 8)负责:
   *   - startSession 时调用 engine.bootstrap(inst, { credentials })
   *   - send-end 后调用 engine.snapshot(inst)
   *   - session.snapshotWorkspace() / getRestoreStatus() 转发到 engine
   */
  snapshotEngine?: WorkspaceSnapshotEngine
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
    /** Task 9 for userMemory:agent.startSession({ userId }) 透传过来 */
    userId?: string
  } = {},
): BuiltClaudeQueryParams {
  const credential = resolveCredential({
    envId: config.envId,
    model: config.model,
    resources: config.resources,
  })

  // ── cwd / settingSources / userMemory 派生(spec §4.1 + §4.2 + §4.6)─────
  //
  // settingSources 决定 SDK 是否扫描文件系统加载资产:
  //   - 'project' → 扫 <cwd>/.claude/(skills、项目级 CLAUDE.md、rules 等)
  //   - 'user'    → 扫 ~/.claude/(被 CLAUDE_CONFIG_DIR override)
  //                 - <CLAUDE_CONFIG_DIR>/CLAUDE.md(用户级偏好)
  //                 - <CLAUDE_CONFIG_DIR>/projects/<cwd-hash>/memory/(主会话 auto-memory)
  //                 - <CLAUDE_CONFIG_DIR>/agent-memory/(用户级 subagent memory)
  //                 这些都在 SYNC_INCLUDES 内(spec §3.4)— 同步到 COS。
  //   - []        → 完全不读文件系统(v0 isolation)
  //
  // 安全:'user' 在我们的部署模型里**不指宿主机 ~/.claude**,因为我们在 userMemory
  // 启用时把 CLAUDE_CONFIG_DIR 显式 redirect 到 per-user 派生目录。
  const userCwd = config.cwd
  if (userCwd) {
    assertSafeUserCwd(userCwd)
  }

  // userMemory 启用时,先派生 claudeConfigDir(per-user 稳定路径)。
  // 也用作 effectiveCwd:让 SDK 的 projects/<cwd-hash>/memory/ 跨节点可复用。
  let claudeConfigDir: string | undefined
  let syncEngine: ClaudeHomeSyncEngine | undefined
  if (config.userMemory?.enabled && extra.userId) {
    try {
      claudeConfigDir = deriveClaudeConfigDir(config.envId, extra.userId)
      syncEngine = new ClaudeHomeSyncEngine({
        store: new CloudBaseCosClaudeHomeStore({
          credentials: config.credentials
            ? { ...config.credentials, envId: config.credentials.envId ?? config.envId }
            : undefined,
        }),
        ctx: { envId: config.envId, userId: extra.userId },
        localDir: claudeConfigDir,
      })
    } catch (err) {
      // ResourceError / InvalidConfigError 等 → graceful degrade,本次 send 不同步,继续工作
      // eslint-disable-next-line no-console
      console.warn(
        '[oak/userMemory] failed to construct sync engine, sync disabled this turn:',
        (err as Error)?.message,
      )
      claudeConfigDir = undefined
      syncEngine = undefined
    }
  }

  // effectiveCwd 优先级:
  //   1) 用户传 cwd → 用 userCwd(平台资产路径,如 /app/skills-bundle)
  //   2) userMemory 启用 → 用 claudeConfigDir 上一级(确保 SDK projects/<cwd-hash>/ 跨节点稳定)
  //   3) 都没有 → ephemeral 随机(v0 行为)
  const effectiveCwd = userCwd ?? (claudeConfigDir !== undefined ? path.dirname(claudeConfigDir) : deriveEphemeralCwd())

  // settingSources 启用条件:任一资产层需要文件加载
  //   - 用户传 cwd → 'project'(skills、项目 CLAUDE.md)
  //   - userMemory 启用 → 'user'(SDK auto-memory / 用户级 CLAUDE.md / agent-memory)
  // 'user' 安全性:CLAUDE_CONFIG_DIR override 让 'user' 指向 per-user 隔离目录,不是宿主机。
  const settingSources: SettingSource[] = []
  if (userCwd) settingSources.push('project')
  if (claudeConfigDir) settingSources.push('user')

  // ── Skills 启用前置校验(spec §4.1.2)──────────
  // 启用 skills 但未传 cwd → SDK 找不到 SKILL.md(settingSources 没含 'project')
  // 静默无效易混淆 → 显式 warning(不抛错,不破坏向后兼容)
  if (config.skills?.enabled !== undefined && !userCwd) {
    // eslint-disable-next-line no-console
    console.warn(
      '[oak/skills] skills configured but cwd not set — SKILL.md will not be discovered. ' +
        'Pass `cwd` pointing to a directory containing `.claude/skills/`.',
    )
  }

  // ── 决定是否启用 SDK 持久化 ──────────────────────────────────────
  // SDK persistSession=false 会禁用 ~/.claude/projects/<cwd-hash>/ 目录创建,
  // 连带 SDK auto-memory 写 MEMORY.md 也无处可去(SDK 文档:"Sessions will not
  // be saved to ~/.claude/projects/ and cannot be resumed later")。
  //
  // 启用条件(任一即可):
  //   1) sessionStore 注入(dual-write 模式 — SDK 强制 persistSession=true)
  //   2) userMemory.enabled(SDK auto-memory 需要 projects/ 目录承载 MEMORY.md)
  //   3) 默认走 SDK default(true)— OAK 历史上为了 isolation 强制关,但那导致
  //      auto-memory 完全失效;现在仅当用户显式不需要任何持久化时由调用方关闭。
  const sessionStore = extractSessionStore(config)
  const enablePersist = sessionStore !== null || syncEngine !== undefined

  // CLAUDE_CONFIG_DIR 单一来源(优先级):
  //   1) userMemory.enabled + userId → per-user 派生路径
  //   2) sessionStore enablePersist → tmpdir(避免污染 host)
  //   3) 都没有 → 不设置(SDK 用默认)
  // 显式合并避免依赖 spread 顺序,后续维护更稳。
  const configDirOverride = claudeConfigDir ?? (enablePersist ? getSessionLocalDir() : undefined)

  // 透传给 SDK 子进程的环境变量
  const env: Record<string, string | undefined> = {
    ...process.env,
    ANTHROPIC_BASE_URL: credential.baseUrl,
    ANTHROPIC_AUTH_TOKEN: credential.apiKey,
    ANTHROPIC_API_KEY: undefined,
    API_TIMEOUT_MS: String(DEFAULT_API_TIMEOUT_MS),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_AGENT_SDK_CLIENT_APP: '@cloudbase/open-agent-kernel/0.2.0-alpha.0',
    ...(configDirOverride ? { CLAUDE_CONFIG_DIR: configDirOverride } : {}),
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

  // ── 决定权限模式（PR #7.0）──────────────────────────────────
  // PR #5 阶段为了让 mcpServers 工具直接放行，默认走 permissionMode='bypassPermissions'。
  // PR #7.0 起，如果用户配了 permissions.requireApproval，则启用 PreToolUse hook 实现审批流，
  // permissionMode 不再 bypass（让 hook 决策生效）。
  const userHasApprovalConfig =
    config.permissions !== undefined &&
    config.permissions.requireApproval !== undefined &&
    Boolean(extra.conversationId) &&
    Boolean(extra.hookLocalState)

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
    return Object.keys(merged).length > 0 ? merged : undefined
  })()

  // ── PR #7.0：构造 PreToolUse hook（审批桥接）──
  const hooks: ClaudeOptions['hooks'] = (() => {
    if (!userHasApprovalConfig) return undefined
    const preToolUseHook = createPreToolUsePermissionHook({
      conversationId: extra.conversationId!,
      permissions: config.permissions!,
      localState: extra.hookLocalState!,
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

  // ── Spec B:workspace snapshot 引擎装配 ──
  // resolveSnapshotMode 决定是否启用、做 scope 校验,失败抛 ConfigError。
  // 启用时构造 WorkspaceSnapshotEngine,实际触发(bootstrap / snapshot)由 create-agent
  // 在 startSession / send-end 时挂载(Task 8)。
  //
  // 注意:必须用条件展开避免把 undefined 透到 engine —— `{ ...DEFAULT, ...opts }`
  // 模式下,显式赋 undefined 会覆盖默认值,导致 setTimeout(undefined) 立即触发,
  // bootstrap 会以 SandboxRestoreTimeout: init timeout after undefinedms 失败。
  const snapshotEnabled = resolveSnapshotMode(config.sandbox)
  const snapshotEngine = snapshotEnabled
    ? new WorkspaceSnapshotEngine({
        ...(config.sandbox?.workspaceSnapshotTimeoutMs !== undefined && {
          snapshotTimeoutMs: config.sandbox.workspaceSnapshotTimeoutMs,
        }),
        ...(config.sandbox?.workspaceInitTimeoutMs !== undefined && {
          initTimeoutMs: config.sandbox.workspaceInitTimeoutMs,
        }),
      })
    : undefined

  const options: ClaudeOptions = {
    model: credential.modelId,
    env,
    cwd: effectiveCwd,
    // ── settingSources(spec §4.1):用户传 cwd→['project'];否则 []（v0 isolation）──
    settingSources,
    strictMcpConfig: true,
    // 持久化策略：注入 store 时必须 true（SDK 强制约束）
    persistSession: enablePersist,
    ...(sessionStore ? { sessionStore } : {}),
    ...(config.session?.flush ? { sessionStoreFlush: config.session.flush } : {}),
    // ── 系统提示 ──
    ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
    // ── Skills 注入(spec §4.1):仅当用户显式配置时透传 ──
    ...(config.skills?.enabled !== undefined ? { skills: config.skills.enabled } : {}),
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
    // ── 内置工具默认全部禁用(沙箱能力通过上面的 mcpServers 提供)──
    // 例外:启用 skills 时必须保留 'Skill' 工具,否则模型无法 invoke discovered skills
    // (SDK 文档:"If you also pass an explicit tools list, include 'Skill' in that list
    //   so Claude can invoke skills.")
    tools: config.skills?.enabled !== undefined ? ['Skill'] : [],
  }

  return { options, credential, syncEngine, snapshotEngine }
}

// ─── 辅助 ────────────────────────────────────────────────────────

/**
 * Spec B:解析 workspaceSnapshot 模式 + 校验 scope。
 *
 * 决策表(spec §1.3 / §2.4):
 *   workspaceSnapshot   runtime.backend       结果
 *   ──────────────────  ────────────────────  ──────────────────────
 *   'disabled'          *                     不启用
 *   'auto' / undefined  'ags-stateful'        启用(校验 scope)
 *   'auto' / undefined  其他                   不启用(silent)
 *   'enabled'           'ags-stateful'        启用(校验 scope)
 *   'enabled'           其他                   throw ConfigError
 *
 * 启用后 scope 必须是 'shared'(同 envId 共享容器,跨 session 接续 cwd),
 * 否则 throw ConfigError(包括 scope='session' 和 scope undefined 默认场景)。
 */
function resolveSnapshotMode(sandboxConfig: SandboxConfig | undefined): boolean {
  const mode = sandboxConfig?.workspaceSnapshot ?? 'auto'
  const scope = sandboxConfig?.scope ?? 'session'
  const runtime = sandboxConfig?.runtime as SandboxRuntime | undefined
  const backend = runtime?.backend
  const supportsSnapshot = backend === 'ags-stateful'

  if (mode === 'disabled') return false

  // mode='enabled' but runtime can't snapshot → 显式抛错(用户主动要求,但能力不匹配)
  if (mode === 'enabled' && !supportsSnapshot) {
    throw new ConfigError(
      `workspaceSnapshot='enabled' but runtime.backend='${backend}' does not support snapshot. ` +
        `Use AgsStatefulSandbox or set workspaceSnapshot='disabled'.`,
    )
  }

  // mode='auto' + 不支持 snapshot 的 runtime → 静默不启用
  if (mode === 'auto' && !supportsSnapshot) return false

  // 到这里 mode 是 'enabled' 或 'auto',且 backend 支持 snapshot → 必须 scope='shared'
  if (scope !== 'shared') {
    throw new ConfigError(
      `workspaceSnapshot 要求 sandbox.scope='shared'(同 envId 共享容器,跨 session 接续 cwd),` +
        `当前 scope='${scope}'。改为 createAgent({ sandbox: { scope: 'shared', ... } })。` +
        `详见 Spec B §1.3。`,
    )
  }
  return true
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

/**
 * 派生 OAK 自管的纯净 ephemeral cwd(用户没传 cwd 时使用)。
 *
 * 这个目录是空白的,settingSources=[]:SDK 进去什么都读不到,等价 v0 isolation。
 * 进程级:每个 SDK 进程实例化时生成一次,进程结束时清理(我们不主动清,依赖 OS tmpdir GC)。
 *
 * **必须 mkdir**:SDK spawn 子进程时若 cwd 不存在会 ENOENT 崩溃。
 * 用 crypto.randomBytes 取代 Math.random,避免可预测性(虽然非安全场景)。
 */
let ephemeralCwdCache: string | undefined
function deriveEphemeralCwd(): string {
  if (ephemeralCwdCache) return ephemeralCwdCache
  const random = randomBytes(4).toString('hex')
  ephemeralCwdCache = path.join(os.tmpdir(), `oak-ephemeral-${random}`)
  mkdirSync(ephemeralCwdCache, { recursive: true })
  return ephemeralCwdCache
}

/**
 * 拒绝用户传 ~/.claude 或其子目录作 cwd(防止误用 + 跨用户读取宿主机配置)。
 * Spec A §5.1 安全约束。
 *
 * 用 realpathSync 解析 symlink,避免 cwd='/data/projects/foo'(符号链接到 ~/.claude)
 * 绕过校验。如果路径不存在(尚未创建),fall back 到 path.resolve 仅做字面校验。
 */
function assertSafeUserCwd(cwd: string): void {
  let absolute: string
  try {
    absolute = realpathSync(cwd)
  } catch {
    absolute = path.resolve(cwd)
  }
  const home = os.homedir()
  const homeClaude = path.join(home, '.claude')
  if (absolute === homeClaude || absolute.startsWith(homeClaude + path.sep)) {
    throw new InvalidConfigError(
      `AgentConfig.cwd cannot point at host ~/.claude/ or its subdirectory (got ${cwd}, resolved to ${absolute}). ` +
        'OAK refuses to share host-level Claude config across multi-tenant requests.',
    )
  }
}
