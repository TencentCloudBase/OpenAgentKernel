import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AcpStreamMessage } from '../acp/types.js'

export interface StreamAdapterContext {
  conversationId: string
  sessionId: string
  userId: string
  turnId: string
}

export interface StreamAdapter<TOut = AcpStreamMessage> {
  adapt(messages: AsyncIterable<SDKMessage>, context: StreamAdapterContext): AsyncIterable<TOut>
}
