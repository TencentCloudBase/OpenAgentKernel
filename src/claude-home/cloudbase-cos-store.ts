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
const MANIFEST_KEY_TPL = (userId: string) => `oak/users/${userId}/claude-home-manifest.json`
const MANIFEST_VERSION = 1 as const

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

export interface CloudBaseAccessKeyClaudeHomeStoreOptions {
  envId: string
  accessKey: string
}

interface CloudBaseStorageApp {
  uploadFile(args: { cloudPath: string; fileContent: Buffer }): Promise<{ fileID: string }>
  getUploadMetadata(args: { cloudPath: string }): Promise<{ data?: { fileId?: string } }>
  getTempFileURL(args: { fileList: Array<{ fileID: string; maxAge: number }> }): Promise<{
    code?: string
    message?: string
    fileList?: Array<{ fileID?: string; tempFileURL?: string; code?: string }>
  }>
  deleteFile(args: { fileList: string[] }): Promise<{
    code?: string
    message?: string
    fileList?: Array<{ fileID?: string; code?: string }>
  }>
}

interface ClaudeHomeManifestEntry {
  path: RelativePath
  fileID: string
  sha256: string
  mtimeMs: number
}

interface ClaudeHomeManifest {
  version: typeof MANIFEST_VERSION
  files: ClaudeHomeManifestEntry[]
}

interface LoadedManifest {
  manifest: ClaudeHomeManifest
  prefetched: Map<RelativePath, { fileID: string; content: Buffer }>
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

function isSafeRelativePath(relPath: string): boolean {
  if (!relPath || relPath.startsWith('/') || relPath.includes('\\') || relPath.includes('\0')) return false
  const segments = relPath.split('/')
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function assertSafeRelativePath(relPath: RelativePath): void {
  if (!isSafeRelativePath(relPath)) {
    throw new InvalidConfigError(
      `Invalid Claude home relative path "${relPath}". Paths must be non-empty, relative, and contain no traversal segments.`,
    )
  }
}

function assertSafeAccessKeyContext(expectedEnvId: string, ctx: ClaudeHomeContext): void {
  if (ctx.envId !== expectedEnvId) {
    throw new InvalidConfigError(
      `CloudBaseAccessKeyClaudeHomeStore was initialized for envId="${expectedEnvId}" but received envId="${ctx.envId}".`,
    )
  }
  if (!ctx.userId || ctx.userId.includes('/') || ctx.userId.includes('\\') || ctx.userId.includes('..')) {
    throw new InvalidConfigError('Claude home userId must be non-empty and contain no path separators or traversal segments.')
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

function isFileNotExistCode(code: unknown): boolean {
  return typeof code === 'string' && DELETE_NOT_EXIST_CODES.has(code)
}

function compareManifestEntries(a: ClaudeHomeManifestEntry, b: ClaudeHomeManifestEntry): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

function parseManifest(content: Buffer, manifestKey: string): ClaudeHomeManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(content.toString('utf8'))
  } catch (err) {
    throw new ResourceError(`Invalid user-memory manifest JSON at ${manifestKey}.`, err)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ResourceError(`Invalid user-memory manifest at ${manifestKey}: expected an object.`)
  }
  const candidate = parsed as { version?: unknown; files?: unknown }
  if (candidate.version !== MANIFEST_VERSION) {
    throw new ResourceError(
      `Unsupported user-memory manifest version at ${manifestKey}: expected ${MANIFEST_VERSION}, got ${String(candidate.version)}.`,
    )
  }
  if (!Array.isArray(candidate.files)) {
    throw new ResourceError(`Invalid user-memory manifest at ${manifestKey}: "files" must be an array.`)
  }

  const seen = new Set<string>()
  const files = candidate.files.map((value, index): ClaudeHomeManifestEntry => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ResourceError(`Invalid user-memory manifest entry ${index} at ${manifestKey}.`)
    }
    const entry = value as Partial<ClaudeHomeManifestEntry>
    if (
      typeof entry.path !== 'string' ||
      !isSafeRelativePath(entry.path) ||
      typeof entry.fileID !== 'string' ||
      entry.fileID.length === 0 ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(entry.sha256) ||
      typeof entry.mtimeMs !== 'number' ||
      !Number.isFinite(entry.mtimeMs) ||
      entry.mtimeMs < 0
    ) {
      throw new ResourceError(`Invalid user-memory manifest entry ${index} at ${manifestKey}.`)
    }
    if (seen.has(entry.path)) {
      throw new ResourceError(`Duplicate user-memory manifest path "${entry.path}" at ${manifestKey}.`)
    }
    seen.add(entry.path)
    return {
      path: entry.path,
      fileID: entry.fileID,
      sha256: entry.sha256.toLowerCase(),
      mtimeMs: entry.mtimeMs,
    }
  })

