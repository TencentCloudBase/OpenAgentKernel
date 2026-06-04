/**
 * InMemoryClaudeHomeStore: 测试 / 开发期使用的同步存储实现。
 *
 * - 进程退出即丢失数据
 * - 与 CloudBaseCosClaudeHomeStore 实现相同 ClaudeHomeSyncStore 接口
 * - 用作单元测试替身
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { sha256OfBuffer } from './dedup.js'
import type { ClaudeHomeContext, ClaudeHomeSyncStore, RelativePath } from './types.js'

function nsKey(ctx: ClaudeHomeContext): string {
  return `${ctx.envId}|${ctx.userId}`
}

export class InMemoryClaudeHomeStore implements ClaudeHomeSyncStore {
  /** ns → Map<relPath, content> */
  private readonly objects = new Map<string, Map<RelativePath, Buffer>>()

  async pull(ctx: ClaudeHomeContext, localDir: string): Promise<Map<RelativePath, string>> {
    const ns = this.objects.get(nsKey(ctx))
    const baseline = new Map<RelativePath, string>()
    if (!ns) return baseline

    for (const [relPath, content] of ns) {
      const localPath = path.join(localDir, relPath)
      await fs.mkdir(path.dirname(localPath), { recursive: true })
      await fs.writeFile(localPath, content)
      baseline.set(relPath, sha256OfBuffer(content))
    }
    return baseline
  }

  async put(ctx: ClaudeHomeContext, relPath: RelativePath, content: Buffer): Promise<void> {
    const key = nsKey(ctx)
    let ns = this.objects.get(key)
    if (!ns) {
      ns = new Map()
      this.objects.set(key, ns)
    }
    ns.set(relPath, Buffer.from(content))    // copy to detach
  }

  async delete(ctx: ClaudeHomeContext, relPath: RelativePath): Promise<void> {
    const ns = this.objects.get(nsKey(ctx))
    ns?.delete(relPath)
  }
}
