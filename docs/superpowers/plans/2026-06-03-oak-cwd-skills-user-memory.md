# OAK `cwd` + `skills` + `userMemory` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `@cloudbase/open-agent-kernel` 加 3 个新的公共 API 字段(`cwd` / `skills` / `userMemory`),内部新增 `src/claude-home/` 同步模块(Claude SDK 的 `~/.claude/` 目录与 CloudBase COS 双向同步,在 `session.send()` 边界触发),删除 `SandboxCapabilities` 里 3 个从未生效的幽灵字段。

**Architecture:**
- **`cwd`/`skills`**:在 `agent-builder.ts` 透传到 SDK options;`cwd` 不传时派生 OAK 自管的纯净 ephemeral 目录,`settingSources` 仅在用户传 `cwd` 时设为 `['project']`。
- **`userMemory`**:per-user `CLAUDE_CONFIG_DIR` 派生 → SDK 子进程从该目录读写 `.claude/` 文件 → session.send() 开始时 pull(列 COS + 计算 SHA-256 baseline)→ session.send() 结束时 push(diff baseline + currentMap → PUT 变化 + DELETE 反向删除)→ 业务方上游保证同 user 请求串行。
- **代码组织**:新增 `src/claude-home/{path-derivation,sync-rules,dedup,types,in-memory-store,cloudbase-cos-store,sync-engine,index}.ts`,internal 不公开 export。

**Tech Stack:** TypeScript ESM, Vitest(新引入), @cloudbase/node-sdk(已有 peer dep), 标准 Node `fs/promises`、`crypto`、`path`、`os`。

**Spec reference:** `packages/open-agent-kernel/docs/superpowers/specs/2026-06-01-oak-cwd-skills-user-memory-design.md`(commit `2968bdd`)

**Working directory:** `/Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding/packages/open-agent-kernel/`

**Branch:** `feat/support-open-agent-kernel`

**File map:**

| 文件 | 状态 | 责任 |
|---|---|---|
| `src/claude-home/types.ts` | Create | `ClaudeHomeSyncStore` / `ClaudeHomeContext` / `RelativePath` 等内部类型 |
| `src/claude-home/path-derivation.ts` | Create | `deriveClaudeConfigDir(envId, userId)` + `sanitizePathSegment` |
| `src/claude-home/sync-rules.ts` | Create | `SYNC_INCLUDES` 通配符 + `matchesSyncRule(relPath)` |
| `src/claude-home/dedup.ts` | Create | `sha256OfBuffer` / `sha256OfFile` |
| `src/claude-home/in-memory-store.ts` | Create | `InMemoryClaudeHomeStore`(测试用) |
| `src/claude-home/cloudbase-cos-store.ts` | Create | `CloudBaseCosClaudeHomeStore`(生产实现) |
| `src/claude-home/sync-engine.ts` | Create | `ClaudeHomeSyncEngine.pullOnSendStart` / `pushOnSendEnd` |
| `src/claude-home/index.ts` | Create | 内部 facade(不被 `src/index.ts` re-export) |
| `src/claude-home/__tests__/path-derivation.test.ts` | Create | 单元测试 |
| `src/claude-home/__tests__/sync-rules.test.ts` | Create | 单元测试 |
| `src/claude-home/__tests__/in-memory-store.test.ts` | Create | 单元测试 |
| `src/claude-home/__tests__/sync-engine.test.ts` | Create | 集成单测(用 InMemory store) |
| `src/public/types.ts` | Modify | 加 `cwd` / `skills` / `userMemory` 字段;改 scope 注释;删 capabilities 三个幽灵字段 |
| `src/runtime/agent-builder.ts` | Modify | 接入 cwd / skills / settingSources 派生 + `CLAUDE_CONFIG_DIR` 注入 + 返回 `syncEngine` |
| `src/public/create-agent.ts` | Modify | 在 `runClaudeQuery` 前后挂载 sync engine 的 pull / push |
| `src/index.ts` | Modify | 不需要新增 export(claude-home internal) |
| `package.json` | Modify | 加 `vitest` devDependency + `test` script |
| `vitest.config.ts` | Create | OAK 包自己的 vitest 配置 |
| `examples/15-skills.ts` | Create | skills 用法演示 |
| `examples/16-user-memory.ts` | Create | userMemory 启用演示(单节点跨 conversation) |
| `examples/17-user-memory-distributed.ts` | Create | userMemory 跨 Node 进程演示(序列化 demo) |
| `README.md` | Modify | 加"平台资产 vs 用户私产"章节 + sandbox scope 两层粒度说明 |
| `HANDOVER.md` | Modify | 记录 v0.x → v0.y 的 API 增量与破坏性改动 |

---

## Task 0: 安装 Vitest 测试基础设施

**Files:**
- Modify: `packages/open-agent-kernel/package.json`
- Create: `packages/open-agent-kernel/vitest.config.ts`

OAK 包目前无测试运行器(`grep` 确认无 `*.test.ts` / 无 `vitest` dep)。我们先把测试基础设施立起来,后续每个任务都能跑 `pnpm test`。

- [ ] **Step 0.1: 在 OAK 包加 vitest devDependency 与 test script**

修改 `packages/open-agent-kernel/package.json`,在 `scripts` 中添加 `test`,在文件末尾(`peerDependenciesMeta` 之后)添加 `devDependencies`(若已存在则合并键)。

```json
{
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "type-check": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "vitest": "^3.2.0"
  }
}
```

- [ ] **Step 0.2: 创建 `vitest.config.ts`**

文件内容:

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
  },
})
```

- [ ] **Step 0.3: 安装依赖**

Run(在 monorepo 根目录):
```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding && pnpm install
```

Expected: 成功安装 vitest,无错误。

- [ ] **Step 0.4: 验证 vitest 跑得起来(此时无测试)**

Run(在 OAK 包目录):
```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding/packages/open-agent-kernel && pnpm test
```

Expected: vitest 正常启动,提示 "No test files found"(因为还没写测试),exit 0 or 1(此时 1 也 OK,只要不是 ENOENT/MODULE_NOT_FOUND)。

- [ ] **Step 0.5: Commit**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding
git add packages/open-agent-kernel/package.json packages/open-agent-kernel/vitest.config.ts pnpm-lock.yaml
git commit -m "chore(oak): add vitest test infrastructure"
```

---

## Task 1: `path-derivation.ts` — sanitize + 派生 CLAUDE_CONFIG_DIR

**Files:**
- Create: `packages/open-agent-kernel/src/claude-home/path-derivation.ts`
- Test: `packages/open-agent-kernel/src/claude-home/__tests__/path-derivation.test.ts`

参考 spec §4.2:envId / userId 必须 sanitize,派生路径必以 `os.tmpdir()` 开头。

- [ ] **Step 1.1: 写失败测试**

创建 `packages/open-agent-kernel/src/claude-home/__tests__/path-derivation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import { deriveClaudeConfigDir, sanitizePathSegment } from '../path-derivation.js'

describe('sanitizePathSegment', () => {
  it('keeps allowed chars unchanged', () => {
    expect(sanitizePathSegment('alice-1.2_test')).toBe('alice-1.2_test')
  })

  it('replaces forbidden chars with underscore', () => {
    expect(sanitizePathSegment('alice/bob')).toBe('alice_bob')
    expect(sanitizePathSegment('alice..bob')).toBe('alice..bob')   // dots are allowed but '..' segment must be blocked at path-level (we test deriveClaudeConfigDir)
    expect(sanitizePathSegment('alice bob')).toBe('alice_bob')
    expect(sanitizePathSegment('alice@bob')).toBe('alice_bob')
  })

  it('handles unicode by replacing', () => {
    expect(sanitizePathSegment('用户1')).toBe('___1')
  })

  it('throws on empty string', () => {
    expect(() => sanitizePathSegment('')).toThrow(/empty/i)
  })
})

describe('deriveClaudeConfigDir', () => {
  it('produces a path under os.tmpdir()', () => {
    const result = deriveClaudeConfigDir('env-abc', 'alice')
    expect(result.startsWith(os.tmpdir())).toBe(true)
  })

  it('contains both envId and userId segments', () => {
    const result = deriveClaudeConfigDir('env-abc', 'alice')
    expect(result).toContain('env-abc')
    expect(result).toContain('alice')
    expect(result.endsWith(path.sep + '.claude')).toBe(true)
  })

  it('isolates different users', () => {
    const a = deriveClaudeConfigDir('env-1', 'alice')
    const b = deriveClaudeConfigDir('env-1', 'bob')
    expect(a).not.toBe(b)
  })

  it('isolates different envs', () => {
    const a = deriveClaudeConfigDir('env-1', 'alice')
    const b = deriveClaudeConfigDir('env-2', 'alice')
    expect(a).not.toBe(b)
  })

  it('sanitizes dangerous chars', () => {
    const result = deriveClaudeConfigDir('env/../../etc', 'alice')
    expect(result).not.toContain('..')
    expect(result.startsWith(os.tmpdir())).toBe(true)
  })

  it('throws on empty envId or userId', () => {
    expect(() => deriveClaudeConfigDir('', 'alice')).toThrow()
    expect(() => deriveClaudeConfigDir('env', '')).toThrow()
  })
})
```

- [ ] **Step 1.2: 跑测试确认失败**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding/packages/open-agent-kernel
pnpm test src/claude-home/__tests__/path-derivation.test.ts
```

Expected: FAIL — 模块不存在。

- [ ] **Step 1.3: 写实现**

创建 `packages/open-agent-kernel/src/claude-home/path-derivation.ts`:

```typescript
/**
 * 派生 per-user CLAUDE_CONFIG_DIR + sanitize 路径段。
 *
 * Spec A §4.2:必须以 os.tmpdir() 开头,envId/userId 走 sanitize 防止 ../ 注入。
 */

import * as os from 'node:os'
import * as path from 'node:path'

const ALLOWED_CHAR_RE = /^[a-zA-Z0-9._-]+$/
const REPLACE_FORBIDDEN_RE = /[^a-zA-Z0-9._-]/g

/**
 * 把单个路径段中不允许的字符替换为下划线。
 * 允许字符:[a-zA-Z0-9._-]。空字符串抛错(避免派生出空段)。
 *
 * 注意:`..` 在 sanitize 后仍是 `..`(因为 . 被允许)。这不会造成路径穿越,
 * 因为 deriveClaudeConfigDir 用 path.join 接 os.tmpdir(),最终路径仍在 tmpdir 内。
 */
export function sanitizePathSegment(s: string): string {
  if (s.length === 0) {
    throw new Error('sanitizePathSegment: input must be non-empty')
  }
  if (ALLOWED_CHAR_RE.test(s)) return s
  return s.replace(REPLACE_FORBIDDEN_RE, '_')
}

