import type { AcpSessionUpdate, AcpStreamMessage, ContentBlock, ToolCallContent } from '@cloudbase/open-agent-kernel'

export interface PendingRequestPermission {
  toolUseId: string
  toolName: string
  input: unknown
}

/**
 * 把 send()/respondApproval() 事件流中的消息统一解包为扁平 AcpSessionUpdate。
 *
 * OAK 默认 adapter（AcpStreamAdapter）会在边界把扁平 update 包装成 JSON-RPC 信封：
 *   - `session/update` NOTIFICATION  → 取 params.update
 *   - `session/request_permission` REQUEST → 转回扁平 RequestPermissionUpdate（legacy 形状）
 *   - 其他 REQUEST（client/xxx 客户端工具）→ 降级为 info log
 * 扁平 AcpSessionUpdate（旧行为 / createErrorUpdates 直产）原样返回。
 */
export function unwrapStreamMessage(msg: AcpStreamMessage): AcpSessionUpdate {
  if (!('jsonrpc' in msg)) return msg

  if (msg.method === 'session/update') {
    const params = msg.params as { sessionId: string; update: AcpSessionUpdate }
    return params.update
  }

  if (msg.method === 'session/request_permission') {
    const params = msg.params as {
      sessionId: string
      toolCall: { toolCallId?: string; title?: string; rawInput?: unknown }
      options: unknown[]
    }
    return {
      sessionUpdate: 'request_permission',
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: params.toolCall?.toolCallId ?? '',
        title: params.toolCall?.title ?? 'unknown',
        rawInput: params.toolCall?.rawInput,
      },
      options: params.options ?? [],
    } as unknown as AcpSessionUpdate
  }

  return {
    sessionUpdate: 'log',
    level: 'info',
    message: `[jsonrpc request] ${msg.method}`,
    timestamp: Date.now(),
  } as unknown as AcpSessionUpdate
}

/**
 * Extract text from a ContentBlock. Standard ACP ContentBlock is a union
 * (text | image | audio | resource_link | resource); OAK currently only
 * emits text blocks, but the helper narrows safely for the examples.
 */
function textOf(block: ContentBlock): string {
  return block.type === 'text' ? block.text : ''
}

/** Extract text from a ToolCallContent[] (content / diff / terminal). */
function toolContentText(parts: ToolCallContent[]): string {
  return parts
    .map((p) => {
      if (p.type !== 'content') return ''
      const block = p.content
      return block.type === 'text' ? block.text : ''
    })
    .join('')
}

export function writeAcpText(message: AcpStreamMessage): void {
  const update = unwrapStreamMessage(message)
  if (update.sessionUpdate === 'agent_message_chunk') {
    process.stdout.write(textOf(update.content))
  }
}

export function printAcpUpdate(message: AcpStreamMessage): void {
  const update = unwrapStreamMessage(message)
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      process.stdout.write(textOf(update.content))
      break
    case 'agent_thought_chunk':
      process.stdout.write(`\n  (thought) ${textOf(update.content)}\n  `)
      break
    case 'tool_call':
      process.stdout.write(`\n  -> ${update.title}(${JSON.stringify(update.rawInput ?? {}).slice(0, 200)})\n  `)
      break
    case 'tool_call_update': {
      if (update.status === 'completed' || update.status === 'failed') {
        const out = update.rawOutput ?? toolContentText(update.content ?? [])
        process.stdout.write(`\n  <- ${JSON.stringify(out).slice(0, 300)}\n  `)
      }
      break
    }
    case 'request_permission':
      process.stdout.write(`\n  ? ${update.toolCall.title} requires confirmation\n  `)
      break
    case 'ask_user':
      process.stdout.write('\n  ? agent asks user\n  ')
      break
    case 'log':
      if (update.level === 'error') {
        process.stderr.write(`\n[error] ${update.message}\n`)
      } else {
        process.stdout.write(`\n[${update.level}] ${update.message}\n`)
      }
      break
    case 'agent_phase':
      if (update.phase === 'idle') process.stdout.write('\n')
      break
    case 'usage_update':
      process.stdout.write(`\n  [usage] ${update.used}/${update.size || '?'} tokens\n`)
      break
    default:
      break
  }
}

