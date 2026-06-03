/**
 * PreToolUse Hook 桥接（PR #7.0）。
 *
 * 实现思路：
 *   1. 当 SDK 子进程检测到工具调用即将执行时，PreToolUse hook 在父进程被调用
 *   2. 我们 在 hook 内：
 *      - 检查 PermissionStore 里是否已有该 toolUseId 的 decision
 *        - 有 'allow' → 返回 {} 放行；同时清掉 store entry
 *        - 有 'deny'  → 返回 deny + 用户拒绝理由（**不**带 sentinel）
 *      - 没有 → 检查规则，需要审批 → 写 store + 返回 deny + sentinel
 *      - 不需要审批 → 返回 {} 放行
 *   3. 事件翻译层（event-translator）识别 sentinel 后吐出 'tool_approval_required' 事件
 *      并吃掉这条假 deny tool_result，避免污染业务事件流和 transcript
 *
 * 这里 "sentinel" 是把 magic string 塞进 `permissionDecisionReason`——这是 SDK Hook
 * 接口能传递信号的唯一通道。具体实现是一个 JSON 字符串，业务侧不会看到（被 translator 吃掉）。
 */

import type { ApprovalDecision, PendingApproval, PermissionConfig } from '../public/types.js'
import { compileRequireApprovalPredicate, DEFAULT_APPROVAL_TIMEOUT_MS, isStaleApproval } from './store.js'

/**
 * Magic string used inside `updatedInput` to inject a client-supplied tool
 * result back into a custom tool's execute() call. The client-tool stub
 * reads this key and returns its content as the tool result, so the SDK
 * writes a real (non-error) tool_result to the transcript.
 */
export const OAK_CLIENT_TOOL_RESULT_KEY = '__oak_client_tool_result__'

/**
 * Pending entry shape for client-side tools (mirrors PendingApproval but
 * carries `output` instead of `decision`).
 */
export interface PendingClientToolResult {
  conversationId: string
  toolUseId: string
  toolName: string
  toolInput: unknown
  /** Set once the host calls session.respondToolUse(). */
  result?: { output: unknown; isError: boolean }
  createdAt: number
}

/**
 * Sentinel：识别 deny reason 是 kernel 自己塞的"中断信号"还是模型/真实 deny。
 *
 * 选择 `__OAK_INTERRUPT__` 是为了：
 *   - 跟其他 reason 字段区分（用户真实 deny 不会含此 token）
 *   - 不依赖业务自定义任何字段
 *   - 用 JSON 而非裸字符串便于携带 metadata（如 toolUseId）
 */
export const OAK_INTERRUPT_SENTINEL = '__OAK_INTERRUPT__'

/**
 * 单轮 SDK 运行的本地状态（防御机制）。
 *
 * 同一 SDK query 内可能出现：
 *   - 同一 toolUseId 触发多次 PreToolUse（不太常见，但 SDK 行为非保证）
 *   - 不同 toolUseId 在同一轮里都需要审批（并发工具调用场景）
 *
 * 我们采用与 tcb-headless-service.copilot 类似的策略：**一轮里只允许触发一次中断**——
 * 后续的需审批工具调用直接返回 deny 让模型重试，而不是创建多个并行 pending entry。
 * 这样设计的依据：
 *   - 用户一次只看一个审批 UI 简单
 *   - 多并发审批易混淆 toolUseId 映射
 *   - 真出现同轮多工具的场景，让模型在用户决策后再触发剩下的就行
 */
export interface PreToolUseHookLocalState {
  /** 当轮 SDK 运行已创建过的 interrupt 标记（防同轮多 interrupt） */
  hasInterruptedThisRun: boolean
  /** 上一次 interrupt 的 toolUseId（用于诊断 / resume 时兜底校验） */
  lastInterruptedToolUseId?: string
  /**
   * 本轮 SDK query 内的"按 toolName 缓存的决策"，用于 scope='session' 决策。
   * 模型在同一轮内多次调用同一工具，hook 直接复用第一次的决策。
   */
  sessionDecisions?: Map<string, ApprovalDecision>
}

export function createHookLocalState(): PreToolUseHookLocalState {
  return { hasInterruptedThisRun: false }
}

