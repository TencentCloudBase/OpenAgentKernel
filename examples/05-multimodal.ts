/**
 * 05-multimodal.ts —— 多模态输入演示（图片 + 文字 → 视觉模型）
 *
 * 演示路径：
 *   方式 A（默认）：传入 credentials 后，createAgent 自动使用 CloudBase Storage
 *   方式 B（调试）：OAK_STORAGE=memory 时显式使用 InMemoryStorage
 *
 * 配置：examples/config.local.json（见 config.example.json）
 *
 * 运行：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/05-multimodal.ts
 */
import { printAcpUpdate } from './_shared/acp.js'
import {
  getEnvId,
  getExampleImagePath,
  getExampleStorage,
  getPlatformCredentials,
  getVisionModel,
} from './_shared/env.js'

import * as path from 'node:path'
import { InMemoryStorage, createAgent } from '@cloudbase/open-agent-kernel'

async function main(): Promise<void> {
  const useInMemoryStorage = getExampleStorage() === 'memory'
  const credentials = useInMemoryStorage ? undefined : getPlatformCredentials()
  const storage = useInMemoryStorage ? new InMemoryStorage() : undefined
  const storageName = useInMemoryStorage ? 'InMemoryStorage' : 'CloudBaseStorage(default)'

  // 默认用项目根目录的 screenshot.png（一张产品截图，模型应该能识别出 UI 元素）
  const defaultImage = path.resolve(new URL('./', import.meta.url).pathname, 'cloud.png')
  const imagePath = getExampleImagePath() ?? defaultImage

  const agent = createAgent({
    envId: getEnvId(),
    ...(credentials ? { credentials } : {}),
    // 必须用视觉模型；config.model 常为文本模型（glm-5.1），不能用于识图
    model: 'glm-5v-turbo',
    systemPrompt: 'You are a helpful image analysis assistant. Reply concisely in Chinese.',
    ...(storage ? { storage } : {}),
  })

  const visionModel = getVisionModel()
  console.log(`[storage] using ${storageName}`)
  console.log(`[model] ${visionModel} (vision; config.model 不影响本 example)`)
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
    printAcpUpdate(event)
    if (event.sessionUpdate === 'log' && event.level === 'error') return
  }

  console.log('\n--- Done ---')
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
