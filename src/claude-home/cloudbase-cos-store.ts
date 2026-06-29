/**
 * CloudBaseCosClaudeHomeStore: 生产实现,把 .claude/ 内容同步到 envId 对应的 COS 桶。
 *
 * COS key pattern: `oak/users/{userId}/claude-home/<relative-path>`
 *
 * SDK 选型:`@cloudbase/manager-node`(而非 `@cloudbase/node-sdk`)。
 *   - `@cloudbase/node-sdk`(服务端 SDK)**没有任何 list API** —— 顶层只有
 *     uploadFile/downloadFile/getTempFileURL/deleteFile/getFileInfo/copyFile/callApis,
 *     无法实现 pull 时的"枚举用户命名空间下的所有文件"。
 *   - `@cloudbase/manager-node`(管理端 SDK)的 `storage` 模块提供完整的
 *     `walkCloudDir / listDirectoryFiles / deleteFile / getTemporaryUrl` —— 是 OAK
 *     这种"遍历 + 双向同步"场景的正确选择。Monorepo 的 packages/server 也是用它做
 *     云存储管理的。
 *
 * 凭证支持两种方式:
 *   1. CAM 凭证 (secretId + secretKey) —— 直接传给 manager-node
 *   2. CloudBase API Key (CLOUDBASE_APIKEY) —— 调 capi/credential 换取临时 CAM 凭证,
 *      再传给 manager-node。临时凭证有过期时间,CredentialExchanger 自动刷新。
 */

import CloudBaseManager from '@cloudbase/manager-node'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { InvalidConfigError } from '../internal/errors.js'
import { sha256OfBuffer } from './dedup.js'
import { deriveSyncTmpDir } from './path-derivation.js'
import type { ClaudeHomeContext, ClaudeHomeSyncStore, RelativePath } from './types.js'

/**
 * COS key 前缀解析器。默认 userMemory 布局 `oak/users/<userId>/claude-home/`。
 * cwd 持久化注入自己的前缀(`oak/workspaces/sessions/<sessionId>/cwd/`)。
 */
export type CosKeyPrefixFn = (ctx: ClaudeHomeContext) => string

const DEFAULT_KEY_PREFIX: CosKeyPrefixFn = (ctx) => `oak/users/${ctx.userId}/claude-home/`

export interface CloudBaseCosCredentials {
  envId: string
  secretId?: string
  secretKey?: string
  sessionToken?: string
  region?: string
  /** CloudBase API Key — 没有 CAM 凭证时用 API Key 换临时密钥 */
  apiKey?: string
}

export interface CloudBaseCosClaudeHomeStoreOptions {
  credentials?: CloudBaseCosCredentials
  /** COS key 前缀解析器。默认 userMemory 布局。 */
  keyPrefix?: CosKeyPrefixFn
}

interface ResolvedCredentials {
  envId: string
  secretId?: string
  secretKey?: string
  sessionToken?: string
  apiKey?: string
  region: string
}

/**
 * 我们使用的 manager-node 子集(精简过的类型)。完整签名见
 * @cloudbase/manager-node/types/storage/index.d.ts
 */
interface ManagerStorage {
  uploadFile(args: { localPath: string; cloudPath: string }): Promise<unknown>
  walkCloudDir(prefix: string): Promise<Array<{ Key: string; Size: string | number }>>
  getTemporaryUrl(
    fileList: Array<{ cloudPath: string; maxAge?: number }>,
  ): Promise<Array<{ fileId: string; url: string }>>
  deleteFile(cloudPathList: string[]): Promise<unknown>
}

interface CloudBaseManagerInstance {
  storage: ManagerStorage
}

// ── API Key → 临时 CAM 凭证交换 ───────────────────────────────

interface TempCredentials {
  secretId: string
  secretKey: string
  sessionToken: string
  expiredTime: number // 毫秒时间戳
}

const credentialCache = new Map<string, TempCredentials & { promise?: Promise<TempCredentials> }>()

/**
 * 用 CloudBase API Key 换取临时 CAM 凭证。
 *
 * 调用 `https://{envId}.{region}.tcb-api.tencentcloudapi.com/capi/credential`，
 * 返回 { TmpSecretId, TmpSecretKey, Token, ExpiredTime }。
 * 结果按 envId 缓存，过期前 5 分钟自动刷新。
 */
