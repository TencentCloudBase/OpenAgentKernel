import { describe, it, expect, vi } from 'vitest'
import { callWorkspaceInit } from '../init-client.js'
import { SandboxRestoreFailed, SandboxRestoreTimeout } from '../errors.js'

function mockInst(handler: (path: string, init?: RequestInit) => Promise<Response>) {
  return {
    id: 'inst-1',
    request: vi.fn().mockImplementation(handler),
    release: vi.fn(),
  }
}

describe('callWorkspaceInit', () => {
  it('returns init result on success (no restoreStatus expected)', async () => {
    const inst = mockInst(async (path) => {
      expect(path).toBe('/api/workspace/init')
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            workspace: '/home/user',
            git: { enabled: true, hasGit: true, branch: 'main' },
            env: { CLOUDBASE_ENV_ID: '<set>' },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    const result = await callWorkspaceInit(inst as any, {
      credentials: { CLOUDBASE_ENV_ID: 'env-1' },
      timeoutMs: 60_000,
    })
    expect(result.workspace).toBe('/home/user')
    // 不应有 restoreStatus 字段(init body 不返回它)
    expect((result as any).restoreStatus).toBeUndefined()
  })

  it('throws SandboxRestoreFailed on 5xx', async () => {
    const inst = mockInst(async () => new Response('boom', { status: 500 }))
    await expect(callWorkspaceInit(inst as any, { credentials: {}, timeoutMs: 60_000 })).rejects.toThrow(
      SandboxRestoreFailed,
    )
  })

  it('throws SandboxRestoreFailed when body schema mismatch', async () => {
    const inst = mockInst(
      async () => new Response(JSON.stringify({ success: false, msg: 'unexpected shape' }), { status: 200 }),
    )
    await expect(callWorkspaceInit(inst as any, { credentials: {}, timeoutMs: 60_000 })).rejects.toThrow(
      SandboxRestoreFailed,
    )
  })

  it('throws SandboxRestoreTimeout when timeout exceeded', async () => {
    const inst = mockInst(
      async (_p, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    await expect(callWorkspaceInit(inst as any, { credentials: {}, timeoutMs: 100 })).rejects.toThrow(
      SandboxRestoreTimeout,
    )
  })

  it('sends credentials in body.env', async () => {
    let capturedBody: any
    const inst = mockInst(async (_p, init) => {
      capturedBody = JSON.parse(init?.body as string)
      return new Response(
        JSON.stringify({
          success: true,
          result: { workspace: '/home/user', git: { enabled: false, hasGit: false }, env: {} },
        }),
        { status: 200 },
      )
    })
    await callWorkspaceInit(inst as any, {
      credentials: { CLOUDBASE_ENV_ID: 'env-1', TENCENTCLOUD_SECRETID: 's' },
      timeoutMs: 60_000,
    })
    expect(capturedBody.env).toEqual({ CLOUDBASE_ENV_ID: 'env-1', TENCENTCLOUD_SECRETID: 's' })
  })
})
