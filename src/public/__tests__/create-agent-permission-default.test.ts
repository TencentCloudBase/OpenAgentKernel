import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingApproval, PermissionStore } from '../types.js'

const mocks = vi.hoisted(() => ({
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

const { createAgent } = await import('../create-agent.js')

describe('createAgent — default permission store', () => {
  beforeEach(() => {
    mocks.cloudBaseDbPermissionDriver.mockClear()
    mocks.cloudBasePermissionStore.mockClear()
  })

  it('enables CloudBase FlexDB permission store by default when credentials and requireApproval are provided', () => {
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
