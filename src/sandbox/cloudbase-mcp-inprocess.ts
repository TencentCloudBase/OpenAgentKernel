/**
 * CloudBase MCP tools for local runtime sandbox.
 *
 * Unlike the AGS/TRW path in `cloudbase-mcp.ts`, this implementation does not
 * call mcporter or any sandbox HTTP data plane. It runs `@cloudbase/cloudbase-mcp`
 * in the OAK process and connects to it with an in-memory MCP transport.
 */

import { createRequire } from 'node:module'
import { createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CloudBaseUserCredentials, CloudBaseMcpBundle } from './cloudbase-mcp.js'
import { jsonSchemaToZodRawShapeForCloudBaseMcp } from './cloudbase-mcp.js'

interface CloudBaseMcpModule {
  createCloudBaseMcpServer(options: Record<string, unknown>): Promise<{
    connect(transport: unknown): Promise<void>
    server?: { ping?: () => Promise<unknown> }
  }>
}

interface McpToolDef {
  name: string
  description?: string
  inputSchema?: Parameters<typeof jsonSchemaToZodRawShapeForCloudBaseMcp>[0]
}

const require = createRequire(import.meta.url)

export interface CreateCloudBaseMcpInProcessOptions {
  /**
   * 获取用户租户 CloudBase 凭证。初始化时调用；工具调用如遇凭证问题由
   * cloudbase-mcp 自身返回错误，后续可扩展为重建 client。
   */
  getCredentials: () => Promise<CloudBaseUserCredentials>
  /** local runtime workspace root，用于 cloudbase-mcp 的 WORKSPACE_FOLDER_PATHS 语义。 */
  workspaceFolderPaths?: string
  /** 透传给 cloudbase-mcp 的 IDE 标识。 */
  integrationIde?: string
  /** 诊断日志回调（不传则按 OAK_DEBUG=1 走 console.error）。 */
  log?: (msg: string) => void
  /** 测试注入点；生产代码不需要传。 */
  createServer?: CloudBaseMcpModule['createCloudBaseMcpServer']
}

function defaultLog(msg: string): void {
  if (process.env.OAK_DEBUG === '1') {
    // eslint-disable-next-line no-console
    console.error(`[oak][cloudbase-mcp-local] ${msg}`)
  }
}

function buildEmptyServer(reason: string, log: (msg: string) => void): CloudBaseMcpBundle {
  log(`degraded: ${reason}`)
  return {
    server: createSdkMcpServer({
      name: 'cloudbase',
      version: '1.0.0',
      tools: [],
    }),
    toolCount: 0,
    degradedReason: reason,
  }
}

/**
 * 在 OAK 本进程内构造 CloudBase MCP server。
 *
 * 失败策略与远程 sandbox 版本一致：初始化失败时返回空 server，让 agent 仍可使用
 * local 文件系统/Bash 工具。
 */
export async function createCloudBaseMcpServerInProcess(
  options: CreateCloudBaseMcpInProcessOptions,
): Promise<CloudBaseMcpBundle> {
  const {
    getCredentials,
    workspaceFolderPaths = '',
    integrationIde = 'open-agent-kernel',
    log = defaultLog,
    createServer,
  } = options

  let credentials: CloudBaseUserCredentials
  try {
    credentials = await getCredentials()
  } catch (err) {
    return buildEmptyServer(`credentials unavailable: ${(err as Error).message}`, log)
  }

  let createCloudBaseMcpServer: CloudBaseMcpModule['createCloudBaseMcpServer']
  if (createServer) {
    createCloudBaseMcpServer = createServer
  } else {
    try {
      const mod = require('@cloudbase/cloudbase-mcp') as CloudBaseMcpModule
      createCloudBaseMcpServer = mod.createCloudBaseMcpServer
      if (typeof createCloudBaseMcpServer !== 'function') {
        return buildEmptyServer('createCloudBaseMcpServer export missing', log)
      }
    } catch (err) {
      return buildEmptyServer(`load @cloudbase/cloudbase-mcp failed: ${(err as Error).message}`, log)
    }
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({
    name: 'open-agent-kernel-cloudbase',
    version: '1.0.0',
  })

  try {
    const server = await createCloudBaseMcpServer({
      name: 'cloudbase-mcp',
      version: '1.0.0',
      cloudBaseOptions: {
        envId: credentials.envId,
        secretId: credentials.secretId,
        secretKey: credentials.secretKey,
        token: credentials.sessionToken,
      },
      ide: integrationIde,
      cloudMode: true,
      workspaceFolderPaths,
    })

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    await server.server?.ping?.()
  } catch (err) {
    return buildEmptyServer(`in-process cloudbase-mcp init failed: ${(err as Error).message}`, log)
  }

  let toolDefs: McpToolDef[]
  try {
    const listed = await client.listTools()
    toolDefs = listed.tools as McpToolDef[]
  } catch (err) {
    return buildEmptyServer(`listTools failed: ${(err as Error).message}`, log)
  }

  const tools = toolDefs
    .filter((t) => typeof t.name === 'string' && t.name.length > 0)
    .map((t) => {
      const zodShape = jsonSchemaToZodRawShapeForCloudBaseMcp(t.inputSchema)
      return sdkTool(
        t.name,
        (t.description ?? `CloudBase tool: ${t.name}`) +
          '\n\nNOTE: localPath refers to paths inside the local runtime workspace.',
        zodShape,
        async (args: Record<string, unknown>) => {
          try {
            const res = await client.callTool({
              name: t.name,
              arguments: args,
            })
            return {
              content: [{ type: 'text', text: JSON.stringify(res) }],
              isError: false,
            }
          } catch (err) {
            return {
              content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
              isError: true,
            }
          }
        },
      )
    })

  log(`registered ${tools.length} in-process cloudbase tools`)

  const knownToolNames = new Set(
    toolDefs.filter((t) => typeof t.name === 'string' && t.name.length > 0).map((t) => t.name),
  )

  return {
    server: createSdkMcpServer({
      name: 'cloudbase',
      version: '1.0.0',
      tools,
    }),
    toolCount: tools.length,
    invoke: async (toolName, input) => {
      if (!knownToolNames.has(toolName)) return null
      try {
        const res = await client.callTool({ name: toolName, arguments: input })
        return { output: JSON.stringify(res), isError: false }
      } catch (err) {
        return { output: err instanceof Error ? err.message : String(err), isError: true }
      }
    },
  }
}
