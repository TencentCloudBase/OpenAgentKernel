import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  put: vi.fn(),
  delete: vi.fn(),
  cosCtor: vi.fn(),
  accessKeyCtor: vi.fn(),
}))

vi.mock('../../claude-home/cloudbase-cos-store.js', () => {
  class MockCloudBaseCosClaudeHomeStore {
    constructor(opts?: unknown) {
      mocks.cosCtor(opts)
    }

    async put(ctx: unknown, path: string, content: Buffer): Promise<void> {
      mocks.put(ctx, path, content)
    }

    async delete(ctx: unknown, path: string): Promise<void> {
      mocks.delete(ctx, path)
    }
  }

  class MockCloudBaseAccessKeyClaudeHomeStore {
    constructor(opts?: unknown) {
      mocks.accessKeyCtor(opts)
    }

    async put(ctx: unknown, path: string, content: Buffer): Promise<void> {
      mocks.put(ctx, path, content)
    }

    async delete(ctx: unknown, path: string): Promise<void> {
      mocks.delete(ctx, path)
    }
  }

  return {
    CloudBaseAccessKeyClaudeHomeStore: MockCloudBaseAccessKeyClaudeHomeStore,
    CloudBaseCosClaudeHomeStore: MockCloudBaseCosClaudeHomeStore,
  }
})

const { deleteUserMemoryFiles, writeUserMemoryFiles } = await import('../index.js')
const originalTcbApiKey = process.env.TCB_API_KEY

describe('user-memory public helpers', () => {
  beforeEach(() => {
    delete process.env.TCB_API_KEY
    mocks.put.mockClear()
    mocks.delete.mockClear()
    mocks.cosCtor.mockClear()
    mocks.accessKeyCtor.mockClear()
  })

  afterAll(() => {
    if (originalTcbApiKey === undefined) delete process.env.TCB_API_KEY
    else process.env.TCB_API_KEY = originalTcbApiKey
  })

  it('writes through the CAM store with envId inherited into credentials', async () => {
    await writeUserMemoryFiles({
      envId: 'env-test',
      userId: 'user-1',
      credentials: {
        secretId: 'sid',
        secretKey: 'sk',
      },
      files: [{ path: 'CLAUDE.md', content: 'hello' }],
    })

    expect(mocks.cosCtor).toHaveBeenCalledWith({
      credentials: {
        envId: 'env-test',
        secretId: 'sid',
        secretKey: 'sk',
      },
    })
    expect(mocks.accessKeyCtor).not.toHaveBeenCalled()
    expect(mocks.put).toHaveBeenCalledWith(
      { envId: 'env-test', userId: 'user-1' },
      'CLAUDE.md',
      Buffer.from('hello', 'utf8'),
    )
  })

  it('prefers the CAM store when credentials and accessKey are both provided', async () => {
    await writeUserMemoryFiles({
      envId: 'env-test',
      userId: 'user-1',
      credentials: { secretId: 'sid', secretKey: 'sk' },
      accessKey: 'ignored-access-key',
      files: [{ path: 'CLAUDE.md', content: 'hello' }],
    })

    expect(mocks.cosCtor).toHaveBeenCalledTimes(1)
    expect(mocks.accessKeyCtor).not.toHaveBeenCalled()
  })

  it('writes through the accessKey store when CAM credentials are absent', async () => {
    await writeUserMemoryFiles({
      envId: 'env-test',
      userId: 'user-1',
      accessKey: 'explicit-access-key',
      files: [{ path: 'CLAUDE.md', content: 'hello' }],
    })

    expect(mocks.cosCtor).not.toHaveBeenCalled()
    expect(mocks.accessKeyCtor).toHaveBeenCalledWith({
      envId: 'env-test',
      accessKey: 'explicit-access-key',
    })
  })

  it('falls back to TCB_API_KEY for accessKey storage', async () => {
    process.env.TCB_API_KEY = 'env-access-key'

    await deleteUserMemoryFiles({
      envId: 'env-test',
      userId: 'user-1',
      paths: ['CLAUDE.md'],
    })

    expect(mocks.accessKeyCtor).toHaveBeenCalledWith({ envId: 'env-test', accessKey: 'env-access-key' })
  })

  it('rejects helpers when neither credential mode is available', async () => {
    await expect(
      writeUserMemoryFiles({ envId: 'env-test', userId: 'user-1', files: [] }),
    ).rejects.toThrow(/credentials.*accessKey.*TCB_API_KEY/)
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
