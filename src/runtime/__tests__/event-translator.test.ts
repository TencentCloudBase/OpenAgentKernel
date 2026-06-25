import { describe, it, expect } from 'vitest'
import { createTranslatorState, translateSdkMessage } from '../event-translator.js'
import type { SessionEvent } from '../../public/types.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function run(msg: any, streaming = false): SessionEvent[] {
  const state = createTranslatorState(streaming)
  return [...translateSdkMessage(msg, state)]
}

const assistantText = {
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'hello world' }] },
}

const streamDelta = {
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hel' } },
}

describe('event-translator: streaming dedup', () => {
  it('non-streaming: assistant text → message_delta + message_complete', () => {
    const events = run(assistantText, false)
    expect(events).toEqual([
      { type: 'message_delta', text: 'hello world' },
      { type: 'message_complete', text: 'hello world' },
    ])
  })

  it('streaming: assistant text → ONLY message_complete (no duplicate delta)', () => {
    const events = run(assistantText, true)
    expect(events).toEqual([{ type: 'message_complete', text: 'hello world' }])
  })

  it('streaming: stream_event → message_delta (incremental)', () => {
    const events = run(streamDelta, true)
    expect(events).toEqual([{ type: 'message_delta', text: 'hel' }])
  })

  it('end-to-end streaming: deltas come from stream_event, final from assistant (no dup)', () => {
    const state = createTranslatorState(true)
    const out: SessionEvent[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const m of [
      streamDelta,
      { ...streamDelta, event: { ...streamDelta.event, delta: { type: 'text_delta', text: 'lo world' } } },
      assistantText,
    ] as any[]) {
      out.push(...translateSdkMessage(m, state))
    }
    const deltas = out.filter((e) => e.type === 'message_delta').map((e) => (e as { text: string }).text)
    const completes = out.filter((e) => e.type === 'message_complete')
    expect(deltas).toEqual(['hel', 'lo world']) // only the incremental chunks
    expect(completes).toEqual([{ type: 'message_complete', text: 'hello world' }]) // single final
  })
})