/**
 * Sentinel reason payload（写到 permissionDecisionReason 的 JSON 字符串）。
 * event-translator 解析这个 JSON 把 toolUseId / toolName / input 还原成 'tool_approval_required' 事件。
 */
export interface InterruptSignalPayload {
  [OAK_INTERRUPT_SENTINEL]: true
  conversationId: string
  toolUseId: string
  toolName: string
  toolInput: unknown
  /** UI hints 透传到事件 */
  hints?: {
    displayName?: string
    description?: string
    suggestedScopes?: Array<'once' | 'session' | 'forever'>
  }
}

export function isInterruptSignal(reason: unknown): reason is string {
  if (typeof reason !== 'string') return false
  if (!reason.includes(OAK_INTERRUPT_SENTINEL)) return false
  try {
    const parsed = JSON.parse(reason) as Partial<InterruptSignalPayload>
    return parsed[OAK_INTERRUPT_SENTINEL] === true
  } catch {
    return false
  }
}

export function parseInterruptSignal(reason: string): InterruptSignalPayload | null {
  try {
    const parsed = JSON.parse(reason) as Partial<InterruptSignalPayload>
    if (parsed[OAK_INTERRUPT_SENTINEL] === true) {
      return parsed as InterruptSignalPayload
    }
  } catch {
    /* fall through */
  }
  return null
}

// ─────────────────────────────────────────────────────────
// Client-tool sentinel (PR #7.1)
// ─────────────────────────────────────────────────────────
//
// Same idea as the approval sentinel but signals "stop the turn — this tool
// must be executed by the client". Used for tools whose definitions live in
// AgentConfig.tools[] and whose `execute()` is a stub: the kernel never
// actually runs them, it pauses the turn (via permissionDecision='deny' +
// sentinel) and emits a `tool_use_required` SessionEvent so the host can
// run the tool elsewhere and feed the result back via session.send({type:
// 'tool_result'}).
//
// Wire format mirrors InterruptSignalPayload to share parser code; the
// discriminator is OAK_CLIENT_TOOL_SENTINEL (different magic string).

export const OAK_CLIENT_TOOL_SENTINEL = '__OAK_CLIENT_TOOL__'

export interface ClientToolSignalPayload {
  [OAK_CLIENT_TOOL_SENTINEL]: true
  conversationId: string
  toolUseId: string
  toolName: string
  toolInput: unknown
}

export function parseClientToolSignal(reason: string): ClientToolSignalPayload | null {
  if (!reason.includes(OAK_CLIENT_TOOL_SENTINEL)) return null
  try {
    const parsed = JSON.parse(reason) as Partial<ClientToolSignalPayload>
    if (parsed[OAK_CLIENT_TOOL_SENTINEL] === true) return parsed as ClientToolSignalPayload
  } catch {
    /* fall through */
  }
  return null
}

// ─────────────────────────────────────────────────────────
// Hook factory
// ─────────────────────────────────────────────────────────

export interface PreToolUsePermissionHookArgs {
  conversationId: string
  permissions: PermissionConfig
  /** 闭包共享单轮状态（同一 SDK query 内复用） */
  localState: PreToolUseHookLocalState
  /**
   * Names of user-defined client-side tools (config.tools[].name). When the
   * model invokes one of these, the hook denies with a client-tool sentinel
   * so the SDK never calls execute(); the runtime intercepts the sentinel
   * to surface a 'tool_use_required' event and pause the turn.
   *
   * On resume, the hook reads the host-supplied result from the
   * clientToolStore and ALLOWs the call after rewriting `updatedInput` to
   * carry the result under OAK_CLIENT_TOOL_RESULT_KEY. The wrapped MCP
   * stub reads this key and returns its content as the tool result.
   */
  clientToolNames?: ReadonlySet<string>
  clientToolStore?: ClientToolResultStore
}

export interface ClientToolResultStore {
  put(entry: PendingClientToolResult): Promise<void>
  get(key: { conversationId: string; toolUseId: string }): Promise<PendingClientToolResult | null>
  delete(key: { conversationId: string; toolUseId: string }): Promise<void>
  scanRecent?(key: { conversationId: string; toolName: string }): Promise<PendingClientToolResult | null>
}

/**
 * Claude SDK Hook callback 入参（PreToolUse）。
 * 我们用一个本地最小子集类型，避免硬依赖 SDK 内部类型。
 */
