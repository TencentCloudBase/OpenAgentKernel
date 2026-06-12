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
  SessionEvent,
  MessageRecord,
  MessagePart,
  AttachmentInput,
  // 配置
  AgentConfig,
  ResourceConfig,
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

// Sandbox：可选用于让 agent 在远程容器里跑文件系统/shell（PR #6A）
export {
  AgsStatefulSandbox,
  type AgsStatefulSandboxOptions,
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

/** SDK 版本号 */
export const VERSION = '0.2.0-alpha.0'
