import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createCloudBaseMcpServer: vi.fn(),
  connectServer: vi.fn(),
  ping: vi.fn(),
  clientConnect: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  createLinkedPair: vi.fn(),
}))

vi.mock('@cloudbase/cloudbase-mcp', () => ({
  createCloudBaseMcpServer: mocks.createCloudBaseMcpServer,
}))

vi.mock('@modelcontextprotocol/sdk/inMemory.js', () => ({
  InMemoryTransport: {
    createLinkedPair: mocks.createLinkedPair,
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mocks.clientConnect
    listTools = mocks.listTools
    callTool = mocks.callTool
  },
}))

const { createCloudBaseMcpServerInProcess } = await import('../cloudbase-mcp-inprocess.js')

describe('createCloudBaseMcpServerInProcess', () => {
  beforeEach(() => {
    mocks.createCloudBaseMcpServer.mockReset()
    mocks.connectServer.mockReset()
    mocks.ping.mockReset()
    mocks.clientConnect.mockReset()
    mocks.listTools.mockReset()
    mocks.callTool.mockReset()
    mocks.createLinkedPair.mockReset()

    mocks.createLinkedPair.mockReturnValue([{ kind: 'client' }, { kind: 'server' }])
    mocks.createCloudBaseMcpServer.mockResolvedValue({
      connect: mocks.connectServer,
      server: { ping: mocks.ping },
    })
    mocks.listTools.mockResolvedValue({
      tools: [
        {
          name: 'envQuery',
          description: 'Query environment',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
        {
          name: 'readNoSqlDatabaseContent',
          description: 'Read NoSQL content',
          inputSchema: {
            type: 'object',
            properties: { collectionName: { type: 'string' } },
            required: ['collectionName'],
          },
        },
      ],
    })
  })

  it('creates cloudbase-mcp in process and registers all listed tools', async () => {
    const bundle = await createCloudBaseMcpServerInProcess({
      createServer: mocks.createCloudBaseMcpServer,
      workspaceFolderPaths: '/tmp/oak-local',
      getCredentials: async () => ({
        envId: 'env-test',
        secretId: 'secret-id',
        secretKey: 'secret-key',
        sessionToken: 'token',
      }),
    })

    expect(mocks.createCloudBaseMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'cloudbase-mcp',
        cloudBaseOptions: {
          envId: 'env-test',
          secretId: 'secret-id',
          secretKey: 'secret-key',
          token: 'token',
        },
        ide: 'open-agent-kernel',
        cloudMode: true,
        workspaceFolderPaths: '/tmp/oak-local',
      }),
    )
    expect(mocks.clientConnect).toHaveBeenCalled()
    expect(mocks.connectServer).toHaveBeenCalled()
    expect(mocks.listTools).toHaveBeenCalled()
    expect(bundle.toolCount).toBe(2)
    expect(bundle.degradedReason).toBeUndefined()
  })

  it('degrades when credentials are unavailable', async () => {
    const bundle = await createCloudBaseMcpServerInProcess({
      createServer: mocks.createCloudBaseMcpServer,
      getCredentials: async () => {
        throw new Error('missing credentials')
      },
    })

    expect(bundle.toolCount).toBe(0)
    expect(bundle.degradedReason).toMatch(/credentials unavailable/)
    expect(mocks.createCloudBaseMcpServer).not.toHaveBeenCalled()
  })
})
