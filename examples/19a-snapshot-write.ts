/**
 * Example 19a: workspace snapshot 跨进程验证 — 第一步(写)
 *
 * ⚠️ 必须配合 19b 一起跑,中间需要你手动 tcb sandbox instance stop。
 *
 * 为什么?
 *   AgsStatefulSandbox.acquire() 在 scope='shared' 下走 ensureSharedInstance,
 *   它通过 AGS DescribeSandboxInstanceList 看 toolId 下是否有 RUNNING 实例 —
 *   有就 reuse,跟 OAK 进程重启无关。`session.abort()` 在 shared 下是 no-op
 *   (ags-stateful-sandbox.ts:1058 inst.release: if (isShared) return)。
 *
 *   所以"启两个 OAK 进程串行跑"在 AGS 层仍是同一个容器,workspace 物理还在,
 *   读到内容只能证明 cosfs 持久化挂载,**不能证明 COS restore**。
 *
 * 真正验证 cross-node restore 闭环要走:
 *
 *   1. pnpm dlx tsx examples/19a-snapshot-write.ts
 *      → 写 /home/user/.last-update.txt + send-end snapshot 推 COS
 *      → 在日志里看到 "instance_start" 或 "instance_reuse: <ID>" — 记下 <ID>
 *      → userId 写到 .last-userid 文件,19b 自动读
 *
 *   2. 你手动:
 *      tcb sandbox instance stop <ID>
 *      tcb sandbox instance list   # 确认 STOPPED
 *
 *   3. pnpm dlx tsx examples/19b-snapshot-read.ts
 *      → 期望看到 instance_start(不是 reuse)
 *      → 期望 restoreStatus='full'(不是 null/fresh)
 *      → 期望模型读到 19a 写入的 stamp
 *
 * Run:
 *   OAK_DEBUG=1 pnpm dlx tsx packages/open-agent-kernel/examples/19a-snapshot-write.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAgent } from '@cloudbase/open-agent-kernel'

import { getPlatformCredentials, loadEnv } from './_shared/env.js'

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

async function main() {
  loadEnv()
  const credentials = getPlatformCredentials()
  const userId = `restore-probe-${Date.now()}`
  const stamp = new Date().toISOString()

  console.log('\n══════ 19a — write phase ══════')
  console.log(`[19a] userId = ${userId}`)
  console.log(`[19a] stamp  = ${stamp}`)

  const agent = createAgent({
    envId: credentials.envId,
    credentials,
    model: buildModel(),
    systemPrompt: 'You are a coding assistant with shell + filesystem tools. 用工具完成,不要编造。',
    sandbox: {
      enabled: true,
    },
  })

  const session = await agent.startSession({ userId })
  const restoreStatus = (await session.getRestoreStatus?.()) ?? null
  console.log(`[19a] startSession ok  restoreStatus=${restoreStatus} (期望 null,因为是新 userId 第一次)`)

  const prompt = `请用 Write 工具在 /home/user/.last-update.txt 写入下面这一行(完全照抄,不要加引号或额外字符):
${stamp}

完成后用 cat /home/user/.last-update.txt 验证内容,然后简短报告。`
  console.log(`[19a] prompt: ${prompt.split('\n')[0]}...`)

  let toolCalls = 0
  for await (const ev of session.send(prompt)) {
    if (ev.type === 'message_delta') process.stdout.write(ev.text)
    if (ev.type === 'tool_call') {
      toolCalls += 1
      console.log(`\n[19a][tool#${toolCalls}] → ${ev.toolName}`)
    }
    if (ev.type === 'tool_result') {
      const out = JSON.stringify(ev.output)
      console.log(`[19a][tool#${toolCalls}] ← isError=${ev.isError} ${out.slice(0, 200)}${out.length > 200 ? '…' : ''}`)
    }
    if (ev.type === 'error') {
      console.warn(
        `\n[19a][error] ${(ev.error as { name?: string; message?: string }).name}: ${(ev.error as { message?: string }).message}`,
      )
    }
  }
  console.log(`\n[19a] write phase done.`)
  console.log(
    `[19a] aborting (send-end snapshot 已在 send finally 内完成,下一行应已看到 [oak][workspace-snapshot] ms=N)...`,
  )
  await session.abort()

  // 持久化 userId + stamp 给 19b 校验
  fs.writeFileSync(HANDOFF_FILE, JSON.stringify({ userId, stamp }, null, 2) + '\n')
  console.log(`[19a] 已写入 ${HANDOFF_FILE} 给 19b 用`)

  console.log('\n──── 接下来你需要手动操作 ────')
  console.log('1. 在上方日志里找 "instance_start" / "instance_reuse: reusing shared sandbox instance <ID>",记下 <ID>')
  console.log('2. echo Y | tcb sandbox instance stop <ID>')
  console.log('3. 用 tcb sandbox instance list 确认 <ID> 已停(Status=STOPPED)')
  console.log('4. 然后跑: pnpm dlx tsx packages/open-agent-kernel/examples/19b-snapshot-read.ts')
  console.log('   (19b 会自动读 .last-userid,期望 instance_start + restoreStatus=full + 模型读到 stamp)')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
