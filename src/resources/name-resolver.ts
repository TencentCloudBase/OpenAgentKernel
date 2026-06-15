/**
 * CloudBase 资源命名派生（internal）。
 *
 * 模型路由走 CloudBase AI gateway：
 *   `https://${envId}.api.tcloudbasegateway.com/v1/ai/cloudbase`
 *
 * DB 表名由 session.tablePrefix / permissions.tablePrefix 等能力配置管理。
 */

/**
 * 模型网关 baseURL。
 */
export function defaultCloudBaseAiBaseUrl(envId: string): string {
  return `https://${envId}.api.tcloudbasegateway.com/v1/ai/cloudbase`
}
