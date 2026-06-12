/**
 * 04-multi-turn-db.ts —— 多轮对话 + CloudBaseDbDriver（CloudBase 数据库持久化）
 *
 * 演示：
 *   1. 传入 credentials 后默认启用 CloudBase FlexDB session 持久化
 *   2. 同一个 session 跑两轮对话，第二轮模型应该能引用第一轮的内容
 *   3. 跨进程 resume：第二次运行时配置 OAK_RESUME_CONVERSATION_ID=<id>
 *      把上次的 conversationId 传入，agent.resumeSession 从 DB 拉历史继续
 *
 * 凭证写在 examples/.env.local（从 .env.example 复制）：
 *   TENCENTCLOUD_TOKENHUB_API_KEY、TCB_ENV_ID、TENCENTCLOUD_SECRETID、TENCENTCLOUD_SECRETKEY
 *
 * 运行：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/04-multi-turn-db.ts
 *
 * 验证 DB：
 *   在 CloudBase 控制台 → 数据库 → 看 oak_sessions / oak_session_entries / oak_session_summaries
 */
import { getEnvId, getPlatformCredentials } from './_shared/env.js'

import { createAgent } from '@cloudbase/open-agent-kernel'

async function main(): Promise<void> {
  const envId = getEnvId()
  const credentials = getPlatformCredentials()

  const agent = createAgent({
    envId,
    credentials,
    model: process.env.CLOUDBASE_AGENT_MODEL ?? 'glm-5.1',
    systemPrompt: 'You are a helpful assistant. Reply concisely in Chinese. ' + 'Remember details across turns.',
    // 不配置 session 时，credentials 存在会默认启用 CloudBase FlexDB session store。
    // 如需自定义表前缀：session: { tablePrefix: 'my_agent_' }
  })

  const resumeId = process.env.OAK_RESUME_CONVERSATION_ID
  const session = resumeId ? await agent.resumeSession(resumeId) : await agent.startSession({ userId: 'demo-user' })

  if (resumeId) {
    console.log(`[resume] continuing conversation=${resumeId}`)
  } else {
    console.log(`[start] new conversation=${session.id}`)
    console.log(`  → 下次跑可以在 .env.local 加 OAK_RESUME_CONVERSATION_ID=${session.id} 来 resume`)
  }

  // ── 第一轮 ─────────────────────────────────────────────────
  console.log('\n--- Turn 1 ---')
  console.log('User: 我是谁')
  process.stdout.write('Assistant: ')
  for await (const event of session.send('我是谁')) {
    if (event.type === 'message_delta') process.stdout.write(event.text)
    if (event.type === 'session_idle') console.log()
    if (event.type === 'error') {
      console.error('[error]', event.error.message)
      return
    }
  }

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

  // ── 验证：用 envId 直接查 DB 确认数据真的落库 ─────────────────
  console.log('\n--- Diagnostic ---')
  console.log(`conversation=${session.id}`)
  console.log('→ 在 CloudBase 控制台 oak_session_entries 集合里按 sessionId 过滤可见全部 transcript 条目。')

  console.log('\n--- Done ---')
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
