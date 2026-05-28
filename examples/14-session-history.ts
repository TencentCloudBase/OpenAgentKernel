/**
 * Example 14: PR #4.6 —— Session getHistory() 消息历史查询
 *
 * 演示：
 *   - 发送消息后，通过 session.getHistory() 拉取前端可读的消息记录
 *   - 消息历史基于 session_messages 元数据表 + session_entries 内容表的 join 查询
 *   - SDKMessage → MessageRecord 的翻译（text/thinking/tool_call/tool_result）
 *
 * 前置条件：
 *   - 需要 CloudBase DB 凭证（TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY）
 *   - session_messages 表会在 append 时自动双写
 *
 * 运行：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/14-session-history.ts
 */
import './_shared/env.js'

import { randomUUID } from 'node:crypto'
import { CloudBaseDbDriver, CloudBaseSessionStore, createAgent } from '@cloudbase/open-agent-kernel'

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
    systemPrompt: 'You are a helpful assistant. Reply concisely in Chinese.',
    session: { store: sessionStore, projectKey: envId },
  })

  // ─── 第 1 轮：发送消息 ─────────────────────────────────────────
  console.log('=== 第 1 轮：发送消息 ===\n')
  const conversationId = randomUUID()
  console.log(`conversationId: ${conversationId}\n`)
  const session = await agent.startSession({ userId: 'demo-user', conversationId })

  let fullText = ''
  for await (const e of session.send('你好，请用一句话介绍你自己')) {
    if (e.type === 'message_delta') {
      process.stdout.write(e.text)
      fullText += e.text
    } else if (e.type === 'session_idle') {
      console.log(`\n[session_idle: ${e.reason}]`)
    } else if (e.type === 'error') {
      console.error('\n[error]', e.error.message)
    }
  }

  // ─── 第 2 轮：查询消息历史 ─────────────────────────────────────
  console.log('\n\n=== 第 2 轮：调用 getHistory() ===\n')

  const history = await session.getHistory({ limit: 20 })
  console.log(`共 ${history.length} 条消息记录:\n`)

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
          console.log(`  tool_call: ${part.toolName}(${JSON.stringify(part.input).slice(0, 100)})`)
          break
        case 'tool_result':
          console.log(`  tool_result: isError=${part.isError}, output=${JSON.stringify(part.output).slice(0, 100)}`)
          break
      }
    }
    console.log()
  }

  // ─── 第 3 轮：再发一条消息，再次查询 ───────────────────────────
  console.log('=== 第 3 轮：再发一条消息并查询历史 ===\n')

  for await (const e of session.send('谢谢！')) {
    if (e.type === 'message_delta') {
      process.stdout.write(e.text)
    } else if (e.type === 'session_idle') {
      console.log(`\n[session_idle: ${e.reason}]`)
    } else if (e.type === 'error') {
      console.error('\n[error]', e.error.message)
    }
  }

  console.log('\n\n--- 更新后的消息历史 ---\n')
  const updatedHistory = await session.getHistory({ limit: 20 })
  console.log(`共 ${updatedHistory.length} 条消息记录:\n`)

  for (const msg of updatedHistory) {
    const preview = msg.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text.slice(0, 80))
      .join(' ')
    console.log(`  [${msg.role}] ${preview}${preview.length >= 80 ? '...' : ''}`)
  }

  console.log('\n--- Done ---')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
