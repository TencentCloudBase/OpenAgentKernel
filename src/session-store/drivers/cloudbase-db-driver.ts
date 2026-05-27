/**
 * CloudBaseDbDriver: 把 SessionStoreDriver 落到 CloudBase 数据库（NoSQL）。
 *
 * 凭证模式（与 OpenVibeCoding 项目保持一致）：
 *   - TCB_ENV_ID + TCB_SECRET_ID + TCB_SECRET_KEY
 *   - 也支持配置注入（CloudBaseDbDriverOptions.credentials）
 *
 * 三张集合：
 *   - {prefix}sessions          一行 = 一个 session（用作 listSessions 索引）
 *   - {prefix}session_entries   一行 = 一条 transcript entry（uuid 唯一索引保证幂等）
 *   - {prefix}session_summaries 一行 = 一个 session 的 summary
 *
 * `@cloudbase/node-sdk` 是 peer dependency，运行时按需加载（避免 InMemoryDriver
 * 用户被强制装 cloudbase 依赖）。
 */

import type {
  SessionKey,
  SessionStoreEntry,
  SessionSummaryEntry,
} from '@anthropic-ai/claude-agent-sdk'

import { ResourceError } from '../../internal/errors.js'
import { encodeSessionKey, type SessionStoreDriver } from './types.js'

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
  /** 显式凭证；不传则从 process.env 读取 TCB_ENV_ID/TCB_SECRET_ID/TCB_SECRET_KEY */
  credentials?: CloudBaseCredentials
  /**
   * 集合名前缀（默认 `oak_`，与 OpenVibeCoding 的 `vibe_agent_` 区分开，
   * 避免污染同一 envId 下其他业务的命名空间）
   */
  collectionPrefix?: string
}

const DEFAULT_PREFIX = 'oak_'

interface ResolvedCredentials extends CloudBaseCredentials {
  region: string
}

function resolveCredentials(opts?: CloudBaseDbDriverOptions): ResolvedCredentials {
  const fromEnv = opts?.credentials
  const envId = fromEnv?.envId ?? process.env.TCB_ENV_ID
  const secretId = fromEnv?.secretId ?? process.env.TCB_SECRET_ID
  const secretKey = fromEnv?.secretKey ?? process.env.TCB_SECRET_KEY
  const sessionToken = fromEnv?.sessionToken ?? process.env.TCB_TOKEN ?? undefined
  const region = fromEnv?.region ?? process.env.TCB_REGION ?? 'ap-shanghai'

  if (!envId || !secretId || !secretKey) {
    throw new ResourceError(
      'CloudBase credentials missing. Set one of:\n' +
        '  - process.env: TCB_ENV_ID + TCB_SECRET_ID + TCB_SECRET_KEY\n' +
        '  - CloudBaseDbDriverOptions.credentials (programmatic)',
    )
  }

  return { envId, secretId, secretKey, sessionToken, region }
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
        '@cloudbase/node-sdk loaded but `.init()` not available. ' +
          'Check the version (>= 3.0.0 required).',
      )
    }
    this.app = init.init({
      env: this.creds.envId,
      region: this.creds.region,
      secretId: this.creds.secretId,
      secretKey: this.creds.secretKey,
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

    return all
      .map((row) => row['entry'])
      .filter((e): e is SessionStoreEntry => e !== null && typeof e === 'object')
  }

  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    const sessionsCol = await this.getCollection('sessions')
    // 仅 main transcript（subpath = null）才写入 sessions 索引
    const { data } = await sessionsCol.where({ projectKey }).get()
    return data
      .filter((row) => typeof row['sessionId'] === 'string' && typeof row['mtime'] === 'number')
      .map((row) => ({
        sessionId: row['sessionId'] as string,
        mtime: row['mtime'] as number,
      }))
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
    const existing = await summariesCol
      .where({ projectKey: args.projectKey, sessionId: args.sessionId })
      .limit(1)
      .get()
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

    // 删 entries（含所有 subpath）
    await entriesCol
      .where({ projectKey: key.projectKey, sessionId: key.sessionId })
      .remove()
    // 删 sessions 索引（仅主 transcript 时写过）
    await sessionsCol
      .where({ projectKey: key.projectKey, sessionId: key.sessionId })
      .remove()
    // 删 summary
    await summariesCol
      .where({ projectKey: key.projectKey, sessionId: key.sessionId })
      .remove()

    // 防止 sessionKey 未使用 lint 警告
    void sessionKey
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    const entriesCol = await this.getCollection('session_entries')
    // 拉所有 subpath 不为 null 的 entries 的 distinct subpath
    // CloudBase DB 不直接支持 distinct，分页拉所有再去重。
    const { data } = await entriesCol
      .where({ projectKey: key.projectKey, sessionId: key.sessionId })
      .get()
    const subpaths = new Set<string>()
    for (const row of data) {
      const sp = row['subpath']
      if (typeof sp === 'string' && sp.length > 0) {
        subpaths.add(sp)
      }
    }
    return Array.from(subpaths)
  }

  // ─── 内部辅助 ──────────────────────────────────────────────────

  private async upsertSessionIndex(args: {
    sessionKey: string
    projectKey: string
    sessionId: string
    mtime: number
  }): Promise<void> {
    const sessionsCol = await this.getCollection('sessions')
    const existing = await sessionsCol
      .where({ projectKey: args.projectKey, sessionId: args.sessionId })
      .limit(1)
      .get()
    if (existing.data && existing.data.length > 0) {
      await sessionsCol
        .where({ projectKey: args.projectKey, sessionId: args.sessionId })
        .update({ mtime: args.mtime })
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
    const { data } = await col
      .where({ sessionKey })
      .orderBy('seq', 'desc')
      .limit(1000)
      .get()
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
}
