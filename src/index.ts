/**
 * @cloudbase/open-agent-kernel
 *
 * Server-side agentic agent SDK for CloudBase platform developers.
 * Built on top of @anthropic-ai/claude-agent-sdk (Anthropic Agent SDK)
 * with first-class CloudBase resources integration (envId-anchored).
 *
 * @packageDocumentation
 */

// 公共 API：唯一的入口点
export { createAgent } from './public/create-agent.js'
export { AcpStreamAdapter } from './adapters/index.js'

export type { AcpStreamAdapterOptions, StreamAdapter, StreamAdapterContext } from './adapters/index.js'
export type {
  // Top-level union
  AcpSessionUpdate,
  // JSON-RPC stream messages
  AcpStreamMessage,
  JsonRpcNotification,
  JsonRpcRequestMessage,
  // OAK convenience alias
  AcpTextBlock,
  // OAK _meta extension namespace
  OakMeta,
  // Standard ACP types (re-exported from @agentclientprotocol/sdk)
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
  // OAK extension variants
  LogUpdate,
  ArtifactUpdate,
  HistoryPageUpdate,
  AgentPhaseUpdate,
  RequestPermissionUpdate,
  AskUserUpdate,
  // OAK history types
  HistoryMessage,
  HistoryMessagePart,
  HistoryMessagePartToolCall,
  HistoryMessagePartToolResult,
  AgentPhaseName,
} from './acp/index.js'

// 公共类型：完整对外契约
export type {
  // Agent / Session
  Agent,
  Session,
  SessionStartOptions,
  SessionManagement,
  SessionSummary,
  // 输入 / 事件
  SessionInput,
  MessageRecord,
  MessagePart,
  AttachmentInput,
  // 配置
  AgentConfig,
  PlatformCredentials,
  ModelInput,
  ModelSpec,
  SandboxConfig,
  SandboxCapabilities,
  SandboxUserCredentials,
  ToolDefinition,
  ToolContext,
  McpServerConfig,
  PermissionConfig,
  ApprovalDecision,
  PermissionStore,
  PendingApproval,
  RequireApprovalRule,
  SessionConfig,
  SessionStoreProvider,
  CloudBaseSessionDatabase,
  CloudBaseStorageConfig,
  CustomStorageProvider,
  StorageConfig,
  UserMemoryConfig,
  // Hooks
  AgentHooks,
  UserMessageContext,
  ToolStartContext,
  ToolEndContext,
  AgentMessageContext,
  SessionContext,
} from './public/types.js'

// Session store：可选用于持久化和跨节点 resume
export {
  CloudBaseSessionStore,
  type CloudBaseSessionStoreOptions,
  InMemoryDriver,
  CloudBaseDbDriver,
  type CloudBaseDbDriverOptions,
  type CloudBaseCredentials,
  type SessionStoreDriver,
  type SessionMessageMeta,
  encodeSessionKey,
} from './session-store/index.js'

// Storage：可选用于多模态附件（图片等）
export {
  InMemoryStorage,
  CloudBaseStorage,
  type CloudBaseStorageOptions,
  type CloudBaseStorageCredentials,
  type StorageProvider,
  type ResolvedAttachment,
  type ResolveContext,
  type ImageSource,
} from './storage/index.js'

// User memory：用户级长期记忆文件管理
export {
  writeUserMemoryFiles,
  deleteUserMemoryFiles,
  type UserMemoryFile,
  type UserMemoryFilesOptions,
  type WriteUserMemoryFilesOptions,
  type DeleteUserMemoryFilesOptions,
} from './user-memory/index.js'

// Sandbox：可选用于让 agent 通过 local/AGS runtime 跑文件系统/shell
//   - provider='ags-stateful'（默认）：腾讯云 AGS Agent Sandbox + TRW 远程数据面
//   - provider='local'：宿主进程本地 FS + Claude SDK 内置工具（过渡方案）
export {
  AgsStatefulSandbox,
  type AgsStatefulSandboxOptions,
  LocalRuntimeSandbox,
  type LocalRuntimeSandboxOptions,
  createCloudBaseMcpServerInProcess,
  type CreateCloudBaseMcpInProcessOptions,
  type SandboxRuntime,
  type SandboxInstance,
  type SandboxAcquireContext,
} from './sandbox/index.js'

// Permissions / HITL（PR #7.0 + PR #7.1）
export {
  // PR #7.0
  InMemoryPermissionStore,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  // PR #7.1：分布式 PermissionStore
  CloudBasePermissionStore,
  type CloudBasePermissionStoreOptions,
  InMemoryPermissionDriver,
  CloudBaseDbPermissionDriver,
  type CloudBaseDbPermissionDriverOptions,
  type CloudBasePermissionCredentials,
  type PermissionStoreDriver,
} from './permissions/index.js'

// 错误类型
export {
  KernelError,
  NotImplementedError,
  InvalidConfigError,
  ResourceError,
  StorageError,
  SandboxError,
} from './internal/errors.js'

import { PACKAGE_VERSION } from './version.js'

/** SDK 版本号 */
export const VERSION = PACKAGE_VERSION
