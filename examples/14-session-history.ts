/**
 * Example 14: Session History 综合演示（真实沙箱 + HITL 审批 + getHistory 聚合）
 *
 * 演示：
 *   1. 真实 AGS 沙箱环境（mcp__sandbox__* 工具）
 *   2. 安全工具调用（glob/read，不触发审批）
 *   3. 危险工具 + HITL 审批（bash 命令，触发审批 → 自动 allow）
 *   4. getHistory() 聚合结果：tool_call + tool_result 配对，内部协议产物过滤
 *   5. 打印原始 JSON 数据结构
 *   6. clearHistory() 清除消息索引
 *
 * 前置条件：
 *   - TENCENTCLOUD_TOKENHUB_API_KEY（模型凭证）
 *   - TCB_ENV_ID + TENCENTCLOUD_SECRETID + TENCENTCLOUD_SECRETKEY（CloudBase 控制面）
 *   - TCB_API_KEY（沙箱数据面 JWT）
 *
 * 运行：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/14-session-history.ts
 */
import { getEnvId, getPlatformCredentials } from './_shared/env.js'

import { randomUUID } from 'node:crypto'
import { createAgent } from '@cloudbase/open-agent-kernel'

// ─── 辅助函数 ──────────────────────────────────────────────────────

function printSeparator(title: string): void {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  ${title}`)
  console.log(`${'═'.repeat(60)}\n`)
}

function printHistory(history: Awaited<ReturnType<typeof session.getHistory>>): void {
  console.log(`共 ${history.length} 条消息记录:\n`)
  for (const msg of history) {
    const roleIcon = msg.role === 'user' ? '👤' : msg.role === 'assistant' ? '🤖' : '⚙️'
    console.log(
      `${roleIcon} [${msg.role}] id=${msg.id.slice(0, 8)}... status=${msg.status} ` +
        `time=${new Date(msg.createdAt).toISOString()}`,
    )
    for (const part of msg.parts) {
      switch (part.type) {
        case 'text':
          console.log(`   📝 text: ${part.text.slice(0, 120)}${part.text.length > 120 ? '...' : ''}`)
          break
        case 'thinking':
          console.log(`   💭 thinking: ${part.text.slice(0, 80)}...`)
          break
        case 'tool_call':
          console.log(
            `   🔧 tool_call: ${part.toolName}(${JSON.stringify(part.input).slice(0, 100)})` +
              (part.status ? ` [status=${part.status}]` : ''),
          )
          break
        case 'tool_result':
          console.log(`   📦 tool_result: isError=${part.isError}, output=${JSON.stringify(part.output).slice(0, 100)}`)
          break
        case 'tool_approval_required':
          console.log(`   ⏸️  tool_approval_required: ${part.toolName}(${JSON.stringify(part.input).slice(0, 100)})`)
          break
      }
    }
    console.log()
  }
}

// ─── 主流程 ────────────────────────────────────────────────────────

const envId = getEnvId()
const credentials = getPlatformCredentials()

const agent = createAgent({
  envId,
  credentials,
  model: process.env.CLOUDBASE_AGENT_MODEL ?? 'glm-5.1',
  systemPrompt:
    'You are a helpful coding assistant working inside a sandbox.\n' +
    'You have access to sandbox tools:\n' +
    '  - mcp__sandbox__glob: list files by pattern (safe)\n' +
    '  - mcp__sandbox__read: read file content (safe)\n' +
    '  - mcp__sandbox__bash: execute shell commands (DANGEROUS, requires approval)\n' +
    'When asked to run commands, use mcp__sandbox__bash directly.\n' +
    'When asked to list/read files, use glob or read.\n' +
    'Reply concisely in Chinese.',
  sandbox: {
    enabled: true,
    cloudbaseTools: false, // 只用 sandbox 工具，不启用 cloudbase MCP（简化依赖）
  },
  permissions: {
    // bash 命令需要审批（危险操作）
    requireApproval: 'mcp__sandbox__bash',
  },
})

const conversationId = randomUUID()
const session = await agent.startSession({ userId: 'demo-user', conversationId })
console.log(`conversationId: ${conversationId}`)

// ═══════════════════════════════════════════════════════════════════
// Phase 1: 安全工具调用（glob/read，不触发审批）
// ═══════════════════════════════════════════════════════════════════

printSeparator('Phase 1: 安全工具调用（无需审批）')

const prompt1 = '请用 glob 工具列出沙箱根目录下的文件（pattern 用 /*）'
console.log(`User: ${prompt1}\n`)
process.stdout.write('Assistant: ')

for await (const e of session.send(prompt1)) {
  if (e.type === 'message_delta') process.stdout.write(e.text)
  else if (e.type === 'tool_call') console.log(`\n  → [tool_call] ${e.toolName}(${JSON.stringify(e.input)})`)
  else if (e.type === 'tool_result') console.log(`  ← [tool_result] ${JSON.stringify(e.output).slice(0, 200)}`)
  else if (e.type === 'session_idle') console.log(`\n[session_idle: ${e.reason}]`)
  else if (e.type === 'error') console.error('\n[error]', e.error.message)
}

// ═══════════════════════════════════════════════════════════════════
// Phase 2: 危险工具 + HITL 审批（bash 命令）
// ═══════════════════════════════════════════════════════════════════

printSeparator('Phase 2: HITL 审批（bash 命令触发审批 → 自动 allow）')

const prompt2 = '请用 bash 工具执行 echo "hello from sandbox" && date 命令。直接调用工具，不要征求我同意。'
console.log(`User: ${prompt2}\n`)
process.stdout.write('Assistant: ')

let pendingApproval: { toolUseId: string; toolName: string; input: unknown } | undefined

for await (const e of session.send(prompt2)) {
  if (e.type === 'message_delta') process.stdout.write(e.text)
  else if (e.type === 'tool_call') console.log(`\n  → [tool_call] ${e.toolName}(${JSON.stringify(e.input)})`)
  else if (e.type === 'tool_result') console.log(`  ← [tool_result] ${JSON.stringify(e.output).slice(0, 200)}`)
  else if (e.type === 'tool_approval_required') {
    console.log('\n\n  ⏸  审批请求触发！')
    console.log(`     工具: ${e.toolName}`)
    console.log(`     参数: ${JSON.stringify(e.input)}`)
    console.log(`     toolUseId: ${e.toolUseId}`)
    pendingApproval = { toolUseId: e.toolUseId, toolName: e.toolName, input: e.input }
  } else if (e.type === 'session_idle') console.log(`\n[session_idle: ${e.reason}]`)
  else if (e.type === 'error') console.error('\n[error]', e.error.message)
}

// 自动批准
if (pendingApproval) {
  console.log('\n  ✅ 自动批准 (demo mode)...\n')
  process.stdout.write('Assistant (after approval): ')

  for await (const e of session.respondApproval({
    toolUseId: pendingApproval.toolUseId,
    decision: { kind: 'allow', scope: 'once' },
  })) {
    if (e.type === 'message_delta') process.stdout.write(e.text)
    else if (e.type === 'tool_call') console.log(`\n  → [tool_call] ${e.toolName}(${JSON.stringify(e.input)})`)
    else if (e.type === 'tool_result') console.log(`  ← [tool_result] ${JSON.stringify(e.output).slice(0, 200)}`)
    else if (e.type === 'session_idle') console.log(`\n[session_idle: ${e.reason}]`)
    else if (e.type === 'error') console.error('\n[error]', e.error.message)
  }
} else {
  console.log('\n  ⚠️  未触发审批流程（模型可能没有调用 bash 工具）')
}

// ═══════════════════════════════════════════════════════════════════
// Phase 3: getHistory() — 聚合后的语义化格式
// ═══════════════════════════════════════════════════════════════════

printSeparator('Phase 3: getHistory() — 聚合后的语义化格式')

const history = await session.getHistory({ limit: 50 })
printHistory(history)

// ─── 打印原始 JSON 数据结构 ──────────────────────────────────────

printSeparator('Phase 3b: getHistory() — 原始 JSON 数据结构')

console.log(JSON.stringify(history, null, 2))

// ═══════════════════════════════════════════════════════════════════
// Phase 4: 验证聚合结果
// ═══════════════════════════════════════════════════════════════════

printSeparator('Phase 4: 验证聚合结果')

let toolCallCount = 0
let toolResultCount = 0
let pairedCount = 0

for (const msg of history) {
  for (let i = 0; i < msg.parts.length; i++) {
    const part = msg.parts[i]
    if (part.type === 'tool_call') {
      toolCallCount++
      // 检查下一个 part 是否是配对的 tool_result
      const next = msg.parts[i + 1]
      if (next && next.type === 'tool_result') pairedCount++
    }
    if (part.type === 'tool_result') toolResultCount++
  }
}

// 验证：不应该有 role=user 且只含 tool_result 的消息（应该被聚合掉了）
const orphanedToolResultMsgs = history.filter(
  (m) => m.role === 'user' && m.parts.length > 0 && m.parts.every((p) => p.type === 'tool_result'),
)
// 验证：不应该有包含 __OAK_INTERRUPT__ 的消息
const sentinelMsgs = history.filter((m) =>
  m.parts.some((p) => p.type === 'tool_result' && JSON.stringify(p.output).includes('__OAK_INTERRUPT__')),
)
// 验证：不应该有 [系统通知] 消息
const resumePromptMsgs = history.filter((m) =>
  m.parts.some((p) => p.type === 'text' && p.text.startsWith('[系统通知]')),
)

const checks = [
  { label: '包含 user 消息', pass: history.some((m) => m.role === 'user') },
  { label: '包含 assistant 消息', pass: history.some((m) => m.role === 'assistant') },
  { label: `tool_call 和 tool_result 在同一 assistant 消息中配对 (${pairedCount} 对)`, pass: pairedCount > 0 },
  { label: '无孤立 tool_result user 消息（已聚合）', pass: orphanedToolResultMsgs.length === 0 },
  { label: '无 __OAK_INTERRUPT__ sentinel 泄露', pass: sentinelMsgs.length === 0 },
  { label: '无 [系统通知] resume prompt 泄露', pass: resumePromptMsgs.length === 0 },
  {
    label: '无被放弃的 awaiting_approval 工具调用（已过滤）',
    pass: !history.some((m) =>
      m.parts.some((p) => p.type === 'tool_call' && 'status' in p && p.status === 'awaiting_approval'),
    ),
  },
]

for (const c of checks) {
  console.log(`${c.pass ? '✅' : '❌'} ${c.label}`)
}

const allPassed = checks.every((c) => c.pass)
console.log(allPassed ? '\n🎉 所有验证通过！聚合机制正常工作。' : '\n⚠️  部分验证失败，请检查。')

// ═══════════════════════════════════════════════════════════════════
// Phase 5: clearHistory()
// ═══════════════════════════════════════════════════════════════════

printSeparator('Phase 5: clearHistory() — 清除消息索引')

console.log('调用 session.clearHistory()...')
await session.clearHistory()

const historyAfterClear = await session.getHistory({ limit: 50 })
console.log(`清除后 getHistory() 返回: ${historyAfterClear.length} 条消息`)
console.log(historyAfterClear.length === 0 ? '✅ clearHistory 生效' : '⚠️  仍有消息残留')

// ── 清理沙箱 ──
console.log('\n--- Cleaning up sandbox ---')
await session.abort()
console.log('--- Done ---')
