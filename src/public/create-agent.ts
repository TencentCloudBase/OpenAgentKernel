import { randomUUID } from 'node:crypto'
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig as SdkMcpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { InvalidConfigError, ResourceError } from '../internal/errors.js'
import {
  createHookLocalState,
  InMemoryAskUserStore,
  InMemoryClientToolStore,
  InMemoryPermissionStore,
  type AskUserStore,
  type ClientToolResultStore,
  CloudBaseDbPermissionDriver,
  CloudBasePermissionStore,
  type PreToolUseHookLocalState,
} from '../permissions/index.js'
import { buildClaudeQueryOptions } from '../runtime/agent-builder.js'
import { createTranslatorState, translateSdkMessage } from '../runtime/event-translator.js'
import { buildPromptAsync } from '../runtime/prompt-builder.js'
import { createCloudBaseMcpServer, type CloudBaseUserCredentials } from '../sandbox/cloudbase-mcp.js'
import { AgsStatefulSandbox } from '../sandbox/index.js'
import type { SandboxInstance, SandboxRuntime } from '../sandbox/types.js'
import type { WorkspaceSnapshotEngine } from '../sandbox/workspace-snapshot/index.js'
import { CloudBaseDbDriver, CloudBaseSessionStore } from '../session-store/index.js'
import { CloudBaseStorage } from '../storage/cloudbase-storage.js'
import type { StorageProvider } from '../storage/types.js'
import type {
  Agent,
  AgentConfig,
  ApprovalDecision,
  CloudBaseStorageConfig,
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

type ResolvedPlatformCredentials = NonNullable<AgentConfig['credentials']> & { envId: string }

/**
 * 创建 CloudBase Open Agent 实例。
 *
 * MVP 形态：服务端 kernel SDK，跟用户业务代码同进程。
 * 内部底层引擎为 Claude Agent SDK（@anthropic-ai/claude-agent-sdk），完全屏蔽。
 *
 * 当前版本跟随 package.json（见 src/version.ts）。
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

  config = normalizeAgentConfig(config)

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

function normalizeAgentConfig(config: AgentConfig): AgentConfig {
  const credentials = resolvePlatformCredentials(config)
  const normalizedConfig: AgentConfig = {
    ...config,
    ...(credentials ? { credentials } : {}),
    sandbox: resolveSandboxConfig(config),
    storage: resolveStorageConfig(config),
  }

  return {
    ...normalizedConfig,
    permissions: resolvePermissionConfig(normalizedConfig),
    session: resolveSessionConfig(normalizedConfig),
  }
}

function resolvePlatformCredentials(config: AgentConfig): ResolvedPlatformCredentials | undefined {
  const credentials = config.credentials
  if (!credentials) return undefined

  return {
    ...credentials,
    envId: credentials.envId ?? config.envId,
  }
}

function resolveSandboxConfig(config: AgentConfig): AgentConfig['sandbox'] {
  const sandbox = config.sandbox
  if (!sandbox || sandbox.enabled === false) return undefined

  if (sandbox.runtime) return sandbox

  const provider = sandbox.provider ?? 'ags-stateful'
  if (provider !== 'ags-stateful') {
    throw new InvalidConfigError(
      `AgentConfig.sandbox.provider="${provider}" is not supported yet. ` +
        'The built-in sandbox currently supports provider="ags-stateful". ' +
        'Pass a custom SandboxRuntime via AgentConfig.sandbox.runtime for advanced scenarios.',
    )
  }

  const apiKey = sandbox.apiKey ?? process.env.CLOUDBASE_APIKEY ?? process.env.OAK_SANDBOX_API_KEY
  if (!apiKey) {
    throw new InvalidConfigError(
      'AgentConfig.sandbox.enabled=true requires sandbox.apiKey, CLOUDBASE_APIKEY, or OAK_SANDBOX_API_KEY ' +
        'for the default AgsStatefulSandbox runtime.',
    )
  }

  return {
    ...sandbox,
    enabled: true,
    provider,
    runtime: new AgsStatefulSandbox({ apiKey }),
    scope: sandbox.scope ?? 'shared',
  }
}

function isStorageProvider(value: unknown): value is StorageProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { resolveAttachment?: unknown }).resolveAttachment === 'function'
  )
}

function resolveStorageConfig(config: AgentConfig): StorageProvider | undefined {
  const storage = config.storage
  const credentials = resolvePlatformCredentials(config)

  if (storage === undefined) {
    return credentials ? new CloudBaseStorage({ credentials }) : undefined
  }

  if (isStorageProvider(storage)) {
    return storage
  }

  if (typeof storage !== 'object' || storage === null) {
    throw new InvalidConfigError(
      'AgentConfig.storage must be a CloudBase storage config object or StorageProvider instance.',
    )
  }

  const storageConfig = storage as CloudBaseStorageConfig

  if (storageConfig.enabled === false) {
    return undefined
  }

  const provider = storageConfig.provider ?? 'cloudbase'
  if (provider !== 'cloudbase') {
    throw new InvalidConfigError(
      `AgentConfig.storage.provider="${provider}" is not supported yet. ` +
        'The built-in storage currently supports provider="cloudbase". ' +
        'Pass a custom StorageProvider instance for advanced scenarios.',
    )
  }

  if (!credentials) {
    throw new InvalidConfigError(
      'AgentConfig.storage provider="cloudbase" requires AgentConfig.credentials for the default CloudBase Storage.',
    )
  }

  return new CloudBaseStorage({
    credentials,
    pathPrefix: storageConfig.pathPrefix,
    urlExpiresIn: storageConfig.urlExpiresIn,
  })
}

function resolveSessionConfig(config: AgentConfig): AgentConfig['session'] {
  const session = config.session
  if (session?.enabled === false) return undefined

  if (session?.store) {
    return session
  }

  const shouldEnable = session?.enabled === true || config.credentials !== undefined
  if (!shouldEnable) return session

  const provider = session?.provider ?? 'cloudbase'
  if (provider !== 'cloudbase') {
    throw new InvalidConfigError(
      `AgentConfig.session.provider="${provider}" is not supported yet. ` +
        'The built-in session store currently supports CloudBase resources only. ' +
        'Pass a custom SessionStore via AgentConfig.session.store for advanced scenarios.',
    )
  }
  const database = session?.database ?? 'flexdb'
  if (database !== 'flexdb') {
    throw new InvalidConfigError(
      `AgentConfig.session.database="${database}" is reserved for future CloudBase support. ` +
        'The built-in session store currently supports database="flexdb".',
    )
  }
  const credentials = resolvePlatformCredentials(config)
  if (!credentials) {
    throw new InvalidConfigError(
      'AgentConfig.session.enabled=true requires AgentConfig.credentials for the default CloudBase FlexDB session store.',
    )
  }

  const projectKey = session?.projectKey ?? config.envId
  const store = new CloudBaseSessionStore({
    driver: new CloudBaseDbDriver({
      credentials,
      collectionPrefix: session?.tablePrefix,
    }),
    projectKey,
  })

  return {
    ...session,
    provider,
    database,
    projectKey,
    store,
  }
}

function resolvePermissionConfig(config: AgentConfig): AgentConfig['permissions'] {
  const permissions = config.permissions
  if (!permissions || permissions.requireApproval === undefined || permissions.store) return permissions

  const credentials = resolvePlatformCredentials(config)
  if (!credentials) return permissions

  return {
    ...permissions,
    store: new CloudBasePermissionStore({
      projectKey: config.envId,
      driver: new CloudBaseDbPermissionDriver({
        credentials,
        collectionPrefix: permissions.tablePrefix,
      }),
    }),
  }
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

  // Spec B(Task 8):workspace snapshot engine 由 buildClaudeQueryOptions 在
  // 第一次 send 时构造并通过本闭包变量记录。bootstrap 仅执行一次(首次 acquire 之后)。
  // 注意:engine 本身是无状态构造,跨 send 持有同一个实例没有副作用。
  let sessionSnapshotEngine: WorkspaceSnapshotEngine | undefined
  let snapshotBootstrapped = false
  let snapshotBootstrapPromise: Promise<void> | undefined

  // PR #7.0/7.1：审批 store 已在 normalizeAgentConfig 中按 credentials 默认 CloudBase 化；
  // 未提供 credentials 时仍回落到进程内单例。
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
    clientToolNames.size > 0
      ? ((config.toolStore as ClientToolResultStore | undefined) ?? new InMemoryClientToolStore())
      : undefined

  // askUser: 内置提问工具 store（agent 主动向用户提问）。
  // 始终启用——askUser 是内置工具，不依赖用户配置 tools[]。
  const askUserStore: AskUserStore = new InMemoryAskUserStore()

  async function ensureSandbox(): Promise<SandboxInstance | undefined> {
    if (!sandboxRuntime) return undefined
    if (sandboxInstance) return sandboxInstance
    if (!sandboxAcquirePromise) {
      sandboxAcquirePromise = sandboxRuntime.acquire({
        envId: config.envId,
        credentials: config.credentials,
        conversationId,
        userId,
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

  /**
   * Spec B(Task 8):workspace snapshot 首次 bootstrap。
   *
   * - 仅当 buildClaudeQueryOptions 返回了 snapshotEngine(spec resolves to enabled)时执行
   * - 仅在首次 send 触发(snapshotBootstrapped flag),后续 send 跳过
   * - 凭证形态对齐 cloudbase-mcp.ts 的 PUT /api/workspace/env(Spec B 镜像端把这份 env
   *   持久化为 .workspace-env.json,init body 的 env 必须跟它语义一致)
   *
   * 失败处理:bootstrap 抛出(SandboxRestoreFailed / 网络错误)时让异常向上冒,
   * 由 runClaudeQuery 的 catch 块翻译为 'error' 事件 + session_idle('error')。
   * 这是 spec §6.2"restore failed → 视为致命"行为。
   */
  async function ensureSnapshotBootstrap(engine: WorkspaceSnapshotEngine, sandbox: SandboxInstance): Promise<void> {
    if (snapshotBootstrapped) return
    if (!snapshotBootstrapPromise) {
      snapshotBootstrapPromise = (async () => {
        const creds = await resolveUserCredentials(config)
        const envBag: Record<string, string> = {
          CLOUDBASE_ENV_ID: creds.envId,
          TENCENTCLOUD_SECRETID: creds.secretId,
          TENCENTCLOUD_SECRETKEY: creds.secretKey,
          TENCENTCLOUD_SESSIONTOKEN: creds.sessionToken ?? '',
        }
        await engine.bootstrap(sandbox, { credentials: envBag })
        snapshotBootstrapped = true
      })()
    }
    try {
      await snapshotBootstrapPromise
    } catch (err) {
      // 失败一次后清理 promise,允许下次 send 重试(graceful)
      snapshotBootstrapPromise = undefined
      throw err
    }
  }

  function onSnapshotEngine(engine: WorkspaceSnapshotEngine | undefined): void {
    if (engine && !sessionSnapshotEngine) {
      sessionSnapshotEngine = engine
    }
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
        userId,
        isContinuation,
        ensureSandbox,
        ensureCloudbaseMcp,
        ensureSnapshotBootstrap,
        onSnapshotEngine,
        permissionStore,
        ...(clientToolNames.size > 0 ? { clientToolNames } : {}),
        ...(clientToolStore ? { clientToolStore } : {}),
        askUserStore,
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
        userId,
        toolUseId: opts.toolUseId,
        decision: opts.decision,
        abortController,
        ensureSandbox,
        ensureCloudbaseMcp,
        ensureSnapshotBootstrap,
        onSnapshotEngine,
        permissionStore,
        ...(clientToolNames.size > 0 ? { clientToolNames } : {}),
        ...(clientToolStore ? { clientToolStore } : {}),
        askUserStore,
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
    respondToolUse(opts: { toolUseId: string; output: unknown; isError?: boolean }): AsyncIterable<SessionEvent> {
      abortController = new AbortController()
      return runClientToolResume({
        config,
        conversationId,
        userId,
        toolUseId: opts.toolUseId,
        output: opts.output,
        isError: opts.isError ?? false,
        abortController,
        ensureSandbox,
        ensureCloudbaseMcp,
        ensureSnapshotBootstrap,
        onSnapshotEngine,
        permissionStore,
        clientToolNames,
        clientToolStore,
        askUserStore,
      })
    },

    /**
     * 注入用户对 askUser 提问的回答并 resume agent 运行。
     *
     * 流终止+resume 范式（与 respondApproval / respondToolUse 同一模式）：
     *   1. 把回答写入 askUserStore
     *   2. 起一轮 SDK query（resume）→ 模型重发 askUser 工具 → hook 从 store 读到回答 → 放行
     */
    respondAskUser(opts: { toolUseId: string; answer: string }): AsyncIterable<SessionEvent> {
      abortController = new AbortController()
      return runAskUserResume({
        config,
        conversationId,
        userId,
        toolUseId: opts.toolUseId,
        answer: opts.answer,
        abortController,
        ensureSandbox,
        ensureCloudbaseMcp,
        ensureSnapshotBootstrap,
        onSnapshotEngine,
        permissionStore,
        clientToolNames,
        clientToolStore,
        askUserStore,
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

      if (process.env.OAK_DEBUG === '1') {
        console.error('[oak][getHistory] raw records:', result.length)
        for (const r of result) {
          console.error(`  ${r.role} id=${r.id} parts=${r.parts.map((p) => p.type).join(',')}`)
        }
      }

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

    /**
     * Spec B 新增。手动触发一次 workspace snapshot。
     *
     * - workspaceSnapshot 未启用 / 沙箱尚未 acquire → 返回 { ms: 0, skipped: true }
     * - 启用且沙箱已就绪 → 转发到 WorkspaceSnapshotEngine.snapshot(inst)
     *
     * 失败一律向上抛(业务方主动调用,理应感知错误);自动 send-end snapshot 失败
     * 则在 generator 内 yield warning(见 runClaudeQuery finally 块)。
     */
    async snapshotWorkspace(): Promise<{ ms: number; skipped?: boolean }> {
      if (!sessionSnapshotEngine || !sandboxInstance) {
        return { ms: 0, skipped: true }
      }
      return sessionSnapshotEngine.snapshot(sandboxInstance)
    },

    /**
     * Spec B 新增。查询本 session 启动时的 restore 状态。
     *
     * **调用时机**：必须在 send() 之后调用（sandbox / snapshotEngine 为懒初始化）。
     * send() 前调用始终返回 null。
     *
     * - sandbox 未就绪 / snapshotEngine 未创建 → null
     * - /health 暂不可用或 restoreStatus 字段为空 → null(graceful)
     */
    async getRestoreStatus(): Promise<'full' | 'fresh' | 'partial' | 'failed' | null> {
      if (!sessionSnapshotEngine) {
        if (process.env.OAK_DEBUG === '1') {
          // eslint-disable-next-line no-console
          console.error(
            '[oak][getRestoreStatus] NULL PATH ①: sessionSnapshotEngine not yet created — call send() first',
          )
        }
        return null
      }
      if (!sandboxInstance) {
        if (process.env.OAK_DEBUG === '1') {
          // eslint-disable-next-line no-console
          console.error('[oak][getRestoreStatus] NULL PATH ①: sandboxInstance not yet acquired — call send() first')
        }
        return null
      }
      const status = await sessionSnapshotEngine.getRestoreStatus(sandboxInstance)
      if (process.env.OAK_DEBUG === '1') {
        // eslint-disable-next-line no-console
        console.error(`[oak][getRestoreStatus] result=${status}`)
      }
      return status
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
        .catch((err) => {
          // Registration failure is non-fatal for session creation,
          // but always log it (not just in OAK_DEBUG mode) so operators
          // can detect lost writes in SCF/cloudrun environments.
          // eslint-disable-next-line no-console
          console.error('[oak] registerSession failed:', err)
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

    // 检测内部 sentinel（HITL approval / client-tool / askUser）
    const isSentinel = msg.parts.some(
      (p) =>
        p.type === 'tool_result' &&
        typeof p.output === 'string' &&
        ((p.output as string).includes('__OAK_INTERRUPT__') ||
          (p.output as string).includes('__OAK_CLIENT_TOOL__') ||
          (p.output as string).includes('__OAK_ASK_USER__')),
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
  userId: string
  isContinuation: boolean
  ensureSandbox: () => Promise<SandboxInstance | undefined>
  ensureCloudbaseMcp: (sandbox: SandboxInstance) => Promise<SdkMcpServerConfig | undefined>
  /** Spec B(Task 8):首次 send 时执行 snapshot bootstrap(restore)*/
  ensureSnapshotBootstrap: (engine: WorkspaceSnapshotEngine, sandbox: SandboxInstance) => Promise<void>
  /** Spec B(Task 8):把 buildClaudeQueryOptions 拿到的 engine 上抛给 session 闭包 */
  onSnapshotEngine: (engine: WorkspaceSnapshotEngine | undefined) => void
  permissionStore?: PermissionStore
  /** PR #7.1: names of user-defined client-side tools (config.tools[].name set). */
  clientToolNames?: ReadonlySet<string>
  /** PR #7.1: store for client-supplied tool results. */
  clientToolStore?: ClientToolResultStore
  /** askUser: store for pending askUser entries. */
  askUserStore?: AskUserStore
}

async function* runClaudeQuery(args: RunClaudeQueryArgs): AsyncGenerator<SessionEvent, void, unknown> {
  const {
    config,
    input,
    abortController,
    sessionId,
    conversationId,
    userId,
    isContinuation,
    ensureSandbox,
    ensureCloudbaseMcp,
    ensureSnapshotBootstrap,
    onSnapshotEngine,
    permissionStore,
    clientToolNames,
    clientToolStore,
    askUserStore,
  } = args

  let q: ReturnType<typeof claudeQuery> | undefined
  let syncEngine: ReturnType<typeof buildClaudeQueryOptions>['syncEngine']
  let snapshotEngine: ReturnType<typeof buildClaudeQueryOptions>['snapshotEngine']
  let sandbox: SandboxInstance | undefined
  // Spec B(Task 8):仅当 snapshot bootstrap 成功完成(或无需 bootstrap)时才置 true。
  // 若 bootstrap 抛错(SandboxRestoreFailed / 网络),finally 必须跳过 send-end snapshot,
  // 否则会在 broken state 上再花 30s timeout 做 snapshot,可能把不完整状态推上 COS。
  let bootstrapOk = false
  try {
    sandbox = await ensureSandbox()
    const cloudbaseMcp = sandbox ? await ensureCloudbaseMcp(sandbox) : undefined

    // PR #7.0：构造一轮的 hook 本地状态（同 query 内闭包共享）
    const hookLocalState: PreToolUseHookLocalState = createHookLocalState()
    // PR #7.0：合并真正生效的 permissions（注入实际的 store——可能是 default in-memory，
    // 也可能是用户传入的；hook factory 需要它来读决策）。
    const effectivePermissions = config.permissions ? { ...config.permissions, store: permissionStore } : undefined
    const effectiveConfig = effectivePermissions ? { ...config, permissions: effectivePermissions } : config

    const built = buildClaudeQueryOptions(effectiveConfig, {
      sandboxInstance: sandbox,
      extraMcpServers: cloudbaseMcp ? { cloudbase: cloudbaseMcp } : undefined,
      conversationId,
      hookLocalState,
      ...(clientToolNames ? { clientToolNames } : {}),
      ...(clientToolStore ? { clientToolStore } : {}),
      ...(askUserStore ? { askUserStore } : {}),
      userId,
    })
    const options = built.options
    syncEngine = built.syncEngine
    snapshotEngine = built.snapshotEngine
    onSnapshotEngine(snapshotEngine)

    // ── Spec B(Task 8):workspace snapshot bootstrap(首次 send + 启用时)───
    // 必须在 claudeQuery() 之前执行,否则模型可能在 restore 完成前就读到空 cwd。
    // 失败(SandboxRestoreFailed / 网络错误)向上冒,被外层 catch 翻成 error 事件;
    // bootstrapOk 保持 false,finally 跳过 send-end snapshot。
    if (snapshotEngine && sandbox) {
      await ensureSnapshotBootstrap(snapshotEngine, sandbox)
      bootstrapOk = true
    } else {
      // 没有 engine 或没有 sandbox = 没有 bootstrap 要做,后续 finally 的
      // snapshot 分支条件本身也会被跳过,这里置 true 仅为语义自洽。
      bootstrapOk = true
    }

    // ── userMemory: send-start pull(失败不抛,记 warning)───
    if (syncEngine) {
      try {
        await syncEngine.pullOnSendStart()
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[oak/userMemory] pullOnSendStart failed:', (err as Error)?.message)
      }
    }

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
  } finally {
    // ── userMemory: send-end push(abort/异常都触发,失败不抛)───
    if (syncEngine) {
      try {
        await syncEngine.pushOnSendEnd()
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[oak/userMemory] pushOnSendEnd failed:', (err as Error)?.message)
      }
    }

    // ── Spec B(Task 8):send-end workspace snapshot(失败 yield warning,不抹答案)──
    // Spec §6.1 提到 oak_workspace_snapshot_duration_ms metric;OAK 当前还没 metrics
    // 框架,留 TODO 等专门 PR 接入(写到 console.error 用于诊断)。
    // bootstrapOk 守门:若 bootstrap 抛了错,沙箱状态可能不完整,继续 snapshot 会把
    // 残缺状态推上 COS,且白白花 30s 网络 timeout。
    if (snapshotEngine && sandbox && bootstrapOk) {
      try {
        const result = await snapshotEngine.snapshot(sandbox)
        if (process.env.OAK_DEBUG === '1') {
          // eslint-disable-next-line no-console
          console.error(`[oak][workspace-snapshot] ms=${result.ms}`)
        }
        // TODO(metrics):emit oak_workspace_snapshot_duration_ms histogram(spec §6.1)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        // OAK SessionEvent union 暂无独立 'warning' 成员;复用 'error' 事件传递,
        // 用确定性错误名让上层(协议适配 / 业务 logger)能识别为非致命快照警告。
        const warning = new Error(`workspace_snapshot_failed: ${reason}`)
        warning.name = 'WorkspaceSnapshotFailedWarning'
        yield { type: 'error', error: warning }
      }
    }
  }
}

// ============================================================
// 内部：注入审批决策并 resume agent 运行（PR #7.0）
// ============================================================

interface RunApprovalResumeArgs {
  config: AgentConfig
  conversationId: string
  userId: string
  toolUseId: string
  decision: ApprovalDecision
  abortController: AbortController
  ensureSandbox: () => Promise<SandboxInstance | undefined>
  ensureCloudbaseMcp: (sandbox: SandboxInstance) => Promise<SdkMcpServerConfig | undefined>
  ensureSnapshotBootstrap: (engine: WorkspaceSnapshotEngine, sandbox: SandboxInstance) => Promise<void>
  onSnapshotEngine: (engine: WorkspaceSnapshotEngine | undefined) => void
  permissionStore?: PermissionStore
  clientToolNames?: ReadonlySet<string>
  clientToolStore?: ClientToolResultStore
  askUserStore?: AskUserStore
}

async function* runApprovalResume(args: RunApprovalResumeArgs): AsyncGenerator<SessionEvent, void, unknown> {
  const {
    config,
    conversationId,
    userId,
    toolUseId,
    decision,
    abortController,
    ensureSandbox,
    ensureCloudbaseMcp,
    ensureSnapshotBootstrap,
    onSnapshotEngine,
    permissionStore,
    clientToolNames,
    clientToolStore,
    askUserStore,
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
      error: new ResourceError('No pending approval found. It may have expired or already been resolved.'),
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
    userId,
    isContinuation: true,
    ensureSandbox,
    ensureCloudbaseMcp,
    ensureSnapshotBootstrap,
    onSnapshotEngine,
    permissionStore,
    ...(clientToolNames ? { clientToolNames } : {}),
    ...(clientToolStore ? { clientToolStore } : {}),
    ...(askUserStore ? { askUserStore } : {}),
  })
}

// ============================================================
// 内部：注入客户端工具结果并 resume agent 运行（PR #7.1）
// ============================================================

interface RunClientToolResumeArgs {
  config: AgentConfig
  conversationId: string
  userId: string
  toolUseId: string
  output: unknown
  isError: boolean
  abortController: AbortController
  ensureSandbox: () => Promise<SandboxInstance | undefined>
  ensureCloudbaseMcp: (sandbox: SandboxInstance) => Promise<SdkMcpServerConfig | undefined>
  ensureSnapshotBootstrap: (engine: WorkspaceSnapshotEngine, sandbox: SandboxInstance) => Promise<void>
  onSnapshotEngine: (engine: WorkspaceSnapshotEngine | undefined) => void
  permissionStore?: PermissionStore
  clientToolNames: ReadonlySet<string>
  clientToolStore?: ClientToolResultStore
  askUserStore?: AskUserStore
}

async function* runClientToolResume(args: RunClientToolResumeArgs): AsyncGenerator<SessionEvent, void, unknown> {
  const {
    config,
    conversationId,
    userId,
    toolUseId,
    output,
    isError,
    abortController,
    ensureSandbox,
    ensureCloudbaseMcp,
    ensureSnapshotBootstrap,
    onSnapshotEngine,
    permissionStore,
    clientToolNames,
    clientToolStore,
    askUserStore,
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
        `No pending client tool found for toolUseId=${toolUseId}. ` + 'It may have expired or already been resolved.',
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

  // Note: session_entries retains the sentinel deny tool_result as-is.
  // This is by design — the SDK transcript is append-only. The sentinel
  // is filtered at the presentation layer by aggregateHistory() in getHistory().
  // Updating the entry would break aggregateHistory()'s sentinel detection
  // and cause duplicate tool_calls in the output.

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
    userId,
    isContinuation: true,
    ensureSandbox,
    ensureCloudbaseMcp,
    ensureSnapshotBootstrap,
    onSnapshotEngine,
    permissionStore,
    clientToolNames,
    clientToolStore,
    ...(askUserStore ? { askUserStore } : {}),
  })
}

// ============================================================
// 内部：注入 askUser 回答并 resume agent 运行
// ============================================================

interface RunAskUserResumeArgs {
  config: AgentConfig
  conversationId: string
  userId: string
  toolUseId: string
  answer: string
  abortController: AbortController
  ensureSandbox: () => Promise<SandboxInstance | undefined>
  ensureCloudbaseMcp: (sandbox: SandboxInstance) => Promise<SdkMcpServerConfig | undefined>
  ensureSnapshotBootstrap: (engine: WorkspaceSnapshotEngine, sandbox: SandboxInstance) => Promise<void>
  onSnapshotEngine: (engine: WorkspaceSnapshotEngine | undefined) => void
  permissionStore?: PermissionStore
  clientToolNames: ReadonlySet<string>
  clientToolStore?: ClientToolResultStore
  askUserStore: AskUserStore
}

async function* runAskUserResume(args: RunAskUserResumeArgs): AsyncGenerator<SessionEvent, void, unknown> {
  const {
    config,
    conversationId,
    userId,
    toolUseId,
    answer,
    abortController,
    ensureSandbox,
    ensureCloudbaseMcp,
    ensureSnapshotBootstrap,
    onSnapshotEngine,
    permissionStore,
    clientToolNames,
    clientToolStore,
    askUserStore,
  } = args

  const existing = await askUserStore.get({ conversationId, toolUseId })
  if (!existing) {
    yield {
      type: 'error',
      error: new ResourceError(
        `No pending askUser found for toolUseId=${toolUseId}. ` + 'It may have expired or already been resolved.',
      ),
    }
    yield { type: 'session_idle', reason: 'error' }
    return
  }
  if (existing.result) {
    yield {
      type: 'error',
      error: new ResourceError(`askUser for toolUseId=${toolUseId} has already been resolved.`),
    }
    yield { type: 'session_idle', reason: 'error' }
    return
  }

  await askUserStore.put({ ...existing, result: { answer } })

  // Resume prompt: tell the model the user has answered, ask it to retry
  // the askUser tool so the hook can inject the answer.
  const resumePrompt = `[系统通知] 用户已回答了你刚才的提问。请重新调用 askUser 工具以获取用户的回答（hook 会自动注入），然后基于回答继续。`

  yield* runClaudeQuery({
    config,
    input: resumePrompt,
    abortController,
    sessionId: conversationId,
    conversationId,
    userId,
    isContinuation: true,
    ensureSandbox,
    ensureCloudbaseMcp,
    ensureSnapshotBootstrap,
    onSnapshotEngine,
    permissionStore,
    clientToolNames,
    clientToolStore,
    askUserStore,
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

  const platformCreds = config.credentials

  if (!platformCreds?.secretId || !platformCreds.secretKey) {
    throw new InvalidConfigError(
      'CloudBase MCP tools require user credentials. ' +
        'Either set AgentConfig.sandbox.userCredentials, ' +
        'or pass AgentConfig.credentials. ' +
        'To disable cloudbase tools entirely, pass `sandbox: { cloudbaseTools: false }`.',
    )
  }

  return {
    envId: platformCreds.envId || config.envId,
    secretId: platformCreds.secretId,
    secretKey: platformCreds.secretKey,
    sessionToken: platformCreds.sessionToken,
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
    async get(conversationId): Promise<SessionSummary | null> {
      const store = config.session?.store as
        | {
            getSession?: (k: string, sid: string) => Promise<{ sessionId: string; mtime: number; userId?: string } | null>
          }
        | undefined
      if (!store?.getSession) return null
      const projectKey = config.session?.projectKey ?? config.envId
      const hit = await store.getSession(projectKey, conversationId)
      if (!hit) return null
      return {
        conversationId: hit.sessionId,
        userId: hit.userId ?? '',
        status: 'idle' as const,
        createdAt: hit.mtime,
        updatedAt: hit.mtime,
      }
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
