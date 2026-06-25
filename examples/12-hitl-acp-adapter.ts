/**
 * Example 12: built-in ACP HITL flow
 *
 * 演示 OAK 内置 ACP 输出后的 HITL 事件：
 *   - session.send() 直接输出 ACP `tool_confirm`
 *   - 业务拿到用户决策后调用 session.respondApproval()
 *
 * 运行（本 example 不依赖真实 ACP 客户端，模拟一个"Always allow_once" 客户端）：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/12-hitl-acp-adapter.ts
 */
import { getEnvId, getModel } from './_shared/env.js'

import { CloudBaseSessionStore, createAgent, InMemoryDriver, type AcpSessionUpdate } from '@cloudbase/open-agent-kernel'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

// ─────────────────────────────────────────────────────────────────────
// 模拟一个 ACP 客户端协议形态（实际项目里来自 @zed-industries/agent-client-protocol）
// ─────────────────────────────────────────────────────────────────────

/**
 * ACP `session/request_permission` 请求体（精简版，对齐 ACP spec）。
 */
interface AcpPermissionRequest {
  toolCall: {
    toolCallId: string
    toolName: string
    args: unknown
  }
  options: Array<{
    optionId: string
    label: string
    /** 决策语义类别 */
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
  }>
}

/**
 * ACP 客户端的批准响应。
 */
interface AcpPermissionResponse {
  outcome: { kind: 'selected'; optionId: string } | { kind: 'cancelled' }
}

/**
 * 模拟的 ACP 客户端（实际是 WebSocket / JSON-RPC 双向连接）。
 * 这里直接 hardcode "总是 allow_once"。
 */
async function fakeAcpRequestPermission(req: AcpPermissionRequest): Promise<AcpPermissionResponse> {
  console.log(`\n[ACP server → client] session/request_permission`)
  console.log(`  toolCall.toolName: ${req.toolCall.toolName}`)
  console.log(`  toolCall.args:     ${JSON.stringify(req.toolCall.args)}`)
  console.log(`  options:           ${req.options.map((o) => o.optionId).join(', ')}`)
  console.log(`[ACP client → server] selected: allow_once  (模拟)`)
  await new Promise((r) => setTimeout(r, 50))
  return { outcome: { kind: 'selected', optionId: 'allow_once' } }
}

// ─────────────────────────────────────────────────────────────────────
// ACP HITL pump：消费 OAK 内置 ACP 更新，遇到 tool_confirm 后注入审批决策
// ─────────────────────────────────────────────────────────────────────

/**
 * 把一次 send / respondApproval 的 ACP 更新流跑完。
 */
async function pumpThroughAcp(
  events: AsyncIterable<AcpSessionUpdate>,
  session: { respondApproval: (opts: any) => AsyncIterable<AcpSessionUpdate> },
): Promise<void> {
  for await (const e of events) {
    if (e.sessionUpdate === 'agent_message_chunk') {
      process.stdout.write(e.content.text)
    } else if (e.sessionUpdate === 'tool_call') {
      process.stdout.write(`\n[kernel ACP] tool_call: ${e.title}\n`)
    } else if (e.sessionUpdate === 'tool_call_update') {
      const out = JSON.stringify(e.result ?? e.error ?? null).slice(0, 100)
      process.stdout.write(`\n[kernel ACP] tool_call_update: result=${out}\n`)
    } else if (e.sessionUpdate === 'tool_confirm') {
      const options: AcpPermissionRequest['options'] = [
        { optionId: 'allow_once', label: '本次允许', kind: 'allow_once' },
        { optionId: 'reject_once', label: '本次拒绝', kind: 'reject_once' },
        { optionId: 'allow_always', label: '本会话内总是允许', kind: 'allow_always' },
      ]
      const acpReq: AcpPermissionRequest = {
        toolCall: {
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          args: e.input,
        },
        options,
      }
      const acpResp = await fakeAcpRequestPermission(acpReq)

      // ── ACP 响应 → kernel 决策 ──
      if (acpResp.outcome.kind === 'cancelled') {
        // 客户端取消 → kernel 视为 deny+interrupt
        await pumpThroughAcp(
          session.respondApproval({
            toolUseId: e.toolCallId,
            decision: { kind: 'deny', reason: 'ACP client cancelled', interrupt: true },
          }),
          session,
        )
        return
      }
      const optionId = acpResp.outcome.optionId
      const decision =
        optionId === 'allow_once'
          ? ({ kind: 'allow', scope: 'once' } as const)
          : optionId === 'allow_always'
            ? ({ kind: 'allow', scope: 'session' } as const)
            : optionId === 'reject_once'
              ? ({ kind: 'deny', scope: 'once', reason: 'User rejected' } as const)
              : ({
                  kind: 'deny',
                  scope: 'session',
                  reason: 'User rejected (always)',
                } as const)

      // ── 注入决策并继续消费事件流（递归式抽干）──
      await pumpThroughAcp(session.respondApproval({ toolUseId: e.toolCallId, decision }), session)
      return
    } else if (e.sessionUpdate === 'agent_phase' && e.phase === 'idle') {
      process.stdout.write('\n[kernel ACP] idle\n')
    } else if (e.sessionUpdate === 'log') {
      process.stdout.write(`\n[kernel ACP] log: ${e.message}\n`)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// 一个被审批保护的工具
// ─────────────────────────────────────────────────────────────────────

const dangerousTools = createSdkMcpServer({
  name: 'fs',
  version: '1.0.0',
  tools: [
    tool('deleteFile', 'Delete a file (DANGEROUS).', { path: z.string() }, async (args) => ({
      content: [{ type: 'text', text: `Deleted ${args.path} (simulated).` }],
    })),
  ],
})

async function main(): Promise<void> {
  const agent = createAgent({
    envId: getEnvId(),
    model: getModel(),
    systemPrompt: 'You are a CLI assistant. When the user asks to delete a file, call mcp__fs__deleteFile directly.',
    mcpServers: { fs: dangerousTools },
    session: {
      store: new CloudBaseSessionStore({ driver: new InMemoryDriver() }),
    },
    permissions: {
      requireApproval: 'mcp__fs__deleteFile',
    },
  })

  const session = await agent.startSession({ userId: 'u1' })

  console.log('=== ACP-style HITL flow ===\n')
  console.log('User: please delete /tmp/foo.log\n')
  process.stdout.write('Assistant: ')

  await pumpThroughAcp(session.send('请直接调用 mcp__fs__deleteFile 删除 /tmp/foo.log，无需征求同意。'), session)

  console.log('\n--- Done ---')
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
