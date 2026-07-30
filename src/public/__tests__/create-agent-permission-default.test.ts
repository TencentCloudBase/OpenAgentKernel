import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingApproval, PermissionStore } from '../types.js'

const mocks = vi.hoisted(() => ({
  cloudBaseDbDriver: vi.fn(),
  cloudBaseDbPermissionDriver: vi.fn(),
  cloudBasePermissionStore: vi.fn(),
}))

vi.mock('../../permissions/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../permissions/index.js')>()

  class MockCloudBaseDbPermissionDriver {
    constructor(opts?: unknown) {
      mocks.cloudBaseDbPermissionDriver(opts)
    }
  }

  class MockCloudBasePermissionStore implements PermissionStore {
    constructor(opts?: unknown) {
      mocks.cloudBasePermissionStore(opts)
    }

    async put(_call: PendingApproval): Promise<void> {}

    async get(_key: { conversationId: string; toolUseId: string }): Promise<PendingApproval | null> {
      return null
    }

    async delete(_key: { conversationId: string; toolUseId: string }): Promise<void> {}
  }

  return {
    ...actual,
    CloudBaseDbPermissionDriver: MockCloudBaseDbPermissionDriver,
    CloudBasePermissionStore: MockCloudBasePermissionStore,
  }
})

vi.mock('../../session-store/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../session-store/index.js')>()

  class MockCloudBaseDbDriver {
    constructor(opts?: unknown) {
      mocks.cloudBaseDbDriver(opts)
    }
  }

  return {
    ...actual,
    CloudBaseDbDriver: MockCloudBaseDbDriver,
  }
})

const { createAgent } = await import('../create-agent.js')
const originalTcbApiKey = process.env.TCB_API_KEY

describe('createAgent — default permission store', () => {
  beforeEach(() => {
    delete process.env.TCB_API_KEY
    mocks.cloudBaseDbDriver.mockClear()
    mocks.cloudBaseDbPermissionDriver.mockClear()
    mocks.cloudBasePermissionStore.mockClear()
  })

  afterAll(() => {
    if (originalTcbApiKey === undefined) delete process.env.TCB_API_KEY
    else process.env.TCB_API_KEY = originalTcbApiKey
  })

  it('prefers credentials for the default permission store when TCB_API_KEY is also present', () => {
    process.env.TCB_API_KEY = 'ignored-access-key'

    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      credentials: {
        secretId: 'sid',
        secretKey: 'sk',
      },
      permissions: {
        requireApproval: '*',
        tablePrefix: 'perm_',
      },
    })

    expect(mocks.cloudBaseDbPermissionDriver).toHaveBeenCalledWith({
      credentials: {
        envId: 'env-test',
        secretId: 'sid',
        secretKey: 'sk',
      },
      collectionPrefix: 'perm_',
    })
    expect(mocks.cloudBasePermissionStore).toHaveBeenCalledWith(
      expect.objectContaining({
        projectKey: 'env-test',
      }),
    )
  })

  it('uses TCB_API_KEY accessKey for default session and HITL persistence without credentials', async () => {
    process.env.TCB_API_KEY = 'test-access-key'

    const agent = createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      session: { tablePrefix: 'session_' },
      permissions: {
        requireApproval: '*',
        tablePrefix: 'perm_',
      },
    })

    expect(mocks.cloudBaseDbDriver).toHaveBeenCalledWith({
      accessKey: { envId: 'env-test', accessKey: 'test-access-key' },
      collectionPrefix: 'session_',
    })
    expect(mocks.cloudBaseDbPermissionDriver).toHaveBeenCalledWith({
      accessKey: { envId: 'env-test', accessKey: 'test-access-key' },
      collectionPrefix: 'perm_',
    })
    expect(mocks.cloudBasePermissionStore).toHaveBeenCalledWith(
      expect.objectContaining({
        projectKey: 'env-test',
      }),
    )
    await expect(agent.resumeSession('conversation-id')).resolves.toMatchObject({
      id: 'conversation-id',
    })
  })

  it('rejects userMemory in TCB_API_KEY-only mode with an explicit credentials error', () => {
    process.env.TCB_API_KEY = 'test-access-key'

    expect(() =>
      createAgent({
        envId: 'env-test',
        model: 'glm-5.1',
        userMemory: true,
      }),
    ).toThrow(/userMemory requires AgentConfig\.credentials/)
  })

  it('keeps custom permission store untouched', () => {
    const store: PermissionStore = {
      async put() {},
      async get() {
        return null
      },
      async delete() {},
    }

    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      credentials: {
        secretId: 'sid',
        secretKey: 'sk',
      },
      permissions: {
        requireApproval: '*',
        store,
      },
    })

    expect(mocks.cloudBaseDbPermissionDriver).not.toHaveBeenCalled()
    expect(mocks.cloudBasePermissionStore).not.toHaveBeenCalled()
  })

  it('keeps in-memory fallback when credentials are not provided', () => {
    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      permissions: {
        requireApproval: '*',
      },
    })

    expect(mocks.cloudBaseDbPermissionDriver).not.toHaveBeenCalled()
    expect(mocks.cloudBasePermissionStore).not.toHaveBeenCalled()
  })
})
