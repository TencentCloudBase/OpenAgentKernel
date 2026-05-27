/**
 * Example 06: 进程内 SDK MCP server
 *
 * 演示如何用 Claude Agent SDK 提供的 `createSdkMcpServer` + `tool`
 * 在 kernel 进程内定义一组 MCP 工具，让 agent 自主调用。
 *
 * 这是"用户自己写工具"的标准范式：
 *   - 零外部依赖（不用 npx 拉子进程）
 *   - 工具实现就是普通 TypeScript 函数
 *   - 凭证 / 上下文跟 kernel 共享
 *
 * 凭证写在 examples/.env.local（从 .env.example 复制）。
 *
 * 运行：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/06-mcp-sdk-server.ts
 */
import './_shared/env.js'

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { createAgent } from '@cloudbase/open-agent-kernel'

async function main(): Promise<void> {
  // 用 SDK 提供的 helper 现场写一个 MCP server，含两个工具：add / multiply。
  const calculator = createSdkMcpServer({
    name: 'calculator',
    version: '1.0.0',
    tools: [
      tool(
        'add',
        'Add two numbers and return the sum.',
        { a: z.number(), b: z.number() },
        async (args) => ({
          content: [{ type: 'text', text: String(args.a + args.b) }],
        }),
      ),
      tool(
        'multiply',
        'Multiply two numbers.',
        { a: z.number(), b: z.number() },
        async (args) => ({
          content: [{ type: 'text', text: String(args.a * args.b) }],
        }),
      ),
    ],
  })

  const agent = createAgent({
    envId: process.env.TCB_ENV_ID ?? 'demo-env',
    model: process.env.CLOUDBASE_AGENT_MODEL ?? 'glm-5.1',
    systemPrompt:
      'You are a helpful assistant. When the user asks for arithmetic, ' +
      'you MUST call the provided tools (add / multiply) instead of computing yourself. ' +
      'Reply concisely in Chinese.',
    mcpServers: {
      // key 即 server 名（最终工具名为 mcp__calculator__add 等）
      calculator,
    },
  })

  const session = await agent.startSession({ userId: 'u1' })

  console.log('User: 帮我算一下 23 * 47 + 100')
  process.stdout.write('Assistant: ')
  for await (const e of session.send('帮我算一下 23 * 47 + 100')) {
    if (e.type === 'message_delta') {
      process.stdout.write(e.text)
    } else if (e.type === 'tool_call') {
      process.stdout.write(`\n  → calling ${e.toolName}(${JSON.stringify(e.input)})\n  `)
    } else if (e.type === 'tool_result') {
      process.stdout.write(`\n  ← result: ${JSON.stringify(e.output)}\n  `)
    } else if (e.type === 'error') {
      console.error('\n[error]', e.error.message)
    }
  }

  console.log('\n\n--- Done ---')
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
