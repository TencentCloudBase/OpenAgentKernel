/**
 * 03-multi-turn.ts —— 多轮对话 + InMemoryDriver 持久化
 *
 * 演示：
 *   1. 用 InMemorySessionStore 启用 session 持久化（无 CloudBase 依赖）
 *   2. 同一个 session 跑两轮对话，第二轮模型应该能引用第一轮的内容
 *   3. 通过 driver.listProjectKeys() 看 SDK 真实派生的 projectKey 长啥样
 *
 * 运行：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/03-multi-turn.ts
 *
 * 凭证写在 examples/.env.local（从 .env.example 复制）。
 */
import './_shared/env.js'

import { CloudBaseSessionStore, InMemoryDriver, createAgent } from '@cloudbase/open-agent-kernel'

async function main(): Promise<void> {
  const driver = new InMemoryDriver()
  const store = new CloudBaseSessionStore({ driver })

  const agent = createAgent({
    envId: process.env.TCB_ENV_ID ?? 'demo-env',
    model: process.env.CLOUDBASE_AGENT_MODEL ?? 'glm-5.1',
    systemPrompt: 'You are a helpful assistant. Reply concisely in Chinese. ' + 'Remember details across turns.',
    session: { store },
  })

  const session = await agent.startSession({ userId: 'demo-user' })
  const conversationId = session.id

  // ── 第一轮 ─────────────────────────────────────────────────
  console.log('--- Turn 1 ---')
  console.log('User: 我叫小明，喜欢吃西红柿炒蛋。')
  process.stdout.write('Assistant: ')
  for await (const event of session.send('我叫小明，喜欢吃西红柿炒蛋。')) {
    if (event.type === 'message_delta') process.stdout.write(event.text)
    if (event.type === 'session_idle') console.log()
    if (event.type === 'error') {
      console.error('[error]', event.error.message)
      return
    }
  }

  // 看看 driver 里 SDK 真实派生的 projectKey 是什么样子
  // （核心链路验证靠 Turn 2 模型记忆，下面这行只是用来看 SDK 内部细节）
  const projectKeys = driver.listProjectKeys()
  console.log(
    `\n[diagnostic] SDK derived projectKeys=${JSON.stringify(projectKeys)}, ` +
      `conversation=${conversationId.slice(0, 8)}...`,
  )

  // ── 第二轮（同一个 session，验证记忆） ──────────────────────
  console.log('\n--- Turn 2 ---')
  console.log('User: 还记得我的名字吗？我喜欢什么菜？')
  process.stdout.write('Assistant: ')
  for await (const event of session.send('还记得我的名字吗？我喜欢什么菜？')) {
    if (event.type === 'message_delta') process.stdout.write(event.text)
    if (event.type === 'session_idle') console.log()
    if (event.type === 'error') {
      console.error('[error]', event.error.message)
      return
    }
  }

  console.log('\n--- Done ---')
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