/**
 * 派生 per-user CLAUDE_CONFIG_DIR。
 *
 * 路径形如:`<os.tmpdir()>/oak/<safeEnvId>/<safeUserId>/.claude`
 *
 * 同 (envId, userId) 永远派生相同路径(供同进程多 session 共享同一目录,
 * SDK 也是这么设计的:per-user `~/.claude/` 全局目录)。
 */
export function deriveClaudeConfigDir(envId: string, userId: string): string {
  if (!envId) throw new Error('deriveClaudeConfigDir: envId is required')
  if (!userId) throw new Error('deriveClaudeConfigDir: userId is required')
  const safeEnv = sanitizePathSegment(envId)
  const safeUser = sanitizePathSegment(userId)
  return path.join(os.tmpdir(), 'oak', safeEnv, safeUser, '.claude')
}
```

- [ ] **Step 1.4: 跑测试确认通过**

```bash
pnpm test src/claude-home/__tests__/path-derivation.test.ts
```

Expected: PASS — 所有 case 通过。

- [ ] **Step 1.5: Commit**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding
git add packages/open-agent-kernel/src/claude-home/path-derivation.ts \
        packages/open-agent-kernel/src/claude-home/__tests__/path-derivation.test.ts
git commit -m "feat(oak): add path-derivation for per-user CLAUDE_CONFIG_DIR"
```

---

## Task 2: `sync-rules.ts` — SYNC_INCLUDES 白名单 matcher

**Files:**
- Create: `packages/open-agent-kernel/src/claude-home/sync-rules.ts`
- Test: `packages/open-agent-kernel/src/claude-home/__tests__/sync-rules.test.ts`

参考 spec §3.4:仅同步 SDK 自动写入的"用户私产"。

- [ ] **Step 2.1: 写失败测试**

创建 `packages/open-agent-kernel/src/claude-home/__tests__/sync-rules.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { matchesSyncRule, SYNC_INCLUDES } from '../sync-rules.js'

describe('SYNC_INCLUDES', () => {
  it('contains the expected three patterns', () => {
    expect(SYNC_INCLUDES).toEqual([
      'CLAUDE.md',
      'projects/*/memory/**',
      'agent-memory/**/MEMORY.md',
    ])
  })
})

describe('matchesSyncRule', () => {
  it('matches CLAUDE.md at root', () => {
    expect(matchesSyncRule('CLAUDE.md')).toBe(true)
  })

  it('does not match nested CLAUDE.md', () => {
    // 项目级 CLAUDE.md 不在 CONFIG_DIR 同步范围(走 cwd)
    expect(matchesSyncRule('subdir/CLAUDE.md')).toBe(false)
  })

  it('matches main session auto-memory files', () => {
    expect(matchesSyncRule('projects/abc123/memory/MEMORY.md')).toBe(true)
    expect(matchesSyncRule('projects/abc123/memory/debugging.md')).toBe(true)
    expect(matchesSyncRule('projects/abc123/memory/nested/deep.md')).toBe(true)
  })

  it('does not match projects without memory subdir', () => {
    expect(matchesSyncRule('projects/abc123/transcripts/foo.jsonl')).toBe(false)
    expect(matchesSyncRule('projects/abc123/foo.md')).toBe(false)
  })

  it('matches user-level subagent memory', () => {
    expect(matchesSyncRule('agent-memory/code-reviewer/MEMORY.md')).toBe(true)
    expect(matchesSyncRule('agent-memory/nested/path/MEMORY.md')).toBe(true)
  })

  it('does not match non-MEMORY.md files in agent-memory', () => {
    expect(matchesSyncRule('agent-memory/code-reviewer/notes.md')).toBe(false)
  })

  it('rejects platform assets', () => {
    expect(matchesSyncRule('settings.json')).toBe(false)
    expect(matchesSyncRule('skills/foo/SKILL.md')).toBe(false)
    expect(matchesSyncRule('commands/deploy.md')).toBe(false)
    expect(matchesSyncRule('rules/api.md')).toBe(false)
    expect(matchesSyncRule('agents/code-reviewer.md')).toBe(false)
  })

  it('rejects .claude.json (contains OAuth/IDE state)', () => {
    expect(matchesSyncRule('.claude.json')).toBe(false)
  })

  it('rejects empty path and absolute paths', () => {
    expect(matchesSyncRule('')).toBe(false)
    expect(matchesSyncRule('/absolute/CLAUDE.md')).toBe(false)
  })
})
```

- [ ] **Step 2.2: 跑测试确认失败**

```bash
pnpm test src/claude-home/__tests__/sync-rules.test.ts
```

Expected: FAIL — 模块不存在。

- [ ] **Step 2.3: 写实现**

创建 `packages/open-agent-kernel/src/claude-home/sync-rules.ts`:

```typescript
/**
 * 同步范围白名单(allow-list,而非 black-list)。
 *
 * Spec A §3.4:仅同步 SDK 自动写入的"用户私产"。
 *   - CLAUDE.md(用户级偏好,SDK `/memory` 命令辅助维护)
 *   - projects/* /memory/**(主会话 auto-memory + dream 产物)
 *   - agent-memory/** /MEMORY.md(用户级 subagent memory)
 *
 * 不同步:settings.json / skills / commands / rules / agents / .claude.json /
 *        themes / keybindings.json / output-styles / projects/* /transcripts/。
 *
 * 项目级 subagent memory(<cwd>/.claude/agent-memory/)在另一处处理 — 仅当 cwd
 * 是 OAK 派生的受控目录时才同步,详见 §3.4 注释。本文件只处理 CLAUDE_CONFIG_DIR 内的同步。
 */

export const SYNC_INCLUDES = [
  'CLAUDE.md',
  'projects/*/memory/**',
  'agent-memory/**/MEMORY.md',
] as const

/**
 * 判断一个相对路径是否应该被同步。
 *
 * @param relPath 相对于 CLAUDE_CONFIG_DIR 的路径(用 / 分隔,无 leading /)。
 * @returns true 表示该文件在同步范围内
 */
export function matchesSyncRule(relPath: string): boolean {
  if (!relPath) return false
  if (relPath.startsWith('/')) return false
  if (relPath.includes('..')) return false   // 防御:本不该出现,但保险

  // CLAUDE.md(只在根)
  if (relPath === 'CLAUDE.md') return true

  // projects/<id>/memory/**
  const projectsMemoryRe = /^projects\/[^/]+\/memory\/.+/
  if (projectsMemoryRe.test(relPath)) return true

  // agent-memory/**/MEMORY.md
  const agentMemoryRe = /^agent-memory\/.+\/MEMORY\.md$/
  if (agentMemoryRe.test(relPath)) return true

  return false
}
```

- [ ] **Step 2.4: 跑测试确认通过**

```bash
pnpm test src/claude-home/__tests__/sync-rules.test.ts
```

Expected: PASS — 所有 case 通过。

- [ ] **Step 2.5: Commit**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding
git add packages/open-agent-kernel/src/claude-home/sync-rules.ts \
        packages/open-agent-kernel/src/claude-home/__tests__/sync-rules.test.ts
git commit -m "feat(oak): add SYNC_INCLUDES whitelist for claude-home sync"
```

---

## Task 3: `dedup.ts` — SHA-256 hash 工具

**Files:**
- Create: `packages/open-agent-kernel/src/claude-home/dedup.ts`

(纯工具函数,无单测必要;后续 sync-engine 测试会覆盖。)

- [ ] **Step 3.1: 写实现**

创建 `packages/open-agent-kernel/src/claude-home/dedup.ts`:

```typescript
/**
 * SHA-256 hash 工具。
 *
 * 用途:sync engine 在 pull / push 阶段对每个文件计算 hash,用于变更检测。
 * 不依赖 mtime(假阳性多)/ ETag(网络往返),纯确定性。
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export function sha256OfBuffer(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex')
}

export async function sha256OfFile(absPath: string): Promise<string> {
  const buf = await readFile(absPath)
  return sha256OfBuffer(buf)
}
```

- [ ] **Step 3.2: 校验语法**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding/packages/open-agent-kernel
pnpm type-check
```

Expected: PASS(无类型错)。

- [ ] **Step 3.3: Commit**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding
git add packages/open-agent-kernel/src/claude-home/dedup.ts
git commit -m "feat(oak): add sha256 helpers for claude-home sync"
```

---

## Task 4: `types.ts` — `ClaudeHomeSyncStore` 接口与 `ClaudeHomeContext`

**Files:**
- Create: `packages/open-agent-kernel/src/claude-home/types.ts`

(类型定义,无单测,后续 in-memory + cos store 都实现这个接口。)

- [ ] **Step 4.1: 写实现**

创建 `packages/open-agent-kernel/src/claude-home/types.ts`:

```typescript
/**
 * ClaudeHomeSyncStore: SDK 原生 .claude/ 目录与远端存储的同步抽象(internal)。
 *
 * 不在公共 API 暴露(internal-only) — 业务方只看到 `userMemory.enabled`,
 * 内部抽象保留供测试替换 + 未来扩展(OSS / S3 等)。
 *
 * Spec A §4.4。
 */

/**
 * 命名空间上下文。SDK 内部用 (envId, userId) 派生 COS key prefix。
 * 不允许 agent 通过 prompt 改变(由 sync engine 闭包注入)。
 */
export interface ClaudeHomeContext {
  envId: string
  userId: string
}

/**
 * 相对路径(以 / 分隔,无 leading /),相对于 CLAUDE_CONFIG_DIR 根。
 * 例:`CLAUDE.md` / `projects/abc/memory/MEMORY.md`。
 */
export type RelativePath = string

/**
 * 同步存储的最小协议。
 *
 * MVP 流程(spec §4.3):
 *   pullOnSendStart:
 *     - 调用 store.pull → 把远端对象拉到 localDir,返回 { relPath → sha256 } baseline
 *   pushOnSendEnd:
 *     - walk localDir 算 currentMap
 *     - diff baseline vs currentMap → 调 store.put 推变更 + store.delete 反向删除
 */
export interface ClaudeHomeSyncStore {
  /**
   * 列出 (envId, userId) namespace 下所有对象,把内容拉到 localDir,
   * 同时返回每个对象的 sha256 作为 baseline。
   *
   * - namespace 不存在(首次访问)→ 返回空 Map(不抛错)
   * - 网络/凭证错误 → 抛 Error(由 sync-engine 捕获并 graceful degrade)
   * - 远端文件不在 SYNC_INCLUDES 内 → 仍然拉下来(避免历史数据丢失;
   *   下次 push 时若仍未变化也不会被反向删除,因为反向删除只看 baseline diff)
   */
  pull(ctx: ClaudeHomeContext, localDir: string): Promise<Map<RelativePath, string>>

