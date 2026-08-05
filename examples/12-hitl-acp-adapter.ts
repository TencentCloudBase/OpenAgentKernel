/**
 * Example 12: built-in ACP HITL flow
 *
 * 演示 OAK 内置 ACP 输出后的 HITL 事件：
 *   - session.send() 直接输出 ACP `request_permission`（OAK stop-and-resume 适配）
 *   - 业务拿到用户决策后调用 session.respondApproval()
 *
 * 运行（本 example 不依赖真实 ACP 客户端，模拟一个 "allow" 客户端）：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/12-hitl-acp-adapter.ts
 */
import { getEnvId, getModel } from './_shared/env.js'

import { CloudBaseSessionStore, createAgent, InMemoryDriver, type AcpSessionUpdate } from '@cloudbase/open-agent-kernel'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

// ─────────────────────────────────────────────────────────────────────
// 模拟一个 ACP 客户端协议形态（实际项目里来自 @agentclientprotocol/sdk）
// ─────────────────────────────────────────────────────────────────────

/**
 * ACP `session/request_permission` 请求体（对齐 ACP spec + OAK stop-and-resume 适配）。
 *
 * OAK 把它作为 sessionUpdate 通知发出（而非 JSON-RPC 反向 request），
 * payload shape 与标准 RequestPermissionRequest 一致：
 *   - `toolCall`: 标准 ToolCallUpdate（toolCallId / title / kind / rawInput / locations）
 *   - `options`: 标准 PermissionOption[]（optionId / name / kind）
 */
interface AcpPermissionRequest {
  toolCall: {
    toolCallId: string
    title: string
    kind: string
    rawInput: unknown
  }
  options: Array<{
    optionId: string
    name: string
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
  }>
}

/**
 * ACP 客户端的批准响应（对齐标准 RequestPermissionResponse.outcome）。
 */
interface AcpPermissionResponse {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }
}

/**
 * 模拟的 ACP 客户端（实际是 WebSocket / JSON-RPC 双向连接）。
 * 这里直接 hardcode "allow"。
 */
async function fakeAcpRequestPermission(req: AcpPermissionRequest): Promise<AcpPermissionResponse> {
  console.log(`\n[ACP server → client] request_permission`)
  console.log(`  toolCall.title:    ${req.toolCall.title}`)
  console.log(`  toolCall.kind:     ${req.toolCall.kind}`)
  console.log(`  toolCall.rawInput: ${JSON.stringify(req.toolCall.rawInput)}`)
  console.log(`  options:           ${req.options.map((o) => `${o.optionId}(${o.kind})`).join(', ')}`)
  console.log(`[ACP client → server] selected: allow  (模拟)`)
  await new Promise((r) => setTimeout(r, 50))
  return { outcome: { outcome: 'selected', optionId: 'allow' } }
}

// ─────────────────────────────────────────────────────────────────────
// ACP HITL pump：消费 OAK 内置 ACP 更新，遇到 request_permission 后注入审批决策
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
      process.stdout.write(e.content.type === 'text' ? e.content.text : '')
    } else if (e.sessionUpdate === 'tool_call') {
      process.stdout.write(`\n[kernel ACP] tool_call: ${e.title} (kind=${e.kind})\n`)
    } else if (e.sessionUpdate === 'tool_call_update') {
      const out = JSON.stringify(e.rawOutput ?? e.content ?? null).slice(0, 100)
      process.stdout.write(`\n[kernel ACP] tool_call_update: status=${e.status} out=${out}\n`)
    } else if (e.sessionUpdate === 'request_permission') {
      const acpReq: AcpPermissionRequest = {
        toolCall: {
          toolCallId: e.toolCall.toolCallId,
          title: e.toolCall.title,
          kind: e.toolCall.kind ?? 'other',
          rawInput: e.toolCall.rawInput,
        },
        options: e.options,
      }
      const acpResp = await fakeAcpRequestPermission(acpReq)

      // ── ACP 响应 → kernel 决策 ──
      if (acpResp.outcome.outcome === 'cancelled') {
        // 客户端取消 → kernel 视为 deny+interrupt
        await pumpThroughAcp(
          session.respondApproval({
            toolUseId: e.toolCall.toolCallId,
            decision: { kind: 'deny', reason: 'ACP client cancelled', interrupt: true },
          }),
          session,
        )
        return
      }
      const optionId = acpResp.outcome.optionId
      const decision =
        optionId === 'allow'
          ? ({ kind: 'allow', scope: 'once' } as const)
          : optionId === 'allow_always'
            ? ({ kind: 'allow', scope: 'session' } as const)
            : optionId === 'reject'
              ? ({ kind: 'deny', scope: 'once', reason: 'User rejected' } as const)
              : ({
                  kind: 'deny',
                  scope: 'session',
                  reason: 'User rejected (always)',
                } as const)

      // ── 注入决策并继续消费事件流（递归式抽干）──
      await pumpThroughAcp(session.respondApproval({ toolUseId: e.toolCall.toolCallId, decision }), session)
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
