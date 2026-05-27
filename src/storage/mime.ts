/**
 * mime-type 推断与白名单校验。
 *
 * Anthropic API 只接受 4 种图片格式：jpeg / png / gif / webp。
 * kernel 在上传前必须校验，否则模型会直接报错。
 */

import { StorageError } from '../internal/errors.js'

const ALLOWED_IMAGE_MIME_TYPES = new Set<string>(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/**
 * 从文件路径推断 mimeType（按后缀名）。
 */
export function guessMimeFromPath(filePath: string): string | undefined {
  const dotIdx = filePath.lastIndexOf('.')
  if (dotIdx < 0) return undefined
  const ext = filePath.slice(dotIdx).toLowerCase()
  return EXT_TO_MIME[ext]
}

/**
 * 从 Buffer 头部 magic bytes 推断 mimeType。
 * 仅识别最常见的几种图片格式。
 */
export function guessMimeFromBytes(buf: Uint8Array): string | undefined {
  if (buf.length < 12) return undefined
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png'
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg'
  }
  // GIF: 47 49 46 38
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return 'image/gif'
  }
  // WEBP: 52 49 46 46 ... 57 45 42 50
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp'
  }
  return undefined
}

/**
 * 断言 mimeType 是 Anthropic 支持的图片格式。
 * @throws StorageError
 */
export function assertSupportedImageMime(
  mimeType: string | undefined,
): asserts mimeType is 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  if (!mimeType) {
    throw new StorageError(
      'Cannot determine attachment mimeType. Please specify it explicitly via AttachmentInput.mimeType.',
    )
  }
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new StorageError(
      `Unsupported image mimeType: ${mimeType}. ` +
        `Anthropic protocol only accepts: image/jpeg, image/png, image/gif, image/webp.`,
    )
  }
}