  /**
   * 覆盖式上传一个文件(整体 PUT)。不存在则创建。
   *
   * 不带 If-Match 等乐观锁 — MVP 假设业务方上游保证同 user 请求串行。
   */
  put(ctx: ClaudeHomeContext, relPath: RelativePath, content: Buffer): Promise<void>

  /**
   * 删除一个对象。不存在时静默(返回 ok,不抛错)。
   */
  delete(ctx: ClaudeHomeContext, relPath: RelativePath): Promise<void>
}
```

- [ ] **Step 4.2: 校验语法**

```bash
pnpm type-check
```

Expected: PASS。

- [ ] **Step 4.3: Commit**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding
git add packages/open-agent-kernel/src/claude-home/types.ts
git commit -m "feat(oak): add ClaudeHomeSyncStore internal abstraction"
```

---

## Task 5: `InMemoryClaudeHomeStore` — 测试用实现

**Files:**
- Create: `packages/open-agent-kernel/src/claude-home/in-memory-store.ts`
- Test: `packages/open-agent-kernel/src/claude-home/__tests__/in-memory-store.test.ts`

后续 sync-engine 单测和示例都会用这个实现替换真实 COS。

- [ ] **Step 5.1: 写失败测试**

创建 `packages/open-agent-kernel/src/claude-home/__tests__/in-memory-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { InMemoryClaudeHomeStore } from '../in-memory-store.js'

const ctxA = { envId: 'env-a', userId: 'alice' }
const ctxB = { envId: 'env-a', userId: 'bob' }

describe('InMemoryClaudeHomeStore', () => {
  let store: InMemoryClaudeHomeStore
  let tmpDir: string

  beforeEach(async () => {
    store = new InMemoryClaudeHomeStore()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oak-claude-home-test-'))
  })

  it('pull on empty namespace returns empty Map and creates no files', async () => {
    const baseline = await store.pull(ctxA, tmpDir)
    expect(baseline.size).toBe(0)
    const entries = await fs.readdir(tmpDir).catch(() => [])
    expect(entries).toEqual([])
  })

  it('put + pull roundtrip writes file content with correct hash', async () => {
    await store.put(ctxA, 'CLAUDE.md', Buffer.from('hello world'))
    const baseline = await store.pull(ctxA, tmpDir)
    expect(baseline.size).toBe(1)
    const content = await fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf8')
    expect(content).toBe('hello world')
    const hash = baseline.get('CLAUDE.md')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('put creates nested directories on pull', async () => {
    await store.put(ctxA, 'projects/abc/memory/MEMORY.md', Buffer.from('# memory'))
    await store.pull(ctxA, tmpDir)
    const content = await fs.readFile(
      path.join(tmpDir, 'projects', 'abc', 'memory', 'MEMORY.md'),
      'utf8'
    )
    expect(content).toBe('# memory')
  })

  it('delete removes object', async () => {
    await store.put(ctxA, 'CLAUDE.md', Buffer.from('v1'))
    await store.delete(ctxA, 'CLAUDE.md')
    const baseline = await store.pull(ctxA, tmpDir)
    expect(baseline.size).toBe(0)
  })

  it('delete non-existent is silent', async () => {
    await expect(store.delete(ctxA, 'nope.md')).resolves.toBeUndefined()
  })

  it('isolates different users', async () => {
    await store.put(ctxA, 'CLAUDE.md', Buffer.from('alice content'))
    await store.put(ctxB, 'CLAUDE.md', Buffer.from('bob content'))
    const aBaseline = await store.pull(ctxA, tmpDir)
    expect(aBaseline.size).toBe(1)
    const aContent = await fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf8')
    expect(aContent).toBe('alice content')
  })

  it('put overwrites existing key', async () => {
    await store.put(ctxA, 'CLAUDE.md', Buffer.from('v1'))
    await store.put(ctxA, 'CLAUDE.md', Buffer.from('v2'))
    await store.pull(ctxA, tmpDir)
    const content = await fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf8')
    expect(content).toBe('v2')
  })
})
```

- [ ] **Step 5.2: 跑测试确认失败**

```bash
pnpm test src/claude-home/__tests__/in-memory-store.test.ts
```

Expected: FAIL — 模块不存在。

- [ ] **Step 5.3: 写实现**

创建 `packages/open-agent-kernel/src/claude-home/in-memory-store.ts`:

```typescript
/**
 * InMemoryClaudeHomeStore: 测试 / 开发期使用的同步存储实现。
 *
 * - 进程退出即丢失数据
 * - 与 CloudBaseCosClaudeHomeStore 实现相同 ClaudeHomeSyncStore 接口
 * - 用作单元测试替身
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { sha256OfBuffer } from './dedup.js'
import type { ClaudeHomeContext, ClaudeHomeSyncStore, RelativePath } from './types.js'

function nsKey(ctx: ClaudeHomeContext): string {
  return `${ctx.envId}|${ctx.userId}`
}

export class InMemoryClaudeHomeStore implements ClaudeHomeSyncStore {
  /** ns → Map<relPath, content> */
  private readonly objects = new Map<string, Map<RelativePath, Buffer>>()

  async pull(ctx: ClaudeHomeContext, localDir: string): Promise<Map<RelativePath, string>> {
    const ns = this.objects.get(nsKey(ctx))
    const baseline = new Map<RelativePath, string>()
    if (!ns) return baseline

    for (const [relPath, content] of ns) {
      const localPath = path.join(localDir, relPath)
      await fs.mkdir(path.dirname(localPath), { recursive: true })
      await fs.writeFile(localPath, content)
      baseline.set(relPath, sha256OfBuffer(content))
    }
    return baseline
  }

  async put(ctx: ClaudeHomeContext, relPath: RelativePath, content: Buffer): Promise<void> {
    const key = nsKey(ctx)
    let ns = this.objects.get(key)
    if (!ns) {
      ns = new Map()
      this.objects.set(key, ns)
    }
    ns.set(relPath, Buffer.from(content))    // copy to detach
  }

  async delete(ctx: ClaudeHomeContext, relPath: RelativePath): Promise<void> {
    const ns = this.objects.get(nsKey(ctx))
    ns?.delete(relPath)
  }
}
```

- [ ] **Step 5.4: 跑测试确认通过**

```bash
pnpm test src/claude-home/__tests__/in-memory-store.test.ts
```

Expected: PASS — 所有 case 通过。

- [ ] **Step 5.5: Commit**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding
git add packages/open-agent-kernel/src/claude-home/in-memory-store.ts \
        packages/open-agent-kernel/src/claude-home/__tests__/in-memory-store.test.ts
git commit -m "feat(oak): add InMemoryClaudeHomeStore for testing"
```

---

## Task 6: `ClaudeHomeSyncEngine` — 同步引擎(pull/push + 反向删除)

**Files:**
- Create: `packages/open-agent-kernel/src/claude-home/sync-engine.ts`
- Test: `packages/open-agent-kernel/src/claude-home/__tests__/sync-engine.test.ts`

参考 spec §4.3 详细 push 流程。

- [ ] **Step 6.1: 写失败测试**

创建 `packages/open-agent-kernel/src/claude-home/__tests__/sync-engine.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { InMemoryClaudeHomeStore } from '../in-memory-store.js'
import { ClaudeHomeSyncEngine } from '../sync-engine.js'

async function readFile(localDir: string, relPath: string): Promise<string> {
  return fs.readFile(path.join(localDir, relPath), 'utf8')
}

async function writeFile(localDir: string, relPath: string, content: string): Promise<void> {
  const abs = path.join(localDir, relPath)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content)
}

