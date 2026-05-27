/**
 * CloudBaseSessionStore: 实现 Claude Agent SDK 的 SessionStore 接口。
 *
 * 职责：
 *   - SDK 协议层适配（key/entries 形状由 SDK 定义）
 *   - 桥接到 SessionStoreDriver（与具体后端解耦）
 *   - 在 append 内部用 SDK 的 foldSessionSummary 增量维护 summary
 *   - 可选：把 SDK 派生的 projectKey 重映射为业务标识（推荐 envId）
 *
 * 设计要点：
 *   1. **append-only**：从不改写、从不重排（与 SDK 协议要求一致）
 *   2. **uuid 幂等**：SDK 重试 / replay 时不会产生重复条目（driver 层保证）
 *   3. **summary 同步维护**：foldSessionSummary 在 append 内部即时计算
 *   4. **不感知压缩**：压缩 entry（subtype: compact_boundary）透明转储
 *
 * 关于 projectKey 映射（生产部署强烈建议传）：
 *   Claude Agent SDK 内部用 cwd 派生 SessionKey.projectKey（"sanitized cwd"）。
 *   在 server-side 部署里这有两个真实问题：
 *     - 多环境 cwd 漂移：本地 dev 与生产容器 cwd 不一致 → 同 sessionId
 *       在不同 projectKey 下，跨节点 resume 断裂
 *     - 多租户混淆：同一进程服务多个 envId 时，所有租户共享同一 cwd
 *       → projectKey 全部相同，多租户隔离失效
 *
 *   解决方案：构造时传 `projectKey: envId`，所有 store 操作把 key.projectKey
 *   替换为这个固定值。本地单机开发场景可不传（保持 SDK 默认行为）。
 */

import {
  foldSessionSummary,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
  type SessionSummaryEntry,
} from '@anthropic-ai/claude-agent-sdk'

import { InMemoryDriver } from './drivers/in-memory-driver.js'
import type { SessionStoreDriver } from './drivers/types.js'

export interface CloudBaseSessionStoreOptions {
  /**
   * 存储驱动。不传则使用内置 InMemoryDriver（适合测试 / 本地 demo）。
   *
   * 生产环境应注入 CloudBaseDbDriver：
   *   ```ts
   *   import { CloudBaseDbDriver, CloudBaseSessionStore } from '@cloudbase/open-agent-kernel'
   *   const store = new CloudBaseSessionStore({
   *     driver: new CloudBaseDbDriver(),
   *     projectKey: envId,
   *   })
   *   ```
   */
  driver?: SessionStoreDriver

  /**
   * 把 SDK 派生的 projectKey 重映射为这个固定值（推荐传 envId）。
   *
   * - 不传：透传 SDK 派生的 "sanitized cwd"（适合本地单机开发，跨节点会断）
   * - 传：所有 store 操作的 key.projectKey 替换为这个值（生产环境强烈建议）
   */
  projectKey?: string
}

export class CloudBaseSessionStore implements SessionStore {
  private readonly driver: SessionStoreDriver
  private readonly fixedProjectKey?: string
  /** sessionKeyString → 上一次 fold 后的 summary（缓存） */
  private readonly summaryCache = new Map<string, SessionSummaryEntry>()

  constructor(opts: CloudBaseSessionStoreOptions = {}) {
    this.driver = opts.driver ?? new InMemoryDriver()
    this.fixedProjectKey = opts.projectKey
  }

  /** 暴露底层 driver（高阶用户可绕过 SDK 直接操作） */
  getDriver(): SessionStoreDriver {
    return this.driver
  }

  /** 把 SDK 传入的 SessionKey 替换 projectKey 字段（如已配置 fixedProjectKey） */
  private mapKey(key: SessionKey): SessionKey {
    if (this.fixedProjectKey === undefined) return key
    return { ...key, projectKey: this.fixedProjectKey }
  }

  /** 同上，但用于只接收 projectKey 字符串的 SDK 接口 */
  private mapProjectKey(projectKey: string): string {
    return this.fixedProjectKey ?? projectKey
  }

  // ─── SDK SessionStore 接口实现 ─────────────────────────────────

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return

    const mapped = this.mapKey(key)

    // 1. 落盘
    await this.driver.appendEntries(mapped, entries)

    // 2. 增量维护 summary（仅主 transcript 需要 summary）
    if (mapped.subpath !== undefined) return

    const cacheKey = `${mapped.projectKey}|${mapped.sessionId}`
    const prev = this.summaryCache.get(cacheKey)
    const now = Date.now()

    const folded = foldSessionSummary(prev, mapped, entries, undefined)
    if (folded === undefined) return

    const summary: SessionSummaryEntry = { ...folded, mtime: now }
    this.summaryCache.set(cacheKey, summary)
    await this.driver.upsertSummary({
      projectKey: mapped.projectKey,
      sessionId: mapped.sessionId,
      mtime: summary.mtime,
      data: summary.data,
    })
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return this.driver.loadEntries(this.mapKey(key))
  }

  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    return this.driver.listSessions(this.mapProjectKey(projectKey))
  }

  async listSessionSummaries(projectKey: string): Promise<SessionSummaryEntry[]> {
    return this.driver.listSummaries(this.mapProjectKey(projectKey))
  }

  async delete(key: SessionKey): Promise<void> {
    const mapped = this.mapKey(key)
    await this.driver.deleteSession(mapped)
    this.summaryCache.delete(`${mapped.projectKey}|${mapped.sessionId}`)
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    return this.driver.listSubkeys({
      projectKey: this.mapProjectKey(key.projectKey),
      sessionId: key.sessionId,
    })
  }
}
