/**
 * OAK 本地路径派生 —— 统一的 `.oak/` 布局 + 路径段 sanitize。
 *
 * 设计:所有 OAK 自管的本地目录统一落在 `<workRoot>/.oak/` 下,按"作用域"分子树,
 * 便于按子树一刀切分配权限(chown/chmod):
 *
 *   <workRoot>/.oak/
 *   ├── agent/.claude/                 ① Agent 全局配置(CLAUDE_CONFIG_DIR 默认)
 *   ├── users/<env>/<user>/.claude/    ② 使用者(C 用户)配置(userMemory 启用时)
 *   └── sync/put-<rand>/               ④ COS 同步临时区(全局级)
 *
 * 注:session 工作目录(cwd)不归 .oak 管 —— 由调用方(agent runtime)显式传
 * AgentConfig.cwd,kernel 不替宿主决定 session 目录的位置/隔离/GC。
 *
 * 用 `.oak`(点开头隐藏目录)遵循 Unix 惯例(.config/.cache/.claude),
 * 避免污染工作目录、且在 ls 里不碍眼。
 *
 * workRoot 解析(见 resolveWorkRoot):home 优先(本地持久、符合 claude CLI ~/.claude
 * 惯例),home 不可写时兜底 os.tmpdir()(serverless 保证可写);可由 OAK_SESSION_LOCAL_DIR
 * 覆盖(部署层指定根,最高优先级)。
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const ALLOWED_CHAR_RE = /^[a-zA-Z0-9._-]+$/
const REPLACE_FORBIDDEN_RE = /[^a-zA-Z0-9._-]/g

/** OAK 统一根目录段名(点开头,Unix 隐藏目录惯例)。 */
export const OAK_ROOT_SEGMENT = '.oak'

/**
 * 探测目录可写性(在 <dir>/.oak 下试建探测文件再删)。不抛错,返回 boolean。
 * 只在 resolveWorkRoot 内用,结果被进程级缓存,不反复 IO。
 */
function isDirWritable(dir: string): boolean {
  try {
    const probeDir = path.join(dir, OAK_ROOT_SEGMENT)
    mkdirSync(probeDir, { recursive: true })
    const probe = path.join(probeDir, `.write-probe-${randomBytes(3).toString('hex')}`)
    writeFileSync(probe, 'x')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/**
 * 解析 OAK 的可写工作根(workRoot)。优先级:
 *   1) OAK_SESSION_LOCAL_DIR 显式设了 → 原样尊重(部署层指定,最高优先级)
 *   2) os.homedir() 可写 → 用它(本地开发:~/.oak,持久 + 符合 claude CLI ~/.claude 惯例)
 *   3) 否则 → os.tmpdir()(serverless 保证可写;home 常只读/不存在,用它会让子进程
 *      静默 exit 0 + 0 输出)
 *
 * 探测结果进程级缓存:本函数被多处派生反复调用,只在首次做一次磁盘探测。
 * 不锁死实现:任何场景都能用 OAK_SESSION_LOCAL_DIR 覆盖。
 */
let workRootCache: string | undefined
export function resolveWorkRoot(): string {
  const explicit = process.env.OAK_SESSION_LOCAL_DIR
  if (explicit) return explicit // 显式配置不缓存(允许运行时/测试改环境变量)
  if (workRootCache) return workRootCache
  let home: string | undefined
  try {
    home = os.homedir()
  } catch {
    home = undefined
  }
  workRootCache = home && isDirWritable(home) ? home : os.tmpdir()
  return workRootCache
}

/** `<workRoot>/.oak` —— 所有 OAK 自管目录的统一前缀。 */
export function getOakRoot(): string {
  return path.join(resolveWorkRoot(), OAK_ROOT_SEGMENT)
}

/**
 * 把单个路径段中不允许的字符替换为下划线。
 * 允许字符:[a-zA-Z0-9._-]。空字符串抛错(避免派生出空段)。
 *
 * 注意:`..` 在 sanitize 后仍是 `..`(因为 . 被允许)。这不会造成路径穿越,
 * 因为派生函数都用 path.join 接 workRoot,最终路径仍在 workRoot 内。
 */
export function sanitizePathSegment(s: string): string {
  if (s.length === 0) {
    throw new Error('sanitizePathSegment: input must be non-empty')
  }
  if (ALLOWED_CHAR_RE.test(s)) return s
  return s.replace(REPLACE_FORBIDDEN_RE, '_')
}

/**
 * ① Agent 全局配置目录(CLAUDE_CONFIG_DIR 默认兜底)。
 *
 * 路径形如:`<workRoot>/.oak/agent/.claude`
 *
 * 这是没启用 userMemory 时 claude CLI 的 home —— settings/sessions/锁文件/
 * XDG state 等都落在这里。per-agent(进程级)共享,不区分用户。
 */
export function deriveAgentConfigDir(): string {
  return path.join(getOakRoot(), 'agent', '.claude')
}

/**
 * ② 使用者(C 用户)配置目录(userMemory 启用时的 CLAUDE_CONFIG_DIR)。
 *
 * 路径形如:`<workRoot>/.oak/users/<safeEnvId>/<safeUserId>/.claude`
 *
 * 同 (envId, userId) 永远派生相同路径(确定性)—— 这是 userMemory 跨节点
 * 复用的前提:COS 同步把这个目录拉下来,同一用户在任何容器实例都指向同一路径。
 */
export function deriveClaudeConfigDir(envId: string, userId: string): string {
  if (!envId) throw new Error('deriveClaudeConfigDir: envId is required')
  if (!userId) throw new Error('deriveClaudeConfigDir: userId is required')
  const safeEnv = sanitizePathSegment(envId)
  const safeUser = sanitizePathSegment(userId)
  return path.join(getOakRoot(), 'users', safeEnv, safeUser, '.claude')
}

/**
 * ④ COS 同步临时区(全局级)。
 *
 * 路径形如:`<workRoot>/.oak/sync` —— 调用方在其下 mkdtemp(`put-`) 做临时桥接。
 */
export function deriveSyncTmpDir(): string {
  return path.join(getOakRoot(), 'sync')
}
