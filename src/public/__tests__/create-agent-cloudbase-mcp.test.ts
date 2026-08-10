import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createCloudBaseMcpServer: vi.fn(),
  createCloudBaseMcpServerInProcess: vi.fn(),
  query: vi.fn(),
}))

vi.mock('../../sandbox/cloudbase-mcp.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../sandbox/cloudbase-mcp.js')>()
  return {
    ...mod,
    createCloudBaseMcpServer: mocks.createCloudBaseMcpServer,
  }
})

vi.mock('../../sandbox/cloudbase-mcp-inprocess.js', () => ({
  createCloudBaseMcpServerInProcess: mocks.createCloudBaseMcpServerInProcess,
}))

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  return {
    ...mod,
    query: mocks.query,
  }
})

const { createAgent } = await import('../create-agent.js')

describe('createAgent — local cloudbase MCP path', () => {
  beforeEach(() => {
    mocks.createCloudBaseMcpServer.mockReset()
    mocks.createCloudBaseMcpServerInProcess.mockReset()
    mocks.query.mockReset()

    mocks.createCloudBaseMcpServerInProcess.mockResolvedValue({
      server: { name: 'cloudbase' },
      toolCount: 1,
      invoke: vi.fn(),
    })
    mocks.createCloudBaseMcpServer.mockResolvedValue({
      server: { name: 'cloudbase-remote' },
      toolCount: 1,
      invoke: vi.fn(),
    })
    mocks.query.mockImplementation(async function* () {
      // no SDK messages needed — we only assert MCP factory selection
    })

    process.env.CLOUDBASE_APIKEY = 'test-api-key'
  })

  it('uses in-process CloudBase MCP for local sandbox and skips remote factory', async () => {
    const agent = createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      cwd: '/tmp/oak-local-mcp-test',
      session: { enabled: false },
      sandbox: {
        enabled: true,
        workspaceRoot: '/tmp/oak-local-mcp-test',
        runtime: {
          backend: 'local',
          async acquire() {
            return {
              id: 'local:test',
              backend: 'local',
              workspaceRoot: '/tmp/oak-local-mcp-test',
              async request(): Promise<Response> {
                throw new Error('local has no HTTP data plane')
              },
              async release(): Promise<void> {},
            }
          },
        },
      },
    })

    const session = await agent.startSession({ userId: 'u1' })
    for await (const _ of session.send('hello')) {
      // drain ACP stream
    }

    expect(mocks.createCloudBaseMcpServerInProcess).toHaveBeenCalledTimes(1)
    expect(mocks.createCloudBaseMcpServerInProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceFolderPaths: '/tmp/oak-local-mcp-test',
      }),
    )
    expect(mocks.createCloudBaseMcpServer).not.toHaveBeenCalled()
  })

  it('uses remote CloudBase MCP factory when sandbox backend is not local', async () => {
    const agent = createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      session: { enabled: false },
      sandbox: {
        enabled: true,
        runtime: {
          backend: 'ags-stateful',
          async acquire() {
            return {
              id: 'ags:test',
              async request(): Promise<Response> {
                return new Response('{}', { status: 200 })
              },
              async release(): Promise<void> {},
            }
          },
        },
      },
    })

    const session = await agent.startSession({ userId: 'u1' })
    for await (const _ of session.send('hello')) {
      // drain ACP stream
    }

    expect(mocks.createCloudBaseMcpServer).toHaveBeenCalledTimes(1)
    expect(mocks.createCloudBaseMcpServerInProcess).not.toHaveBeenCalled()
  })
})
