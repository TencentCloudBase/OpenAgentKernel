/**
 * Internal facade for src/claude-home/.
 *
 * 不被 src/index.ts re-export — 业务方只看到 AgentConfig.userMemory.enabled。
 * 内部模块(agent-builder / create-agent)从这里 import。
 */

export {
  deriveClaudeConfigDir,
  deriveAgentConfigDir,
  deriveSyncTmpDir,
  resolveWorkRoot,
  getOakRoot,
  sanitizePathSegment,
  OAK_ROOT_SEGMENT,
} from './path-derivation.js'
export { matchesSyncRule, SYNC_INCLUDES } from './sync-rules.js'
export { matchesCwdSyncRule, shouldPruneCwdDir, DEFAULT_CWD_EXCLUDES } from './workspace-cwd-rules.js'
export {
  WorkspaceCwdArchiveEngine,
  createWorkspaceCwdArchiveEngine,
  cwdArchiveKeyPrefix,
  type WorkspaceCwdArchiveEngineOptions,
} from './workspace-cwd-archive-engine.js'
export { sha256OfBuffer, sha256OfFile } from './dedup.js'
export { ClaudeHomeSyncEngine, type ClaudeHomeSyncEngineOptions } from './sync-engine.js'
export { InMemoryClaudeHomeStore } from './in-memory-store.js'
export {
  CloudBaseCosClaudeHomeStore,
  type CloudBaseCosCredentials,
  type CloudBaseCosClaudeHomeStoreOptions,
  type CosKeyPrefixFn,
} from './cloudbase-cos-store.js'
export type { ClaudeHomeSyncStore, ClaudeHomeContext, RelativePath } from './types.js'
