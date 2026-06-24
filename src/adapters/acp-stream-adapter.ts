import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AcpSessionUpdate } from '../acp/types.js'
import { parseAskUserSignal, parseClientToolSignal, parseInterruptSignal } from '../permissions/hooks.js'
import type { StreamAdapter, StreamAdapterContext } from './types.js'

interface AcpAdapterState {
  activeToolBlocks: Map<number, StreamingToolCall>
  emittedToolCalls: Set<string>
  toolCallNames: Map<string, string>
  streamedText: boolean
}

interface StreamingToolCall {
  toolCallId: string
  toolName: string
  partialJson: string
  parentToolCallId?: string
}

export interface AcpStreamAdapterOptions {
  /**
   * When partial stream events are enabled, assistant text blocks replay the
   * final text. Keep this on to avoid duplicate text chunks.
   */
  dedupeAssistantText?: boolean
}

export class AcpStreamAdapter implements StreamAdapter<AcpSessionUpdate> {
  private readonly dedupeAssistantText: boolean

  constructor(options: AcpStreamAdapterOptions = {}) {
    this.dedupeAssistantText = options.dedupeAssistantText ?? true
  }

  async *adapt(messages: AsyncIterable<SDKMessage>, context: StreamAdapterContext): AsyncIterable<AcpSessionUpdate> {
    const state: AcpAdapterState = {
      activeToolBlocks: new Map(),
      emittedToolCalls: new Set(),
      toolCallNames: new Map(),
      streamedText: false,
    }

    for await (const message of messages) {
      for (const update of this.translateMessage(message, context, state)) {
        yield update
      }
    }
  }

  private *translateMessage(
    message: SDKMessage,
    context: StreamAdapterContext,
    state: AcpAdapterState,
  ): Generator<AcpSessionUpdate, void, unknown> {
    switch (message.type) {
      case 'stream_event':
        yield* translateStreamEvent(message, state)
        return
      case 'assistant':
        yield* translateAssistantMessage(message, state, this.dedupeAssistantText)
        return
      case 'user':
        yield* translateUserMessage(message, context, state)
        return
      case 'result':
        yield {
          sessionUpdate: 'agent_phase',
          phase: 'idle',
          timestamp: Date.now(),
        }
        return
      default:
        void context
        return
    }
  }
}

function* translateStreamEvent(
  message: SDKMessage,
  state: AcpAdapterState,
): Generator<AcpSessionUpdate, void, unknown> {
  const parentToolCallId = getParentToolCallId(message)
  const event = (
    message as {
      event?: {
        type?: string
        index?: number
        content_block?: { type?: string; id?: string; name?: string; input?: unknown }
        delta?: { type?: string; text?: string; partial_json?: string }
      }
    }
  ).event
  if (
    event?.type === 'content_block_delta' &&
    event.delta?.type === 'text_delta' &&
    typeof event.delta.text === 'string' &&
    event.delta.text.length > 0
  ) {
    state.streamedText = true
    yield {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: event.delta.text },
    }
  }

  if (
    event?.type === 'content_block_start' &&
    typeof event.index === 'number' &&
    event.content_block?.type === 'tool_use' &&
    typeof event.content_block.id === 'string' &&
    typeof event.content_block.name === 'string'
  ) {
    const tool: StreamingToolCall = {
      toolCallId: event.content_block.id,
      toolName: event.content_block.name,
      partialJson: '',
      ...(parentToolCallId ? { parentToolCallId } : {}),
    }
    state.activeToolBlocks.set(event.index, tool)
    state.emittedToolCalls.add(tool.toolCallId)
    state.toolCallNames.set(tool.toolCallId, tool.toolName)
    yield {
      sessionUpdate: 'tool_call',
      toolCallId: tool.toolCallId,
      title: tool.toolName,
      kind: 'function',
      status: 'in_progress',
      input: toRecordInput(event.content_block.input),
      ...(tool.parentToolCallId ? { parentToolCallId: tool.parentToolCallId } : {}),
    }
    return
  }

  if (
    event?.type === 'content_block_delta' &&
    typeof event.index === 'number' &&
    event.delta?.type === 'input_json_delta' &&
    typeof event.delta.partial_json === 'string'
  ) {
    const tool = state.activeToolBlocks.get(event.index)
    if (!tool) return
    tool.partialJson += event.delta.partial_json
    yield {
      sessionUpdate: 'tool_call_update',
      toolCallId: tool.toolCallId,
      status: 'in_progress',
      input: parseJsonOrText(tool.partialJson),
      ...(tool.parentToolCallId ? { parentToolCallId: tool.parentToolCallId } : {}),
    }
    return
  }

  if (event?.type === 'content_block_stop' && typeof event.index === 'number') {
    const tool = state.activeToolBlocks.get(event.index)
    if (!tool) return
    state.activeToolBlocks.delete(event.index)
    if (tool.partialJson.length > 0) {
      yield {
        sessionUpdate: 'tool_call_update',
        toolCallId: tool.toolCallId,
        status: 'in_progress',
        input: parseJsonOrText(tool.partialJson),
        ...(tool.parentToolCallId ? { parentToolCallId: tool.parentToolCallId } : {}),
      }
    }
  }
}