async function exchangeApiKeyForCredentials(envId: string, apiKey: string, region: string): Promise<TempCredentials> {
  const cacheKey = `${envId}:${apiKey}`
  const cached = credentialCache.get(cacheKey)
  const now = Date.now()

  // 缓存有效（还有 5 分钟才过期）
  if (cached && cached.expiredTime - now > 5 * 60 * 1000) {
    return cached
  }

  // 防止并发重复请求
  if (cached?.promise) {
    return cached.promise
  }

  const promise = (async (): Promise<TempCredentials> => {
    const baseUrl = process.env.CLOUDBASE_API_ENDPOINT ?? `https://${envId}.${region}.tcb-api.tencentcloudapi.com`
    const url = `${baseUrl}/capi/credential`

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ env: envId }),
    })

    if (!res.ok) {
      throw new InvalidConfigError(`API Key 换取临时密钥失败: HTTP ${res.status} ${res.statusText}`)
    }

    const body = (await res.json()) as {
      code: number
      message?: string
      msg?: string
      data?: {
        TmpSecretId: string
        TmpSecretKey: string
        Token: string
        ExpiredTime: number // 秒级时间戳
      }
    }

    if (body.code !== 0) {
      throw new InvalidConfigError(`API Key 换取临时密钥失败: ${body.message ?? body.msg ?? `code=${body.code}`}`)
    }

    if (!body.data?.TmpSecretId || !body.data?.TmpSecretKey || !body.data?.Token) {
      throw new InvalidConfigError('API Key 换取临时密钥返回数据不完整，请检查 API Key 是否有效')
    }

    const result: TempCredentials = {
      secretId: body.data.TmpSecretId,
      secretKey: body.data.TmpSecretKey,
      sessionToken: body.data.Token,
      expiredTime: body.data.ExpiredTime * 1000, // 秒 → 毫秒
    }

    credentialCache.set(cacheKey, { ...result, promise: undefined })
    return result
  })()

  // 暂存 promise 防止并发
  credentialCache.set(cacheKey, { secretId: '', secretKey: '', sessionToken: '', expiredTime: 0, promise })

  try {
    return await promise
  } finally {
    const entry = credentialCache.get(cacheKey)
    if (entry) entry.promise = undefined
  }
}

function resolveCredentials(opts?: CloudBaseCosClaudeHomeStoreOptions): ResolvedCredentials {
  const fromOpts = opts?.credentials
  const envId = fromOpts?.envId
  if (!envId) {
    throw new InvalidConfigError(
      'CloudBaseCosClaudeHomeStore requires envId. ' +
        'Pass constructor option `credentials.envId` or createAgent({ credentials }).',
    )
  }

  const secretId = fromOpts?.secretId
  const secretKey = fromOpts?.secretKey
  const apiKey = fromOpts?.apiKey ?? process.env.CLOUDBASE_APIKEY
  const region = fromOpts?.region ?? 'ap-shanghai'

  // 需要至少一种凭证：CAM (secretId+secretKey) 或 API Key
  if (!secretId && !secretKey && !apiKey) {
    throw new InvalidConfigError(
      'CloudBaseCosClaudeHomeStore requires credentials. Set one of:\n' +
        '  - credentials.secretId + credentials.secretKey (CAM)\n' +
        '  - credentials.apiKey or CLOUDBASE_APIKEY env (exchanged for temp CAM)\n' +
        '  - createAgent({ credentials })',
    )
  }

  return {
    envId,
    ...(secretId ? { secretId } : {}),
    ...(secretKey ? { secretKey } : {}),
    ...(fromOpts?.sessionToken ? { sessionToken: fromOpts.sessionToken } : {}),
    ...(apiKey ? { apiKey } : {}),
    region,
  }
}

function assertSafeKey(expectedPrefix: string, fullKey: string): void {
  if (!fullKey.startsWith(expectedPrefix)) {
    throw new Error(`assertSafeKey: ${fullKey} does not start with ${expectedPrefix}`)
  }
  if (fullKey.includes('..')) {
    throw new Error(`assertSafeKey: ${fullKey} contains traversal segment`)
  }
}

/**
 * delete 视为成功的 COS 错误码集合。
 * 不同 SDK 路径(node-sdk vs manager-node vs cos-nodejs-sdk-v5)对"文件不存在"返回的
 * 错误名/code 不一致,统一在这里收口。
 */
const DELETE_NOT_EXIST_CODES = new Set(['STORAGE.FileNotFound', 'STORAGE_FILE_NONEXIST', 'NoSuchKey'])

function isFileNotExistError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: string; name?: string; message?: string; statusCode?: number }
  if (e.code && DELETE_NOT_EXIST_CODES.has(e.code)) return true
  if (e.name && DELETE_NOT_EXIST_CODES.has(e.name)) return true
  // COS HTTP 404 兜底
  if (e.statusCode === 404) return true
  // 文案兜底(部分版本只塞 message)
  if (typeof e.message === 'string' && /no such key|file.*not.*exist|nonexist/i.test(e.message)) return true
  return false
}

export class CloudBaseCosClaudeHomeStore implements ClaudeHomeSyncStore {
  private readonly creds: ResolvedCredentials
  private readonly keyPrefix: CosKeyPrefixFn
  private manager: CloudBaseManagerInstance | null = null