  files.sort(compareManifestEntries)
  return { version: MANIFEST_VERSION, files }
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

/**
 * CloudBase node-sdk storage data-plane implementation for TCB_API_KEY mode.
 *
 * node-sdk cannot list a directory, so the sidecar manifest is the authoritative
 * index for objects below `claude-home/`. The sidecar deliberately lives outside
 * that prefix: the manager-node store walks the prefix, and placing the manifest
 * inside it would make the sync engine treat the manifest as user data.
 *
 * A data upload is committed before its manifest entry. A failed manifest write
 * can therefore leave an orphan, while readers may observe the previous entry;
 * pull hashes downloaded bytes and repairs stale hashes/missing entries. Calls on
 * one store instance are serialized below because sync-engine uploads/deletes a
 * turn concurrently. Across instances/processes, callers must follow the SDK README
 * convention that requests for the same userId are serialized. node-sdk exposes no
 * conditional manifest write with which to implement a safe cross-node CAS.
 */
export class CloudBaseAccessKeyClaudeHomeStore implements ClaudeHomeSyncStore {
  private readonly envId: string
  private readonly accessKey: string
  private app: CloudBaseStorageApp | null = null
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(opts: CloudBaseAccessKeyClaudeHomeStoreOptions) {
    if (!opts.envId || typeof opts.envId !== 'string' || !opts.accessKey || typeof opts.accessKey !== 'string') {
      throw new InvalidConfigError(
        'CloudBaseAccessKeyClaudeHomeStore requires non-empty constructor options `envId` and `accessKey`.',
      )
    }
    this.envId = opts.envId
    this.accessKey = opts.accessKey
  }

  private async getApp(): Promise<CloudBaseStorageApp> {
    if (this.app) return this.app
    const mod = await this.requireCloudBase()
    const sdk = (mod.default ?? mod) as { init?: (opts: Record<string, unknown>) => CloudBaseStorageApp }
    if (typeof sdk.init !== 'function') {
      throw new ResourceError(
        '@cloudbase/node-sdk loaded but `.init()` not available. Check the version (>= 3.0.0 required).',
      )
    }
    this.app = sdk.init({ env: this.envId, accessKey: this.accessKey })
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

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation)
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async resolveFileID(app: CloudBaseStorageApp, cloudPath: string): Promise<string> {
    let metadata: Awaited<ReturnType<CloudBaseStorageApp['getUploadMetadata']>>
    try {
      metadata = await app.getUploadMetadata({ cloudPath })
    } catch (err) {
      throw new ResourceError(`Failed to resolve CloudBase fileID for cloudPath=${cloudPath}.`, err)
    }
    const fileID = metadata.data?.fileId
    if (!fileID) {
      throw new ResourceError(`CloudBase getUploadMetadata returned no fileId for cloudPath=${cloudPath}.`)
    }
    return fileID
  }

  private async downloadByFileID(
    app: CloudBaseStorageApp,
    fileID: string,
    label: string,
  ): Promise<Buffer | undefined> {
    let result: Awaited<ReturnType<CloudBaseStorageApp['getTempFileURL']>>
    try {
      result = await app.getTempFileURL({ fileList: [{ fileID, maxAge: 600 }] })
    } catch (err) {
      if (isFileNotExistError(err)) return undefined
      throw err
    }

    if (isFileNotExistCode(result.code)) return undefined
    if (result.code && result.code !== 'SUCCESS') {
      throw new ResourceError(
        `CloudBase getTempFileURL failed for ${label}: ${result.code} ${result.message ?? ''}`.trim(),
      )
    }
    const item = result.fileList?.[0]
    if (isFileNotExistCode(item?.code)) return undefined
    if (item?.code && item.code !== 'SUCCESS') {
      throw new ResourceError(`CloudBase getTempFileURL failed for ${label}: ${item.code}`)
    }
    const url = item?.tempFileURL
    if (!url) {
      throw new ResourceError(`CloudBase getTempFileURL returned no URL for ${label}.`)
    }

    const response = await fetch(url)
    if (response.status === 404) return undefined
    if (!response.ok) {
      throw new ResourceError(`CloudBase user-memory download failed for ${label}: HTTP ${response.status}.`)
    }
    return Buffer.from(await response.arrayBuffer())
  }

