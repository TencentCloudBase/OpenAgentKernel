import { randomUUID } from 'node:crypto'
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig as SdkMcpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { InvalidConfigError, ResourceError } from '../internal/errors.js'
import { createHookLocalState, InMemoryClientToolStore, InMemoryPermissionStore, type ClientToolResultStore, type PreToolUseHookLocalState } from '../permissions/index.js'
import { buildClaudeQueryOptions } from '../runtime/agent-builder.js'
import { createTranslatorState, translateSdkMessage } from '../runtime/event-translator.js'
import { buildPromptAsync } from '../runtime/prompt-builder.js'
import { createCloudBaseMcpServer, type CloudBaseUserCredentials } from '../sandbox/cloudbase-mcp.js'
import type { SandboxInstance, SandboxRuntime } from '../sandbox/types.js'
import type { StorageProvider } from '../storage/types.js'
import type {
  Agent,
  AgentConfig,
  ApprovalDecision,
  MessagePart,
  MessageRecord,
  PermissionStore,
  SandboxUserCredentials,
  Session,
  SessionEvent,
  SessionInput,
  SessionStartOptions,
  SessionSummary,
} from './types.js'

/**
 * 创建 CloudBase Open Agent 实例。
 *
 * MVP 形态：服务端 kernel SDK，跟用户业务代码同进程。
 * 内部底层引擎为 Claude Agent SDK（@anthropic-ai/claude-agent-sdk），完全屏蔽。
 *
 * 当前版本：v0.1.0-alpha.0
 * 已支持：
 *   - startSession / resumeSession / session.send（PR #4）
 *   - 多模态输入（PR #4.5）
 *   - MCP 接入（PR #5）
 *   - Sandbox + CloudBase MCP（PR #6 / #6.5）
 *   - HITL 工具审批（PR #7.0）：requireApproval / respondApproval / 流终止+resume 范式
 */
export function createAgent(config: AgentConfig): Agent {
  if (!config.envId || typeof config.envId !== 'string') {
    throw new InvalidConfigError('AgentConfig.envId is required and must be a non-empty string')
  }
  if (!config.model) {
    throw new InvalidConfigError('AgentConfig.model is required')
  }

  if (config.tools) {
    for (const tool of config.tools) {
      if (typeof tool.execute !== 'function') {
        throw new InvalidConfigError(
          `Custom tool "${tool.name}" is missing 'execute'. ` +
            `Client-side custom tools (events-based) will be supported in a later version.`,
        )
      }
    }
  }

  const agentId = randomUUID()
  const sessionsManagement = createSessionsManagement(config)

  const agent: Agent = {
    id: agentId,
    name: config.name,

    async startSession(opts: SessionStartOptions): Promise<Session> {
      if (!opts.userId) {
        throw new InvalidConfigError('SessionStartOptions.userId is required')
      }
      const conversationId = opts.conversationId ?? randomUUID()
      return createSession({
        config,
        conversationId,
        userId: opts.userId,
        resumeFromExisting: false,
      })
    },

    async resumeSession(stateJsonOrConversationId: string): Promise<Session> {
      if (!config.session?.store) {
        throw new ResourceError(
          'agent.resumeSession requires AgentConfig.session.store. ' +
            'Provide a CloudBaseSessionStore (or compatible) when creating the agent.',
        )
      }
      const conversationId = stateJsonOrConversationId
      return createSession({
        config,
        conversationId,
        userId: 'resumed',
        resumeFromExisting: true,
      })
    },

    sessions: sessionsManagement,
  }

  return agent
}

// ============================================================
// 内部：Session 实现
// ============================================================

interface SessionDeps {
  config: AgentConfig
  conversationId: string
  userId: string
  resumeFromExisting: boolean
}