  constructor(opts: CloudBaseCosClaudeHomeStoreOptions = {}) {
    this.creds = resolveCredentials(opts)
    this.keyPrefix = opts.keyPrefix ?? DEFAULT_KEY_PREFIX
  }

  private async getManager(): Promise<CloudBaseManagerInstance> {
    if (this.manager) return this.manager

    let secretId = this.creds.secretId
    let secretKey = this.creds.secretKey
    let sessionToken = this.creds.sessionToken

    // 没有 CAM 凭证但有 API Key → 换取临时凭证
    if ((!secretId || !secretKey) && this.creds.apiKey) {
      const temp = await exchangeApiKeyForCredentials(this.creds.envId, this.creds.apiKey, this.creds.region)
      secretId = temp.secretId
      secretKey = temp.secretKey
      sessionToken = temp.sessionToken
    }

    this.manager = new CloudBaseManager({
      secretId: secretId!,
      secretKey: secretKey!,
      envId: this.creds.envId,
      ...(sessionToken ? { token: sessionToken } : {}),
      region: this.creds.region,
    }) as unknown as CloudBaseManagerInstance
    return this.manager
  }

  async pull(ctx: ClaudeHomeContext, localDir: string): Promise<Map<RelativePath, string>> {
    const baseline = new Map<RelativePath, string>()
    const manager = await this.getManager()
    const prefix = this.keyPrefix(ctx)

    const listed = await manager.storage.walkCloudDir(prefix)

    await Promise.all(
      listed.map(async (item) => {
        const fileID = item.Key
        if (!fileID) return
        // walkCloudDir 会把"目录占位符"(以 / 结尾,Size=0)也列出来,跳过
        if (fileID.endsWith('/')) return
        const size = typeof item.Size === 'number' ? item.Size : Number(item.Size)
        if (Number.isFinite(size) && size === 0) return

        assertSafeKey(prefix, fileID)
        const relPath = fileID.substring(prefix.length)
        if (!relPath) return

        const urlRes = await manager.storage.getTemporaryUrl([{ cloudPath: fileID, maxAge: 600 }])
        const url = urlRes?.[0]?.url
        if (!url) return
        const resp = await fetch(url)
        if (!resp.ok) throw new Error(`pull failed for ${fileID}: ${resp.status}`)
        const buf = Buffer.from(await resp.arrayBuffer())

        const localPath = path.join(localDir, relPath)
        await fs.mkdir(path.dirname(localPath), { recursive: true })
        await fs.writeFile(localPath, buf)
        baseline.set(relPath, sha256OfBuffer(buf))
      }),
    )

    return baseline
  }

  async put(ctx: ClaudeHomeContext, relPath: RelativePath, content: Buffer): Promise<void> {
    const manager = await this.getManager()
    const prefix = this.keyPrefix(ctx)
    const fullKey = prefix + relPath
    assertSafeKey(prefix, fullKey)

    // manager-node 的 uploadFile 只接 localPath(底层 fs.createReadStream),
    // 我们要传 Buffer,所以走"临时文件桥接"。COS 上传后立即清理 tmp 文件。
    const syncRoot = deriveSyncTmpDir()
    await fs.mkdir(syncRoot, { recursive: true })
    const tmpDir = await fs.mkdtemp(path.join(syncRoot, 'put-'))
    const tmpFile = path.join(tmpDir, 'payload')
    try {
      await fs.writeFile(tmpFile, content)
      await manager.storage.uploadFile({ localPath: tmpFile, cloudPath: fullKey })
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  async delete(ctx: ClaudeHomeContext, relPath: RelativePath): Promise<void> {
    const manager = await this.getManager()
    const prefix = this.keyPrefix(ctx)
    const fullKey = prefix + relPath
    assertSafeKey(prefix, fullKey)
    try {
      await manager.storage.deleteFile([fullKey])
    } catch (err) {
      if (isFileNotExistError(err)) return
      throw err
    }
  }

  async getObject(ctx: ClaudeHomeContext, relPath: RelativePath): Promise<Buffer | null> {
    const manager = await this.getManager()
    const prefix = this.keyPrefix(ctx)
    const fullKey = prefix + relPath
    assertSafeKey(prefix, fullKey)
    const urlRes = await manager.storage
      .getTemporaryUrl([{ cloudPath: fullKey, maxAge: 600 }])
      .catch((err: unknown) => {
        if (isFileNotExistError(err)) return null
        throw err
      })
    if (!urlRes?.[0]?.url) return null
    const resp = await fetch(urlRes[0].url)
    if (resp.status === 404) return null
    if (!resp.ok) throw new Error(`getObject failed for ${fullKey}: ${resp.status}`)
    return Buffer.from(await resp.arrayBuffer())
  }
}
