/**
 * Example 12: PR #7.0 —— ACP 协议适配演示
 *
 * 演示 kernel 的 HITL 事件流如何映射到 ACP 协议：
 *   - kernel 出 'tool_approval_required' → 业务发 ACP `session/request_permission`
 *   - ACP 客户端回 selectedOption.optionId → 业务调 session.respondApproval()
 *
 * **重点：协议适配代码完全在用户业务侧**，kernel 不内置 ACP——这就是
 * "kernel 是协议中立的纯库" 的真实含义。下面的 `AcpAdapter` 是 30 行业务代码示意。
 *
 * 真实生产中，AcpAdapter 一边接 @zed-industries/agent-client-protocol（或自家实现），
 * 另一边消费 kernel SessionEvent。
 *
 * 运行（本 example 不依赖真实 ACP 客户端，模拟一个"Always allow_once" 客户端）：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/12-hitl-acp-adapter.ts
 */
import './_shared/env.js'

import { CloudBaseSessionStore, createAgent, InMemoryDriver, type SessionEvent } from '@cloudbase/open-agent-kernel'
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
// AcpAdapter：把 kernel SessionEvent ↔ ACP 协议来回映射（业务侧 ~30 行）
// ─────────────────────────────────────────────────────────────────────

/**
 * 把一次 send / respondApproval 的事件流跑完，遇到 tool_approval_required
 * 自动通过 ACP 协议跟客户端交互拿决策，再 respondApproval 注入。
 *
 * 这是协议适配层的最小骨架——你可以原样套到自家 ACP server 实现。
 */
async function pumpThroughAcp(
  events: AsyncIterable<SessionEvent>,
  session: { respondApproval: (opts: any) => AsyncIterable<SessionEvent> },
): Promise<void> {
  for await (const e of events) {
    if (e.type === 'message_delta') {
      process.stdout.write(e.text)
    } else if (e.type === 'tool_call') {
      console.log(`\n[kernel → ACP] session_update.tool_call: ${e.toolName}`)
    } else if (e.type === 'tool_result') {
      const out = JSON.stringify(e.output).slice(0, 100)
      console.log(`\n[kernel → ACP] session_update.tool_call_update: result=${out}`)
    } else if (e.type === 'tool_approval_required') {
      // ── kernel → ACP 映射 ──
      const acpReq: AcpPermissionRequest = {
        toolCall: {
          toolCallId: e.toolUseId,
          toolName: e.toolName,
          args: e.input,
        },
        options: (e.hints?.suggestedScopes ?? ['once', 'session']).flatMap((scope) => {
          if (scope === 'once') {
            return [
              { optionId: 'allow_once', label: '本次允许', kind: 'allow_once' as const },
              { optionId: 'reject_once', label: '本次拒绝', kind: 'reject_once' as const },
            ]
          }
          if (scope === 'session') {
            return [
              {
                optionId: 'allow_always',
                label: '本会话内总是允许',
                kind: 'allow_always' as const,
              },
            ]
          }
          return []
        }),
      }
      const acpResp = await fakeAcpRequestPermission(acpReq)

      // ── ACP 响应 → kernel 决策 ──
      if (acpResp.outcome.kind === 'cancelled') {
        // 客户端取消 → kernel 视为 deny+interrupt
        await pumpThroughAcp(
          session.respondApproval({
            toolUseId: e.toolUseId,
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
      await pumpThroughAcp(session.respondApproval({ toolUseId: e.toolUseId, decision }), session)
      return
    } else if (e.type === 'session_idle') {
      console.log(`\n[kernel → ACP] session_update.idle: ${e.reason}`)
    } else if (e.type === 'error') {
      console.error(`\n[kernel → ACP] error: ${e.error.message}`)
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
    envId: process.env.TCB_ENV_ID ?? 'demo-env',
    model: process.env.CLOUDBASE_AGENT_MODEL ?? 'glm-5.1',
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
