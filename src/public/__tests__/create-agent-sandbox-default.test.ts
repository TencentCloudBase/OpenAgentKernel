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

  // 默认 provider 现在是 'local'(AGS 产品化未就绪前的过渡默认)。
  // 用户想要 AGS 必须显式写 provider: 'ags-stateful'。
  it('creates default LocalRuntimeSandbox when sandbox is enabled (no provider)', () => {
    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      sandbox: {
        enabled: true,
      },
    })

    expect(mocks.localRuntimeSandbox).toHaveBeenCalledWith({})
    expect(mocks.agsStatefulSandbox).not.toHaveBeenCalled()
  })

  it('passes cwd and workspaceRoot to default LocalRuntimeSandbox', () => {
    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      cwd: '/tmp/oak-local',
      sandbox: {
        enabled: true,
        workspaceRoot: '/tmp/oak-local',
      },
    })

    expect(mocks.localRuntimeSandbox).toHaveBeenCalledWith({
      cwd: '/tmp/oak-local',
      workspaceRoot: '/tmp/oak-local',
    })
  })

  it('creates AgsStatefulSandbox when provider is explicitly ags-stateful', () => {
    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      sandbox: {
        enabled: true,
        provider: 'ags-stateful',
        apiKey: 'sandbox-api-key',
      },
    })

    expect(mocks.agsStatefulSandbox).toHaveBeenCalledWith({ apiKey: 'sandbox-api-key' })
    expect(mocks.localRuntimeSandbox).not.toHaveBeenCalled()
  })

  it('reads CLOUDBASE_APIKEY for the ags-stateful provider', () => {
    process.env.CLOUDBASE_APIKEY = 'env-sandbox-api-key'

    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      sandbox: {
        enabled: true,
        provider: 'ags-stateful',
      },
    })

    expect(mocks.agsStatefulSandbox).toHaveBeenCalledWith({ apiKey: 'env-sandbox-api-key' })
    expect(mocks.localRuntimeSandbox).not.toHaveBeenCalled()
  })

  it('requires an api key when ags-stateful provider is selected', () => {
    expect(() =>
      createAgent({
        envId: 'env-test',
        model: 'glm-5.1',
        sandbox: {
          enabled: true,
          provider: 'ags-stateful',
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
})