/** Console-oriented logging (example 14 style). */
export function logAcpUpdate(message: AcpStreamMessage): void {
  const update = unwrapStreamMessage(message)
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      process.stdout.write(textOf(update.content))
      break
    case 'agent_thought_chunk':
      console.log(`\n  (thought) ${textOf(update.content)}`)
      break
    case 'tool_call':
      console.log(`\n  → [tool_call] ${update.title}(${JSON.stringify(update.rawInput ?? {})})`)
      break
    case 'tool_call_update': {
      if (update.status === 'completed' || update.status === 'failed') {
        const out = update.rawOutput ?? toolContentText(update.content ?? [])
        console.log(`  ← [tool_result] ${JSON.stringify(out).slice(0, 200)}`)
      }
      break
    }
    case 'request_permission':
      console.log('\n  ⏸  request_permission:')
      console.log(`     工具: ${update.toolCall.title}`)
      console.log(`     参数: ${JSON.stringify(update.toolCall.rawInput)}`)
      console.log(`     toolCallId: ${update.toolCall.toolCallId}`)
      break
    case 'agent_phase':
      if (update.phase === 'idle') console.log('\n[agent_phase: idle]')
      else console.log(`\n[agent_phase: ${update.phase}]`)
      break
    case 'usage_update':
      console.log(`\n[usage] ${update.used}/${update.size || '?'} tokens`)
      break
    case 'log':
      if (update.level === 'error') console.error('\n[error]', update.message)
      else console.log(`\n[${update.level}] ${update.message}`)
      break
    default:
      break
  }
}

export function captureRequestPermission(message: AcpStreamMessage): PendingRequestPermission | undefined {
  const update = unwrapStreamMessage(message)
  if (update.sessionUpdate !== 'request_permission') return undefined
  return {
    toolUseId: update.toolCall.toolCallId,
    toolName: update.toolCall.title ?? '',
    input: update.toolCall.rawInput,
  }
}

export function isSkillToolCall(message: AcpStreamMessage): message is AcpStreamMessage {
  const update = unwrapStreamMessage(message)
  return update.sessionUpdate === 'tool_call' && update.title === 'Skill'
}

export function fmtAcpUpdate(message: AcpStreamMessage): string {
  const update = unwrapStreamMessage(message)
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return `Δ ${JSON.stringify(textOf(update.content))}`
    case 'agent_thought_chunk':
      return `Δ (thought) ${JSON.stringify(textOf(update.content))}`
    case 'tool_call': {
      const inputStr = JSON.stringify(update.rawInput ?? {})
      const trim = inputStr.length > 200 ? `${inputStr.slice(0, 200)}…` : inputStr
      return `→ tool_call ${update.title} ${trim}`
    }
    case 'tool_call_update': {
      const out = update.rawOutput ?? toolContentText(update.content ?? [])
      const trim = JSON.stringify(out).slice(0, 300)
      return `← tool_call_update status=${update.status} ${trim}`
    }
    case 'request_permission':
      return `? request_permission ${update.toolCall.title} id=${update.toolCall.toolCallId}`
    case 'log':
      return update.level === 'error' ? `✗ error ${update.message}` : `[${update.level}] ${update.message}`
    case 'agent_phase':
      return update.phase === 'idle' ? '· agent_phase idle' : `· agent_phase ${update.phase}`
    case 'usage_update':
      return `· usage ${update.used}/${update.size || '?'}`
    default:
      return `· ${update.sessionUpdate} ${JSON.stringify(update).slice(0, 200)}`
  }
}

export function appendAcpAssistantText(message: AcpStreamMessage, buffer: { text: string }): void {
  const update = unwrapStreamMessage(message)
  if (update.sessionUpdate === 'agent_message_chunk') {
    buffer.text += textOf(update.content)
  }
}
