/**
 * SessionStoreDriver: 抽象出"session store 数据落到哪里"的协议。
 *
 * 与 Claude Agent SDK 的 SessionStore 接口解耦：
 *   - SDK SessionStore   = SDK 协议层（key/entries 形状由 SDK 定义）
 *   - SessionStoreDriver = 我们 kernel 自己的存储抽象（与具体后端解耦）
 *
 * 当前提供两个实现：
 *   - InMemoryDriver        测试/开发用（进程退出即丢）
 *   - CloudBaseDbDriver     生产用（落 CloudBase 数据库三张集合）
 *
 * 未来可加：
 *   - PostgresDriver、RedisDriver、S3Driver、混合 driver 等
 */

import type { SessionKey, SessionStoreEntry, SessionSummaryEntry } from '@anthropic-ai/claude-agent-sdk'
import type { MessageStatus } from '../../public/types.js'

/**
 * 会话消息元数据：用于分页和关联查询。
 *
 * 与 SessionStoreEntry 的区别：
 *   - SessionStoreEntry → SDK 内部协议（透明转储，driver 不解释）
 *   - SessionMessageMeta → 前端可读消息的元数据（driver 从 entries 中提取）
 *
 * 存储在 oak_session_messages 集合中，用于：
 *   1. 分页查询（不需要扫描整个 session_entries 表）
 *   2. 关联 session_entries 表获取完整内容
 *   3. 接口层做结构转换（SDKMessage → MessageRecord）
 */
export interface SessionMessageMeta {
  /** encodeSessionKey(key)，关联 session_entries 表 */
  sessionKey: string
  /** key.sessionId，用于前端查询 */
  conversationId: string
  /** sdkMsg.message?.id || entry.uuid，用于关联 session_entries 表 */
  messageId: string
  /** 消息角色 */
  role: 'user' | 'assistant' | 'system'
  /** 消息时间戳（Unix epoch 毫秒），用于排序 */
  createdAt: number
  /** 消息状态：pending/streaming/done/error/cancel */
  status: MessageStatus
  /** 最近更新时间（Unix epoch 毫秒） */
  mtime: number
}

export interface SessionStoreDriver {
  /**
   * 追加一批 transcript entries。
   *
   * 实现要求：
   *   - 必须按 entries 数组顺序持久化（保证同一进程内的顺序性）
   *   - 必须把 entry.uuid 作为幂等键（已存在则忽略，不抛错）
   *   - 必须把"sessionKey 写入时间"作为 sessions 集合的 mtime 更新（用于 listSessions 排序）
   *   - 不能解释 entry 内部结构（透明转储）
   */
  appendEntries(key: SessionKey, entries: SessionStoreEntry[]): Promise<void>

  /**
   * 加载一个 session 的完整 transcript。
   *
   * 实现要求：
   *   - 按写入顺序返回（按 seq 升序）
   *   - 从未写入过 → 返回 null
   *   - 写入过但被清空 → 也允许返回 null（SDK 不区分这两种情况）
   */
  loadEntries(key: SessionKey): Promise<SessionStoreEntry[] | null>

  /**
   * 列出某个 projectKey 下的所有 session（仅 main transcript，不含 subpath）。
   * 返回的 mtime 是 Unix epoch 毫秒。
   */
  listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>>

  /**
   * 列出某个 projectKey 下的所有 session summaries。
   * 实现要求：
   *   - mtime 必须与 listSessions() 同源（保证 staleness 检查正确）
   *   - data 字段透明转储，不可解释
   */
  listSummaries(projectKey: string): Promise<SessionSummaryEntry[]>

  /**
   * 写入或覆盖某个 session 的 summary。
   * 由 CloudBaseSessionStore 在 appendEntries 内部用 foldSessionSummary 计算后调用。
   */
  upsertSummary(args: {
    projectKey: string
    sessionId: string
    mtime: number
    data: Record<string, unknown>
  }): Promise<void>

  /**
   * 删除一个 session（含所有 entries 和 summary）。
   * 包括所有 subpath 下的 entries（subagent transcripts）。
   */
  deleteSession(key: SessionKey): Promise<void>

  /**
   * 列出某个 session 下的所有 subpath（subagent transcripts）。
   */
  listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]>

  /**
   * 写入会话消息元数据（PR #4.6）。
   *
   * 由 CloudBaseSessionStore 在 appendEntries 内部调用，从 SDKMessage 中提取关键标识。
   *
   * 实现要求：
   *   - 从 entries 中提取 assistant/user 类型的 SDKMessage
   *   - 提取关键标识：messageId、role、createdAt、status
   *   - 写入 oak_session_messages 集合
   *   - 必须把 entry.uuid 作为幂等键（已存在则忽略，不抛错）
   */
  appendSessionMessage(key: SessionKey, entries: SessionStoreEntry[]): Promise<void>

  /**
   * 查询会话消息元数据（分页）。
   *
   * @param opts.limit 可选：返回条数上限（默认 100）
   * @param opts.before 可选：返回此时间戳之前的消息（用于分页）
   * @param opts.after 可选：返回此时间戳之后的消息（用于增量同步）
   */
  querySessionMessages(
    projectKey: string,
    conversationId: string,
    opts?: {
      limit?: number
      before?: number
      after?: number
    },
  ): Promise<SessionMessageMeta[]>

  /**
   * 删除某个会话的所有消息元数据。
   */
  deleteSessionMessages(key: SessionKey): Promise<void>
}

/**
 * 把 SessionKey 编码成扁平字符串，用作 entries 集合里的 sessionKey 字段。
 * 编码规则（确保稳定可解析）：
 *   - 主 transcript：`${projectKey}|${sessionId}`
 *   - subagent：    `${projectKey}|${sessionId}|${subpath}`
 *
 * 注意：projectKey/sessionId/subpath 内含 `|` 时按 SDK 文档约定不会发生
 * （projectKey 已被 SDK 在 200 字符截断 + djb2 hash 处理，sessionId 是 UUID，
 *  subpath 是 SDK 内部生成的标识符）。
 */
export function encodeSessionKey(key: SessionKey): string {
  if (key.subpath !== undefined && key.subpath.length > 0) {
    return `${key.projectKey}|${key.sessionId}|${key.subpath}`
  }
  return `${key.projectKey}|${key.sessionId}`
}
