/**
 * CloudBaseClientToolStore: 分布式 ClientToolResultStore 实现。
 *
 * 参照 CloudBasePermissionStore 的模式，薄封装注入 projectKey。
 *
 * 用法：
 *   import { CloudBaseClientToolStore, CloudBaseDbClientToolDriver } from '@cloudbase/open-agent-kernel'
 *
 *   const store = new CloudBaseClientToolStore({
 *     driver: new CloudBaseDbClientToolDriver(),
 *     projectKey: envId,
 *   })
 *
 *   createAgent({
 *     ...config,
 *     toolStore: store,
 *   })
 */

import type { ClientToolResultStore, PendingClientToolResult } from './hooks.js'
import type { ClientToolResultStoreDriver } from './drivers/types.js'

export interface CloudBaseClientToolStoreOptions {
  driver: ClientToolResultStoreDriver
  projectKey: string
}

export class CloudBaseClientToolStore implements ClientToolResultStore {
  private readonly driver: ClientToolResultStoreDriver
  private readonly projectKey: string

  constructor(opts: CloudBaseClientToolStoreOptions) {
    this.driver = opts.driver
    this.projectKey = opts.projectKey
  }

  async put(entry: PendingClientToolResult): Promise<void> {
    return this.driver.put({ projectKey: this.projectKey, entry })
  }

  async get(key: { conversationId: string; toolUseId: string }): Promise<PendingClientToolResult | null> {
    return this.driver.get({ projectKey: this.projectKey, ...key })
  }

  async delete(key: { conversationId: string; toolUseId: string }): Promise<void> {
    return this.driver.delete({ projectKey: this.projectKey, ...key })
  }

  async scanRecent(key: { conversationId: string; toolName: string }): Promise<PendingClientToolResult | null> {
    return this.driver.scanRecent({ projectKey: this.projectKey, ...key })
  }
}