  private async downloadCloudPath(
    app: CloudBaseStorageApp,
    cloudPath: string,
  ): Promise<{ fileID: string; content: Buffer | undefined }> {
    // getUploadMetadata is the public way to map cloudPath to the real bucket-shaped
    // fileID. It may return an ID for an object that has not been uploaded, so only
    // getTempFileURL/fetch 404 below determines existence.
    const fileID = await this.resolveFileID(app, cloudPath)
    const content = await this.downloadByFileID(app, fileID, cloudPath)
    return { fileID, content }
  }

  private async deleteByFileID(app: CloudBaseStorageApp, fileID: string): Promise<void> {
    try {
      const result = await app.deleteFile({ fileList: [fileID] })
      if (isFileNotExistCode(result.code)) return
      if (result.code && result.code !== 'SUCCESS') {
        throw new ResourceError(`CloudBase deleteFile failed for fileID=${fileID}: ${result.code}`)
      }
      const item = result.fileList?.[0]
      if (isFileNotExistCode(item?.code)) return
      if (item?.code && item.code !== 'SUCCESS') {
        throw new ResourceError(`CloudBase deleteFile failed for fileID=${fileID}: ${item.code}`)
      }
    } catch (err) {
      if (isFileNotExistError(err)) return
      throw err
    }
  }

  private async writeManifest(
    app: CloudBaseStorageApp,
    ctx: ClaudeHomeContext,
    manifest: ClaudeHomeManifest,
  ): Promise<void> {
    const manifestKey = MANIFEST_KEY_TPL(ctx.userId)
    const files = [...manifest.files].sort(compareManifestEntries)
    if (files.length === 0) {
      const manifestFileID = await this.resolveFileID(app, manifestKey)
      await this.deleteByFileID(app, manifestFileID)
      return
    }
    await app.uploadFile({
      cloudPath: manifestKey,
      fileContent: Buffer.from(JSON.stringify({ version: MANIFEST_VERSION, files }, null, 2) + '\n', 'utf8'),
    })
  }

  private async readManifestOrRecoverLegacy(
    app: CloudBaseStorageApp,
    ctx: ClaudeHomeContext,
  ): Promise<LoadedManifest> {
    const manifestKey = MANIFEST_KEY_TPL(ctx.userId)
    const manifestObject = await this.downloadCloudPath(app, manifestKey)
    let manifest: ClaudeHomeManifest = manifestObject.content
      ? parseManifest(manifestObject.content, manifestKey)
      : { version: MANIFEST_VERSION, files: [] }
    const prefetched: LoadedManifest['prefetched'] = new Map()

    // Reconcile the one deterministic legacy path even when a manifest already
    // exists. A CAM/manager-node writer does not update this sidecar, so it may
    // create CLAUDE.md after an accessKey writer has already created a manifest.
    // projects/* and agent-memory/* still cannot be recovered without a list API.
    const legacyPath = 'CLAUDE.md'
    if (manifest.files.some((entry) => entry.path === legacyPath)) {
      return { manifest, prefetched }
    }

    const legacyObject = await this.downloadCloudPath(app, KEY_PREFIX_TPL(ctx.userId) + legacyPath)
    if (!legacyObject.content) {
      return { manifest, prefetched }
    }

    const entry: ClaudeHomeManifestEntry = {
      path: legacyPath,
      fileID: legacyObject.fileID,
      sha256: sha256OfBuffer(legacyObject.content),
      mtimeMs: Date.now(),
    }
    manifest = { version: MANIFEST_VERSION, files: [...manifest.files, entry] }
    await this.writeManifest(app, ctx, manifest)
    prefetched.set(legacyPath, { fileID: legacyObject.fileID, content: legacyObject.content })
    return { manifest, prefetched }
  }

