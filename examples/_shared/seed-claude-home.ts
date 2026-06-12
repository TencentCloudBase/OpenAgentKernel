/**
 * seed-claude-home.ts — 测试辅助:把内容预先写到 envId 对应的 CloudBase COS,
 * 模拟"用户之前已经累积了一些 .claude/ 配置"的状态。
 *
 * 用途:examples 16/17 验证 OAK 同步引擎能否在 SDK 启动 pull 时把这些预置内容
 *       带到本地,SDK 启动时把 CLAUDE.md 注入 prompt,模型据此回答。
 *
 * 注意:这里直接 deep-import OAK 内部的 CloudBaseCosClaudeHomeStore — 在示例
 *       场景下可接受(为了真实模拟 COS 上已有内容),业务方代码不应这样做。
 */

import { CloudBaseCosClaudeHomeStore } from '../../src/claude-home/cloudbase-cos-store.js'
import type { PlatformCredentials } from '@cloudbase/open-agent-kernel'

export interface SeedFile {
  /** 相对 CLAUDE_CONFIG_DIR 的路径,例:'CLAUDE.md' / 'agent-memory/code-reviewer/MEMORY.md' */
  relPath: string
  /** 文件内容 */
  content: string
}

/**
 * 把多个文件写入 (envId, userId) 对应的 COS 命名空间。
 *
 * 失败会抛 — 调用方负责处理(测试里通常希望失败立刻可见)。
 */
export async function seedClaudeHome(args: {
  envId: string
  userId: string
  credentials: PlatformCredentials
  files: SeedFile[]
}): Promise<void> {
  const store = new CloudBaseCosClaudeHomeStore({ credentials: args.credentials })
  for (const file of args.files) {
    await store.put({ envId: args.envId, userId: args.userId }, file.relPath, Buffer.from(file.content, 'utf8'))
    // eslint-disable-next-line no-console
    console.log(`[seed] wrote ${file.relPath} (${file.content.length} bytes) to COS`)
  }
}

/**
 * 清空 (envId, userId) 命名空间下我们 seed 过的文件。
 *
 * 不会列举 COS 自动发现 — 调用方传入需要清理的 relPath 列表(通常就是 seed 时用的那些)。
 */
export async function clearSeededClaudeHome(args: {
  envId: string
  userId: string
  credentials: PlatformCredentials
  relPaths: string[]
}): Promise<void> {
  const store = new CloudBaseCosClaudeHomeStore({ credentials: args.credentials })
  for (const relPath of args.relPaths) {
    await store.delete({ envId: args.envId, userId: args.userId }, relPath)
    // eslint-disable-next-line no-console
    console.log(`[seed] deleted ${relPath} from COS`)
  }
}
