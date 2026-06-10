import { describe, it, expect, vi } from 'vitest'
import { WorkspaceSnapshotEngine } from '../snapshot-engine.js'
import { SandboxRestoreFailed } from '../errors.js'

const goodInit = {
  success: true,
  result: {
    workspace: '/home/user',
    git: { enabled: true, hasGit: true, branch: 'main' },
    env: {},
  },
}
const fullHealth = {
  ok: true,
  restoreStatus: { restored: 'full', restoredAt: 'x', source: 'cos' },
}
const failedHealth = {
  ok: true,
  restoreStatus: { restored: 'failed', restoredAt: 'x', source: 'cos', note: 'boom' },
}
const goodSnap = { success: true, result: { ms: 100 } }

function mockInst(handlers: Record<string, () => Response>) {
  return {
    id: 'x',
    request: vi
      .fn()
      .mockImplementation(async (path: string) => handlers[path]?.() ?? new Response('not handled', { status: 404 })),
    release: vi.fn(),
  }
}

describe('WorkspaceSnapshotEngine', () => {
  it('bootstrap returns SyncStatus when init OK + health says full', async () => {
    const inst = mockInst({
      '/api/workspace/init': () => new Response(JSON.stringify(goodInit), { status: 200 }),
      '/health': () => new Response(JSON.stringify(fullHealth), { status: 200 }),
    })
    const e = new WorkspaceSnapshotEngine({ healthRetryDelayMs: 0 })
    const status = await e.bootstrap(inst as any, { credentials: {} })
    expect(status?.restored).toBe('full')
  })

  it('bootstrap throws SandboxRestoreFailed when health says failed', async () => {
    const inst = mockInst({
      '/api/workspace/init': () => new Response(JSON.stringify(goodInit), { status: 200 }),
      '/health': () => new Response(JSON.stringify(failedHealth), { status: 200 }),
    })
    const e = new WorkspaceSnapshotEngine({ healthRetryDelayMs: 0 })
    await expect(e.bootstrap(inst as any, { credentials: {} })).rejects.toThrow(SandboxRestoreFailed)
  })

  it('bootstrap throws SandboxRestoreFailed when init 5xx (does not call /health)', async () => {
    const inst = mockInst({
      '/api/workspace/init': () => new Response('boom', { status: 500 }),
    })
    const e = new WorkspaceSnapshotEngine({ healthRetryDelayMs: 0 })
    await expect(e.bootstrap(inst as any, { credentials: {} })).rejects.toThrow(SandboxRestoreFailed)
  })

  it('bootstrap returns null when /health restoreStatus stays null after retries (graceful degrade)', async () => {
    const inst = mockInst({
      '/api/workspace/init': () => new Response(JSON.stringify(goodInit), { status: 200 }),
      '/health': () => new Response(JSON.stringify({ ok: true, restoreStatus: null }), { status: 200 }),
    })
    const e = new WorkspaceSnapshotEngine({ healthMaxAttempts: 2, healthRetryDelayMs: 0 })
    const status = await e.bootstrap(inst as any, { credentials: {} })
    expect(status).toBeNull() // session 仍可用,只是不知道 restore 是否真完成
  })

  it('snapshot delegates to client', async () => {
    const inst = mockInst({
      '/api/workspace/snapshot': () => new Response(JSON.stringify(goodSnap), { status: 200 }),
    })
    const e = new WorkspaceSnapshotEngine()
    const r = await e.snapshot(inst as any)
    expect(r.ms).toBe(100)
  })

  it('getRestoreStatus reads /health (not retried)', async () => {
    const inst = mockInst({
      '/health': () =>
        new Response(
          JSON.stringify({
            ok: true,
            restoreStatus: { restored: 'partial', restoredAt: 'x', source: 'cos' },
          }),
          { status: 200 },
        ),
    })
    const e = new WorkspaceSnapshotEngine()
    expect(await e.getRestoreStatus(inst as any)).toBe('partial')
  })

  // 回归:undefined 字段不能覆盖默认值 —— `{ ...DEFAULT, ...opts }` 模式会让显式
  // undefined 覆盖默认值,导致 setTimeout(undefined) 立即触发 → init 抛
  // "init timeout after undefinedms"。constructor 现在用 `??` 逐字段 fallback。
  it('explicit undefined options fall back to defaults (not coerce to undefined)', async () => {
    const inst = mockInst({
      '/api/workspace/init': () => new Response(JSON.stringify(goodInit), { status: 200 }),
      '/health': () => new Response(JSON.stringify(fullHealth), { status: 200 }),
    })
    // 模拟调用方写 `{ initTimeoutMs: config?.workspaceInitTimeoutMs }` 但 config 没设
    const e = new WorkspaceSnapshotEngine({
      initTimeoutMs: undefined,
      snapshotTimeoutMs: undefined,
      retryBackoffMs: undefined,
      healthMaxAttempts: undefined,
      healthRetryDelayMs: 0, // 唯一显式给的值,避免实际等
    })
    // 必须正常 bootstrap;若 undefined 透到 init-client,setTimeout 会立即触发 → reject
    const status = await e.bootstrap(inst as any, { credentials: {} })
    expect(status?.restored).toBe('full')
  })
})
