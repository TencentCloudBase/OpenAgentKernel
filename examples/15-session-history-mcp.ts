/**
 * Example 15: PR #4.6 —— Session getHistory() with MCP tool calls
 *
 * 演示：
 *   - 使用沙箱 + CloudBase MCP 工具触发 tool_call / tool_result 类型的 SDK 消息
 *   - 通过 session.getHistory() 查询完整消息历史，验证 tool_call 和 tool_result 部分
 *   - 验证双写机制正确记录 MCP 工具调用的元数据
 *
 * 前置条件：
 *   - 需要 CloudBase DB 凭证（TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY）
 *   - 需要沙箱凭证（TCB_API_KEY）和模型凭证（TENCENTCLOUD_TOKENHUB_API_KEY）
 *   - session_messages 表会在 append 时自动双写
 *
 * 运行：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/15-session-history-mcp.ts
 */
import './_shared/env.js'

import { randomUUID } from 'node:crypto'
import { AgsStatefulSandbox, CloudBaseDbDriver, CloudBaseSessionStore, createAgent } from '@cloudbase/open-agent-kernel'

async function main(): Promise<void> {
  const envId = process.env.TCB_ENV_ID
  if (!envId) {
    throw new Error('TCB_ENV_ID is required (set it in examples/.env.local)')
  }

  // ─── 共享后端：session store 落 CloudBase DB ────────────────────
  const sessionStore = new CloudBaseSessionStore({
    driver: new CloudBaseDbDriver(),
    projectKey: envId,
  })

  const agent = createAgent({
    envId,
    model: process.env.CLOUDBASE_AGENT_MODEL ?? 'glm-5.1',
    systemPrompt:
      'You are a CloudBase coding assistant working inside a sandbox. ' +
      'You have two tool families:\n' +
      '  - mcp__sandbox__*  : filesystem and shell (bash/read/write/edit/glob/grep)\n' +
      '  - mcp__cloudbase__*: CloudBase resources (database / storage / cloudfunction / hosting / ...)\n' +
      'Prefer mcp__cloudbase__* when the task is about CloudBase resources. ' +
      'Always use the tools to verify—never fabricate output. ' +
      'Reply concisely in Chinese.',
    session: { store: sessionStore, projectKey: envId },
    sandbox: {
      runtime: new AgsStatefulSandbox(),
      // 默认 cloudbaseTools: true（开通 sandbox 即内置 cloudbase MCP）
    },
  })

  // ─── 第 1 轮：发送会触发 MCP 工具调用的消息 ─────────────────────
  console.log('=== 第 1 轮：发送 MCP 工具调用消息 ===\n')
  const conversationId = randomUUID()
  console.log(`conversationId: ${conversationId}\n`)
  const session = await agent.startSession({ userId: 'demo-user', conversationId })

  const prompt =
    '请帮我探索一下当前 CloudBase 环境：\n' +
    '1. 用 cloudbase 工具列出当前环境下的云数据库集合（最多 5 个）\n' +
    '2. 如果有集合，挑第一个集合查询前 2 条记录\n' +
    '3. 如果没有任何集合，告诉我即可，不要尝试创建\n' +
    '完成后简单总结你看到了什么。'

  console.log(`User: ${prompt}\n`)
  process.stdout.write('Assistant: ')

  let fullText = ''
  for await (const e of session.send(prompt)) {
    if (e.type === 'message_delta') {
      process.stdout.write(e.text)
      fullText += e.text
    } else if (e.type === 'tool_call') {
      console.log(`\n  → [tool_call] ${e.toolName}(${JSON.stringify(e.input).slice(0, 200)})`)
    } else if (e.type === 'tool_result') {
      const out = JSON.stringify(e.output).slice(0, 300)
      console.log(`  ← [tool_result] ${out}`)
    } else if (e.type === 'session_idle') {
      console.log(`\n[session_idle: ${e.reason}]`)
    } else if (e.type === 'error') {
      console.error('\n[error]', e.error.message)
    }
  }

  // ─── 第 2 轮：查询消息历史 ─────────────────────────────────────
  console.log('\n\n=== 第 2 轮：调用 getHistory() ===\n')

  const history = await session.getHistory({ limit: 50 })
  console.log(`共 ${history.length} 条消息记录:\n`)

  let toolCallCount = 0
  let toolResultCount = 0

  for (const msg of history) {
    console.log(
      `[${msg.role}] (id=${msg.id}, status=${msg.status}, createdAt=${new Date(msg.createdAt).toISOString()})`,
    )
    for (const part of msg.parts) {
      switch (part.type) {
        case 'text':
          console.log(`  text: ${part.text.slice(0, 200)}${part.text.length > 200 ? '...' : ''}`)
          break
        case 'thinking':
          console.log(`  thinking: ${part.text.slice(0, 100)}...`)
          break
        case 'tool_call':
          toolCallCount++
          console.log(`  tool_call: ${part.toolName}(${JSON.stringify(part.input).slice(0, 100)})`)
          break
        case 'tool_result':
          toolResultCount++
          console.log(`  tool_result: isError=${part.isError}, output=${JSON.stringify(part.output).slice(0, 100)}`)
          break
      }
    }
    console.log()
  }

  console.log(`统计：${toolCallCount} 个 tool_call, ${toolResultCount} 个 tool_result`)

  // ─── 验证结果 ─────────────────────────────────────────────────
  console.log('\n=== 验证结果 ===\n')

  const hasUserMessage = history.some((m) => m.role === 'user')
  const hasAssistantMessage = history.some((m) => m.role === 'assistant')
  const hasToolCalls = toolCallCount > 0
  const hasToolResults = toolResultCount > 0

  console.log(`✓ 包含 user 消息: ${hasUserMessage}`)
  console.log(`✓ 包含 assistant 消息: ${hasAssistantMessage}`)
  console.log(`✓ 包含 tool_call: ${hasToolCalls} (${toolCallCount} 个)`)
  console.log(`✓ 包含 tool_result: ${hasToolResults} (${toolResultCount} 个)`)

  if (!hasUserMessage) {
    console.error('❌ 缺少 user 消息，双写可能有问题')
  }
  if (!hasAssistantMessage) {
    console.error('❌ 缺少 assistant 消息，双写可能有问题')
  }
  if (!hasToolCalls) {
    console.error('❌ 缺少 tool_call，MCP 工具调用可能未触发或双写有问题')
  }
  if (!hasToolResults) {
    console.error('❌ 缺少 tool_result，MCP 工具调用可能未触发或双写有问题')
  }

  if (hasUserMessage && hasAssistantMessage && hasToolCalls && hasToolResults) {
    console.log('\n✅ 所有验证通过！双写机制正确记录了 MCP 工具调用。')
  } else {
    console.log('\n⚠️  部分验证失败，请检查双写机制。')
  }

  // ─── 清理沙箱 ─────────────────────────────────────────────────
  console.log('\n--- Cleaning up sandbox ---')
  await session.abort()
  console.log('--- Done ---')
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
