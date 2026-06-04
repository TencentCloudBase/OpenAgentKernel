/**
 * ClaudeHomeSyncEngine: pullOnSendStart / pushOnSendEnd 的核心逻辑。
 *
 * 流程(spec §4.3):
 *   send-start:
 *     1. store.pull → 把 COS 内容拉到 localDir + 返回 { relPath → sha256 } baseline
 *
 *   send-end / abort:
 *     1. walk localDir 匹配 SYNC_INCLUDES → 每个文件算 sha256 → currentMap
 *     2. 推送变更:currentMap 有 + (baseline 没有 OR hash 变了) → store.put
 *     3. 反向删除:baseline 有 + currentMap 没有 → store.delete
 *     4. baseline = currentMap(供下次 send 对比)
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { sha256OfBuffer } from './dedup.js'
import { matchesSyncRule } from './sync-rules.js'
import type { ClaudeHomeContext, ClaudeHomeSyncStore, RelativePath } from './types.js'

export interface ClaudeHomeSyncEngineOptions {
  store: ClaudeHomeSyncStore
  ctx: ClaudeHomeContext
  localDir: string
}

export class ClaudeHomeSyncEngine {
  private baseline = new Map<RelativePath, string>()
  // 暴露给测试做断言
  readonly opts: ClaudeHomeSyncEngineOptions

  constructor(opts: ClaudeHomeSyncEngineOptions) {
    this.opts = opts
  }

  /** 测试辅助:返回 baseline 的不可变 snapshot */
  baselineSnapshot(): ReadonlyMap<RelativePath, string> {
    return new Map(this.baseline)
  }

  /**
   * Send-start:从 COS 拉取该 user 的 .claude/ 内容到 localDir,
   * 并对每个文件算 sha256 作为 baseline。
   *
   * 失败不抛 — 由调用方做 graceful degrade(MVP 仅记 warning)。
   */
  async pullOnSendStart(): Promise<void> {
    await fs.mkdir(this.opts.localDir, { recursive: true })
    this.baseline = await this.opts.store.pull(this.opts.ctx, this.opts.localDir)
  }

  /**
   * Send-end / abort:diff baseline vs 当前 localDir,推送变化 + 反向删除。
   * 完成后 baseline 更新为 currentMap。
   */
  async pushOnSendEnd(): Promise<void> {
    const currentMap = await this.scanCurrent()

    // 1. push 新增 + 改动
    const toUpload: Array<RelativePath> = []
    for (const [relPath, hash] of currentMap) {
      if (this.baseline.get(relPath) !== hash) toUpload.push(relPath)
    }
    await Promise.all(
      toUpload.map(async (relPath) => {
        const buf = await fs.readFile(path.join(this.opts.localDir, relPath))
        await this.opts.store.put(this.opts.ctx, relPath, buf)
      }),
    )

    // 2. 反向删除
    const toDelete: Array<RelativePath> = []
    for (const relPath of this.baseline.keys()) {
      if (!currentMap.has(relPath)) toDelete.push(relPath)
    }
    await Promise.all(toDelete.map((relPath) => this.opts.store.delete(this.opts.ctx, relPath)))

    // 3. baseline 更新
    this.baseline = currentMap
  }

  /**
   * 扫描 localDir 中所有匹配 SYNC_INCLUDES 的文件,返回 { relPath → sha256 }。
   * localDir 不存在时返回空 Map。
   */
  private async scanCurrent(): Promise<Map<RelativePath, string>> {
    const result = new Map<RelativePath, string>()
    try {
      await fs.access(this.opts.localDir)
    } catch {
      return result
    }
    await this.walkDir(this.opts.localDir, '', result)
    return result
  }

  private async walkDir(absDir: string, relPrefix: string, out: Map<RelativePath, string>): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      const absPath = path.join(absDir, entry.name)
      if (entry.isDirectory()) {
        await this.walkDir(absPath, relPath, out)
      } else if (entry.isFile()) {
        if (!matchesSyncRule(relPath)) continue
        const buf = await fs.readFile(absPath)
        out.set(relPath, sha256OfBuffer(buf))
      }
    }
  }
}
