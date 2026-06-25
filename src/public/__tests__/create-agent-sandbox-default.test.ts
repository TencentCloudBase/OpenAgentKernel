import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  agsStatefulSandbox: vi.fn(),
  localRuntimeSandbox: vi.fn(),
}))

vi.mock('../../sandbox/index.js', () => {
  class MockAgsStatefulSandbox {
    readonly backend = 'ags-stateful'

    constructor(opts?: unknown) {
      mocks.agsStatefulSandbox(opts)
    }

    async acquire(): Promise<never> {
      throw new Error('not used in this test')
    }
  }
  class MockLocalRuntimeSandbox {
    readonly backend = 'local'

    constructor(opts?: unknown) {
      mocks.localRuntimeSandbox(opts)
    }

    async acquire(): Promise<never> {
      throw new Error('not used in this test')
    }
  }

  return {
    AgsStatefulSandbox: MockAgsStatefulSandbox,
    LocalRuntimeSandbox: MockLocalRuntimeSandbox,
  }
})

const { createAgent } = await import('../create-agent.js')

describe('createAgent — default sandbox runtime', () => {
  beforeEach(() => {
    mocks.agsStatefulSandbox.mockClear()
    mocks.localRuntimeSandbox.mockClear()
    delete process.env.CLOUDBASE_APIKEY
    delete process.env.OAK_SANDBOX_API_KEY
  })

  it('creates default AgsStatefulSandbox when sandbox is enabled', () => {
    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      sandbox: {
        enabled: true,
        apiKey: 'sandbox-api-key',
      },
    })

    expect(mocks.agsStatefulSandbox).toHaveBeenCalledWith({ apiKey: 'sandbox-api-key' })
    expect(mocks.localRuntimeSandbox).not.toHaveBeenCalled()
  })

  it('reads CLOUDBASE_APIKEY for the default ags-stateful provider', () => {
    process.env.CLOUDBASE_APIKEY = 'env-sandbox-api-key'

    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      sandbox: {
        enabled: true,
      },
    })

    expect(mocks.agsStatefulSandbox).toHaveBeenCalledWith({ apiKey: 'env-sandbox-api-key' })
    expect(mocks.localRuntimeSandbox).not.toHaveBeenCalled()
  })

  it('requires an api key when ags-stateful provider is enabled', () => {
    expect(() =>
      createAgent({
        envId: 'env-test',
        model: 'glm-5.1',
        sandbox: {
          enabled: true,
        },
      }),
    ).toThrow(/sandbox\.apiKey/)
  })

  it('keeps custom sandbox runtime untouched', () => {
    const runtime = {
      backend: 'custom',
      async acquire(): Promise<never> {
        throw new Error('not used in this test')
      },
    }

    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      sandbox: {
        runtime,
      },
    })

    expect(mocks.agsStatefulSandbox).not.toHaveBeenCalled()
    expect(mocks.localRuntimeSandbox).not.toHaveBeenCalled()
  })

  it('creates LocalRuntimeSandbox when provider is local', () => {
    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      sandbox: {
        enabled: true,
        provider: 'local',
      },
    })

    expect(mocks.localRuntimeSandbox).toHaveBeenCalledWith({})
    expect(mocks.agsStatefulSandbox).not.toHaveBeenCalled()
  })

  it('passes cwd and workspaceRoot to LocalRuntimeSandbox', () => {
    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      cwd: '/tmp/oak-local',
      sandbox: {
        enabled: true,
        provider: 'local',
        workspaceRoot: '/tmp/oak-local',
      },
    })

    expect(mocks.localRuntimeSandbox).toHaveBeenCalledWith({
      cwd: '/tmp/oak-local',
      workspaceRoot: '/tmp/oak-local',
    })
  })

  it('local provider does not require apiKey', () => {
    expect(() =>
      createAgent({
        envId: 'env-test',
        model: 'glm-5.1',
        sandbox: {
          enabled: true,
          provider: 'local',
        },
      }),
    ).not.toThrow()
  })
})
