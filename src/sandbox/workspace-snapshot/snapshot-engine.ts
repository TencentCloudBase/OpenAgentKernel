import type { SandboxInstance } from '../types.js'
import { callWorkspaceInit } from './init-client.js'
import { callWorkspaceSnapshot } from './snapshot-client.js'
import { fetchRestoreStatus, getHealthRestoreStatus } from './health-client.js'
import { SandboxRestoreFailed } from './errors.js'
import type { SyncStatus, Restored } from './types.js'

export interface WorkspaceSnapshotEngineOptions {
  snapshotTimeoutMs?: number // default 30_000
  initTimeoutMs?: number // default 60_000
  retryBackoffMs?: number // default 1_000(snapshot retryable backoff)
  healthMaxAttempts?: number // default 3(bootstrap 阶段读 /health 重试次数)
  healthRetryDelayMs?: number // default 200
}

interface ResolvedOpts extends Required<WorkspaceSnapshotEngineOptions> {}

const DEFAULT: ResolvedOpts = {
  snapshotTimeoutMs: 30_000,
  initTimeoutMs: 60_000,
  retryBackoffMs: 1_000,
  healthMaxAttempts: 3,
  healthRetryDelayMs: 200,
}

export class WorkspaceSnapshotEngine {
  private readonly opts: ResolvedOpts

  constructor(opts: WorkspaceSnapshotEngineOptions = {}) {
    // 不能直接 `{ ...DEFAULT, ...opts }`:JS spread 不跳过显式 undefined,
    // 调用方写 `new WorkspaceSnapshotEngine({ initTimeoutMs: undefined })` 时
    // 会覆盖默认值,导致 setTimeout(undefined) 立即触发 → init 立刻抛
    // "SandboxRestoreTimeout: init timeout after undefinedms"。
    // 用 `??` 逐字段 fallback 才是正确的"未提供则用默认"语义。
    this.opts = {
      snapshotTimeoutMs: opts.snapshotTimeoutMs ?? DEFAULT.snapshotTimeoutMs,
      initTimeoutMs: opts.initTimeoutMs ?? DEFAULT.initTimeoutMs,
      retryBackoffMs: opts.retryBackoffMs ?? DEFAULT.retryBackoffMs,
      healthMaxAttempts: opts.healthMaxAttempts ?? DEFAULT.healthMaxAttempts,
      healthRetryDelayMs: opts.healthRetryDelayMs ?? DEFAULT.healthRetryDelayMs,
    }
  }

  /**
   * startSession 时调用。两步序列:
   * 1. POST /api/workspace/init(同步触发 ensureWorkspace + restoreFromCos)
   * 2. GET /health 解析 body.restoreStatus 拿真实 SyncStatus
   *
   * - SyncStatus.restored === 'failed' → throw SandboxRestoreFailed
   * - SyncStatus 拿不到(/health 5xx 或 restoreStatus 一直 null)→ 返回 null,session 继续,
   *   但 OAK 应在调用方 log 提示"无法确认 restore 状态,假装 fresh"
   */
  async bootstrap(inst: SandboxInstance, args: { credentials: Record<string, string> }): Promise<SyncStatus | null> {
    // 1. 触发 init(内部已等到 restoreFromCos 完成)
    await callWorkspaceInit(inst, {
      credentials: args.credentials,
      timeoutMs: this.opts.initTimeoutMs,
    })

    // 2. 读 /health 拿 SyncStatus(可能因为内部 race 暂时没刷新到,允许小重试)
    const status = await fetchRestoreStatus(inst, {
      maxAttempts: this.opts.healthMaxAttempts,
      retryDelayMs: this.opts.healthRetryDelayMs,
    })

    if (status?.restored === 'failed') {
      throw new SandboxRestoreFailed('restoreFromCos failed', { note: status.note })
    }
    return status
  }

  async snapshot(inst: SandboxInstance): Promise<{ ms: number }> {
    return callWorkspaceSnapshot(inst, {
      timeoutMs: this.opts.snapshotTimeoutMs,
      retryBackoffMs: this.opts.retryBackoffMs,
    })
  }

  async getRestoreStatus(inst: SandboxInstance): Promise<Restored | null> {
    return getHealthRestoreStatus(inst)
  }
}
