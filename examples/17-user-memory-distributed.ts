/**
 * Example 17: userMemory 跨节点文件同步验证(串行)
 *
 * 验证目标:同 userId 的两个独立 OAK 实例(模拟跨节点)共享 .claude/ 配置。
 *          通过 COS 中转 → Node A 启动 pull → SDK 加载 CLAUDE.md →
 *          Node B 启动也 pull 到同一份 → 两边模型回答一致。
 *
 * 不依赖 SDK auto-memory(已验证在 SDK query() 模式不工作 — 见 v0.2.0 调试结论)。
 *
 * 流程:
 *   1. seedClaudeHome → 把 CLAUDE.md 预置到 COS(模拟"用户之前的累积")
 *   2. Node A:全新 OAK 实例 → startSession → pull → SDK 加载 CLAUDE.md →
 *      模型回答 → abort 触发 push
 *   3. 等 1.5s 模拟节点切换(spec §5.3:同 user 必须串行)
 *   4. Node B:独立的 OAK 实例(完全独立的 sync engine)→ 同样 pull → 同样回答
 *   5. 清理 COS
 *
 * 注意:严格串行,Node A abort 完才启 Node B。spec §5.3 明确"业务方需保证
 *      同 user 请求串行"。
 *
 * Run:
 *   OAK_DEBUG=1 pnpm dlx tsx packages/open-agent-kernel/examples/17-user-memory-distributed.ts
 */

import { createAgent } from '@cloudbase/open-agent-kernel'

import { loadEnv } from './_shared/env.js'
import { clearSeededClaudeHome, seedClaudeHome } from './_shared/seed-claude-home.js'

const SEEDED_CLAUDE_MD = `# 项目偏好(预置)

- 项目代号:**Aurora**
- 部署区域:**ap-shanghai**
- 构建命令:\`pnpm build:dev\`
`

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
    : (customModelId ?? 'glm-5.1')
}

async function runOnNode(nodeName: string, userId: string, prompt: string) {
  console.log(`\n--- ${nodeName} ---`)
  const agent = createAgent({
    envId: process.env.TCB_ENV_ID!,
    model: buildModel(),
    systemPrompt: 'You are a coding assistant. Answer based on the project conventions you can see.',
    userMemory: { enabled: true },
  })
  const session = await agent.startSession({ userId })
  console.log(`[${nodeName}] user: ${prompt}`)
  process.stdout.write(`[${nodeName}] assistant: `)
  for await (const event of session.send(prompt)) {
    if (event.type === 'message_delta') process.stdout.write(event.text)
  }
  console.log(`\n[${nodeName}] aborting (final push)...`)
  await session.abort()
}

async function main() {
  loadEnv()
  const envId = process.env.TCB_ENV_ID!
  const userId = `dist-demo-${Date.now()}`

  // ── Step 1:预置 CLAUDE.md 到 COS ────────────────────────────────
  console.log('[example] Step 1: seeding CLAUDE.md to COS...')
  await seedClaudeHome({
    envId,
    userId,
    files: [{ relPath: 'CLAUDE.md', content: SEEDED_CLAUDE_MD }],
  })

  try {
    // ── Step 2:Node A 启动 — pull → SDK 加载 CLAUDE.md → 模型回答 ──
    await runOnNode('Node A', userId, '我的项目代号是什么?部署在哪个区域?')

    // ── Step 3:模拟节点间间隔(同 user 必须串行,spec §5.3)───────
    await new Promise((r) => setTimeout(r, 1500))

    // ── Step 4:Node B 全新实例 — 应 pull 到同样的 CLAUDE.md ───────
    // (Node B 是另一个 createAgent 调用,完全独立的 sync engine 实例)
    await runOnNode('Node B (新的 OAK 实例,模拟跨节点)', userId, '我的项目代号是什么?构建命令是什么?')

    // 两个 node 应给出一致回答(都基于同一份 CLAUDE.md)。
  } finally {
    // ── Step 5:清理 COS ────────────────────────────────────────
    console.log('\n[example] Step 5: cleaning up seeded files from COS...')
    await clearSeededClaudeHome({ envId, userId, relPaths: ['CLAUDE.md'] })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
