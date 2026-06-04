/**
 * CloudBaseCosClaudeHomeStore: 生产实现,把 .claude/ 内容同步到 envId 对应的 COS 桶。
 *
 * COS key pattern: `oak/users/{userId}/claude-home/<relative-path>`
 *
 * 凭证派生(与 CloudBaseStorage 一致):
 *   1. options.credentials(编程注入)
 *   2. process.env: TCB_ENV_ID + TCB_SECRET_ID + TCB_SECRET_KEY (+ TCB_TOKEN)
 *
 * `@cloudbase/node-sdk` 是 optional peer dep,按需懒加载。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { ResourceError } from '../internal/errors.js'
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

interface CloudBaseApp {
  uploadFile(args: { cloudPath: string; fileContent: Uint8Array | Buffer }): Promise<{ fileID: string }>
  getTempFileURL(args: { fileList: Array<string> }): Promise<{
    fileList: Array<{ fileID: string; tempFileURL: string; code?: string }>
  }>
  deleteFile(args: { fileList: Array<string> }): Promise<{
    fileList: Array<{ fileID: string; code?: string }>
  }>
  getStorage?(): {
    listDirectoryFiles(prefix: string): Promise<Array<{ Key: string; Size: number }>>
  }
}

function resolveCredentials(opts?: CloudBaseCosClaudeHomeStoreOptions): ResolvedCredentials {
  const fromOpts = opts?.credentials
  const envId = fromOpts?.envId ?? process.env.TCB_ENV_ID
  const secretId = fromOpts?.secretId ?? process.env.TCB_SECRET_ID
  const secretKey = fromOpts?.secretKey ?? process.env.TCB_SECRET_KEY
  const sessionToken = fromOpts?.sessionToken ?? process.env.TCB_TOKEN ?? undefined
  const region = fromOpts?.region ?? process.env.TCB_REGION ?? 'ap-shanghai'

  if (!envId || !secretId || !secretKey) {
    throw new ResourceError(
      'CloudBase credentials missing for CloudBaseCosClaudeHomeStore. Set one of:\n' +
        '  - process.env: TCB_ENV_ID + TCB_SECRET_ID + TCB_SECRET_KEY\n' +
        '  - constructor option `credentials`',
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

export class CloudBaseCosClaudeHomeStore implements ClaudeHomeSyncStore {
  private readonly creds: ResolvedCredentials
  private app: CloudBaseApp | null = null

  constructor(opts: CloudBaseCosClaudeHomeStoreOptions = {}) {
    this.creds = resolveCredentials(opts)
  }

  private async getApp(): Promise<CloudBaseApp> {
    if (this.app) return this.app
    // 与 src/storage/cloudbase-storage.ts 一致的懒加载模式:
    //   1) 用 new Function 绕过 tsup 静态打包(否则 ESM 入口找不到 @cloudbase/node-sdk)
    //   2) `@cloudbase/node-sdk` 是 CommonJS,ESM import 后真实导出在 mod.default
    const mod = await this.requireCloudBase()
    const init = (mod.default ?? mod) as { init?: (opts: Record<string, unknown>) => CloudBaseApp }
    if (typeof init.init !== 'function') {
      throw new ResourceError(
        '@cloudbase/node-sdk loaded but `.init()` not available. Check the version (>= 3.0.0 required).',
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
      // 必须用 new Function 包,避免 tsup 把 import('@cloudbase/node-sdk')
      // 静态展开成相对路径(运行时 ESM 解析失败)。
      const dynamicImport = new Function('p', 'return import(p)') as (
        p: string,
      ) => Promise<{ default?: unknown; init?: unknown }>
      return await dynamicImport('@cloudbase/node-sdk')
    } catch {
      throw new ResourceError(
        'CloudBaseCosClaudeHomeStore requires @cloudbase/node-sdk. Install via:\n  pnpm add @cloudbase/node-sdk',
      )
    }
  }

  async pull(ctx: ClaudeHomeContext, localDir: string): Promise<Map<RelativePath, string>> {
    const baseline = new Map<RelativePath, string>()
    const app = await this.getApp()
    const prefix = KEY_PREFIX_TPL(ctx.userId)

    const storage = app.getStorage?.()
    if (!storage) {
      // SDK 不暴露 listDirectoryFiles → 视为 namespace 空(graceful)
      return baseline
    }
    const listed = await storage.listDirectoryFiles(prefix)

    await Promise.all(
      listed.map(async (item) => {
        if (item.Size === 0) return // 目录占位文件
        const fileID = item.Key
        assertSafeKey(ctx.userId, fileID)
        const relPath = fileID.substring(prefix.length)
        if (!relPath) return

        const urlRes = await app.getTempFileURL({ fileList: [fileID] })
        const url = urlRes.fileList?.[0]?.tempFileURL
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
    const app = await this.getApp()
    const fullKey = KEY_PREFIX_TPL(ctx.userId) + relPath
    assertSafeKey(ctx.userId, fullKey)
    await app.uploadFile({ cloudPath: fullKey, fileContent: content })
  }

  async delete(ctx: ClaudeHomeContext, relPath: RelativePath): Promise<void> {
    const app = await this.getApp()
    const fullKey = KEY_PREFIX_TPL(ctx.userId) + relPath
    assertSafeKey(ctx.userId, fullKey)
    const result = await app.deleteFile({ fileList: [fullKey] })
    const item = result.fileList?.[0]
    if (item?.code && item.code !== 'SUCCESS' && item.code !== 'STORAGE.FileNotFound') {
      throw new Error(`COS delete failed for ${fullKey}: ${item.code}`)
    }
  }
}
