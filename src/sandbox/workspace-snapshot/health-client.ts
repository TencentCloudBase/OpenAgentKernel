import type { SandboxInstance } from '../types.js'
import { healthResponseSchema, type Restored, type SyncStatus } from './types.js'

async function readHealthOnce(inst: SandboxInstance): Promise<SyncStatus | null | 'unavailable'> {
  try {
    const res = await inst.request('/health', { method: 'GET' })
    if (!res.ok) {
      if (process.env.OAK_DEBUG === '1') {
        // eslint-disable-next-line no-console
        console.error(`[oak][readHealthOnce] NULL PATH ③: /health returned non-OK status=${res.status}`)
      }
      return 'unavailable'
    }
    const json = await res.json().catch(() => null)
    if (!json) {
      if (process.env.OAK_DEBUG === '1') {
        // eslint-disable-next-line no-console
        console.error('[oak][readHealthOnce] NULL PATH ④: /health body is not valid JSON')
      }
      return 'unavailable'
    }
    const parsed = healthResponseSchema.safeParse(json)
    if (!parsed.success) {
      if (process.env.OAK_DEBUG === '1') {
        // eslint-disable-next-line no-console
        console.error(
          `[oak][readHealthOnce] NULL PATH ⑤: /health body schema mismatch — zod error=${JSON.stringify(parsed.error.issues).slice(0, 500)} body keys=${JSON.stringify(Object.keys(json))}`,
        )
      }
      return 'unavailable'
    }
    if (parsed.data.restoreStatus == null) {
      if (process.env.OAK_DEBUG === '1') {
        // eslint-disable-next-line no-console
        console.error(
          `[oak][readHealthOnce] NULL PATH ⑦: /health body parsed OK but restoreStatus field is null/undefined — body keys=${JSON.stringify(Object.keys(parsed.data))}`,
        )
      }
      return null
    }
    // restoreStatus 有效
    return parsed.data.restoreStatus
  } catch (err) {
    if (process.env.OAK_DEBUG === '1') {
      // eslint-disable-next-line no-console
      console.error(`[oak][readHealthOnce] NULL PATH ⑥: /health request threw — ${(err as Error).message}`)
    }
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
  if (!r || r === 'unavailable') {
    if (process.env.OAK_DEBUG === '1') {
      // eslint-disable-next-line no-console
      console.error(`[oak][getHealthRestoreStatus] NULL PATH ②: readHealthOnce returned ${JSON.stringify(r)}`)
    }
    return null
  }
  if (process.env.OAK_DEBUG === '1') {
    // eslint-disable-next-line no-console
    console.error(`[oak][getHealthRestoreStatus] readHealthOnce returned restored=${r.restored}`)
  }
  return r.restored
}