describe('ClaudeHomeSyncEngine', () => {
  let store: InMemoryClaudeHomeStore
  let localDir: string
  let engine: ClaudeHomeSyncEngine

  beforeEach(async () => {
    store = new InMemoryClaudeHomeStore()
    localDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oak-sync-test-'))
    engine = new ClaudeHomeSyncEngine({
      store,
      ctx: { envId: 'env-1', userId: 'alice' },
      localDir,
    })
  })

  it('pullOnSendStart with empty COS does not fail', async () => {
    await engine.pullOnSendStart()
    expect(engine.baselineSnapshot().size).toBe(0)
  })

  it('pullOnSendStart materializes remote files into localDir', async () => {
    await store.put({ envId: 'env-1', userId: 'alice' }, 'CLAUDE.md', Buffer.from('seeded'))
    await engine.pullOnSendStart()
    expect(await readFile(localDir, 'CLAUDE.md')).toBe('seeded')
  })

  it('pushOnSendEnd uploads new files', async () => {
    await engine.pullOnSendStart()
    await writeFile(localDir, 'CLAUDE.md', 'new content')
    await engine.pushOnSendEnd()

    // 重新 pull 验证 COS 上有内容
    const fresh = new ClaudeHomeSyncEngine({
      store,
      ctx: { envId: 'env-1', userId: 'alice' },
      localDir: await fs.mkdtemp(path.join(os.tmpdir(), 'oak-sync-fresh-')),
    })
    await fresh.pullOnSendStart()
    expect(fresh.baselineSnapshot().has('CLAUDE.md')).toBe(true)
  })

  it('pushOnSendEnd skips unchanged files (hash short-circuit)', async () => {
    await store.put({ envId: 'env-1', userId: 'alice' }, 'CLAUDE.md', Buffer.from('v1'))
    await engine.pullOnSendStart()
    // 不修改本地,直接 push
    await engine.pushOnSendEnd()
    // baselineSnapshot 仍然只有 CLAUDE.md,且 hash 不变
    expect(engine.baselineSnapshot().size).toBe(1)
  })

  it('pushOnSendEnd uploads changed files', async () => {
    await store.put({ envId: 'env-1', userId: 'alice' }, 'CLAUDE.md', Buffer.from('v1'))
    await engine.pullOnSendStart()
    await writeFile(localDir, 'CLAUDE.md', 'v2')
    await engine.pushOnSendEnd()

    // 起一个新 engine 验证远端
    const fresh = new ClaudeHomeSyncEngine({
      store,
      ctx: { envId: 'env-1', userId: 'alice' },
      localDir: await fs.mkdtemp(path.join(os.tmpdir(), 'oak-sync-fresh2-')),
    })
    await fresh.pullOnSendStart()
    expect(await readFile((fresh as any).opts.localDir, 'CLAUDE.md')).toBe('v2')
  })

  it('pushOnSendEnd does reverse deletion (baseline has, currentMap missing)', async () => {
    await store.put({ envId: 'env-1', userId: 'alice' }, 'CLAUDE.md', Buffer.from('to-be-deleted'))
    await engine.pullOnSendStart()
    // 本地删除文件
    await fs.unlink(path.join(localDir, 'CLAUDE.md'))
    await engine.pushOnSendEnd()

    // 新 engine pull 应得到空
    const fresh = new ClaudeHomeSyncEngine({
      store,
      ctx: { envId: 'env-1', userId: 'alice' },
      localDir: await fs.mkdtemp(path.join(os.tmpdir(), 'oak-sync-fresh3-')),
    })
    await fresh.pullOnSendStart()
    expect(fresh.baselineSnapshot().size).toBe(0)
  })

  it('pushOnSendEnd ignores non-SYNC_INCLUDES files', async () => {
    await engine.pullOnSendStart()
    await writeFile(localDir, 'settings.json', '{}')
    await writeFile(localDir, '.claude.json', '{"oauth":"token"}')
    await engine.pushOnSendEnd()

    // 远端不应有这些 key
    const fresh = new ClaudeHomeSyncEngine({
      store,
      ctx: { envId: 'env-1', userId: 'alice' },
      localDir: await fs.mkdtemp(path.join(os.tmpdir(), 'oak-sync-fresh4-')),
    })
    await fresh.pullOnSendStart()
    expect(fresh.baselineSnapshot().has('settings.json')).toBe(false)
    expect(fresh.baselineSnapshot().has('.claude.json')).toBe(false)
  })

  it('baseline updates after push for next-cycle diff', async () => {
    await engine.pullOnSendStart()
    await writeFile(localDir, 'CLAUDE.md', 'v1')
    await engine.pushOnSendEnd()
    const baselineAfterFirst = new Map(engine.baselineSnapshot())

    // 第二轮:本地不变,push 应不上传任何东西(短路)
    await engine.pushOnSendEnd()
    const baselineAfterSecond = new Map(engine.baselineSnapshot())
    expect(baselineAfterSecond).toEqual(baselineAfterFirst)
  })

  it('handles deeply nested paths', async () => {
    await engine.pullOnSendStart()
    await writeFile(localDir, 'projects/abc/memory/MEMORY.md', '# index')
    await writeFile(localDir, 'projects/abc/memory/debugging.md', '# debug notes')
    await engine.pushOnSendEnd()

    const fresh = new ClaudeHomeSyncEngine({
      store,
      ctx: { envId: 'env-1', userId: 'alice' },
      localDir: await fs.mkdtemp(path.join(os.tmpdir(), 'oak-sync-fresh5-')),
    })
    await fresh.pullOnSendStart()
    expect(fresh.baselineSnapshot().has('projects/abc/memory/MEMORY.md')).toBe(true)
    expect(fresh.baselineSnapshot().has('projects/abc/memory/debugging.md')).toBe(true)
  })
})
```

- [ ] **Step 6.2: 跑测试确认失败**

```bash
pnpm test src/claude-home/__tests__/sync-engine.test.ts
```

Expected: FAIL — 模块不存在。

- [ ] **Step 6.3: 写实现**

创建 `packages/open-agent-kernel/src/claude-home/sync-engine.ts`:

```typescript
/**
 * ClaudeHomeSyncEngine: pullOnSendStart / pushOnSendEnd 的核心逻辑。
 *
 * 流程(spec §4.3):
 *   send-start:
 *     1. store.pull → 把 COS 内容拉到 localDir + 返回 { relPath → sha256 } baseline
 *
 *   send-end / abort:
 *     1. walk localDir 匹配 SYNC_INCLUDES → 每个文件算 sha256 → currentMap
 *     2. 推送变更:currentMap 有 + (baseline 没有 OR hash 变了) → store.put
 *     3. 反向删除:baseline 有 + currentMap 没有 → store.delete
 *     4. baseline = currentMap(供下次 send 对比)
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { sha256OfBuffer } from './dedup.js'
import { matchesSyncRule } from './sync-rules.js'
import type { ClaudeHomeContext, ClaudeHomeSyncStore, RelativePath } from './types.js'

export interface ClaudeHomeSyncEngineOptions {
  store: ClaudeHomeSyncStore
  ctx: ClaudeHomeContext
  localDir: string
}

export class ClaudeHomeSyncEngine {
  private baseline = new Map<RelativePath, string>()
  // 暴露给测试做断言
  readonly opts: ClaudeHomeSyncEngineOptions

  constructor(opts: ClaudeHomeSyncEngineOptions) {
    this.opts = opts
  }

  /** 测试辅助:返回 baseline 的不可变 snapshot */
  baselineSnapshot(): ReadonlyMap<RelativePath, string> {
    return new Map(this.baseline)
  }

  /**
   * Send-start:从 COS 拉取该 user 的 .claude/ 内容到 localDir,
   * 并对每个文件算 sha256 作为 baseline。
   *
   * 失败不抛 — 由调用方做 graceful degrade(MVP 仅记 warning)。
   */
  async pullOnSendStart(): Promise<void> {
    await fs.mkdir(this.opts.localDir, { recursive: true })
    this.baseline = await this.opts.store.pull(this.opts.ctx, this.opts.localDir)
  }

  /**
   * Send-end / abort:diff baseline vs 当前 localDir,推送变化 + 反向删除。
   * 完成后 baseline 更新为 currentMap。
   */
  async pushOnSendEnd(): Promise<void> {
    const currentMap = await this.scanCurrent()

    // 1. push 新增 + 改动
    const toUpload: Array<RelativePath> = []
    for (const [relPath, hash] of currentMap) {
      if (this.baseline.get(relPath) !== hash) toUpload.push(relPath)
    }
    await Promise.all(
      toUpload.map(async (relPath) => {
        const buf = await fs.readFile(path.join(this.opts.localDir, relPath))
        await this.opts.store.put(this.opts.ctx, relPath, buf)
      }),
    )

    // 2. 反向删除
    const toDelete: Array<RelativePath> = []
    for (const relPath of this.baseline.keys()) {
      if (!currentMap.has(relPath)) toDelete.push(relPath)
    }
    await Promise.all(toDelete.map((relPath) => this.opts.store.delete(this.opts.ctx, relPath)))

    // 3. baseline 更新
    this.baseline = currentMap
  }

  /**
   * 扫描 localDir 中所有匹配 SYNC_INCLUDES 的文件,返回 { relPath → sha256 }。
   * localDir 不存在时返回空 Map。
   */
  private async scanCurrent(): Promise<Map<RelativePath, string>> {
    const result = new Map<RelativePath, string>()
    try {
      await fs.access(this.opts.localDir)
    } catch {
      return result
    }
    await this.walkDir(this.opts.localDir, '', result)
    return result
  }

  private async walkDir(absDir: string, relPrefix: string, out: Map<RelativePath, string>): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      const absPath = path.join(absDir, entry.name)
      if (entry.isDirectory()) {
        await this.walkDir(absPath, relPath, out)
      } else if (entry.isFile()) {
        if (!matchesSyncRule(relPath)) continue
        const buf = await fs.readFile(absPath)
        out.set(relPath, sha256OfBuffer(buf))
      }
    }
  }
}
```

- [ ] **Step 6.4: 跑测试确认通过**

```bash
pnpm test src/claude-home/__tests__/sync-engine.test.ts
```

Expected: PASS — 所有 case 通过。

- [ ] **Step 6.5: Commit**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding
git add packages/open-agent-kernel/src/claude-home/sync-engine.ts \
        packages/open-agent-kernel/src/claude-home/__tests__/sync-engine.test.ts
git commit -m "feat(oak): add ClaudeHomeSyncEngine with hash-diff and reverse delete"
```

---

## Task 7: `CloudBaseCosClaudeHomeStore` — 生产实现

**Files:**
- Create: `packages/open-agent-kernel/src/claude-home/cloudbase-cos-store.ts`
- Create: `packages/open-agent-kernel/src/claude-home/index.ts`

参考 `src/storage/cloudbase-storage.ts` 的凭证 / SDK 懒加载模式。

- [ ] **Step 7.1: 写实现**

创建 `packages/open-agent-kernel/src/claude-home/cloudbase-cos-store.ts`:

