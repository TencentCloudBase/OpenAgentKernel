/**
 * CloudBaseDbPermissionDriver: 把 PermissionStoreDriver 落到 CloudBase 数据库（NoSQL）。
 *
 * 凭证模式（与 CloudBaseDbDriver / CloudBaseStorage 一致）：
 *   - TCB_ENV_ID + TCB_SECRET_ID + TCB_SECRET_KEY
 *   - 也支持配置注入（CloudBaseDbPermissionDriverOptions.credentials）
 *
 * 单集合：
 *   - {prefix}permissions  一行 = 一个 pending/decided permission entry
 *
 * 索引建议（生产部署应在 CloudBase 控制台手动创建）：
 *   1. (projectKey, conversationId, toolUseId)         主键查询：get / delete
 *   2. (projectKey, conversationId, toolName, createdAt desc)  scanRecent 加速
 *   3. (createdAt)                                     可选：批量 cleanup stale
 *
 * `@cloudbase/node-sdk` 是 peer dependency，运行时按需加载。
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
  /** 显式凭证；不传则从 process.env 读取 TCB_ENV_ID/TCB_SECRET_ID/TCB_SECRET_KEY */
  credentials?: CloudBasePermissionCredentials
  /**
   * 集合名前缀（默认 `oak_`，与 SessionStoreDriver 的 oak_sessions / oak_session_entries
   * 共享同一前缀；最终集合名为 `oak_permissions`）。
   */
  collectionPrefix?: string
}

const DEFAULT_PREFIX = 'oak_'
const COLLECTION_NAME = 'permissions'

interface ResolvedCredentials extends CloudBasePermissionCredentials {
  region: string
}

function resolveCredentials(
  opts?: CloudBaseDbPermissionDriverOptions,
): ResolvedCredentials {
  const fromOpts = opts?.credentials
  const envId = fromOpts?.envId ?? process.env.TCB_ENV_ID
  const secretId = fromOpts?.secretId ?? process.env.TCB_SECRET_ID
  const secretKey = fromOpts?.secretKey ?? process.env.TCB_SECRET_KEY
  const sessionToken = fromOpts?.sessionToken ?? process.env.TCB_TOKEN ?? undefined
  const region = fromOpts?.region ?? process.env.TCB_REGION ?? 'ap-shanghai'

  if (!envId || !secretId || !secretKey) {
    throw new ResourceError(
      'CloudBase credentials missing. Set one of:\n' +
        '  - process.env: TCB_ENV_ID + TCB_SECRET_ID + TCB_SECRET_KEY\n' +
        '  - CloudBaseDbPermissionDriverOptions.credentials (programmatic)',
    )
  }

  return { envId, secretId, secretKey, sessionToken, region }
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
  private app: CloudBaseApp | null = null
  private ensured = false

  constructor(opts?: CloudBaseDbPermissionDriverOptions) {
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
      const dynamicImport = new Function('p', 'return import(p)') as (
        p: string,
      ) => Promise<{ default?: unknown; init?: unknown }>
      return await dynamicImport('@cloudbase/node-sdk')
    } catch {
      throw new ResourceError(
        '@cloudbase/node-sdk is not installed. Add it as a dependency:\n' +
          '  pnpm add @cloudbase/node-sdk\n' +
          'It is a peer dependency of @cloudbase/open-agent-kernel and is\n' +
          'required when using CloudBaseDbPermissionDriver.',
      )
    }
  }

  private async getCollection(): Promise<CloudBaseCollection> {
    const app = await this.getApp()
    const db = app.database()
    const fullName = `${this.prefix}${COLLECTION_NAME}`
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

  // ─── PermissionStoreDriver 接口实现 ──────────────────────────────

  async put(args: { projectKey: string; entry: PendingApproval }): Promise<void> {
    const col = await this.getCollection()
    const { projectKey, entry } = args
    const now = Date.now()

    // CloudBase DB 的 update 对嵌套对象字段使用"点路径合并"语义：
    //   update({ decision: { kind: 'allow' } })
    //   被转换为 $set: { 'decision.kind': 'allow' }，
    //   当原行里 decision 是标量 null 时会报 "Cannot create field 'kind' in element {decision: null}"。
    //
    // 为绕开这个问题，put 采用"先 remove 旧行，再 add 新行"的 replace 语义：
    //   - 主键 (projectKey, conversationId, toolUseId) 上无并发更新（单 toolUseId 串行）
    //   - 简单可靠，避免子字段 schema 漂移
    //   - 性能可接受（一次审批往返通常 1~3 次 put）
    await col
      .where({
        projectKey,
        conversationId: entry.conversationId,
        toolUseId: entry.toolUseId,
      })
      .remove()

    await col.add({
      projectKey,
      conversationId: entry.conversationId,
      toolUseId: entry.toolUseId,
      toolName: entry.toolName,
      // CloudBase DB 透明转储 unknown：JSON-safe 字段（input 应该是 JSON 可序列化的）
      toolInput: entry.toolInput as unknown,
      createdAt: entry.createdAt,
      // CloudBase DB 不接受 undefined，pending 阶段用 null 显式表达
      decision: entry.decision ?? null,
      mtime: now,
    })
  }

  async get(args: {
    projectKey: string
    conversationId: string
    toolUseId: string
  }): Promise<PendingApproval | null> {
    const col = await this.getCollection()
    const { data } = await col
      .where({
        projectKey: args.projectKey,
        conversationId: args.conversationId,
        toolUseId: args.toolUseId,
      })
      .limit(1)
      .get()
    if (!data || data.length === 0) return null
    return rowToEntry(data[0])
  }

  async delete(args: {
    projectKey: string
    conversationId: string
    toolUseId: string
  }): Promise<void> {
    const col = await this.getCollection()
    await col
      .where({
        projectKey: args.projectKey,
        conversationId: args.conversationId,
        toolUseId: args.toolUseId,
      })
      .remove()
  }

  async scanRecent(args: {
    projectKey: string
    conversationId: string
    toolName: string
  }): Promise<PendingApproval | null> {
    const col = await this.getCollection()
    // CloudBase DB where 不支持 `decision != null` 字面量，需借 db.command.neq。
    // 先用动态 command 拿 ne(null)；失败时退化为客户端过滤（拉 limit=20 再筛）。
    let neqNullFilter: Record<string, unknown> | null = null
    try {
      const app = await this.getApp()
      const db = app.database() as unknown as { command: { neq?(v: unknown): unknown } }
      if (typeof db.command?.neq === 'function') {
        neqNullFilter = { decision: db.command.neq(null) }
      }
    } catch {
      // 忽略：退化客户端过滤
    }

    const baseFilter = {
      projectKey: args.projectKey,
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
      if (row['decision'] !== null && row['decision'] !== undefined) {
        return rowToEntry(row)
      }
    }
    return null
  }
}

/** CloudBase DB row → PendingApproval（处理 decision: null → undefined） */
function rowToEntry(row: Record<string, unknown>): PendingApproval {
  const decision = row['decision']
  return {
    conversationId: row['conversationId'] as string,
    toolUseId: row['toolUseId'] as string,
    toolName: row['toolName'] as string,
    toolInput: row['toolInput'],
    createdAt: row['createdAt'] as number,
    decision: decision === null || decision === undefined
      ? undefined
      : (decision as PendingApproval['decision']),
  }
}
