import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AcpSessionUpdate } from '../acp/types.js'
import type { StreamAdapter, StreamAdapterContext } from './types.js'

interface AcpAdapterState {
  toolCallNames: Map<string, string>
  streamedText: boolean
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
        yield* translateUserMessage(message, state)
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
  const event = (message as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event
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
      yield {
        sessionUpdate: 'tool_call',
        toolCallId: block.id,
        title: block.name,
        kind: 'function',
        status: 'in_progress',
        input: isRecord(block.input) ? block.input : (block.input ?? {}),
      }
    }
  }
}

function* translateUserMessage(
  message: SDKMessage,
  state: AcpAdapterState,
): Generator<AcpSessionUpdate, void, unknown> {
  const content = (message as { message?: { content?: unknown[] } }).message?.content
  if (!Array.isArray(content)) return

  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
    const output = block.content ?? null
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
