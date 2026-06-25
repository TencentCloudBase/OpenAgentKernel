/**
 * 04-multi-turn-db.ts —— 多轮对话 + CloudBaseDbDriver（CloudBase 数据库持久化）
 *
 * 演示：
 *   1. 传入 credentials 后默认启用 CloudBase FlexDB session 持久化
 *   2. **第一次运行**（无 resumeConversationId）：告知个人信息，落库后输出 conversationId
 *   3. **第二次运行**（填入 examples.resumeConversationId）：跨进程 resume，提问验证 DB 记忆
 *
 * 配置：examples/config.local.json（见 config.example.json）
 *
 * 运行：
 *   # 第一次：写入个人信息
 *   pnpm dlx tsx packages/open-agent-kernel/examples/04-multi-turn-db.ts
 *   # 把输出的 conversationId 填入 config.local.json → examples.resumeConversationId
 *   # 第二次：跨进程 resume + 回忆测试
 *   pnpm dlx tsx packages/open-agent-kernel/examples/04-multi-turn-db.ts
 *
 * 验证 DB：
 *   在 CloudBase 控制台 → 数据库 → 看 oak_sessions / oak_session_entries / oak_session_summaries
 */
import { printAcpUpdate } from './_shared/acp.js'
import { getEnvId, getModel, getPlatformCredentials, getResumeConversationId } from './_shared/env.js'

import { createAgent, type AcpSessionUpdate } from '@cloudbase/open-agent-kernel'

const SEED_PROMPT = '我叫小明，喜欢吃西红柿炒蛋。'
const RECALL_PROMPT = '还记得我的名字吗？我喜欢什么菜？'

async function streamTurn(
  session: { send: (input: string) => AsyncIterable<AcpSessionUpdate> },
  label: string,
  prompt: string,
) {
  console.log(`\n--- ${label} ---`)
  console.log(`User: ${prompt}`)
  process.stdout.write('Assistant: ')
  for await (const event of session.send(prompt)) {
    printAcpUpdate(event)
    if (event.sessionUpdate === 'log' && event.level === 'error') {
      throw new Error('session ended with error')
    }
  }
}

async function main(): Promise<void> {
  const envId = getEnvId()
  const credentials = getPlatformCredentials()
  const resumeId = getResumeConversationId()

  const agent = createAgent({
    envId,
    credentials,
    model: getModel(),
    systemPrompt: 'You are a helpful assistant. Reply concisely in Chinese. ' + 'Remember details across turns.',
  })

  const session = resumeId ? await agent.resumeSession(resumeId) : await agent.startSession({ userId: 'demo-user' })

  if (resumeId) {
    console.log(`[resume] continuing conversation=${resumeId}`)
    await streamTurn(session, 'Turn (cross-process recall)', RECALL_PROMPT)
  } else {
    console.log(`[start] new conversation=${session.id}`)
    await streamTurn(session, 'Turn 1 (seed profile to DB)', SEED_PROMPT)
    console.log('\n--- Next step ---')
    console.log(`把 conversationId 写入 config.local.json → examples.resumeConversationId：`)
    console.log(`  "${session.id}"`)
    console.log('然后重新运行本 example，将跨进程 resume 并提问回忆。')
  }

  console.log('\n--- Diagnostic ---')
  console.log(`conversation=${session.id}`)
  console.log('→ 在 CloudBase 控制台 oak_session_entries 集合里按 sessionId 过滤可见全部 transcript 条目。')
  console.log('\n--- Done ---')
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
