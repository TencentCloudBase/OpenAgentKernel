/**
 * Example 16: Client-Tool History 真实集成测试
 *
 * 使用真实 API + CloudBase 验证 client-tool 流程的 getHistory() 聚合结果。
 *
 * 运行：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/16-client-tool-history-live.ts
 */
import './_shared/env.js'

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { CloudBaseDbDriver, CloudBaseSessionStore, createAgent } from '@cloudbase/open-agent-kernel'

// ─── 配置 ──────────────────────────────────────────────────────────

const envId = process.env.TCB_ENV_ID!
const apiKey = process.env.TENCENTCLOUD_TOKENHUB_API_KEY!
const baseUrl = process.env.OAK_BASE_URL!

console.log(`[config] envId=${envId}`)
console.log(`[config] baseUrl=${baseUrl}`)
console.log(`[config] apiKey=${apiKey.slice(0, 10)}...`)

// ─── Session Store ─────────────────────────────────────────────────

const driver = new CloudBaseDbDriver()
const sessionStore = new CloudBaseSessionStore({ driver, projectKey: envId })

// ─── 定义一个 client-tool ──────────────────────────────────────────

const agent = createAgent({
  envId,
  model: {
    id: 'mimo-v2.5-pro',
    apiKey,
    apiBaseUrl: baseUrl,
  },
  systemPrompt:
    'You are a helpful assistant. When the user asks about weather, ' +
    'use the get_weather tool. Reply concisely in Chinese.',
  tools: [
    {
      name: 'get_weather',
      description: 'Get current weather for a city',
      parameters: {
        type: 'object' as const,
        properties: {
          city: { type: 'string', description: 'City name' },
        },
        required: ['city'],
      },
      execute: async (_input: { city: string }, _ctx: unknown) => {
        // 这个 execute 不会被调用（client-tool 由 host 执行）
        return { temp: 99, note: 'this should not be called' }
      },
    },
  ],
  session: { store: sessionStore, projectKey: envId },
})

// ─── 主流程 ────────────────────────────────────────────────────────

const conversationId = randomUUID()
console.log(`\nconversationId: ${conversationId}\n`)

const session = await agent.startSession({ userId: 'test-user', conversationId })

const prompt =
  'You must call the get_weather tool immediately with input {"city":"Beijing"}. Do not say anything else first.'
console.log(`👤 User: ${prompt}\n`)

let toolUseId: string | undefined

// Step 1: 发送消息，等待 tool_use_required
process.stdout.write('🤖 Assistant: ')
for await (const e of session.send(prompt)) {
  switch (e.type) {
    case 'message_delta':
      process.stdout.write(e.text)
      break
    case 'tool_use_required':
      console.log(`\n\n  ⏸  client-tool 触发！`)
      console.log(`     工具: ${e.toolName}`)
      console.log(`     参数: ${JSON.stringify(e.input)}`)
      console.log(`     toolUseId: ${e.toolUseId}`)
      toolUseId = e.toolUseId
      break
    case 'session_idle':
      console.log(`\n[session_idle: ${e.reason}]`)
      break
    case 'error':
      console.error('\n[error]', e.error.message)
      break
  }
}

// Step 2: 模拟 client 执行工具，返回结果
if (toolUseId) {
  const mockResult = JSON.stringify({ temp: 25, unit: 'celsius', condition: 'sunny', city: 'Beijing' })
  console.log(`\n  ✅ 模拟 client 执行工具，返回: ${mockResult}\n`)
  process.stdout.write('🤖 Assistant (after tool): ')

  for await (const e of session.respondToolUse({
    toolUseId,
    output: mockResult,
    isError: false,
  })) {
    switch (e.type) {
      case 'message_delta':
        process.stdout.write(e.text)
        break
      case 'tool_call':
        console.log(`\n  → [tool_call] ${e.toolName}(${JSON.stringify(e.input)})`)
        break
      case 'tool_result':
        console.log(`  ← [tool_result] ${JSON.stringify(e.output).slice(0, 200)}`)
        break
      case 'session_idle':
        console.log(`\n[session_idle: ${e.reason}]`)
        break
      case 'error':
        console.error('\n[error]', e.error.message)
        break
    }
  }
}

// Step 3: getHistory() — 验证聚合结果
console.log(`\n${'═'.repeat(60)}`)
console.log('  getHistory() 结果')
console.log(`${'═'.repeat(60)}\n`)

const history = await session.getHistory({ limit: 50 })
console.log(`共 ${history.length} 条消息:\n`)

for (const msg of history) {
  const icon = msg.role === 'user' ? '👤' : '🤖'
  console.log(`${icon} [${msg.role}] id=${msg.id.slice(0, 8)}... status=${msg.status}`)
  for (const part of msg.parts) {
    switch (part.type) {
      case 'text':
        console.log(`   📝 text: ${part.text.slice(0, 150)}`)
        break
      case 'tool_call':
        console.log(`   🔧 tool_call: ${part.toolName}(${JSON.stringify(part.input).slice(0, 100)})`)
        break
      case 'tool_result':
        console.log(`   📦 tool_result: isError=${part.isError}, output=${JSON.stringify(part.output).slice(0, 150)}`)
        break
    }
  }
  console.log()
}

// Step 4: 验证
console.log(`${'═'.repeat(60)}`)
console.log('  验证')
console.log(`${'═'.repeat(60)}\n`)

const TOOL_FULL_NAME = 'mcp__custom__get_weather' // SDK adds MCP server prefix

const checks = [
  {
    label: '无 __OAK_CLIENT_TOOL__ sentinel 泄露',
    pass: !history.some((m) =>
      m.parts.some((p) => p.type === 'tool_result' && JSON.stringify(p.output).includes('__OAK_CLIENT_TOOL__')),
    ),
  },
  {
    label: '无 [系统通知] resume prompt 泄露',
    pass: !history.some((m) => m.parts.some((p) => p.type === 'text' && p.text.startsWith('[系统通知]'))),
  },
  {
    label: '无孤立 tool_result user 消息',
    pass: !history.some(
      (m) => m.role === 'user' && m.parts.length > 0 && m.parts.every((p) => p.type === 'tool_result'),
    ),
  },
  {
    label: 'get_weather tool_call 存在',
    pass: history.some((m) => m.parts.some((p) => p.type === 'tool_call' && p.toolName === TOOL_FULL_NAME)),
  },
  {
    label: '实际 tool_result 存在且包含 city=Beijing',
    pass: history.some((m) =>
      m.parts.some((p) => p.type === 'tool_result' && JSON.stringify(p.output).includes('Beijing')),
    ),
  },
  {
    label: 'tool_call 和 tool_result 配对（在同一 assistant 消息中）',
    pass: history.some((m) => {
      if (m.role !== 'assistant') return false
      const calls = m.parts.filter((p) => p.type === 'tool_call' && p.toolName === TOOL_FULL_NAME)
      const results = m.parts.filter((p) => p.type === 'tool_result')
      return calls.length > 0 && results.length > 0
    }),
  },
  {
    label: '只有 1 次 get_weather tool_call（无重复）',
    pass:
      history.flatMap((m) => m.parts).filter((p) => p.type === 'tool_call' && p.toolName === TOOL_FULL_NAME).length ===
      1,
  },
]

for (const c of checks) {
  console.log(`${c.pass ? '✅' : '❌'} ${c.label}`)
}

const allPassed = checks.every((c) => c.pass)
console.log(allPassed ? '\n🎉 所有验证通过！' : '\n⚠️  部分验证失败。')

// ── 清理 ──
await session.abort()
console.log('\n--- Done ---')