```typescript
/**
 * CloudBaseCosClaudeHomeStore: 生产实现,把 .claude/ 内容同步到 envId 对应的 COS 桶。
 *
 * COS key pattern: `oak/users/{userId}/claude-home/<relative-path>`
 *
 * 凭证派生(与 CloudBaseStorage 一致):
 *   1. options.credentials(编程注入)
 *   2. process.env: TCB_ENV_ID + TCB_SECRET_ID + TCB_SECRET_KEY (+ TCB_TOKEN)
 *
 * `@cloudbase/node-sdk` 是 optional peer dep,按需懒加载。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { ResourceError } from '../internal/errors.js'
import { sha256OfBuffer } from './dedup.js'
import type { ClaudeHomeContext, ClaudeHomeSyncStore, RelativePath } from './types.js'

const KEY_PREFIX_TPL = (userId: string) => `oak/users/${userId}/claude-home/`

export interface CloudBaseCosCredentials {
  envId: string
  secretId: string
  secretKey: string
  sessionToken?: string
  region?: string
}

export interface CloudBaseCosClaudeHomeStoreOptions {
  credentials?: CloudBaseCosCredentials
}

interface ResolvedCredentials extends CloudBaseCosCredentials {
  region: string
}

interface CloudBaseApp {
  uploadFile(args: { cloudPath: string; fileContent: Uint8Array | Buffer }): Promise<{ fileID: string }>
  getTempFileURL(args: { fileList: Array<string> }): Promise<{
    fileList: Array<{ fileID: string; tempFileURL: string; code?: string }>
  }>
  deleteFile(args: { fileList: Array<string> }): Promise<{
    fileList: Array<{ fileID: string; code?: string }>
  }>
  getStorage?(): {
    listDirectoryFiles(prefix: string): Promise<Array<{ Key: string; Size: number }>>
  }
}

function resolveCredentials(opts?: CloudBaseCosClaudeHomeStoreOptions): ResolvedCredentials {
  const fromOpts = opts?.credentials
  const envId = fromOpts?.envId ?? process.env.TCB_ENV_ID
  const secretId = fromOpts?.secretId ?? process.env.TCB_SECRET_ID
  const secretKey = fromOpts?.secretKey ?? process.env.TCB_SECRET_KEY
  const sessionToken = fromOpts?.sessionToken ?? process.env.TCB_TOKEN ?? undefined
  const region = fromOpts?.region ?? process.env.TCB_REGION ?? 'ap-shanghai'

  if (!envId || !secretId || !secretKey) {
    throw new ResourceError(
      'CloudBase credentials missing for CloudBaseCosClaudeHomeStore. Set one of:\n' +
        '  - process.env: TCB_ENV_ID + TCB_SECRET_ID + TCB_SECRET_KEY\n' +
        '  - constructor option `credentials`',
    )
  }
  return { envId, secretId, secretKey, sessionToken, region }
}

function assertSafeKey(userId: string, fullKey: string): void {
  const expectedPrefix = KEY_PREFIX_TPL(userId)
  if (!fullKey.startsWith(expectedPrefix)) {
    throw new Error(`assertSafeKey: ${fullKey} does not start with ${expectedPrefix}`)
  }
  if (fullKey.includes('..')) {
    throw new Error(`assertSafeKey: ${fullKey} contains traversal segment`)
  }
}

export class CloudBaseCosClaudeHomeStore implements ClaudeHomeSyncStore {
  private readonly creds: ResolvedCredentials
  private app: CloudBaseApp | null = null

  constructor(opts: CloudBaseCosClaudeHomeStoreOptions = {}) {
    this.creds = resolveCredentials(opts)
  }

  private async getApp(): Promise<CloudBaseApp> {
    if (this.app) return this.app
    const tcbModule = await import('@cloudbase/node-sdk').catch(() => null)
    if (!tcbModule) {
      throw new ResourceError(
        'CloudBaseCosClaudeHomeStore requires @cloudbase/node-sdk. Install via:\n' +
          '  pnpm add @cloudbase/node-sdk',
      )
    }
    const tcb = tcbModule as unknown as {
      init: (opts: {
        env: string
        secretId: string
        secretKey: string
        sessionToken?: string
        region?: string
      }) => CloudBaseApp
    }
    this.app = tcb.init({
      env: this.creds.envId,
      secretId: this.creds.secretId,
      secretKey: this.creds.secretKey,
      sessionToken: this.creds.sessionToken,
      region: this.creds.region,
    })
    return this.app
  }

  async pull(ctx: ClaudeHomeContext, localDir: string): Promise<Map<RelativePath, string>> {
    const baseline = new Map<RelativePath, string>()
    const app = await this.getApp()
    const prefix = KEY_PREFIX_TPL(ctx.userId)

    const storage = app.getStorage?.()
    if (!storage) {
      // SDK 不暴露 listDirectoryFiles → 视为 namespace 空(graceful)
      return baseline
    }
    const listed = await storage.listDirectoryFiles(prefix)

    await Promise.all(
      listed.map(async (item) => {
        if (item.Size === 0) return    // 目录占位文件
        const fileID = item.Key
        assertSafeKey(ctx.userId, fileID)
        const relPath = fileID.substring(prefix.length)
        if (!relPath) return

        const urlRes = await app.getTempFileURL({ fileList: [fileID] })
        const url = urlRes.fileList?.[0]?.tempFileURL
        if (!url) return
        const resp = await fetch(url)
        if (!resp.ok) throw new Error(`pull failed for ${fileID}: ${resp.status}`)
        const buf = Buffer.from(await resp.arrayBuffer())

        const localPath = path.join(localDir, relPath)
        await fs.mkdir(path.dirname(localPath), { recursive: true })
        await fs.writeFile(localPath, buf)
        baseline.set(relPath, sha256OfBuffer(buf))
      }),
    )

    return baseline
  }

  async put(ctx: ClaudeHomeContext, relPath: RelativePath, content: Buffer): Promise<void> {
    const app = await this.getApp()
    const fullKey = KEY_PREFIX_TPL(ctx.userId) + relPath
    assertSafeKey(ctx.userId, fullKey)
    await app.uploadFile({ cloudPath: fullKey, fileContent: content })
  }

  async delete(ctx: ClaudeHomeContext, relPath: RelativePath): Promise<void> {
    const app = await this.getApp()
    const fullKey = KEY_PREFIX_TPL(ctx.userId) + relPath
    assertSafeKey(ctx.userId, fullKey)
    const result = await app.deleteFile({ fileList: [fullKey] })
    const item = result.fileList?.[0]
    if (item?.code && item.code !== 'SUCCESS' && item.code !== 'STORAGE.FileNotFound') {
      throw new Error(`COS delete failed for ${fullKey}: ${item.code}`)
    }
  }
}
```

- [ ] **Step 7.2: 创建 internal facade**

创建 `packages/open-agent-kernel/src/claude-home/index.ts`:

```typescript
/**
 * Internal facade for src/claude-home/.
 *
 * 不被 src/index.ts re-export — 业务方只看到 AgentConfig.userMemory.enabled。
 * 内部模块(agent-builder / create-agent)从这里 import。
 */

export { deriveClaudeConfigDir, sanitizePathSegment } from './path-derivation.js'
export { matchesSyncRule, SYNC_INCLUDES } from './sync-rules.js'
export { sha256OfBuffer, sha256OfFile } from './dedup.js'
export { ClaudeHomeSyncEngine, type ClaudeHomeSyncEngineOptions } from './sync-engine.js'
export { InMemoryClaudeHomeStore } from './in-memory-store.js'
export {
  CloudBaseCosClaudeHomeStore,
  type CloudBaseCosCredentials,
  type CloudBaseCosClaudeHomeStoreOptions,
} from './cloudbase-cos-store.js'
export type { ClaudeHomeSyncStore, ClaudeHomeContext, RelativePath } from './types.js'
```

- [ ] **Step 7.3: 校验类型**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding/packages/open-agent-kernel
pnpm type-check
```

Expected: PASS。

注:CloudBaseCosClaudeHomeStore 不写专门集成测试(需要真实 COS 桶)。后续 example 17 会做端到端验证。

- [ ] **Step 7.4: Commit**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding
git add packages/open-agent-kernel/src/claude-home/cloudbase-cos-store.ts \
        packages/open-agent-kernel/src/claude-home/index.ts
git commit -m "feat(oak): add CloudBaseCosClaudeHomeStore production implementation"
```

---

## Task 8: 公共类型 — 加 `cwd` / `skills` / `userMemory`,删幽灵字段

**Files:**
- Modify: `packages/open-agent-kernel/src/public/types.ts`

参考 spec §3.1 + §3.3 + §4.8。

- [ ] **Step 8.1: 修改 `SandboxConfig.scope` 注释(对齐 server 术语)**

在 `src/public/types.ts` 找到 line ~70(`scope?: 'session' | 'shared'` 字段),把上面整段注释替换为:

```typescript
  /**
   * 沙箱粒度(AGS 实例层):
   * - `'session'`(默认):每个 startSession 一个独立 AGS 实例,session.abort 时 Pause。
   *   对应 server feature/stateful-infra 的 `sandboxMode: 'isolated'`。
   * - `'shared'`:同 envId 多个 session 共享一个 AGS 实例,按需 Resume / Stop 漂移实例,
   *   abort 不 Pause(由 AGS 按 DefaultTimeout 自动回收)。
   *   对应 server feature/stateful-infra 的 `sandboxMode: 'shared'`。
   *
   * 注意:这两个 scope 是 AGS 实例粒度,与"沙箱内工作区目录"是两层正交关系。
   * 工作区目录派生由沙箱镜像负责(/home/user/{conversationId}/ 约定),SDK 不感知。
   */
  scope?: 'session' | 'shared'
```

- [ ] **Step 8.2: 删除 `SandboxCapabilities` 中的幽灵字段**

在 `src/public/types.ts` 中找到 `SandboxCapabilities` interface(line ~124),把它替换为:

```typescript
export interface SandboxCapabilities {
  /** 文件系统工具(read/write/edit/ls/glob/grep)*/
  filesystem?: boolean
  /** Shell 工具(bash 命令)*/
  shell?: boolean
}
```

并删除 line ~141 的 `CompactionConfig` interface(整个 interface 都删,因为 `compaction` 字段已删,`CompactionConfig` 不再被任何东西引用)。

- [ ] **Step 8.3: 给 `AgentConfig` 加 `cwd` / `skills` / `userMemory` 字段**

在 `src/public/types.ts` 找到 `export interface AgentConfig {` 块(line ~382),在 `// ── 钩子 ──` 之前加入新字段(也就是在 `hooks?: AgentHooks` 上面):

```typescript
  // ── 平台资产层(宿主机 cwd)──────────────────
  /**
   * SDK 加载本机文件型资产的根目录。
   * 影响:Skills 扫描根、项目级 CLAUDE.md 查找根、SDK 子进程 spawn cwd。
   * 默认:OAK 自管的纯净 ephemeral 目录(无 skills、无 CLAUDE.md,等价 v0 行为)。
   * 业务方通常传镜像内的固定路径(如 '/app/skills-bundle')。
   *
   * ⚠️ 安全:OAK 内部强制 settingSources 仅含 'project',永远不读 'user'(宿主机 ~/.claude)。
   * cwd 指向 ~/.claude/ 或其子目录会被 OAK 拒绝。
   */
  cwd?: string

  /**
   * 启用 Claude Agent SDK 的 skills 能力。
   * SDK 在 cwd/.claude/skills/ 下扫描 SKILL.md,按 enabled 过滤后注入到 system prompt。
   * 不传或 enabled 未配 → skills 关闭(等价 v0 行为)。
   *
   * 仅当同时传了 cwd 且 cwd 下有 .claude/skills/ 目录时才生效。
   */
  skills?: {
    enabled?: 'all' | string[]
  }

  // ── 用户级长期记忆(SDK 原生 .claude/ 同步)────
  /**
   * 用户级长期记忆。启用后:
   *   1. SDK 子进程的 CLAUDE_CONFIG_DIR 自动按 (envId, userId) 派生到独立目录
   *   2. 每次 session.send() 开始:从 CloudBase COS 拉取 + 算 SHA-256 baseline
   *   3. 每次 session.send() 结束(包括 abort):diff baseline → PUT 变化 + DELETE 反向
   *
   * 同步范围(spec §3.4):仅 SDK 自动写入的"用户私产"
   *   - <CLAUDE_CONFIG_DIR>/CLAUDE.md
   *   - <CLAUDE_CONFIG_DIR>/projects/* /memory/
   *   - <CLAUDE_CONFIG_DIR>/agent-memory/
   * 不同步:settings.json / skills / commands / rules / agents / .claude.json 等。
   *
   * 默认:disabled(等价 v0 行为)。
   *
   * 依赖:启用时该 envId 必须开通 CloudBase COS。COS 不可达时记 warning,
   * 不阻塞 send(graceful degrade — agent 仍可工作,只是这次不同步)。
   *
   * ⚠️ 前提条件(业务方需保证):同一 userId 的请求不能并发处理 —
   * 即同一时刻不能有两个 SDK 节点同时为 alice 服务。SDK 不在并发场景下做冲突
   * 防御。但允许 alice 这次落 node1、下次落 node2,只要两次不重叠。
   */
  userMemory?: {
    enabled?: boolean
  }

```

