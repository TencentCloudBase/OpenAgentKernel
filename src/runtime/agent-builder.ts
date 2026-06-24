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
import { mkdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {
  HookCallback as SdkHookCallback,
  Options as ClaudeOptions,
  McpServerConfig as SdkMcpServerConfig,
  SessionStore,
  SettingSource,
} from '@anthropic-ai/claude-agent-sdk'
import { createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import {
  createPreToolUsePermissionHook,
  OAK_CLIENT_TOOL_RESULT_KEY,
  type PreToolUseHookLocalState,
  type ClientToolResultStore,
  type AskUserStore,
} from '../permissions/hooks.js'
import {
  ClaudeHomeSyncEngine,
  CloudBaseCosClaudeHomeStore,
  deriveAgentConfigDir,
  deriveClaudeConfigDir,
} from '../claude-home/index.js'
import { ConfigError, InvalidConfigError } from '../internal/errors.js'
import type { AgentConfig, SandboxConfig, ToolDefinition, UserMemoryConfig } from '../public/types.js'
import { createSandboxMcpServer } from '../sandbox/sandbox-tools.js'
import type { SandboxInstance, SandboxRuntime } from '../sandbox/types.js'
import { WorkspaceSnapshotEngine } from '../sandbox/workspace-snapshot/index.js'
import { PACKAGE_VERSION } from '../version.js'
import { resolveCredential, type ResolvedCredential } from './credential-factory.js'

/**
 * 默认 API 超时（10 分钟）。
 * CloudBase AI gateway 推荐值，避免长输出时被默认超时打断。
 * 参考：https://cloud.tencent.com/document/product/1823/130079
 */
const DEFAULT_API_TIMEOUT_MS = 600_000

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
  /**
   * OAK_DEBUG=1 时返回:我们指定给 SDK 的 claude CLI debug-file 绝对路径。
   * SDK 把子进程 --debug 的详细输出写到这个文件(而非 stderr),调用方(create-agent)
   * 在 query 结束后(尤其 0 消息时)读取它,把子进程 init/退出原因打到日志。
   */
  debugFilePath?: string
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
    /** askUser: store for pending askUser entries. */
    askUserStore?: AskUserStore
    /** Task 9 for userMemory:agent.startSession({ userId }) 透传过来 */
    userId?: string
  } = {},
): BuiltClaudeQueryParams {
  const credential = resolveCredential({
    envId: config.envId,
    model: config.model,
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
  const userMemoryEnabled = isUserMemoryEnabled(config.userMemory)
  if (userMemoryEnabled && extra.userId) {
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

  // effectiveCwd:
  //   1) 用户传 cwd → 用 userCwd(平台资产路径,如 /app/skills-bundle)
  //   2) 没传 → process.cwd()(进程实际工作目录)
  //
  // 职责边界:cwd 是"运行环境"的事,kernel 不替宿主猜可写目录。没传 cwd 时,最诚实的
  // 兜底是 process.cwd() —— 不自作主张造 ephemeral 目录(那是越权:kernel 不知道宿主
  // 哪里可写、session 目录怎么隔离/GC)。需要可写、隔离的工作目录时,由调用方(agent
  // runtime)显式传 config.cwd(它才掌握运行环境)。
  const effectiveCwd = userCwd ?? process.cwd()

  // ── cwd 可写性检查(serverless 只读 FS)─────────────────────────────
  // claude CLI 在 cwd 里会做事(git 检测、写临时文件、--add-dir 等)。cwd 不可写会让
  // 子进程在 init 阶段静默失败、exit 0 却 0 输出。这里只做"诚实报告":不可写就 warn
  // 明确指出原因 + 让调用方传可写 config.cwd,但不偷偷换路径(换路径也是越权)。
  if (probeWritable(effectiveCwd) !== true) {
    // eslint-disable-next-line no-console
    console.warn(
      `[oak] cwd '${effectiveCwd}' is not writable (serverless read-only FS?). ` +
        `The claude subprocess may exit silently with 0 output. ` +
        `Pass a writable AgentConfig.cwd from the caller (it owns the runtime FS layout).`,
    )
  }

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
  //   2) 其余所有情况 → tmpdir(/tmp 下的可写目录)
  //
  // 为什么不再用 `enablePersist ? ... : undefined`:
  //   claude CLI 把 CLAUDE_CONFIG_DIR 当成自己的"home"——配置、sessions、锁文件、
  //   XDG state/cache 等都落在它下面。不设置时 SDK 回落到宿主 $HOME/.claude。
  //   在云函数(SCF/CloudRun)里 $HOME 通常指向只读路径(/root 等),CLI 在产出任何
  //   stream message 之前就因 EROFS/EACCES 崩溃 → 上层收不到任何事件(静默)。
  //   所以无论是否启用持久化,都把 CLAUDE_CONFIG_DIR 兜底到 Agent 全局配置目录
  //   <workRoot>/.oak/agent/.claude(workRoot = OAK_SESSION_LOCAL_DIR ?? os.tmpdir())。
  //   这样不需要去改进程的 HOME 环境变量(那会影响同进程其它库),只用 claude 官方
  //   推荐的 CLAUDE_CONFIG_DIR 机制做隔离。
  // 优先级:userMemory 派生的 per-user 目录(.oak/users/<env>/<user>/.claude)> Agent 全局兜底。
  const configDirOverride = claudeConfigDir ?? deriveAgentConfigDir()

  // 透传给 SDK 子进程的环境变量
  const env: Record<string, string | undefined> = {
    ...process.env,
    ANTHROPIC_BASE_URL: credential.baseUrl,
    ANTHROPIC_AUTH_TOKEN: credential.apiKey,
    ANTHROPIC_API_KEY: undefined,
    API_TIMEOUT_MS: String(DEFAULT_API_TIMEOUT_MS),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_AGENT_SDK_CLIENT_APP: `@cloudbase/open-agent-kernel/${PACKAGE_VERSION}`,
    // claude CLI 的"home":配置/sessions/锁文件/XDG state 等都落在这里。
    // 始终设置,避免回落到云函数里只读的宿主 $HOME/.claude(见 configDirOverride 注释)。
    CLAUDE_CONFIG_DIR: configDirOverride,
    // OAK_DEBUG 时打开 SDK 自身的内部 logger(M6):它会把 spawn 命令行、子进程 exit
    // 原因、"Non-JSON stdout: ..."、transcript-mirror 写失败等关键诊断打到 stderr。
    // 这是"子进程 exit code 0 却 0 条消息"这类静默失败的唯一窗口 —— --debug 只让
    // 子进程更啰嗦,而 DEBUG_CLAUDE_AGENT_SDK 让父进程 SDK 把 spawn/exit 细节吐出来。
    ...(process.env.OAK_DEBUG === '1' ? { DEBUG_CLAUDE_AGENT_SDK: '1' } : {}),
  }

  // ── OAK_DEBUG:指定 claude CLI 的 debug-file ────────────────────────
  // 重要:SDK 在没传 debugFile 时会自己派生一个默认 debug-file 路径,把子进程 --debug
  // 的详细输出全写进去(不进 stderr)——这就是 stderr 回调收不到东西的原因。
  // 我们主动指定到可写的 CLAUDE_CONFIG_DIR/debug/ 下,且把路径回传给 create-agent,
  // 让它在 query 结束后(尤其 0 消息时)读取并打到日志 —— 拿到子进程 init/退出真因。
  let debugFilePath: string | undefined
  if (process.env.OAK_DEBUG === '1') {
    try {
      const debugDir = path.join(configDirOverride, 'debug')
      mkdirSync(debugDir, { recursive: true })
      debugFilePath = path.join(debugDir, `oak-${Date.now()}-${randomBytes(3).toString('hex')}.txt`)
    } catch {
      debugFilePath = undefined // mkdir 失败就算了,回退到 SDK 默认行为
    }
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
      cwd: effectiveCwd,
      claudeConfigDir: configDirOverride,
    })
  }

  // ── 决定权限模式（PR #7.0 / PR #7.1）─────────────────────────
  // PreToolUse hook 启用条件：
  //   - 用户配了 permissions.requireApproval（PR #7.0 审批流），或
  //   - 用户声明了 config.tools[]（PR #7.1 client-side 工具流），或
  //   - 上述任一并提供了 conversationId + hookLocalState（runtime 必须配齐）
  const hasClientTools = Boolean(config.tools && config.tools.length > 0)
  const hasApproval = config.permissions !== undefined && config.permissions.requireApproval !== undefined
  const hasAskUser = Boolean(extra.askUserStore)
  const userHasApprovalConfig =
    (hasApproval || hasClientTools || hasAskUser) && Boolean(extra.conversationId) && Boolean(extra.hookLocalState)

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
    // ── 内置 askUser 工具 → SDK MCP server 'kernel' (mcp__kernel__askUser)
    // 模型可通过此工具主动向用户提问，kernel 用 sentinel 中断 turn，
    // Host 收集回答后调 respondAskUser() resume。
    if (extra.askUserStore) {
      merged.kernel = createBuiltinAskUserMcpServer(extra.askUserStore, extra.conversationId)
    }
    // ── 用户自定义 ToolDefinition[] → SDK MCP server 'custom' (mcp__custom__*)
    // SDK 的 query() 不接受 tools 数组——所有工具必须打包成 MCP server 注入。
    // 用 'custom' 作为 server key（而不是 'kernel'）：模型看到的工具名前缀
    // mcp__custom__<name> 在语义上明确告诉调用链"这是用户声明的、由 client/上层
    // 业务代码实现的工具"，与 mcp__sandbox__* / mcp__cloudbase__* 区分开。
    if (config.tools && config.tools.length > 0) {
      merged.custom = wrapKernelToolsAsMcpServer(config.tools, {
        clientToolStore: extra.clientToolStore,
        conversationId: extra.conversationId,
      })
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
      ...(extra.askUserStore ? { askUserStore: extra.askUserStore } : {}),
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
    // ── OAK_DEBUG:把子进程 --debug 详细输出写到我们指定的可写文件(create-agent 会读它)──
    ...(debugFilePath ? { debugFile: debugFilePath } : {}),
    // ── settingSources(spec §4.1):用户传 cwd→['project'];否则 []（v0 isolation）──
    settingSources,
    strictMcpConfig: true,
    // 持久化策略：注入 store 时必须 true（SDK 强制约束）
    persistSession: enablePersist,
    // ACP adapter consumes SDK stream_event messages for token/tool input streaming.
    includePartialMessages: true,
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

  return { options, credential, syncEngine, snapshotEngine, ...(debugFilePath ? { debugFilePath } : {}) }
}

// ─── 辅助 ────────────────────────────────────────────────────────

function isUserMemoryEnabled(config: UserMemoryConfig | undefined): boolean {
  return config === true || (typeof config === 'object' && config.enabled === true)
}

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
function wrapKernelToolsAsMcpServer(
  tools: ToolDefinition[],
  opts?: { clientToolStore?: ClientToolResultStore; conversationId?: string },
): ReturnType<typeof createSdkMcpServer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdkTools: any[] = tools.map((t) =>
    sdkTool(
      t.name,
      t.description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      t.parameters as any,
      async (input: Record<string, unknown>) => {
        // PR #7.1: client-side tool fast path.
        //
        // Claude Agent SDK does NOT pass `updatedInput` from the PreToolUse
        // hook to the MCP server's execute(). So we cannot rely on the magic
        // key injection approach. Instead, the MCP stub checks the
        // `clientToolStore` directly for a pending result with matching
        // toolName. The hook stores the result there (via scanRecent) before
        // allowing the call, so by the time execute() runs, the result is
        // already waiting.
        if (opts?.clientToolStore && opts?.conversationId && opts.clientToolStore.scanRecent) {
          const scanned = await opts.clientToolStore.scanRecent({
            conversationId: opts.conversationId,
            toolName: t.name,
          })
          if (scanned?.result) {
            await opts.clientToolStore.delete({
              conversationId: opts.conversationId,
              toolUseId: scanned.toolUseId,
            })
            const text =
              typeof scanned.result.output === 'string' ? scanned.result.output : JSON.stringify(scanned.result.output)
            return {
              content: [{ type: 'text', text }],
              isError: !!scanned.result.isError,
            }
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

/**
 * 创建内置 askUser MCP server。
 *
 * 注册一个 `askUser` 工具，模型可通过它主动向用户提问。
 * 工具的 execute() 是 stub——实际执行由 PreToolUse hook 拦截（sentinel 模式），
 * Host 收集用户回答后调 session.respondAskUser() resume。
 *
 * resume 时 hook 从 store 读到回答 → allow → 此 stub 读取回答并返回。
 */
function createBuiltinAskUserMcpServer(
  askUserStore: AskUserStore,
  conversationId?: string,
): ReturnType<typeof createSdkMcpServer> {
  const askUserTool = sdkTool(
    'askUser',
    'Ask the user a question and wait for their answer. Use this when you need clarification, confirmation, or a choice from the user.',
    {
      question: z.string().describe('The question to ask the user'),
      options: z
        .array(z.string())
        .optional()
        .describe('Optional predefined answer options for the user to choose from'),
    },
    async (input: Record<string, unknown>) => {
      // Resume path: check if an answer is already stashed in the store.
      if (conversationId && askUserStore.scanRecent) {
        const questionText = (input.question as string) ?? ''
        const scanned = await askUserStore.scanRecent({
          conversationId,
          question: questionText,
        })
        if (scanned?.result) {
          await askUserStore.delete({
            conversationId,
            toolUseId: scanned.toolUseId,
          })
          return {
            content: [{ type: 'text', text: scanned.result.answer }],
          }
        }
      }
      // Should not reach here in normal flow — the hook intercepts before execute().
      return {
        content: [{ type: 'text', text: '(askUser: no answer available)' }],
        isError: true,
      }
    },
  )
  return createSdkMcpServer({
    name: 'kernel',
    version: '1.0.0',
    tools: [askUserTool],
  })
}

/**
 * 探测一个目录是否可写(诊断用,不抛错)。
 * 返回 true / false / 'missing'(目录不存在或探测异常)。
 */
function probeWritable(dir: string): true | false | 'missing' {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.oak-write-probe-${randomBytes(3).toString('hex')}`)
    // 用同步 fs 直接试写删 —— 避免引入额外异步链路
    writeFileSync(probe, 'x')
    unlinkSync(probe)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 'missing'
    return false
  }
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
