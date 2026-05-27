/**
 * HistoryStoreDriver: 抽象出"历史消息存储落到哪里"的协议。
 *
 * 与 SessionStoreDriver 对称：
 *   - SessionStoreDriver  → SDK 内部协议（transcript entries，透明转储）
 *   - HistoryStoreDriver  → 前端可读消息（MessageRecord，语义化格式）
 *
 * 两者职责：
 *   - SessionStore → SDK resume 用（重建 agent context）
 *   - HistoryStore → 前端渲染 chat UI 用（MessageRecord）
 *
 * 当前提供两个实现：
 *   - InMemoryHistoryStoreDriver    测试/开发用（进程退出即丢）
 *   - CloudBaseDbHistoryStoreDriver 生产用（落 CloudBase 数据库 oak_messages 集合）
 *
 * 未来可加：
 *   - PostgresDriver、RedisDriver、MongoDriver 等
 */

import type { MessageRecord } from '../../public/types.js'

export interface HistoryStoreDriver {
  /**
   * 追加一批消息记录。
   *
   * 实现要求：
   *   - 必须按 records 数组顺序持久化（保证同一进程内的顺序性）
   *   - 必须把 record.id 作为幂等键（已存在则忽略，不抛错）
   *   - 不能解释 record 内部结构（透明转储）
   */
  append(projectKey: string, records: MessageRecord[]): Promise<void>

  /**
   * 查询某个 conversation 的历史消息。
   *
   * @param opts.conversationId 必填：会话 ID
   * @param opts.limit 可选：返回条数上限（默认 100）
   * @param opts.before 可选：返回此时间戳之前的消息（用于分页）
   * @param opts.after 可选：返回此时间戳之后的消息（用于增量同步）
   */
  query(
    projectKey: string,
    opts: {
      conversationId: string
      limit?: number
      before?: number
      after?: number
    },
  ): Promise<MessageRecord[]>

  /**
   * 列出某个 projectKey 下的所有会话（带摘要 / 最后一条预览 / 时间戳）。
   *
   * 实现要求：
   *   - 按最后一条消息的 createdAt 降序排列
   *   - 可选：支持分页（limit + cursor）
   */
  listConversations(
    projectKey: string,
    opts?: {
      userId?: string
      limit?: number
      cursor?: string
    },
  ): Promise<ConversationSummary[]>

  /**
   * 删除某个会话的所有历史消息。
   */
  deleteConversation(projectKey: string, conversationId: string): Promise<void>
}

/**
 * 会话摘要：用于会话列表页展示
 */
export interface ConversationSummary {
  conversationId: string
  userId?: string
  title?: string
  lastMessage?: {
    role: 'user' | 'assistant' | 'system'
    text: string
    createdAt: number
  }
  messageCount: number
  createdAt: number
  updatedAt: number
}
