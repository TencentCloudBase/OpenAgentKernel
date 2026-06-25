/**
 * ACP session/update types exposed by OAK.
 *
 * Built on top of the standard ACP {@link SessionUpdate} from
 * `@agentclientprotocol/sdk`. Standard variants are re-exported as-is; OAK
 * extensions are defined below for capabilities the spec does not cover:
 *
 * - `log` / `artifact` / `history_page` / `agent_phase` — OAK-specific
 *   notifications with no standard equivalent.
 * - `request_permission` — OAK's stop-and-resume adaptation of the standard
 *   `session/request_permission` JSON-RPC request. Serverless deployments have
 *   no session affinity to hold a reverse-RPC channel open, so the payload is
 *   delivered as a `session/update` notification and the turn ends with
 *   `stopReason: 'awaiting_permission'`. The client resumes via a new
 *   `session/prompt` POST carrying the selected `optionId`. The payload shape
 *   mirrors {@link RequestPermissionRequest} so a standard ACP client can
 *   consume it directly.
 * - `ask_user` — OAK's AskUserQuestion flow (stop-and-resume, same reason as
 *   `request_permission`).
 *
 * OAK-specific data on standard variants (e.g. `parentToolCallId`) is carried
 * in `_meta.oak.*`, per the ACP extensibility convention.
 */

import type {
  SessionUpdate,
  ToolCall,
  ToolCallUpdate,
  ToolKind,
  ToolCallStatus,
  ToolCallLocation,
  ToolCallContent,
  ContentChunk,
  ContentBlock,
  TextContent,
  Plan,
  PlanEntry,
  PlanUpdate,
  PlanRemoved,
  UsageUpdate,
  AvailableCommandsUpdate,
  AvailableCommand,
  CurrentModeUpdate,
  ConfigOptionUpdate,
  SessionInfoUpdate,
  PermissionOption,
  PermissionOptionKind,
  PermissionOptionId,
  RequestPermissionRequest,
  RequestPermissionOutcome,
  SelectedPermissionOutcome,
  Diff,
  Terminal,
  Cost,
  MessageId,
} from '@agentclientprotocol/sdk'

// ── Re-export standard ACP types for consumer convenience ───────────────

export type {
  SessionUpdate,
  ToolCall,
  ToolCallUpdate,
  ToolKind,
  ToolCallStatus,
  ToolCallLocation,
  ToolCallContent,
  ContentChunk,
  ContentBlock,
  TextContent,
  Plan,
  PlanEntry,
  PlanUpdate,
  PlanRemoved,
  UsageUpdate,
  AvailableCommandsUpdate,
  AvailableCommand,
  CurrentModeUpdate,
  ConfigOptionUpdate,
  SessionInfoUpdate,
  PermissionOption,
  PermissionOptionKind,
  PermissionOptionId,
  RequestPermissionRequest,
  RequestPermissionOutcome,
  SelectedPermissionOutcome,
  Diff,
  Terminal,
  Cost,
  MessageId,
}

/**
 * Convenience alias for a text content block — `TextContent & { type: 'text' }`.
 * Useful when constructing `agent_message_chunk` / `agent_thought_chunk`
 * updates that only carry text.
 */
export type AcpTextBlock = TextContent & { type: 'text' }

// ── OAK _meta extension namespace ───────────────────────────────────────
//
// Standard ACP types reserve `_meta` for extensibility. OAK carries its own
// non-standard fields under `_meta.oak.*` so they don't collide with the
// spec and standard clients can ignore them.

export interface OakMeta {
  oak?: {
    /** Parent tool call ID for sub-agent tool chains. */
    parentToolCallId?: string
    /** OAK-internal assistant message id (for SSE correlation). */
    assistantMessageId?: string
    /** ExitPlanMode plan content (Markdown), when the tool is ExitPlanMode. */
    planContent?: string
    [key: string]: unknown
  } | null
  [key: string]: unknown
}

// ── OAK extension: log ──────────────────────────────────────────────────
//
// Standard ACP has no log sessionUpdate. OAK uses this for error/status
// messages that need to surface in the conversation stream (e.g. abort
// reasons, model errors).