function createSession(deps: SessionDeps): Session {
  const { config, conversationId, userId, resumeFromExisting } = deps
  let abortController: AbortController | undefined
  let hasStarted = resumeFromExisting

  const sandboxRuntime = extractSandboxRuntime(config)
  let sandboxInstance: SandboxInstance | undefined
  let sandboxAcquirePromise: Promise<SandboxInstance> | undefined

  const cloudbaseToolsEnabled = isCloudbaseToolsEnabled(config)
  let cloudbaseMcpServer: SdkMcpServerConfig | undefined
  let cloudbaseMcpPromise: Promise<SdkMcpServerConfig | undefined> | undefined

  // PR #7.0：审批 store（默认 InMemoryPermissionStore，进程内单例）。
  // 仅在用户配了 requireApproval 时启用；不配则 hook 整体不注入。
  const permissionStore: PermissionStore | undefined =
    config.permissions?.requireApproval !== undefined
      ? (config.permissions.store ?? createDefaultPermissionStore())
      : undefined

  // PR #7.1: client-side tools store + name set. The set lets the
  // PreToolUse hook recognise mcp__custom__* tools (custom = user-declared,
  // execute() in the wrapped MCP server is a stub). The store carries
  // host-supplied tool results between SDK turns (turn-1 emits
  // tool_use_required; respondToolUse() stashes; turn-2 reads).
  const clientToolNames: Set<string> = new Set((config.tools ?? []).map((t) => t.name))
  const clientToolStore: ClientToolResultStore | undefined =
    clientToolNames.size > 0 ? new InMemoryClientToolStore() : undefined

  async function ensureSandbox(): Promise<SandboxInstance | undefined> {
    if (!sandboxRuntime) return undefined
    if (sandboxInstance) return sandboxInstance
    if (!sandboxAcquirePromise) {
      sandboxAcquirePromise = sandboxRuntime.acquire({
        envId: config.envId,
        conversationId,
        scope: config.sandbox?.scope ?? 'session',
        onProgress: (msg) => {
          if (process.env.OAK_DEBUG === '1') {
            // eslint-disable-next-line no-console
            console.error(`[oak][sandbox] ${msg.phase}: ${msg.message}`)
          }
        },
      })
    }
    sandboxInstance = await sandboxAcquirePromise
    return sandboxInstance
  }

  async function ensureCloudbaseMcp(sandbox: SandboxInstance): Promise<SdkMcpServerConfig | undefined> {
    if (!cloudbaseToolsEnabled) return undefined
    if (cloudbaseMcpServer) return cloudbaseMcpServer
    if (!cloudbaseMcpPromise) {
      cloudbaseMcpPromise = (async (): Promise<SdkMcpServerConfig | undefined> => {
        try {
          const bundle = await createCloudBaseMcpServer({
            sandbox,
            getCredentials: () => resolveUserCredentials(config),
          })
          if (process.env.OAK_DEBUG === '1') {
            // eslint-disable-next-line no-console
            console.error(
              `[oak][cloudbase-mcp] toolCount=${bundle.toolCount}` +
                (bundle.degradedReason ? ` reason=${bundle.degradedReason}` : ''),
            )
          }
          return bundle.server as SdkMcpServerConfig
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            '[oak] cloudbase MCP setup failed, agent will continue without cloudbase tools:',
            (err as Error).message,
          )
          return undefined
        }
      })()
    }
    cloudbaseMcpServer = await cloudbaseMcpPromise
    return cloudbaseMcpServer
  }

  const session: Session = {
    id: conversationId,
    userId,

    send(input: string | SessionInput): AsyncIterable<SessionEvent> {
      abortController = new AbortController()
      const isContinuation = hasStarted
      hasStarted = true
      return runClaudeQuery({
        config,
        input,
        abortController,
        sessionId: conversationId,
        conversationId,
        isContinuation,
        ensureSandbox,
        ensureCloudbaseMcp,
        permissionStore,
        ...(clientToolNames.size > 0 ? { clientToolNames } : {}),
        ...(clientToolStore ? { clientToolStore } : {}),
      })
    },

    /**
     * PR #7.0：注入审批决策并 resume agent 运行。
     *
     * "流终止 + 重新进入"范式（不阻塞 send 的 generator，跨进程友好）：
     *   1. 把 decision 写回 PermissionStore
     *   2. 起一轮"空 prompt"的 SDK query（resume=conversationId） → 模型从 transcript 重新发起
     *      之前那个工具调用 → PreToolUse hook 这次从 store 读到决策 → 放行/拒绝
     *
     * 调用方不需要持有"那次 send 的 generator"——业务可在任意进程 / 节点（store 共享前提下）调本方法。
     */
    respondApproval(opts: { toolUseId: string; decision: ApprovalDecision }): AsyncIterable<SessionEvent> {
      abortController = new AbortController()
      return runApprovalResume({
        config,
        conversationId,
        toolUseId: opts.toolUseId,
        decision: opts.decision,
        abortController,
        ensureSandbox,
        ensureCloudbaseMcp,
        permissionStore,
        ...(clientToolNames.size > 0 ? { clientToolNames } : {}),
        ...(clientToolStore ? { clientToolStore } : {}),
      })
    },

    /**
     * PR #7.1: respond to a client-side tool_use_required pause.
     *
     * Wire flow:
     *   1. Stash the host-supplied result in the in-memory clientToolStore.
     *   2. Resume the SDK with a short prompt asking the model to retry
     *      the same tool. The PreToolUse hook will scan the store, find the
     *      result, allow + inject it via updatedInput so the wrapped MCP
     *      stub returns it as the actual tool_result. The transcript ends
     *      up with a clean (non-error) tool_result for the new tool_use_id;
     *      the original (errored, sentinel-bearing) tool_result remains in
     *      the transcript but is harmless because the hook's deny outcome
     *      already aborted that branch of reasoning.
     */
    respondToolUse(opts: {
      toolUseId: string
      output: unknown
      isError?: boolean
    }): AsyncIterable<SessionEvent> {
      abortController = new AbortController()
      return runClientToolResume({
        config,
        conversationId,
        toolUseId: opts.toolUseId,
        output: opts.output,
        isError: opts.isError ?? false,
        abortController,
        ensureSandbox,
        ensureCloudbaseMcp,
        permissionStore,
        clientToolNames,
        clientToolStore,
      })
    },

    async getHistory(opts): Promise<MessageRecord[]> {
      const store = config.session?.store
      if (!store) return []

      const driver = (
        store as { getDriver?: () => { querySessionMessages: Function; loadEntriesByMessageIds: Function } }
      ).getDriver?.()
      if (!driver) return []

      const projectKey = config.session?.projectKey ?? config.envId

      // 1. 查询 session_messages 元数据（已分页）
      const metas = await driver.querySessionMessages(projectKey, conversationId, {
        limit: opts?.limit,
        before: opts?.before,
      })
      if (metas.length === 0) return []

      // 2. 只加载匹配的 entries（分页优化：不再全量扫描）
      const messageIds = metas.map((m: { messageId: string }) => m.messageId)
      const entries = await driver.loadEntriesByMessageIds({ projectKey, sessionId: conversationId }, messageIds)
      if (!entries || entries.length === 0) return []

      // 3. 构建 messageId → entry 映射
      const entryMap = new Map<string, Record<string, unknown>>()
      for (const entry of entries) {
        const sdkMsg = entry as Record<string, unknown>
        if (!sdkMsg || typeof sdkMsg !== 'object') continue
        const messageId = (sdkMsg.message as { id?: string })?.id || (entry as { uuid?: string }).uuid
        if (messageId) {
          entryMap.set(messageId, sdkMsg)
        }
      }

      if (process.env.OAK_DEBUG === '1') {
        console.error('[oak][getHistory] entryMap size:', entryMap.size, ', metas:', metas.length)
      }

      // 4. 用元数据顺序组装 MessageRecord
      const result: MessageRecord[] = []
      for (const meta of metas) {
        const sdkMsg = entryMap.get(meta.messageId)
        if (!sdkMsg) continue

        const parts = extractMessageParts(sdkMsg)
        if (parts.length === 0) continue

        result.push({
          id: meta.messageId,
          conversationId,
          role: meta.role,
          parts,
          status: meta.status,
          createdAt: meta.createdAt,
        })
      }

      // metas 是 desc 排序，返回给用户改为 asc（时间正序）
      result.reverse()
      return aggregateHistory(result)
    },

    async clearHistory(): Promise<void> {
      const store = config.session?.store
      if (!store) return

      const driver = (store as { getDriver?: () => { deleteSessionMessages: Function } }).getDriver?.()
      if (!driver) return

      const projectKey = config.session?.projectKey ?? config.envId
      await driver.deleteSessionMessages({ projectKey, sessionId: conversationId })
    },

    async getState(): Promise<string> {
      return JSON.stringify({ conversationId, schema: 'oak/v1/sessionRef' })
    },

    async abort(): Promise<void> {
      abortController?.abort()
      if (sandboxInstance) {
        try {
          await sandboxInstance.release()
        } catch {
          // release 失败不影响业务
        }
        sandboxInstance = undefined
        sandboxAcquirePromise = undefined
      }
    },
  }

  // 持久化 session 元数据（userId）到 store
  if (config.session?.store && !resumeFromExisting) {
    const storeWithRegister = config.session.store as {
      registerSession?: (args: {
        projectKey: string
        sessionId: string
        userId: string
        title?: string
        metadata?: Record<string, unknown>
      }) => Promise<void>
    }
    if (typeof storeWithRegister.registerSession === 'function') {
      const projectKey = config.session?.projectKey ?? config.envId
      storeWithRegister
        .registerSession({
          projectKey,
          sessionId: conversationId,
          userId,
        })
        .catch(() => {
          // 注册失败不阻塞 session 创建
          if (process.env.OAK_DEBUG === '1') {
            // eslint-disable-next-line no-console
            console.error('[oak] registerSession failed (non-blocking)')
          }
        })
    }
  }

  return session
}

