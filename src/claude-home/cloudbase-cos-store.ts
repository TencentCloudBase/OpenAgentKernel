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
 * 凭证由 options.credentials 显式注入；manager-node 不从环境变量兜底读取。
 *
 * `@cloudbase/manager-node` 按需懒加载。
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { InvalidConfigError, ResourceError } from '../internal/errors.js'
import { sha256OfBuffer } from './dedup.js'
import type { ClaudeHomeContext, ClaudeHomeSyncStore, RelativePath } from './types.js'

const KEY_PREFIX_TPL = (userId: string) => `oak/users/${userId}/claude-home/`

export interface CloudBaseCosCredentials {
  envId: string
  secretId: string
  secretKey: string
  sessionToken?: string
  region?: string
}

export interface CloudBaseCosClaudeHomeStoreOptions {
  credentials?: CloudBaseCosCredentials
}

interface ResolvedCredentials extends CloudBaseCosCredentials {
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

interface ManagerCtor {
  new (opts: {
    secretId: string
    secretKey: string
    envId: string
    token?: string
    region?: string
  }): CloudBaseManagerInstance
}

function resolveCredentials(opts?: CloudBaseCosClaudeHomeStoreOptions): ResolvedCredentials {
  const fromOpts = opts?.credentials
  const envId = fromOpts?.envId
  const secretId = fromOpts?.secretId
  const secretKey = fromOpts?.secretKey
  const sessionToken = fromOpts?.sessionToken
  const region = fromOpts?.region ?? 'ap-shanghai'

  if (!envId || !secretId || !secretKey) {
    throw new InvalidConfigError(
      'CloudBaseCosClaudeHomeStore requires platform credentials. ' +
        'Pass constructor option `credentials` or createAgent({ credentials }).',
    )
  }
  return { envId, secretId, secretKey, sessionToken, region }
}

function assertSafeKey(userId: string, fullKey: string): void {
  const expectedPrefix = KEY_PREFIX_TPL(userId)
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
  private manager: CloudBaseManagerInstance | null = null

  constructor(opts: CloudBaseCosClaudeHomeStoreOptions = {}) {
    this.creds = resolveCredentials(opts)
  }

  private async getManager(): Promise<CloudBaseManagerInstance> {
    if (this.manager) return this.manager

    // 与 src/storage/cloudbase-storage.ts 一致的懒加载模式:
    //   1) 用 new Function 绕过 tsup 静态打包(否则 ESM 入口找不到 @cloudbase/manager-node)
    //   2) `@cloudbase/manager-node` 是 CommonJS,ESM import 后真实导出在 mod.default
    const mod = await this.requireManagerNode()
    const Ctor = ((mod as { default?: unknown }).default ?? mod) as ManagerCtor
    if (typeof Ctor !== 'function') {
      throw new ResourceError(
        '@cloudbase/manager-node loaded but default export is not a constructor. ' +
          'Check the version (>= 4.0.0 required).',
      )
    }
    this.manager = new Ctor({
      secretId: this.creds.secretId,
      secretKey: this.creds.secretKey,
      envId: this.creds.envId,
      ...(this.creds.sessionToken ? { token: this.creds.sessionToken } : {}),
      region: this.creds.region,
    })
    return this.manager
  }

  private async requireManagerNode(): Promise<unknown> {
    try {
      // 必须用 new Function 包,避免 tsup 把 import('@cloudbase/manager-node')
      // 静态展开成相对路径(运行时 ESM 解析失败)。
      const dynamicImport = new Function('p', 'return import(p)') as (p: string) => Promise<unknown>
      return await dynamicImport('@cloudbase/manager-node')
    } catch {
      throw new ResourceError(
        'CloudBaseCosClaudeHomeStore failed to load @cloudbase/manager-node. ' +
          'Reinstall @cloudbase/open-agent-kernel or check your node_modules.',
      )
    }
  }

  async pull(ctx: ClaudeHomeContext, localDir: string): Promise<Map<RelativePath, string>> {
    const baseline = new Map<RelativePath, string>()
    const manager = await this.getManager()
    const prefix = KEY_PREFIX_TPL(ctx.userId)

    const listed = await manager.storage.walkCloudDir(prefix)

    await Promise.all(
      listed.map(async (item) => {
        const fileID = item.Key
        if (!fileID) return
        // walkCloudDir 会把"目录占位符"(以 / 结尾,Size=0)也列出来,跳过
        if (fileID.endsWith('/')) return
        const size = typeof item.Size === 'number' ? item.Size : Number(item.Size)
        if (Number.isFinite(size) && size === 0) return

        assertSafeKey(ctx.userId, fileID)
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
    const fullKey = KEY_PREFIX_TPL(ctx.userId) + relPath
    assertSafeKey(ctx.userId, fullKey)

    // manager-node 的 uploadFile 只接 localPath(底层 fs.createReadStream),
    // 我们要传 Buffer,所以走"临时文件桥接"。COS 上传后立即清理 tmp 文件。
    // 这是标准做法,几 KB 文档的 IO 开销可以忽略;避免依赖 manager-node 的
    // private getCos() 实现。
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oak-claude-home-put-'))
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
    const fullKey = KEY_PREFIX_TPL(ctx.userId) + relPath
    assertSafeKey(ctx.userId, fullKey)
    try {
      await manager.storage.deleteFile([fullKey])
    } catch (err) {
      // 文件不存在视为成功(idempotent delete)
      if (isFileNotExistError(err)) return
      throw err
    }
  }
}
