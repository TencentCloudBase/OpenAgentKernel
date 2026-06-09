import type { SandboxInstance } from '../types.js'
import { WorkspaceSnapshotError, SandboxUnavailableError } from './errors.js'
import { snapshotSuccessSchema, RETRYABLE_ERROR_CODES } from './types.js'

export interface CallWorkspaceSnapshotOpts {
  timeoutMs: number // default 30_000
  retryBackoffMs: number // default 1_000
}

interface ProblemBody {
  errorCode?: string
  detail?: string
  retryable?: boolean
}

async function attempt(inst: SandboxInstance, timeoutMs: number): Promise<{ ms: number }> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await inst.request('/api/workspace/snapshot', {
      method: 'POST',
      signal: ac.signal,
    })

    if (res.status >= 500 && res.status < 600) {
      // 502/503/504 = 基础设施
      if (res.status !== 500) {
        throw new SandboxUnavailableError(`upstream ${res.status}`, res.status)
      }
      // 500: 解析 problem+json
      const body = (await res.json().catch(() => ({}))) as ProblemBody
      const retryable =
        body.retryable === true && body.errorCode != null && RETRYABLE_ERROR_CODES.has(body.errorCode)
      throw new WorkspaceSnapshotError(
        `snapshot failed: ${body.errorCode ?? 'unknown'}: ${body.detail ?? ''}`,
        retryable,
        body,
      )
    }

    if (!res.ok) {
      throw new WorkspaceSnapshotError(`snapshot http ${res.status}`, false)
    }

    const json = await res.json()
    return snapshotSuccessSchema.parse(json).result
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new WorkspaceSnapshotError(`snapshot timeout after ${timeoutMs}ms`, false)
    }
    throw err
  } finally {
    clearTimeout(t)
  }
}

export async function callWorkspaceSnapshot(
  inst: SandboxInstance,
  opts: CallWorkspaceSnapshotOpts,
): Promise<{ ms: number }> {
  try {
    return await attempt(inst, opts.timeoutMs)
  } catch (err) {
    if (err instanceof WorkspaceSnapshotError && err.retryable) {
      await new Promise((r) => setTimeout(r, opts.retryBackoffMs))
      return await attempt(inst, opts.timeoutMs)
    }
    throw err
  }
}
