/**
 * Sandbox runtime 协议。
 *
 * SandboxRuntime 抽象不同后端：
 * - PR #6A：`AgsStatefulSandbox`（腾讯云 Agent Sandbox 产品）
 * - 未来：`LocalDockerSandbox` / `E2bSandbox` 等
 *
 * 协议设计参考 OpenVibeCoding `feature/stateful-infra` 分支
 * `packages/server/src/sandbox/provider/types.ts` 的 `SandboxProvider` 接口，
 * 但做了大幅精简（PR #6A 不需要 prepare/release 的复杂上下文）。
 */

/**
 * 沙箱实例（acquire 后返回）。
 *
 * 实例在 session 生命周期内 by 调用方持有，session 结束时调用 `release()`。
 */
export interface SandboxInstance {
  /** 实例唯一 ID（例：AGS InstanceId） */
  readonly id: string

  /**
   * 在沙箱内调用一次 HTTP 接口（数据面）。
   * AGS 模式下：`POST /api/tools/{name}` / `PUT /api/workspace/env` 等。
   *
   * runtime 内部负责拼接 baseUrl + headers，调用方只传相对 path 和 body。
   */
  request(path: string, init?: RequestInit): Promise<Response>

  /** 释放实例（PR #6A：发 PauseSandboxInstance；后续可改为按需销毁） */
  release(): Promise<void>
}

/**
 * Sandbox runtime（一个长期对象，跨 session 复用 acquire/release 入口）。
 *
 * - `acquire(ctx)` 返回一个具体的 `SandboxInstance`（PR #6A 每个 session 独立实例）
 * - 内部负责 ensureTool（template）+ StartInstance + warmup readiness probe
 */
export interface SandboxRuntime {
  /**
   * Runtime 类型标识。诊断日志 + 业务逻辑判定(如 `workspaceSnapshot: 'auto'` 模式)。
   *
   * 当前可识别值:
   * - 'ags-stateful'  → AGS 沙箱 stateful 模式(支持 /api/workspace/snapshot)
   * - 其他            → workspaceSnapshot='auto' 不启用快照
   *
   * 未来扩展:'ags-stateless' / 'docker-local' / 'firecracker' / 'e2b' 等。
   */
  readonly backend: string

  /**
   * 申请一个沙箱实例。
   * @param ctx kernel 在 session 创建时传入的上下文
   */
  acquire(ctx: SandboxAcquireContext): Promise<SandboxInstance>
}

/**
 * acquire 调用上下文。
 */
export interface SandboxAcquireContext {
  /** 业务 envId（多租户隔离的根） */
  envId: string
  /** 当前 session 的 conversationId */
  conversationId: string
  /**
   * 实例粒度：
   * - 'session'：每个 session 一个独立实例（默认，PR #6A 行为）
   * - 'shared'：同 envId 多 session 共享一个实例（PR #6B 新增）
   */
  scope?: 'session' | 'shared'
  /** 进度回调（warmup 期间汇报状态） */
  onProgress?: (msg: { phase: string; message: string }) => void
}
