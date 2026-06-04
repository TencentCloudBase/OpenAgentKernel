/**
 * SHA-256 hash 工具。
 *
 * 用途:sync engine 在 pull / push 阶段对每个文件计算 hash,用于变更检测。
 * 不依赖 mtime(假阳性多)/ ETag(网络往返),纯确定性。
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export function sha256OfBuffer(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex')
}

export async function sha256OfFile(absPath: string): Promise<string> {
  const buf = await readFile(absPath)
  return sha256OfBuffer(buf)
}
