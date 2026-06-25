import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AcpSessionUpdate, OakMeta, PermissionOption, ToolKind } from '../acp/types.js'
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
        yield* translateResultMessage(message)
        return
      default:
        void context
        return
    }
  }
}

// ── Translation helpers ─────────────────────────────────────────────────

/**
 * Derive the standard ACP {@link ToolKind} from a tool name. Ported from the
 * official @agentclientprotocol/claude-agent-acp `tools.ts` (toolInfoFromToolUse).
 */
function toolKindFromName(toolName: string): ToolKind {
  switch (toolName) {
    case 'Bash':
    case 'bash':
      return 'execute'
    case 'Read':
    case 'read':
      return 'read'
    case 'Write':
    case 'write':
    case 'Edit':
    case 'edit':
    case 'Patch':
    case 'patch':
    case 'ApplyPatch':
      return 'edit'
    case 'Grep':
    case 'grep':
    case 'Glob':
    case 'glob':
      return 'search'
    case 'WebFetch':
    case 'webfetch':
    case 'Fetch':
      return 'fetch'
    case 'Agent':
    case 'Task':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskGet':
    case 'TaskList':
      return 'think'
    default:
      // MCP tools (mcp__*) and other SDK built-ins default to 'other'.
      // Skills / custom tools surface as 'other' too — the title carries
      // enough context for the client to render.
      return 'other'
  }
}

/**
 * Build the `_meta.oak` extension object for parentToolCallId / assistantMessageId.
 * Returns undefined when there's nothing to carry, so the emitted update stays
 * clean for the common (non-subagent, non-HITL) case.
 */
function oakMeta(opts: {
  parentToolCallId?: string | undefined
  assistantMessageId?: string | undefined
  planContent?: string | undefined
}): OakMeta | null {
  const oak: Record<string, unknown> = {}
  if (opts.parentToolCallId) oak.parentToolCallId = opts.parentToolCallId
  if (opts.assistantMessageId) oak.assistantMessageId = opts.assistantMessageId
  if (opts.planContent) oak.planContent = opts.planContent
  if (Object.keys(oak).length === 0) return null
  return { oak }
}

/**
 * Standard permission options for the `request_permission` variant.
 * Matches the optionId/kind conventions used by the official claude-agent-acp
 * wrapper (see acp-agent.ts canUseTool).
 */
