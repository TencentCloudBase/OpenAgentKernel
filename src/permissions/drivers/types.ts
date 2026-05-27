/**
 * PermissionStoreDriver: 抽象出"审批状态落到哪里"的协议（PR #7.1）。
 *
 * 与 SessionStoreDriver 同套路：
 *   - PermissionStore        = kernel 协议层（PR #7.0 定义，hook / respondApproval 直接调用）
 *   - PermissionStoreDriver  = 与具体后端解耦的存储抽象
 *
 * 当前提供两个实现：
 *   - InMemoryPermissionDriver        测试 / 开发 / 单进程默认（封装在 store.ts InMemoryPermissionStore 内）
 *   - CloudBaseDbPermissionDriver     生产用（落 CloudBase 数据库单集合）
 *
 * 未来可加：
 *   - PostgresPermissionDriver、RedisPermissionDriver、MongoPermissionDriver 等
 *
 * 设计要点：
 *   1. 所有方法都接受 `projectKey`（即 envId）做多租户隔离
 *   2. driver 不感知 PR #7.0 的"流终止 + resume"协议，只负责 KV 存取
 *   3. `scanRecent` 是 PR #7.0 hook 兜底路径需要的能力，driver 必须实现（分布式 store
 *      场景必备：模型 resume 后用新 toolUseId 重发同 toolName，hook 通过 toolName 找回旧 decision）
 */

import type { PendingApproval } from '../../public/types.js'

export interface PermissionStoreDriver {
  /**
   * 写入 / 覆盖 pending entry（put pending、写决策、消费后写空均走这里）。
   *
   * 实现要求：
   *   - 主键为 (projectKey, conversationId, toolUseId)，重复写入应为 upsert
   *   - 不能解释 entry 内部结构（透明转储）
   *   - 必须更新 mtime 为当前时间（用于 scanRecent 排序）
   */
  put(args: { projectKey: string; entry: PendingApproval }): Promise<void>

  /**
   * 按 (projectKey, conversationId, toolUseId) 取回 entry。
   * 不存在返回 null。
   */
  get(args: { projectKey: string; conversationId: string; toolUseId: string }): Promise<PendingApproval | null>

  /** 删除 entry（不存在不抛错） */
  delete(args: { projectKey: string; conversationId: string; toolUseId: string }): Promise<void>

  /**
   * 扫描某 (projectKey, conversationId) 下"已决策"且最新的同 toolName entry。
   *
   * PR #7.0 hook 关键路径：模型 resume 后用新 toolUseId 重发同 toolName 工具，
   * hook 通过 scanRecent 按 toolName 兜底找回旧 decision。
   *
   * 实现要求：
   *   - 过滤条件：projectKey + conversationId + toolName + decision != null
   *   - 排序：createdAt desc（取最新）
   *   - 返回 1 条；无匹配返回 null
   *
   * 性能建议：分布式 driver 应在 (projectKey, conversationId, toolName, createdAt desc) 上建索引。
   */
  scanRecent(args: { projectKey: string; conversationId: string; toolName: string }): Promise<PendingApproval | null>
}
