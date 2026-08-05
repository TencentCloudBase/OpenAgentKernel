/**
 * cwd 工作目录持久化的同步规则。
 *
 * 与 userMemory 的 sync-rules(白名单:仅 memory .md)相反,cwd 持久化是
 * **全量同步 + 排除黑名单**:claude 在 cwd 里产生的用户产物/代码都要持久,
 * 但必须排除大体积/可重建/SDK 内部目录,否则每轮 send 会把海量文件推上 COS。
 *
 * 提供两个判定:
 *   - shouldPruneCwdDir(relPath):目录级剪枝(顶层 node_modules/.git 等整棵跳过)
 *   - matchesCwdSyncRule(relPath):文件级是否同步
 */

/**
 * 默认排除的顶层目录名(大体积 / 可重建 / VCS / SDK 内部 / 本 kernel 自管)。
 * 注意:.oak 和 .claude 必须排除 —— 它们是 kernel/claude 的配置区,不属于工作产物。
 */
export const DEFAULT_CWD_EXCLUDES: readonly string[] = [
  'node_modules',
  '.git',
  '.oak',
  '.claude',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'target', // rust/java
  '.gradle',
]

/** 默认排除的文件后缀(噪音 / 临时)。 */
const DEFAULT_EXCLUDE_SUFFIXES: readonly string[] = ['.log', '.tmp', '.swp']

export interface CwdSyncRuleOptions {
  /**
   * 追加到默认黑名单的排除项。约定:
   *   - 以 `*.` 开头 → 文件后缀排除(如 `*.log` → 排除 `.log` 后缀)
   *   - 其余 → 顶层/路径段目录名排除(如 `tmp`、`.venv`)
   */
  extraExcludes?: readonly string[]
}

function splitExtra(extra?: readonly string[]): { dirs: Set<string>; suffixes: string[] } {
  const dirs = new Set<string>()
  const suffixes: string[] = []
  for (const e of extra ?? []) {
    if (e.startsWith('*.')) {
      suffixes.push(e.slice(1)) // '*.log' → '.log'
    } else {
      dirs.add(e)
    }
  }
  return { dirs, suffixes }
}

/** 取 relPath 的顶层段(`a/b/c` → `a`)。 */
function topSegment(relPath: string): string {
  const i = relPath.indexOf('/')
  return i === -1 ? relPath : relPath.slice(0, i)
}

/**
 * 目录级剪枝:relPath 是否应整棵跳过(不递归进去)。
 * 只按顶层目录名匹配黑名单(node_modules 在任意层都剪;但 cwd 同步从根递归,
 * 顶层命中即剪,深层同名目录也会被各自的顶层判断覆盖)。
 */
export function shouldPruneCwdDir(relPath: string, opts?: CwdSyncRuleOptions): boolean {
  const { dirs } = splitExtra(opts?.extraExcludes)
  const name = topSegment(relPath)
  if (DEFAULT_CWD_EXCLUDES.includes(name)) return true
  if (dirs.has(name)) return true
  return false
}

/**
 * 文件级:relPath 是否应同步。
 * 基本卫生 + 排除位于黑名单目录下的文件 + 排除噪音后缀。
 */
export function matchesCwdSyncRule(relPath: string, opts?: CwdSyncRuleOptions): boolean {
  if (!relPath) return false
  if (relPath.startsWith('/')) return false
  if (relPath.includes('..')) return false

  const { dirs, suffixes } = splitExtra(opts?.extraExcludes)

  // 排除黑名单目录下的所有文件(任一路径段命中)
  const segs = relPath.split('/')
  for (const seg of segs.slice(0, -1)) {
    if (DEFAULT_CWD_EXCLUDES.includes(seg) || dirs.has(seg)) return false
  }

  // 排除噪音后缀
  for (const suf of [...DEFAULT_EXCLUDE_SUFFIXES, ...suffixes]) {
    if (relPath.endsWith(suf)) return false
  }

  return true
}
