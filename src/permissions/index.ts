/**
 * Permissions 模块公共导出（PR #7.0 + PR #7.1）。
 */

export {
  InMemoryPermissionStore,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  compileRequireApprovalPredicate,
  isStaleApproval,
} from './store.js'

export {
  OAK_INTERRUPT_SENTINEL,
  isInterruptSignal,
  parseInterruptSignal,
  createPreToolUsePermissionHook,
  createHookLocalState,
  type InterruptSignalPayload,
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
