/**
 * CloudBaseDbDriver: 把 SessionStoreDriver 落到 CloudBase 数据库（NoSQL）。
 *
 * 凭证模式：
 *   - 推荐通过 CloudBaseDbDriverOptions.credentials 显式注入
 *   - 不传时不做 env fallback，由 @cloudbase/node-sdk 自身处理运行环境认证
 *
 * 四张集合：
 *   - {prefix}sessions          一行 = 一个 session（用作 listSessions 索引）
 *   - {prefix}session_entries   一行 = 一条 transcript entry（uuid 唯一索引保证幂等）
 *   - {prefix}session_summaries 一行 = 一个 session 的 summary
 *   - {prefix}session_messages  一行 = 一条会话消息元数据（PR #4.6：前端分页索引）
 *
 * `@cloudbase/node-sdk` 是 peer dependency，运行时按需加载（避免 InMemoryDriver
 * 用户被强制装 cloudbase 依赖）。
 */

import type { SessionKey, SessionStoreEntry, SessionSummaryEntry } from '@anthropic-ai/claude-agent-sdk'

import { ResourceError } from '../../internal/errors.js'
import type { MessageStatus } from '../../public/types.js'
import { encodeSessionKey, type SessionStoreDriver, type SessionMessageMeta } from './types.js'

/** CloudBase Node SDK 凭证 */
export interface CloudBaseCredentials {
  envId: string
  secretId: string
  secretKey: string
  /** STS 临时凭证 token（可选） */
  sessionToken?: string
  /** 默认 ap-shanghai */
  region?: string
}

export interface CloudBaseDbDriverOptions {
  /** 显式凭证；不传则由 @cloudbase/node-sdk 自身处理运行环境认证 */
  credentials?: CloudBaseCredentials
  /**
   * 集合名前缀（默认 `oak_`，与 OpenVibeCoding 的 `vibe_agent_` 区分开，
   * 避免污染同一 envId 下其他业务的命名空间）
   */
  collectionPrefix?: string
}

const DEFAULT_PREFIX = 'oak_'

interface ResolvedCredentials extends Partial<CloudBaseCredentials> {
  region: string
}

