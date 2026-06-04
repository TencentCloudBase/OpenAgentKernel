/**
 * Example 16: userMemory(用户级长期记忆)
 *
 * 演示:
 *   1. 启用 userMemory.enabled = true
 *   2. 第一段对话告诉 agent 一个用户事实("我的猫叫咪咪")
 *   3. session abort 时 .claude/CLAUDE.md 与 projects/* /memory/MEMORY.md 自动同步到 COS
 *   4. 创建第二个 conversation(同 userId)→ pull 拿到 memory → agent 主动想起咪咪
 *
 * 运行前提:
 *   - .env.local 配置 TCB_ENV_ID + TCB_SECRET_ID + TCB_SECRET_KEY + TENCENTCLOUD_TOKENHUB_API_KEY
 *   - 该 envId 对应的 CloudBase 已开通 COS
 *
 * Run:
 *   pnpm dlx tsx packages/open-agent-kernel/examples/16-user-memory.ts
 */

import { loadEnv } from './_shared/env.js'

import { createAgent } from '@cloudbase/open-agent-kernel'

async function runConversation(prompt: string, userId: string) {
  const agent = createAgent({
    envId: process.env.TCB_ENV_ID!,
    model: 'glm-5.1',
    systemPrompt:
      'You are a friendly assistant. When the user shares personal facts, ' +
      'use the /memory command or remember them for future conversations.',
    userMemory: { enabled: true },
  })

  const session = await agent.startSession({ userId })
  console.log(`\n[example] conversation start (user=${userId})`)
  console.log(`[example] user: ${prompt}`)
  process.stdout.write('[example] assistant: ')
  for await (const event of session.send(prompt)) {
    if (event.type === 'message_delta') process.stdout.write(event.text)
  }
  console.log('\n[example] aborting session (triggers final push)...')
  await session.abort()
}

async function main() {
  loadEnv()
  const userId = `demo-user-${Date.now()}`

  // 第一段对话:植入事实
  await runConversation('我的猫叫咪咪,2 岁,布偶猫。请记住这个。', userId)

  // 等 1 秒确保 COS 同步完成(这里依赖 send-end 的 push)
  await new Promise((r) => setTimeout(r, 1000))

  // 第二段对话:跨 conversation 测试记忆
  await runConversation('你还记得我家的猫吗?', userId)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
