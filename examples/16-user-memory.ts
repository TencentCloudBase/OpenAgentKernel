/**
 * Example 16: userMemory(用户级长期记忆 — auto-memory 验证)
 *
 * 演示:
 *   1. 启用 userMemory.enabled = true
 *   2. 第一段对话:植入"项目工程上下文事实"(auto-memory 保存的设计目标类型)
 *      Claude 自动判断这些值得 remember,写入 ~/.claude/projects/<cwd-hash>/memory/MEMORY.md
 *   3. session abort 时 OAK 同步引擎把 MEMORY.md 推送到 COS
 *   4. 创建第二个 conversation(同 userId)→ pull 把 MEMORY.md 拉回本地 →
 *      SDK 在新会话启动时把 MEMORY.md 注入 prompt → 模型记得这些事实
 *
 * 关键(参考 https://code.claude.com/docs/en/memory#auto-memory):
 *   - auto-memory 是 Claude **自动判断**值不值得记的(不是用户敲 /memory 触发)
 *   - 设计目标类型:**build commands / debugging insights / architecture / code style /
 *     workflow habits**(都是工程上下文)
 *   - "我的猫叫咪咪" 这类用户私人事实 **不会触发 auto-memory** — 因为 Claude 评估
 *     "对未来 coding 任务有用吗?" → 几乎没用 → 不写
 *   - 触发 auto-memory 需要工程相关的事实陈述 + 强信号("记住这个,后续都按这个工作")
 *
 * 运行前提:
 *   - .env.local 配置 TCB_ENV_ID + TCB_SECRET_ID + TCB_SECRET_KEY + TENCENTCLOUD_TOKENHUB_API_KEY
 *   - 该 envId 对应的 CloudBase 已开通 COS
 *
 * Run:
 *   OAK_DEBUG=1 pnpm dlx tsx packages/open-agent-kernel/examples/16-user-memory.ts
 *
 * 验证 SDK 是否真的写了 MEMORY.md(看 OAK_DEBUG 输出):
 *   - push scan 阶段如果出现:
 *       found: projects/<cwd-hash>/memory/MEMORY.md
 *     → SDK auto-memory 工作了 + 同步引擎扫到了
 *   - 如果只看到 .claude.json / backups → SDK 没触发 auto-memory(可能 model 不支持)
 */

import { loadEnv } from './_shared/env.js'

import { createAgent } from '@cloudbase/open-agent-kernel'

async function runConversation(prompt: string, userId: string) {
  // 模型配置:支持环境变量自带 key + endpoint(测试方便),不传则走 CloudBase 网关默认。
  // ⚠️ 不要在源码里硬编码 apiKey;.env.local 不该提交到 git。
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
    envId: process.env.TCB_ENV_ID!,
    model,
    systemPrompt:
      'You are a coding assistant. ' +
      'When the user shares project conventions (build commands, test commands, ' +
      'architecture decisions, code style, workflow habits), record them as memory ' +
      'so you can apply them in future sessions. ' +
      'Acknowledge what you have remembered.',
    userMemory: { enabled: true },
  })

  const session = await agent.startSession({ userId })
  console.log(`\n[example] conversation start (user=${userId})`)
  console.log(`[example] user: ${prompt}`)
  process.stdout.write('[example] assistant: ')
  for await (const event of session.send(prompt)) {
    if (event.type === 'message_delta') process.stdout.write(event.text)
  }
  console.log('\n[example] aborting session (triggers final push)...')
  await session.abort()
}

async function main() {
  loadEnv()
  const userId = `demo-user-${Date.now()}`

  // ── 第一段对话:植入"项目工程上下文事实" ─────────────────────────
  // 这些是 auto-memory 设计文档(https://code.claude.com/docs/en/memory#auto-memory)
  // 明确列出的"值得保存"的内容类型:build commands / test commands / architecture /
  // code style / workflow habits — Claude 评估这类信息对未来 coding 任务有用 → 写 MEMORY.md。
  await runConversation(
    [
      '请记住这个项目的关键约定,后续我都按这个工作:',
      '',
      '- 项目代号:Aurora',
      '- 部署区域:ap-shanghai',
      '- 构建命令:`pnpm build:dev`(开发模式),不要用 npm',
      '- 测试命令:`pnpm test`',
      '- 入口文件:`src/index.ts`',
      '- API handlers 必须放在 `src/api/handlers/` 目录',
      '- 所有 API 入参必须用 zod 做 validation',
      '- 代码风格:2 空格缩进,单引号',
      '',
      '这些是项目规范,以后跟我对话时请基于这些约定回答。',
    ].join('\n'),
    userId,
  )

  // 等 2 秒确保 COS 同步完成(send-end push 是 async)
  await new Promise((r) => setTimeout(r, 2000))

  // ── 第二段对话:测试 SDK 是否在新会话注入 MEMORY.md ──────────────
  // 跨 conversation 同 userId,OAK 同步引擎应该 pull 把 MEMORY.md 拉回本地,
  // SDK 启动时自动加载到 prompt(参考 auto-memory 文档:"loaded into every session")。
  await runConversation(
    '请告诉我这个项目的:1) 构建命令 2) 测试命令 3) API handlers 放在哪个目录 4) 入参 validation 用什么库?',
    userId,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
