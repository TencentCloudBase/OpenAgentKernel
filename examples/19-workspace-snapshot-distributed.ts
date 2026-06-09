/**
 * Example 19: workspace snapshot 跨节点演示(串行)
 *
 * 验证目标:同 userId 的两个独立 OAK 实例(模拟跨节点)通过 sandbox workspace
 *          snapshot 接续工作:
 *            - Node A:全新 createAgent → startSession → 模型在 sandbox 写文件
 *                     → send 结束触发 send-end snapshot 推到 COS → abort 释放 sandbox
 *            - Node B:全新 createAgent(完全独立的 sandbox runtime + snapshot
 *                     engine 实例)→ startSession 时 bootstrap 拉 restore →
 *                     模型 cat 出 Node A 写过的文件
 *
 * 关键前提:同 envId + 同 userId + sandbox.scope='shared'(spec B §1.3)。不同
 *          envId 或 scope='session' 都不会跨节点接续。
 *
 * 注意:严格串行,Node A abort 完才启 Node B(spec B §5.3:同 user 必须串行)。
 *
 * 运行前提:同 example 18(.env.local + AGS sandbox tool)。
 *
 * Run:
 *   OAK_DEBUG=1 pnpm dlx tsx packages/open-agent-kernel/examples/19-workspace-snapshot-distributed.ts
 */

import { AgsStatefulSandbox, createAgent } from '@cloudbase/open-agent-kernel'

import { loadEnv } from './_shared/env.js'

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

async function runOnNode(nodeName: string, userId: string, prompt: string) {
  console.log(`\n--- ${nodeName} ---`)
  // ⚠️ 每个 node 都是独立的 createAgent 调用 + 独立的 AgsStatefulSandbox 实例,
  //    模拟跨节点(不共享内存中的 snapshot engine state)。
  const agent = createAgent({
    envId: process.env.TCB_ENV_ID!,
    model: buildModel(),
    systemPrompt: 'You are a coding assistant with shell + filesystem tools. 请用工具完成任务,不要编造。',
    sandbox: {
      runtime: new AgsStatefulSandbox(),
      // workspaceSnapshot 要求 scope=shared(spec B §1.3)
      scope: 'shared',
    },
  })

  const session = await agent.startSession({ userId })
  const restoreStatus = (await session.getRestoreStatus?.()) ?? null
  console.log(`[${nodeName}] restoreStatus=${restoreStatus}`)
  console.log(`[${nodeName}] user: ${prompt}`)
  process.stdout.write(`[${nodeName}] assistant: `)
  for await (const event of session.send(prompt)) {
    if (event.type === 'message_delta') process.stdout.write(event.text)
    // workspace snapshot 失败以 'error' 事件 + name='WorkspaceSnapshotFailedWarning' 透出
    // (见 src/public/create-agent.ts send-end snapshot 分支),非致命。
    if (event.type === 'error' && event.error?.name === 'WorkspaceSnapshotFailedWarning') {
      console.warn(`\n[${nodeName}][warning] workspace snapshot failed: ${event.error.message}`)
    }
  }
  console.log(`\n[${nodeName}] aborting (final snapshot 已在 send finally 完成)...`)
  await session.abort()
}

async function main() {
  loadEnv()
  const userId = `ws-dist-${Date.now()}`
  const stamp = new Date().toISOString()

  // ── Node A:写文件 + 时间戳 → send 结束触发 snapshot ──────────────
  await runOnNode(
    'Node A',
    userId,
    `请在工作区根目录创建一个 .last-update.txt,内容是这一行:"${stamp}"。完成后用 ls 确认。`,
  )

  // ── 模拟节点切换间隔(同 user 必须串行,spec B §5.3)──────────────
  await new Promise((r) => setTimeout(r, 5_000))

  // ── Node B:独立 OAK 实例 → startSession bootstrap 拉 restore → 读文件 ──
  await runOnNode(
    'Node B (新的 OAK 实例,模拟跨节点)',
    userId,
    '请用 cat 读取工作区根目录的 .last-update.txt,把里面的时间戳原样告诉我。',
  )

  // Node B 应能读到 Node A 写入的 stamp,证明 workspace snapshot 跨节点接续链路通了。
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
