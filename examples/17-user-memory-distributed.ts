/**
 * Example 17: userMemory 跨节点演示(串行)
 *
 * 演示:同一 userId 的请求依次落在两个不同的 SDK 实例(模拟跨节点),
 *      只要严格串行(第一个 abort 完才启第二个),记忆完整恢复。
 *
 * 注意:这个 demo 不并发 — spec §5.3 明确"业务方需保证同 user 串行"。
 *
 * Run:
 *   pnpm dlx tsx packages/open-agent-kernel/examples/17-user-memory-distributed.ts
 */

import { loadEnv } from './_shared/env.js'

import { createAgent } from '@cloudbase/open-agent-kernel'

const userId = `dist-demo-${Date.now()}`

async function nodeA() {
  console.log('--- Node A ---')
  const agent = createAgent({
    envId: process.env.TCB_ENV_ID!,
    model: 'glm-5.1',
    systemPrompt: 'You are a helpful assistant. Remember user facts.',
    userMemory: { enabled: true },
  })
  const session = await agent.startSession({ userId })
  process.stdout.write('A: ')
  for await (const event of session.send('请记住:我的项目代号是 Aurora,部署在 ap-shanghai。')) {
    if (event.type === 'message_delta') process.stdout.write(event.text)
  }
  console.log('\n[A] aborting (final push to COS)...')
  await session.abort()
}

async function nodeB() {
  console.log('\n--- Node B (新的 OAK 实例,模拟新节点)---')
  const agent = createAgent({
    envId: process.env.TCB_ENV_ID!,
    model: 'glm-5.1',
    systemPrompt: 'You are a helpful assistant.',
    userMemory: { enabled: true },
  })
  const session = await agent.startSession({ userId })
  process.stdout.write('B: ')
  for await (const event of session.send('我的项目代号叫什么?部署在哪?')) {
    if (event.type === 'message_delta') process.stdout.write(event.text)
  }
  console.log('\n[B] done.')
  await session.abort()
}

async function main() {
  loadEnv()
  await nodeA()
  await new Promise((r) => setTimeout(r, 1500)) // 模拟节点间间隔
  await nodeB()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
