import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  build: vi.fn(),
  query: vi.fn(),
  accessKeyStoreCtor: vi.fn(),
  syncEngineCtor: vi.fn(),
  pull: vi.fn(),
  push: vi.fn(),
  deriveClaudeConfigDir: vi.fn((envId: string, userId: string) => `/tmp/oak/${envId}/${userId}/.claude`),
}))

vi.mock('../../runtime/agent-builder.js', () => ({
  buildClaudeQueryOptions: mocks.build,
}))

vi.mock('../../claude-home/cloudbase-cos-store.js', () => {
  class MockCloudBaseAccessKeyClaudeHomeStore {
    constructor(opts: unknown) {
      mocks.accessKeyStoreCtor(opts)
    }

    async pull(): Promise<Map<string, string>> {
      return new Map()
    }

    async put(): Promise<void> {}

    async delete(): Promise<void> {}
  }

  return { CloudBaseAccessKeyClaudeHomeStore: MockCloudBaseAccessKeyClaudeHomeStore }
})

vi.mock('../../claude-home/index.js', () => {
  class MockClaudeHomeSyncEngine {
    constructor(opts: unknown) {
      mocks.syncEngineCtor(opts)
    }

    async pullOnSendStart(): Promise<void> {
      mocks.pull()
    }

    async pushOnSendEnd(): Promise<void> {
      mocks.push()
    }
  }

  return {
    ClaudeHomeSyncEngine: MockClaudeHomeSyncEngine,
    deriveClaudeConfigDir: mocks.deriveClaudeConfigDir,
  }
})

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mocks.query,
}))

const { createAgent } = await import('../create-agent.js')
const originalTcbApiKey = process.env.TCB_API_KEY

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of iterable) {
    // Empty mocked SDK stream; consuming it is what drives runClaudeQuery.
  }
}

describe('createAgent — accessKey userMemory shim', () => {
  beforeEach(() => {
    process.env.TCB_API_KEY = 'captured-access-key'
    for (const mock of Object.values(mocks)) {
      if ('mockClear' in mock) mock.mockClear()
    }
    mocks.build.mockImplementation((config: { cwd?: string }) => ({
      options: {
        env: { KEEP_ME: 'yes', CLAUDE_CONFIG_DIR: '/tmp/session-only' },
        cwd: config.cwd ?? '/tmp/ephemeral',
        settingSources: config.cwd ? ['project'] : [],
        persistSession: false,
      },
      credential: { modelId: 'model', baseUrl: 'https://example.test', apiKey: 'model-key' },
      syncEngine: undefined,
      snapshotEngine: undefined,
    }))
    mocks.query.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {},
    }))
  })

  afterAll(() => {
    if (originalTcbApiKey === undefined) delete process.env.TCB_API_KEY
    else process.env.TCB_API_KEY = originalTcbApiKey
  })

  it('removes the builder fail-fast and atomically adds accessKey memory query options', async () => {
    const agent = createAgent({
      envId: 'env-test',
      model: { id: 'model', apiKey: 'model-key' },
      session: { enabled: false },
      userMemory: true,
    })
    // Prove normalization captured the key rather than re-reading mutable env at send time.
    process.env.TCB_API_KEY = 'changed-after-create'

    const session = await agent.startSession({ userId: 'alice' })
    await drain(session.send('hello'))

    expect(mocks.build).toHaveBeenCalledTimes(1)
    expect(mocks.build.mock.calls[0][0]).toEqual(expect.objectContaining({ userMemory: false }))
    expect(mocks.accessKeyStoreCtor).toHaveBeenCalledWith({
      envId: 'env-test',
      accessKey: 'captured-access-key',
    })
    expect(mocks.syncEngineCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: { envId: 'env-test', userId: 'alice' },
        localDir: '/tmp/oak/env-test/alice/.claude',
      }),
    )
    expect(mocks.pull).toHaveBeenCalledTimes(1)
    expect(mocks.push).toHaveBeenCalledTimes(1)

    const sdkOptions = mocks.query.mock.calls[0][0].options
    expect(sdkOptions.env).toMatchObject({
      KEEP_ME: 'yes',
      CLAUDE_CONFIG_DIR: '/tmp/oak/env-test/alice/.claude',
    })
    expect(sdkOptions.cwd).toBe('/tmp/oak/env-test/alice')
    expect(sdkOptions.settingSources).toEqual(['user'])
    expect(sdkOptions.persistSession).toBe(true)
  })

  it('preserves explicit cwd and project settings while appending user exactly once', async () => {
    const agent = createAgent({
      envId: 'env-test',
      model: { id: 'model', apiKey: 'model-key' },
      session: { enabled: false },
      cwd: '/srv/platform-assets',
      userMemory: { enabled: true },
    })
    const session = await agent.startSession({ userId: 'alice' })
    await drain(session.send('hello'))

    const sdkOptions = mocks.query.mock.calls[0][0].options
    expect(sdkOptions.cwd).toBe('/srv/platform-assets')
    expect(sdkOptions.settingSources).toEqual(['project', 'user'])
  })

  it('keeps the CAM path delegated to buildClaudeQueryOptions even when TCB_API_KEY is present', async () => {
    const credentials = { secretId: 'sid', secretKey: 'sk' }
    const agent = createAgent({
      envId: 'env-test',
      model: { id: 'model', apiKey: 'model-key' },
      credentials,
      session: { enabled: false },
      userMemory: true,
    })
    const session = await agent.startSession({ userId: 'alice' })
    await drain(session.send('hello'))

    expect(mocks.build.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        userMemory: true,
        credentials: { envId: 'env-test', secretId: 'sid', secretKey: 'sk' },
      }),
    )
    expect(mocks.accessKeyStoreCtor).not.toHaveBeenCalled()
    expect(mocks.syncEngineCtor).not.toHaveBeenCalled()
  })

  it('leaves all four query option fields and sync engine untouched when construction fails', async () => {
    mocks.deriveClaudeConfigDir.mockImplementationOnce(() => {
      throw new Error('derive failed')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const agent = createAgent({
      envId: 'env-test',
      model: { id: 'model', apiKey: 'model-key' },
      session: { enabled: false },
      userMemory: true,
    })
    const session = await agent.startSession({ userId: 'alice' })
    await drain(session.send('hello'))

    const sdkOptions = mocks.query.mock.calls[0][0].options
    expect(sdkOptions.env.CLAUDE_CONFIG_DIR).toBe('/tmp/session-only')
    expect(sdkOptions.cwd).toBe('/tmp/ephemeral')
    expect(sdkOptions.settingSources).toEqual([])
    expect(sdkOptions.persistSession).toBe(false)
    expect(mocks.syncEngineCtor).not.toHaveBeenCalled()
    expect(mocks.pull).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      '[oak/userMemory] failed to construct sync engine, sync disabled this turn:',
      'derive failed',
    )
  })
})