function buildPermissionOptions(): PermissionOption[] {
  return [
    { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
  ]
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
        delta?: { type?: string; text?: string; partial_json?: string; thinking?: string }
      }
    }
  ).event

  // text_delta → agent_message_chunk
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

  // thinking_delta → agent_thought_chunk (standard variant, replaces OAK's old 'thinking')
  if (
    event?.type === 'content_block_delta' &&
    event.delta?.type === 'thinking_delta' &&
    typeof event.delta.thinking === 'string' &&
    event.delta.thinking.length > 0
  ) {
    yield {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: event.delta.thinking },
    }
  }

  // content_block_start (tool_use) → tool_call
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
      kind: toolKindFromName(tool.toolName),
      status: 'in_progress',
      rawInput: toRecordInput(event.content_block.input),
      ...(tool.parentToolCallId ? { _meta: oakMeta({ parentToolCallId: tool.parentToolCallId }) ?? undefined } : {}),
    }
    return
  }

  // input_json_delta → tool_call_update (rawInput refinement)
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
      rawInput: parseJsonOrText(tool.partialJson),
      ...(tool.parentToolCallId ? { _meta: oakMeta({ parentToolCallId: tool.parentToolCallId }) ?? undefined } : {}),
    }
    return
  }

  // content_block_stop → finalize tool_call_update (rawInput)
  if (event?.type === 'content_block_stop' && typeof event.index === 'number') {
    const tool = state.activeToolBlocks.get(event.index)
    if (!tool) return
    state.activeToolBlocks.delete(event.index)
    if (tool.partialJson.length > 0) {
      yield {
        sessionUpdate: 'tool_call_update',
        toolCallId: tool.toolCallId,
        status: 'in_progress',
        rawInput: parseJsonOrText(tool.partialJson),
        ...(tool.parentToolCallId ? { _meta: oakMeta({ parentToolCallId: tool.parentToolCallId }) ?? undefined } : {}),
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
  const parentToolCallId = getParentToolCallId(message)
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
      const rawInput = isRecord(block.input) ? block.input : (block.input ?? {})
      if (state.emittedToolCalls.has(block.id)) {
        // Replay after streaming: refine the existing tool_call with rawInput
        yield {
          sessionUpdate: 'tool_call_update',
          toolCallId: block.id,
          status: 'in_progress',
          rawInput,
          ...(parentToolCallId ? { _meta: oakMeta({ parentToolCallId }) ?? undefined } : {}),
        }
      } else {
        state.emittedToolCalls.add(block.id)
        yield {
          sessionUpdate: 'tool_call',
          toolCallId: block.id,
          title: block.name,
          kind: toolKindFromName(block.name),
          status: 'in_progress',
          rawInput,
          ...(parentToolCallId ? { _meta: oakMeta({ parentToolCallId }) ?? undefined } : {}),
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
    const toolName = state.toolCallNames.get(block.tool_use_id) ?? 'unknown'

    // OAK HITL sentinel → request_permission (stop-and-resume)
    const interrupt = reasonText ? parseInterruptSignal(reasonText) : null
    if (interrupt) {
      yield {
        sessionUpdate: 'request_permission',
        sessionId: context.sessionId,
        toolCall: {
          toolCallId: interrupt.toolUseId,
          title: interrupt.toolName,
          kind: toolKindFromName(interrupt.toolName),
          rawInput: toRecordInput(interrupt.toolInput),
        },
        options: buildPermissionOptions(),
        _meta: oakMeta({ assistantMessageId: context.turnId }) ?? undefined,
      }
      continue
    }

    // OAK client-tool sentinel → request_permission (client-side tool flow)
    const clientSignal = reasonText ? parseClientToolSignal(reasonText) : null
    if (clientSignal) {
      yield {
        sessionUpdate: 'request_permission',
        sessionId: context.sessionId,
        toolCall: {
          toolCallId: clientSignal.toolUseId,
          title: clientSignal.toolName,
          kind: toolKindFromName(clientSignal.toolName),
          rawInput: toRecordInput(clientSignal.toolInput),
        },
        options: buildPermissionOptions(),
        _meta: oakMeta({ assistantMessageId: context.turnId }) ?? undefined,
      }
      continue
    }

    // OAK askUser sentinel → ask_user (OAK extension)
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

    // Normal tool_result → tool_call_update with rawOutput
    const isError = Boolean(block.is_error)
    const resultText = stringifyToolResult(output)
    yield {
      sessionUpdate: 'tool_call_update',
      toolCallId: block.tool_use_id,
      status: isError ? 'failed' : 'completed',
      rawOutput: output,
      ...(isError
        ? {
            content: [
              {
                type: 'content' as const,
                content: { type: 'text' as const, text: resultText },
              },
            ],
          }
        : {}),
    }
    state.toolCallNames.delete(block.tool_use_id)
  }
}

function* translateResultMessage(message: SDKMessage): Generator<AcpSessionUpdate, void, unknown> {
  // Emit usage_update (standard) when the SDK result carries token usage.
  const usage = (message as { usage?: { input_tokens?: number; output_tokens?: number } }).usage
  if (usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number') {
    const used = usage.input_tokens + usage.output_tokens
    yield {
      sessionUpdate: 'usage_update',
      used,
      // size unknown without the model context window; report 0 so clients
      // treat it as "unbounded" rather than mis-rendering a full bar.
      size: 0,
    }
  }
  // Signal turn end. Standard ACP has no 'agent_phase' sessionUpdate; this is
  // an OAK extension that the client uses to clear its streaming indicator.
  yield {
    sessionUpdate: 'agent_phase',
    phase: 'idle',
    timestamp: Date.now(),
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
