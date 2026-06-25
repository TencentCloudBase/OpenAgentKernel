import type { AcpSessionUpdate } from '@cloudbase/open-agent-kernel'

export interface PendingToolConfirm {
  toolUseId: string
  toolName: string
  input: unknown
}

export function writeAcpText(update: AcpSessionUpdate): void {
  if (update.sessionUpdate === 'agent_message_chunk') {
    process.stdout.write(update.content.text)
  }
}

export function printAcpUpdate(update: AcpSessionUpdate): void {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      process.stdout.write(update.content.text)
      break
    case 'tool_call':
      process.stdout.write(`\n  -> ${update.title}(${JSON.stringify(update.input ?? {}).slice(0, 200)})\n  `)
      break
    case 'tool_call_update':
      if (update.status === 'completed' || update.status === 'failed') {
        process.stdout.write(`\n  <- ${JSON.stringify(update.result ?? update.error ?? null).slice(0, 300)}\n  `)
      }
      break
    case 'tool_confirm':
      process.stdout.write(`\n  ? ${update.toolName} requires confirmation\n  `)
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
    default:
      break
  }
}

/** Console-oriented logging (example 14 style). */
export function logAcpUpdate(update: AcpSessionUpdate): void {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      process.stdout.write(update.content.text)
      break
    case 'tool_call':
      console.log(`\n  → [tool_call] ${update.title}(${JSON.stringify(update.input ?? {})})`)
      break
    case 'tool_call_update':
      if (update.status === 'completed' || update.status === 'failed') {
        console.log(`  ← [tool_result] ${JSON.stringify(update.result ?? update.error ?? null).slice(0, 200)}`)
      }
      break
    case 'tool_confirm':
      console.log('\n  ⏸  tool_confirm:')
      console.log(`     工具: ${update.toolName}`)
      console.log(`     参数: ${JSON.stringify(update.input)}`)
      console.log(`     toolCallId: ${update.toolCallId}`)
      break
    case 'agent_phase':
      if (update.phase === 'idle') console.log('\n[agent_phase: idle]')
      break
    case 'log':
      if (update.level === 'error') console.error('\n[error]', update.message)
      else console.log(`\n[${update.level}] ${update.message}`)
      break
    default:
      break
  }
}

export function captureToolConfirm(update: AcpSessionUpdate): PendingToolConfirm | undefined {
  if (update.sessionUpdate !== 'tool_confirm') return undefined
  return {
    toolUseId: update.toolCallId,
    toolName: update.toolName,
    input: update.input,
  }
}

export function isSkillToolCall(update: AcpSessionUpdate): boolean {
  return update.sessionUpdate === 'tool_call' && update.title === 'Skill'
}

export function fmtAcpUpdate(update: AcpSessionUpdate): string {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return `Δ ${JSON.stringify(update.content.text)}`
    case 'tool_call': {
      const inputStr = JSON.stringify(update.input ?? {})
      const trim = inputStr.length > 200 ? `${inputStr.slice(0, 200)}…` : inputStr
      return `→ tool_call ${update.title} ${trim}`
    }
    case 'tool_call_update': {
      const out = JSON.stringify(update.result ?? update.error ?? null)
      const trim = out.length > 300 ? `${out.slice(0, 300)}…` : out
      return `← tool_call_update status=${update.status} ${trim}`
    }
    case 'tool_confirm':
      return `? tool_confirm ${update.toolName} id=${update.toolCallId}`
    case 'log':
      return update.level === 'error' ? `✗ error ${update.message}` : `[${update.level}] ${update.message}`
    case 'agent_phase':
      return update.phase === 'idle' ? '· agent_phase idle' : `· agent_phase ${update.phase}`
    default:
      return `· ${update.sessionUpdate} ${JSON.stringify(update).slice(0, 200)}`
  }
}

export function appendAcpAssistantText(update: AcpSessionUpdate, buffer: { text: string }): void {
  if (update.sessionUpdate === 'agent_message_chunk') {
    buffer.text += update.content.text
  }
}
