/**
 * PermissionStore 实现 + 规则匹配（PR #7.0）。
 *
 * 设计原则参考 docs/open-agent-kernel-design.md 第 7 节：
 *   - HITL 实现为"流终止 + respondApproval + 重新进入"范式（OpenAI Agents SDK 风格），
 *     不绑死单进程 Promise（Claude SDK canUseTool 路径）
 *   - kernel 不内置 Redis；分布式由 PermissionStore 接口 + driver（PR #7.1 落 CloudBase）解决
 *
 * 本文件提供：
 *   - InMemoryPermissionStore：开箱即用的进程内 store（单进程足够）
 *   - matchRequireApprovalRule：规则匹配（字符串/通配符/数组/函数）
 *   - isStaleApproval：超时判定
 */

import type {
  PendingApproval,
  PermissionStore,
  RequireApprovalRule,
} from '../public/types.js'

/**
 * 默认审批超时：30 分钟（与 tcb-headless-service.copilot 对齐）。
 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000

/**
 * 进程内 PermissionStore（默认实现）。
 *
 * 单进程下完全可用；多副本部署 / 云函数 / 跨设备审批需要用分布式 store
 * （PR #7.1 提供 CloudBasePermissionStore）。
 */
export class InMemoryPermissionStore implements PermissionStore {
  private readonly entries = new Map<string, PendingApproval>()

  async put(call: PendingApproval): Promise<void> {
    this.entries.set(buildKey(call.conversationId, call.toolUseId), call)
  }

  async get(key: {
    conversationId: string
    toolUseId: string
  }): Promise<PendingApproval | null> {
    return this.entries.get(buildKey(key.conversationId, key.toolUseId)) ?? null
  }

  async delete(key: {
    conversationId: string
    toolUseId: string
  }): Promise<void> {
    this.entries.delete(buildKey(key.conversationId, key.toolUseId))
  }

  /**
   * 扫描某 conversationId 内"已决策但未消费"的同 toolName entry。
   *
   * PR #7.0 关键路径：模型 resume 后用新 toolUseId 重发同 toolName 工具，
   * hook 通过 scanRecent 找到旧 entry 并按其 decision 处理。
   *
   * 这是 InMemoryPermissionStore 特有的快速路径；分布式 store（PR #7.1）应在
   * 持久化层加 (conversationId, toolName, decision != null) 索引以提供等价能力。
   */
  async scanRecent(key: {
    conversationId: string
    toolName: string
  }): Promise<PendingApproval | null> {
    let best: PendingApproval | null = null
    for (const entry of this.entries.values()) {
      if (
        entry.conversationId === key.conversationId &&
        entry.toolName === key.toolName &&
        entry.decision !== undefined
      ) {
        // 取最新的（createdAt 大）
        if (!best || entry.createdAt > best.createdAt) {
          best = entry
        }
      }
    }
    return best
  }

  /** 调试用：列出当前所有 pending entry（不在公共 API） */
  _debugList(): PendingApproval[] {
    return [...this.entries.values()]
  }
}

function buildKey(conversationId: string, toolUseId: string): string {
  return `${conversationId}::${toolUseId}`
}

/**
 * 把 PR #7.0 的 RequireApprovalRule 编译成统一 predicate。
 *
 * 通配符支持：
 *   - `'*'` 匹配任意工具
 *   - `'Bash'` 严格匹配
 *   - `'mcp__cloudbase__*'` 前缀匹配（末尾 `*`）
 *   - `'*Database*'` 含 `*` 的子串/前缀混合（实现为 glob → regex）
 *
 * 不需要审批时返回 () => false。
 */
export function compileRequireApprovalPredicate(
  rule: RequireApprovalRule | undefined,
): (ctx: {
  toolName: string
  input: unknown
  conversationId: string
}) => boolean | Promise<boolean> {
  if (rule == null) {
    return () => false
  }
  if (typeof rule === 'function') {
    return rule
  }
  const patterns = Array.isArray(rule) ? rule : [rule]
  const regexes = patterns.map(globToRegex)
  return (ctx) => regexes.some((re) => re.test(ctx.toolName))
}

/**
 * 把 glob 模式转成 RegExp（仅支持 `*` 通配，其他字符按字面）。
 *
 * 示例：
 *   `*`                  → /^.*$/
 *   `Bash`               → /^Bash$/
 *   `mcp__cloudbase__*`  → /^mcp__cloudbase__.*$/
 */
function globToRegex(pattern: string): RegExp {
  if (pattern === '*') return /^.*$/
  // 转义 RegExp 元字符（除 `*` 外），把 `*` 替换为 `.*`
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

/**
 * pendingApproval 是否已超时。
 *
 * @param call pending entry
 * @param timeoutMs 配置的超时（毫秒）
 * @param now 当前时间（注入便于测试，默认 Date.now()）
 */
export function isStaleApproval(
  call: PendingApproval,
  timeoutMs: number,
  now: number = Date.now(),
): boolean {
  return now - call.createdAt > timeoutMs
}