function* translateAssistantMessage(
  message: SDKMessage,
  state: AcpAdapterState,
  dedupeAssistantText: boolean,
): Generator<AcpSessionUpdate, void, unknown> {
  const content = (message as { message?: { content?: unknown[] } }).message?.content ?? []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (
      block.type === 'text' &&
      typeof block.text === 'string' &&
      block.text.length > 0 &&
      (!dedupeAssistantText || !state.streamedText)
    ) {
      yield {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: block.text },
      }
      continue
    }
    if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      state.toolCallNames.set(block.id, block.name)
      const input = isRecord(block.input) ? block.input : (block.input ?? {})
      if (state.emittedToolCalls.has(block.id)) {
        yield {
          sessionUpdate: 'tool_call_update',
          toolCallId: block.id,
          status: 'in_progress',
          input,
        }
      } else {
        state.emittedToolCalls.add(block.id)
        yield {
          sessionUpdate: 'tool_call',
          toolCallId: block.id,
          title: block.name,
          kind: 'function',
          status: 'in_progress',
          input,
        }
      }
    }
  }
}

function* translateUserMessage(
  message: SDKMessage,
  context: StreamAdapterContext,
  state: AcpAdapterState,
): Generator<AcpSessionUpdate, void, unknown> {
  const content = (message as { message?: { content?: unknown[] } }).message?.content
  if (!Array.isArray(content)) return

  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
    const output = block.content ?? null
    const reasonText = extractTextContent(output)
    const interrupt = reasonText ? parseInterruptSignal(reasonText) : null
    if (interrupt) {
      yield {
        sessionUpdate: 'tool_confirm',
        toolCallId: interrupt.toolUseId,
        assistantMessageId: context.turnId,
        toolName: interrupt.toolName,
        input: toRecordInput(interrupt.toolInput),
      }
      continue
    }

    const clientSignal = reasonText ? parseClientToolSignal(reasonText) : null
    if (clientSignal) {
      yield {
        sessionUpdate: 'tool_confirm',
        toolCallId: clientSignal.toolUseId,
        assistantMessageId: context.turnId,
        toolName: clientSignal.toolName,
        input: toRecordInput(clientSignal.toolInput),
      }
      continue
    }

    const askUserSignal = reasonText ? parseAskUserSignal(reasonText) : null
    if (askUserSignal) {
      yield {
        sessionUpdate: 'ask_user',
        toolCallId: askUserSignal.toolUseId,
        assistantMessageId: context.turnId,
        questions: [
          {
            question: askUserSignal.question,
            header: 'Agent asks a question',
            options: (askUserSignal.options ?? []).map((option) => ({ label: option, description: '' })),
            multiSelect: false,
          },
        ],
      }
      continue
    }

    const isError = Boolean(block.is_error)
    yield {
      sessionUpdate: 'tool_call_update',
      toolCallId: block.tool_use_id,
      status: isError ? 'failed' : 'completed',
      result: output,
      ...(isError ? { error: { message: stringifyToolResult(output) } } : {}),
    }
    state.toolCallNames.delete(block.tool_use_id)
  }
}

function getParentToolCallId(message: SDKMessage): string | undefined {
  const parent = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id
  return typeof parent === 'string' && parent.length > 0 ? parent : undefined
}

function parseJsonOrText(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function toRecordInput(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (value === undefined || value === null) return {}
  return { value }
}

function extractTextContent(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null

  for (const part of content) {
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
      return part.text
    }
  }
  return null
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
