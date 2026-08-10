/**
 * Example 08: Local Runtime Sandbox
 *
 * 演示 agent 在宿主进程本地工作区用 Claude SDK 内置工具读写文件：
 *   1. 写一个 README.md
 *   2. 跑 `ls` 列目录
 *   3. 读回 README.md 验证
 *
 * 配置：
 *   - examples/config.local.json: envId / model / tcbApiKey
 *   - credentials.secretId/secretKey 可选；缺省或占位符时回退到 tcbApiKey（accessKey）
 *     供 workspacePersist（cwd.tar.gz → COS）鉴权
 *
 * 默认：
 *   - 省略 sandbox → enabled local
 *   - 省略 cwd → os.tmpdir()/oak-local-sandbox
 *
 * 运行：
 *   pnpm dlx tsx examples/08-local-sandbox.ts
 */
import * as os from 'node:os'
import * as path from 'node:path'

import { printAcpUpdate } from './_shared/acp.js'
import { getEnvId, getModel, getPlatformCredentialsOrApiKey } from './_shared/env.js'

import { createAgent } from '@cloudbase/open-agent-kernel'

async function main(): Promise<void> {
  const envId = getEnvId()
  const credentials = getPlatformCredentialsOrApiKey()
  const cwd = path.join(os.tmpdir(), 'oak-local-sandbox')

  const agent = createAgent({
    envId,
    credentials,
    model: getModel(),
    // cwd / sandbox 均可省略：默认 local + tmpdir/oak-local-sandbox
    systemPrompt:
      'You are a helpful coding assistant working in a local workspace. ' +
      'You have access to Bash / Read / Write / Edit / Glob / Grep tools. ' +
      'Always use the tools to interact with the filesystem—never fabricate output. ' +
      'Reply concisely in Chinese.',
  })

  const session = await agent.startSession({ userId: 'u1' })

  const prompt =
    '请完成以下任务：\n' +
    '1. 在工作目录用 Write 工具创建一个 README.md，内容是 "# Hello from open-agent-kernel local sandbox"\n' +
    '2. 用 Bash 跑 `ls -la` 看下当前目录\n' +
    '3. 用 Read 工具读 README.md 的内容并展示给我\n' +
    '完成后告诉我结果。'

  console.log('cwd (default):', cwd)
  console.log('User:', prompt, '\n')
  process.stdout.write('Assistant: ')

  for await (const e of session.send(prompt)) {
    printAcpUpdate(e)
  }

  console.log('\n\n--- Done ---')
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
