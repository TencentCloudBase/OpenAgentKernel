/**
 * Example 07: stdio 子进程模式接入社区 MCP server
 *
 * 演示如何接入"已发布到 npm 的 MCP server"，全程零配置：
 *
 *   - 用 `@modelcontextprotocol/server-everything`（MCP 协议官方维护的 reference server）
 *   - 由 npx 自动拉取 + 子进程启动
 *   - 不需要任何 API key 或额外环境变量
 *
 * 该 server 提供一组演示工具（add / echo / longRunningOperation 等），
 * 可以直接给模型调用。
 *
 * 凭证写在 examples/.env.local（从 .env.example 复制）。
 *
 * 运行：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/07-mcp-stdio.ts
 *
 * 注意：第一次运行 npx 会拉包，需要 ~10s。
 */
import './_shared/env.js'

import { createAgent } from '@cloudbase/open-agent-kernel'

async function main(): Promise<void> {
  const agent = createAgent({
    envId: process.env.TCB_ENV_ID ?? 'demo-env',
    model: process.env.CLOUDBASE_AGENT_MODEL ?? 'glm-5.1',
    systemPrompt:
      'You are a helpful assistant. When the user asks you to add numbers ' +
      'or echo text, prefer calling the available tools rather than computing yourself. ' +
      'Reply concisely in Chinese.',
    mcpServers: {
      // 官方 reference server，stdio 模式
      everything: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-everything'],
      },
    },
  })

  const session = await agent.startSession({ userId: 'u1' })

  console.log('User: 帮我把 17 和 25 相加，再让 echo 工具回显 "hello mcp"')
  process.stdout.write('Assistant: ')

  for await (const e of session.send(
    '帮我把 17 和 25 相加，再让 echo 工具回显 "hello mcp"',
  )) {
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