/**
 * 进程内单例的默认 PermissionStore（懒创建）。
 *
 * 同进程多个 createAgent 实例共享一个 InMemoryStore（按 conversationId+toolUseId 隔离），
 * 这样 send / respondApproval 跨调用能找到 pending entry。
 *
 * 多实例 / 跨进程部署场景下，业务应显式传 PermissionStore（PR #7.1 提供 CloudBaseDb 实现）。
 */
let _defaultPermissionStore: InMemoryPermissionStore | undefined
function createDefaultPermissionStore(): InMemoryPermissionStore {
  if (!_defaultPermissionStore) {
    _defaultPermissionStore = new InMemoryPermissionStore()
  }
  return _defaultPermissionStore
}

/**
 * 从 SDKMessage 提取 MessagePart[]（PR #4.6：getHistory 内部使用）。
 *
 * 处理两种消息类型：
 *   - assistant: text block → { type: 'text' }, tool_use block → { type: 'tool_call' }, thinking block → { type: 'thinking' }
 *   - user: text block → { type: 'text' }, tool_result block → { type: 'tool_result' }
 */
function extractMessageParts(sdkMsg: Record<string, unknown>): MessagePart[] {
  const parts: MessagePart[] = []
  const content = (sdkMsg.message as { content?: unknown[] | string })?.content

  // 处理 content 是字符串的情况（user 消息）
  if (typeof content === 'string' && content.length > 0) {
    parts.push({ type: 'text', text: content })
    return parts
  }

  if (!Array.isArray(content)) return parts

  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as {
      type?: string
      text?: string
      id?: string
      name?: string
      input?: unknown
      tool_use_id?: string
      content?: unknown
      is_error?: boolean
    }

    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string' && b.text.length > 0) {
          parts.push({ type: 'text', text: b.text })
        }
        break
      case 'thinking':
        if (typeof b.text === 'string' && b.text.length > 0) {
          parts.push({ type: 'thinking', text: b.text })
        }
        break
      case 'tool_use':
        if (b.id && b.name) {
          parts.push({
            type: 'tool_call',
            toolUseId: b.id as string,
            toolName: b.name as string,
            input: b.input ?? {},
          })
        }
        break
      case 'tool_result':
        if (b.tool_use_id) {
          parts.push({
            type: 'tool_result',
            toolUseId: b.tool_use_id as string,
            output: b.content ?? null,
            isError: Boolean(b.is_error),
          })
        }
        break
    }
  }

  return parts
}