export interface LogUpdate {
  sessionUpdate: 'log'
  level: 'info' | 'error' | 'success' | 'command'
  message: string
  timestamp: number
}

// ── OAK extension: artifact ──────────────────────────────────────────────
//
// Standard ACP has no artifact sessionUpdate. OAK uses this to surface
// deployment artifacts (web links, miniprogram QR codes, JSON blobs) to
// the client for dedicated UI treatment.

export interface ArtifactUpdate {
  sessionUpdate: 'artifact'
  artifact: {
    title: string
    description?: string
    contentType: 'image' | 'link' | 'json'
    data: string
    metadata?: Record<string, unknown>
  }
}

// ── OAK extension: history_page ──────────────────────────────────────────
//
// Standard ACP uses `session/load` as a request-response method. OAK's
// stop-and-resume model surfaces history as a session/update notification
// carrying one page of messages, so the client can reuse the same render
// pipeline as live updates.

export interface HistoryMessagePartToolCall {
  type: 'tool_call'
  toolCallId: string
  toolName: string
  input?: unknown
  status?: string
  parentToolCallId?: string
}

export interface HistoryMessagePartToolResult {
  type: 'tool_result'
  toolCallId: string
  toolName?: string
  content: string
  isError?: boolean
  status?: string
  parentToolCallId?: string
}

export type HistoryMessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | HistoryMessagePartToolCall
  | HistoryMessagePartToolResult

export interface HistoryMessage {
  id: string
  taskId: string
  role: 'user' | 'agent'
  content: string
  parts?: HistoryMessagePart[]
  status?: string
  createdAt: number
}

export interface HistoryPageUpdate {
  sessionUpdate: 'history_page'
  messages: HistoryMessage[]
  cursor?: string | null
  nextCursor?: string | null
}

// ── OAK extension: agent_phase ───────────────────────────────────────────
//
// Standard ACP has no phase concept. OAK reports execution-phase transitions
// (preparing / model_responding / tool_executing / compacting / idle) so the
// client can render a status indicator.

export type AgentPhaseName = 'preparing' | 'model_responding' | 'tool_executing' | 'compacting' | 'idle'

export interface AgentPhaseUpdate {
  sessionUpdate: 'agent_phase'
  phase: AgentPhaseName
  toolName?: string
  timestamp: number
}

// ── OAK extension: request_permission (stop-and-resume HITL) ────────────
//
// Mirrors the standard RequestPermissionRequest payload, but delivered as a
// session/update notification (not a JSON-RPC request) because serverless
// deployments cannot hold a reverse-RPC channel open. The turn ends after
// emitting this and the client resumes via a new session/prompt POST.

export interface RequestPermissionUpdate {
  sessionUpdate: 'request_permission'
  sessionId: string
  toolCall: ToolCallUpdate
  options: PermissionOption[]
  _meta?: OakMeta | null
}

// ── OAK extension: ask_user (stop-and-resume AskUserQuestion) ────────────
//
// OAK's AskUserQuestion flow. Same stop-and-resume rationale as
// request_permission. Kept as a separate variant (rather than folded into
// request_permission) because the question/options shape is richer than a
// permission option list.

export interface AskUserUpdate {
  sessionUpdate: 'ask_user'
  toolCallId: string
  assistantMessageId: string
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiSelect: boolean
  }>
}

// ── AcpSessionUpdate: standard SessionUpdate + OAK extensions ────────────
//
// `sessionUpdate` discriminators:
//   standard: user_message_chunk | agent_message_chunk | agent_thought_chunk
//           | tool_call | tool_call_update | plan | plan_update | plan_removed
//           | available_commands_update | current_mode_update
//           | config_option_update | session_info_update | usage_update
//   OAK:      log | artifact | history_page | agent_phase
//           | request_permission | ask_user

export type AcpSessionUpdate =
  | SessionUpdate
  | LogUpdate
  | ArtifactUpdate
  | HistoryPageUpdate
  | AgentPhaseUpdate
  | RequestPermissionUpdate
  | AskUserUpdate
