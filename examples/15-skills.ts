/**
 * Example 15: Skills(平台资产)
 *
 * 演示:
 *   1. 业务方在某固定目录下放 .claude/skills/<name>/SKILL.md(平台共享资产)
 *   2. createAgent 时传 cwd 指向该目录,启用 skills.enabled
 *   3. agent 启动后该 skill 自动加载到 system prompt,可被 / 调用或被 LLM 选用
 *
 * 运行前提:
 *   - .env.local 配置 TCB_ENV_ID + TENCENTCLOUD_TOKENHUB_API_KEY
 *
 * Run:
 *   pnpm dlx tsx packages/open-agent-kernel/examples/15-skills.ts
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadEnv } from './_shared/env.js'

import { createAgent } from '@cloudbase/open-agent-kernel'

async function main() {
  loadEnv()

  // 1. 准备一个临时 cwd,放一个 SKILL.md
  const cwd = join(tmpdir(), `oak-skills-demo-${Date.now()}`)
  const skillDir = join(cwd, '.claude', 'skills', 'greet')
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: greet',
      'description: Greets the user warmly in Chinese.',
      '---',
      '',
      '当用户请求问候时,使用温暖友好的中文回应,以"你好"开头。',
    ].join('\n'),
    'utf8',
  )
  console.log(`[example] skill seeded at ${skillDir}`)

  // 2. createAgent 启用 skills
  const agent = createAgent({
    envId: process.env.TCB_ENV_ID!,
    model: 'glm-5.1',
    systemPrompt: 'You are a helpful assistant.',
    cwd,
    skills: { enabled: 'all' },
  })

  // 3. agent 启动 — 期望 SDK 自动加载 greet skill
  const session = await agent.startSession({ userId: 'demo-user' })
  console.log('[example] session started, sending prompt...\n')
  for await (const event of session.send('请问候我')) {
    if (event.type === 'message_delta') process.stdout.write(event.text)
  }
  console.log('\n[example] done.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
