import type { AcpSessionUpdate, ContentBlock, ToolCallContent } from '@cloudbase/open-agent-kernel'

export interface PendingRequestPermission {
  toolUseId: string
  toolName: string
  input: unknown
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

export function writeAcpText(update: AcpSessionUpdate): void {
  if (update.sessionUpdate === 'agent_message_chunk') {
    process.stdout.write(textOf(update.content))
  }
}

export function printAcpUpdate(update: AcpSessionUpdate): void {
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
export function logAcpUpdate(update: AcpSessionUpdate): void {
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

export function captureRequestPermission(update: AcpSessionUpdate): PendingRequestPermission | undefined {
  if (update.sessionUpdate !== 'request_permission') return undefined
  return {
    toolUseId: update.toolCall.toolCallId,
    toolName: update.toolCall.title,
    input: update.toolCall.rawInput,
  }
}

export function isSkillToolCall(update: AcpSessionUpdate): update is AcpSessionUpdate & { sessionUpdate: 'tool_call' } {
  return update.sessionUpdate === 'tool_call' && update.title === 'Skill'
}

export function fmtAcpUpdate(update: AcpSessionUpdate): string {
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

export function appendAcpAssistantText(update: AcpSessionUpdate, buffer: { text: string }): void {
  if (update.sessionUpdate === 'agent_message_chunk') {
    buffer.text += textOf(update.content)
  }
}
