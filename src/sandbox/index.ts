/**
 * Sandbox 模块公共导出。
 *
 * 用法：
 *   ```ts
 *   import { createAgent } from '@cloudbase/open-agent-kernel'
 *
 *   const agent = createAgent({
 *     envId: 'my-env',
 *     model: 'glm-5.1',
 *     sandbox: { enabled: true },
 *   })
 *   ```
 *
 * provider 默认为 'ags-stateful'；显式选择 'local' 可在 OAK 宿主进程内直接
 * 操作本地 FS（云函数 / CloudRun 等已有可写目录的 serverless runtime）：
 *
 *   ```ts
 *   createAgent({
 *     envId: 'my-env',
 *     model: 'glm-5.1',
 *     cwd: '/tmp/oak-workspaces/demo',
 *     sandbox: { enabled: true, provider: 'local' },
 *   })
 *   ```
 *
 * 高级用户仍可显式传入 `sandbox.runtime` 覆盖默认 provider 实现。
 */

export type { SandboxRuntime, SandboxInstance, SandboxAcquireContext } from './types.js'

export { AgsStatefulSandbox, type AgsStatefulSandboxOptions } from './ags-stateful-sandbox.js'

export { LocalRuntimeSandbox, type LocalRuntimeSandboxOptions } from './local-runtime-sandbox.js'

export { createSandboxMcpServer } from './sandbox-tools.js'

export {
  createCloudBaseMcpServer,
  type CreateCloudBaseMcpOptions,
  type CloudBaseMcpBundle,
  type CloudBaseUserCredentials,
} from './cloudbase-mcp.js'

export {
  createCloudBaseMcpServerInProcess,
  type CreateCloudBaseMcpInProcessOptions,
} from './cloudbase-mcp-inprocess.js'
