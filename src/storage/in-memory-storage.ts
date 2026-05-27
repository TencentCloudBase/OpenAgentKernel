/**
 * InMemoryStorage：开发 / 测试用 StorageProvider 实现。
 *
 * 行为：
 *   - file 类型 attachment：读 Buffer → base64 内联到 SDK 请求
 *   - url 类型：透传（kernel 不下载、不重新上传）
 *   - cos 类型：本实现不支持（CloudBase 凭证依赖），抛 StorageError
 *
 * 适用场景：
 *   - 本地开发 / 单元测试
 *   - 验证多模态主链路（不依赖 CloudBase 云存储）
 *
 * 不适用场景：
 *   - 生产环境（base64 让 payload 膨胀 ~33%、transcript 历史里塞超大字符串）
 *   - 跨节点共享附件（base64 是 inline 不是引用）
 */

import * as fs from 'node:fs/promises'
import { StorageError } from '../internal/errors.js'
import type { AttachmentInput } from '../public/types.js'
import { assertSupportedImageMime, guessMimeFromBytes, guessMimeFromPath } from './mime.js'
import type { ResolveContext, ResolvedAttachment, StorageProvider } from './types.js'

export class InMemoryStorage implements StorageProvider {
  async resolveAttachment(att: AttachmentInput, _ctx: ResolveContext): Promise<ResolvedAttachment> {
    if (att.type === 'cos') {
      throw new StorageError(
        'InMemoryStorage does not support `cos` attachments (no CloudBase credentials). ' +
          'Use CloudBaseStorage for cos:// references.',
      )
    }

    if (att.type === 'url') {
      const mimeType = att.mimeType ?? 'image/jpeg' // SDK url source 不要求 media_type，但 transcript 需要
      assertSupportedImageMime(mimeType)
      return {
        source: { type: 'url', url: att.url },
        mimeType,
        messageRef: { kind: 'url', url: att.url },
      }
    }

    // file 类型：本地路径或 Buffer → base64 内联
    let buf: Uint8Array
    let mimeType: string | undefined = att.mimeType

    if (typeof att.source === 'string') {
      // 本地路径
      try {
        buf = await fs.readFile(att.source)
      } catch (err) {
        throw new StorageError(`Failed to read file: ${att.source}`, err instanceof Error ? err : undefined)
      }
      if (!mimeType) mimeType = guessMimeFromPath(att.source)
    } else {
      buf = att.source
    }
    if (!mimeType) mimeType = guessMimeFromBytes(buf)

    assertSupportedImageMime(mimeType)

    const base64 = Buffer.from(buf).toString('base64')
    return {
      source: { type: 'base64', media_type: mimeType, data: base64 },
      mimeType,
      messageRef: {
        kind: 'base64',
        dataUrl: `data:${mimeType};base64,${base64}`,
      },
    }
  }

  async resolveRefToUrl(ref: ResolvedAttachment['messageRef']): Promise<string> {
    if (ref.kind === 'url') return ref.url
    if (ref.kind === 'base64') return ref.dataUrl
    throw new StorageError('InMemoryStorage cannot resolve cos:// refs (no CloudBase credentials).')
  }
}
