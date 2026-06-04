/**
 * Permissions 模块公共导出（PR #7.0 + PR #7.1）。
 */

export {
  InMemoryPermissionStore,
  InMemoryClientToolStore,
  InMemoryAskUserStore,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  compileRequireApprovalPredicate,
  isStaleApproval,
} from './store.js'

export {
  OAK_INTERRUPT_SENTINEL,
  OAK_CLIENT_TOOL_SENTINEL,
  OAK_ASK_USER_SENTINEL,
  OAK_CLIENT_TOOL_RESULT_KEY,
  isInterruptSignal,
  parseInterruptSignal,
  parseClientToolSignal,
  parseAskUserSignal,
  createPreToolUsePermissionHook,
  createHookLocalState,
  type InterruptSignalPayload,
  type ClientToolSignalPayload,
  type ClientToolResultStore,
  type PendingClientToolResult,
  type AskUserStore,
  type PendingAskUserEntry,
  type AskUserSignalPayload,
  type PreToolUseHookLocalState,
} from './hooks.js'

// PR #7.1：分布式 PermissionStore（CloudBase DB driver）
export { CloudBasePermissionStore, type CloudBasePermissionStoreOptions } from './cloudbase-permission-store.js'

export type { PermissionStoreDriver } from './drivers/types.js'

export { InMemoryPermissionDriver } from './drivers/in-memory-driver.js'

export {
  CloudBaseDbPermissionDriver,
  type CloudBaseDbPermissionDriverOptions,
  type CloudBasePermissionCredentials,
} from './drivers/cloudbase-db-driver.js'

// PR #7.1：分布式 ClientToolResultStore（CloudBase DB driver）
export { CloudBaseClientToolStore, type CloudBaseClientToolStoreOptions } from './cloudbase-client-tool-store.js'

export type { ClientToolResultStoreDriver } from './drivers/types.js'

export {
  CloudBaseDbClientToolDriver,
  type CloudBaseDbClientToolDriverOptions,
  type CloudBaseClientToolCredentials,
} from './drivers/cloudbase-client-tool-driver'
