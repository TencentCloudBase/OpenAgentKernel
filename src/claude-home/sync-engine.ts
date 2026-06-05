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
 *     4. baseline 重建为 newBaseline:成功项替换,失败项保留旧值(下次重试)
 *
 * 错误处理:
 *   - upload / delete 用 Promise.allSettled,单文件失败不影响其他文件
 *   - 失败仅 console.warn,baseline 中保留旧 entry 以便下次 send 重试
 *   - 这样保证用户的"删除"动作不会因为部分失败而被回滚
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
   * 网络/凭证错误会抛 Error — 调用方(create-agent.ts)负责 try/catch
   * 实现 graceful degrade(失败不阻塞 send loop)。
   *
   * pull 完成后会 ensure 一个最小 settings.json 存在(若用户没有 — settings.json
   * 不在 SYNC_INCLUDES,所以 COS 不会有,首次 pull 永远空),让 SDK 通过
   * `settingSources: 'user'` 读到 `autoMemoryEnabled: true` — 否则 SDK 默认
   * 不开 auto-memory,projects/<hash>/memory/ 永远不会被写。
   */
  async pullOnSendStart(): Promise<void> {
    await fs.mkdir(this.opts.localDir, { recursive: true })
    this.baseline = await this.opts.store.pull(this.opts.ctx, this.opts.localDir)
    await this.ensureUserSettings()
    if (process.env.OAK_DEBUG === '1') {
      const cosPrefix = `oak/users/${this.opts.ctx.userId}/claude-home/`
      // eslint-disable-next-line no-console
      console.error(
        `[oak/userMemory] pull complete (envId=${this.opts.ctx.envId} userId=${this.opts.ctx.userId}): ` +
          `${this.baseline.size} files in baseline, localDir=${this.opts.localDir}`,
      )
      for (const [relPath] of this.baseline) {
        // eslint-disable-next-line no-console
        console.error(
          `  baseline: ${relPath}  (local: ${path.join(this.opts.localDir, relPath)}  ←  COS key=${cosPrefix}${relPath})`,
        )
      }
    }
  }

  /**
   * 确保 <localDir>/settings.json 存在,含 autoMemoryEnabled: true。
   *
   * - 不存在 → 写一个 minimal settings(开 auto-memory)
   * - 存在 → 读取并 merge:autoMemoryEnabled 缺失时填 true,其他字段保持原样
   *   (用户/SDK 自己改的设置我们不覆盖)
   *
   * settings.json 不在 SYNC_INCLUDES 范围内(平台资产,不跨节点同步),
   * 每节点本地维护即可。
   */
  private async ensureUserSettings(): Promise<void> {
    const settingsPath = path.join(this.opts.localDir, 'settings.json')
    let current: Record<string, unknown> = {}
    try {
      const raw = await fs.readFile(settingsPath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>
      }
    } catch {
      // 不存在或解析失败 → 当成空 settings 处理
    }
    if (current.autoMemoryEnabled === undefined) {
      current.autoMemoryEnabled = true
      await fs.writeFile(settingsPath, JSON.stringify(current, null, 2) + '\n', 'utf8')
      if (process.env.OAK_DEBUG === '1') {
        // eslint-disable-next-line no-console
        console.error(
          `[oak/userMemory] wrote default settings.json (autoMemoryEnabled=true) at ${settingsPath}`,
        )
      }
    }
  }

  /**
   * Send-end / abort:diff baseline vs 当前 localDir,推送变化 + 反向删除。
   * 完成后 baseline 更新为 newBaseline(成功项替换,失败项保留旧值供下次重试)。
   *
   * 单文件 PUT/DELETE 失败不会抛 — 用 Promise.allSettled 兼容,
   * 失败会记 console.warn 但不影响其他文件同步。
   * 真正抛错的场景:scanCurrent / fs.readFile / store 实现内部 throw → 整个方法抛。
   * 调用方仍需 try/catch 包裹此方法以兼容上述场景。
   */
  async pushOnSendEnd(): Promise<void> {
    const currentMap = await this.scanCurrent()

    if (process.env.OAK_DEBUG === '1') {
      // eslint-disable-next-line no-console
      console.error(
        `[oak/userMemory] push scan: ${currentMap.size} files match SYNC_INCLUDES in localDir=${this.opts.localDir}`,
      )
      for (const [relPath] of currentMap) {
        // eslint-disable-next-line no-console
        console.error(`  current: ${relPath}  (abs: ${path.join(this.opts.localDir, relPath)})`)
      }
      // 同时列出 localDir 下"所有"文件(不仅 SYNC_INCLUDES 命中的),帮诊断 SDK 是否真的在写
      try {
        const all = await listAllFilesRelative(this.opts.localDir)
        // eslint-disable-next-line no-console
        console.error(`[oak/userMemory] push scan: total files in localDir = ${all.length}`)
        for (const relPath of all) {
          // eslint-disable-next-line no-console
          console.error(`  found: ${relPath}  (abs: ${path.join(this.opts.localDir, relPath)})`)
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[oak/userMemory] push scan: localDir walk failed:`, (err as Error)?.message)
      }
    }

    // 1. 计算待 upload(currentMap 有 + (baseline 没有 OR hash 变了))
    const toUpload: Array<RelativePath> = []
    for (const [relPath, hash] of currentMap) {
      if (this.baseline.get(relPath) !== hash) toUpload.push(relPath)
    }

    // 2. 计算待 delete(baseline 有 + currentMap 没有)
    const toDelete: Array<RelativePath> = []
    for (const relPath of this.baseline.keys()) {
      if (!currentMap.has(relPath)) toDelete.push(relPath)
    }

    if (process.env.OAK_DEBUG === '1') {
      // eslint-disable-next-line no-console
      console.error(`[oak/userMemory] push diff: ${toUpload.length} to upload, ${toDelete.length} to delete`)
      const cosPrefix = `oak/users/${this.opts.ctx.userId}/claude-home/`
      for (const relPath of toUpload) {
        // eslint-disable-next-line no-console
        console.error(`  PUT  local=${path.join(this.opts.localDir, relPath)}  →  COS key=${cosPrefix}${relPath}`)
      }
      for (const relPath of toDelete) {
        // eslint-disable-next-line no-console
        console.error(`  DEL  COS key=${cosPrefix}${relPath}`)
      }
    }

    // 3. upload 与 delete 独立处理,allSettled 兼容部分失败
    const uploadResults = await Promise.allSettled(
      toUpload.map(async (relPath) => {
        const buf = await fs.readFile(path.join(this.opts.localDir, relPath))
        await this.opts.store.put(this.opts.ctx, relPath, buf)
        return relPath
      }),
    )

    const deleteResults = await Promise.allSettled(
      toDelete.map(async (relPath) => {
        await this.opts.store.delete(this.opts.ctx, relPath)
        return relPath
      }),
    )

    // 4. 重建 baseline:
    //    - 起点:currentMap 中"hash 不变"的项(它们一定在旧 baseline 里且 hash 相同)
    //    - upload 成功 → 用 currentMap 中的新 hash 覆盖
    //    - upload 失败 → 保留旧 hash(下次重试);若是新文件则不进 baseline,下次仍走 upload
    //    - delete 成功 → 不写入 newBaseline
    //    - delete 失败 → 保留旧 baseline entry(下次重试 delete)
    const newBaseline = new Map<RelativePath, string>()

    // 4a. 先把 currentMap 中"hash 不变"的全部带入
    for (const [relPath, hash] of currentMap) {
      if (!toUpload.includes(relPath)) {
        newBaseline.set(relPath, hash)
      }
    }

    // 4b. upload 成功的 → 用新 hash;失败的 → 保留旧 hash(若有)
    for (let i = 0; i < uploadResults.length; i++) {
      const result = uploadResults[i]
      const relPath = toUpload[i]
      if (result.status === 'fulfilled') {
        newBaseline.set(relPath, currentMap.get(relPath)!)
      } else {
        const oldHash = this.baseline.get(relPath)
        if (oldHash !== undefined) newBaseline.set(relPath, oldHash)
        // 旧 baseline 没有 → 这是新文件的 upload 失败 → 不进 newBaseline,下次会重试 upload
        console.warn(`[oak/userMemory] push failed for ${relPath}:`, (result.reason as Error)?.message ?? result.reason)
      }
    }

    // 4c. delete 失败的 → 保留旧 baseline entry(下次重试)
    for (let i = 0; i < deleteResults.length; i++) {
      const result = deleteResults[i]
      const relPath = toDelete[i]
      if (result.status === 'rejected') {
        const oldHash = this.baseline.get(relPath)
        if (oldHash !== undefined) newBaseline.set(relPath, oldHash)
        console.warn(
          `[oak/userMemory] delete failed for ${relPath}:`,
          (result.reason as Error)?.message ?? result.reason,
        )
      }
      // delete 成功的 → 不在 newBaseline 中(因 currentMap 也没有,且没在前面 set)
    }

    this.baseline = newBaseline
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

/**
 * 列出 dir 下所有文件(相对路径,不限白名单),仅 OAK_DEBUG 诊断用。
 */
async function listAllFilesRelative(dir: string): Promise<string[]> {
  const out: string[] = []
  await walkAllFiles(dir, '', out)
  return out
}

async function walkAllFiles(absDir: string, relPrefix: string, out: string[]): Promise<void> {
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
      await walkAllFiles(absPath, relPath, out)
    } else if (entry.isFile()) {
      out.push(relPath)
    }
  }
}
