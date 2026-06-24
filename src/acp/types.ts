/**
 * Self-contained ACP session/update types exposed by OAK.
 *
 * The shape intentionally mirrors OpenVibeCoding's ExtendedSessionUpdate,
 * but this package does not depend on the monorepo shared package at runtime.
 */

export interface AcpTextBlock {
  type: 'text'
  text: string
}

export interface AgentMessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk'
  content: AcpTextBlock
}

export interface AgentThoughtChunkUpdate {
  sessionUpdate: 'agent_thought_chunk'
  content: string
}

export interface ToolCallUpdate {
  sessionUpdate: 'tool_call'
  toolCallId: string
  title: string
  kind: 'function' | 'other'
  status: 'in_progress' | 'completed' | 'failed'
  input?: unknown
  parentToolCallId?: string
}

export interface ToolCallStatusUpdate {
  sessionUpdate: 'tool_call_update'
  toolCallId: string
  status: 'in_progress' | 'completed' | 'failed'
  result?: unknown
  input?: unknown
  error?: { message: string }
  parentToolCallId?: string
}

export interface AvailableCommandsUpdate {
  sessionUpdate: 'available_commands_update'
  availableCommands: Array<{
    name: string
    description: string
    _meta?: Record<string, unknown>
  }>
}

export interface LogUpdate {
  sessionUpdate: 'log'
  level: 'info' | 'error' | 'success' | 'command'
  message: string
  timestamp: number
}

export interface TaskProgressUpdate {
  sessionUpdate: 'task_progress'
  progress: number
  status: 'pending' | 'processing' | 'completed' | 'error' | 'stopped'
}

export interface FileChangeUpdate {
  sessionUpdate: 'file_change'
  filename: string
  action: 'add' | 'modify' | 'delete'
}

export interface ThinkingUpdate {
  sessionUpdate: 'thinking'
  content: string
}

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

export interface ToolConfirmUpdate {
  sessionUpdate: 'tool_confirm'
  toolCallId: string
  assistantMessageId: string
  toolName: string
  input: Record<string, unknown>
  planContent?: string
}

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

export type AgentPhaseName = 'preparing' | 'model_responding' | 'tool_executing' | 'compacting' | 'idle'

export interface AgentPhaseUpdate {
  sessionUpdate: 'agent_phase'
  phase: AgentPhaseName
  toolName?: string
  timestamp: number
}

export type AcpSessionUpdate =
  | AgentMessageChunkUpdate
  | AgentThoughtChunkUpdate
  | ToolCallUpdate
  | ToolCallStatusUpdate
  | AvailableCommandsUpdate
  | LogUpdate
  | TaskProgressUpdate
  | FileChangeUpdate
  | ThinkingUpdate
  | AskUserUpdate
  | ToolConfirmUpdate
  | ArtifactUpdate
  | HistoryPageUpdate
  | AgentPhaseUpdate
