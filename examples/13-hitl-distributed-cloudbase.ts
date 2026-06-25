/**
 * Example 13: PR #7.1 —— HITL 分布式审批（CloudBasePermissionStore + CloudBase DB）
 *
 * 演示：
 *   - 节点 A（agentA）发起 send → hook 命中 requireApproval → 写 pending entry 到 CloudBase DB → 流终止
 *   - 节点 B（agentB）拿到 toolUseId → respondApproval 写 decision 到同一行 → resume → 工具放行
 *   - agentA 和 agentB 是两个独立的 createAgent 实例，模拟"分布式部署 / 跨节点 / 跨进程"
 *   - 传入 credentials 后，createAgent 默认启用 CloudBase FlexDB session store 和 permission store
 *
 * 与 Example 11 的关键区别：
 *   - Example 11：单进程内 InMemoryPermissionStore（审批状态在内存）
 *   - Example 13：跨实例 CloudBasePermissionStore（审批状态跨进程持久化）
 *
 * 配置：
 *   - examples/config.local.json
 *   - examples/config.local.json: envId / model / credentials
 *
 * 运行：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/13-hitl-distributed-cloudbase.ts
 *
 * 验证 DB：
 *   在 CloudBase 控制台 → 数据库 → 看 oak_state 集合（pending / decided 都会落到这里）
 */
import { captureToolConfirm, printAcpUpdate, type PendingToolConfirm } from './_shared/acp.js'
import { getEnvId, getModel, getPlatformCredentials } from './_shared/env.js'

import { createAgent } from '@cloudbase/open-agent-kernel'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

const dangerousTools = createSdkMcpServer({
  name: 'fs',
  version: '1.0.0',
  tools: [
    tool(
      'deleteFile',
      'Simulate deleting a file from the filesystem. Call this tool when the user asks to delete a file; the platform permission hook handles approval.',
      { path: z.string().describe('Absolute path to the file to delete') },
      async (args) => ({
        content: [{ type: 'text', text: `Deleted ${args.path} (simulated, nothing actually deleted).` }],
      }),
    ),
  ],
})

async function main(): Promise<void> {
  const envId = getEnvId()
  const credentials = getPlatformCredentials()

  // ─── 节点 A：发起 send，触发审批 ──────────────────────────────────
  console.log('=== 节点 A：startSession + send，触发审批 ===\n')
  const agentA = createAgent({
    envId,
    credentials,
    model: getModel(),
    systemPrompt:
      'You are a helpful assistant with one tool: ' +
      'mcp__fs__deleteFile. ' +
      'When the user asks to delete files, call deleteFile directly. ' +
      'Do not ask the user for confirmation yourself; the platform permission hook will pause the tool call for approval. ' +
      'Reply concisely in Chinese.',
    mcpServers: { fs: dangerousTools },
    permissions: {
      requireApproval: 'mcp__fs__deleteFile',
      // 有 credentials 时默认使用 CloudBase FlexDB 分布式 permission store。
    },
  })

  const sessionA = await agentA.startSession({ userId: 'u1' })
  const conversationId = sessionA.id
  console.log(`[node-A] conversation=${conversationId}\n`)

  const prompt =
    '请直接调用 mcp__fs__deleteFile 工具删除 /tmp/old.log 这个文件。' + '不要提前征求我的同意，直接调用工具就好。'
  console.log(`User: ${prompt}\n`)
  process.stdout.write('Assistant: ')

  let pendingApproval: PendingToolConfirm | undefined

  for await (const e of sessionA.send(prompt)) {
    printAcpUpdate(e)
    const captured = captureToolConfirm(e)
    if (captured) {
      console.log('\n\n⏸  审批请求（已写入 CloudBase DB）：')
      console.log(`   工具: ${captured.toolName}`)
      console.log(`   参数: ${JSON.stringify(captured.input)}`)
      console.log(`   toolUseId: ${captured.toolUseId}`)
      pendingApproval = captured
    } else if (e.sessionUpdate === 'agent_phase' && e.phase === 'idle') {
      console.log('\n[agent_phase: idle]')
    }
  }

  if (!pendingApproval) {
    console.log('\n（没有触发审批，example 演示提前结束）')
    return
  }

  // ─── 节点 B：另一个 agent 实例，使用同一 envId 的默认 CloudBase store，注入决策并 resume ──────
  console.log('\n=== 节点 B：另一个 agent 实例 resume + respondApproval ===\n')
  const agentB = createAgent({
    envId,
    credentials,
    model: getModel(),
    systemPrompt:
      'You are a helpful assistant with one tool: ' +
      'mcp__fs__deleteFile. ' +
      'When the user asks to delete files, call deleteFile directly. ' +
      'Do not ask the user for confirmation yourself; the platform permission hook will pause the tool call for approval. ' +
      'Reply concisely in Chinese.',
    mcpServers: { fs: dangerousTools },
    permissions: {
      requireApproval: 'mcp__fs__deleteFile',
      // 默认共享同一 envId/projectKey 下的审批状态
    },
  })

  // 用 conversationId 在节点 B resume 出同一会话
  const sessionB = await agentB.resumeSession(conversationId)
  console.log(`[node-B] resumed conversation=${sessionB.id}\n`)

  console.log('=== 节点 B：respondApproval(allow) 注入决策 ===\n')
  process.stdout.write('Assistant: ')

  for await (const e of sessionB.respondApproval({
    toolUseId: pendingApproval.toolUseId,
    decision: { kind: 'allow', scope: 'once' },
  })) {
    printAcpUpdate(e)
    const captured = captureToolConfirm(e)
    if (captured) {
      console.log('\n\n⏸  又一个审批请求（demo 自动 allow）：', captured.toolName)
      for await (const e2 of sessionB.respondApproval({
        toolUseId: captured.toolUseId,
        decision: { kind: 'allow', scope: 'once' },
      })) {
        printAcpUpdate(e2)
        if (e2.sessionUpdate === 'agent_phase' && e2.phase === 'idle') {
          console.log('\n[agent_phase: idle]')
        }
      }
    } else if (e.sessionUpdate === 'agent_phase' && e.phase === 'idle') {
      console.log('\n[agent_phase: idle]')
    }
  }

  console.log('\n--- Done ---')
  console.log(
    `→ 在 CloudBase 控制台 oak_state 集合按 conversationId="${conversationId}" 过滤，` +
      `可看到本次审批 entry 的全生命周期（pending → decided）。`,
  )
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
