/**
 * Example 20: built-in ACP stream adapter fixture.
 *
 * This example does not call a real model. It feeds Claude Agent SDK-shaped
 * messages into AcpStreamAdapter and prints ACP session/update objects.
 *
 * Run after build:
 *   pnpm --filter @cloudbase/open-agent-kernel build
 *   pnpm dlx tsx packages/open-agent-kernel/examples/20-acp-stream-adapter-fixture.ts
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { AcpStreamAdapter } from '@cloudbase/open-agent-kernel'

async function* fixtureMessages(): AsyncIterable<SDKMessage> {
  yield {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: '你好，' },
    },
  } as unknown as SDKMessage

  yield {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'ACP。' },
    },
  } as unknown as SDKMessage

  yield {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: '你好，ACP。' },
        { type: 'tool_use', id: 'toolu_fixture_1', name: 'mcp__demo__echo', input: { text: 'hello' } },
      ],
    },
  } as unknown as SDKMessage

  yield {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_fixture_2', name: 'mcp__demo__write', input: {} },
    },
  } as unknown as SDKMessage

  yield {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"path":' },
    },
  } as unknown as SDKMessage

  yield {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '"/tmp/demo.txt"}' },
    },
  } as unknown as SDKMessage

  yield {
    type: 'stream_event',
    event: {
      type: 'content_block_stop',
      index: 1,
    },
  } as unknown as SDKMessage

  yield {
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'toolu_fixture_1', content: 'echo: hello' }],
    },
  } as unknown as SDKMessage

  yield {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_fixture_2',
          is_error: true,
          content: JSON.stringify({
            __OAK_INTERRUPT__: true,
            conversationId: 'conv_fixture',
            toolUseId: 'toolu_fixture_2',
            toolName: 'mcp__demo__write',
            toolInput: { path: '/tmp/demo.txt' },
          }),
        },
      ],
    },
  } as unknown as SDKMessage

  yield {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_fixture_ask',
          is_error: true,
          content: JSON.stringify({
            __OAK_ASK_USER__: true,
            conversationId: 'conv_fixture',
            toolUseId: 'toolu_fixture_ask',
            question: '是否继续？',
            options: ['继续', '停止'],
          }),
        },
      ],
    },
  } as unknown as SDKMessage

  yield {
    type: 'result',
    subtype: 'success',
  } as unknown as SDKMessage
}

async function main(): Promise<void> {
  const adapter = new AcpStreamAdapter()
  const updates = adapter.adapt(fixtureMessages(), {
    conversationId: 'conv_fixture',
    sessionId: 'conv_fixture',
    userId: 'u1',
    turnId: 'turn_fixture',
  })

  for await (const update of updates) {
    process.stdout.write(`${JSON.stringify(update)}\n`)
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
