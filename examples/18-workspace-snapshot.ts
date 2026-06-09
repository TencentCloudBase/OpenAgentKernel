/**
 * Example 18: workspace snapshot(单进程演示)
 *
 * 验证目标:让 model 在 sandbox cwd 写文件,session.send 结束自动 snapshot 到 COS;
 *          重新 startSession 时自动 restore,model 能读到上次写的内容。
 *
 * 流程:
 *   1. 第一轮 createAgent → startSession(同 userId)→ 让模型写 hello.txt
 *      → send 结束触发 send-end snapshot(via WorkspaceSnapshotEngine.snapshot)
 *      → abort 释放 sandbox
 *   2. 第二轮 createAgent → startSession(同 userId)→ bootstrap 期间从 COS restore
 *      → 模型 cat hello.txt 读到上一轮写入的内容
 *
 * 运行前提:
 *   - .env.local 配置 TCB_ENV_ID + TCB_SECRET_ID + TCB_SECRET_KEY
 *   - envId 对应的 CloudBase 已开通 AGS sandbox tool(workspace snapshot 依赖
 *     sandbox runtime /api/workspace/init + /api/workspace/snapshot)
 *
 * Run:
 *   OAK_DEBUG=1 pnpm dlx tsx packages/open-agent-kernel/examples/18-workspace-snapshot.ts
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

async function runOne(userId: string, prompt: string) {
  const agent = createAgent({
    envId: process.env.TCB_ENV_ID!,
    model: buildModel(),
    systemPrompt: 'You are a coding assistant with shell + filesystem tools. 请用工具完成任务,不要编造。',
    sandbox: {
      runtime: new AgsStatefulSandbox(),
      // workspaceSnapshot 要求 scope=shared(spec B §1.3);'session' 会让 OAK 拒绝启用。
      scope: 'shared',
      // workspaceSnapshot 默认 'auto' — ags-stateful runtime 自动启用,这里不必显式传。
    },
  })

  const session = await agent.startSession({ userId })
  const restoreStatus = (await session.getRestoreStatus?.()) ?? null
  console.log(`\n[user=${userId}] restoreStatus=${restoreStatus}`)
  console.log(`[user=${userId}] sending: ${prompt}`)
  process.stdout.write(`[user=${userId}] assistant: `)
  for await (const event of session.send(prompt)) {
    if (event.type === 'message_delta') process.stdout.write(event.text)
    // workspace snapshot 失败以 'error' 事件 + name='WorkspaceSnapshotFailedWarning' 透出
    // (见 src/public/create-agent.ts send-end snapshot 分支),非致命,只 log 不抛。
    if (event.type === 'error' && event.error?.name === 'WorkspaceSnapshotFailedWarning') {
      console.warn(`\n[warning] workspace snapshot failed: ${event.error.message}`)
    }
  }
  console.log(`\n[user=${userId}] aborting (final snapshot 已在 send finally 完成)...`)
  await session.abort()
}

async function main() {
  loadEnv()
  const userId = `ws-demo-${Date.now()}`

  // 第一轮:写文件 → send 结束 → 自动 snapshot
  await runOne(userId, '请在工作区根目录创建一个 hello.txt,内容是 "OAK Spec B works!"。完成后用 ls 确认。')

  // 等几秒让 sandbox 端 periodic sync 也跑一轮(非必须,只为更稳)
  await new Promise((r) => setTimeout(r, 3_000))

  // 第二轮:全新 startSession → bootstrap restore → 读上一轮的 hello.txt
  await runOne(userId, '请用 cat 读取工作区根目录的 hello.txt,把内容原样告诉我。')

  // 第二轮模型应该输出 "OAK Spec B works!" — 证明 workspace snapshot restore 链路通了。
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
