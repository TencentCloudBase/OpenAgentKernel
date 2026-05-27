/**
 * Example 09: PR #6B —— Sandbox shared 模式 + 扩展工具集
 *
 * 演示：
 *   1. **shared 模式**：起两个 session（相同 envId），都命中同一个 AGS 实例
 *      第一个 session 写入的文件，第二个 session 能直接读到（实例共享）
 *   2. **新工具**：edit / glob / grep 在沙箱里做精确编辑 + 文件检索 + 内容搜索
 *
 * 凭证写在 examples/.env.local（同 example 08）。
 *
 * 运行：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/09-sandbox-shared.ts
 */
import './_shared/env.js'

import { createAgent, AgsStatefulSandbox } from '@cloudbase/open-agent-kernel'
import type { SessionEvent } from '@cloudbase/open-agent-kernel'

async function streamSession(
  label: string,
  session: { send: (input: string) => AsyncIterable<SessionEvent> },
  prompt: string,
): Promise<void> {
  console.log(`\n=== ${label} ===`)
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
  console.log()
}

async function main(): Promise<void> {
  const envId = process.env.TCB_ENV_ID
  if (!envId) {
    throw new Error('TCB_ENV_ID is required (set it in examples/.env.local)')
  }

  const agent = createAgent({
    envId,
    model: process.env.CLOUDBASE_AGENT_MODEL ?? 'glm-5.1',
    systemPrompt:
      'You are a helpful coding assistant working inside a sandbox. ' +
      'You have access to bash / read / write / edit / glob / grep tools (mcp__sandbox__*). ' +
      'Always use the tools to interact with the filesystem—never fabricate output. ' +
      'Reply concisely in Chinese.',
    sandbox: {
      runtime: new AgsStatefulSandbox(),
      // shared 模式：同 envId 多 session 共享一个实例
      scope: 'shared',
    },
  })

  // ── Session A：写一个文件 + 用 glob 检查 ──────────────
  const sessionA = await agent.startSession({ userId: 'u1' })
  await streamSession(
    'Session A',
    sessionA,
    '请用 write 工具创建一个文件 hello.txt，内容是 "Hello from session A. version=1.0"。' +
      '然后用 glob 工具列出当前目录下所有 .txt 文件。',
  )

  // ── Session B：在共享实例里能读到 A 写的文件 + 用 edit 改 + grep 验证 ──
  const sessionB = await agent.startSession({ userId: 'u2' })
  await streamSession(
    'Session B（共享实例，应该能看到 Session A 写的文件）',
    sessionB,
    '请完成以下任务：\n' +
      '1. 用 read 工具读 hello.txt（这应该是上个 session 创建的）\n' +
      '2. 用 edit 工具把里面的 "version=1.0" 改成 "version=2.0"\n' +
      '3. 用 grep 工具在当前目录搜索 "version=" 验证内容\n' +
      '完成后告诉我每一步的结果。',
  )

  // 清理：把两个 session 都 abort（shared 模式下 abort 不 pause，避免影响其他用户）
  await sessionA.abort()
  await sessionB.abort()
  console.log('\n--- Done ---')
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
