/**
 * Example 15: Client-Tool History 聚合验证
 *
 * 模拟 client-tool 的 SDK transcript 数据结构，验证 aggregateHistory 逻辑：
 *   1. Turn 1 的 sentinel tool_result 是否被过滤
 *   2. Turn 1 的 tool_call 是否被跳过
 *   3. [系统通知] resume prompt 是否被过滤
 *   4. Turn 2 的 tool_call + 实际 tool_result 是否保留
 *   5. 最终用户只看到干净的 tool_call + 实际结果
 *
 * 运行：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/15-client-tool-history.ts
 */

// ─── 模拟类型 ──────────────────────────────────────────────────────

interface MessagePart {
  type: string
  text?: string
  toolUseId?: string
  toolName?: string
  input?: unknown
  output?: unknown
  isError?: boolean
}

interface MessageRecord {
  id: string
  role: 'user' | 'assistant'
  parts: MessagePart[]
  createdAt: number
  status: string
}

// ─── 复制 aggregateHistory 逻辑（与 create-agent.ts 一致）──────────

function aggregateHistory(records: MessageRecord[]): MessageRecord[] {
  // Pass 1: 收集 tool_results + 识别内部产物
  const toolResultMap = new Map<string, MessagePart>()
  const interruptedToolUseIds = new Set<string>()
  const excludeIds = new Set<string>()

  for (const msg of records) {
    if (msg.role !== 'user') continue

    // 检测内部 sentinel（HITL approval / client-tool）
    const isSentinel = msg.parts.some(
      (p) =>
        p.type === 'tool_result' &&
        typeof p.output === 'string' &&
        ((p.output as string).includes('__OAK_INTERRUPT__') || (p.output as string).includes('__OAK_CLIENT_TOOL__')),
    )
    if (isSentinel) {
      for (const p of msg.parts) {
        if (p.type === 'tool_result') interruptedToolUseIds.add(p.toolUseId!)
      }
      excludeIds.add(msg.id)
      continue
    }

    // 检测 resume prompt
    const isResumePrompt = msg.parts.some((p) => p.type === 'text' && p.text!.startsWith('[系统通知]'))
    if (isResumePrompt) {
      excludeIds.add(msg.id)
      continue
    }

    // 纯 tool_result 消息 → 收集等待合并
    const isAllToolResults = msg.parts.length > 0 && msg.parts.every((p) => p.type === 'tool_result')
    if (isAllToolResults) {
      for (const part of msg.parts) {
        if (part.type === 'tool_result') {
          const outputStr = typeof part.output === 'string' ? part.output : JSON.stringify(part.output)
          if (outputStr.includes('oak_pending_approval_in_turn')) {
            interruptedToolUseIds.add(part.toolUseId!)
            continue
          }
          toolResultMap.set(part.toolUseId!, part)
        }
      }
      excludeIds.add(msg.id)
    }
  }

  // Pass 2: 重建记录
  const result: MessageRecord[] = []
  for (const msg of records) {
    if (excludeIds.has(msg.id)) continue

    if (msg.role === 'assistant') {
      const augmentedParts: MessagePart[] = []
      for (const part of msg.parts) {
        if (part.type === 'tool_call') {
          if (interruptedToolUseIds.has(part.toolUseId!)) {
            continue
          }
          augmentedParts.push(part)
          const matched = toolResultMap.get(part.toolUseId!)
          if (matched) {
            augmentedParts.push(matched)
            toolResultMap.delete(part.toolUseId!)
          }
        } else {
          augmentedParts.push(part)
        }
      }
      if (augmentedParts.length > 0) {
        result.push({ ...msg, parts: augmentedParts })
      }
    } else {
      result.push(msg)
    }
  }

  // Pass 3: 合并连续 assistant 消息
  const merged: MessageRecord[] = []
  for (const msg of result) {
    if (msg.role === 'assistant' && merged.length > 0 && merged[merged.length - 1].role === 'assistant') {
      const prev = merged[merged.length - 1]
      merged[merged.length - 1] = {
        ...prev,
        parts: [...prev.parts, ...msg.parts],
      }
    } else {
      merged.push(msg)
    }
  }

  return merged
}

// ─── 构造模拟数据 ──────────────────────────────────────────────────

const TOOL_NAME = 'get_weather'
const TOOL_INPUT = { city: 'Beijing' }
const TOOL_ACTUAL_OUTPUT = '{"temp": 25, "unit": "celsius", "condition": "sunny"}'
const CONVERSATION_ID = 'conv-test-123'

// Turn 1: 模型调用 client-tool，被 deny
const sentinelPayload = JSON.stringify({
  __OAK_CLIENT_TOOL__: true,
  conversationId: CONVERSATION_ID,
  toolUseId: 'tool-001',
  toolName: TOOL_NAME,
  toolInput: TOOL_INPUT,
  message: 'Tool call deferred to the client (toolUseId=tool-001). Do not retry this tool yourself.',
})

// Turn 2: resume，模型重新调用，hook 注入结果
const resumePrompt = `[系统通知] 用户为刚才的工具调用 \`${TOOL_NAME}\` 提供了实际执行结果。请重新调用该工具以获取该结果（hook 会自动注入），然后基于结果继续。`

