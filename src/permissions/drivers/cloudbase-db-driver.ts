/**
 * CloudBaseDbPermissionDriver: 把 PermissionStoreDriver 落到 CloudBase 数据库（NoSQL）。
 *
 * 存储在统一的 `oak_state` 表中（type='permission'），与其他临时状态共享同一集合。
 * 这样每个小租户环境只需开通 1 张临时状态表，而不是每个功能开一张。
 *
 * 凭证模式（与 CloudBaseDbDriver / CloudBaseStorage 一致）：
 *   - 推荐通过 CloudBaseDbPermissionDriverOptions.credentials 显式注入
 *   - 不传时不做 env fallback，由 @cloudbase/node-sdk 自身处理运行环境认证
 *
 * oak_state 文档结构（type='permission'）：
 *   {
 *     projectKey: string,
 *     type: 'permission',
 *     key: `${conversationId}|${toolUseId}`,
 *     data: PendingApproval,
 *     toolName: string,               // 冗余：scanRecent 查询需要
 *     conversationId: string,         // 冗余：查询便利
 *     createdAt: number,
 *     expiresAt: number | null,       // 过期时间（approvalTimeoutMs 后）
 *     mtime: number,
 *   }
 *
 * 索引建议（生产部署应在 CloudBase 控制台手动创建）：
 *   1. (projectKey, type, key)                                  主键查询：get / delete
 *   2. (projectKey, type, conversationId, toolName, createdAt desc)  scanRecent
 *   3. (expiresAt)                                              批量 cleanup stale
 *
 * `@cloudbase/node-sdk` 按需懒加载。
 */

import { ResourceError } from '../../internal/errors.js'
import type { PendingApproval } from '../../public/types.js'
import type { PermissionStoreDriver } from './types.js'

/** CloudBase Node SDK 凭证（与 CloudBaseDbDriver / CloudBaseStorage 同 shape） */
export interface CloudBasePermissionCredentials {
  envId: string
  secretId: string
  secretKey: string
  /** STS 临时凭证 token（可选） */
  sessionToken?: string
  /** 默认 ap-shanghai */
  region?: string
}

export interface CloudBaseDbPermissionDriverOptions {
  /** 显式凭证；不传则由 @cloudbase/node-sdk 自身处理运行环境认证 */
  credentials?: CloudBasePermissionCredentials
  /**
   * 集合名前缀（默认 `oak_`）。
   * 最终集合名为 `{prefix}state`（统一临时状态表）。
   */
  collectionPrefix?: string
  /**
   * Permission entry 过期时间（毫秒）。
   * 过期后的 entry 会被 cleanup sweep 清除。
   * 默认 1800_000（30 分钟），与 DEFAULT_APPROVAL_TIMEOUT_MS 一致。
   */
  expiresAfterMs?: number
}

const DEFAULT_PREFIX = 'oak_'
const STATE_COLLECTION = 'state'
const ENTRY_TYPE = 'permission'
const DEFAULT_EXPIRES_AFTER_MS = 1_800_000 // 30 分钟

interface ResolvedCredentials extends Partial<CloudBasePermissionCredentials> {
  region: string
}

