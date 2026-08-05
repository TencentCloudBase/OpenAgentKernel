/**
 * @internal
 * resources/ 模块统一导出。
 * 不对外暴露给用户（kernel 公共 API 只通过 `public/` 目录）。
 */

export { defaultCloudBaseAiBaseUrl } from './name-resolver.js'

export { resolveApiKey, type ResolvedApiKey } from './credential-provider.js'