/**
 * 聚合 getHistory 结果：把 tool_result 合并到对应的 assistant tool_call 中，
 * 过滤掉 SDK 内部协议产物（sentinel、resume prompt）。
 *
 * 规则：
 *   1. User 消息中只含 tool_result → 按 toolUseId 合并到 assistant 的 tool_call 后面 → 排除该 user 消息
 *   2. User 消息含 __OAK_INTERRUPT__ sentinel → 排除（标记对应 tool_call 为 awaiting_approval）
 *   3. User 消息文本以 [系统通知] 开头 → 排除（HITL resume prompt）
 *   4. 正常 user 文本消息 → 保留
 *   5. Assistant 消息 → 保留，附带聚合后的 tool_result
 */
function aggregateHistory(records: MessageRecord[]): MessageRecord[] {
  // Pass 1: 收集 tool_results + 识别内部产物
  const toolResultMap = new Map<string, MessagePart>()
  const interruptedToolUseIds = new Set<string>()
  const excludeIds = new Set<string>()

  for (const msg of records) {
    if (msg.role !== 'user') continue

    // 检测 HITL sentinel
    const isSentinel = msg.parts.some(
      (p) =>
        p.type === 'tool_result' && typeof p.output === 'string' && (p.output as string).includes('__OAK_INTERRUPT__'),
    )
    if (isSentinel) {
      for (const p of msg.parts) {
        if (p.type === 'tool_result') interruptedToolUseIds.add(p.toolUseId)
      }
      excludeIds.add(msg.id)
      continue
    }

    // 检测 resume prompt
    const isResumePrompt = msg.parts.some((p) => p.type === 'text' && p.text.startsWith('[系统通知]'))
    if (isResumePrompt) {
      excludeIds.add(msg.id)
      continue
    }

    // 纯 tool_result 消息 → 收集等待合并
    const isAllToolResults = msg.parts.length > 0 && msg.parts.every((p) => p.type === 'tool_result')
    if (isAllToolResults) {
      for (const part of msg.parts) {
        if (part.type === 'tool_result') {
          // 跳过内部拦截产物（同轮多审批保护）
          const outputStr = typeof part.output === 'string' ? part.output : JSON.stringify(part.output)
          if (outputStr.includes('oak_pending_approval_in_turn')) {
            interruptedToolUseIds.add(part.toolUseId)
            continue
          }
          toolResultMap.set(part.toolUseId, part)
        }
      }
      excludeIds.add(msg.id)
    }
  }

  // Pass 2: 重建记录，附加 tool_result 到 assistant，过滤被放弃的 awaiting_approval
  const result: MessageRecord[] = []
  for (const msg of records) {
    if (excludeIds.has(msg.id)) continue

    if (msg.role === 'assistant') {
      const augmentedParts: MessagePart[] = []
      for (const part of msg.parts) {
        if (part.type === 'tool_call') {
          if (interruptedToolUseIds.has(part.toolUseId)) {
            // 被中断且无后续 result → 直接跳过（不展示给用户）
            // 这类 tool_call 是模型自发调用被 HITL 拦截后从未被 respond 的，属于噪音
            continue
          }
          augmentedParts.push(part)
          // 把配对的 tool_result 附在 tool_call 后面
          const matched = toolResultMap.get(part.toolUseId)
          if (matched) {
            augmentedParts.push(matched)
            toolResultMap.delete(part.toolUseId)
          }
        } else {
          augmentedParts.push(part)
        }
      }
      // 如果过滤后 parts 为空，排除整条消息
      if (augmentedParts.length > 0) {
        result.push({ ...msg, parts: augmentedParts })
      }
    } else {
      result.push(msg)
    }
  }

  // Pass 3: 合并连续 assistant 消息为一个 "turn"
  // 行业标准：两个 user 消息之间的所有 assistant 内容属于同一个响应轮次
  const merged: MessageRecord[] = []
  for (const msg of result) {
    if (msg.role === 'assistant' && merged.length > 0 && merged[merged.length - 1].role === 'assistant') {
      // 合并到前一个 assistant 消息
      const prev = merged[merged.length - 1]
      merged[merged.length - 1] = {
        ...prev,
        parts: [...prev.parts, ...msg.parts],
      }
    } else {
      merged.push(msg)
    }
  }

  return merged
}