function resolveCredentials(opts?: CloudBaseDbPermissionDriverOptions): ResolvedCredentials {
  const creds = opts?.credentials
  return {
    ...(creds?.envId ? { envId: creds.envId } : {}),
    ...(creds?.secretId ? { secretId: creds.secretId } : {}),
    ...(creds?.secretKey ? { secretKey: creds.secretKey } : {}),
    ...(creds?.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    region: creds?.region ?? 'ap-shanghai',
  }
}

// `@cloudbase/node-sdk` 没有 export 类型，只能用 unknown 包装
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

export class CloudBaseDbPermissionDriver implements PermissionStoreDriver {
  private readonly creds: ResolvedCredentials
  private readonly prefix: string
  private readonly expiresAfterMs: number
  private app: CloudBaseApp | null = null
  private ensured = false

  constructor(opts?: CloudBaseDbPermissionDriverOptions) {
    this.creds = resolveCredentials(opts)
    this.prefix = opts?.collectionPrefix ?? DEFAULT_PREFIX
    this.expiresAfterMs = opts?.expiresAfterMs ?? DEFAULT_EXPIRES_AFTER_MS
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
      const dynamicImport = new Function('p', 'return import(p)') as (
        p: string,
      ) => Promise<{ default?: unknown; init?: unknown }>
      return await dynamicImport('@cloudbase/node-sdk')
    } catch {
      throw new ResourceError(
        '@cloudbase/node-sdk failed to load. Reinstall @cloudbase/open-agent-kernel or check your node_modules.',
      )
    }
  }

  private async getCollection(): Promise<CloudBaseCollection> {
    const app = await this.getApp()
    const db = app.database()
    const fullName = `${this.prefix}${STATE_COLLECTION}`
    if (!this.ensured) {
      try {
        await db.createCollection(fullName)
      } catch {
        // 集合已存在，忽略
      }
      this.ensured = true
    }
    return db.collection(fullName)
  }

  /** 构建 oak_state 的 key 字段（type 内唯一） */
  private buildKey(conversationId: string, toolUseId: string): string {
    return `${conversationId}|${toolUseId}`
  }

  // ─── PermissionStoreDriver 接口实现 ──────────────────────────────

  async put(args: { projectKey: string; entry: PendingApproval }): Promise<void> {
    const col = await this.getCollection()
    const { projectKey, entry } = args
    const now = Date.now()
    const key = this.buildKey(entry.conversationId, entry.toolUseId)

    // replace 语义：先删旧行，再 add 新行（避免 CloudBase DB 嵌套对象更新问题）
    await col
      .where({
        projectKey,
        type: ENTRY_TYPE,
        key,
      })
      .remove()

    await col.add({
      projectKey,
      type: ENTRY_TYPE,
      key,
      conversationId: entry.conversationId,
      toolUseId: entry.toolUseId,
      toolName: entry.toolName,
      data: {
        conversationId: entry.conversationId,
        toolUseId: entry.toolUseId,
        toolName: entry.toolName,
        toolInput: entry.toolInput,
        createdAt: entry.createdAt,
        decision: entry.decision ?? null,
      },
      createdAt: entry.createdAt,
      expiresAt: entry.createdAt + this.expiresAfterMs,
      mtime: now,
    })
  }

  async get(args: { projectKey: string; conversationId: string; toolUseId: string }): Promise<PendingApproval | null> {
    const col = await this.getCollection()
    const key = this.buildKey(args.conversationId, args.toolUseId)
    const { data } = await col
      .where({
        projectKey: args.projectKey,
        type: ENTRY_TYPE,
        key,
      })
      .limit(1)
      .get()
    if (!data || data.length === 0) return null
    return rowToEntry(data[0])
  }

  async delete(args: { projectKey: string; conversationId: string; toolUseId: string }): Promise<void> {
    const col = await this.getCollection()
    const key = this.buildKey(args.conversationId, args.toolUseId)
    await col
      .where({
        projectKey: args.projectKey,
        type: ENTRY_TYPE,
        key,
      })
      .remove()
  }

  async scanRecent(args: {
    projectKey: string
    conversationId: string
    toolName: string
  }): Promise<PendingApproval | null> {
    const col = await this.getCollection()

    // 尝试用 db.command.neq(null) 做服务端过滤
    let neqNullFilter: Record<string, unknown> | null = null
    try {
      const app = await this.getApp()
      const db = app.database() as unknown as { command: { neq?(v: unknown): unknown } }
      if (typeof db.command?.neq === 'function') {
        neqNullFilter = { 'data.decision': db.command.neq(null) }
      }
    } catch {
      // 退化客户端过滤
    }

    const baseFilter: Record<string, unknown> = {
      projectKey: args.projectKey,
      type: ENTRY_TYPE,
      conversationId: args.conversationId,
      toolName: args.toolName,
    }
    const filter = neqNullFilter ? { ...baseFilter, ...neqNullFilter } : baseFilter

    const { data } = await col
      .where(filter)
      .orderBy('createdAt', 'desc')
      .limit(neqNullFilter ? 1 : 20)
      .get()

    if (!data || data.length === 0) return null

    if (neqNullFilter) {
      return rowToEntry(data[0])
    }
    // 客户端过滤：取第一个 decision != null 的
    for (const row of data) {
      const rowData = row['data'] as Record<string, unknown> | undefined
      if (rowData && rowData['decision'] !== null && rowData['decision'] !== undefined) {
        return rowToEntry(row)
      }
    }
    return null
  }

  // ─── 扩展：清理过期 entries ──────────────────────────────────────

  /**
   * 清理已过期的 permission entries。
   *
   * 可选择性调用（定时任务 / session 结束时 / 手动清理）。
   * 非必须——过期 entry 不影响功能（hook 会检查 isStaleApproval），
   * 但定期清理可以减少存储占用。
   *
   * @returns 清理的条目数
   */
  async cleanup(projectKey?: string): Promise<number> {
    const col = await this.getCollection()
    const now = Date.now()

    try {
      const app = await this.getApp()
      const db = app.database() as unknown as { command: { lt(v: number): unknown } }

      const filter: Record<string, unknown> = {
        type: ENTRY_TYPE,
        expiresAt: db.command.lt(now),
      }
      if (projectKey) {
        filter.projectKey = projectKey
      }

      const { data } = await col.where(filter).limit(100).get()
      if (!data || data.length === 0) return 0

      await col.where(filter).remove()
      return data.length
    } catch {
      return 0
    }
  }
}

/** oak_state row → PendingApproval */
function rowToEntry(row: Record<string, unknown>): PendingApproval {
  const data = row['data'] as Record<string, unknown> | undefined
  if (!data) {
    // 兜底：从顶层字段恢复
    const decision = row['decision']
    return {
      conversationId: row['conversationId'] as string,
      toolUseId: row['toolUseId'] as string,
      toolName: row['toolName'] as string,
      toolInput: row['toolInput'],
      createdAt: row['createdAt'] as number,
      decision: decision === null || decision === undefined ? undefined : (decision as PendingApproval['decision']),
    }
  }
  const decision = data['decision']
  return {
    conversationId: data['conversationId'] as string,
    toolUseId: data['toolUseId'] as string,
    toolName: data['toolName'] as string,
    toolInput: data['toolInput'],
    createdAt: data['createdAt'] as number,
    decision: decision === null || decision === undefined ? undefined : (decision as PendingApproval['decision']),
  }
}
