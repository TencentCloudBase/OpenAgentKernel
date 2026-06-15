/**
 * Example 11: PR #7.0 —— HITL 工具审批（单进程，CLI 交互）
 *
 * 演示：
 *   - `permissions.requireApproval` 把指定工具变成"需审批"
 *   - 事件流出 `tool_approval_required` 后流自然结束（reason: 'requires_action'）
 *   - 业务侧通过 readline 在终端收集用户决定
 *   - `session.respondApproval({ toolUseId, decision })` 注入决策并 resume
 *   - 决策为 allow → 工具执行，agent 继续；deny → 模型收到拒绝并解释
 *
 * 这是 PR #7.0 的最小演示：单进程内进行，PermissionStore 走默认 InMemoryPermissionStore。
 * 多节点 / 跨进程 / 跨设备审批见 PR #7.1（需配 CloudBasePermissionStore）。
 *
 * 配置：复用 example 06 的（仅需要 TCB_API_KEY + config.envId）。
 *
 * 运行：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/11-hitl-approval.ts
 */
import { getEnvId, getModel } from './_shared/env.js'

import { CloudBaseSessionStore, createAgent, InMemoryDriver } from '@cloudbase/open-agent-kernel'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import readline from 'node:readline/promises'
import { z } from 'zod'

/**
 * 一个简单的"危险"工具：模拟"删除文件"。
 * 我们让 agent 用它，触发审批流程。
 */
const dangerousTools = createSdkMcpServer({
  name: 'fs',
  version: '1.0.0',
  tools: [
    tool(
      'deleteFile',
      'Delete a file from the filesystem (DANGEROUS — should always require approval).',
      { path: z.string().describe('Absolute path to the file to delete') },
      async (args) => ({
        content: [{ type: 'text', text: `Deleted ${args.path} (simulated, nothing actually deleted).` }],
      }),
    ),
    tool(
      'listFiles',
      'List files in a directory (safe, does not require approval).',
      { dir: z.string().describe('Directory to list') },
      async (args) => ({
        content: [{ type: 'text', text: `Files in ${args.dir}: a.txt, b.txt, c.log` }],
      }),
    ),
  ],
})

async function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(question)).trim().toLowerCase()
  } finally {
    rl.close()
  }
}