// ============================================================
// 内部：跑一次 Claude SDK query 并翻译事件流
// ============================================================

interface RunClaudeQueryArgs {
  config: AgentConfig
  input: string | SessionInput
  abortController: AbortController
  sessionId: string
  conversationId: string
  isContinuation: boolean
  ensureSandbox: () => Promise<SandboxInstance | undefined>
  ensureCloudbaseMcp: (sandbox: SandboxInstance) => Promise<SdkMcpServerConfig | undefined>
  permissionStore?: PermissionStore
  /** PR #7.1: names of user-defined client-side tools (config.tools[].name set). */
  clientToolNames?: ReadonlySet<string>
  /** PR #7.1: store for client-supplied tool results. */
  clientToolStore?: ClientToolResultStore
}

async function* runClaudeQuery(args: RunClaudeQueryArgs): AsyncGenerator<SessionEvent, void, unknown> {
  const {
    config,
    input,
    abortController,
    sessionId,
    conversationId,
    isContinuation,
    ensureSandbox,
    ensureCloudbaseMcp,
    permissionStore,
    clientToolNames,
    clientToolStore,
  } = args

  let q: ReturnType<typeof claudeQuery> | undefined
  try {
    const sandbox = await ensureSandbox()
    const cloudbaseMcp = sandbox ? await ensureCloudbaseMcp(sandbox) : undefined

    // PR #7.0：构造一轮的 hook 本地状态（同 query 内闭包共享）
    const hookLocalState: PreToolUseHookLocalState = createHookLocalState()
    // PR #7.0：合并真正生效的 permissions（注入实际的 store——可能是 default in-memory，
    // 也可能是用户传入的；hook factory 需要它来读决策）。
    const effectivePermissions = config.permissions ? { ...config.permissions, store: permissionStore } : undefined
    const effectiveConfig = effectivePermissions ? { ...config, permissions: effectivePermissions } : config

    const { options } = buildClaudeQueryOptions(effectiveConfig, {
      sandboxInstance: sandbox,
      extraMcpServers: cloudbaseMcp ? { cloudbase: cloudbaseMcp } : undefined,
      conversationId,
      hookLocalState,
      ...(clientToolNames ? { clientToolNames } : {}),
      ...(clientToolStore ? { clientToolStore } : {}),
    })
    const storage = extractStorageProvider(config)
    const promptStream = buildPromptAsync({
      input,
      storage,
      envId: config.envId,
      sessionId,
    })

    const sdkOptions = {
      ...options,
      abortController,
      ...(isContinuation ? { resume: sessionId } : { sessionId }),
    }

    q = claudeQuery({ prompt: promptStream as never, options: sdkOptions })
    const translatorState = createTranslatorState()
    for await (const sdkMsg of q) {
      for (const event of translateSdkMessage(sdkMsg, translatorState)) {
        yield event
      }
    }
  } catch (err) {
    yield {
      type: 'error',
      error: err instanceof Error ? err : new Error(String(err)),
    }
    yield { type: 'session_idle', reason: 'error' }
  }
}

