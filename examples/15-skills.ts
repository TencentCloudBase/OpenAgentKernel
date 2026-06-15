/**
 * Example 15: Skills(平台资产)
 *
 * 演示:
 *   1. 业务方在某固定目录下放 .claude/skills/<name>/SKILL.md(平台共享资产)
 *   2. createAgent 时传 cwd 指向该目录,启用 skills.enabled
 *   3. agent 启动后 SDK 通过 cwd/.claude/skills/ 发现 skill,把 frontmatter 注入 prompt
 *   4. 模型遇到匹配场景时,主动调 Skill 工具加载 SKILL.md 全文 → 按 SKILL.md 指令回应
 *
 * 关键:skills 不是 system prompt 直接注入,是 model-invoked tool。
 *       OAK 启用 skills 时会把 'Skill' 工具加到 allowedTools(spec §4.1)。
 *
 * 运行前提:
 *   - examples/config.local.json
 *   - examples/config.local.json: envId / model
 *
 * Run:
 *   pnpm dlx tsx packages/open-agent-kernel/examples/15-skills.ts
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEnvId, getModel, loadEnv } from './_shared/env.js'

import { createAgent } from '@cloudbase/open-agent-kernel'

async function main() {
  loadEnv()

  // 1. 准备一个临时 cwd,放一个 SKILL.md
  const cwd = join(tmpdir(), `oak-skills-demo-${Date.now()}`)
  console.log('[example] cwd:', cwd)
  const skillDir = join(cwd, '.claude', 'skills', 'greet')
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: greet',
      // description 决定模型何时调用 — 写得越具体越好。
      // 这里强引导:看到任何形式的问候请求,必须 invoke 这个 skill。
      'description: USE THIS SKILL whenever the user requests a greeting (e.g., "你好", "hello", "请问候我", "打个招呼"). This skill provides the project-specific greeting style and MUST be invoked for all greeting interactions.',
      '---',
      '',
      '# Project-Specific Greeting',
      '',
      '当用户请求问候时,**必须**使用以下风格回应:',
      '',
      '- 以 `咕咕你好` 开头(注意是"咕咕"开头,不是"你好")',
      '- 用温暖友好的中文继续后续内容',
      '',
      '示例:',
      '> 咕咕你好!很高兴见到你 ~',
    ].join('\n'),
    'utf8',
  )
  console.log(`[example] skill seeded at ${skillDir}`)

  // 2. createAgent 启用 skills
  //    OAK 内部会:① settingSources=['project'] 让 SDK 扫 cwd/.claude/skills/
  //              ② tools=['Skill'] 让模型能 invoke skill
  const agent = createAgent({
    envId: getEnvId(),
    model: getModel(),
    systemPrompt: 'You are a helpful assistant.',
    cwd,
    skills: { enabled: 'all' },
  })

  // 3. agent 启动 — 期望 SDK 自动加载 greet skill 的 frontmatter,
  //    模型看到匹配的"问候"请求 → 调 Skill('greet') → 加载 SKILL.md → 按指令回应
  const session = await agent.startSession({ userId: 'demo-user' })
  console.log('[example] session started, sending prompt...\n')
  let sawSkillInvocation = false
  for await (const event of session.send('请问候我')) {
    if (event.type === 'message_delta') process.stdout.write(event.text)
    if (event.type === 'tool_call' && event.toolName === 'Skill') {
      sawSkillInvocation = true
      console.log(`\n[example] ✓ Skill tool invoked with input:`, event.input)
    }
  }
  console.log('\n[example] done.')
  if (!sawSkillInvocation) {
    console.warn(
      '[example] ⚠️  Skill tool was NOT invoked by the model. ' +
        'Check (1) the SKILL.md description is specific enough, ' +
        '(2) cwd contains .claude/skills/<name>/SKILL.md, ' +
        '(3) model has tool_use capability.',
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
