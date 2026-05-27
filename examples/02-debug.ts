/**
 * 02-debug.ts —— 诊断脚本（PR #3 排错用）
 *
 * 打印 Claude SDK 发出的所有原始消息 type，以及 kernel 翻译出的 SessionEvent。
 * 用来定位"为什么 message_delta 没触发"。
 *
 * 运行：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/02-debug.ts
 *
 * 凭证写在 examples/.env.local（从 .env.example 复制）。
 */
import './_shared/env.js'

import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk'
import { buildClaudeQueryOptions } from '../src/runtime/agent-builder.js'
import { translateSdkMessage } from '../src/runtime/event-translator.js'

async function main(): Promise<void> {
  const { options } = buildClaudeQueryOptions({
    envId: process.env.TCB_ENV_ID ?? 'demo-env',
    model: process.env.CLOUDBASE_AGENT_MODEL ?? 'glm-5.1',
    systemPrompt: 'You are a helpful assistant. Reply concisely in Chinese.',
  })

  console.log('=== Options summary ===')
  console.log('model:', options.model)
  console.log('settingSources:', options.settingSources)
  console.log('strictMcpConfig:', options.strictMcpConfig)
  console.log('persistSession:', options.persistSession)
  console.log('tools:', options.tools)
  console.log('env.ANTHROPIC_BASE_URL:', options.env?.ANTHROPIC_BASE_URL)
  console.log(
    'env.ANTHROPIC_AUTH_TOKEN:',
    options.env?.ANTHROPIC_AUTH_TOKEN ? '<set>' : '<unset>',
  )
  console.log('')

  const q = claudeQuery({
    prompt: '你好，请用一句话介绍你自己。',
    options,
  })

  console.log('=== Stream events ===')
  for await (const msg of q) {
    console.log('raw msg', JSON.stringify(msg))
    // 打印 SDK 原始消息的 type + subtype（不打印 content 避免太长）
    const summary: Record<string, unknown> = { sdk_type: msg.type }
    if ('subtype' in msg) summary.subtype = msg.subtype
    if ('subagent_type' in msg) summary.subagent_type = msg.subagent_type
    if (msg.type === 'assistant' && 'message' in msg) {
      const m = msg.message as { content?: Array<{ type: string }> }
      summary.content_blocks = m.content?.map((b) => b.type) ?? []
    }
    console.log('SDK msg:', JSON.stringify(summary))

    // 同时打印 kernel 翻译结果
    for (const event of translateSdkMessage(msg)) {
      console.log('  → kernel event:', JSON.stringify({ type: event.type }))
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
