import type { AcpSessionUpdate } from '@cloudbase/open-agent-kernel'

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
      process.stdout.write(`\n[${update.level}] ${update.message}\n`)
      break
    case 'agent_phase':
      if (update.phase === 'idle') process.stdout.write('\n')
      break
    default:
      break
  }
}