(确保 `hooks?: AgentHooks` 这一行还在,新字段在它之前。)

- [ ] **Step 8.4: 校验类型 + 跑现有测试**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding/packages/open-agent-kernel
pnpm type-check && pnpm test
```

Expected:
- type-check PASS(若有引用 `compaction` / `skills` / `memory` 的旧代码报错,需在本任务一并删除)
- test PASS(claude-home 的 4 套测试都通过)

如果 type-check 报错 "Property 'compaction' does not exist..." 之类,说明 `agent-builder.ts` 或别处仍在引用幽灵字段,删除那些引用(grep 一下 `capabilities\.compaction|capabilities\.memory|capabilities\.skills` 应该返回 0 行)。

```bash
grep -rn 'capabilities\.\(compaction\|memory\|skills\)' src/ --include="*.ts"
```

Expected: 无输出(或只在注释里)。

- [ ] **Step 8.5: Commit**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding
git add packages/open-agent-kernel/src/public/types.ts
git commit -m "feat(oak): add cwd/skills/userMemory fields, drop ghost capabilities"
```

---

## Task 9: `agent-builder.ts` — 接入 cwd / skills / userMemory

**Files:**
- Modify: `packages/open-agent-kernel/src/runtime/agent-builder.ts`

把 spec §4.1 + §4.6 的 agent-builder 改动落实。这是本 plan 最复杂的一步。

- [ ] **Step 9.1: 阅读现状以确认插入位置**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding/packages/open-agent-kernel
sed -n '60,200p' src/runtime/agent-builder.ts
```

观察:`buildClaudeQueryOptions(config, extra)` 函数的 `extra` 参数现在有 `sandboxInstance / extraMcpServers / conversationId / hookLocalState`。我们要给它加 `userId`,并返回 `syncEngine`。

- [ ] **Step 9.2: 修改 `BuiltClaudeQueryParams` 与 `buildClaudeQueryOptions` 签名**

在 `src/runtime/agent-builder.ts` 顶部加新的 import:

```typescript
import { existsSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  ClaudeHomeSyncEngine,
  CloudBaseCosClaudeHomeStore,
  deriveClaudeConfigDir,
} from '../claude-home/index.js'
import type { SettingSource } from '@anthropic-ai/claude-agent-sdk'
```

(若 `SettingSource` 已经从 `@anthropic-ai/claude-agent-sdk` 导出可用就用;否则就去掉这个 import,在内部用字面量类型。)

修改 `BuiltClaudeQueryParams`:

```typescript
export interface BuiltClaudeQueryParams {
  options: ClaudeOptions
  credential: ResolvedCredential
  /**
   * 当 userMemory.enabled = true 时返回的同步引擎。
   * 调用方(create-agent.ts)负责挂到 session.send 两端:
   *   send-start → syncEngine.pullOnSendStart()
   *   send-end (含 abort) → syncEngine.pushOnSendEnd()
   */
  syncEngine?: ClaudeHomeSyncEngine
}
```

修改 `buildClaudeQueryOptions(config, extra)` 的签名,把 `extra` 加上 `userId`:

```typescript
export function buildClaudeQueryOptions(
  config: AgentConfig,
  extra: {
    sandboxInstance?: SandboxInstance
    extraMcpServers?: Record<string, SdkMcpServerConfig>
    conversationId?: string
    hookLocalState?: PreToolUseHookLocalState
    /** PR for userMemory:agent.startSession({ userId }) 透传过来 */
    userId?: string
  } = {},
): BuiltClaudeQueryParams {
  // ... 现有实现 ...
}
```

- [ ] **Step 9.3: 在 `buildClaudeQueryOptions` 内加入 cwd / skills / userMemory 派生**

在函数体内,**`const credential = resolveCredential(...)` 之后**、**`const env = {...}` 之前**插入以下逻辑:

```typescript
  // ── cwd / settingSources 派生(spec §4.1)─────────
  // 1) 用户传 cwd:走"受控 settingSources"路径
  // 2) 用户没传:用 ephemeral 目录,settingSources=[](等价 v0 isolation)
  const userCwd = config.cwd
  if (userCwd) assertSafeUserCwd(userCwd)
  const effectiveCwd = userCwd ?? deriveEphemeralCwd()
  const settingSources: SettingSource[] = userCwd ? ['project'] : []

  // ── userMemory 派生(spec §4.2 + §4.6)───────────
  let claudeConfigDir: string | undefined
  let syncEngine: ClaudeHomeSyncEngine | undefined
  if (config.userMemory?.enabled && extra.userId) {
    claudeConfigDir = deriveClaudeConfigDir(config.envId, extra.userId)
    syncEngine = new ClaudeHomeSyncEngine({
      store: new CloudBaseCosClaudeHomeStore(),    // 复用 process.env 凭证
      ctx: { envId: config.envId, userId: extra.userId },
      localDir: claudeConfigDir,
    })
  }
```

然后在 `const env = {...}` 中追加 `CLAUDE_CONFIG_DIR`:

```typescript
  const env: Record<string, string | undefined> = {
    ...process.env,
    ANTHROPIC_BASE_URL: credential.baseUrl,
    ANTHROPIC_AUTH_TOKEN: credential.apiKey,
    ANTHROPIC_API_KEY: undefined,
    API_TIMEOUT_MS: String(DEFAULT_API_TIMEOUT_MS),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_AGENT_SDK_CLIENT_APP: '@cloudbase/open-agent-kernel/0.1.0-alpha.0',
    ...(enablePersist ? { CLAUDE_CONFIG_DIR: getSessionLocalDir() } : {}),
    // userMemory 启用时覆盖 CLAUDE_CONFIG_DIR(per-user 派生)
    ...(claudeConfigDir ? { CLAUDE_CONFIG_DIR: claudeConfigDir } : {}),
  }
```

(注意:`claudeConfigDir` 必须在 `enablePersist` 之后才能覆盖前者。如果两个都启用,以 userMemory 的 per-user dir 为准。)

修改 `options` object 把 `settingSources: []` 改为 `settingSources` 变量,加 `cwd` 与 `skills` 字段:

```typescript
  const options: ClaudeOptions = {
    model: credential.modelId,
    env,
    cwd: effectiveCwd,
    settingSources,
    strictMcpConfig: true,
    persistSession: enablePersist,
    ...(sessionStore ? { sessionStore } : {}),
    ...(config.session?.flush ? { sessionStoreFlush: config.session.flush } : {}),
    ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
    ...(config.skills?.enabled !== undefined ? { skills: config.skills.enabled } : {}),
    ...(mergedMcpServers ? { mcpServers: mergedMcpServers } : {}),
    ...(hooks ? { hooks } : {}),
    permissionMode: 'bypassPermissions' as const,
    allowDangerouslySkipPermissions: true,
    tools: [],
  }
```

最后修改 return:

```typescript
  return { options, credential, syncEngine }
```

- [ ] **Step 9.4: 加辅助函数 `deriveEphemeralCwd` 和 `assertSafeUserCwd`**

在文件末尾(`extractSessionStore` 函数之后)添加:

```typescript
/**
 * 派生 OAK 自管的纯净 ephemeral cwd(用户没传 cwd 时使用)。
 *
 * 这个目录是空白的,settingSources=[]:SDK 进去什么都读不到,等价 v0 isolation。
 * 进程级:每个 SDK 进程实例化时生成一次,进程结束时清理(我们不主动清,依赖 OS tmpdir GC)。
 */
let ephemeralCwdCache: string | undefined
function deriveEphemeralCwd(): string {
  if (ephemeralCwdCache) return ephemeralCwdCache
  const random = Math.random().toString(36).slice(2, 10)
  ephemeralCwdCache = path.join(os.tmpdir(), `oak-ephemeral-${random}`)
  return ephemeralCwdCache
}

/**
 * 拒绝用户传 ~/.claude 或其子目录作 cwd(防止误用 + 跨用户读取宿主机配置)。
 * Spec A §5.1 安全约束。
 */
function assertSafeUserCwd(cwd: string): void {
  const absolute = path.resolve(cwd)
  const home = os.homedir()
  const homeClaude = path.join(home, '.claude')
  if (absolute === homeClaude || absolute.startsWith(homeClaude + path.sep)) {
    throw new InvalidConfigError(
      `AgentConfig.cwd cannot point at host ~/.claude/ or its subdirectory (got ${cwd}). ` +
        'OAK refuses to share host-level Claude config across multi-tenant requests.',
    )
  }
}
```

把 `existsSync` 这个 import 删掉(我让你加的,但其实没用上,避免 unused import 报错)。grep 确认:

```bash
grep -n existsSync src/runtime/agent-builder.ts
```

如果只是 import 行而无别处使用,删除该 import。

- [ ] **Step 9.5: 校验类型**

```bash
pnpm type-check
```

Expected: PASS。如果有错,常见原因:
- `SettingSource` 没从 SDK 导出 → 删 import,改用 `('project' | 'user' | 'local')[]`
- `ClaudeOptions` 没有 `cwd` 字段 → 检查 SDK 版本,确认 `Options` 接口含 `cwd`(spec §9.1 引用 sdk.d.ts:1265,1267)。若该 SDK 版本不支持,需要升级或绕过(把 cwd 通过 env 注入)。

- [ ] **Step 9.6: 跑全部测试,确认没破坏既有逻辑**

```bash
pnpm test
```

Expected: PASS — claude-home 的 4 套测试仍通过。

- [ ] **Step 9.7: Commit**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding
git add packages/open-agent-kernel/src/runtime/agent-builder.ts
git commit -m "feat(oak): wire cwd/skills/userMemory into agent-builder"
```

---

## Task 10: `create-agent.ts` — 把 sync engine 挂到 send 两端

**Files:**
- Modify: `packages/open-agent-kernel/src/public/create-agent.ts`

参考 spec §4.6 后半部分。`syncEngine` 从 `buildClaudeQueryOptions` 返回,需要在 `runClaudeQuery` 的 generator 包一层 try/finally。