  async pull(ctx: ClaudeHomeContext, localDir: string): Promise<Map<RelativePath, string>> {
    return this.enqueueMutation(async () => {
      assertSafeAccessKeyContext(this.envId, ctx)
      const app = await this.getApp()
      const loaded = await this.readManifestOrRecoverLegacy(app, ctx)
      const baseline = new Map<RelativePath, string>()
      const repairedEntries: ClaudeHomeManifestEntry[] = []
      let manifestChanged = false

      for (const entry of loaded.manifest.files) {
        // Manifest fileID is an untrusted cache, never an authorization boundary.
        // Bind the validated relative path back to this user's namespace and ask
        // CloudBase for the real bucket-shaped fileID before every read.
        const cloudPath = KEY_PREFIX_TPL(ctx.userId) + entry.path
        const actualFileID = await this.resolveFileID(app, cloudPath)
        const prefetched = loaded.prefetched.get(entry.path)
        const content =
          prefetched?.fileID === actualFileID
            ? prefetched.content
            : await this.downloadByFileID(app, actualFileID, cloudPath)
        if (!content) {
          manifestChanged = true
          continue
        }
        const actualHash = sha256OfBuffer(content)
        let repaired = entry
        if (actualHash !== entry.sha256) {
          // Content changed outside this manifest (for example a later CAM write):
          // hash and modification time must advance together.
          repaired = { ...entry, fileID: actualFileID, sha256: actualHash, mtimeMs: Date.now() }
        } else if (actualFileID !== entry.fileID) {
          // Only the cached physical ID was stale; logical content did not change.
          repaired = { ...entry, fileID: actualFileID }
        }
        if (repaired !== entry) manifestChanged = true
        repairedEntries.push(repaired)

        const localPath = path.join(localDir, entry.path)
        await fs.mkdir(path.dirname(localPath), { recursive: true })
        await fs.writeFile(localPath, content)
        baseline.set(entry.path, actualHash)
      }

      if (manifestChanged) {
        await this.writeManifest(app, ctx, { version: MANIFEST_VERSION, files: repairedEntries })
      }
      return baseline
    })
  }

  async put(ctx: ClaudeHomeContext, relPath: RelativePath, content: Buffer): Promise<void> {
    return this.enqueueMutation(async () => {
      assertSafeAccessKeyContext(this.envId, ctx)
      assertSafeRelativePath(relPath)
      const app = await this.getApp()
      const cloudPath = KEY_PREFIX_TPL(ctx.userId) + relPath
      const uploaded = await app.uploadFile({ cloudPath, fileContent: content })
      if (!uploaded.fileID) {
        throw new ResourceError(`CloudBase uploadFile returned no fileID for cloudPath=${cloudPath}.`)
      }

      const loaded = await this.readManifestOrRecoverLegacy(app, ctx)
      const byPath = new Map(loaded.manifest.files.map((entry) => [entry.path, entry]))
      byPath.set(relPath, {
        path: relPath,
        fileID: uploaded.fileID,
        sha256: sha256OfBuffer(content),
        mtimeMs: Date.now(),
      })
      await this.writeManifest(app, ctx, { version: MANIFEST_VERSION, files: [...byPath.values()] })
    })
  }

  async delete(ctx: ClaudeHomeContext, relPath: RelativePath): Promise<void> {
    return this.enqueueMutation(async () => {
      assertSafeAccessKeyContext(this.envId, ctx)
      assertSafeRelativePath(relPath)
      const app = await this.getApp()
      const loaded = await this.readManifestOrRecoverLegacy(app, ctx)
      const entry = loaded.manifest.files.find((candidate) => candidate.path === relPath)
      // As in pull(), never let an untrusted/stale manifest fileID select the
      // delete target. The validated logical path is the sole authority.
      const cloudPath = KEY_PREFIX_TPL(ctx.userId) + relPath
      const actualFileID = await this.resolveFileID(app, cloudPath)
      await this.deleteByFileID(app, actualFileID)

      if (entry) {
        await this.writeManifest(app, ctx, {
          version: MANIFEST_VERSION,
          files: loaded.manifest.files.filter((candidate) => candidate.path !== relPath),
        })
      }
    })
  }
}