async function main(): Promise<void> {
  const agent = createAgent({
    envId: getEnvId(),
    model: getModel(),
    systemPrompt:
      'You are a helpful assistant with two tools: ' +
      'mcp__fs__listFiles (safe) and mcp__fs__deleteFile (DANGEROUS). ' +
      'When the user asks to delete files, call deleteFile. ' +
      'Reply concisely in Chinese.',
    mcpServers: { fs: dangerousTools },
    // 💡 PR #7.0 必需：HITL 的 resume 是"重新进入 SDK query"，需要 transcript 能 resume。
    //    单进程 demo 用 InMemoryDriver 即可；生产用 CloudBaseDbDriver。
    session: {
      store: new CloudBaseSessionStore({ driver: new InMemoryDriver() }),
    },
    permissions: {
      // PR #7.0：把 deleteFile 标为需审批（精确匹配）
      // 也可写成数组、通配符、或函数：
      //   requireApproval: ['mcp__fs__deleteFile']
      //   requireApproval: 'mcp__fs__delete*'
      //   requireApproval: (ctx) => ctx.toolName.includes('delete')
      requireApproval: 'mcp__fs__deleteFile',
      // store 不传 → 走默认 InMemoryPermissionStore
      // approvalTimeoutMs 不传 → 默认 30 分钟
    },
  })

  const session = await agent.startSession({ userId: 'u1' })

  console.log('=== 第 1 步：用户请求"删除文件"，模型会调工具触发审批 ===\n')
  const prompt =
    '请直接调用 mcp__fs__deleteFile 工具删除 /tmp/old.log 这个文件。' +
    '不要提前征求我的同意，直接调用工具就好——上层会处理审批流程。'
  console.log(`User: ${prompt}\n`)
  process.stdout.write('Assistant: ')

  let pendingApproval: { toolUseId: string; toolName: string; input: unknown } | undefined

  for await (const e of session.send(prompt)) {
    if (e.type === 'message_delta') {
      process.stdout.write(e.text)
    } else if (e.type === 'tool_call') {
      process.stdout.write(`\n  → ${e.toolName}(${JSON.stringify(e.input).slice(0, 200)})\n  `)
    } else if (e.type === 'tool_result') {
      process.stdout.write(`\n  ← ${JSON.stringify(e.output).slice(0, 200)}\n  `)
    } else if (e.type === 'tool_approval_required') {
      console.log('\n\n⏸  审批请求：')
      console.log(`   工具: ${e.toolName}`)
      console.log(`   参数: ${JSON.stringify(e.input)}`)
      console.log(`   toolUseId: ${e.toolUseId}`)
      pendingApproval = { toolUseId: e.toolUseId, toolName: e.toolName, input: e.input }
    } else if (e.type === 'session_idle') {
      console.log(`\n[session_idle: ${e.reason}]`)
    } else if (e.type === 'error') {
      console.error('\n[error]', e.error.message)
    }
  }

  if (!pendingApproval) {
    console.log('\n（没有触发审批，example 演示结束）')
    return
  }

  // ── 第 2 步：业务侧收集用户决定 ──
  console.log('\n=== 第 2 步：在终端做决策 ===')
  const answer = await promptUser('[a]llow / [d]eny / [Enter=allow] > ')
  const approved = answer === '' || answer === 'a' || answer === 'allow' || answer === 'y'

  console.log(`\n=== 第 3 步：respondApproval（${approved ? 'allow' : 'deny'}）===\n`)
  process.stdout.write('Assistant: ')

  for await (const e of session.respondApproval({
    toolUseId: pendingApproval.toolUseId,
    decision: approved
      ? { kind: 'allow', scope: 'once' }
      : { kind: 'deny', reason: '用户在 CLI 拒绝', interrupt: false },
  })) {
    if (e.type === 'message_delta') {
      process.stdout.write(e.text)
    } else if (e.type === 'tool_call') {
      process.stdout.write(`\n  → ${e.toolName}(${JSON.stringify(e.input).slice(0, 200)})\n  `)
    } else if (e.type === 'tool_result') {
      process.stdout.write(`\n  ← ${JSON.stringify(e.output).slice(0, 200)}\n  `)
    } else if (e.type === 'tool_approval_required') {
      // 第二个工具调用又触发了审批；为简化 demo，直接 allow
      console.log('\n\n⏸  又一个审批请求（demo 自动 allow）：', e.toolName, e.input)
      // 注意：这里嵌套调用同一 session.respondApproval 来再次 resume——支持
      for await (const e2 of session.respondApproval({
        toolUseId: e.toolUseId,
        decision: { kind: 'allow', scope: 'once' },
      })) {
        if (e2.type === 'message_delta') process.stdout.write(e2.text)
        else if (e2.type === 'tool_call')
          process.stdout.write(`\n  → ${e2.toolName}(${JSON.stringify(e2.input).slice(0, 200)})\n  `)
        else if (e2.type === 'tool_result') process.stdout.write(`\n  ← ${JSON.stringify(e2.output).slice(0, 200)}\n  `)
        else if (e2.type === 'session_idle') console.log(`\n[session_idle: ${e2.reason}]`)
        else if (e2.type === 'error') console.error('\n[error]', e2.error.message)
      }
    } else if (e.type === 'session_idle') {
      console.log(`\n[session_idle: ${e.reason}]`)
    } else if (e.type === 'error') {
      console.error('\n[error]', e.error.message)
    }
  }

  console.log('\n--- Done ---')
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
