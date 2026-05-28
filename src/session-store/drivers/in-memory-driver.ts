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
import { encodeSessionKey, type SessionStoreDriver, type SessionMessageMeta } from './types.js'

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
  /** sessionKeyString → SessionMessageMeta[]（PR #4.6：会话消息元数据） */
  private readonly sessionMessages = new Map<string, SessionMessageMeta[]>()

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
    // 删除会话消息元数据
    this.sessionMessages.delete(prefix)
  }

  async appendSessionMessage(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const sk = encodeSessionKey(key)
    const now = Date.now()

    // 从 entries 中提取 assistant/user 类型的 SDKMessage
    for (const entry of entries) {
      try {
        // entry 本身就是 SessionStoreEntry 对象（包含 type, message, uuid, timestamp 等）
        const sdkMsg = entry
        if (!sdkMsg || typeof sdkMsg !== 'object') {
          continue
        }
        // 只处理 assistant 和 user 类型的消息
        if (sdkMsg.type !== 'assistant' && sdkMsg.type !== 'user') {
          continue
        }

        // 提取关键标识
        const messageId = (sdkMsg as any).message?.id || entry.uuid
        if (!messageId) {
          continue
        }

        // 幂等检查：已存在则跳过
        const existingMessages = this.sessionMessages.get(sk) || []
        if (existingMessages.some((m) => m.messageId === messageId)) {
          continue
        }

        // 提取 role
        const role = sdkMsg.type as 'user' | 'assistant'

        // 提取 createdAt（确保是数字格式：毫秒时间戳）
        let createdAt: number
        if (typeof sdkMsg.timestamp === 'string') {
          createdAt = new Date(sdkMsg.timestamp).getTime()
        } else if (typeof sdkMsg.timestamp === 'number') {
          createdAt = sdkMsg.timestamp
        } else if (typeof entry.createdAt === 'number') {
          createdAt = entry.createdAt
        } else {
          createdAt = now
        }

        // 提取 status（默认 done）
        const status = 'done' as const

        // 创建 SessionMessageMeta
        const meta: SessionMessageMeta = {
          sessionKey: sk,
          conversationId: key.sessionId,
          messageId,
          role,
          createdAt,
          status,
          mtime: now,
        }

        // 写入 sessionMessages
        if (!this.sessionMessages.has(sk)) {
          this.sessionMessages.set(sk, [])
        }
        this.sessionMessages.get(sk)!.push(meta)
      } catch {
        // 解析失败跳过（可能是非 JSON 数据）
        continue
      }
    }
  }

  async querySessionMessages(
    projectKey: string,
    conversationId: string,
    opts?: {
      limit?: number
      before?: number
      after?: number
    },
  ): Promise<SessionMessageMeta[]> {
    const sk = `${projectKey}|${conversationId}`
    const messages = this.sessionMessages.get(sk) || []

    // 过滤
    let filtered = messages
    if (opts?.before) {
      filtered = filtered.filter((m) => m.createdAt < opts.before!)
    }
    if (opts?.after) {
      filtered = filtered.filter((m) => m.createdAt > opts.after!)
    }

    // 按 createdAt 降序排列（最新的在前）
    filtered.sort((a, b) => b.createdAt - a.createdAt)

    // 分页
    const limit = opts?.limit || 100
    return filtered.slice(0, limit)
  }

  async deleteSessionMessages(key: SessionKey): Promise<void> {
    const sk = encodeSessionKey(key)
    this.sessionMessages.delete(sk)
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
    this.sessionMessages.clear()
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
