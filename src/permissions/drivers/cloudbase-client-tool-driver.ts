/**
 * CloudBaseDbClientToolDriver: 把 ClientToolResultStore 落到 CloudBase 数据库。
 *
 * 复用 oak_state 集合（type='client_tool'），与 PermissionStore 共享同一张表。
 *
 * oak_state 文档结构（type='client_tool'）：
 *   {
 *     projectKey: string,
 *     type: 'client_tool',
 *     key: `${conversationId}|${toolUseId}`,
 *     conversationId: string,
 *     toolName: string,
 *     data: PendingClientToolResult,
 *     createdAt: number,
 *     mtime: number,
 *   }
 *
 * 索引建议：
 *   1. (projectKey, type, key)                                  主键查询
 *   2. (projectKey, type, conversationId, toolName, createdAt desc)  scanRecent
 */

import cloudbase from '@cloudbase/node-sdk'

import { ResourceError } from '../../internal/errors.js'
import type { PendingClientToolResult } from '../hooks.js'
import type { ClientToolResultStoreDriver } from './types.js'

/** CloudBase Node SDK 凭证 */
export interface CloudBaseClientToolCredentials {
  envId: string
  /** CloudBase 平台 API Key。存在时优先于 secretId/secretKey */
  accessKey?: string
  secretId?: string
  secretKey?: string
  sessionToken?: string
  region?: string
}

export interface CloudBaseDbClientToolDriverOptions {
  credentials?: CloudBaseClientToolCredentials
  collectionPrefix?: string
}

const DEFAULT_PREFIX = 'oak_'
const STATE_COLLECTION = 'state'
const ENTRY_TYPE = 'client_tool'

interface ResolvedCredentials {
  envId?: string
  accessKey?: string
  secretId?: string
  secretKey?: string
  sessionToken?: string
  region: string
}

/**
 * Resolve credentials — lenient pattern (same as CloudBaseDbDriver and
 * CloudBaseDbPermissionDriver). Copies only truthy fields; the
 * @cloudbase/node-sdk picks up CLOUDBASE_APIKEY from env for Bearer auth
 * when secretId/secretKey are empty. This lets FlexDB work with just
 * CLOUDBASE_APIKEY (no CAM secret needed).
 */
function resolveCredentials(opts?: CloudBaseDbClientToolDriverOptions): ResolvedCredentials {
  const creds = opts?.credentials
  const envId = creds?.envId ?? process.env.TCB_ENV_ID
  if (!envId) {
    throw new ResourceError(
      'CloudBase envId missing. Set one of:\n' +
        '  - process.env: TCB_ENV_ID or CLOUDBASE_ENV_ID\n' +
        '  - CloudBaseDbClientToolDriverOptions.credentials.envId (programmatic)',
    )
  }
  return {
    envId,
    ...(creds?.accessKey ? { accessKey: creds.accessKey } : {}),
    ...(creds?.secretId ? { secretId: creds.secretId } : {}),
    ...(creds?.secretKey ? { secretKey: creds.secretKey } : {}),
    ...(creds?.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    region: creds?.region ?? 'ap-shanghai',
  }
}

// CloudBase Node SDK 类型（与 cloudbase-db-driver.ts 一致）
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

export class CloudBaseDbClientToolDriver implements ClientToolResultStoreDriver {
  private readonly creds: ResolvedCredentials
  private readonly prefix: string
  private app: CloudBaseApp | null = null
  private ensured = false

  constructor(opts?: CloudBaseDbClientToolDriverOptions) {
    this.creds = resolveCredentials(opts)
    this.prefix = opts?.collectionPrefix ?? DEFAULT_PREFIX
  }

  // ─── 懒加载 CloudBase Node SDK ──────────────────────────────────

  private async getApp(): Promise<CloudBaseApp> {
    if (this.app) return this.app
    this.app = cloudbase.init({
      env: this.creds.envId,
      region: this.creds.region,
      ...(this.creds.accessKey ? { accessKey: this.creds.accessKey } : {}),
      secretId: this.creds.secretId,
      secretKey: this.creds.secretKey,
      ...(this.creds.sessionToken ? { sessionToken: this.creds.sessionToken } : {}),
    })
    return this.app
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

  private buildKey(conversationId: string, toolUseId: string): string {
    return `${conversationId}|${toolUseId}`
  }

  // ─── ClientToolResultStoreDriver 接口实现 ───────────────────────

  async put(args: { projectKey: string; entry: PendingClientToolResult }): Promise<void> {
    const col = await this.getCollection()
    const { projectKey, entry } = args
    const now = Date.now()
    const key = this.buildKey(entry.conversationId, entry.toolUseId)

    // replace 语义：先删旧行，再 add 新行
    await col.where({ projectKey, type: ENTRY_TYPE, key }).remove()

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
        result: entry.result ?? null,
      },
      createdAt: entry.createdAt,
      mtime: now,
    })
  }

  async get(args: {
    projectKey: string
    conversationId: string
    toolUseId: string
  }): Promise<PendingClientToolResult | null> {
    const col = await this.getCollection()
    const key = this.buildKey(args.conversationId, args.toolUseId)
    const { data } = await col.where({ projectKey: args.projectKey, type: ENTRY_TYPE, key }).limit(1).get()
    if (!data || data.length === 0) return null
    return rowToEntry(data[0])
  }

  async delete(args: { projectKey: string; conversationId: string; toolUseId: string }): Promise<void> {
    const col = await this.getCollection()
    const key = this.buildKey(args.conversationId, args.toolUseId)
    await col.where({ projectKey: args.projectKey, type: ENTRY_TYPE, key }).remove()
  }

  async scanRecent(args: {
    projectKey: string
    conversationId: string
    toolName: string
  }): Promise<PendingClientToolResult | null> {
    const col = await this.getCollection()

    // 尝试用 db.command.neq(null) 做服务端过滤
    let neqNullFilter: Record<string, unknown> | null = null
    try {
      const app = await this.getApp()
      const db = app.database() as unknown as { command: { neq?(v: unknown): unknown } }
      if (typeof db.command?.neq === 'function') {
        neqNullFilter = { 'data.result': db.command.neq(null) }
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
    // 客户端过滤：取第一个 result != null 的
    for (const row of data) {
      const rowData = row['data'] as Record<string, unknown> | undefined
      if (rowData && rowData['result'] !== null && rowData['result'] !== undefined) {
        return rowToEntry(row)
      }
    }
    return null
  }
}

/** oak_state row → PendingClientToolResult */
function rowToEntry(row: Record<string, unknown>): PendingClientToolResult {
  const data = row['data'] as Record<string, unknown> | undefined
  if (!data) {
    const result = row['result']
    return {
      conversationId: row['conversationId'] as string,
      toolUseId: row['toolUseId'] as string,
      toolName: row['toolName'] as string,
      toolInput: row['toolInput'],
      createdAt: row['createdAt'] as number,
      result: result === null || result === undefined ? undefined : (result as { output: unknown; isError: boolean }),
    }
  }
  const result = data['result']
  return {
    conversationId: data['conversationId'] as string,
    toolUseId: data['toolUseId'] as string,
    toolName: data['toolName'] as string,
    toolInput: data['toolInput'],
    createdAt: data['createdAt'] as number,
    result: result === null || result === undefined ? undefined : (result as { output: unknown; isError: boolean }),
  }
}
