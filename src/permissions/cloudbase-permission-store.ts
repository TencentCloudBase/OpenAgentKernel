/**
 * CloudBasePermissionStore: 实现 PermissionStore 接口（PR #7.1）。
 *
 * 职责：
 *   - 桥接 PR #7.0 的 PermissionStore 协议到 PermissionStoreDriver
 *   - 多租户隔离：用 envId 作为 projectKey
 *   - 透传 scanRecent（duck-type，hook 通过 `'scanRecent' in store` 判定可用）
 *
 * 设计参考 CloudBaseSessionStore：driver 不传则用 InMemoryPermissionDriver 兜底，
 * 这样测试 / 本地开发可以直接 `new CloudBasePermissionStore({ projectKey: 'test' })`。
 *
 * 生产用法：
 *   ```ts
 *   import {
 *     CloudBasePermissionStore,
 *     CloudBaseDbPermissionDriver,
 *   } from '@cloudbase/open-agent-kernel'
 *
 *   const store = new CloudBasePermissionStore({
 *     projectKey: process.env.TCB_ENV_ID!,
 *     driver: new CloudBaseDbPermissionDriver(),
 *   })
 *
 *   const agent = createAgent({
 *     envId: process.env.TCB_ENV_ID!,
 *     permissions: { requireApproval: '*', store },
 *     ...
 *   })
 *   ```
 *
 * 分布式 e2e 流程：
 *   - 节点 A 上 `session.send(prompt)` → hook 命中 requireApproval → 写 entry 到 CloudBase DB → 流终止
 *   - 节点 B 上 `session.respondApproval({ toolUseId, decision })` → 写 decision 到同一行 →
 *     起 SDK resume → hook 从 DB 读到 decision → 放行 → agent 继续
 */

import type {
  PendingApproval,
  PermissionStore,
} from '../public/types.js'
import { InMemoryPermissionDriver } from './drivers/in-memory-driver.js'
import type { PermissionStoreDriver } from './drivers/types.js'

export interface CloudBasePermissionStoreOptions {
  /**
   * 多租户隔离键（强烈建议传 envId）。
   *
   * 同一 driver 后端可能服务多个 envId，所有 store 操作都会带上这个 projectKey
   * 做隔离，避免跨租户读到彼此的 pending entry。
   *
   * 不传则用 'default'（仅适合单租户 / 本地测试）。
   */
  projectKey?: string

  /**
   * 存储驱动。不传则使用 InMemoryPermissionDriver（适合测试 / 本地 demo）。
   *
   * 生产环境应注入 CloudBaseDbPermissionDriver：
   *   ```ts
   *   import { CloudBaseDbPermissionDriver, CloudBasePermissionStore } from '@cloudbase/open-agent-kernel'
   *   const store = new CloudBasePermissionStore({
   *     projectKey: envId,
   *     driver: new CloudBaseDbPermissionDriver(),
   *   })
   *   ```
   */
  driver?: PermissionStoreDriver
}

const DEFAULT_PROJECT_KEY = 'default'

export class CloudBasePermissionStore implements PermissionStore {
  private readonly driver: PermissionStoreDriver
  private readonly projectKey: string

  constructor(opts: CloudBasePermissionStoreOptions = {}) {
    this.driver = opts.driver ?? new InMemoryPermissionDriver()
    this.projectKey = opts.projectKey ?? DEFAULT_PROJECT_KEY
  }

  /** 暴露底层 driver（高阶用户可绕过 PermissionStore 直接操作） */
  getDriver(): PermissionStoreDriver {
    return this.driver
  }

  // ─── PermissionStore 接口实现 ────────────────────────────────────

  async put(call: PendingApproval): Promise<void> {
    await this.driver.put({ projectKey: this.projectKey, entry: call })
  }

  async get(key: {
    conversationId: string
    toolUseId: string
  }): Promise<PendingApproval | null> {
    return this.driver.get({ projectKey: this.projectKey, ...key })
  }

  async delete(key: {
    conversationId: string
    toolUseId: string
  }): Promise<void> {
    await this.driver.delete({ projectKey: this.projectKey, ...key })
  }

  // ─── PR #7.0 hook 兜底路径用（duck-type 调用，无接口约束） ─────────
  /**
   * 扫描某 conversationId 内"已决策"且最新的同 toolName entry。
   *
   * PR #7.0 hook 需要：模型 resume 后用新 toolUseId 重发同 toolName，
   * hook 通过 toolName 兜底找回旧 decision。
   *
   * driver 在 (projectKey, conversationId, toolName, createdAt desc) 上建索引会更快。
   */
  async scanRecent(key: {
    conversationId: string
    toolName: string
  }): Promise<PendingApproval | null> {
    return this.driver.scanRecent({ projectKey: this.projectKey, ...key })
  }
}
