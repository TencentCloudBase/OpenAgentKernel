import { describe, it, expect, vi } from 'vitest'
import { fetchRestoreStatus, getHealthRestoreStatus } from '../health-client.js'

function mockInst(responses: Array<() => Response>) {
  const queue = [...responses]
  return {
    id: 'x',
    request: vi.fn().mockImplementation(async () => queue.shift()!()),
    release: vi.fn(),
  }
}

describe('fetchRestoreStatus(bootstrap 路径,会重试)', () => {
  it('returns SyncStatus on first success', async () => {
    const inst = mockInst([
      () =>
        new Response(
          JSON.stringify({
            ok: true,
            restoreStatus: { restored: 'full', restoredAt: 'x', source: 'cos' },
          }),
          { status: 200 },
        ),
    ])
    const status = await fetchRestoreStatus(inst as any, { maxAttempts: 3, retryDelayMs: 0 })
    expect(status?.restored).toBe('full')
  })

  it('retries when restoreStatus is null (init/health race)', async () => {
    const inst = mockInst([
      () => new Response(JSON.stringify({ ok: true, restoreStatus: null }), { status: 200 }),
      () => new Response(JSON.stringify({ ok: true, restoreStatus: null }), { status: 200 }),
      () =>
        new Response(
          JSON.stringify({
            ok: true,
            restoreStatus: { restored: 'fresh', restoredAt: 'x', source: 'none' },
          }),
          { status: 200 },
        ),
    ])
    const status = await fetchRestoreStatus(inst as any, { maxAttempts: 5, retryDelayMs: 0 })
    expect(status?.restored).toBe('fresh')
    expect(inst.request).toHaveBeenCalledTimes(3)
  })

  it('returns null after exhausting maxAttempts', async () => {
    const inst = mockInst([
      () => new Response(JSON.stringify({ ok: true, restoreStatus: null }), { status: 200 }),
      () => new Response(JSON.stringify({ ok: true, restoreStatus: null }), { status: 200 }),
    ])
    const status = await fetchRestoreStatus(inst as any, { maxAttempts: 2, retryDelayMs: 0 })
    expect(status).toBeNull()
  })

  it('returns null on /health 5xx (graceful, lets caller proceed without restoreStatus)', async () => {
    const inst = mockInst([() => new Response('boom', { status: 503 })])
    const status = await fetchRestoreStatus(inst as any, { maxAttempts: 1, retryDelayMs: 0 })
    expect(status).toBeNull()
  })
})

describe('getHealthRestoreStatus(事后查询路径,不重试)', () => {
  it('returns "full" when restoreStatus.restored === "full"', async () => {
    const inst = mockInst([
      () =>
        new Response(
          JSON.stringify({
            ok: true,
            restoreStatus: { restored: 'full', restoredAt: 'x', source: 'cos' },
          }),
          { status: 200 },
        ),
    ])
    expect(await getHealthRestoreStatus(inst as any)).toBe('full')
  })

  it('returns null when restoreStatus is null', async () => {
    const inst = mockInst([() => new Response(JSON.stringify({ ok: true, restoreStatus: null }), { status: 200 })])
    expect(await getHealthRestoreStatus(inst as any)).toBeNull()
  })

  it('returns null when /health 5xx (graceful)', async () => {
    const inst = mockInst([() => new Response('boom', { status: 503 })])
    expect(await getHealthRestoreStatus(inst as any)).toBeNull()
  })

  it('returns null on schema mismatch (graceful, never throws)', async () => {
    const inst = mockInst([() => new Response(JSON.stringify({ unexpected: true }), { status: 200 })])
    expect(await getHealthRestoreStatus(inst as any)).toBeNull()
  })
})