interface PreToolUseHookInput {
  hook_event_name: 'PreToolUse'
  tool_name: string
  tool_input: unknown
  tool_use_id: string
}

/**
 * Claude SDK 的 HookCallback 入参（联合类型）。我们的 hook 只关心 PreToolUse，
 * 用 generic 入参 + 运行时收窄。
 */
interface AnyHookInput {
  hook_event_name: string
  [k: string]: unknown
}

/**
 * Claude SDK Hook callback 输出。我们的实现只用 hookSpecificOutput.permissionDecision。
 */
interface PreToolUseHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse'
    permissionDecision?: 'allow' | 'deny' | 'ask' | 'defer'
    permissionDecisionReason?: string
    updatedInput?: Record<string, unknown>
  }
}

/**
 * 构建 PreToolUse hook 回调。
 *
 * 该回调直接传给 Claude SDK options.hooks.PreToolUse；我们用宽入参（AnyHookInput）+ 运行时收窄
 * 来匹配 SDK 的 HookCallback 联合签名。
 */
export function createPreToolUsePermissionHook(
  args: PreToolUsePermissionHookArgs,
): (
  input: AnyHookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<PreToolUseHookOutput | Record<string, never>> {
  const { conversationId, permissions, localState, clientToolNames, clientToolStore } = args
  const requirePredicate = compileRequireApprovalPredicate(permissions.requireApproval)
  const store = permissions.store
  const timeoutMs = permissions.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS

  return async (rawInput, toolUseID): Promise<PreToolUseHookOutput | Record<string, never>> => {
    // 防御：matcher 没传时该 hook 会收到所有事件，过滤一下
    if (rawInput.hook_event_name !== 'PreToolUse') return {}
    const input = rawInput as unknown as PreToolUseHookInput
    const toolName = input.tool_name
    const toolInput = input.tool_input
    const toolUseId = input.tool_use_id ?? toolUseID ?? ''

    // ── PR #7.1: client-side tool flow ─────────────────────────────────
    // Tools whose names appear in clientToolNames have stub execute()s in
    // an in-process MCP server (mcp__custom__<name>). The kernel must NOT
    // run them; instead pause the turn and let the host execute the tool.
    //
    // Lookup is by the bare tool name (config.tools[].name), but the SDK
    // reports the prefixed form 'mcp__custom__<bare>'. Strip the prefix
    // before matching.
    const bareToolName = toolName.startsWith('mcp__custom__')
      ? toolName.slice('mcp__custom__'.length)
      : toolName
    const isClientTool = !!clientToolNames && clientToolNames.has(bareToolName)

    if (isClientTool && clientToolStore) {
      // Phase A: a result is already waiting in the store (resume path).
      // Allow the call but pass the result through `updatedInput` so the
      // wrapped MCP stub returns it directly without doing real work.
      // We try by toolUseId first (rare race), then by toolName scan.
      if (toolUseId) {
        const existing = await clientToolStore.get({ conversationId, toolUseId })
        if (existing?.result) {
          await clientToolStore.delete({ conversationId, toolUseId })
          return buildClientToolAllow(toolInput, existing.result)
        }
      }
      if (clientToolStore.scanRecent) {
        const scanned = await clientToolStore.scanRecent({ conversationId, toolName: bareToolName })
        if (scanned?.result) {
          await clientToolStore.delete({ conversationId, toolUseId: scanned.toolUseId })
          return buildClientToolAllow(toolInput, scanned.result)
        }
      }

      // Phase B: no result → pause. Mirror the approval flow: write a
      // pending entry, return deny + sentinel. Translator detects the
      // sentinel and emits a 'tool_use_required' SessionEvent.
      if (!toolUseId) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: JSON.stringify({
              reason: 'Internal error: missing toolUseId for client-side tool flow.',
              type: 'oak_internal_error',
            }),
          },
        }
      }
      const pending: PendingClientToolResult = {
        conversationId,
        toolUseId,
        toolName: bareToolName,
        toolInput,
        createdAt: Date.now(),
      }
      await clientToolStore.put(pending)

      const signal: ClientToolSignalPayload = {
        [OAK_CLIENT_TOOL_SENTINEL]: true,
        conversationId,
        toolUseId,
        toolName: bareToolName,
        toolInput,
      }
      const reasonForModel =
        `Tool call deferred to the client (toolUseId=${toolUseId}). ` +
        `Do not retry this tool yourself; the client is executing it. ` +
        `Stop the current turn and wait for the next user message.`
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: JSON.stringify({ ...signal, message: reasonForModel }),
        },
      }
    }

    // 没配 store → 直接放行（PR #7.0 防御：缺 store 时审批无法持久化，避免误暂停）
    if (!store) {
      return {}
    }

    // ── Phase 1a: 当前 toolUseId 在 store 里有 decision（罕见——同一 toolUseId 重发的场景） ──
    if (toolUseId) {
      const existing = await store.get({ conversationId, toolUseId })
      if (existing && existing.decision) {
        const result = applyDecision(existing, toolName, timeoutMs)
        if (result.cleanup) await store.delete({ conversationId, toolUseId })
        if (result.shouldClearTurnFlag) localState.hasInterruptedThisRun = false
        return result.output
      }
    }

    // ── Phase 1b: 同 toolName 的 decision 命中（PR #7.0 关键设计）──
    //    模型 resume 后会用新的 toolUseId 重发同样的工具，store 里旧 toolUseId 的 decision
    //    需要被这次调用消化。我们用 sessionDecisions（同 conversationId 内的"刚批/刚拒"短期记忆）。
    //    sessionDecisions 在闭包内，跟随 SDK query 生命周期；resume 时新 query 会带新闭包，
    //    但 store 里的 decision 也会按 toolName 兜底（下面 scanByToolName）。
    if (localState.sessionDecisions) {
      const sessionHit = localState.sessionDecisions.get(toolName)
      if (sessionHit) {
        // 'session' scope 的 decision 永久放行该工具直到本轮 SDK query 结束
        if (sessionHit.kind === 'allow') {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
              ...(sessionHit.updatedInput ? { updatedInput: sessionHit.updatedInput } : {}),
            },
          }
        }
        if (sessionHit.kind === 'deny') {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: JSON.stringify({
                reason: sessionHit.reason ?? 'User denied this tool call (session-wide).',
                type: 'oak_user_denied_session',
              }),
            },
          }
        }
      }
    }

    // 兜底扫描 store：是否有相同 conversationId + 相同 toolName 的"已决策且未消费"entry
    // 这是 resume 路径的核心：respondApproval 写完 decision 后，模型重发同 toolName 但
    // 新 toolUseId，hook 来这里按 toolName 找到旧 entry 并消化掉。
    if ('scanRecent' in store && typeof (store as { scanRecent?: unknown }).scanRecent === 'function') {
      // 仅为 InMemory 这类支持 scan 的 store 启用快速路径；其他 store 不强制（PR #7.1
      // 时若引入 CloudBaseDb 可考虑加索引）。
      const scanned = await (
        store as unknown as {
          scanRecent: (key: { conversationId: string; toolName: string }) => Promise<PendingApproval | null>
        }
      ).scanRecent({ conversationId, toolName })
      if (scanned && scanned.decision) {
        if (isStaleApproval(scanned, timeoutMs)) {
          await store.delete({ conversationId, toolUseId: scanned.toolUseId })
        } else {
          const decision = scanned.decision
          await store.delete({ conversationId, toolUseId: scanned.toolUseId })
          // 命中即记入 sessionDecisions（如果 scope='session'，本轮内同 toolName 不再触发审批）
          if (decision.scope === 'session') {
            localState.sessionDecisions ??= new Map()
            localState.sessionDecisions.set(toolName, decision)
          }
          localState.hasInterruptedThisRun = false
          if (decision.kind === 'allow') {
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
                ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
              },
            }
          }
          // deny
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: JSON.stringify({
                reason: decision.reason ?? 'User denied this tool call.',
                type: 'oak_user_denied',
                ...(decision.interrupt ? { interrupt: true } : {}),
              }),
            },
          }
        }
      }
    }

    // ── Phase 2: 不在 store → 检查规则是否需要审批 ──
    const needs = await Promise.resolve(requirePredicate({ toolName, input: toolInput, conversationId }))
    if (!needs) {
      return {} // 不需要审批，放行
    }

    // ── Phase 3: 同轮已经触发过中断 → 拒绝后续工具，让模型先等用户决策 ──
    if (localState.hasInterruptedThisRun) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: JSON.stringify({
            reason:
              'Another tool call is already pending user approval in this turn. ' +
              'Please wait for that decision before requesting more tools.',
            type: 'oak_pending_approval_in_turn',
          }),
        },
      }
    }

    // ── Phase 4: 触发中断：写 pending → 返回 sentinel deny ──
    if (!toolUseId) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: JSON.stringify({
            reason: 'Internal error: missing toolUseId for approval flow.',
            type: 'oak_internal_error',
          }),
        },
      }
    }
    const pending: PendingApproval = {
      conversationId,
      toolUseId,
      toolName,
      toolInput,
      createdAt: Date.now(),
    }
    await store.put(pending)
    localState.hasInterruptedThisRun = true
    localState.lastInterruptedToolUseId = toolUseId

    const signal: InterruptSignalPayload = {
      [OAK_INTERRUPT_SENTINEL]: true,
      conversationId,
      toolUseId,
      toolName,
      toolInput,
      hints: {
        suggestedScopes: ['once', 'session'],
      },
    }
    // permissionDecisionReason 这段 JSON 既是 kernel 内部的 sentinel，又会被 SDK
    // 当作 tool_result 喂给模型 context（SDK 接口约束）。我们让它对模型也"读得通"：
    // 加一个明确的 message 字段，引导模型停止重试、等待审批。
    // event-translator 仍然识别 sentinel 字段并把这条消息从业务事件流里吃掉。
    const reasonForModel =
      `Tool call paused for user approval (toolUseId=${toolUseId}). ` +
      `Do not retry this tool yourself; the user is reviewing it. ` +
      `Stop the current turn and wait for the next user message.`
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: JSON.stringify({
          ...signal,
          message: reasonForModel,
        }),
      },
    }
  }
}

