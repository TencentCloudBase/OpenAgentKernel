/**
 * Example 17: Session Store 原始数据调试
 *
 * 运行 client-tool 流程后，dump session_entries 和 session_messages 的原始数据，
 * 验证 entries 是否包含中间态的 sentinel deny，messages 是否干净。
 *
 * 运行：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/17-session-store-debug.ts
 */
import './_shared/env.js'

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { CloudBaseDbDriver, CloudBaseSessionStore, createAgent } from '@cloudbase/open-agent-kernel'

// ─── 配置 ──────────────────────────────────────────────────────────

const envId = process.env.TCB_ENV_ID!
const apiKey = process.env.TENCENTCLOUD_TOKENHUB_API_KEY!
const baseUrl = process.env.OAK_BASE_URL!

const driver = new CloudBaseDbDriver()
const sessionStore = new CloudBaseSessionStore({ driver, projectKey: envId })

const agent = createAgent({
  envId,
  model: { id: 'mimo-v2.5-pro', apiKey, apiBaseUrl: baseUrl },
  systemPrompt: 'You are a helpful assistant. Use get_weather tool when asked about weather. Reply concisely.',
  tools: [
    {
      name: 'get_weather',
      description: 'Get weather for a city',
      parameters: z.object({ city: z.string() }),
      execute: async () => ({ temp: 99, note: 'stub should not be called' }),
    },
  ],
  session: { store: sessionStore, projectKey: envId },
})

// ─── 主流程 ────────────────────────────────────────────────────────

const conversationId = randomUUID()
console.log(`conversationId: ${conversationId}\n`)

const session = await agent.startSession({ userId: 'debug-user', conversationId })

// Step 1: 触发 client-tool
console.log('=== Step 1: send ===')
let toolUseId: string | undefined
for await (const e of session.send('Call get_weather tool with city="Beijing". Do not skip the tool.')) {
  if (e.type === 'tool_use_required') {
    console.log(`  tool_use_required: ${e.toolName}, toolUseId=${e.toolUseId}`)
    toolUseId = e.toolUseId
  } else if (e.type === 'session_idle') {
    console.log(`  session_idle: ${e.reason}`)
  }
}

// Step 2: 注入结果
if (toolUseId) {
  console.log('\n=== Step 2: respondToolUse ===')
  for await (const e of session.respondToolUse({
    toolUseId,
    output: JSON.stringify({ temp: 25, city: 'Beijing', condition: 'sunny' }),
    isError: false,
  })) {
    if (e.type === 'session_idle') {
      console.log(`  session_idle: ${e.reason}`)
    } else if (e.type === 'tool_call') {
      console.log(`  tool_call: ${e.toolName}`)
    } else if (e.type === 'tool_result') {
      console.log(`  tool_result: ${JSON.stringify(e.output).slice(0, 100)}`)
    }
  }
}

// Step 3: Dump 原始数据
console.log('\n=== Step 3: Raw Session Store Data ===\n')

const dbDriver = sessionStore.getDriver() as any
const projectKey = envId

// ── session_messages ──
console.log('── session_messages (元数据) ──')
const messagesCol = await dbDriver.getCollection('session_messages')
const { data: messages } = await messagesCol
  .where({ sessionKey: `${projectKey}|${conversationId}` })
  .orderBy('createdAt', 'asc')
  .get()

for (const msg of messages) {
  console.log(`  ${msg.role} messageId=${msg.messageId?.slice(0, 16)}... createdAt=${msg.createdAt}`)
}

// ── session_entries ──
console.log('\n── session_entries (原始 SDK entries) ──')
const entriesCol = await dbDriver.getCollection('session_entries')
const { data: entries } = await entriesCol
  .where({ sessionKey: `${projectKey}|${conversationId}` })
  .orderBy('seq', 'asc')
  .get()

for (const row of entries) {
  const entry = row.entry
  const type = entry?.type || row.type || 'unknown'
  const uuid = entry?.uuid?.slice(0, 12) || 'null'
  const msgId = row.messageId?.slice(0, 16) || 'null'

  // 提取 content 摘要
  let contentSummary = ''
  if (type === 'user' || type === 'assistant') {
    const content = entry?.message?.content
    if (typeof content === 'string') {
      contentSummary = `text="${content.slice(0, 60)}${content.length > 60 ? '...' : ''}"`
    } else if (Array.isArray(content)) {
      const parts = content.map((b: any) => {
        if (b.type === 'text') return `text("${(b.text || '').slice(0, 40)}...")`
        if (b.type === 'tool_use') return `tool_use(${b.name}, id=${b.id?.slice(0, 12)}...)`
        if (b.type === 'tool_result') {
          const out = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '')
          const isSentinel = out.includes('__OAK_CLIENT_TOOL__') || out.includes('__OAK_INTERRUPT__')
          return `tool_result(${b.tool_use_id?.slice(0, 12)}..., ${isSentinel ? '⚠️ SENTINEL' : 'output=' + out.slice(0, 40) + '...'})`
        }
        return b.type
      })
      contentSummary = parts.join(' + ')
    }
  }

  console.log(`  [${type}] uuid=${uuid}... messageId=${msgId}...`)
  if (contentSummary) {
    console.log(`    content: ${contentSummary}`)
  }
}

// Step 4: getHistory() 聚合结果
console.log('\n── getHistory() 聚合结果 ──')
const history = await session.getHistory({ limit: 50 })
for (const msg of history) {
  const icon = msg.role === 'user' ? '👤' : '🤖'
  console.log(`${icon} [${msg.role}] id=${msg.id.slice(0, 12)}...`)
  for (const part of msg.parts) {
    if (part.type === 'text') console.log(`   📝 ${part.text.slice(0, 80)}...`)
    if (part.type === 'tool_call') console.log(`   🔧 ${part.toolName}(${JSON.stringify(part.input).slice(0, 60)})`)
    if (part.type === 'tool_result') console.log(`   📦 ${JSON.stringify(part.output).slice(0, 80)}...`)
  }
}

// Step 5: 对比分析
console.log('\n── 对比分析 ──')
const entryTypes = entries.map((r: any) => r.entry?.type || r.type)
const msgRoles = messages.map((m: any) => m.role)

console.log(`  entries 总数: ${entries.length}, 类型分布: ${JSON.stringify(entryTypes)}`)
console.log(`  messages 总数: ${messages.length}, 角色分布: ${JSON.stringify(msgRoles)}`)
console.log(`  getHistory 条数: ${history.length}`)

// 检查 entries 中是否有 sentinel
const sentinelEntries = entries.filter((r: any) => {
  const content = r.entry?.message?.content
  if (!Array.isArray(content)) return false
  return content.some((b: any) => {
    if (b.type !== 'tool_result') return false
    const out = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '')
    return out.includes('__OAK_CLIENT_TOOL__')
  })
})
console.log(`  entries 中含 sentinel 的条数: ${sentinelEntries.length}`)
if (sentinelEntries.length > 0) {
  console.log('  ⚠️  session_entries 保留了中间态的 sentinel deny tool_result')
  console.log('     这是预期行为 — entries 是 append-only 原始日志，不做清理')
  console.log('     聚合逻辑在 getHistory() → aggregateHistory() 中过滤')
}

await session.abort()
console.log('\n--- Done ---')
