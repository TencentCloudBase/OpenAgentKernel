/**
 * 01-quickstart.ts —— 快速开始
 *
 * 运行：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/01-quickstart.ts
 *
 * 配置：examples/config.local.json（见 config.example.json）
 */
import { printAcpUpdate } from './_shared/acp.js'
import { getEnvId, getModel } from './_shared/env.js'

import { createAgent } from '@cloudbase/open-agent-kernel'

async function main(): Promise<void> {
  const agent = createAgent({
    envId: getEnvId(),
    model: getModel(),
    systemPrompt: 'You are a helpful CloudBase assistant. Reply concisely in Chinese.',
  })

  const session = await agent.startSession({ userId: 'demo-user' })

  console.log('User: 你好，请用一句话介绍你自己。\n')
  process.stdout.write('Assistant: ')

  for await (const event of session.send('你好，请用一句话介绍你自己。')) {
    printAcpUpdate(event)
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
