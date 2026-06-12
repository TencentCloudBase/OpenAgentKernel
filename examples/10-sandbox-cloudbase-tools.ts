/**
 * Example 10: PR #6.5 —— Sandbox 内置 CloudBase MCP 工具
 *
 * 演示当开通 sandbox 后，kernel 自动暴露 `mcp__cloudbase__*` 工具集（DB / COS /
 * 云函数 / 静态托管 / …）给 agent。
 *
 * 与 example 08/09 的区别：
 *   - 08/09 只用 `mcp__sandbox__*`（bash/read/write/edit/glob/grep）操作沙箱内文件系统
 *   - 10 在此基础上 **自动**注入 `mcp__cloudbase__*`，agent 可以直接调 CloudBase 资源
 *     （凭证由 kernel 注入，agent 不需要手动 mcporter call）
 *
 * 凭证（examples/.env.local）：
 *   - TENCENTCLOUD_TOKENHUB_API_KEY  模型凭证
 *   - TCB_API_KEY                     沙箱数据面长期 JWT
 *   - TCB_ENV_ID                      CloudBase 环境
 *   - TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY  控制面 AK/SK（同时作为用户租户凭证兜底）
 *
 * 运行：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/10-sandbox-cloudbase-tools.ts
 *
 * 注意：
 *   - 第一次运行会触发 CreateSandboxTool（~30s）+ StartSandboxInstance（~30-60s）
 *     + cloudbase schema 发现（~3-10s）
 *   - 镜像必须自带 mcporter + cloudbase-mcp（默认 OpenVibeCoding 公开 vibecoding 镜像满足）
 *   - 镜像不带这两个工具时，cloudbase tools 自动 degrade（仍能用 sandbox 文件系统工具）
 */
import { getEnvId, getPlatformCredentials } from './_shared/env.js'

import { createAgent } from '@cloudbase/open-agent-kernel'

async function main(): Promise<void> {
  const envId = getEnvId()
  const credentials = getPlatformCredentials()

  const agent = createAgent({
    envId,
    credentials,
    model: process.env.CLOUDBASE_AGENT_MODEL ?? 'glm-5.1',
    systemPrompt:
      'You are a CloudBase coding assistant working inside a sandbox. ' +
      'You have two tool families:\n' +
      '  - mcp__sandbox__*  : filesystem and shell (bash/read/write/edit/glob/grep)\n' +
      '  - mcp__cloudbase__*: CloudBase resources (database / storage / cloudfunction / hosting / ...)\n' +
      'Prefer mcp__cloudbase__* when the task is about CloudBase resources. ' +
      'Always use the tools to verify—never fabricate output. ' +
      'Reply concisely in Chinese.',
    sandbox: {
      enabled: true,
      // 默认 cloudbaseTools: true（开通 sandbox 即内置 cloudbase MCP）
      // 用户租户凭证不传时回退到 AgentConfig.credentials
      // 多租户场景示例（每次 acquire 调一次拿当前用户的凭证）：
      //   userCredentials: async () => {
      //     const u = await myDb.getUserCloudbaseCreds(currentUserId)
      //     return { envId: u.envId, secretId: u.secretId, secretKey: u.secretKey }
      //   },
    },
  })

  const session = await agent.startSession({ userId: 'u1' })

  const prompt =
    '请帮我探索一下当前 CloudBase 环境：\n' +
    '1. 用 cloudbase 工具列出当前环境下的云数据库集合（最多 10 个）\n' +
    '2. 如果有集合，挑第一个集合查询前 3 条记录\n' +
    '3. 如果没有任何集合，告诉我即可，不要尝试创建\n' +
    '完成后简单总结你看到了什么。'

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
