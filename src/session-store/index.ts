/**
 * session-store 模块导出
 *
 * 公共 API：
 *   - CloudBaseSessionStore     主入口，注入到 Claude Agent SDK 的 sessionStore 选项
 *   - InMemoryDriver            测试 / 本地 demo 用
 *   - CloudBaseDbDriver         生产用（CloudBase 数据库）
 *   - SessionStoreDriver        协议接口（用户可实现自定义 driver）
 */

export { CloudBaseSessionStore, type CloudBaseSessionStoreOptions } from './cloudbase-session-store.js'

export { InMemoryDriver } from './drivers/in-memory-driver.js'

export {
  CloudBaseDbDriver,
  type CloudBaseDbDriverOptions,
  type CloudBaseCredentials,
} from './drivers/cloudbase-db-driver.js'

export { encodeSessionKey, type SessionStoreDriver } from './drivers/types.js'