const sdkTranscript: MessageRecord[] = [
  // 0. 用户原始消息
  {
    id: 'msg-001',
    role: 'user',
    parts: [{ type: 'text', text: '北京今天天气怎么样？' }],
    createdAt: 1000,
    status: 'done',
  },
  // 1. Turn 1: assistant 发起 tool_call（被 deny）
  {
    id: 'msg-002',
    role: 'assistant',
    parts: [
      { type: 'text', text: '让我查一下北京的天气。' },
      { type: 'tool_call', toolUseId: 'tool-001', toolName: TOOL_NAME, input: TOOL_INPUT },
    ],
    createdAt: 2000,
    status: 'done',
  },
  // 2. Turn 1: sentinel deny tool_result
  {
    id: 'msg-003',
    role: 'user',
    parts: [{ type: 'tool_result', toolUseId: 'tool-001', output: sentinelPayload, isError: true }],
    createdAt: 3000,
    status: 'done',
  },
  // 3. Turn 2: resume prompt
  {
    id: 'msg-004',
    role: 'user',
    parts: [{ type: 'text', text: resumePrompt }],
    createdAt: 4000,
    status: 'done',
  },
  // 4. Turn 2: assistant 重新调用（hook 注入结果）
  {
    id: 'msg-005',
    role: 'assistant',
    parts: [{ type: 'tool_call', toolUseId: 'tool-002', toolName: TOOL_NAME, input: TOOL_INPUT }],
    createdAt: 5000,
    status: 'done',
  },
  // 5. Turn 2: 实际 tool_result（MCP stub 返回）
  {
    id: 'msg-006',
    role: 'user',
    parts: [{ type: 'tool_result', toolUseId: 'tool-002', output: TOOL_ACTUAL_OUTPUT, isError: false }],
    createdAt: 6000,
    status: 'done',
  },
  // 6. 最终回复
  {
    id: 'msg-007',
    role: 'assistant',
    parts: [{ type: 'text', text: '北京今天天气晴朗，气温 25°C。' }],
    createdAt: 7000,
    status: 'done',
  },
]

// ─── 执行测试 ──────────────────────────────────────────────────────

function printSeparator(title: string): void {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  ${title}`)
  console.log(`${'═'.repeat(60)}\n`)
}

function printRecords(records: MessageRecord[]): void {
  for (const msg of records) {
    const icon = msg.role === 'user' ? '👤' : '🤖'
    console.log(`${icon} [${msg.role}] id=${msg.id}`)
    for (const part of msg.parts) {
      switch (part.type) {
        case 'text':
          console.log(`   📝 text: ${part.text!.slice(0, 120)}`)
          break
        case 'tool_call':
          console.log(`   🔧 tool_call: ${part.toolName}(${JSON.stringify(part.input).slice(0, 80)})`)
          break
        case 'tool_result':
          console.log(`   📦 tool_result: isError=${part.isError}, output=${JSON.stringify(part.output).slice(0, 100)}`)
          break
      }
    }
    console.log()
  }
}

// ── 原始 transcript ──
printSeparator('SDK Transcript（原始数据，共 7 条）')
printRecords(sdkTranscript)

// ── 聚合后 ──
const aggregated = aggregateHistory(sdkTranscript)
printSeparator(`aggregateHistory 聚合后（共 ${aggregated.length} 条）`)
printRecords(aggregated)

// ── 验证 ──
printSeparator('验证结果')

const checks = [
  {
    label: 'sentinel tool_result 被过滤',
    pass: !aggregated.some((m) =>
      m.parts.some((p) => p.type === 'tool_result' && JSON.stringify(p.output).includes('__OAK_CLIENT_TOOL__')),
    ),
  },
  {
    label: '[系统通知] resume prompt 被过滤',
    pass: !aggregated.some((m) => m.parts.some((p) => p.type === 'text' && p.text!.startsWith('[系统通知]'))),
  },
  {
    label: 'Turn 1 的 tool_call（tool-001）被跳过',
    pass: !aggregated.some((m) => m.parts.some((p) => p.type === 'tool_call' && p.toolUseId === 'tool-001')),
  },
  {
    label: 'Turn 2 的 tool_call（tool-002）保留',
    pass: aggregated.some((m) => m.parts.some((p) => p.type === 'tool_call' && p.toolUseId === 'tool-002')),
  },
  {
    label: '实际 tool_result 保留且配对',
    pass: aggregated.some((m) =>
      m.parts.some((p) => p.type === 'tool_result' && p.toolUseId === 'tool-002' && p.output === TOOL_ACTUAL_OUTPUT),
    ),
  },
  {
    label: '无孤立 tool_result user 消息',
    pass: !aggregated.some(
      (m) => m.role === 'user' && m.parts.length > 0 && m.parts.every((p) => p.type === 'tool_result'),
    ),
  },
  {
    label: '连续 assistant 消息已合并',
    pass: (() => {
      for (let i = 1; i < aggregated.length; i++) {
        if (aggregated[i].role === 'assistant' && aggregated[i - 1].role === 'assistant') return false
      }
      return true
    })(),
  },
  {
    label: '最终结构：user → assistant（含 tool_call+result+text）',
    pass: (() => {
      if (aggregated.length !== 2) return false
      if (aggregated[0].role !== 'user') return false
      if (aggregated[1].role !== 'assistant') return false
      const parts = aggregated[1].parts
      // 应该有: text + tool_call + tool_result + text
      const hasToolCall = parts.some((p) => p.type === 'tool_call' && p.toolUseId === 'tool-002')
      const hasToolResult = parts.some((p) => p.type === 'tool_result' && p.toolUseId === 'tool-002')
      const hasFinalText = parts.some((p) => p.type === 'text' && p.text!.includes('25°C'))
      return hasToolCall && hasToolResult && hasFinalText
    })(),
  },
]

for (const c of checks) {
  console.log(`${c.pass ? '✅' : '❌'} ${c.label}`)
}

const allPassed = checks.every((c) => c.pass)
console.log(allPassed ? '\n🎉 所有验证通过！client-tool 历史聚合正确。' : '\n⚠️  部分验证失败，请检查。')
