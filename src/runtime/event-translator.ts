/**
 * Event translator: Claude Agent SDK SDKMessage → kernel SessionEvent
 *
 * SDK 端的事件类型（@anthropic-ai/claude-agent-sdk）：
 *   - SDKAssistantMessage: assistant turn，message.content[] 是 Anthropic ContentBlock 数组
 *     - text block          → kernel 'message_delta' / 'message_complete'
 *     - tool_use block      → kernel 'tool_call'
 *     - thinking block      → 暂不映射（v0.2 可作为单独事件）
 *   - SDKUserMessage（含 tool_result block）→ kernel 'tool_result'
 *     - **特殊：含 OAK_INTERRUPT_SENTINEL 的 tool_result（PR #7.0 假 deny）**
 *       → 翻译成 kernel 'tool_approval_required'，不再 yield 'tool_result'
 *   - SDKResultMessage（success/error）     → kernel 'session_idle'
 *   - SDKPartialAssistantMessage（流式 chunk）→ kernel 'message_delta'
 *   - 其他 SDK 内部消息（hook_started / status / system 等）→ 暂不暴露
 *
 * 设计原则：
 *   - kernel 不暴露任何 SDK 内部类型给上层
 *   - 翻译失败/未知消息类型 → 静默丢弃（不抛错，避免阻断主流程）
 *   - 一个 SDKAssistantMessage 可能携带多个 content block，逐个 yield 多个 SessionEvent
 *
 * 状态：
 *   PR #2 起 translator 是无状态的；PR #7.0 引入 `TranslatorState` 用于记录一轮内
 *   是否触发过 approval（让最终的 session_idle 能正确翻译为 'requires_action'）。
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { parseInterruptSignal } from '../permissions/hooks.js'
import type { SessionEvent } from '../public/types.js'

/**
 * 翻译器的轮内状态（一次 query 的整个事件流共享一个）。
 */
export interface TranslatorState {
  /** 本轮是否触发过 PR #7.0 审批中断 */
  approvalTriggered: boolean
  /**
   * 已 yield 的 tool_call 索引：toolUseId → toolName。
   * 用于在审批中断时给 'tool_approval_required' 事件补 toolName（兜底，主路径从 sentinel JSON 直接拿）。
   */
  toolCallNames: Map<string, string>
}

export function createTranslatorState(): TranslatorState {
  return { approvalTriggered: false, toolCallNames: new Map() }
}

/**
 * 翻译单个 SDK 消息为 0~N 个 kernel SessionEvent（generator 形式，方便上层 for-of 消费）。
 *
 * 注意：这是"轻状态翻译器"，PR #7.0 起在 state 上记录"是否触发过审批"，
 * 用于把最终的 result 消息翻译成 'session_idle.requires_action'。
 */
export function* translateSdkMessage(
  msg: SDKMessage,
  state: TranslatorState = createTranslatorState(),
): Generator<SessionEvent, void, unknown> {
  switch (msg.type) {
    case 'assistant': {
      // BetaMessage.content 是 ContentBlock[]
      const content = msg.message?.content ?? []
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        switch (block.type) {
          case 'text': {
            const text = (block as { text?: string }).text
            if (typeof text === 'string' && text.length > 0) {
              yield { type: 'message_delta', text }
              yield { type: 'message_complete', text }
            }
            break
          }
          case 'tool_use': {
            const toolUseBlock = block as {
              id?: string
              name?: string
              input?: unknown
            }
            if (toolUseBlock.id && toolUseBlock.name) {
              state.toolCallNames.set(toolUseBlock.id, toolUseBlock.name)
              yield {
                type: 'tool_call',
                toolUseId: toolUseBlock.id,
                toolName: toolUseBlock.name,
                input: toolUseBlock.input ?? {},
              }
            }
            break
          }
          // thinking / server_tool_use / 等其他 block 类型暂不映射
          default:
            break
        }
      }
      break
    }

    case 'user': {
      // 用户消息回流时，可能包含 tool_result（agent 自己执行完工具后回灌）
      const content = msg.message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue
          if ((block as { type?: string }).type === 'tool_result') {
            const trBlock = block as {
              tool_use_id?: string
              content?: unknown
              is_error?: boolean
            }
            if (!trBlock.tool_use_id) continue

            // ── PR #7.0：识别审批中断 sentinel ──
            // tool_result.content 在 SDK 里既可能是 string，也可能是 [{type:'text', text:'...'}]。
            const reasonText = extractReasonText(trBlock.content)
            const interrupt = reasonText ? parseInterruptSignal(reasonText) : null
            if (interrupt) {
              state.approvalTriggered = true
              yield {
                type: 'tool_approval_required',
                toolUseId: interrupt.toolUseId,
                toolName: interrupt.toolName,
                input: interrupt.toolInput,
                ...(interrupt.hints ? { hints: interrupt.hints } : {}),
                // PR #7.0：runStateJson 里只放 conversationId + toolUseId（业务侧
                // 不需要解析；后续若做 RunState 序列化再扩展）。
                runStateJson: JSON.stringify({
                  conversationId: interrupt.conversationId,
                  toolUseId: interrupt.toolUseId,
                  schema: 'oak/v1/approvalRef',
                }),
              }
              continue // ← 关键：不再 yield 这条 tool_result（吃掉假 deny）
            }

            // 正常 tool_result
            yield {
              type: 'tool_result',
              toolUseId: trBlock.tool_use_id,
              toolName: state.toolCallNames.get(trBlock.tool_use_id) ?? '',
              output: trBlock.content ?? null,
              isError: Boolean(trBlock.is_error),
            }
          }
        }
      }
      break
    }

    case 'result': {
      // SDKResultSuccess | SDKResultError
      const resultMsg = msg as { subtype?: string; is_error?: boolean }
      // 先看本轮是否触发过审批，触发了就报 requires_action
      if (state.approvalTriggered) {
        yield { type: 'session_idle', reason: 'requires_action' }
      } else if (resultMsg.is_error) {
        yield { type: 'session_idle', reason: 'error' }
      } else if (resultMsg.subtype === 'success') {
        yield { type: 'session_idle', reason: 'completed' }
      } else {
        yield { type: 'session_idle', reason: 'aborted' }
      }
      break
    }

    case 'stream_event': {
      // SDKPartialAssistantMessage（流式增量 chunk，仅在 options.includePartialMessages: true 时发出）
      const partial = msg as {
        event?: { type?: string; delta?: { type?: string; text?: string } }
      }
      const evt = partial.event
      if (
        evt?.type === 'content_block_delta' &&
        evt.delta?.type === 'text_delta' &&
        typeof evt.delta.text === 'string' &&
        evt.delta.text.length > 0
      ) {
        yield { type: 'message_delta', text: evt.delta.text }
      }
      break
    }

    // 其他 SDK 内部消息（system / status / hook_* / task_* / 等）
    default:
      break
  }
}

/**
 * 从 tool_result.content 字段抽出文本（兼容 string / Array<{type:'text', text}>）。
 */
function extractReasonText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (
        part &&
        typeof part === 'object' &&
        (part as { type?: string }).type === 'text' &&
        typeof (part as { text?: string }).text === 'string'
      ) {
        return (part as { text: string }).text
      }
    }
  }
  return null
}
