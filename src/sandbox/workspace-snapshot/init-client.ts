import type { SandboxInstance } from '../types.js'
import { SandboxRestoreFailed, SandboxRestoreTimeout } from './errors.js'
import { workspaceInitResponseSchema, type WorkspaceInitResponse } from './types.js'

export interface CallWorkspaceInitOpts {
  /** body.env 注入到镜像内的凭证(沿用 tcb-remote-workspace 既有契约)*/
  credentials: Record<string, string>
  /** HTTP timeout,默认上层传 60_000 */
  timeoutMs: number
}

/**
 * 调 POST /api/workspace/init,返回 init 真实 body 的 result 字段。
 *
 * 重要:**init body 不含 restoreStatus**(见 routes/api.ts:240-312 + workspace.ts:699
 * `getWorkspaceStatus` 只返 workspace+git)。restore 的 SyncStatus 必须在 init
 * 之后单独 GET /health 解析 body.restoreStatus(由 health-client.fetchRestoreStatus 完成)。
 *
 * 不重试 — restore 是 expensive,失败应让业务方明确处理。
 */
export async function callWorkspaceInit(
  inst: SandboxInstance,
  opts: CallWorkspaceInitOpts,
): Promise<WorkspaceInitResponse['result']> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), opts.timeoutMs)
  try {
    const res = await inst.request('/api/workspace/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env: opts.credentials }),
      signal: ac.signal,
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new SandboxRestoreFailed(`init failed (${res.status}): ${detail.slice(0, 200)}`)
    }

    const body = await res.json().catch(() => null)
    if (!body) throw new SandboxRestoreFailed('init returned non-json body')

    const parsed = workspaceInitResponseSchema.safeParse(body)
    if (!parsed.success) {
      throw new SandboxRestoreFailed(`init response schema mismatch: ${parsed.error.message}`)
    }
    return parsed.data.result
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new SandboxRestoreTimeout(`init timeout after ${opts.timeoutMs}ms`, opts.timeoutMs)
    }
    if (err instanceof SandboxRestoreFailed || err instanceof SandboxRestoreTimeout) throw err
    throw new SandboxRestoreFailed(`init unexpected error: ${(err as Error).message}`, { cause: err })
  } finally {
    clearTimeout(t)
  }
}
