/**
 * cwd 工作目录持久化 —— tar.gz 单包引擎(无沙箱场景)。
 *
 * 与逐文件 diff 的 ClaudeHomeSyncEngine 不同,本引擎把整个 cwd 打包成单个 cwd.tar.gz
 * 上传 / 下载。适合 cwd 文件数量可能成百上千的场景:
 *   - 恢复(pull):1 次下载 + 本地解包,而非 N 次 getTemporaryUrl+fetch
 *   - 同步(push):1 次打包 + 1 次上传,而非 N 次上传
 *   - COS object 数:1 个(而非 N 个)
 *
 * 代价:无增量,每轮 send 都全量重传整个 cwd。但 cwd 是"整目录快照"语义,
 * 在文件多、跨容器冷启动恢复为主的场景下,单包远优于逐文件(避免上千次网络往返
 * 与全并发打爆 COS 限流)。
 *
 * COS 路径(对齐沙箱 oak-workspaces 顶层 + userId 维度,保留 session 隔离):
 *   oak-workspaces/<userId>/<sessionId>/cwd.tar.gz
 *
 * envId 仅用于定位 COS 桶,不进 key(与 ClaudeHomeSyncEngine 一致)。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { create as tarCreate, extract as tarExtract } from 'tar'
import { deriveSyncTmpDir } from './path-derivation.js'
import { InvalidConfigError } from '../internal/errors.js'
import { CloudBaseCosClaudeHomeStore, type CloudBaseCosCredentials } from './cloudbase-cos-store.js'
import type { ClaudeHomeContext, ClaudeHomeSyncStore } from './types.js'
import { matchesCwdSyncRule, shouldPruneCwdDir } from './workspace-cwd-rules.js'

/** 单包归档文件名(相对 keyPrefix 的 relPath)。 */
const ARCHIVE_REL = 'cwd.tar.gz'

/** cwd 默认单文件上限:5 MB(打包时跳过更大的文件,防止单包过大)。 */
const DEFAULT_MAX_FILE_BYTES = 5_000_000

/** 单个 tar.gz 上传大小上限(保守,避免 COS / tmp 文件桥接过大):50 MB。 */
const MAX_ARCHIVE_BYTES = 50_000_000

export interface WorkspaceCwdArchiveEngineOptions {
  store: ClaudeHomeSyncStore
  ctx: ClaudeHomeContext
  /** 本地工作目录(effectiveCwd),打包/解包的根。 */
  cwd: string
  /** 追加排除项(目录名 / '*.log' 后缀)。 */
  extraExcludes?: readonly string[]
  /** 单文件上限(字节),默认 5MB。 */
  maxFileBytes?: number
}

/**
 * tar.gz 单包 cwd 持久化引擎。与 ClaudeHomeSyncEngine 接口对齐
 * (pullOnSendStart / pushOnSendEnd),便于 create-agent 复用同一生命周期挂点。
 */
export class WorkspaceCwdArchiveEngine {
  private readonly opts: WorkspaceCwdArchiveEngineOptions
  constructor(opts: WorkspaceCwdArchiveEngineOptions) {
    if (!opts.ctx.sessionId) {
      throw new InvalidConfigError('WorkspaceCwdArchiveEngine: ctx.sessionId is required')
    }
    this.opts = opts
  }

  /**
   * Send-start:从 COS 下载 cwd.tar.gz,解包到本地 cwd。
   * 首次访问(对象不存在)→ 不做任何事(空 cwd,模型自己建)。
   */
  async pullOnSendStart(): Promise<void> {
    await fs.mkdir(this.opts.cwd, { recursive: true })
    if (!this.opts.store.getObject) return // store 不支持单对象下载(不应发生)
    const buf = await this.opts.store.getObject(this.opts.ctx, ARCHIVE_REL)
    if (!buf || buf.length === 0) {
      // 首次:无归档,空 cwd
      if (process.env.OAK_DEBUG === '1') {
        // eslint-disable-next-line no-console
        console.error(`[oak/workspaceCwdArchive] pull: no archive found (first run), cwd=${this.opts.cwd}`)
      }
      return
    }
    await this.extractTarGz(buf, this.opts.cwd)
    if (process.env.OAK_DEBUG === '1') {
      // eslint-disable-next-line no-console
      console.error(`[oak/workspaceCwdArchive] pull: extracted ${buf.length}B archive → ${this.opts.cwd}`)
    }
  }

  /**
   * Send-end:打包 cwd → cwd.tar.gz → 上传(覆盖)。
   * 打包时排除黑名单目录/文件 + 跳过大于 maxFileBytes 的文件。
   */
  async pushOnSendEnd(): Promise<void> {
    const archiveBuf = await this.packTarGz(this.opts.cwd)
    if (archiveBuf.length > MAX_ARCHIVE_BYTES) {
      // 超大归档不传(避免 COS / tmp 桥接失败),warn 不抛
      // eslint-disable-next-line no-console
      console.warn(
        `[oak/workspaceCwdArchive] push: archive ${archiveBuf.length}B exceeds ${MAX_ARCHIVE_BYTES}B cap, skipping upload`,
      )
      return
    }
    await this.opts.store.put(this.opts.ctx, ARCHIVE_REL, archiveBuf)
    if (process.env.OAK_DEBUG === '1') {
      // eslint-disable-next-line no-console
      console.error(`[oak/workspaceCwdArchive] push: uploaded ${archiveBuf.length}B archive`)
    }
  }

