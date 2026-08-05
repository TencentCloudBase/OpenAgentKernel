import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ConfigError, SandboxError } from '../internal/errors.js'
import type { SandboxAcquireContext, SandboxInstance, SandboxRuntime } from './types.js'

export interface LocalRuntimeSandboxOptions {
  /**
   * Local runtime workspace root. If omitted, acquire() derives a per-session
   * directory from OAK_WORKSPACE_ROOT or os.tmpdir().
   */
  workspaceRoot?: string
  /**
   * AgentConfig.cwd mirrored into the runtime by createAgent(). It has higher
   * priority than workspaceRoot because Claude SDK built-in tools run from cwd.
   */
  cwd?: string
}

/**
 * Local Runtime Sandbox(provider='local')。
 *
 * 在 OAK 宿主进程内创建/校验一个可写工作目录,返回一个轻量 SandboxInstance。
 * 不暴露 HTTP 数据面 —— SDK 内置工具(Bash/Read/Write/Edit/Glob/Grep)直接操作
 * 该目录。
 *
 * cwd 跨容器/请求的持久化由 AgentConfig.workspacePersist 负责(tar.gz 单包归档到
 * COS),与本 provider 正交:local provider 只管"工作目录现在可用",workspacePersist
 * 管"工作目录的内容跨请求可恢复"。
 */
export class LocalRuntimeSandbox implements SandboxRuntime {
  readonly backend = 'local'

  private readonly options: LocalRuntimeSandboxOptions

  constructor(options: LocalRuntimeSandboxOptions = {}) {
    if (options.cwd && options.workspaceRoot && path.resolve(options.cwd) !== path.resolve(options.workspaceRoot)) {
      throw new ConfigError(
        'AgentConfig.cwd and sandbox.workspaceRoot must point to the same directory when sandbox.provider is local.',
      )
    }
    this.options = options
  }

  async acquire(ctx: SandboxAcquireContext): Promise<SandboxInstance> {
    const workspaceRoot = this.resolveWorkspaceRoot(ctx)
    await fs.mkdir(workspaceRoot, { recursive: true })
    // 可写性检查交给 buildClaudeQueryOptions 里的 probeWritable(基于 fs.access,
    // 单次 syscall 无 IO 副作用)——不在 acquire 里再写 probe 文件,避免重复 IO。

    ctx.onProgress?.({
      phase: 'local_workspace',
      message: 'local sandbox workspace is ready',
    })

    return {
      id: `local:${ctx.conversationId}`,
      backend: this.backend,
      workspaceRoot,
      async request(): Promise<Response> {
        throw new SandboxError(
          'LocalRuntimeSandbox does not expose an HTTP data plane. Use Claude SDK built-in tools in local mode.',
        )
      },
      async release(): Promise<void> {
        // local provider 不删除本地目录(workspacePersist 以 COS 为 source of truth,
        // 本地目录可被复用)。最终 snapshot 由 workspacePersist 在 send-end 触发。
      },
    }
  }

  private resolveWorkspaceRoot(ctx: SandboxAcquireContext): string {
    const configuredRoot = this.options.cwd ?? this.options.workspaceRoot
    if (configuredRoot) return path.resolve(configuredRoot)

    const base = process.env.OAK_WORKSPACE_ROOT || path.join(os.tmpdir(), 'oak-workspaces')
    return path.resolve(
      base,
      safeSegment(ctx.envId),
      safeSegment(ctx.userId ?? 'default'),
      safeSegment(ctx.conversationId),
    )
  }
}

function safeSegment(input: string): string {
  const normalized = input.replace(/[^a-zA-Z0-9._-]/g, '-')
  return normalized || 'default'
}
