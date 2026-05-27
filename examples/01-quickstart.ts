/**
 * 01-quickstart.ts —— 最小可运行示例
 *
 * 运行：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/01-quickstart.ts
 *
 * 必需配置（写在 examples/.env.local，从 .env.example 复制）：
 *   TENCENTCLOUD_TOKENHUB_API_KEY=sk-xxxxxxxx
 *
 * 此 demo 只用 envId + model + systemPrompt（< 10 行配置）。
 */
import './_shared/env.js'

import { createAgent } from '@cloudbase/open-agent-kernel'

async function main(): Promise<void> {
  const agent = createAgent({
    envId: process.env.TCB_ENV_ID ?? 'demo-env',
    // TokenHub 已确认支持 Anthropic 协议的模型，参见
    // https://cloud.tencent.com/document/product/1823/130079
    model: process.env.CLOUDBASE_AGENT_MODEL ?? 'glm-5.1',
    systemPrompt: 'You are a helpful CloudBase assistant. Reply concisely in Chinese.',
  })

  const session = await agent.startSession({ userId: 'demo-user' })

  console.log('User: 你好，请用一句话介绍你自己。\n')
  process.stdout.write('Assistant: ')

  for await (const event of session.send('你好，请用一句话介绍你自己。')) {
    switch (event.type) {
      case 'message_delta':
        process.stdout.write(event.text)
        break
      case 'tool_call':
        console.log(`\n[tool_call] ${event.toolName}(${JSON.stringify(event.input)})`)
        break
      case 'tool_result':
        console.log(`\n[tool_result] ${JSON.stringify(event.output)}`)
        break
      case 'session_idle':
        console.log(`\n\n[session_idle] reason=${event.reason}`)
        break
      case 'error':
        console.error(`\n[error] ${event.error.message}`)
        break
      default:
        break
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
