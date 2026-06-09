import { describe, it, expect, vi } from 'vitest'
import { callWorkspaceSnapshot } from '../snapshot-client.js'
import { WorkspaceSnapshotError, SandboxUnavailableError } from '../errors.js'

const PROBLEM_HEADERS = { 'Content-Type': 'application/problem+json' }

function mockInst(responses: Array<() => Response>) {
  const queue = [...responses]
  return {
    id: 'inst-1',
    request: vi.fn().mockImplementation(async () => queue.shift()!()),
    release: vi.fn(),
  }
}

describe('callWorkspaceSnapshot', () => {
  it('parses { success, result: { ms } } on 200', async () => {
    const inst = mockInst([
      () =>
        new Response(JSON.stringify({ success: true, result: { ms: 1234 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ])
    const r = await callWorkspaceSnapshot(inst as any, { timeoutMs: 30_000, retryBackoffMs: 0 })
    expect(r.ms).toBe(1234)
  })

  it('retries once on retryable 500', async () => {
    const inst = mockInst([
      () =>
        new Response(
          JSON.stringify({ errorCode: 'workspace_snapshot_failed', retryable: true, detail: 'mutex held' }),
          { status: 500, headers: PROBLEM_HEADERS },
        ),
      () => new Response(JSON.stringify({ success: true, result: { ms: 200 } }), { status: 200 }),
    ])
    const r = await callWorkspaceSnapshot(inst as any, { timeoutMs: 30_000, retryBackoffMs: 0 })
    expect(r.ms).toBe(200)
    expect(inst.request).toHaveBeenCalledTimes(2)
  })

  it('does not retry on retryable=false', async () => {
    const inst = mockInst([
      () =>
        new Response(
          JSON.stringify({ errorCode: 'workspace_snapshot_failed', retryable: false, detail: 'fatal' }),
          { status: 500, headers: PROBLEM_HEADERS },
        ),
    ])
    await expect(
      callWorkspaceSnapshot(inst as any, { timeoutMs: 30_000, retryBackoffMs: 0 }),
    ).rejects.toThrow(WorkspaceSnapshotError)
    expect(inst.request).toHaveBeenCalledTimes(1)
  })

  it('does not retry on 502/503', async () => {
    const inst = mockInst([() => new Response('upstream gone', { status: 502 })])
    await expect(
      callWorkspaceSnapshot(inst as any, { timeoutMs: 30_000, retryBackoffMs: 0 }),
    ).rejects.toThrow(SandboxUnavailableError)
    expect(inst.request).toHaveBeenCalledTimes(1)
  })

  it('throws on timeout', async () => {
    const inst = {
      id: 'x',
      request: vi.fn().mockImplementation(
        async (_p: string, init?: RequestInit) =>
          new Promise((_, rej) =>
            init?.signal?.addEventListener('abort', () =>
              rej(new DOMException('aborted', 'AbortError')),
            ),
          ),
      ),
      release: vi.fn(),
    }
    await expect(
      callWorkspaceSnapshot(inst as any, { timeoutMs: 50, retryBackoffMs: 0 }),
    ).rejects.toThrow(/timeout/)
  })
})
