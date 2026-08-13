/**
 * Example 09: Local Runtime Sandbox + CloudBase MCP（进程内）
 *
 * 对照内部示例 `_10-sandbox-cloudbase-tools.ts`（远程 AGS 沙箱内 HTTP MCP），
 * 本脚本验证 local sandbox 路径：kernel 在宿主进程内挂载 `@cloudbase/cloudbase-mcp`
 * （optional peer，本仓库已放在 devDependencies），自动暴露 `mcp__cloudbase__*` 工具给 agent。
 *
 * 工具族：
 *   - Bash / Read / Write / Edit / Glob / Grep（SDK 内置，操作本地 cwd）
 *   - mcp__cloudbase__*（进程内 CloudBase MCP：数据库 / 存储 / 云函数 / …）
 *
 * 配置：
 *   - examples/config.local.json: envId / model / tcbApiKey
 *   - credentials.secretId/secretKey 可选；缺省或占位符时回退到 tcbApiKey（accessKey）
 *     供 workspacePersist（cwd.tar.gz → COS）鉴权
 *
 * 默认：
 *   - 省略 sandbox → enabled local
 *   - 省略 cwd → os.tmpdir()/oak-local-sandbox
 *   - 默认 cloudbaseTools: true → 进程内注入 mcp__cloudbase__*
 *
 * 运行：
 *   pnpm dlx tsx examples/09-local-sandbox-cloudbase-tools.ts
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
    // 默认 sandbox.cloudbaseTools: true → 进程内注入 mcp__cloudbase__*
    systemPrompt:
      'You are a CloudBase coding assistant working in a local workspace. ' +
      'You have two tool families:\n' +
      '  - Bash / Read / Write / Edit / Glob / Grep : local filesystem and shell\n' +
      '  - mcp__cloudbase__* : CloudBase resources (database / storage / cloudfunction / hosting / ...)\n' +
      'Prefer mcp__cloudbase__* when the task is about CloudBase resources. ' +
      'Always use the tools to verify—never fabricate output. ' +
      'Reply concisely in Chinese.',
  })

  const session = await agent.startSession({ userId: 'u1' })

  const prompt =
    '请帮我探索一下当前 CloudBase 环境：\n' +
    '1. 用 cloudbase 工具列出当前环境下的云数据库集合（最多 10 个）\n' +
    '2. 如果有集合，挑第一个集合查询前 3 条记录\n' +
    '3. 如果没有任何集合，告诉我即可，不要尝试创建\n' +
    '完成后简单总结你看到了什么。'

  console.log('cwd (default):', cwd)
  console.log('auth:', credentials.accessKey ? 'accessKey (CLOUDBASE_APIKEY)' : 'CAM secretId/secretKey')
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
