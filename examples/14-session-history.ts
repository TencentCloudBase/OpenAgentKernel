/**
 * Example 14: Session History 综合演示（getHistory + MCP 工具 + HITL 审批）
 *
 * 演示：
 *   1. 基本对话 + getHistory() 查询前端可读消息记录
 *   2. MCP 工具调用（验证 tool_call / tool_result 被正确记录）
 *   3. HITL 审批流程（验证 tool_approval_required 相关消息被记录）
 *   4. 打印 history 原始数据结构（方便调试 / 理解 MessageRecord 格式）
 *   5. clearHistory() 清除消息索引
 *
 * 前置条件：
 *   - 仅需模型凭证（TENCENTCLOUD_TOKENHUB_API_KEY）
 *   - 不需要 CloudBase DB / 沙箱凭证（使用 InMemoryDriver）
 *
 * 运行：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/14-session-history.ts
 */
import './_shared/env.js'

import { randomUUID } from 'node:crypto'
import { CloudBaseSessionStore, createAgent, InMemoryDriver } from '@cloudbase/open-agent-kernel'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

// ─── 工具定义：一个安全工具 + 一个危险工具 ────────────────────────────

const mockTools = createSdkMcpServer({
  name: 'demo',
  version: '1.0.0',
  tools: [
    tool(
      'queryDatabase',
      'Query a database collection and return records.',
      { collection: z.string().describe('Collection name'), limit: z.number().optional().describe('Max records') },
      async (args) => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              collection: args.collection,
              records: [
                { _id: '001', name: 'Alice', age: 28 },
                { _id: '002', name: 'Bob', age: 32 },
              ],
              total: 2,
            }),
          },
        ],
      }),
    ),
    tool(
      'deleteRecord',
      'Delete a record from a collection (DANGEROUS — requires approval).',
      { collection: z.string().describe('Collection name'), recordId: z.string().describe('Record ID to delete') },
      async (args) => ({
        content: [{ type: 'text', text: `Deleted record ${args.recordId} from ${args.collection} (simulated).` }],
      }),
    ),
  ],
})

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
          console.log(`   🔧 tool_call: ${part.toolName}(${JSON.stringify(part.input).slice(0, 100)})`)
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

const driver = new InMemoryDriver()
const sessionStore = new CloudBaseSessionStore({ driver })

const agent = createAgent({
  envId: process.env.TCB_ENV_ID ?? 'demo-env',
  model: process.env.CLOUDBASE_AGENT_MODEL ?? 'glm-5.1',
  systemPrompt:
    'You are a helpful database assistant. You have two tools:\n' +
    '  - mcp__demo__queryDatabase: query records (safe)\n' +
    '  - mcp__demo__deleteRecord: delete a record (DANGEROUS)\n' +
    'When asked to query, use queryDatabase. When asked to delete, use deleteRecord.\n' +
    'Reply concisely in Chinese.',
  mcpServers: { demo: mockTools },
  session: { store: sessionStore },
  permissions: {
    // 只有 deleteRecord 需要审批
    requireApproval: 'mcp__demo__deleteRecord',
  },
})

const conversationId = randomUUID()
const session = await agent.startSession({ userId: 'demo-user', conversationId })
console.log(`conversationId: ${conversationId}`)

// ═══════════════════════════════════════════════════════════════════
// Phase 1: 基本对话 + 工具调用（安全工具，无需审批）
// ═══════════════════════════════════════════════════════════════════

printSeparator('Phase 1: 对话 + 安全工具调用')

const prompt1 = '请查询 users 集合的前 5 条记录。'
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
// Phase 2: HITL 审批流程（危险工具）
// ═══════════════════════════════════════════════════════════════════

printSeparator('Phase 2: HITL 审批（危险工具触发审批 → 自动 allow）')

const prompt2 = '请删除 users 集合中 recordId 为 001 的记录。直接调用工具，不要征求我同意。'
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

// 自动批准（生产环境中应由用户在 UI 操作）
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
  console.log('\n  ⚠️  未触发审批流程（模型可能没有调用 deleteRecord 工具）')
}

// ═══════════════════════════════════════════════════════════════════
// Phase 3: 查询完整 history + 打印原始数据结构
// ═══════════════════════════════════════════════════════════════════

printSeparator('Phase 3: getHistory() — 语义化格式')

const history = await session.getHistory({ limit: 50 })
printHistory(history)

// ─── 打印原始 JSON 数据结构（方便调试 / 理解 MessageRecord 格式） ────

printSeparator('Phase 3b: getHistory() — 原始 JSON 数据结构')

console.log(JSON.stringify(history, null, 2))

// ═══════════════════════════════════════════════════════════════════
// Phase 4: 验证结果统计
// ═══════════════════════════════════════════════════════════════════

printSeparator('Phase 4: 验证结果')

let toolCallCount = 0
let toolResultCount = 0
let approvalCount = 0

for (const msg of history) {
  for (const part of msg.parts) {
    if (part.type === 'tool_call') toolCallCount++
    if (part.type === 'tool_result') toolResultCount++
    if (part.type === 'tool_approval_required') approvalCount++
  }
}

const checks = [
  { label: '包含 user 消息', pass: history.some((m) => m.role === 'user') },
  { label: '包含 assistant 消息', pass: history.some((m) => m.role === 'assistant') },
  { label: `包含 tool_call (${toolCallCount} 个)`, pass: toolCallCount > 0 },
  { label: `包含 tool_result (${toolResultCount} 个)`, pass: toolResultCount > 0 },
]

for (const c of checks) {
  console.log(`${c.pass ? '✅' : '❌'} ${c.label}`)
}

const allPassed = checks.every((c) => c.pass)
console.log(allPassed ? '\n🎉 所有验证通过！' : '\n⚠️  部分验证失败，请检查。')

// ═══════════════════════════════════════════════════════════════════
// Phase 5: clearHistory() 演示
// ═══════════════════════════════════════════════════════════════════

printSeparator('Phase 5: clearHistory() — 清除消息索引')

console.log('调用 session.clearHistory()...')
await session.clearHistory()

const historyAfterClear = await session.getHistory({ limit: 50 })
console.log(`清除后 getHistory() 返回: ${historyAfterClear.length} 条消息`)
console.log(historyAfterClear.length === 0 ? '✅ clearHistory 生效' : '⚠️  仍有消息残留')

console.log('\n--- Done ---')
