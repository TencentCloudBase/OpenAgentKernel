import { mkdtemp, rm } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalRuntimeSandbox } from '../local-runtime-sandbox.js'

const cleanup: string[] = []

afterEach(async () => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

describe('LocalRuntimeSandbox', () => {
  it('creates a writable workspaceRoot and returns a local instance', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'oak-local-test-'))
    cleanup.push(workspaceRoot)

    const runtime = new LocalRuntimeSandbox({ workspaceRoot })
    const instance = await runtime.acquire({
      envId: 'env-test',
      conversationId: 'conv-test',
      userId: 'user-test',
    })

    expect(instance.id).toBe('local:conv-test')
    expect(instance.backend).toBe('local')
    expect(instance.workspaceRoot).toBe(workspaceRoot)
  })

  it('derives a per-session workspaceRoot when none is configured', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'oak-local-base-'))
    cleanup.push(base)
    process.env.OAK_WORKSPACE_ROOT = base

    try {
      const runtime = new LocalRuntimeSandbox()
      const instance = await runtime.acquire({
        envId: 'env/test',
        conversationId: 'conv/test',
        userId: 'user/test',
      })

      expect(instance.workspaceRoot).toBe(path.join(base, 'env-test', 'user-test', 'conv-test'))
    } finally {
      delete process.env.OAK_WORKSPACE_ROOT
    }
  })

  it('throws a clear error when request is used in local mode', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'oak-local-test-'))
    cleanup.push(workspaceRoot)

    const runtime = new LocalRuntimeSandbox({ workspaceRoot })
    const instance = await runtime.acquire({
      envId: 'env-test',
      conversationId: 'conv-test',
      userId: 'user-test',
    })

    await expect(instance.request('/api/tools/bash')).rejects.toThrow(/does not expose an HTTP data plane/)
  })

  it('rejects conflicting cwd and workspaceRoot', () => {
    expect(
      () =>
        new LocalRuntimeSandbox({
          cwd: '/tmp/oak-a',
          workspaceRoot: '/tmp/oak-b',
        }),
    ).toThrow(/must point to the same directory/)
  })
})