function resolveCredentials(opts?: CloudBaseDbDriverOptions): ResolvedCredentials {
  const creds = opts?.credentials
  return {
    ...(creds?.envId ? { envId: creds.envId } : {}),
    ...(creds?.secretId ? { secretId: creds.secretId } : {}),
    ...(creds?.secretKey ? { secretKey: creds.secretKey } : {}),
    ...(creds?.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    region: creds?.region ?? 'ap-shanghai',
  }
}

// `@cloudbase/node-sdk` 没有 export 类型，只能用 unknown 包装。
// 内部封装时给关键方法起别名，让 driver 主体保持类型清晰。
interface CloudBaseDatabase {
  collection(name: string): CloudBaseCollection
  createCollection(name: string): Promise<unknown>
}

interface CloudBaseCollection {
  add(doc: Record<string, unknown>): Promise<unknown>
  where(filter: Record<string, unknown>): CloudBaseQuery
  doc(id: string): CloudBaseDocRef
  orderBy(field: string, direction: 'asc' | 'desc'): CloudBaseQuery
  limit(n: number): CloudBaseQuery
  get(): Promise<{ data: Array<Record<string, unknown>> }>
}

interface CloudBaseQuery {
  where(filter: Record<string, unknown>): CloudBaseQuery
  orderBy(field: string, direction: 'asc' | 'desc'): CloudBaseQuery
  limit(n: number): CloudBaseQuery
  get(): Promise<{ data: Array<Record<string, unknown>> }>
  remove(): Promise<unknown>
  update(doc: Record<string, unknown>): Promise<unknown>
}

interface CloudBaseDocRef {
  set(doc: Record<string, unknown>): Promise<unknown>
  update(doc: Record<string, unknown>): Promise<unknown>
  remove(): Promise<unknown>
  get(): Promise<{ data: Array<Record<string, unknown>> }>
}

interface CloudBaseApp {
  database(): CloudBaseDatabase
}

export class CloudBaseDbDriver implements SessionStoreDriver {
  private readonly creds: ResolvedCredentials
  private readonly prefix: string
  private app: CloudBaseApp | null = null
  private readonly ensuredCollections = new Set<string>()

  constructor(opts?: CloudBaseDbDriverOptions) {
    this.creds = resolveCredentials(opts)
    this.prefix = opts?.collectionPrefix ?? DEFAULT_PREFIX
  }

  // ─── 懒加载 CloudBase Node SDK ──────────────────────────────────

  private async getApp(): Promise<CloudBaseApp> {
    if (this.app) return this.app
    const mod = await this.requireCloudBase()
    const init = (mod.default ?? mod) as { init(opts: Record<string, unknown>): CloudBaseApp }
    if (typeof init.init !== 'function') {
      throw new ResourceError(
        '@cloudbase/node-sdk loaded but `.init()` not available. ' + 'Check the version (>= 3.0.0 required).',
      )
    }
    this.app = init.init({
      region: this.creds.region,
      ...(this.creds.envId ? { env: this.creds.envId } : {}),
      ...(this.creds.secretId ? { secretId: this.creds.secretId } : {}),
      ...(this.creds.secretKey ? { secretKey: this.creds.secretKey } : {}),
      ...(this.creds.sessionToken ? { sessionToken: this.creds.sessionToken } : {}),
    })
    return this.app
  }

  private async requireCloudBase(): Promise<{ default?: unknown; init?: unknown }> {
    try {
      // 用 Function 构造避免 bundler 静态分析硬连接 peer dep
      const dynamicImport = new Function('p', 'return import(p)') as (
        p: string,
      ) => Promise<{ default?: unknown; init?: unknown }>
      return await dynamicImport('@cloudbase/node-sdk')
    } catch {
      throw new ResourceError(
        '@cloudbase/node-sdk is not installed. Add it as a dependency:\n' +
          '  pnpm add @cloudbase/node-sdk\n' +
          'It is a peer dependency of @cloudbase/open-agent-kernel and is\n' +
          'required when using CloudBaseDbDriver.',
      )
    }
  }

  private async getCollection(name: string): Promise<CloudBaseCollection> {
    const app = await this.getApp()
    const db = app.database()
    const fullName = `${this.prefix}${name}`
    if (!this.ensuredCollections.has(fullName)) {
      try {
        await db.createCollection(fullName)
      } catch {
        // 集合已存在，忽略
      }
      this.ensuredCollections.add(fullName)
    }
    return db.collection(fullName)
  }

  // ─── SessionStoreDriver 接口实现 ────────────────────────────────

  async appendEntries(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return

    const sessionKey = encodeSessionKey(key)
    const now = Date.now()
    const entriesCol = await this.getCollection('session_entries')

    // 读取已存在的 uuid，做幂等
    const existingUuids = await this.fetchExistingUuids(
      entriesCol,
      sessionKey,
      entries.map((e) => e.uuid).filter((u): u is string => typeof u === 'string'),
    )

    // 准备插入
    const docs: Array<Record<string, unknown>> = []
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      const uuid = typeof entry.uuid === 'string' ? entry.uuid : undefined
      if (uuid !== undefined && existingUuids.has(uuid)) {
        continue
      }
      docs.push({
        sessionKey,
        projectKey: key.projectKey,
        sessionId: key.sessionId,
        subpath: key.subpath ?? null,
        // seq：使用 now + i 作为时间戳排序键。
        // 若同一毫秒内 append 多条，i 提供 tiebreak。
        seq: now * 1000 + i,
        uuid: uuid ?? null,
        // messageId：与 appendSessionMessage 的 messageId 派生逻辑一致
        // （message.id || uuid），用于 loadEntriesByMessageIds 查询。
        messageId: (entry as { message?: { id?: string } }).message?.id || uuid || null,
        type: typeof entry.type === 'string' ? entry.type : 'unknown',
        entry,
        createdAt: now,
      })
    }

    if (docs.length > 0) {
      // CloudBase Node SDK 的 add() 在不同版本对数组的支持不一致，
      // 安全做法是逐条 add（一次 append 通常只有 1-3 条 entry，开销微小）。
      for (const doc of docs) {
        await entriesCol.add(doc)
      }
    }

    // 更新 sessions 索引（仅主 transcript 才写）
    if (key.subpath === undefined) {
      await this.upsertSessionIndex({
        sessionKey,
        projectKey: key.projectKey,
        sessionId: key.sessionId,
        mtime: now,
      })
    }
  }

  async loadEntries(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const sessionKey = encodeSessionKey(key)
    const entriesCol = await this.getCollection('session_entries')

    // CloudBase DB 单次 get 默认有 100 条上限，需要分页。
    const PAGE_SIZE = 100
    const all: Array<Record<string, unknown>> = []
    let lastSeq: number | null = null

    while (true) {
      let q: CloudBaseQuery = entriesCol.where({ sessionKey })
      if (lastSeq !== null) {
        // CloudBase DB 的 _.gt 操作符需要 db.command，但为了不直接依赖
        // node-sdk 的 command 类型，这里改用 orderBy + 跳过策略：
        // 重新拉一遍 + skip。简单起见，直接用 limit + 分批 orderBy seq。
        // 实现细节：用 seq 作为游标
        q = entriesCol.where({
          sessionKey,
          // CloudBase DB where 不支持 $gt 字面量，使用动态 command
          ...(await this.gtCommand('seq', lastSeq)),
        })
      }
      q = q.orderBy('seq', 'asc').limit(PAGE_SIZE)
      const { data } = await q.get()
      if (!data || data.length === 0) break
      all.push(...data)
      if (data.length < PAGE_SIZE) break
      const last = data[data.length - 1]
      const lastSeqVal = last['seq']
      if (typeof lastSeqVal === 'number') {
        lastSeq = lastSeqVal
      } else {
        break // 异常防御
      }
    }

    if (all.length === 0) return null

    return all.map((row) => row['entry']).filter((e): e is SessionStoreEntry => e !== null && typeof e === 'object')
  }

  async loadEntriesByMessageIds(key: SessionKey, messageIds: string[]): Promise<SessionStoreEntry[]> {
    if (messageIds.length === 0) return []
    const sessionKey = encodeSessionKey(key)
    const entriesCol = await this.getCollection('session_entries')

    // CloudBase DB 的 in 查询：需要 db.command.in
    const app = await this.getApp()
    const db = app.database() as unknown as { command: { in(arr: string[]): unknown } }

    // CloudBase in 查询单次上限 20，分批查询
    // 查询 messageId 字段（= entry.message.id || entry.uuid，与 appendSessionMessage 一致）
    const BATCH_SIZE = 20
    const allEntries: SessionStoreEntry[] = []
    for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
      const batch = messageIds.slice(i, i + BATCH_SIZE)
      const { data } = await entriesCol
        .where({ sessionKey, messageId: db.command.in(batch) })
        .orderBy('seq', 'asc')
        .limit(batch.length)
        .get()
      for (const row of data) {
        const entry = row['entry']
        if (entry && typeof entry === 'object') {
          allEntries.push(entry as SessionStoreEntry)
        }
      }
    }
    return allEntries
  }

  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number; userId?: string }>> {
    const sessionsCol = await this.getCollection('sessions')
    // 仅 main transcript（subpath = null）才写入 sessions 索引
    const { data } = await sessionsCol.where({ projectKey }).get()
    return data
      .filter((row) => typeof row['sessionId'] === 'string' && typeof row['mtime'] === 'number')
      .map((row) => ({
        sessionId: row['sessionId'] as string,
        mtime: row['mtime'] as number,
        userId: typeof row['userId'] === 'string' ? (row['userId'] as string) : undefined,
      }))
  }

  async registerSession(args: {
    projectKey: string
    sessionId: string
    userId: string
    title?: string
    metadata?: Record<string, unknown>
  }): Promise<void> {
    const sessionsCol = await this.getCollection('sessions')
    const existing = await sessionsCol.where({ projectKey: args.projectKey, sessionId: args.sessionId }).limit(1).get()

    const now = Date.now()
    if (existing.data && existing.data.length > 0) {
      await sessionsCol.where({ projectKey: args.projectKey, sessionId: args.sessionId }).update({
        userId: args.userId,
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
        mtime: now,
      })
    } else {
      await sessionsCol.add({
        sessionKey: `${args.projectKey}|${args.sessionId}`,
        projectKey: args.projectKey,
        sessionId: args.sessionId,
        userId: args.userId,
        title: args.title ?? null,
        metadata: args.metadata ?? null,
        mtime: now,
        createdAt: now,
      })
    }
  }

  async listSummaries(projectKey: string): Promise<SessionSummaryEntry[]> {
    const summariesCol = await this.getCollection('session_summaries')
    const { data } = await summariesCol.where({ projectKey }).get()
    return data
      .filter(
        (row) =>
          typeof row['sessionId'] === 'string' &&
          typeof row['mtime'] === 'number' &&
          typeof row['data'] === 'object' &&
          row['data'] !== null,
      )
      .map((row) => ({
        sessionId: row['sessionId'] as string,
        mtime: row['mtime'] as number,
        data: row['data'] as Record<string, unknown>,
      }))
  }

  async upsertSummary(args: {
    projectKey: string
    sessionId: string
    mtime: number
    data: Record<string, unknown>
  }): Promise<void> {
    const summariesCol = await this.getCollection('session_summaries')
    const existing = await summariesCol.where({ projectKey: args.projectKey, sessionId: args.sessionId }).limit(1).get()
    if (existing.data && existing.data.length > 0) {
      await summariesCol
        .where({ projectKey: args.projectKey, sessionId: args.sessionId })
        .update({ mtime: args.mtime, data: args.data })
    } else {
      await summariesCol.add({
        projectKey: args.projectKey,
        sessionId: args.sessionId,
        mtime: args.mtime,
        data: args.data,
      })
    }
  }

  async deleteSession(key: SessionKey): Promise<void> {
    const sessionKey = encodeSessionKey(key)
    const entriesCol = await this.getCollection('session_entries')
    const sessionsCol = await this.getCollection('sessions')
    const summariesCol = await this.getCollection('session_summaries')
    const messagesCol = await this.getCollection('session_messages')

    // 删 entries（含所有 subpath）
    await entriesCol.where({ projectKey: key.projectKey, sessionId: key.sessionId }).remove()
    // 删 sessions 索引（仅主 transcript 时写过）
    await sessionsCol.where({ projectKey: key.projectKey, sessionId: key.sessionId }).remove()
    // 删 summary
    await summariesCol.where({ projectKey: key.projectKey, sessionId: key.sessionId }).remove()
    // 删会话消息元数据（字段名是 conversationId，对应 key.sessionId）
    await messagesCol.where({ projectKey: key.projectKey, conversationId: key.sessionId }).remove()

    // 防止 sessionKey 未使用 lint 警告
    void sessionKey
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    const entriesCol = await this.getCollection('session_entries')
    // 拉所有 subpath 不为 null 的 entries 的 distinct subpath
    // CloudBase DB 不直接支持 distinct，分页拉所有再去重。
    const { data } = await entriesCol.where({ projectKey: key.projectKey, sessionId: key.sessionId }).get()
    const subpaths = new Set<string>()
    for (const row of data) {
      const sp = row['subpath']
      if (typeof sp === 'string' && sp.length > 0) {
        subpaths.add(sp)
      }
    }
    return Array.from(subpaths)
  }

  async appendSessionMessage(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return

    const sessionKey = encodeSessionKey(key)
    const now = Date.now()
    const messagesCol = await this.getCollection('session_messages')

    if (process.env.OAK_DEBUG === '1') {
      // eslint-disable-next-line no-console
      console.error(
        '[oak][session-messages] appendSessionMessage start, sessionKey=' +
          sessionKey +
          ', entryCount=' +
          entries.length,
      )
    }

    // 拉取该 sessionKey 已有的 messageId 集合（幂等检查）
    const existingIds = await this.fetchExistingMessageIds(messagesCol, sessionKey)

    if (process.env.OAK_DEBUG === '1') {
      // eslint-disable-next-line no-console
      console.error('[oak][session-messages] existingIds count=' + existingIds.size)
    }

    let processedCount = 0
    let skippedCount = 0
    let errorCount = 0

    for (const entry of entries) {
      try {
        // entry 本身就是 SessionStoreEntry 对象（包含 type, message, uuid, timestamp 等）
        // 在 CloudBase DB 中，entry 字段存储的是完整的 SessionStoreEntry
        const sdkMsg = entry

        if (process.env.OAK_DEBUG === '1') {
          const msgType = sdkMsg?.type || 'unknown'
          // eslint-disable-next-line no-console
          console.error('[oak][session-messages] sdkMsg.type=' + msgType + ', entry.uuid=' + (entry.uuid || 'null'))
        }

        if (!sdkMsg || typeof sdkMsg !== 'object') {
          skippedCount++
          continue
        }

        // 只处理 assistant 和 user 类型的消息
        if (sdkMsg.type !== 'assistant' && sdkMsg.type !== 'user') {
          skippedCount++
          continue
        }

        // 提取关键标识
        const messageId = (sdkMsg as any).message?.id || entry.uuid
        if (!messageId) {
          if (process.env.OAK_DEBUG === '1') {
            // eslint-disable-next-line no-console
            console.error('[oak][session-messages] skipped: no messageId')
          }
          skippedCount++
          continue
        }

        // 幂等检查：已存在则跳过
        if (existingIds.has(messageId)) {
          if (process.env.OAK_DEBUG === '1') {
            // eslint-disable-next-line no-console
            console.error('[oak][session-messages] skipped: already exists, messageId=' + messageId)
          }
          skippedCount++
          continue
        }

        // 确保 createdAt 是数字格式（毫秒时间戳）
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

        await messagesCol.add({
          sessionKey,
          projectKey: key.projectKey,
          conversationId: key.sessionId,
          messageId,
          role: sdkMsg.type,
          createdAt,
          status: 'done',
          mtime: now,
        })

        existingIds.add(messageId)
        processedCount++

        if (process.env.OAK_DEBUG === '1') {
          // eslint-disable-next-line no-console
          console.error('[oak][session-messages] wrote message, messageId=' + messageId + ', role=' + sdkMsg.type)
        }
      } catch (err) {
        errorCount++
        if (process.env.OAK_DEBUG === '1') {
          // eslint-disable-next-line no-console
          console.error('[oak][session-messages] error processing entry:', (err as Error).message)
        }
        // 解析失败跳过（可能是非 JSON 数据）
        continue
      }
    }

    if (process.env.OAK_DEBUG === '1') {
      // eslint-disable-next-line no-console
      console.error(
        '[oak][session-messages] appendSessionMessage done, processed=' +
          processedCount +
          ', skipped=' +
          skippedCount +
          ', errors=' +
          errorCount,
      )
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
    const messagesCol = await this.getCollection('session_messages')
    const limit = opts?.limit ?? 100

    // 构建 where 条件
    const filter: Record<string, unknown> = { projectKey, conversationId }

    let q: CloudBaseQuery = messagesCol.where(filter)

    // before / after 过滤需要 CloudBase command 操作符
    if (opts?.before !== undefined && opts?.after !== undefined) {
      // 同时有 before 和 after：用 command 组合
      const app = await this.getApp()
      interface CommandPredicate {
        and(...args: unknown[]): CommandPredicate
      }
      const db = app.database() as unknown as {
        command: { gt(v: number): CommandPredicate; lt(v: number): CommandPredicate }
      }
      q = messagesCol.where({
        ...filter,
        createdAt: db.command.gt(opts.after).and(db.command.lt(opts.before)),
      })
    } else if (opts?.before !== undefined) {
      q = messagesCol.where({
        ...filter,
        ...(await this.ltCommand('createdAt', opts.before)),
      })
    } else if (opts?.after !== undefined) {
      q = messagesCol.where({
        ...filter,
        ...(await this.gtCommand('createdAt', opts.after)),
      })
    }

    q = q.orderBy('createdAt', 'desc').limit(limit)
    const { data } = await q.get()

    return data
      .filter(
        (row) =>
          typeof row['sessionKey'] === 'string' &&
          typeof row['conversationId'] === 'string' &&
          typeof row['messageId'] === 'string' &&
          typeof row['role'] === 'string' &&
          typeof row['createdAt'] === 'number' &&
          typeof row['status'] === 'string' &&
          typeof row['mtime'] === 'number',
      )
      .map((row) => ({
        sessionKey: row['sessionKey'] as string,
        conversationId: row['conversationId'] as string,
        messageId: row['messageId'] as string,
        role: row['role'] as 'user' | 'assistant' | 'system',
        createdAt: row['createdAt'] as number,
        status: row['status'] as MessageStatus,
        mtime: row['mtime'] as number,
      }))
  }

  async deleteSessionMessages(key: SessionKey): Promise<void> {
    const sessionKey = encodeSessionKey(key)
    const messagesCol = await this.getCollection('session_messages')
    await messagesCol.where({ sessionKey }).remove()
  }

  // ─── 内部辅助 ──────────────────────────────────────────────────

  private async upsertSessionIndex(args: {
    sessionKey: string
    projectKey: string
    sessionId: string
    mtime: number
  }): Promise<void> {
    const sessionsCol = await this.getCollection('sessions')
    const existing = await sessionsCol.where({ projectKey: args.projectKey, sessionId: args.sessionId }).limit(1).get()
    if (existing.data && existing.data.length > 0) {
      await sessionsCol.where({ projectKey: args.projectKey, sessionId: args.sessionId }).update({ mtime: args.mtime })
    } else {
      await sessionsCol.add({
        sessionKey: args.sessionKey,
        projectKey: args.projectKey,
        sessionId: args.sessionId,
        mtime: args.mtime,
        createdAt: args.mtime,
      })
    }
  }

  private async fetchExistingUuids(
    col: CloudBaseCollection,
    sessionKey: string,
    uuids: string[],
  ): Promise<Set<string>> {
    if (uuids.length === 0) return new Set()
    // 简化：单次 where + limit 拉所有同 sessionKey 已存在 uuid。
    // 大批量场景未来改为 IN 查询（需引入 db.command.in）。
    const { data } = await col.where({ sessionKey }).orderBy('seq', 'desc').limit(1000).get()
    const existing = new Set<string>()
    for (const row of data) {
      const u = row['uuid']
      if (typeof u === 'string') existing.add(u)
    }
    return existing
  }

  private async gtCommand(field: string, threshold: number): Promise<Record<string, unknown>> {
    // 动态拿到 db.command.gt（避免静态依赖 cloudbase node sdk 的 command 类型）
    const app = await this.getApp()
    const db = app.database() as unknown as { command: { gt(v: number): unknown } }
    return { [field]: db.command.gt(threshold) }
  }

  private async ltCommand(field: string, threshold: number): Promise<Record<string, unknown>> {
    const app = await this.getApp()
    const db = app.database() as unknown as { command: { lt(v: number): unknown } }
    return { [field]: db.command.lt(threshold) }
  }

  private async fetchExistingMessageIds(col: CloudBaseCollection, sessionKey: string): Promise<Set<string>> {
    const { data } = await col.where({ sessionKey }).limit(1000).get()
    const existing = new Set<string>()
    for (const row of data) {
      const mid = row['messageId']
      if (typeof mid === 'string') existing.add(mid)
    }
    return existing
  }
}
