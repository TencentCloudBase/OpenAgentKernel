/**
 * 04-multi-turn-db.ts —— 多轮对话 + CloudBaseDbDriver（CloudBase 数据库持久化）
 *
 * 演示：
 *   1. 用 CloudBaseDbDriver 启用 session 持久化（数据真的落 CloudBase DB）
 *   2. 同一个 session 跑两轮对话，第二轮模型应该能引用第一轮的内容
 *   3. 跨进程 resume：第二次运行时配置 OAK_RESUME_CONVERSATION_ID=<id>
 *      把上次的 conversationId 传入，agent.resumeSession 从 DB 拉历史继续
 *
 * 凭证写在 examples/.env.local（从 .env.example 复制）：
 *   TENCENTCLOUD_TOKENHUB_API_KEY、TCB_ENV_ID、TCB_SECRET_ID、TCB_SECRET_KEY
 *
 * 运行：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/04-multi-turn-db.ts
 *
 * 验证 DB：
 *   在 CloudBase 控制台 → 数据库 → 看 oak_sessions / oak_session_entries / oak_session_summaries
 */
import './_shared/env.js'

import { CloudBaseDbDriver, CloudBaseSessionStore, createAgent } from '@cloudbase/open-agent-kernel'

async function main(): Promise<void> {
  const envId = process.env.TCB_ENV_ID
  if (!envId) {
    throw new Error('TCB_ENV_ID is required (set it in examples/.env.local)')
  }

  const driver = new CloudBaseDbDriver({
    // 不传 credentials → 从 TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY 读取
    // collectionPrefix 默认 'oak_'，可按需自定义避免冲突
  })
  const store = new CloudBaseSessionStore({
    driver,
    // 推荐生产环境传 envId：把 SDK 派生的 "sanitized cwd" 替换为业务标识，
    // 解决"多环境部署 cwd 漂移"和"多租户隔离"两个问题。
    projectKey: envId,
  })

  const agent = createAgent({
    envId,
    model: process.env.CLOUDBASE_AGENT_MODEL ?? 'glm-5.1',
    systemPrompt: 'You are a helpful assistant. Reply concisely in Chinese. ' + 'Remember details across turns.',
    session: { store },
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
  const sessionsInDb = await driver.listSessions(envId)
  console.log(`sessions in DB (projectKey=${envId}): ${sessionsInDb.length}`)
  const entries = await driver.loadEntries({ projectKey: envId, sessionId: session.id })
  console.log(`entries for current conversation: ${entries?.length ?? 0}`)
  console.log(`conversation=${session.id}`)
  console.log(
    `→ 在 CloudBase 控制台 oak_session_entries 集合里按 sessionId="${session.id}" 过滤可见全部 transcript 条目。`,
  )

  console.log('\n--- Done ---')
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