// ============================================================
// 内部：注入审批决策并 resume agent 运行（PR #7.0）
// ============================================================

interface RunApprovalResumeArgs {
  config: AgentConfig
  conversationId: string
  toolUseId: string
  decision: ApprovalDecision
  abortController: AbortController
  ensureSandbox: () => Promise<SandboxInstance | undefined>
  ensureCloudbaseMcp: (sandbox: SandboxInstance) => Promise<SdkMcpServerConfig | undefined>
  permissionStore?: PermissionStore
  clientToolNames?: ReadonlySet<string>
  clientToolStore?: ClientToolResultStore
}

async function* runApprovalResume(args: RunApprovalResumeArgs): AsyncGenerator<SessionEvent, void, unknown> {
  const {
    config,
    conversationId,
    toolUseId,
    decision,
    abortController,
    ensureSandbox,
    ensureCloudbaseMcp,
    permissionStore,
    clientToolNames,
    clientToolStore,
  } = args

  if (!permissionStore) {
    yield {
      type: 'error',
      error: new InvalidConfigError(
        'session.respondApproval requires AgentConfig.permissions.requireApproval to be configured. ' +
          'Without permissions config, no approval flow exists to resume.',
      ),
    }
    yield { type: 'session_idle', reason: 'error' }
    return
  }

  const existing = await permissionStore.get({ conversationId, toolUseId })
  if (!existing) {
    yield {
      type: 'error',
      error: new ResourceError(
        `No pending approval found for toolUseId=${toolUseId}. ` + 'It may have expired or already been resolved.',
      ),
    }
    yield { type: 'session_idle', reason: 'error' }
    return
  }
  if (existing.decision) {
    yield {
      type: 'error',
      error: new ResourceError(`Approval for toolUseId=${toolUseId} has already been resolved.`),
    }
    yield { type: 'session_idle', reason: 'error' }
    return
  }

  await permissionStore.put({ ...existing, decision })

  // 用具体的 prompt 触发一轮 resume：让模型明确知道"刚才那个工具被批准/拒绝了，请重新调用"。
  // 为什么不能用空 prompt：SDK 的 resume 默认会让模型自由继续，模型可能"理解错"上下文，
  // 这里用确定指令引导模型重发同样的工具调用，PreToolUse hook 这次从 store 读到 decision → 放行/拒绝。
  const resumePrompt = buildResumePrompt(existing.toolName, decision)

  yield* runClaudeQuery({
    config,
    input: resumePrompt,
    abortController,
    sessionId: conversationId,
    conversationId,
    isContinuation: true,
    ensureSandbox,
    ensureCloudbaseMcp,
    permissionStore,
    ...(clientToolNames ? { clientToolNames } : {}),
    ...(clientToolStore ? { clientToolStore } : {}),
  })
}

