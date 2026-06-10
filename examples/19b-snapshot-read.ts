/**
 * Example 19b: workspace snapshot 跨进程验证 — 第二步(读)
 *
 * 配合 19a。前置:必须先跑 19a + 手动 tcb sandbox instance stop <id>。
 *
 * 验证目标:全新 OAK 进程下 startSession,bootstrap 阶段触发 COS restore,
 *          模型 cat 出 19a 写入的内容。
 *
 * 运行:OAK_DEBUG=1 pnpm dlx tsx packages/open-agent-kernel/examples/19b-snapshot-read.ts
 *
 * 通过条件:
 *   ✓ 日志含 instance_start(不是 instance_reuse)
 *   ✓ restoreStatus='full' 或 'partial'(不是 null/fresh)
 *   ✓ 模型读出的内容 == 19a 写入的 stamp
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { AgsStatefulSandbox, createAgent } from '@cloudbase/open-agent-kernel'

import { loadEnv } from './_shared/env.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HANDOFF_FILE = path.join(__dirname, '.last-userid')

function buildModel() {
  const customModelId = process.env.OAK_EXAMPLE_MODEL_ID
  const customApiKey = process.env.OAK_EXAMPLE_MODEL_API_KEY
  const customApiBaseUrl = process.env.OAK_EXAMPLE_MODEL_API_BASE_URL
  return customApiKey
    ? {
        id: customModelId ?? 'claude-opus-4-8',
        apiKey: customApiKey,
        ...(customApiBaseUrl ? { apiBaseUrl: customApiBaseUrl } : {}),
      }
    : (customModelId ?? 'claude-opus-4-8')
}

interface Handoff {
  userId: string
  stamp: string
}

function readHandoff(): Handoff {
  if (!fs.existsSync(HANDOFF_FILE)) {
    console.error(`[19b] 找不到 ${HANDOFF_FILE} —— 请先跑 19a-snapshot-write.ts`)
    process.exit(1)
  }
  const raw = fs.readFileSync(HANDOFF_FILE, 'utf-8')
  const parsed = JSON.parse(raw) as Handoff
  if (!parsed.userId || !parsed.stamp) {
    console.error(`[19b] ${HANDOFF_FILE} 内容不完整: ${raw}`)
    process.exit(1)
  }
  return parsed
}

async function main() {
  loadEnv()
  const { userId, stamp: expectedStamp } = readHandoff()

  console.log('\n══════ 19b — read phase ══════')
  console.log(`[19b] userId        = ${userId}  (来自 .last-userid)`)
  console.log(`[19b] expectedStamp = ${expectedStamp}`)
  console.log('[19b] 提醒:跑这步前必须已经手动 tcb sandbox instance stop <19a 那个 instanceId>')

  const agent = createAgent({
    envId: process.env.TCB_ENV_ID!,
    model: buildModel(),
    systemPrompt: 'You are a coding assistant with shell + filesystem tools. 用工具完成,不要编造。',
    sandbox: {
      runtime: new AgsStatefulSandbox(),
      scope: 'shared',
    },
  })

  const session = await agent.startSession({ userId })
  const restoreStatus = (await session.getRestoreStatus?.()) ?? null
  console.log(`\n[19b] >>> KEY SIGNAL <<<  restoreStatus=${restoreStatus}`)
  if (restoreStatus === 'full' || restoreStatus === 'partial') {
    console.log(`[19b]   ✅ restore 链路通了 — 期望模型也能读到 stamp`)
  } else if (restoreStatus === 'fresh') {
    console.warn(`[19b]   ⚠️  restoreStatus=fresh — 可能 19a 的 send-end snapshot 没真写到 COS,或 19a 这次写的是新 SubPath`)
  } else if (restoreStatus === 'failed') {
    console.error(`[19b]   ❌ restoreStatus=failed — restoreFromCos 阶段出错,看 sandbox 端日志`)
  } else {
    console.warn(`[19b]   ⚠️  restoreStatus=${restoreStatus} — 期望 'full'。如果你看到日志里 instance_reuse 而非 instance_start,说明上一步 stop 没成功`)
  }

  const prompt =
    '请用 cat 命令读取 /home/user/.last-update.txt,把里面的内容(单行 ISO 时间戳)原样复述给我,不要添加任何说明。'
  console.log(`\n[19b] prompt: ${prompt}`)

  let assistantText = ''
  let toolCalls = 0
  for await (const ev of session.send(prompt)) {
    if (ev.type === 'message_delta') {
      process.stdout.write(ev.text)
      assistantText += ev.text
    }
    if (ev.type === 'message_complete') assistantText = ev.text
    if (ev.type === 'tool_call') {
      toolCalls += 1
      console.log(`\n[19b][tool#${toolCalls}] → ${ev.toolName}`)
    }
    if (ev.type === 'tool_result') {
      const out = JSON.stringify(ev.output)
      console.log(`[19b][tool#${toolCalls}] ← isError=${ev.isError} ${out.slice(0, 300)}${out.length > 300 ? '…' : ''}`)
    }
    if (ev.type === 'error') {
      console.warn(`\n[19b][error] ${(ev.error as { name?: string }).name}: ${(ev.error as { message?: string }).message}`)
    }
  }

  console.log('\n\n──── 验收 ────')
  const matched = assistantText.includes(expectedStamp)
  console.log(`[19b] expected stamp 是否出现在模型回答里: ${matched ? '✅ 是' : '❌ 否'}`)
  console.log(`[19b] expected: ${expectedStamp}`)
  console.log(`[19b] got     : ${JSON.stringify(assistantText.slice(0, 200))}`)

  await session.abort()

  if (matched && (restoreStatus === 'full' || restoreStatus === 'partial')) {
    console.log('\n[19b] 🎉 跨进程 COS restore 闭环已验证。Spec B 全绿。')
  } else {
    console.log('\n[19b] ⚠️  尚未完全验证。请检查上方日志确定哪一环出问题。')
    process.exit(2)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
