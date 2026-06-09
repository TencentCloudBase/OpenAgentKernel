import type { SandboxInstance } from '../types.js'
import { healthResponseSchema, type Restored, type SyncStatus } from './types.js'

async function readHealthOnce(inst: SandboxInstance): Promise<SyncStatus | null | 'unavailable'> {
  try {
    const res = await inst.request('/health', { method: 'GET' })
    if (!res.ok) return 'unavailable'
    const json = await res.json().catch(() => null)
    if (!json) return 'unavailable'
    const parsed = healthResponseSchema.safeParse(json)
    if (!parsed.success) return 'unavailable'
    // null = restoreStatus 字段还没有(init 跟 health 还没同步)
    return parsed.data.restoreStatus ?? null
  } catch {
    return 'unavailable'
  }
}

export interface FetchRestoreStatusOpts {
  /** bootstrap 阶段允许重试,处理 init→health 之间的状态写入延迟 */
  maxAttempts: number // default 3
  retryDelayMs: number // default 200
}

/**
 * bootstrap 阶段使用 — 拿完整的 SyncStatus 决定是否抛 SandboxRestoreFailed。
 * - 成功(SyncStatus) → 返回
 * - 'unavailable' / null 重试,直到 maxAttempts 用完
 * - 仍 null/unavailable → 返回 null,让 caller 决定(通常是降级为"假装 fresh")
 */
export async function fetchRestoreStatus(
  inst: SandboxInstance,
  opts: FetchRestoreStatusOpts,
): Promise<SyncStatus | null> {
  for (let i = 0; i < opts.maxAttempts; i++) {
    const r = await readHealthOnce(inst)
    if (r && r !== 'unavailable') return r
    if (i < opts.maxAttempts - 1) {
      await new Promise((res) => setTimeout(res, opts.retryDelayMs))
    }
  }
  return null
}

/**
 * 事后查询(Session.getRestoreStatus()),graceful 失败一律 null,不重试不抛错。
 */
export async function getHealthRestoreStatus(inst: SandboxInstance): Promise<Restored | null> {
  const r = await readHealthOnce(inst)
  if (!r || r === 'unavailable') return null
  return r.restored
}
