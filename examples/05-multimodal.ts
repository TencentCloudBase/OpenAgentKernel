/**
 * 05-multimodal.ts —— 多模态输入演示（图片 + 文字 → 视觉模型）
 *
 * 演示路径：
 *   方式 A（默认）：传入 credentials 后，createAgent 自动使用 CloudBase Storage
 *   方式 B（调试）：OAK_STORAGE=memory 时显式使用 InMemoryStorage
 *
 * 凭证写在 examples/.env.local（从 .env.example 复制）：
 *   - TENCENTCLOUD_TOKENHUB_API_KEY 必需
 *   - 默认还需要 TCB_ENV_ID + TENCENTCLOUD_SECRETID + TENCENTCLOUD_SECRETKEY
 *
 * 运行：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/05-multimodal.ts
 */
import { getPlatformCredentials } from './_shared/env.js'

import * as path from 'node:path'
import { InMemoryStorage, createAgent } from '@cloudbase/open-agent-kernel'

async function main(): Promise<void> {
  const useInMemoryStorage = process.env.OAK_STORAGE === 'memory'
  const credentials = useInMemoryStorage ? undefined : getPlatformCredentials()
  const storage = useInMemoryStorage ? new InMemoryStorage() : undefined
  const storageName = useInMemoryStorage ? 'InMemoryStorage' : 'CloudBaseStorage(default)'

  // 默认用项目根目录的 screenshot.png（一张产品截图，模型应该能识别出 UI 元素）
  const defaultImage = path.resolve(new URL('./', import.meta.url).pathname, 'cloud.png')
  const imagePath = process.env.OAK_IMAGE_PATH ?? defaultImage

  const agent = createAgent({
    envId: process.env.TCB_ENV_ID ?? 'demo-env',
    ...(credentials ? { credentials } : {}),
    // 视觉模型：glm-5v-turbo 已实测在 TokenHub Anthropic 协议下支持图片
    model: process.env.CLOUDBASE_AGENT_MODEL ?? 'glm-5v-turbo',
    systemPrompt: 'You are a helpful image analysis assistant. Reply concisely in Chinese.',
    ...(storage ? { storage } : {}),
  })

  console.log(`[storage] using ${storageName}`)
  console.log(`[image] ${imagePath}`)

  const session = await agent.startSession({ userId: 'demo-user' })

  console.log(`\nUser: 这张图里展示了什么？请用一两句话描述关键内容。`)
  console.log(`     [attachment: file=${path.basename(imagePath)}]`)
  process.stdout.write('Assistant: ')

  for await (const event of session.send({
    type: 'message',
    content: '这张图里展示了什么？请用一两句话描述关键内容。',
    attachments: [{ type: 'file', source: imagePath }],
  })) {
    if (event.type === 'message_delta') process.stdout.write(event.text)
    if (event.type === 'session_idle') console.log()
    if (event.type === 'error') {
      console.error('\n[error]', event.error.message)
      return
    }
  }

  console.log('\n--- Done ---')
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
