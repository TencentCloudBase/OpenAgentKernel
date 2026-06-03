/**
 * Public TypeScript types for @cloudbase/open-agent-kernel
 *
 * 这些类型是 SDK 对外的稳定契约，任何修改需要走 semver 流程。
 * 内部实现位于 src/runtime/, src/resources/, src/session-store/ 等模块，
 * 不导出给用户。
 */

import type { McpServerConfig as SdkMcpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { z } from 'zod'

// ============================================================
// 资源配置（envId 派生 + 用户覆盖）
// ============================================================

/**
 * 资源命名配置（可选；不传按规则从 envId 派生）
 *
 * 派生规则：
 * - conversationCollection: 'agent_conversations'
 * - messageCollection: 'agent_messages'
 * - sandboxFunctionName: 'agent-sandbox'
 * - modelGatewayBaseUrl: 'https://{envId}.api.tcloudbasegateway.com/v1/anthropic'
 *   (走 CloudBase 网关的 Anthropic 协议；如需 OpenAI 协议网关，使用 modelGatewayBaseUrl 覆盖)
 */
export interface ResourceConfig {
  conversationCollection?: string
  messageCollection?: string
  sandboxFunctionName?: string
  /** 自定义模型网关 URL（覆盖默认派生）*/
  modelGatewayBaseUrl?: string
}

// ============================================================
// 模型配置
// ============================================================

/**
 * 模型可以是简单字符串（kernel 自动派生 baseUrl + key），
 * 或完整 ModelSpec（用户自带 key 场景）
 */
export type ModelInput = string | ModelSpec

export interface ModelSpec {
  /** 模型 ID，如 'hunyuan-t1-latest' / 'deepseek-v3.2' / 'gpt-5' */
  id: string
  /** 不传则走 CloudBase 网关代理（计费走平台）；传则用自带 key */
  apiKey?: string
  /** 自带 key 时的 endpoint */
  apiBaseUrl?: string
  /** 透传到底层 provider 的额外选项 */
  options?: Record<string, unknown>
}

// ============================================================
// Sandbox 配置（Claude Agent SDK 文件系统/Shell/Skills/Memory/Compaction 能力封装）
// ============================================================

export interface SandboxConfig {
  /**
   * Sandbox 后端实例（由用户从 `@cloudbase/open-agent-kernel/sandbox` 子模块构造，
   * 例如 `new AgsStatefulSandbox()`）。
   * 不传 `runtime` 时不启用任何沙箱（agent 只能跑模型对话，无文件系统/shell 能力）。
   *
   * 类型故意宽泛（unknown），避免公共类型层依赖底层实现。
   */
  runtime?: unknown
  /**
   * 沙箱粒度：
   * - `'session'`（默认）：每个 startSession 一个独立 AGS 实例，session.abort 时 Pause。
   * - `'shared'`：同 envId 多个 session 共享一个 AGS 实例，按需 Resume / Stop 漂移实例，
   *   abort 不 Pause（由 AGS 按 DefaultTimeout 自动回收）。
   */
  scope?: 'session' | 'shared'
  /** 沙箱生命周期（秒，传给 AGS Timeout）*/
  ttl?: number
  /** 启用的 sandbox capabilities */
  capabilities?: SandboxCapabilities

  /**
   * 是否在沙箱里自动暴露 CloudBase MCP 工具集（PR #6.5）。
   *
   * - `true`（默认）：sandbox acquire 之后，自动调 `mcporter list cloudbase --schema`
   *   发现 cloudbase 工具集（DB / COS / 云函数 / 静态托管 / …），
   *   注入沙箱内 `/api/workspace/env` 凭证，然后封装为 `mcp__cloudbase__*` 工具暴露给 agent。
   * - `false`：完全不暴露 cloudbase 工具，agent 只能用 `mcp__sandbox__*` 文件系统/shell 工具。
   *
   * 仅在镜像内置 mcporter + cloudbase-mcp 时生效（默认 OpenVibeCoding 公开 vibecoding 镜像）。
   * 镜像不带这两个工具时会自动 degrade（warning，不阻塞 session 启动）。
   */
  cloudbaseTools?: boolean

  /**
   * 用户租户的 CloudBase 凭证（仅 PR #6.5 cloudbase MCP 工具调用时使用）。
   *
   * 与 sandbox 控制面凭证（process.env.TCB_SECRET_ID/KEY，由平台持有）**不一定相同**——
   * 多租户场景下沙箱本身用平台凭证起，但沙箱内 cloudbase-mcp 操作的是用户自己的资源。
   *
   * 优先级：
   *   1. `userCredentials` 函数（异步回调，每次 acquire 调一次，适合多租户）
   *   2. `userCredentials` 静态对象（适合单租户/本地开发）
   *   3. `process.env`（兜底）：`TCB_ENV_ID` / `TCB_SECRET_ID` / `TCB_SECRET_KEY` / `TCB_TOKEN`
   *
   * 缺凭证时 cloudbase 工具会 degrade（agent 仍能用文件系统 / shell 工具）。
   */
  userCredentials?: SandboxUserCredentials | (() => Promise<SandboxUserCredentials>)
}

/**
 * 沙箱内 cloudbase-mcp 工具调用使用的用户租户凭证。
 *
 * 注入到沙箱 `/api/workspace/env`：
 *   CLOUDBASE_ENV_ID, TENCENTCLOUD_SECRETID, TENCENTCLOUD_SECRETKEY, TENCENTCLOUD_SESSIONTOKEN
 */
export interface SandboxUserCredentials {
  /** CloudBase 环境 ID（不传则回退到 AgentConfig.envId） */
  envId?: string
  secretId: string
  secretKey: string
  /** 临时 token（CAM 临时凭证场景），可选 */
  sessionToken?: string
}

export interface SandboxCapabilities {
  /** 文件系统工具（read/write/edit/ls/glob/grep）*/
  filesystem?: boolean
  /** Shell 工具（bash 命令）*/
  shell?: boolean
  /**
   * Skills（领域知识进阶式披露）
   * - true: 启用但无内置 skills
   * - { sources }: 加载指定 SKILL.md 文件
   */
  skills?: boolean | { sources: string[] }
  /** Memory（跨 run 学习）*/
  memory?: boolean
  /** Compaction（长会话自动压缩）*/
  compaction?: boolean | CompactionConfig
}

export interface CompactionConfig {
  /** 触发压缩的条目数阈值，默认 10 */
  threshold?: number
  /** 自定义判定函数（基于 token 数 / 自定义启发式）*/
  shouldTrigger?: (ctx: { itemCount: number; tokenCount?: number }) => boolean
}

// ============================================================
// 工具定义
// ============================================================

export interface ToolDefinition<TInput extends Record<string, unknown> = Record<string, unknown>, TOutput = unknown> {
  name: string
  description: string
  /** Zod schema，必须是 zod ^4.0.0 */
  parameters: z.ZodType<TInput>
  /** 是否需要审批（HITL）*/
  needsApproval?: boolean
  /** 工具执行函数 */
  execute: (input: TInput, ctx: ToolContext) => Promise<TOutput>
}

export interface ToolContext {
  toolUseId: string
  conversationId: string
  userId: string
  envId: string
  /** 取消信号 */
  signal: AbortSignal
}

// ============================================================
// MCP server 配置
// ============================================================

/**
 * MCP server 配置，**直接对齐 Claude Agent SDK 的 `McpServerConfig`**。
 *
 * 4 种形态：
 * - `stdio`：spawn 子进程并通过 stdio pipe 通信（如 `npx @some/mcp-server`）
 * - `http`：远程 HTTP（streamable transport）
 * - `sse`：远程 SSE（已弃用，仅向后兼容）
 * - `sdk`：进程内 SDK server（用 `createSdkMcpServer()` 构造，零网络开销）
 *
 * 形态 / 字段含义见 Claude SDK 文档。kernel 不做改写、不做封装，纯透传。
 *
 * @example 进程内 SDK server（推荐用于 kernel-side 的本地工具）
 * ```ts
 * import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
 * mcpServers: {
 *   myTools: createSdkMcpServer({
 *     name: 'myTools',
 *     tools: [tool('add', 'Add two numbers', { ... }, async (args) => ...)],
 *   }),
 * }
 * ```
 *
 * @example stdio 子进程（接入 npm 包形式的 MCP server）
 * ```ts
 * mcpServers: {
 *   everything: {
 *     type: 'stdio',
 *     command: 'npx',
 *     args: ['-y', '@modelcontextprotocol/server-everything'],
 *   },
 * }
 * ```
 */
export type McpServerConfig = SdkMcpServerConfig

// ============================================================
// 权限配置（HITL, PR #7.0）
// ============================================================

/**
 * 审批决策（用户对 tool_approval_required 的响应）。
 *
 * 这是协议无关的超集——业务侧的 ACP / AG-UI / 自家 SSE 等协议只需要把
 * 自己的决策枚举映射成下面的字段即可。
 *
 * @example 允许一次
 *   { kind: 'allow' }                         // 等价于 { kind: 'allow', scope: 'once' }
 *
 * @example 本次会话内永久放行该工具
 *   { kind: 'allow', scope: 'session' }       // 后续同名工具调用自动放行
 *
 * @example 允许，但替换参数（用户在 UI 上改了路径）
 *   { kind: 'allow', updatedInput: { path: '/safe/dir' } }
 *
 * @example 拒绝
 *   { kind: 'deny', reason: '用户拒绝' }
 *
 * @example 拒绝并打断后续推理（停止当轮 agent 运行）
 *   { kind: 'deny', interrupt: true, reason: '危险操作' }
 */
export type ApprovalDecision =
  | {
      kind: 'allow'
      /**
       * 决策影响范围（默认 'once'）：
       * - 'once'：仅本次工具调用
       * - 'session'：本次 session 内同名工具自动放行（不再触发审批）
       * - 'forever'：业务可自行解释为"用户偏好"长期记忆（PR #7.0 不保证持久化语义，
       *              业务侧需自己实现跨 session 记忆）
       */
      scope?: 'once' | 'session' | 'forever'
      /** 用户改写了工具参数（如修正路径） */
      updatedInput?: Record<string, unknown>
    }
  | {
      kind: 'deny'
      scope?: 'once' | 'session'
      reason?: string
      /** true 时本轮 agent 运行直接结束，不让模型对这次 deny 继续思考 */
      interrupt?: boolean
    }

/**
 * 暂存的待审批工具调用（写入 PermissionStore 的数据形态）。
 */
export interface PendingApproval {
  conversationId: string
  toolUseId: string
  toolName: string
  toolInput: unknown
  /** 创建时间戳（ms） */
  createdAt: number
  /** 用户已做出的决策（pending 阶段为 undefined） */
  decision?: ApprovalDecision
}

/**
 * 审批状态外部存储接口（让 HITL 支持分布式扩展）。
 *
 * - 不传 store：kernel 使用进程内 `InMemoryPermissionStore`（单进程可用）
 * - 传 store：可跨节点 / 跨进程 resume；同一 conversationId 的请求可路由到任意节点
 *
 * 接口与 SessionStoreDriver 同套路：内置 InMemory（默认）+ CloudBaseDb（生产）+ 用户可自实现。
 */
export interface PermissionStore {
  /** 写入 / 覆盖（写决策、写 pending 都走这里） */
  put(call: PendingApproval): Promise<void>
  /** 按 conversationId + toolUseId 取回 */
  get(key: { conversationId: string; toolUseId: string }): Promise<PendingApproval | null>
  /** 删除 */
  delete(key: { conversationId: string; toolUseId: string }): Promise<void>
}

/**
 * 工具审批匹配规则。
 *
 * - 字符串通配符：`'*'` 匹配任意工具；`'Bash'` 严格匹配；`'mcp__cloudbase__*'` 前缀匹配
 * - 函数：返回 true 表示需要审批
 *
 * 多个字符串规则之间为"任一匹配即触发审批"。
 */
export type RequireApprovalRule =
  | string
  | string[]
  | ((ctx: { toolName: string; input: unknown; conversationId: string }) => boolean | Promise<boolean>)

export interface PermissionConfig {
  /**
   * 哪些工具调用需要审批。不配置 → 全部工具直接放行（PR #5 默认 bypass 行为）。
   *
   * @example 全部工具都要审批
   *   { requireApproval: '*' }
   *
   * @example 按工具名通配符列表
   *   { requireApproval: ['Bash', 'mcp__cloudbase__deleteCollection', 'mcp__sandbox__write'] }
   *
   * @example 自定义函数
   *   { requireApproval: (ctx) => ctx.toolName === 'Bash' && /rm\s+-rf/.test(JSON.stringify(ctx.input)) }
   */
  requireApproval?: RequireApprovalRule

  /**
   * 审批状态存储。不传走进程内 `InMemoryPermissionStore`。
   *
   * 单进程场景下 InMemory 够用；多副本部署 / 云函数 / 跨设备审批需传入分布式实现
   * （PR #7.1 将提供 `CloudBasePermissionStore`）。
   */
  store?: PermissionStore

  /**
   * 审批超时（毫秒）。超过后 `respondApproval` 仍能注入决策（如果 store 还在），
   * 但 store 里超时的 pendingApproval 会被视为 stale，hook 拒绝二次注入。
   * 默认 1800_000（30 分钟），参考 tcb-headless-service.copilot。
   */
  approvalTimeoutMs?: number
}

// ============================================================
// Hooks（业务旁路 / 改写）
// ============================================================

export interface AgentHooks {
  onUserMessage?: (
    ctx: UserMessageContext,
  ) => Promise<void | { modifiedPrompt?: string }> | void | { modifiedPrompt?: string }

  onToolStart?: (ctx: ToolStartContext) => Promise<void> | void
  onToolEnd?: (ctx: ToolEndContext) => Promise<void | { updatedOutput?: unknown }> | void | { updatedOutput?: unknown }

  onAgentMessage?: (ctx: AgentMessageContext) => Promise<void> | void
  onSessionStart?: (ctx: SessionContext) => Promise<void> | void
  onSessionEnd?: (ctx: SessionContext) => Promise<void> | void
}

export interface UserMessageContext {
  conversationId: string
  userId: string
  prompt: string
}

export interface ToolStartContext extends ToolContext {
  toolName: string
  input: unknown
}

export interface ToolEndContext extends ToolStartContext {
  output: unknown
  isError: boolean
}

export interface AgentMessageContext {
  conversationId: string
  userId: string
  text: string
}

export interface SessionContext {
  conversationId: string
  userId: string
  envId: string
}

// ============================================================
// Agent 配置（顶层入口）
// ============================================================

export interface AgentConfig {
  // ── 元信息 ──────────────────────────────────────
  name?: string
  description?: string
  metadata?: Record<string, unknown>

  // ── 资源锚点 ────────────────────────────────────
  envId: string
  resources?: ResourceConfig

  // ── 模型 ────────────────────────────────────────
  model: ModelInput
  systemPrompt?: string

  // ── 能力 ────────────────────────────────────────
  tools?: ToolDefinition<any, any>[]
  mcpServers?: Record<string, McpServerConfig>
  /** 子 agent（handoffs） */
  handoffs?: Agent[]
  sandbox?: SandboxConfig
  permissions?: PermissionConfig

  // ── 会话持久化 ──────────────────────────────────
  session?: SessionConfig

  // ── 多模态附件存储 ──────────────────────────────
  /**
   * StorageProvider 实例（由 `@cloudbase/open-agent-kernel/storage` 导出）。
   * 不传：传入 attachments 时抛错（不支持多模态）；
   * 传：kernel 把 SessionInput.attachments 解析为 image content block 喂给 SDK。
   *
   * 类型故意宽泛（unknown），避免公共类型层依赖底层实现。
   */
  storage?: unknown

  // ── 钩子 ────────────────────────────────────────
  hooks?: AgentHooks
}

/**
 * 会话持久化配置。
 *
 * 不传 `store`：transcript 仅在 SDK 子进程的本地临时目录里（进程退出即丢，
 *               不可跨节点 resume）。
 * 传 `store`：transcript 镜像到外部存储（CloudBase DB / 自定义 driver）。
 *
 * 注意：本接口刻意不导出底层 SDK 的 `SessionStore` 类型，避免锁定 runtime。
 *       store 对象通过 `kernel/session-store` 子模块的 `CloudBaseSessionStore`
 *       构造，详见 README。
 */
export interface SessionConfig {
  /**
   * 兼容 Claude Agent SDK SessionStore 接口的 store 对象。
   *
   * 推荐用法：
   *   ```ts
   *   import { CloudBaseSessionStore, CloudBaseDbDriver } from '@cloudbase/open-agent-kernel'
   *   session: { store: new CloudBaseSessionStore({ driver: new CloudBaseDbDriver() }) }
   *   ```
   *
   * 类型故意宽泛（unknown），避免公共类型层依赖底层 runtime SDK 的类型。
   * 内部 runtime/agent-builder 会做结构性校验后传给 SDK。
   */
  store?: unknown

  /**
   * Project key（多租户隔离）
   * 默认：envId
   */
  projectKey?: string

  /**
   * 落盘策略
   * - 'batched'（默认）：每次 turn 结束批量写
   * - 'eager'：每帧立即写（实时性高，存储压力大）
   */
  flush?: 'batched' | 'eager'
}

// ============================================================
// Agent / Session 接口
// ============================================================

export interface Agent {
  readonly id: string
  readonly name?: string

  startSession(opts: SessionStartOptions): Promise<Session>
  /** 用 session ID 或 RunState JSON 恢复会话 */
  resumeSession(stateJsonOrConversationId: string): Promise<Session>

  sessions: SessionManagement
}

export interface SessionStartOptions {
  userId: string
  conversationId?: string
  title?: string
  /** 业务自定义元数据（透传到 SessionSummary）*/
  metadata?: Record<string, unknown>
}

export interface Session {
  readonly id: string
  readonly userId: string

  /**
   * 发送用户消息，返回事件流。
   * 字符串糖：等价于 { type: 'message', content: input }
   */
  send(input: string | SessionInput): AsyncIterable<SessionEvent>

  /**
   * 响应工具审批（PR #7.0）。
   *
   * 当事件流给出 `tool_approval_required` 后，业务收集到用户决策（allow/deny/scope/...）
   * 调本方法注入决策。kernel 把决策写入 PermissionStore，然后内部 resume 一次 SDK 运行：
   * Hook 再次触发时从 store 读到决策并放行 / 拒绝，agent 继续往下跑。
   *
   * 返回的事件流是"决策注入后"的运行流（可能包含 message_delta / tool_call /
   * tool_result / 再次的 tool_approval_required / session_idle 等）。
   *
   * 注意：调用方应确保同一 toolUseId 不被并发响应；重复响应会用最后一次为准。
   */
  respondApproval(opts: { toolUseId: string; decision: ApprovalDecision }): AsyncIterable<SessionEvent>

  /**
   * PR #7.1: 注入客户端工具结果并 resume agent 运行。
   *
   * 配套 'tool_use_required' 事件使用：业务侧在客户端执行完 AgentConfig.tools[]
   * 中声明的工具后，调本方法把结果回灌给 kernel：
   *   1. kernel 把结果写入内部 client-tool store
   *   2. 起一轮 SDK query（resume）→ 模型重发同名工具 → PreToolUse hook 这次
   *      把结果通过 updatedInput 注入 → 包装的 MCP stub 直接返回它，写一条
   *      正常（非 error）的 tool_result 进 transcript。
   *
   * 返回的事件流是"结果注入后"的运行流（可能包含 message_delta / tool_call /
   * tool_result / session_idle 等）。
   */
  respondToolUse(opts: { toolUseId: string; output: unknown; isError?: boolean }): AsyncIterable<SessionEvent>

  /** 拉取历史消息 */
  getHistory(opts?: { limit?: number; before?: number }): Promise<MessageRecord[]>

  /**
   * 清除会话消息元数据索引（oak_session_messages）。
   *
   * 仅清除前端分页索引数据，不影响 SDK transcript（session 仍可继续对话）。
   * 用途：用户在 UI 上"清除聊天记录"但保留对话上下文。
   */
  clearHistory(): Promise<void>

  /** 序列化当前 RunState 为 JSON 字符串（用于跨进程 resume）*/
  getState(): Promise<string>

  /** 中止当前运行 */
  abort(): Promise<void>
}

export interface SessionManagement {
  list(opts?: { userId?: string; limit?: number; cursor?: string }): Promise<SessionSummary[]>
  get(conversationId: string): Promise<SessionSummary | null>
  delete(conversationId: string): Promise<void>
}

export interface SessionSummary {
  conversationId: string
  userId: string
  title?: string
  status: 'idle' | 'running' | 'requires_action' | 'archived'
  createdAt: number
  updatedAt: number
  metadata?: Record<string, unknown>
}

// ============================================================
// Session 输入（统一入口）
// ============================================================

export type SessionInput =
  | { type: 'message'; content: string; attachments?: AttachmentInput[] }
  /** 客户端工具结果回灌（用户自己执行 tool 后回传，v0.2+）*/
  | { type: 'tool_result'; toolUseId: string; output: unknown; isError?: boolean }

/**
 * 附件输入（多模态）。
 *
 * - `file`：本地文件路径或 Buffer，kernel 内部交给 StorageProvider 处理
 * - `url`：已有可访问的 URL（公网或带签名），kernel 直接透传
 * - `cos`：已存在 CloudBase 云存储里的 fileId，kernel 调 getTempFileURL 拿签名 URL
 *
 * 实际向模型发送的形态由 StorageProvider 决定（base64 内联 / URL 引用）。
 */
export type AttachmentInput =
  | { type: 'file'; source: string | Uint8Array; mimeType?: string }
  | { type: 'url'; url: string; mimeType?: string }
  | { type: 'cos'; fileId: string; mimeType?: string }

// ============================================================
// Session 事件流
// ============================================================

export type SessionEvent =
  | { type: 'message_delta'; text: string }
  | { type: 'message_complete'; text: string }
  | {
      type: 'tool_call'
      toolUseId: string
      toolName: string
      input: unknown
    }
  | {
      type: 'tool_result'
      toolUseId: string
      toolName: string
      output: unknown
      isError: boolean
    }
  | {
      /**
       * 工具调用需要用户审批（PR #7.0）。
       *
       * 收到此事件后，本轮 SDK 运行会自然结束（紧跟 `session_idle.requires_action`）。
       * 业务收集到决策后调 `session.respondApproval({ toolUseId, decision })` 继续。
       *
       * 协议无关字段：客户端协议（ACP/AG-UI/SSE）适配只需把这些字段映射到自家协议。
       */
      type: 'tool_approval_required'
      toolUseId: string
      toolName: string
      input: unknown
      /**
       * 给客户端 UI 的辅助提示，**协议无关**。
       * - displayName：UI 按钮 / 标题用的短名
       * - description：长描述（"will read files in ~/Downloads"）
       * - suggestedScopes：UI 可呈现的"作用范围"选项（once/session/forever）
       */
      hints?: {
        displayName?: string
        description?: string
        suggestedScopes?: Array<'once' | 'session' | 'forever'>
      }
      /**
       * Resume token（业务可不持久化，conversationId + toolUseId 就够 resumeApproval；
       * 此字段留作未来跨进程 RunState 持久化的扩展点）。
       */
      runStateJson: string
    }
  | {
      /**
       * 客户端工具需要客户端执行（PR #7.1）。
       *
       * 当模型调用 AgentConfig.tools[] 中声明的"client-side custom tool"时，
       * kernel 不会真的调 execute()，而是让 PreToolUse hook 拦截：
       *   1. 写一个 pending entry 到内部 client-tool store
       *   2. 用一个 sentinel deny 让 SDK 终止本轮
       *   3. 翻译层识别 sentinel 后吐出本事件
       *
       * 业务侧收到本事件 → 在客户端实际执行工具 → 调
       * `session.respondToolUse({ toolUseId, output, isError? })` 注入结果，
       * kernel 会 resume 一轮 SDK 让模型重发同名工具，hook 这次会注入结果，
       * 模型基于真实结果继续。
       */
      type: 'tool_use_required'
      toolUseId: string
      toolName: string
      input: unknown
    }
  | {
      type: 'handoff'
      fromAgent: string
      toAgent: string
    }
  | {
      type: 'session_idle'
      reason: 'completed' | 'requires_action' | 'aborted' | 'error'
    }
  | { type: 'error'; error: Error }

// ============================================================
// 历史消息记录（PR #4.6 扩展）
// ============================================================

/**
 * 消息状态：前端渲染用（spinner / 灰条 / 错误提示）
 *
 * - `pending`：用户刚发送，等待模型响应
 * - `streaming`：模型正在输出（流式场景，有 partial 消息时）
 * - `done`：正常结束
 * - `error`：发生错误
 * - `cancel`：用户取消 / 中止
 */
export type MessageStatus = 'pending' | 'streaming' | 'done' | 'error' | 'cancel'

/**
 * 工具调用 / 结果状态：
 * - `pending`：已发起，等待执行
 * - `executing`：正在执行（可选，流式场景）
 * - `done`：执行完成
 * - `denied`：被 HITL 拒绝
 * - `awaiting_approval`：等待用户审批（HITL）
 */
export type ToolStatus = 'pending' | 'executing' | 'done' | 'denied' | 'awaiting_approval'

/**
 * 聚合消息记录：给前端渲染用的"人类可读"格式。
 *
 * 与 SDK 内部的 SDKMessage（SessionStore 存的）不同：
 * - SDKMessage 是 SDK 内部协议（含 partial、replay、compact_boundary 等十几种 subtype）
 * - MessageRecord 是 kernel 翻译后的语义化格式，只包含前端需要的字段
 *
 * 两者职责：
 * - SessionStore → SDK resume 用（重建 agent context）
 * - HistoryStore → 前端渲染 chat UI 用（MessageRecord）
 */
export interface MessageRecord {
  id: string
  conversationId: string
  role: 'user' | 'assistant' | 'system'
  parts: MessagePart[]
  status: MessageStatus
  createdAt: number
}

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'image'
      mimeType: string
      /**
       * 稳定引用：长期可解析为可访问 URL。
       * - CloudBase 存储：`{ kind: 'cos', fileId: 'cloud://...' }`
       * - 内联 base64：`{ kind: 'base64', dataUrl: 'data:image/png;base64,...' }`
       * - 外部 URL：`{ kind: 'url', url: 'https://...' }`（kernel 不保证有效期）
       */
      ref: { kind: 'cos'; fileId: string } | { kind: 'base64'; dataUrl: string } | { kind: 'url'; url: string }
    }
  | {
      type: 'tool_call'
      toolUseId: string
      toolName: string
      input: unknown
      status?: ToolStatus
    }
  | {
      type: 'tool_result'
      toolUseId: string
      output: unknown
      isError: boolean
      status?: ToolStatus
    }
  | {
      type: 'tool_approval_required'
      toolUseId: string
      toolName: string
      input: unknown
    }