- [ ] **Step 10.1: 阅读现状**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding/packages/open-agent-kernel
sed -n '186,210p' src/public/create-agent.ts
echo '---'
sed -n '565,610p' src/public/create-agent.ts
```

观察:
- `session.send()`(line ~189)调 `runClaudeQuery({...})` 返回 generator
- `runClaudeQuery`(line ~565)内部调 `buildClaudeQueryOptions(effectiveConfig, {...})`,line ~590

**思路**:在 `runClaudeQuery` 内部,把它原本 `for await (...)` 的循环包一层 try/finally,在循环开始前 `await syncEngine?.pullOnSendStart()`,在 finally 里 `await syncEngine?.pushOnSendEnd()`。

- [ ] **Step 10.2: 修改 `runClaudeQuery` 调用 `buildClaudeQueryOptions` 的位置传入 userId**

找到 `runClaudeQuery` 函数体(line ~565 起),在调用 `buildClaudeQueryOptions(effectiveConfig, ...)` 时(line ~590),把 `extra` 中加上 `userId`。

`runClaudeQuery` 函数签名是这样:

```typescript
async function* runClaudeQuery(args: RunClaudeQueryArgs): AsyncGenerator<SessionEvent, void, unknown>
```

`RunClaudeQueryArgs` 定义在该文件其它位置(line ~107 附近),它有 `conversationId` 但**没有 userId**。先加 userId 字段:

```typescript
interface RunClaudeQueryArgs {
  config: AgentConfig
  input: string | SessionInput
  abortController: AbortController
  sessionId: string
  conversationId: string
  userId: string                 // ← 新增
  isContinuation: boolean
  ensureSandbox: () => Promise<SandboxInstance | null>
  ensureCloudbaseMcp: () => Promise<Record<string, SdkMcpServerConfig>>
  permissionStore: PermissionStore
}
```

然后在 `session.send()`(line ~189)调用处把 `userId` 透传:

```typescript
    send(input: string | SessionInput): AsyncIterable<SessionEvent> {
      abortController = new AbortController()
      const isContinuation = hasStarted
      hasStarted = true
      return runClaudeQuery({
        config,
        input,
        abortController,
        sessionId: conversationId,
        conversationId,
        userId,                    // ← 新增
        isContinuation,
        ensureSandbox,
        ensureCloudbaseMcp,
        permissionStore,
      })
    },
```

如果 `respondApproval` 内部调 `runApprovalResume` 也调用 `buildClaudeQueryOptions`,那它也要透传 `userId` —— 同样修改 `RunApprovalResumeArgs` 与调用点。grep 确认:

```bash
grep -n 'runApprovalResume\|runClaudeQuery' src/public/create-agent.ts
```

如果 `runApprovalResume` 也调 `buildClaudeQueryOptions` 但**不需要同步**(因为它只是注入审批决策,不算"新一轮 send"),可以不传 userId(传 undefined,sync engine 就不会启动)。**但本 plan 决定**:respondApproval 也算 send 边界 — 仍透传 userId,sync engine 同样起作用,因为审批 resume 后 SDK 仍会写入 memory。

修改 `runApprovalResume` 的调用,加 userId:

```typescript
    respondApproval(opts: { toolUseId: string; decision: ApprovalDecision }): AsyncIterable<SessionEvent> {
      abortController = new AbortController()
      return runApprovalResume({
        config,
        conversationId,
        userId,                  // ← 新增
        toolUseId: opts.toolUseId,
        decision: opts.decision,
        abortController,
        ensureSandbox,
        ensureCloudbaseMcp,
        permissionStore,
      })
    },
```

并在 `RunApprovalResumeArgs` 接口加 `userId: string` 字段。

最后,`buildClaudeQueryOptions` 调用处加 userId:

```typescript
    const { options, syncEngine } = buildClaudeQueryOptions(effectiveConfig, {
      sandboxInstance,
      extraMcpServers,
      conversationId,
      hookLocalState,
      userId: args.userId,           // ← 新增
    })
```

(`runApprovalResume` 中同理加 userId 透传。)

- [ ] **Step 10.3: 在 `runClaudeQuery` 函数体外层包 try/finally 调用 sync 钩子**

找到 `runClaudeQuery` 函数体(line ~565)。它当前形如:

```typescript
async function* runClaudeQuery(args: RunClaudeQueryArgs): AsyncGenerator<SessionEvent, void, unknown> {
  // ... 各种 setup ...
  const { options } = buildClaudeQueryOptions(...)

  // 其余逻辑(SDK query iter + 事件转译 + ...)
  for await (const ... of query({...})) {
    // ...
    yield event
  }
}
```

把它改成:

```typescript
async function* runClaudeQuery(args: RunClaudeQueryArgs): AsyncGenerator<SessionEvent, void, unknown> {
  // ... 各种 setup ...
  const { options, syncEngine } = buildClaudeQueryOptions(effectiveConfig, {
    sandboxInstance,
    extraMcpServers,
    conversationId,
    hookLocalState,
    userId: args.userId,
  })

  // ── userMemory: send-start pull(失败不抛,记 warning)───
  if (syncEngine) {
    try {
      await syncEngine.pullOnSendStart()
    } catch (err) {
      console.warn('[oak/userMemory] pullOnSendStart failed:', (err as Error)?.message)
    }
  }

  try {
    // 其余逻辑(SDK query iter + 事件转译 + ...)— 原封不动
    for await (const ... of query({...})) {
      // ...
      yield event
    }
  } finally {
    // ── userMemory: send-end push(abort/异常都触发,失败不抛)───
    if (syncEngine) {
      try {
        await syncEngine.pushOnSendEnd()
      } catch (err) {
        console.warn('[oak/userMemory] pushOnSendEnd failed:', (err as Error)?.message)
      }
    }
  }
}
```

**关键**:把 `for await` 整个外面包 try/finally,而不是 try/catch — 这样 abort / 异常 / 正常完成都会触发 push。

对 `runApprovalResume` 做相同修改(同样的 try/finally 模式)。

- [ ] **Step 10.4: 校验类型 + 跑测试**

```bash
pnpm type-check && pnpm test
```

Expected:
- type-check PASS
- test PASS(claude-home 的 4 套测试仍通过)

- [ ] **Step 10.5: Commit**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding
git add packages/open-agent-kernel/src/public/create-agent.ts
git commit -m "feat(oak): hook userMemory sync engine into session.send/respondApproval"
```

---

## Task 11: 端到端示例 — `examples/15-skills.ts`

**Files:**
- Create: `packages/open-agent-kernel/examples/15-skills.ts`

业务方在 cwd 下放一个 SKILL.md 示例,启用 skills,验证 agent 能 list 到。

- [ ] **Step 11.1: 创建示例**

```typescript
/**
 * Example 15: Skills(平台资产)
 *
 * 演示:
 *   1. 业务方在某固定目录下放 .claude/skills/<name>/SKILL.md(平台共享资产)
 *   2. createAgent 时传 cwd 指向该目录,启用 skills.enabled
 *   3. agent 启动后该 skill 自动加载到 system prompt,可被 / 调用或被 LLM 选用
 *
 * 运行前提:
 *   - .env.local 配置 TCB_ENV_ID + TENCENTCLOUD_TOKENHUB_API_KEY
 *
 * Run:
 *   pnpm dlx tsx packages/open-agent-kernel/examples/15-skills.ts
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgent } from '../src/index.js'
import { loadEnv } from './_shared/env.js'

async function main() {
  loadEnv()

  // 1. 准备一个临时 cwd,放一个 SKILL.md
  const cwd = await mkdir(join(tmpdir(), `oak-skills-demo-${Date.now()}`), { recursive: true })
  const skillDir = join(cwd!, '.claude', 'skills', 'greet')
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: greet',
      'description: Greets the user warmly in Chinese.',
      '---',
      '',
      '当用户请求问候时,使用温暖友好的中文回应,以"你好"开头。',
    ].join('\n'),
    'utf8',
  )
  console.log(`[example] skill seeded at ${skillDir}`)

  // 2. createAgent 启用 skills
  const agent = createAgent({
    envId: process.env.TCB_ENV_ID!,
    model: 'glm-5.1',
    systemPrompt: 'You are a helpful assistant.',
    cwd: cwd!,
    skills: { enabled: 'all' },
  })

  // 3. agent 启动 — 期望 SDK 自动加载 greet skill
  const session = await agent.startSession({ userId: 'demo-user' })
  console.log('[example] session started, sending prompt...\n')
  for await (const event of session.send('请问候我')) {
    if (event.type === 'message_delta') process.stdout.write(event.text)
  }
  console.log('\n[example] done.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 11.2: 校验类型(不实际跑,因为需要真凭证)**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding/packages/open-agent-kernel
pnpm type-check
```

Expected: PASS。

- [ ] **Step 11.3: Commit**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding
git add packages/open-agent-kernel/examples/15-skills.ts
git commit -m "docs(oak): add example 15 — skills via cwd"
```

---

## Task 12: 端到端示例 — `examples/16-user-memory.ts`

**Files:**
- Create: `packages/open-agent-kernel/examples/16-user-memory.ts`

演示 `userMemory.enabled = true` 后,跨 conversation 同 user 记忆持续。

- [ ] **Step 12.1: 创建示例**

```typescript
/**
 * Example 16: userMemory(用户级长期记忆)
 *
 * 演示:
 *   1. 启用 userMemory.enabled = true
 *   2. 第一段对话告诉 agent 一个用户事实("我的猫叫咪咪")
 *   3. session abort 时 .claude/CLAUDE.md 与 projects/* /memory/MEMORY.md 自动同步到 COS
 *   4. 创建第二个 conversation(同 userId)→ pull 拿到 memory → agent 主动想起咪咪
 *
 * 运行前提:
 *   - .env.local 配置 TCB_ENV_ID + TCB_SECRET_ID + TCB_SECRET_KEY + TENCENTCLOUD_TOKENHUB_API_KEY
 *   - 该 envId 对应的 CloudBase 已开通 COS
 *
 * Run:
 *   pnpm dlx tsx packages/open-agent-kernel/examples/16-user-memory.ts
 */

import { createAgent } from '../src/index.js'
import { loadEnv } from './_shared/env.js'

async function runConversation(prompt: string, userId: string) {
  const agent = createAgent({
    envId: process.env.TCB_ENV_ID!,
    model: 'glm-5.1',
    systemPrompt:
      'You are a friendly assistant. When the user shares personal facts, ' +
      'use the /memory command or remember them for future conversations.',
    userMemory: { enabled: true },
  })

  const session = await agent.startSession({ userId })
  console.log(`\n[example] conversation start (user=${userId})`)
  console.log(`[example] user: ${prompt}`)
  process.stdout.write('[example] assistant: ')
  for await (const event of session.send(prompt)) {
    if (event.type === 'message_delta') process.stdout.write(event.text)
  }
  console.log('\n[example] aborting session (triggers final push)...')
  await session.abort()
}