  /** 打包 cwd → tar.gz Buffer,应用排除规则 + 单文件上限。 */
  private async packTarGz(cwd: string): Promise<Buffer> {
    const ruleOpts = this.opts.extraExcludes ? { extraExcludes: this.opts.extraExcludes } : undefined
    const matchRule = (relPath: string) => matchesCwdSyncRule(relPath, ruleOpts)
    const pruneDir = (relPath: string) => shouldPruneCwdDir(relPath, ruleOpts)
    const maxFileBytes = this.opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES

    // 收集要打包的文件(相对 cwd 的 relPath)
    const entries: string[] = []
    await this.walk(cwd, '', entries, matchRule, pruneDir, maxFileBytes)

    // tar.c 写到临时文件(库的标准用法),再读回 Buffer
    await fs.mkdir(deriveSyncTmpDir(), { recursive: true })
    const tmpFile = path.join(deriveSyncTmpDir(), `cwd-pack-${Date.now()}-${process.pid}.tar.gz`)
    try {
      await tarCreate(
        {
          cwd,
          file: tmpFile,
          gzip: true,
          portable: true,
          noMtime: true,
          noDirRecurse: true,
        },
        entries,
      )
      return await fs.readFile(tmpFile)
    } finally {
      await fs.rm(tmpFile, { force: true }).catch(() => {})
    }
  }

  /** 递归收集要打包的 relPath(应用 pruneDir/matchRule/maxFileBytes)。 */
  private async walk(
    absDir: string,
    relPrefix: string,
    out: string[],
    matchRule: (relPath: string) => boolean,
    pruneDir: (relPath: string) => boolean,
    maxFileBytes: number,
  ): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (pruneDir(relPath)) continue
        await this.walk(path.join(absDir, entry.name), relPath, out, matchRule, pruneDir, maxFileBytes)
      } else if (entry.isFile()) {
        if (!matchRule(relPath)) continue
        try {
          const st = await fs.stat(path.join(absDir, entry.name))
          if (st.size > maxFileBytes) continue
        } catch {
          continue
        }
        out.push(relPath)
      }
    }
  }

  /** 解包 tar.gz Buffer 到 cwd。写到临时文件后用 tar.x 解包(库的标准用法)。 */
  private async extractTarGz(buf: Buffer, cwd: string): Promise<void> {
    await fs.mkdir(deriveSyncTmpDir(), { recursive: true })
    const tmpFile = path.join(deriveSyncTmpDir(), `cwd-extract-${Date.now()}-${process.pid}.tar.gz`)
    try {
      await fs.writeFile(tmpFile, buf)
      await tarExtract({ file: tmpFile, cwd, sync: false })
    } finally {
      await fs.rm(tmpFile, { force: true }).catch(() => {})
    }
  }
}

/** cwd 归档的 COS key 前缀(对齐沙箱 oak-workspaces 顶层 + userId,session 隔离)。 */
export function cwdArchiveKeyPrefix(ctx: ClaudeHomeContext): string {
  if (!ctx.sessionId) {
    throw new InvalidConfigError('cwdArchiveKeyPrefix: ctx.sessionId is required')
  }
  return `oak-workspaces/${ctx.userId}/${ctx.sessionId}/`
}

/**
 * 构造绑定到 COS 的 cwd 归档引擎(单包)。
 * sessionId 缺失直接抛 InvalidConfigError —— 调用方负责 try/catch 降级。
 */
export function createWorkspaceCwdArchiveEngine(args: {
  credentials?: CloudBaseCosCredentials
  envId: string
  userId: string
  sessionId: string
  cwd: string
  extraExcludes?: readonly string[]
  maxFileBytes?: number
}): WorkspaceCwdArchiveEngine {
  if (!args.sessionId) {
    throw new InvalidConfigError('createWorkspaceCwdArchiveEngine: sessionId is required')
  }
  const store = new CloudBaseCosClaudeHomeStore({
    ...(args.credentials ? { credentials: args.credentials } : {}),
    keyPrefix: cwdArchiveKeyPrefix,
  })
  return new WorkspaceCwdArchiveEngine({
    store,
    ctx: { envId: args.envId, userId: args.userId, sessionId: args.sessionId },
    cwd: args.cwd,
    ...(args.extraExcludes ? { extraExcludes: args.extraExcludes } : {}),
    ...(args.maxFileBytes !== undefined ? { maxFileBytes: args.maxFileBytes } : {}),
  })
}