// ============================================================
// 内部：注入客户端工具结果并 resume agent 运行（PR #7.1）
// ============================================================

interface RunClientToolResumeArgs {
  config: AgentConfig
  conversationId: string
  toolUseId: string
  output: unknown
  isError: boolean
  abortController: AbortController
  ensureSandbox: () => Promise<SandboxInstance | undefined>
  ensureCloudbaseMcp: (sandbox: SandboxInstance) => Promise<SdkMcpServerConfig | undefined>
  permissionStore?: PermissionStore
  clientToolNames: ReadonlySet<string>
  clientToolStore?: ClientToolResultStore
}

async function* runClientToolResume(
  args: RunClientToolResumeArgs,
): AsyncGenerator<SessionEvent, void, unknown> {
  const {
    config,
    conversationId,
    toolUseId,
    output,
    isError,
    abortController,
    ensureSandbox,
    ensureCloudbaseMcp,
    permissionStore,
    clientToolNames,
    clientToolStore,
  } = args

  if (!clientToolStore) {
    yield {
      type: 'error',
      error: new InvalidConfigError(
        'session.respondToolUse requires AgentConfig.tools[] to be configured. ' +
          'Without client-side tool definitions, no client-tool flow exists to resume.',
      ),
    }
    yield { type: 'session_idle', reason: 'error' }
    return
  }

  const existing = await clientToolStore.get({ conversationId, toolUseId })
  if (!existing) {
    yield {
      type: 'error',
      error: new ResourceError(
        `No pending client tool found for toolUseId=${toolUseId}. ` +
          'It may have expired or already been resolved.',
      ),
    }
    yield { type: 'session_idle', reason: 'error' }
    return
  }
  if (existing.result) {
    yield {
      type: 'error',
      error: new ResourceError(`Client tool result for toolUseId=${toolUseId} has already been resolved.`),
    }
    yield { type: 'session_idle', reason: 'error' }
    return
  }

  await clientToolStore.put({ ...existing, result: { output, isError } })

  // Mirror the approval-resume prompt: tell the model the prior call has
  // been resolved and ask it to retry the same tool. The hook will scan the
  // store on this new call and inject the result via updatedInput.
  const resumePrompt = isError
    ? `[系统通知] 用户为刚才的工具调用 \`${existing.toolName}\` 提供了执行错误结果。请重新调用该工具以获取结果（hook 会注入），然后基于错误结果继续。`
    : `[系统通知] 用户为刚才的工具调用 \`${existing.toolName}\` 提供了实际执行结果。请重新调用该工具以获取该结果（hook 会自动注入），然后基于结果继续。`

  yield* runClaudeQuery({
    config,
    input: resumePrompt,
    abortController,
    sessionId: conversationId,
    conversationId,
    isContinuation: true,
    ensureSandbox,
    ensureCloudbaseMcp,
    permissionStore,
    clientToolNames,
    clientToolStore,
  })
}

/**
 * 构造 resume 阶段给模型的引导 prompt。
 *
 * - allow：让模型重新发起被审批的工具调用（hook 这次会放行）
 * - deny：告诉模型用户拒绝了，不要再重试
 */
function buildResumePrompt(toolName: string, decision: ApprovalDecision): string {
  if (decision.kind === 'allow') {
    const updated = decision.updatedInput
      ? `（用户修改了参数为 ${JSON.stringify(decision.updatedInput)}，请按这些参数调用）`
      : ''
    return (
      `[系统通知] 用户已批准刚才的工具调用 \`${toolName}\`${updated}。` +
      '请立即重新调用该工具完成原任务，不要再询问用户。'
    )
  }
  // deny
  const reason = decision.reason ?? '未给出原因'
  return (
    `[系统通知] 用户已拒绝刚才的工具调用 \`${toolName}\`，原因：${reason}。` +
    '请不要重试该工具，向用户说明并询问替代方案。'
  )
}

// ============================================================
// 内部：辅助函数
// ============================================================

