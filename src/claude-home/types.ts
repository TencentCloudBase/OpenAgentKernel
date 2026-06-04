/**
 * ClaudeHomeSyncStore: SDK 原生 .claude/ 目录与远端存储的同步抽象(internal)。
 *
 * 不在公共 API 暴露(internal-only) — 业务方只看到 `userMemory.enabled`,
 * 内部抽象保留供测试替换 + 未来扩展(OSS / S3 等)。
 *
 * Spec A §4.4。
 */

/**
 * 命名空间上下文。SDK 内部用 (envId, userId) 派生 COS key prefix。
 * 不允许 agent 通过 prompt 改变(由 sync engine 闭包注入)。
 */
export interface ClaudeHomeContext {
  envId: string
  userId: string
}

/**
 * 相对路径(以 / 分隔,无 leading /),相对于 CLAUDE_CONFIG_DIR 根。
 * 例:`CLAUDE.md` / `projects/abc/memory/MEMORY.md`。
 */
export type RelativePath = string

/**
 * 同步存储的最小协议。
 *
 * MVP 流程(spec §4.3):
 *   pullOnSendStart:
 *     - 调用 store.pull → 把远端对象拉到 localDir,返回 { relPath → sha256 } baseline
 *   pushOnSendEnd:
 *     - walk localDir 算 currentMap
 *     - diff baseline vs currentMap → 调 store.put 推变更 + store.delete 反向删除
 */
export interface ClaudeHomeSyncStore {
  /**
   * 列出 (envId, userId) namespace 下所有对象,把内容拉到 localDir,
   * 同时返回每个对象的 sha256 作为 baseline。
   *
   * - namespace 不存在(首次访问)→ 返回空 Map(不抛错)
   * - 网络/凭证错误 → 抛 Error(由 sync-engine 捕获并 graceful degrade)
   * - 远端文件不在 SYNC_INCLUDES 内 → 仍然拉下来(避免历史数据丢失;
   *   下次 push 时若仍未变化也不会被反向删除,因为反向删除只看 baseline diff)
   */
  pull(ctx: ClaudeHomeContext, localDir: string): Promise<Map<RelativePath, string>>

  /**
   * 覆盖式上传一个文件(整体 PUT)。不存在则创建。
   *
   * 不带 If-Match 等乐观锁 — MVP 假设业务方上游保证同 user 请求串行。
   */
  put(ctx: ClaudeHomeContext, relPath: RelativePath, content: Buffer): Promise<void>

  /**
   * 删除一个对象。不存在时静默(返回 ok,不抛错)。
   */
  delete(ctx: ClaudeHomeContext, relPath: RelativePath): Promise<void>
}