async function main() {
  loadEnv()
  const userId = `demo-user-${Date.now()}`

  // 第一段对话:植入事实
  await runConversation('我的猫叫咪咪,2 岁,布偶猫。请记住这个。', userId)

  // 等 1 秒确保 COS 同步完成(这里依赖 send-end 的 push)
  await new Promise((r) => setTimeout(r, 1000))

  // 第二段对话:跨 conversation 测试记忆
  await runConversation('你还记得我家的猫吗?', userId)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 12.2: 校验类型**

```bash
pnpm type-check
```

Expected: PASS。

- [ ] **Step 12.3: Commit**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding
git add packages/open-agent-kernel/examples/16-user-memory.ts
git commit -m "docs(oak): add example 16 — userMemory across conversations"
```

---

## Task 13: 端到端示例 — `examples/17-user-memory-distributed.ts`

**Files:**
- Create: `packages/open-agent-kernel/examples/17-user-memory-distributed.ts`

演示同一 userId 跨 Node 进程(模拟跨节点)的串行访问 — 第一个进程结束后第二个进程能拿到记忆。

- [ ] **Step 13.1: 创建示例**

```typescript
/**
 * Example 17: userMemory 跨节点演示(串行)
 *
 * 演示:同一 userId 的请求依次落在两个不同的 SDK 实例(模拟跨节点),
 *      只要严格串行(第一个 abort 完才启第二个),记忆完整恢复。
 *
 * 注意:这个 demo 不并发 — spec §5.3 明确"业务方需保证同 user 串行"。
 *
 * Run:
 *   pnpm dlx tsx packages/open-agent-kernel/examples/17-user-memory-distributed.ts
 */

import { createAgent } from '../src/index.js'
import { loadEnv } from './_shared/env.js'

const userId = `dist-demo-${Date.now()}`

async function nodeA() {
  console.log('--- Node A ---')
  const agent = createAgent({
    envId: process.env.TCB_ENV_ID!,
    model: 'glm-5.1',
    systemPrompt: 'You are a helpful assistant. Remember user facts.',
    userMemory: { enabled: true },
  })
  const session = await agent.startSession({ userId })
  process.stdout.write('A: ')
  for await (const event of session.send('请记住:我的项目代号是 Aurora,部署在 ap-shanghai。')) {
    if (event.type === 'message_delta') process.stdout.write(event.text)
  }
  console.log('\n[A] aborting (final push to COS)...')
  await session.abort()
}

async function nodeB() {
  console.log('\n--- Node B (新的 OAK 实例,模拟新节点)---')
  const agent = createAgent({
    envId: process.env.TCB_ENV_ID!,
    model: 'glm-5.1',
    systemPrompt: 'You are a helpful assistant.',
    userMemory: { enabled: true },
  })
  const session = await agent.startSession({ userId })
  process.stdout.write('B: ')
  for await (const event of session.send('我的项目代号叫什么?部署在哪?')) {
    if (event.type === 'message_delta') process.stdout.write(event.text)
  }
  console.log('\n[B] done.')
  await session.abort()
}

async function main() {
  loadEnv()
  await nodeA()
  await new Promise((r) => setTimeout(r, 1500))   // 模拟节点间间隔
  await nodeB()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 13.2: 校验类型**

```bash
pnpm type-check
```

Expected: PASS。

- [ ] **Step 13.3: Commit**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding
git add packages/open-agent-kernel/examples/17-user-memory-distributed.ts
git commit -m "docs(oak): add example 17 — userMemory cross-process serialized"
```

---

## Task 14: README 更新

**Files:**
- Modify: `packages/open-agent-kernel/README.md`

加 4 个内容:
- 新增 cwd / skills / userMemory 配置介绍
- 平台资产 vs 用户私产章节
- sandbox scope 与 server `sandboxMode` 术语对应
- userMemory 的串行性前提声明

- [ ] **Step 14.1: 在 `## API 概览 > createAgent(config)` 表格加 3 行**

找到 README 中 `## API 概览` 下面的 createAgent 配置项表(line ~118),在表格末尾(`hooks` 后)加:

```markdown
| `cwd` | `string` | | 平台资产层根目录(skills + 项目级 CLAUDE.md 加载根) |
| `skills` | `{ enabled?: 'all' \| string[] }` | | 启用 SDK skills 能力(需配合 `cwd`) |
| `userMemory` | `{ enabled?: boolean }` | | 用户级长期记忆(SDK auto-memory 同步到 envId 对应 COS) |
```

- [ ] **Step 14.2: 在 sandbox scope 注释附近加术语对应**

找到 `## 架构` 章节(line ~392),在它前面(或合适位置)加新章节:

```markdown
## 平台资产 vs 用户私产

OAK 把 Claude SDK 文件系统资产分两类:

**平台资产**(共享 / 只读心智 — 业务方在镜像或 cwd 中管理):
- 项目级 `CLAUDE.md`(`cwd/CLAUDE.md`)
- Skills(`cwd/.claude/skills/`)
- 子 agent 定义、规则、命令(`cwd/.claude/{agents,rules,commands}/`)

**用户私产**(独占 / 读写心智 — SDK 自动写,跨节点同步到 COS):
- 用户级 `CLAUDE.md`(`<CLAUDE_CONFIG_DIR>/CLAUDE.md`)
- 主会话自动记忆(`<CLAUDE_CONFIG_DIR>/projects/*/memory/`)
- 子 agent 用户级记忆(`<CLAUDE_CONFIG_DIR>/agent-memory/`)

两者用不同的载体:平台资产走 `cwd` 字段,用户私产走 `userMemory.enabled = true`。

## 沙箱粒度(scope)与术语对照

`sandbox.scope` 描述 AGS 实例粒度,**与"沙箱内工作区目录派生"是两层正交关系**。

| OAK SDK | server feature/stateful-infra | 含义 |
|---|---|---|
| `scope: 'session'`(默认) | `sandboxMode: 'isolated'` | 每 session 一个独立 AGS 实例 |
| `scope: 'shared'` | `sandboxMode: 'shared'` | 同 envId 多 session 共享一个 AGS 实例 |

工作区目录派生(`/home/user/{conversationId}/`)由沙箱镜像负责,SDK 不感知。

## userMemory 启用前提

启用 `userMemory.enabled = true` 后,业务方上游必须保证:

> **同一 userId 的请求不能并发处理** — 即同一时刻不能有两个 SDK 节点同时为 alice 服务。

注意:这只要求"串行性",**不要求"永远固定到同一节点"**。alice 这次请求落 node1、下次落 node2 完全可以,只要两次不重叠即可。常见实现路径:Redis 互斥锁 / userId 队列 / 会话级路由 / 一致性哈希 — 任选其一。
```

- [ ] **Step 14.3: 校验 markdown 渲染**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding/packages/open-agent-kernel
cat README.md | head -50
```

Expected: 输出正常,无明显格式错误。

- [ ] **Step 14.4: Commit**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding
git add packages/open-agent-kernel/README.md
git commit -m "docs(oak): document cwd/skills/userMemory + scope terminology"
```

---

## Task 15: 最终回归验证

**Files:** 全部

- [ ] **Step 15.1: 跑全部测试**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding/packages/open-agent-kernel
pnpm type-check && pnpm test && pnpm build
```

Expected:
- `type-check`: PASS
- `test`: 所有 4 套测试通过(path-derivation / sync-rules / in-memory-store / sync-engine)
- `build`: 成功生成 dist/

- [ ] **Step 15.2: 验证 examples 编译通过**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding
pnpm -F @cloudbase/open-agent-kernel exec tsc --noEmit examples/15-skills.ts examples/16-user-memory.ts examples/17-user-memory-distributed.ts
```

Expected: 无类型错。如有缺 import 类型,补全。

- [ ] **Step 15.3: 验证幽灵 API 全部清除**

```bash
cd /Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding/packages/open-agent-kernel
grep -rn "capabilities\.compaction\|capabilities\.memory\|capabilities\.skills\|CompactionConfig" src/ --include='*.ts' | grep -v __tests__
```

Expected: 无输出(或只在被驳回的 spec 文档里)。

- [ ] **Step 15.4: 验证 src/index.ts 不暴露 claude-home 模块**

```bash
grep -n claude-home packages/open-agent-kernel/src/index.ts
```

Expected: 无输出(internal-only)。

- [ ] **Step 15.5: Commit final passes(若 step 15.1-15.4 引入了任何修复)**

如果上面四步引入小修(比如类型补全),:

```bash
git add -A && git commit -m "chore(oak): final cleanup before merge"
```

否则跳过。

- [ ] **Step 15.6: 记录到 HANDOVER.md**

打开 `packages/open-agent-kernel/HANDOVER.md`,在合适位置(顶部或 changelog 节)加一段:

```markdown
## v0.2.0 — cwd / skills / userMemory(Spec A)

**新增公共 API**:
- `AgentConfig.cwd?: string` — 平台资产根目录(skills + 项目 CLAUDE.md)
- `AgentConfig.skills?: { enabled?: 'all' | string[] }` — SDK skills 透传
- `AgentConfig.userMemory?: { enabled?: boolean }` — 用户级长期记忆(基于 SDK 原生 `.claude/` + COS 同步)

**破坏性改动**(从未生效字段,可接受):
- 删除 `SandboxCapabilities.skills` / `.memory` / `.compaction`
- 删除 `CompactionConfig` interface

**新增 internal 模块**:`src/claude-home/`(同步引擎 / store / 工具)— 不公开 export。

**新增 examples**:`15-skills.ts` / `16-user-memory.ts` / `17-user-memory-distributed.ts`

**测试**:`pnpm test` 跑 4 套单元测试(path-derivation / sync-rules / in-memory-store / sync-engine)。

**Spec**:`docs/superpowers/specs/2026-06-01-oak-cwd-skills-user-memory-design.md`(commit `2968bdd`)。
```

- [ ] **Step 15.7: Commit handover**

```bash
git add packages/open-agent-kernel/HANDOVER.md
git commit -m "docs(oak): add v0.2.0 changelog to HANDOVER"
```

---

## Done

至此 Spec A 全部 8 个阶段(A0-A8 重新映射为 Task 0-15)完成:

| Spec 阶段 | 对应 Task |
|---|---|
| A0(基础设施) | Task 0(vitest) |
| A1(path-derivation + sync-rules + dedup) | Task 1, 2, 3 |
| A2(InMemoryStore + types) | Task 4, 5 |
| A3(CloudBaseCosStore) | Task 7 |
| A4(SyncEngine) | Task 6 |
| A5(cwd/skills 透传) | Task 8 + Task 9(部分) |
| A6(userMemory 接入) | Task 9, 10 |
| A7(删幽灵字段) | Task 8 |
| A8(examples + README) | Task 11, 12, 13, 14, 15 |

最终回到 brainstorming → 准备启动 **Spec B**(沙箱工作区快照),可由用户独立触发。
