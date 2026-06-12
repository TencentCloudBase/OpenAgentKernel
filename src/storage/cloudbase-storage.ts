/**
 * CloudBaseStorage：把 attachment 上传到 CloudBase 云存储（COS），
 * 给 SDK 返回 url source（短 payload + 长期可访问）。
 *
 * 凭证模式：
 *   - 推荐通过 CloudBaseStorageOptions.credentials 显式注入
 *   - 不传时不做 env fallback，由 @cloudbase/node-sdk 自身处理运行环境认证
 *
 * 路径策略：
 *   `agent-attachments/{envId}/{sessionId}/{timestamp}-{index}.{ext}`
 *
 * `@cloudbase/node-sdk` 是 optional peer dep，按需懒加载（与 CloudBaseDbDriver 一致）。
 */

import * as fs from 'node:fs/promises'
import { ResourceError, StorageError } from '../internal/errors.js'
import type { AttachmentInput } from '../public/types.js'
import { assertSupportedImageMime, guessMimeFromBytes, guessMimeFromPath } from './mime.js'
import type { ResolveContext, ResolvedAttachment, StorageProvider } from './types.js'

export interface CloudBaseStorageCredentials {
  envId: string
  secretId: string
  secretKey: string
  sessionToken?: string
  region?: string
}

export interface CloudBaseStorageOptions {
  credentials?: CloudBaseStorageCredentials
  /** 云存储路径前缀（默认 `agent-attachments/`） */
  pathPrefix?: string
  /** 临时签名 URL 有效期（秒，默认 3600） */
  urlExpiresIn?: number
}

const DEFAULT_PATH_PREFIX = 'agent-attachments/'
const DEFAULT_URL_EXPIRES_IN = 3600 // 1 hour

interface ResolvedCredentials extends Partial<CloudBaseStorageCredentials> {
  region: string
}

interface CloudBaseApp {
  uploadFile(args: { cloudPath: string; fileContent: Uint8Array | Buffer }): Promise<{ fileID: string }>
  getTempFileURL(args: { fileList: Array<string | { fileID: string; maxAge?: number }> }): Promise<{
    fileList: Array<{ fileID: string; tempFileURL: string; code?: string }>
  }>
}

function resolveCredentials(opts?: CloudBaseStorageOptions): ResolvedCredentials {
  const creds = opts?.credentials
  return {
    ...(creds?.envId ? { envId: creds.envId } : {}),
    ...(creds?.secretId ? { secretId: creds.secretId } : {}),
    ...(creds?.secretKey ? { secretKey: creds.secretKey } : {}),
    ...(creds?.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    region: creds?.region ?? 'ap-shanghai',
  }
}

export class CloudBaseStorage implements StorageProvider {
  private readonly creds: ResolvedCredentials
  private readonly pathPrefix: string
  private readonly urlExpiresIn: number
  private app: CloudBaseApp | null = null

  constructor(opts: CloudBaseStorageOptions = {}) {
    this.creds = resolveCredentials(opts)
    this.pathPrefix = opts.pathPrefix ?? DEFAULT_PATH_PREFIX
    this.urlExpiresIn = opts.urlExpiresIn ?? DEFAULT_URL_EXPIRES_IN
  }

  // ─── 懒加载 @cloudbase/node-sdk ────────────────────────────────

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
        '@cloudbase/node-sdk is not installed. Add it as a dependency:\n' + '  pnpm add @cloudbase/node-sdk',
      )
    }
  }

  // ─── StorageProvider 接口实现 ──────────────────────────────────

  async resolveAttachment(att: AttachmentInput, ctx: ResolveContext): Promise<ResolvedAttachment> {
    if (att.type === 'url') {
      const mimeType = att.mimeType ?? 'image/jpeg'
      assertSupportedImageMime(mimeType)
      return {
        source: { type: 'url', url: att.url },
        mimeType,
        messageRef: { kind: 'url', url: att.url },
      }
    }

    if (att.type === 'cos') {
      const mimeType = att.mimeType ?? 'image/jpeg'
      assertSupportedImageMime(mimeType)
      const url = await this.signCosFileId(att.fileId)
      return {
        source: { type: 'url', url },
        mimeType,
        messageRef: { kind: 'cos', fileId: att.fileId },
      }
    }

    // file 类型：上传到 cos
    let buf: Uint8Array
    let mimeType: string | undefined = att.mimeType
    let extHint = ''

    if (typeof att.source === 'string') {
      try {
        buf = await fs.readFile(att.source)
      } catch (err) {
        throw new StorageError(`Failed to read file: ${att.source}`, err instanceof Error ? err : undefined)
      }
      if (!mimeType) mimeType = guessMimeFromPath(att.source)
      const dotIdx = att.source.lastIndexOf('.')
      if (dotIdx >= 0) extHint = att.source.slice(dotIdx).toLowerCase()
    } else {
      buf = att.source
    }
    if (!mimeType) mimeType = guessMimeFromBytes(buf)
    assertSupportedImageMime(mimeType)

    if (!extHint) {
      extHint = `.${mimeType.split('/')[1]}` // image/png → .png
    }

    const cloudPath = `${this.pathPrefix}${ctx.envId}/${ctx.sessionId}/${Date.now()}-${ctx.index}${extHint}`

    let fileID: string
    try {
      const app = await this.getApp()
      const r = await app.uploadFile({ cloudPath, fileContent: Buffer.from(buf) })
      fileID = r.fileID
    } catch (err) {
      throw new StorageError('CloudBase uploadFile failed', err instanceof Error ? err : undefined)
    }

    const url = await this.signCosFileId(fileID)
    return {
      source: { type: 'url', url },
      mimeType,
      messageRef: { kind: 'cos', fileId: fileID },
    }
  }

  async resolveRefToUrl(ref: ResolvedAttachment['messageRef']): Promise<string> {
    if (ref.kind === 'url') return ref.url
    if (ref.kind === 'base64') return ref.dataUrl
    return this.signCosFileId(ref.fileId)
  }

  // ─── 内部 ──────────────────────────────────────────────────────

  private async signCosFileId(fileId: string): Promise<string> {
    const app = await this.getApp()
    let result: Awaited<ReturnType<CloudBaseApp['getTempFileURL']>>
    try {
      result = await app.getTempFileURL({
        fileList: [{ fileID: fileId, maxAge: this.urlExpiresIn }],
      })
    } catch (err) {
      throw new StorageError('CloudBase getTempFileURL failed', err instanceof Error ? err : undefined)
    }
    const item = result.fileList?.[0]
    if (!item || !item.tempFileURL) {
      throw new StorageError(`CloudBase getTempFileURL returned empty result for fileId=${fileId}`)
    }
    return item.tempFileURL
  }
}