// ─────────────────────────────────────────────────────────
// 辅助：把 store 里的 decision 转成 hook output
// ─────────────────────────────────────────────────────────

/**
 * Build the allow output that injects a client-supplied tool result into
 * the wrapped MCP stub via `updatedInput`. The stub reads the magic key
 * and returns its value as the tool result, so the SDK records a real
 * (non-error) tool_result in the transcript.
 */
function buildClientToolAllow(
  originalInput: unknown,
  result: { output: unknown; isError: boolean },
): PreToolUseHookOutput {
  const baseInput = originalInput && typeof originalInput === 'object' ? (originalInput as Record<string, unknown>) : {}
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        ...baseInput,
        [OAK_CLIENT_TOOL_RESULT_KEY]: {
          output: result.output,
          isError: result.isError,
        },
      },
    },
  }
}

interface ApplyDecisionResult {
  output: PreToolUseHookOutput
  cleanup: boolean
  shouldClearTurnFlag: boolean
}

function applyDecision(existing: PendingApproval, toolName: string, timeoutMs: number): ApplyDecisionResult {
  // 工具名校验
  if (existing.toolName !== toolName) {
    return {
      output: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: JSON.stringify({
            reason:
              `Tool mismatch: user approved "${existing.toolName}" but model invoked "${toolName}". ` +
              `Please retry with the approved tool name.`,
            type: 'oak_tool_mismatch',
          }),
        },
      },
      cleanup: false, // 保留 entry 让模型重试时能再找到
      shouldClearTurnFlag: false,
    }
  }
  // 超时
  if (isStaleApproval(existing, timeoutMs)) {
    return {
      output: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: JSON.stringify({
            reason: 'Approval expired before user response.',
            type: 'oak_approval_expired',
          }),
        },
      },
      cleanup: true,
      shouldClearTurnFlag: false,
    }
  }
  const decision = existing.decision!
  if (decision.kind === 'allow') {
    return {
      output: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
        },
      },
      cleanup: true,
      shouldClearTurnFlag: true,
    }
  }
  // deny
  return {
    output: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: JSON.stringify({
          reason: decision.reason ?? 'User denied this tool call.',
          type: 'oak_user_denied',
          ...(decision.interrupt ? { interrupt: true } : {}),
        }),
      },
    },
    cleanup: true,
    shouldClearTurnFlag: true,
  }
}
