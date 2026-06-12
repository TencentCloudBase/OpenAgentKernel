/**
 * Example 08: AGS Stateful Sandbox（腾讯云 Agent Sandbox 产品）
 *
 * 演示 agent 在真实远程沙箱里跑文件系统 + shell：
 *   1. 让 agent 在沙箱里写一个 README.md
 *   2. 让 agent 跑 `ls` 列目录
 *   3. 让 agent 读回 README.md 验证
 *
 * 凭证写在 examples/.env.local（从 .env.example 复制）：
 *   - TENCENTCLOUD_TOKENHUB_API_KEY  模型凭证
 *   - TCB_API_KEY                     沙箱数据面长期 JWT
 *   - TCB_ENV_ID                      CloudBase 环境
 *   - TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY  控制面 AK/SK
 *
 * 运行：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/08-sandbox.ts
 *
 * 注意：
 *   - 第一次运行会触发 CreateSandboxTool（~30s）+ StartSandboxInstance（~30-60s）
 *   - 之后同一 envId 会复用 ToolId（内存 cache），但每个 session 仍会启新实例
 */
import { getEnvId, getPlatformCredentials, getSandboxApiKey } from './_shared/env.js'

import { createAgent, AgsStatefulSandbox } from '@cloudbase/open-agent-kernel'

async function main(): Promise<void> {
  const envId = getEnvId()
  const credentials = getPlatformCredentials()

  const agent = createAgent({
    envId,
    credentials,
    model: process.env.CLOUDBASE_AGENT_MODEL ?? 'glm-5.1',
    systemPrompt:
      'You are a helpful coding assistant working inside a sandbox. ' +
      'You have access to bash / read / write tools (mcp__sandbox__*). ' +
      'Always use the tools to interact with the filesystem—never fabricate output. ' +
      'Reply concisely in Chinese.',
    sandbox: {
      runtime: new AgsStatefulSandbox({ apiKey: getSandboxApiKey() }),
      scope: 'shared',
      // PR #6A 默认 isolated 模式（每个 session 一个独立实例）
    },
  })

  const session = await agent.startSession({ userId: 'u1' })

  const prompt =
    '请完成以下任务：\n' +
    '1. 在工作目录用 write 工具创建一个 README.md，内容是 "# Hello from open-agent-kernel sandbox"\n' +
    '2. 用 bash 工具跑 `ls -la` 看下当前目录\n' +
    '3. 用 read 工具读 README.md 的内容并展示给我\n' +
    '完成后告诉我结果。'

  console.log('User:', prompt, '\n')
  process.stdout.write('Assistant: ')

  for await (const e of session.send(prompt)) {
    if (e.type === 'message_delta') {
      process.stdout.write(e.text)
    } else if (e.type === 'tool_call') {
      process.stdout.write(`\n  → ${e.toolName}(${JSON.stringify(e.input).slice(0, 200)})\n  `)
    } else if (e.type === 'tool_result') {
      const out = JSON.stringify(e.output).slice(0, 300)
      process.stdout.write(`\n  ← ${out}\n  `)
    } else if (e.type === 'error') {
      console.error('\n[error]', e.error.message)
    }
  }

  console.log('\n\n--- Cleaning up sandbox ---')
  await session.abort() // 触发 PauseSandboxInstance
  console.log('--- Done ---')
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
