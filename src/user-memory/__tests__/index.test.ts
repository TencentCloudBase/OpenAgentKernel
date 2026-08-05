import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  put: vi.fn(),
  delete: vi.fn(),
  ctor: vi.fn(),
}))

vi.mock('../../claude-home/index.js', () => {
  class MockCloudBaseCosClaudeHomeStore {
    constructor(opts?: unknown) {
      mocks.ctor(opts)
    }

    async put(ctx: unknown, path: string, content: Buffer): Promise<void> {
      mocks.put(ctx, path, content)
    }

    async delete(ctx: unknown, path: string): Promise<void> {
      mocks.delete(ctx, path)
    }
  }

  return {
    CloudBaseCosClaudeHomeStore: MockCloudBaseCosClaudeHomeStore,
  }
})

const { deleteUserMemoryFiles, writeUserMemoryFiles } = await import('../index.js')

describe('user-memory public helpers', () => {
  beforeEach(() => {
    mocks.put.mockClear()
    mocks.delete.mockClear()
    mocks.ctor.mockClear()
  })

  it('writes files with envId inherited into credentials', async () => {
    await writeUserMemoryFiles({
      envId: 'env-test',
      userId: 'user-1',
      credentials: {
        secretId: 'sid',
        secretKey: 'sk',
      },
      files: [{ path: 'CLAUDE.md', content: 'hello' }],
    })

    expect(mocks.ctor).toHaveBeenCalledWith({
      credentials: {
        envId: 'env-test',
        secretId: 'sid',
        secretKey: 'sk',
      },
    })
    expect(mocks.put).toHaveBeenCalledWith(
      { envId: 'env-test', userId: 'user-1' },
      'CLAUDE.md',
      Buffer.from('hello', 'utf8'),
    )
  })

  it('deletes files from the user memory namespace', async () => {
    await deleteUserMemoryFiles({
      envId: 'env-test',
      userId: 'user-1',
      credentials: {
        secretId: 'sid',
        secretKey: 'sk',
      },
      paths: ['CLAUDE.md'],
    })

    expect(mocks.delete).toHaveBeenCalledWith({ envId: 'env-test', userId: 'user-1' }, 'CLAUDE.md')
  })
})
