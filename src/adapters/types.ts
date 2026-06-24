import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

export interface StreamAdapterContext {
  conversationId: string
  sessionId: string
  userId: string
  turnId: string
}

export interface StreamAdapter<TOut> {
  adapt(messages: AsyncIterable<SDKMessage>, context: StreamAdapterContext): AsyncIterable<TOut>
}
