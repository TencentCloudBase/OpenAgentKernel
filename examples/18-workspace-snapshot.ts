/**
 * Example 18: workspace snapshot(单进程演示)
 *
 * 验证目标:让 model 在 sandbox cwd 写文件,session.send 结束自动 snapshot 到 COS;
 *          重新 startSession 时自动 restore,model 能读到上次写的内容。
 *
 * 注意 — 单进程 reuse 限制:
 *   AgsStatefulSandbox 在同 envId + scope=shared 下,第二轮 startSession 会
 *   reuse 同一物理 AGS 容器(ensureSharedInstance 检查 RUNNING 实例就直接复用)。
 *   也就是说 hello.txt 在第二轮**物理上还在**容器 /home/user 里,
 *   "模型读到内容"只能证明 send-end snapshot 没破坏 workspace,
 *   **不能**证明 COS restore 链路。要验真 restore 请跑 example 19(跨进程)。
 *
 * Run:
 *   OAK_DEBUG=1 pnpm dlx tsx packages/open-agent-kernel/examples/18-workspace-snapshot.ts
 */

import { createAgent, type AcpSessionUpdate } from '@cloudbase/open-agent-kernel'

import { appendAcpAssistantText, fmtAcpUpdate } from './_shared/acp.js'
import { getPlatformCredentials, loadEnv } from './_shared/env.js'

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

/**
 * 把 ACP update 简短打印 — 展示 update 全貌而不只 agent_message_chunk。
 */
function fmtEvent(ev: AcpSessionUpdate): string {
  return fmtAcpUpdate(ev)
}

async function runOne(label: string, userId: string, prompt: string, opts: { manualSnapshotAfter?: boolean } = {}) {
  console.log(`\n══════ ${label} ══════`)
  const credentials = getPlatformCredentials()
  const agent = createAgent({
    envId: credentials.envId,
    credentials,
    model: buildModel(),
    systemPrompt: 'You are a coding assistant with shell + filesystem tools. 请用工具完成任务,不要编造。',
    sandbox: {
      enabled: true,
    },
  })

  const t0 = Date.now()
  const session = await agent.startSession({ userId })
  const restoreStatus = (await session.getRestoreStatus?.()) ?? null
  console.log(`[${label}] startSession ms=${Date.now() - t0}  restoreStatus=${restoreStatus}`)
  console.log(`[${label}] >> prompt: ${prompt}`)

  const tSend = Date.now()
  let eventCount = 0
  const assistantText = { text: '' }
  for await (const event of session.send(prompt)) {
    eventCount += 1
    console.log(`[${label}][evt#${eventCount}] ${fmtEvent(event)}`)
    appendAcpAssistantText(event, assistantText)
  }
  console.log(
    `[${label}] send-end ms=${Date.now() - tSend}  events=${eventCount}  finalText=${JSON.stringify(assistantText.text.slice(0, 300))}`,
  )

  if (opts.manualSnapshotAfter && session.snapshotWorkspace) {
    try {
      const t = Date.now()
      const r = await session.snapshotWorkspace()
      console.log(`[${label}] manual snapshot OK ms=${Date.now() - t}  result=${JSON.stringify(r)}`)
    } catch (err) {
      console.warn(`[${label}] manual snapshot failed: ${(err as Error).message}`)
    }
  }

  console.log(`[${label}] aborting...`)
  await session.abort()
}

async function main() {
  loadEnv()
  const userId = `ws-demo-${Date.now()}`

  // 第一轮:让模型用 Write 工具创建 hello.txt
  await runOne(
    'round-1 (write)',
    userId,
    '请使用 Write 工具在工作区根目录(也就是当前 cwd /home/user)创建一个名为 hello.txt 的文件,文件内容是字符串 OAK Spec B works!,然后用 ls -la 查看确认。完成后简短报告。',
    { manualSnapshotAfter: true },
  )

  console.log('\n[main] sleeping 3s 让 sandbox 端 periodic sync / cosfs flush 充分进行...')
  await new Promise((r) => setTimeout(r, 3_000))

  // 第二轮:同 userId,新 startSession;**期望** restoreStatus 仍是 null —
  // 因为 OAK shared scope 在单进程内 reuse 同一 AGS instance,workspace
  // 物理上还在,根本没经历 restore。这一轮真正验证的是:
  //   - send-end snapshot 没破坏 workspace
  //   - 模型 cat 能读到第一轮写入的内容
  await runOne('round-2 (read)', userId, '请使用 Read 工具(或 cat)读取工作区根目录的 hello.txt,把内容原样告诉我。')

  console.log('\n[main] DONE.')
  console.log('[main] 想验证真正的 COS restore 跨进程闭环,请运行 example 19(它会模拟"换节点").')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
