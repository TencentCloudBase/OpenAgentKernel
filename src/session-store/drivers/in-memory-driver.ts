/**
 * InMemoryDriver: 测试 / 开发期使用的 SessionStoreDriver 实现。
 *
 * - 进程退出即丢失数据（不适合生产）
 * - 严格遵守 uuid 幂等语义
 * - 按写入顺序保留 entries（不重排）
 * - 与 CloudBaseDbDriver 暴露完全相同的接口（替换零成本）
 *
 * 用途：
 *   - 单元测试
 *   - 不依赖 CloudBase 凭证的本地 demo（PR #4 quickstart）
 *   - 故障兜底（CloudBase DB 不可用时降级使用，未来 v0.2+ 接入）
 */

import type { SessionKey, SessionStoreEntry, SessionSummaryEntry } from '@anthropic-ai/claude-agent-sdk'
import { encodeSessionKey, type SessionStoreDriver } from './types.js'

interface SessionRecord {
  projectKey: string
  sessionId: string
  subpath?: string
  /** entries，按写入顺序 */
  entries: SessionStoreEntry[]
  /** 已写入过的 entry uuid 集合（幂等键） */
  uuidSet: Set<string>
  /** 最近一次 append 的 mtime（毫秒） */
  mtime: number
}

interface SummaryRecord {
  projectKey: string
  sessionId: string
  mtime: number
  data: Record<string, unknown>
}

export class InMemoryDriver implements SessionStoreDriver {
  /** sessionKeyString → SessionRecord */
  private readonly sessions = new Map<string, SessionRecord>()
  /** projectKey + sessionId → SummaryRecord（仅主 transcript 需要 summary） */
  private readonly summaries = new Map<string, SummaryRecord>()

  async appendEntries(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const sk = encodeSessionKey(key)
    let record = this.sessions.get(sk)
    if (!record) {
      record = {
        projectKey: key.projectKey,
        sessionId: key.sessionId,
        subpath: key.subpath,
        entries: [],
        uuidSet: new Set(),
        mtime: Date.now(),
      }
      this.sessions.set(sk, record)
    }

    for (const entry of entries) {
      const uuid = typeof entry.uuid === 'string' ? entry.uuid : undefined
      if (uuid !== undefined) {
        if (record.uuidSet.has(uuid)) {
          continue // 幂等：已存在则跳过
        }
        record.uuidSet.add(uuid)
      }
      record.entries.push(entry)
    }
    record.mtime = Date.now()
  }

  async loadEntries(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const record = this.sessions.get(encodeSessionKey(key))
    if (!record) return null
    // 返回拷贝，防止上游修改污染存储
    return record.entries.map((e) => ({ ...e }))
  }

  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    const result: Array<{ sessionId: string; mtime: number }> = []
    for (const record of this.sessions.values()) {
      // 仅主 transcript（subpath 为空）算一个 session
      if (record.projectKey === projectKey && record.subpath === undefined) {
        result.push({ sessionId: record.sessionId, mtime: record.mtime })
      }
    }
    return result
  }

  async listSummaries(projectKey: string): Promise<SessionSummaryEntry[]> {
    const result: SessionSummaryEntry[] = []
    for (const record of this.summaries.values()) {
      if (record.projectKey === projectKey) {
        result.push({
          sessionId: record.sessionId,
          mtime: record.mtime,
          data: record.data,
        })
      }
    }
    return result
  }

  async upsertSummary(args: {
    projectKey: string
    sessionId: string
    mtime: number
    data: Record<string, unknown>
  }): Promise<void> {
    const k = `${args.projectKey}|${args.sessionId}`
    this.summaries.set(k, { ...args })
  }

  async deleteSession(key: SessionKey): Promise<void> {
    // 删除主 transcript + 所有 subpath
    const prefix = `${key.projectKey}|${key.sessionId}`
    for (const sk of Array.from(this.sessions.keys())) {
      if (sk === prefix || sk.startsWith(`${prefix}|`)) {
        this.sessions.delete(sk)
      }
    }
    this.summaries.delete(prefix)
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    const prefix = `${key.projectKey}|${key.sessionId}|`
    const subkeys: string[] = []
    for (const sk of this.sessions.keys()) {
      if (sk.startsWith(prefix)) {
        subkeys.push(sk.slice(prefix.length))
      }
    }
    return subkeys
  }

  // ─── Test helpers ──────────────────────────────────────────────

  /** 测试用：清空所有数据 */
  clearAll(): void {
    this.sessions.clear()
    this.summaries.clear()
  }

  /** 测试用：返回某 session 的 entries 数（不存在返回 0） */
  countEntries(key: SessionKey): number {
    return this.sessions.get(encodeSessionKey(key))?.entries.length ?? 0
  }

  /** 测试用：返回 store 中出现过的所有 projectKey（用于诊断） */
  listProjectKeys(): string[] {
    const keys = new Set<string>()
    for (const record of this.sessions.values()) {
      keys.add(record.projectKey)
    }
    return Array.from(keys)
  }
}
