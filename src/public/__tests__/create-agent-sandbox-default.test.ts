import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'

const DEFAULT_LOCAL_CWD = path.join(os.tmpdir(), 'oak-local-sandbox')

const mocks = vi.hoisted(() => ({
  agsStatefulSandbox: vi.fn(),
  localRuntimeSandbox: vi.fn(),
  query: vi.fn(),
}))

vi.mock('../../sandbox/ags-stateful-sandbox.js', () => {
  class MockAgsStatefulSandbox {
    readonly backend = 'ags-stateful'

    constructor(opts?: unknown) {
      mocks.agsStatefulSandbox(opts)
    }

    async acquire(): Promise<never> {
      throw new Error('not used in this test')
    }
  }

  return {
    AgsStatefulSandbox: MockAgsStatefulSandbox,
  }
})

vi.mock('../../sandbox/local-runtime-sandbox.js', () => {
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
    LocalRuntimeSandbox: MockLocalRuntimeSandbox,
  }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  return {
    ...mod,
    query: mocks.query,
  }
})

const { createAgent } = await import('../create-agent.js')

describe('createAgent — default sandbox runtime', () => {
  beforeEach(() => {
    mocks.agsStatefulSandbox.mockClear()
    mocks.localRuntimeSandbox.mockClear()
    mocks.query.mockReset()
    mocks.query.mockImplementation(async function* () {
      // no SDK messages needed
    })
    delete process.env.CLOUDBASE_APIKEY
    delete process.env.OAK_SANDBOX_API_KEY
  })

  // 默认 provider 是 'local'。远程 AGS 正规用法是 sandbox.runtime = new AgsStatefulSandbox(...)。
  it('defaults to LocalRuntimeSandbox when sandbox is omitted', () => {
    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
    })

    expect(mocks.localRuntimeSandbox).toHaveBeenCalledWith({ cwd: DEFAULT_LOCAL_CWD })
    expect(mocks.agsStatefulSandbox).not.toHaveBeenCalled()
  })

  it('defaults to LocalRuntimeSandbox when sandbox is an empty object', () => {
    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      sandbox: {},
    })

    expect(mocks.localRuntimeSandbox).toHaveBeenCalledWith({ cwd: DEFAULT_LOCAL_CWD })
    expect(mocks.agsStatefulSandbox).not.toHaveBeenCalled()
  })

  it('creates default LocalRuntimeSandbox when sandbox is enabled (no provider)', () => {
    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      sandbox: {
        enabled: true,
      },
    })

    expect(mocks.localRuntimeSandbox).toHaveBeenCalledWith({ cwd: DEFAULT_LOCAL_CWD })
    expect(mocks.agsStatefulSandbox).not.toHaveBeenCalled()
  })

  it('aligns default cwd with sandbox.workspaceRoot when cwd is omitted', () => {
    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      sandbox: {
        enabled: true,
        workspaceRoot: '/tmp/oak-custom-root',
      },
    })

    expect(mocks.localRuntimeSandbox).toHaveBeenCalledWith({
      cwd: '/tmp/oak-custom-root',
      workspaceRoot: '/tmp/oak-custom-root',
    })
  })

  it('does not create a sandbox runtime when sandbox.enabled is false', () => {
    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      sandbox: {
        enabled: false,
      },
    })

    expect(mocks.localRuntimeSandbox).not.toHaveBeenCalled()
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

  it('creates AgsStatefulSandbox when untyped provider is ags-stateful', () => {
    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      sandbox: {
        enabled: true,
        provider: 'ags-stateful',
        apiKey: 'sandbox-api-key',
      } as never,
    })

    expect(mocks.agsStatefulSandbox).toHaveBeenCalledWith({ apiKey: 'sandbox-api-key' })
    expect(mocks.localRuntimeSandbox).not.toHaveBeenCalled()
  })

  it('reads CLOUDBASE_APIKEY for the untyped ags-stateful provider', () => {
    process.env.CLOUDBASE_APIKEY = 'env-sandbox-api-key'

    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      sandbox: {
        enabled: true,
        provider: 'ags-stateful',
      } as never,
    })

    expect(mocks.agsStatefulSandbox).toHaveBeenCalledWith({ apiKey: 'env-sandbox-api-key' })
    expect(mocks.localRuntimeSandbox).not.toHaveBeenCalled()
  })

  it('requires an api key when untyped ags-stateful provider is selected', () => {
    expect(() =>
      createAgent({
        envId: 'env-test',
        model: 'glm-5.1',
        sandbox: {
          enabled: true,
          provider: 'ags-stateful',
        } as never,
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

  it('defaults scope to shared when ags-stateful runtime is injected without scope', async () => {
    const acquire = vi.fn(async () => ({
      id: 'ags:test',
      backend: 'ags-stateful',
      async request(): Promise<Response> {
        return new Response('{}', { status: 200 })
      },
      async release(): Promise<void> {},
    }))

    const agent = createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      session: { enabled: false },
      sandbox: {
        runtime: {
          backend: 'ags-stateful',
          acquire,
        },
        // disable snapshot so this test only asserts acquire scope defaulting
        workspaceSnapshot: 'disabled',
        cloudbaseTools: false,
      },
    })

    const session = await agent.startSession({ userId: 'u1' })
    for await (const _ of session.send('hello')) {
      // drain ACP stream
    }

    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'shared',
      }),
    )
  })

  it('preserves explicit scope=session on ags-stateful runtime injection', async () => {
    const acquire = vi.fn(async () => ({
      id: 'ags:test',
      backend: 'ags-stateful',
      async request(): Promise<Response> {
        return new Response('{}', { status: 200 })
      },
      async release(): Promise<void> {},
    }))

    const agent = createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      session: { enabled: false },
      sandbox: {
        runtime: {
          backend: 'ags-stateful',
          acquire,
        },
        scope: 'session',
        workspaceSnapshot: 'disabled',
        cloudbaseTools: false,
      },
    })

    const session = await agent.startSession({ userId: 'u1' })
    for await (const _ of session.send('hello')) {
      // drain ACP stream
    }

    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'session',
      }),
    )
  })
})
