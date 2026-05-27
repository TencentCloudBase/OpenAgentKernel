/**
 * Sandbox 模块公共导出。
 *
 * 用法：
 *   ```ts
 *   import { createAgent, AgsStatefulSandbox } from '@cloudbase/open-agent-kernel'
 *
 *   const agent = createAgent({
 *     envId: 'my-env',
 *     model: 'glm-5.1',
 *     sandbox: { runtime: new AgsStatefulSandbox() },
 *   })
 *   ```
 */

export type { SandboxRuntime, SandboxInstance, SandboxAcquireContext } from './types.js'

export { AgsStatefulSandbox, type AgsStatefulSandboxOptions } from './ags-stateful-sandbox.js'

export { createSandboxMcpServer } from './sandbox-tools.js'

export {
  createCloudBaseMcpServer,
  type CreateCloudBaseMcpOptions,
  type CloudBaseMcpBundle,
  type CloudBaseUserCredentials,
} from './cloudbase-mcp.js'
