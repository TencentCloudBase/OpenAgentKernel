/**
 * InMemoryPermissionDriver: 进程内 PermissionStoreDriver 实现（PR #7.1）。
 *
 * 单进程下完全可用；多副本部署 / 云函数 / 跨设备审批需要用分布式 driver
 * （CloudBaseDbPermissionDriver）。
 *
 * 注意：PR #7.0 的 InMemoryPermissionStore 仍保留作为 zero-config 默认实现
 * （PR #7.0 兼容，无需改动）。本 driver 主要给 CloudBasePermissionStore 在
 * driver 不传时做兜底，行为与 PR #7.0 InMemoryPermissionStore 完全一致。
 */

import type { PendingApproval } from '../../public/types.js'
import type { PermissionStoreDriver } from './types.js'

export class InMemoryPermissionDriver implements PermissionStoreDriver {
  private readonly entries = new Map<string, PendingApproval>()

  async put(args: { projectKey: string; entry: PendingApproval }): Promise<void> {
    this.entries.set(buildKey(args.projectKey, args.entry.conversationId, args.entry.toolUseId), args.entry)
  }

  async get(args: { projectKey: string; conversationId: string; toolUseId: string }): Promise<PendingApproval | null> {
    return this.entries.get(buildKey(args.projectKey, args.conversationId, args.toolUseId)) ?? null
  }

  async delete(args: { projectKey: string; conversationId: string; toolUseId: string }): Promise<void> {
    this.entries.delete(buildKey(args.projectKey, args.conversationId, args.toolUseId))
  }

  async scanRecent(args: {
    projectKey: string
    conversationId: string
    toolName: string
  }): Promise<PendingApproval | null> {
    let best: PendingApproval | null = null
    const prefix = `${args.projectKey}::${args.conversationId}::`
    for (const [k, entry] of this.entries.entries()) {
      if (!k.startsWith(prefix)) continue
      if (entry.toolName !== args.toolName) continue
      if (entry.decision === undefined) continue
      if (!best || entry.createdAt > best.createdAt) {
        best = entry
      }
    }
    return best
  }

  /** 调试用：列出所有 entry */
  _debugList(): PendingApproval[] {
    return [...this.entries.values()]
  }
}

function buildKey(projectKey: string, conversationId: string, toolUseId: string): string {
  return `${projectKey}::${conversationId}::${toolUseId}`
}
