import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentInput } from '../types.js'

const mocks = vi.hoisted(() => ({
  cloudBaseStorage: vi.fn(),
}))

vi.mock('../../storage/cloudbase-storage.js', () => {
  class MockCloudBaseStorage {
    constructor(opts?: unknown) {
      mocks.cloudBaseStorage(opts)
    }

    async resolveAttachment(_att: AttachmentInput): Promise<unknown> {
      return {}
    }
  }

  return {
    CloudBaseStorage: MockCloudBaseStorage,
  }
})

const { createAgent } = await import('../create-agent.js')

describe('createAgent — default storage', () => {
  beforeEach(() => {
    mocks.cloudBaseStorage.mockClear()
  })

  it('enables CloudBase Storage by default when credentials are provided', () => {
    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      credentials: {
        secretId: 'sid',
        secretKey: 'sk',
      },
    })

    expect(mocks.cloudBaseStorage).toHaveBeenCalledWith({
      credentials: {
        envId: 'env-test',
        secretId: 'sid',
        secretKey: 'sk',
      },
    })
  })

  it('supports simplified CloudBase Storage config', () => {
    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      credentials: {
        secretId: 'sid',
        secretKey: 'sk',
      },
      storage: {
        pathPrefix: 'custom-attachments/',
        urlExpiresIn: 7200,
      },
    })

    expect(mocks.cloudBaseStorage).toHaveBeenCalledWith({
      credentials: {
        envId: 'env-test',
        secretId: 'sid',
        secretKey: 'sk',
      },
      pathPrefix: 'custom-attachments/',
      urlExpiresIn: 7200,
    })
  })

  it('allows disabling the default storage', () => {
    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      credentials: {
        secretId: 'sid',
        secretKey: 'sk',
      },
      storage: {
        enabled: false,
      },
    })

    expect(mocks.cloudBaseStorage).not.toHaveBeenCalled()
  })

  it('keeps custom storage provider untouched', () => {
    const storage = {
      async resolveAttachment(_att: AttachmentInput): Promise<unknown> {
        return {}
      },
    }

    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      credentials: {
        secretId: 'sid',
        secretKey: 'sk',
      },
      storage,
    })

    expect(mocks.cloudBaseStorage).not.toHaveBeenCalled()
  })

  it('requires credentials for simplified CloudBase Storage config', () => {
    expect(() =>
      createAgent({
        envId: 'env-test',
        model: 'glm-5.1',
        storage: {
          pathPrefix: 'custom-attachments/',
        },
      }),
    ).toThrow(/requires AgentConfig\.credentials/)
  })
})
