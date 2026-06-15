/**
 * Example 16: userMemory 文件同步验证(单进程)
 *
 * 验证目标:OAK 同步引擎能把 COS 上预置的 .claude/ 配置(CLAUDE.md 等)在 SDK
 *          启动时 pull 到本地,SDK 读取后注入 prompt,模型据此回答。
 *
 * 不依赖 SDK auto-memory 机制(已验证在 SDK query() 模式下不工作 — 见 v0.2.0
 * 调试结论)。本 example 只验证"COS ↔ 本地 .claude/"双向同步链路。
 *
 * 流程:
 *   1. 用 seedClaudeHome() 预先把 CLAUDE.md 写到 COS(模拟"用户之前累积的偏好")
 *   2. createAgent({ userMemory: true }) → SDK 启动时 OAK pull,
 *      把 CLAUDE.md 落到 <CLAUDE_CONFIG_DIR>/CLAUDE.md
 *   3. SDK 把 CLAUDE.md 当作用户级偏好注入 prompt(SDK 文档:"CLAUDE.md files
 *      are loaded into the context window at the start of every session")
 *   4. 模型根据 CLAUDE.md 内容回答问题 → 验证同步真的把内容带进了 prompt
 *
 * 运行前提:
 *   - examples/config.local.json
 *   - examples/config.local.json: envId / credentials
 *   - envId 对应的 CloudBase 已开通 COS
 *
 * Run:
 *   OAK_DEBUG=1 pnpm dlx tsx packages/open-agent-kernel/examples/16-user-memory.ts
 */

import { createAgent } from '@cloudbase/open-agent-kernel'

import { getEnvId, getPlatformCredentials, loadEnv } from './_shared/env.js'
import { clearSeededClaudeHome, seedClaudeHome } from './_shared/seed-claude-home.js'

// 预置到 COS 的 CLAUDE.md 内容 — 含可被验证的具体事实
const SEEDED_CLAUDE_MD = `# 项目偏好(预置)

这是用户已累积的工程上下文,SDK 启动时应自动加载到 prompt:

- 项目代号:**Aurora**
- 部署区域:**ap-shanghai**
- 构建命令:\`pnpm build:dev\`(开发模式),不要用 npm
- 测试命令:\`pnpm test\`
- 入口文件:\`src/index.ts\`
- API handlers 必须放在 \`src/api/handlers/\` 目录
- 所有 API 入参必须用 zod 做 validation
- 代码风格:2 空格缩进,单引号
`

async function runConversation(prompt: string, userId: string) {
  const envId = getEnvId()
  const credentials = getPlatformCredentials()
  // 模型配置:支持环境变量自带 key + endpoint(测试方便),不传则走 CloudBase 网关默认。
  // ⚠️ 不要在源码里硬编码 apiKey；凭证应写在 config.local.json，不要提交到 git。
  const customModelId = process.env.OAK_EXAMPLE_MODEL_ID
  const customApiKey = process.env.OAK_EXAMPLE_MODEL_API_KEY
  const customApiBaseUrl = process.env.OAK_EXAMPLE_MODEL_API_BASE_URL
  const model = customApiKey
    ? {
        id: customModelId ?? 'claude-opus-4-8',
        apiKey: customApiKey,
        ...(customApiBaseUrl ? { apiBaseUrl: customApiBaseUrl } : {}),
      }
    : (customModelId ?? 'glm-5.1')

  const agent = createAgent({
    envId,
    credentials,
    model,
    systemPrompt: 'You are a coding assistant. Answer based on the project conventions you can see.',
    userMemory: true,
  })

  const session = await agent.startSession({ userId })
  console.log(`\n[example] conversation start (user=${userId})`)
  console.log(`[example] user: ${prompt}`)
  process.stdout.write('[example] assistant: ')
  for await (const event of session.send(prompt)) {
    if (event.type === 'message_delta') process.stdout.write(event.text)
  }
  console.log('\n[example] aborting session...')
  await session.abort()
}

async function main() {
  loadEnv()
  const envId = getEnvId()
  const credentials = getPlatformCredentials()
  const userId = `demo-user-${Date.now()}`

  // ── Step 1:预置 CLAUDE.md 到 COS ────────────────────────────────
  console.log('[example] Step 1: seeding CLAUDE.md to COS...')
  await seedClaudeHome({
    envId,
    userId,
    credentials,
    files: [{ relPath: 'CLAUDE.md', content: SEEDED_CLAUDE_MD }],
  })

  try {
    // ── Step 2:创建 agent — SDK 启动时 OAK pull,SDK 加载 CLAUDE.md 入 prompt ──
    // 验证问题需要 CLAUDE.md 中的内容才能回答
    await runConversation(
      '请告诉我这个项目的:1) 构建命令 2) 测试命令 3) API handlers 放在哪个目录 4) 入参 validation 用什么库?',
      userId,
    )

    // 模型应该说出 pnpm build:dev / pnpm test / src/api/handlers/ / zod。
    // 如果说"没有相关信息" → 同步链路有问题,看 OAK_DEBUG 日志:
    //   - pull complete 应显示 baseline 含 CLAUDE.md
    //   - 本地 CLAUDE.md 应在 found 列表里
  } finally {
    // ── Step 3:清理 COS,避免污染下次运行 ─────────────────────────
    console.log('\n[example] Step 3: cleaning up seeded files from COS...')
    await clearSeededClaudeHome({ envId, userId, credentials, relPaths: ['CLAUDE.md'] })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
