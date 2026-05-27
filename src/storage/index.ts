/**
 * storage 模块导出
 *
 * 公共 API：
 *   - StorageProvider     协议接口
 *   - InMemoryStorage     测试 / 本地 demo（base64 内联）
 *   - CloudBaseStorage    生产用（落 CloudBase 云存储）
 */

export type {
  StorageProvider,
  ResolvedAttachment,
  ResolveContext,
  ImageSource,
} from './types.js'

export { InMemoryStorage } from './in-memory-storage.js'
export {
  CloudBaseStorage,
  type CloudBaseStorageOptions,
  type CloudBaseStorageCredentials,
} from './cloudbase-storage.js'