function extractStorageProvider(config: AgentConfig): StorageProvider | undefined {
  const raw = config.storage
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object') {
    throw new InvalidConfigError('AgentConfig.storage must be an object implementing StorageProvider')
  }
  const candidate = raw as Record<string, unknown>
  if (typeof candidate.resolveAttachment !== 'function') {
    throw new InvalidConfigError(
      'AgentConfig.storage does not implement StorageProvider (resolveAttachment missing). ' +
        'Use InMemoryStorage or CloudBaseStorage from @cloudbase/open-agent-kernel.',
    )
  }
  return raw as StorageProvider
}

function extractSandboxRuntime(config: AgentConfig): SandboxRuntime | undefined {
  const raw = config.sandbox?.runtime
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object') {
    throw new InvalidConfigError('AgentConfig.sandbox.runtime must be an object implementing SandboxRuntime')
  }
  const candidate = raw as Record<string, unknown>
  if (typeof candidate.acquire !== 'function') {
    throw new InvalidConfigError(
      'AgentConfig.sandbox.runtime does not implement SandboxRuntime (acquire missing). ' +
        'Use AgsStatefulSandbox from @cloudbase/open-agent-kernel.',
    )
  }
  return raw as SandboxRuntime
}

function isCloudbaseToolsEnabled(config: AgentConfig): boolean {
  if (!config.sandbox?.runtime) return false
  return config.sandbox.cloudbaseTools !== false
}

async function resolveUserCredentials(config: AgentConfig): Promise<CloudBaseUserCredentials> {
  const raw = config.sandbox?.userCredentials
  let creds: SandboxUserCredentials | undefined

  if (typeof raw === 'function') {
    creds = await (raw as () => Promise<SandboxUserCredentials>)()
  } else if (raw && typeof raw === 'object') {
    creds = raw as SandboxUserCredentials
  }

  if (creds) {
    return {
      envId: creds.envId ?? config.envId,
      secretId: creds.secretId,
      secretKey: creds.secretKey,
      sessionToken: creds.sessionToken,
    }
  }

  const envSecretId = process.env.TCB_SECRET_ID ?? process.env.TENCENTCLOUD_SECRET_ID ?? ''
  const envSecretKey = process.env.TCB_SECRET_KEY ?? process.env.TENCENTCLOUD_SECRET_KEY ?? ''
  const envSessionToken = process.env.TCB_TOKEN ?? process.env.TENCENTCLOUD_SESSIONTOKEN
  const envEnvId = process.env.TCB_ENV_ID ?? config.envId

  if (!envSecretId || !envSecretKey) {
    throw new InvalidConfigError(
      'CloudBase MCP tools require user credentials. ' +
        'Either set AgentConfig.sandbox.userCredentials, ' +
        'or set process.env TCB_SECRET_ID + TCB_SECRET_KEY. ' +
        'To disable cloudbase tools entirely, pass `sandbox: { cloudbaseTools: false }`.',
    )
  }

  return {
    envId: envEnvId,
    secretId: envSecretId,
    secretKey: envSecretKey,
    sessionToken: envSessionToken,
  }
}

function createSessionsManagement(config: AgentConfig): Agent['sessions'] {
  return {
    async list(opts): Promise<SessionSummary[]> {
      const store = config.session?.store as
        | {
            listSessions?: (k: string) => Promise<Array<{ sessionId: string; mtime: number; userId?: string }>>
          }
        | undefined
      if (!store?.listSessions) return []
      const projectKey = config.session?.projectKey ?? config.envId
      const sessions = await store.listSessions(projectKey)
      void opts
      return sessions.map((s) => ({
        conversationId: s.sessionId,
        userId: s.userId ?? '',
        status: 'idle' as const,
        createdAt: s.mtime,
        updatedAt: s.mtime,
      }))
    },
    async get(_conversationId): Promise<SessionSummary | null> {
      return null
    },
    async delete(conversationId): Promise<void> {
      const store = config.session?.store as
        | { delete?: (key: { projectKey: string; sessionId: string }) => Promise<void> }
        | undefined
      if (!store?.delete) return
      const projectKey = config.session?.projectKey ?? config.envId
      await store.delete({ projectKey, sessionId: conversationId })
    },
  }
}

function mapSummary(raw: unknown): SessionSummary {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    conversationId: typeof r.sessionId === 'string' ? r.sessionId : '',
    userId: '',
    status: 'idle',
    createdAt: typeof r.mtime === 'number' ? r.mtime : 0,
    updatedAt: typeof r.mtime === 'number' ? r.mtime : 0,
    metadata: typeof r.data === 'object' && r.data !== null ? (r.data as Record<string, unknown>) : {},
  }
}
