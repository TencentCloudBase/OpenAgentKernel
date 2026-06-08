# OAK Workspace Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `@cloudbase/open-agent-kernel` 加 sandbox workspace 快照能力。OAK SDK 在 `AgsStatefulSandbox` runtime 上,在 `session.startSession()` 时阻塞调 `POST /api/workspace/init`(同步触发镜像内 restoreFromCos),在 `session.send()` finally 阻塞调 `POST /api/workspace/snapshot`(timeout 30s),委托沙箱业务镜像 `tcb-remote-workspace` 完成 cwd ↔ COS 的实际同步。

**Architecture:**
- **委托不重造**:OAK 不实现任何 zstd/tar/COS FUSE 逻辑,完全靠 HTTP 触发镜像内已有机制
- **scope 约束**:`workspaceSnapshot` 启用要求 `sandbox.scope === 'shared'`,在 startSession fail-fast(详 Spec B §1.3)
- **失败哲学**:bootstrap 失败 throw 阻塞 startSession;snapshot 失败 yield warning event(不抹掉用户已看到的 final answer)
- **字段复用**:用既有的 `SandboxRuntime.backend === 'ags-stateful'` 做 `'auto'` 模式判定,**不引入新字段**

**bootstrap 的真实序列**(交叉验证 tcb-remote-workspace v0.4.0 源码):
1. `POST /api/workspace/init`(body 含 env 凭证)— 200 = `ensureWorkspace()` 同步完成,restore 状态已写本地文件 `.restore-in-status.json`(`workspace.ts:108-160`)。**注意**:init 200 body **不含 restoreStatus**(只返 `{ workspace, git, env }`,见 `routes/api.ts:240-312`)。
2. `GET /health` — body.restoreStatus 是 SyncStatus 对象(`routes/api.ts:200` 用 `readRestoreInStatus()`),含 restored/restoredAt/source/note。
3. 若 `restoreStatus === null`(竞争条件 — init 已返回但 health 这边还在读) → 简单重试一次 GET /health。
4. 若 `restoreStatus.restored === 'failed'` → throw SandboxRestoreFailed。

**Tech Stack:** TypeScript ESM, Vitest(已有), zod(用于 `/health` SyncStatus schema), 标准 Node `fetch`(undici)。

**Spec reference:** `packages/open-agent-kernel/docs/superpowers/specs/2026-06-08-oak-workspace-snapshot.md`(commit `db7c35b`)

**Working directory:** `/Users/lukejyhuang/Workspace/tencent/cloudbase/OpenVibeCoding/packages/open-agent-kernel/`

**Branch:** `feat/support-open-agent-kernel`

**File map:**

| 文件 | 状态 | 责任 |
|---|---|---|
| `src/sandbox/workspace-snapshot/types.ts` | Create | `SyncStatus` zod schema + `HealthResponse` 子集 schema + `WorkspaceInitResponse` schema(无 restoreStatus,只 workspace+git+env) + 错误码常量 |
| `src/sandbox/workspace-snapshot/errors.ts` | Create | `WorkspaceSnapshotError` / `SandboxRestoreFailed` / `SandboxRestoreTimeout` / `SandboxUnavailableError` |
| `src/sandbox/workspace-snapshot/init-client.ts` | Create | `callWorkspaceInit(inst, opts)` — POST /api/workspace/init,不重试,timeout 60s。**只返回 init 的 success body(workspace path 等),不含 restoreStatus** |
| `src/sandbox/workspace-snapshot/snapshot-client.ts` | Create | `callWorkspaceSnapshot(inst, opts)` — POST /api/workspace/snapshot,1s backoff retry once on retryable,timeout 30s |
| `src/sandbox/workspace-snapshot/health-client.ts` | Create | `getHealthRestoreStatus(inst)` 用于事后查询;**新增 `fetchRestoreStatus(inst)` 在 bootstrap 中读 body.restoreStatus 拿到真实 SyncStatus**(graceful 重试 1 次以处理 init/health 竞争) |
| `src/sandbox/workspace-snapshot/snapshot-engine.ts` | Create | `WorkspaceSnapshotEngine.bootstrap()`(init → fetch /health → 解析 restoreStatus → 失败 throw)/ `snapshot()` / `getRestoreStatus()` |
| `src/sandbox/workspace-snapshot/index.ts` | Create | 内部 facade(不被 `src/index.ts` re-export) |
| `src/sandbox/workspace-snapshot/__tests__/types.test.ts` | Create | 单元测试 zod schema 容错 |
| `src/sandbox/workspace-snapshot/__tests__/init-client.test.ts` | Create | mock fetch:成功(返回 workspace+git)/ 5xx / timeout |
| `src/sandbox/workspace-snapshot/__tests__/snapshot-client.test.ts` | Create | mock fetch:成功 / 500-retryable retry / 500-non-retryable / 502 / timeout |
| `src/sandbox/workspace-snapshot/__tests__/health-client.test.ts` | Create | mock fetch:各种 SyncStatus 形态 / null / 字段缺失 graceful;`fetchRestoreStatus` 重试逻辑 |
| `src/sandbox/workspace-snapshot/__tests__/snapshot-engine.test.ts` | Create | 整合 + bootstrap 序列(init → health → restoreStatus 解析)+ scope 校验 |
| `src/sandbox/types.ts` | Modify | `SandboxRuntime.backend` 注释升级("诊断日志用"→"业务判定字段") |
| `src/public/types.ts` | Modify | `SandboxConfig` 加 `workspaceSnapshot` / `workspaceSnapshotTimeoutMs` / `workspaceInitTimeoutMs`;`Session` 加 `snapshotWorkspace?` / `getRestoreStatus?` |
| `src/runtime/agent-builder.ts` | Modify | `resolveSnapshotMode()` 函数 + scope 校验 + engine 构造 |
| `src/public/create-agent.ts` | Modify | startSession 调 `engine.bootstrap()`;send finally 调 `engine.snapshot()` 并在失败时 yield warning event |
| `src/internal/errors.ts` | Modify | `ConfigError` 若不存在则补(scope 校验失败用) |
| `examples/18-workspace-snapshot.ts` | Create | 单进程演示:写文件 → snapshot → 重启 → restore |
| `examples/19-workspace-snapshot-distributed.ts` | Create | Node A 写文件 + Node B 接续 |
| `README.md`(packages/open-agent-kernel) | Modify | userManual 章节加 workspaceSnapshot 用法 |

---

### Task 0: zod schema(`workspace-snapshot/types.ts`)

**Files:**
- Create: `src/sandbox/workspace-snapshot/types.ts`
- Test: `src/sandbox/workspace-snapshot/__tests__/types.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// __tests__/types.test.ts
import { describe, it, expect } from 'vitest'
import { syncStatusSchema, healthResponseSchema, workspaceInitResponseSchema } from '../types.js'

describe('syncStatusSchema', () => {
  it('parses minimal valid SyncStatus', () => {
    const s = syncStatusSchema.parse({
      restored: 'full',
      restoredAt: '2026-06-08T10:00:00Z',
      source: 'cos',
    })
    expect(s.restored).toBe('full')
  })

  it('accepts all 4 restored values', () => {
    for (const r of ['full', 'partial', 'fresh', 'failed']) {
      expect(() => syncStatusSchema.parse({ restored: r, restoredAt: 'x', source: 'cos' })).not.toThrow()
    }
  })

  it('rejects unknown restored value', () => {
    expect(() => syncStatusSchema.parse({ restored: 'unknown', restoredAt: 'x', source: 'cos' })).toThrow()
  })

  it('accepts optional fields (restoreMs, cosMetaSizeBytes, steps, note)', () => {
    const s = syncStatusSchema.parse({
      restored: 'full',
      restoredAt: '2026-06-08T10:00:00Z',
      source: 'cos',
      restoreMs: 1234,
      cosMetaSizeBytes: 4096,
      cosMetaFileCount: 12,
      steps: { restoreFromCosMs: 800, ensureSkelFilesMs: 12 },
      note: 'restored from snapshot abc',
    })
    expect(s.restoreMs).toBe(1234)
    expect(s.steps?.restoreFromCosMs).toBe(800)
  })
})

describe('healthResponseSchema', () => {
  it('parses health body with restoreStatus null (still booting)', () => {
    const r = healthResponseSchema.parse({ ok: true, restoreStatus: null })
    expect(r.restoreStatus).toBeNull()
  })

  it('parses health body with full SyncStatus', () => {
    const r = healthResponseSchema.parse({
      ok: true,
      restoreStatus: { restored: 'full', restoredAt: 'x', source: 'cos' },
    })
    expect(r.restoreStatus?.restored).toBe('full')
  })

  it('extra fields are stripped (forward compat)', () => {
    const r = healthResponseSchema.parse({
      ok: true,
      restoreStatus: null,
      bootProfile: { extra: 'whatever' },
      futureField: 123,
    })
    expect(r.ok).toBe(true)
  })
})

describe('workspaceInitResponseSchema', () => {
  it('parses real init response (no restoreStatus, only workspace + git + env)', () => {
    const r = workspaceInitResponseSchema.parse({
      success: true,
      result: {
        workspace: '/home/user',
        git: { enabled: true, hasGit: true, branch: 'main' },
        env: { TCB_ENV_ID: '<set>' },
      },
    })
    expect(r.result.workspace).toBe('/home/user')
  })

  it('accepts optional set/ignored/skillsMaterialized fields', () => {
    const r = workspaceInitResponseSchema.parse({
      success: true,
      result: {
        workspace: '/home/user',
        git: { enabled: false, hasGit: false },
        env: {},
        set: ['TCB_ENV_ID'],
        ignored: ['UNSAFE_KEY'],
        skillsMaterialized: 3,
      },
    })
    expect(r.result.set).toEqual(['TCB_ENV_ID'])
  })

  it('extra fields are stripped (forward compat)', () => {
    const r = workspaceInitResponseSchema.parse({
      success: true,
      result: {
        workspace: '/home/user',
        git: { enabled: true, hasGit: true },
        env: {},
        envSet: ['x'],  // 镜像未来可能加的字段
        futureField: 'whatever',
      },
    })
    expect(r.success).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试 → fail**

Run: `pnpm test -- --run src/sandbox/workspace-snapshot/__tests__/types.test.ts`
Expected: FAIL "Cannot find module '../types.js'"

- [ ] **Step 3: 实现 types.ts**

```typescript
// types.ts
import { z } from 'zod'

/** restored 取值,直接对应 tcb-remote-workspace cos-sync.ts:135 SyncStatus */
export const restoredEnum = z.enum(['full', 'partial', 'fresh', 'failed'])
export type Restored = z.infer<typeof restoredEnum>

/** SyncStatus 真实结构,见 cos-sync.ts:135-144 */
export const syncStatusSchema = z.object({
  restored: restoredEnum,
  restoredAt: z.string(),
  restoreMs: z.number().optional(),
  source: z.enum(['cos', 'git', 'none']),
  cosMetaSizeBytes: z.number().optional(),
  cosMetaFileCount: z.number().optional(),
  steps: z.record(z.string(), z.number()).optional(),
  note: z.string().optional(),
})
export type SyncStatus = z.infer<typeof syncStatusSchema>

/**
 * /health 响应的最小子集(我们只关心 restoreStatus)。
 * 见 routes/api.ts:200,bootstrap 序列里 init 后必须 GET /health 拿真实 SyncStatus。
 *
 * 注意:`/health` 在镜像还没 ready 时返回 503 + problem+json,client 层要处理这种情况。
 */
export const healthResponseSchema = z
  .object({
    ok: z.boolean().optional(),
    restoreStatus: syncStatusSchema.nullable().optional(),
  })
  .passthrough()
export type HealthResponse = z.infer<typeof healthResponseSchema>

/**
 * `POST /api/workspace/init` 真实成功响应(见 routes/api.ts:240-300)。
 * 注意:**body 不含 restoreStatus** — 那个只在 `/health` 上读。
 */
export const workspaceInitResponseSchema = z.object({
  success: z.literal(true),
  result: z
    .object({
      workspace: z.string(),
      git: z
        .object({
          enabled: z.boolean(),
          hasGit: z.boolean(),
          branch: z.string().optional(),
        })
        .passthrough(),
      env: z.record(z.string(), z.unknown()),
      set: z.array(z.string()).optional(),
      envSet: z.array(z.string()).optional(),     // 镜像内部别名,跟 set 同义
      ignored: z.array(z.string()).optional(),
      skillsMaterialized: z.number().optional(),
    })
    .passthrough(),
})
export type WorkspaceInitResponse = z.infer<typeof workspaceInitResponseSchema>

/** 镜像约定的 retryable error code(application/problem+json) */
export const RETRYABLE_ERROR_CODES = new Set(['workspace_snapshot_failed'])

/** snapshot 成功响应的外层 wrapper */
export const snapshotSuccessSchema = z.object({
  success: z.literal(true),
  result: z.object({ ms: z.number() }),
})
```

- [ ] **Step 4: 跑测试 → pass**
- [ ] **Step 5: commit `feat(oak): add workspace-snapshot types and zod schemas`**

---

### Task 1: errors(`workspace-snapshot/errors.ts`)

**Files:**
- Create: `src/sandbox/workspace-snapshot/errors.ts`

- [ ] **Step 1: 写测试**

```typescript
// __tests__/errors.test.ts
import { describe, it, expect } from 'vitest'
import {
  WorkspaceSnapshotError,
  SandboxRestoreFailed,
  SandboxRestoreTimeout,
  SandboxUnavailableError,
} from '../errors.js'

describe('error classes', () => {
  it('WorkspaceSnapshotError carries retryable flag', () => {
    const e = new WorkspaceSnapshotError('boom', true)
    expect(e.retryable).toBe(true)
    expect(e.message).toBe('boom')
    expect(e.name).toBe('WorkspaceSnapshotError')
  })

  it('SandboxRestoreFailed carries note', () => {
    const e = new SandboxRestoreFailed('failed', { note: 'COS unreachable' })
    expect(e.note).toBe('COS unreachable')
    expect(e.name).toBe('SandboxRestoreFailed')
  })

  it('SandboxRestoreTimeout carries timeoutMs', () => {
    const e = new SandboxRestoreTimeout('timeout', 60_000)
    expect(e.timeoutMs).toBe(60_000)
  })

  it('SandboxUnavailableError carries httpStatus', () => {
    const e = new SandboxUnavailableError('502', 502)
    expect(e.httpStatus).toBe(502)
  })
})
```

- [ ] **Step 2: 跑 → FAIL**

- [ ] **Step 3: 实现 errors.ts**

```typescript
export class WorkspaceSnapshotError extends Error {
  constructor(message: string, public readonly retryable: boolean, public readonly cause?: unknown) {
    super(message)
    this.name = 'WorkspaceSnapshotError'
  }
}

export class SandboxRestoreFailed extends Error {
  readonly note?: string
  constructor(message: string, opts: { note?: string; cause?: unknown } = {}) {
    super(message)
    this.name = 'SandboxRestoreFailed'
    this.note = opts.note
  }
}

export class SandboxRestoreTimeout extends Error {
  constructor(message: string, public readonly timeoutMs: number) {
    super(message)
    this.name = 'SandboxRestoreTimeout'
  }
}

export class SandboxUnavailableError extends Error {
  constructor(message: string, public readonly httpStatus: number) {
    super(message)
    this.name = 'SandboxUnavailableError'
  }
}
```

- [ ] **Step 4: 跑 → PASS**
- [ ] **Step 5: commit `feat(oak): add workspace-snapshot error classes`**

---

### Task 2: init client(`workspace-snapshot/init-client.ts`)

**Files:**
- Create: `src/sandbox/workspace-snapshot/init-client.ts`
- Test: `src/sandbox/workspace-snapshot/__tests__/init-client.test.ts`

**职责说明**:仅负责 `POST /api/workspace/init` 这一次 HTTP 调用。**不解析 restoreStatus**(因为 init body 不含此字段);返回 `WorkspaceInitResponse` 的 `result` 字段(workspace path / git / env)。restoreStatus 由 health-client 在 bootstrap 阶段单独读 `/health` 拿到。

- [ ] **Step 1: 写测试**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { callWorkspaceInit } from '../init-client.js'
import { SandboxRestoreFailed, SandboxRestoreTimeout } from '../errors.js'

function mockInst(handler: (path: string, init?: RequestInit) => Promise<Response>) {
  return {
    id: 'inst-1',
    request: vi.fn().mockImplementation(handler),
    release: vi.fn(),
  }
}

describe('callWorkspaceInit', () => {
  it('returns init result on success (no restoreStatus expected)', async () => {
    const inst = mockInst(async (path) => {
      expect(path).toBe('/api/workspace/init')
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            workspace: '/home/user',
            git: { enabled: true, hasGit: true, branch: 'main' },
            env: { TCB_ENV_ID: '<set>' },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    const result = await callWorkspaceInit(inst as any, { credentials: { TCB_ENV_ID: 'env-1' }, timeoutMs: 60_000 })
    expect(result.workspace).toBe('/home/user')
    // 不应有 restoreStatus 字段(init body 不返回它)
    expect((result as any).restoreStatus).toBeUndefined()
  })

  it('throws SandboxRestoreFailed on 5xx', async () => {
    const inst = mockInst(async () => new Response('boom', { status: 500 }))
    await expect(callWorkspaceInit(inst as any, { credentials: {}, timeoutMs: 60_000 })).rejects.toThrow(SandboxRestoreFailed)
  })

  it('throws SandboxRestoreFailed when body schema mismatch', async () => {
    const inst = mockInst(async () =>
      new Response(JSON.stringify({ success: false, msg: 'unexpected shape' }), { status: 200 }))
    await expect(callWorkspaceInit(inst as any, { credentials: {}, timeoutMs: 60_000 })).rejects.toThrow(SandboxRestoreFailed)
  })

  it('throws SandboxRestoreTimeout when timeout exceeded', async () => {
    const inst = mockInst(async (_p, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }))
    await expect(callWorkspaceInit(inst as any, { credentials: {}, timeoutMs: 100 })).rejects.toThrow(SandboxRestoreTimeout)
  })

  it('sends credentials in body.env', async () => {
    let capturedBody: any
    const inst = mockInst(async (_p, init) => {
      capturedBody = JSON.parse(init?.body as string)
      return new Response(JSON.stringify({
        success: true,
        result: { workspace: '/home/user', git: { enabled: false, hasGit: false }, env: {} },
      }), { status: 200 })
    })
    await callWorkspaceInit(inst as any, {
      credentials: { TCB_ENV_ID: 'env-1', TCB_SECRET_ID: 's' },
      timeoutMs: 60_000,
    })
    expect(capturedBody.env).toEqual({ TCB_ENV_ID: 'env-1', TCB_SECRET_ID: 's' })
  })
})
```

- [ ] **Step 2: 跑 → FAIL**

- [ ] **Step 3: 实现 init-client.ts**

```typescript
import type { SandboxInstance } from '../types.js'
import { SandboxRestoreFailed, SandboxRestoreTimeout } from './errors.js'
import { workspaceInitResponseSchema, type WorkspaceInitResponse } from './types.js'

export interface CallWorkspaceInitOpts {
  /** body.env 注入到镜像内的凭证(沿用 tcb-remote-workspace 既有契约)*/
  credentials: Record<string, string>
  /** HTTP timeout,默认上层传 60_000 */
  timeoutMs: number
}

/**
 * 调 POST /api/workspace/init,返回 init 真实 body 的 result 字段。
 *
 * 重要:**init body 不含 restoreStatus**(见 routes/api.ts:240-312 + workspace.ts:699
 * `getWorkspaceStatus` 只返 workspace+git)。restore 的 SyncStatus 必须在 init
 * 之后单独 GET /health 解析 body.restoreStatus(由 health-client.fetchRestoreStatus 完成)。
 *
 * 不重试 — restore 是 expensive,失败应让业务方明确处理。
 */
export async function callWorkspaceInit(
  inst: SandboxInstance,
  opts: CallWorkspaceInitOpts,
): Promise<WorkspaceInitResponse['result']> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), opts.timeoutMs)
  try {
    const res = await inst.request('/api/workspace/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env: opts.credentials }),
      signal: ac.signal,
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new SandboxRestoreFailed(`init failed (${res.status}): ${detail.slice(0, 200)}`)
    }

    const body = await res.json().catch(() => null)
    if (!body) throw new SandboxRestoreFailed('init returned non-json body')

    const parsed = workspaceInitResponseSchema.safeParse(body)
    if (!parsed.success) {
      throw new SandboxRestoreFailed(`init response schema mismatch: ${parsed.error.message}`)
    }
    return parsed.data.result
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new SandboxRestoreTimeout(`init timeout after ${opts.timeoutMs}ms`, opts.timeoutMs)
    }
    if (err instanceof SandboxRestoreFailed || err instanceof SandboxRestoreTimeout) throw err
    throw new SandboxRestoreFailed(`init unexpected error: ${(err as Error).message}`, { cause: err })
  } finally {
    clearTimeout(t)
  }
}
```

- [ ] **Step 4: 跑 → PASS**
- [ ] **Step 5: commit `feat(oak): add workspace-snapshot init-client`**

---

### Task 3: snapshot client(`workspace-snapshot/snapshot-client.ts`)

**Files:**
- Create: `src/sandbox/workspace-snapshot/snapshot-client.ts`
- Test: `src/sandbox/workspace-snapshot/__tests__/snapshot-client.test.ts`

- [ ] **Step 1: 写测试**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { callWorkspaceSnapshot } from '../snapshot-client.js'
import { WorkspaceSnapshotError, SandboxUnavailableError } from '../errors.js'

const PROBLEM_HEADERS = { 'Content-Type': 'application/problem+json' }

function mockInst(responses: Array<() => Response>) {
  const queue = [...responses]
  return {
    id: 'inst-1',
    request: vi.fn().mockImplementation(async () => queue.shift()!()),
    release: vi.fn(),
  }
}

describe('callWorkspaceSnapshot', () => {
  it('parses { success, result: { ms } } on 200', async () => {
    const inst = mockInst([() =>
      new Response(JSON.stringify({ success: true, result: { ms: 1234 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ])
    const r = await callWorkspaceSnapshot(inst as any, { timeoutMs: 30_000, retryBackoffMs: 0 })
    expect(r.ms).toBe(1234)
  })

  it('retries once on retryable 500', async () => {
    const inst = mockInst([
      () => new Response(
        JSON.stringify({ errorCode: 'workspace_snapshot_failed', retryable: true, detail: 'mutex held' }),
        { status: 500, headers: PROBLEM_HEADERS },
      ),
      () => new Response(JSON.stringify({ success: true, result: { ms: 200 } }), { status: 200 }),
    ])
    const r = await callWorkspaceSnapshot(inst as any, { timeoutMs: 30_000, retryBackoffMs: 0 })
    expect(r.ms).toBe(200)
    expect(inst.request).toHaveBeenCalledTimes(2)
  })

  it('does not retry on retryable=false', async () => {
    const inst = mockInst([() =>
      new Response(
        JSON.stringify({ errorCode: 'workspace_snapshot_failed', retryable: false, detail: 'fatal' }),
        { status: 500, headers: PROBLEM_HEADERS },
      ),
    ])
    await expect(callWorkspaceSnapshot(inst as any, { timeoutMs: 30_000, retryBackoffMs: 0 })).rejects.toThrow(WorkspaceSnapshotError)
    expect(inst.request).toHaveBeenCalledTimes(1)
  })

  it('does not retry on 502/503', async () => {
    const inst = mockInst([() => new Response('upstream gone', { status: 502 })])
    await expect(callWorkspaceSnapshot(inst as any, { timeoutMs: 30_000, retryBackoffMs: 0 })).rejects.toThrow(SandboxUnavailableError)
    expect(inst.request).toHaveBeenCalledTimes(1)
  })

  it('throws on timeout', async () => {
    const inst = {
      id: 'x',
      request: vi.fn().mockImplementation(async (_p: string, init?: RequestInit) =>
        new Promise((_, rej) => init?.signal?.addEventListener('abort', () =>
          rej(new DOMException('aborted', 'AbortError')))),
      ),
      release: vi.fn(),
    }
    await expect(callWorkspaceSnapshot(inst as any, { timeoutMs: 50, retryBackoffMs: 0 })).rejects.toThrow(/timeout/)
  })
})
```

- [ ] **Step 2: 跑 → FAIL**

- [ ] **Step 3: 实现 snapshot-client.ts**

```typescript
import type { SandboxInstance } from '../types.js'
import { WorkspaceSnapshotError, SandboxUnavailableError } from './errors.js'
import { snapshotSuccessSchema, RETRYABLE_ERROR_CODES } from './types.js'

export interface CallWorkspaceSnapshotOpts {
  timeoutMs: number      // default 30_000
  retryBackoffMs: number // default 1_000
}

interface ProblemBody {
  errorCode?: string
  detail?: string
  retryable?: boolean
}

async function attempt(inst: SandboxInstance, timeoutMs: number): Promise<{ ms: number }> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await inst.request('/api/workspace/snapshot', {
      method: 'POST',
      signal: ac.signal,
    })

    if (res.status >= 500 && res.status < 600) {
      // 502/503/504 = 基础设施
      if (res.status !== 500) {
        throw new SandboxUnavailableError(`upstream ${res.status}`, res.status)
      }
      // 500: 解析 problem+json
      const body = (await res.json().catch(() => ({}))) as ProblemBody
      const retryable = body.retryable === true && body.errorCode != null && RETRYABLE_ERROR_CODES.has(body.errorCode)
      throw new WorkspaceSnapshotError(
        `snapshot failed: ${body.errorCode ?? 'unknown'}: ${body.detail ?? ''}`,
        retryable,
        body,
      )
    }

    if (!res.ok) {
      throw new WorkspaceSnapshotError(`snapshot http ${res.status}`, false)
    }

    const json = await res.json()
    return snapshotSuccessSchema.parse(json).result
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new WorkspaceSnapshotError(`snapshot timeout after ${timeoutMs}ms`, false)
    }
    throw err
  } finally {
    clearTimeout(t)
  }
}

export async function callWorkspaceSnapshot(
  inst: SandboxInstance,
  opts: CallWorkspaceSnapshotOpts,
): Promise<{ ms: number }> {
  try {
    return await attempt(inst, opts.timeoutMs)
  } catch (err) {
    if (err instanceof WorkspaceSnapshotError && err.retryable) {
      await new Promise((r) => setTimeout(r, opts.retryBackoffMs))
      return await attempt(inst, opts.timeoutMs)
    }
    throw err
  }
}
```

- [ ] **Step 4: 跑 → PASS**
- [ ] **Step 5: commit `feat(oak): add workspace-snapshot snapshot-client with retry`**

---

### Task 4: health client(`workspace-snapshot/health-client.ts`)

**Files:**
- Create: `src/sandbox/workspace-snapshot/health-client.ts`
- Test: `src/sandbox/workspace-snapshot/__tests__/health-client.test.ts`

**职责说明**:暴露**两个**函数:
1. `fetchRestoreStatus(inst, opts)`:bootstrap 阶段使用,返回完整的 `SyncStatus | null`。null 时小幅重试(最多 N 次,每次 200ms)以处理 init/health 之间的短暂 race。
2. `getHealthRestoreStatus(inst)`:供 `Session.getRestoreStatus()` 公开 API 用,只返回 `Restored | null`(graceful,失败一律 null,不重试不抛错)。

- [ ] **Step 1: 写测试**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { fetchRestoreStatus, getHealthRestoreStatus } from '../health-client.js'

function mockInst(responses: Array<() => Response>) {
  const queue = [...responses]
  return {
    id: 'x',
    request: vi.fn().mockImplementation(async () => queue.shift()!()),
    release: vi.fn(),
  }
}

describe('fetchRestoreStatus(bootstrap 路径,会重试)', () => {
  it('returns SyncStatus on first success', async () => {
    const inst = mockInst([() =>
      new Response(JSON.stringify({
        ok: true,
        restoreStatus: { restored: 'full', restoredAt: 'x', source: 'cos' },
      }), { status: 200 })
    ])
    const status = await fetchRestoreStatus(inst as any, { maxAttempts: 3, retryDelayMs: 0 })
    expect(status?.restored).toBe('full')
  })

  it('retries when restoreStatus is null (init/health race)', async () => {
    const inst = mockInst([
      () => new Response(JSON.stringify({ ok: true, restoreStatus: null }), { status: 200 }),
      () => new Response(JSON.stringify({ ok: true, restoreStatus: null }), { status: 200 }),
      () => new Response(JSON.stringify({
        ok: true, restoreStatus: { restored: 'fresh', restoredAt: 'x', source: 'none' },
      }), { status: 200 }),
    ])
    const status = await fetchRestoreStatus(inst as any, { maxAttempts: 5, retryDelayMs: 0 })
    expect(status?.restored).toBe('fresh')
    expect(inst.request).toHaveBeenCalledTimes(3)
  })

  it('returns null after exhausting maxAttempts', async () => {
    const inst = mockInst([
      () => new Response(JSON.stringify({ ok: true, restoreStatus: null }), { status: 200 }),
      () => new Response(JSON.stringify({ ok: true, restoreStatus: null }), { status: 200 }),
    ])
    const status = await fetchRestoreStatus(inst as any, { maxAttempts: 2, retryDelayMs: 0 })
    expect(status).toBeNull()
  })

  it('returns null on /health 5xx (graceful, lets caller proceed without restoreStatus)', async () => {
    const inst = mockInst([() => new Response('boom', { status: 503 })])
    const status = await fetchRestoreStatus(inst as any, { maxAttempts: 1, retryDelayMs: 0 })
    expect(status).toBeNull()
  })
})

describe('getHealthRestoreStatus(事后查询路径,不重试)', () => {
  it('returns "full" when restoreStatus.restored === "full"', async () => {
    const inst = mockInst([() =>
      new Response(JSON.stringify({
        ok: true, restoreStatus: { restored: 'full', restoredAt: 'x', source: 'cos' },
      }), { status: 200 })
    ])
    expect(await getHealthRestoreStatus(inst as any)).toBe('full')
  })

  it('returns null when restoreStatus is null', async () => {
    const inst = mockInst([() =>
      new Response(JSON.stringify({ ok: true, restoreStatus: null }), { status: 200 })
    ])
    expect(await getHealthRestoreStatus(inst as any)).toBeNull()
  })

  it('returns null when /health 5xx (graceful)', async () => {
    const inst = mockInst([() => new Response('boom', { status: 503 })])
    expect(await getHealthRestoreStatus(inst as any)).toBeNull()
  })

  it('returns null on schema mismatch (graceful, never throws)', async () => {
    const inst = mockInst([() => new Response(JSON.stringify({ unexpected: true }), { status: 200 })])
    expect(await getHealthRestoreStatus(inst as any)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑 → FAIL**

- [ ] **Step 3: 实现 health-client.ts**

```typescript
import type { SandboxInstance } from '../types.js'
import { healthResponseSchema, type Restored, type SyncStatus } from './types.js'

async function readHealthOnce(inst: SandboxInstance): Promise<SyncStatus | null | 'unavailable'> {
  try {
    const res = await inst.request('/health', { method: 'GET' })
    if (!res.ok) return 'unavailable'
    const json = await res.json().catch(() => null)
    if (!json) return 'unavailable'
    const parsed = healthResponseSchema.safeParse(json)
    if (!parsed.success) return 'unavailable'
    // null = restoreStatus 字段还没有(init 跟 health 还没同步)
    return parsed.data.restoreStatus ?? null
  } catch {
    return 'unavailable'
  }
}

export interface FetchRestoreStatusOpts {
  /** bootstrap 阶段允许重试,处理 init→health 之间的状态写入延迟 */
  maxAttempts: number          // default 3
  retryDelayMs: number         // default 200
}

/**
 * bootstrap 阶段使用 — 拿完整的 SyncStatus 决定是否抛 SandboxRestoreFailed。
 * - 成功(SyncStatus) → 返回
 * - 'unavailable' / null 重试,直到 maxAttempts 用完
 * - 仍 null/unavailable → 返回 null,让 caller 决定(通常是降级为"假装 fresh")
 */
export async function fetchRestoreStatus(
  inst: SandboxInstance,
  opts: FetchRestoreStatusOpts,
): Promise<SyncStatus | null> {
  for (let i = 0; i < opts.maxAttempts; i++) {
    const r = await readHealthOnce(inst)
    if (r && r !== 'unavailable') return r
    if (i < opts.maxAttempts - 1) {
      await new Promise((res) => setTimeout(res, opts.retryDelayMs))
    }
  }
  return null
}

/**
 * 事后查询(Session.getRestoreStatus()),graceful 失败一律 null,不重试不抛错。
 */
export async function getHealthRestoreStatus(inst: SandboxInstance): Promise<Restored | null> {
  const r = await readHealthOnce(inst)
  if (!r || r === 'unavailable') return null
  return r.restored
}
```

- [ ] **Step 4: 跑 → PASS**
- [ ] **Step 5: commit `feat(oak): add workspace-snapshot health-client with bootstrap retry`**

---

### Task 5: snapshot engine(`workspace-snapshot/snapshot-engine.ts`)

**Files:**
- Create: `src/sandbox/workspace-snapshot/snapshot-engine.ts`
- Create: `src/sandbox/workspace-snapshot/index.ts`
- Test: `src/sandbox/workspace-snapshot/__tests__/snapshot-engine.test.ts`

**职责说明**:Engine 是这套客户端的总装。`bootstrap()` 实现两步序列:
1. `callWorkspaceInit()` — POST /api/workspace/init,确保 ensureWorkspace 已 await(包括 restoreFromCos)
2. `fetchRestoreStatus()` — GET /health 拿 restoreStatus,若 `'failed'` → throw `SandboxRestoreFailed`;`null`(撑过重试仍然没拿到)→ 视为成功降级("假装 fresh"日志 warn,session 仍可用)

- [ ] **Step 1: 写测试**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { WorkspaceSnapshotEngine } from '../snapshot-engine.js'
import { SandboxRestoreFailed } from '../errors.js'

const goodInit = {
  success: true,
  result: {
    workspace: '/home/user',
    git: { enabled: true, hasGit: true, branch: 'main' },
    env: {},
  },
}
const fullHealth = {
  ok: true,
  restoreStatus: { restored: 'full', restoredAt: 'x', source: 'cos' },
}
const failedHealth = {
  ok: true,
  restoreStatus: { restored: 'failed', restoredAt: 'x', source: 'cos', note: 'boom' },
}
const goodSnap = { success: true, result: { ms: 100 } }

function mockInst(handlers: Record<string, () => Response>) {
  return {
    id: 'x',
    request: vi.fn().mockImplementation(async (path: string) =>
      handlers[path]?.() ?? new Response('not handled', { status: 404 })),
    release: vi.fn(),
  }
}

describe('WorkspaceSnapshotEngine', () => {
  it('bootstrap returns SyncStatus when init OK + health says full', async () => {
    const inst = mockInst({
      '/api/workspace/init': () => new Response(JSON.stringify(goodInit), { status: 200 }),
      '/health': () => new Response(JSON.stringify(fullHealth), { status: 200 }),
    })
    const e = new WorkspaceSnapshotEngine({ healthRetryDelayMs: 0 })
    const status = await e.bootstrap(inst as any, { credentials: {} })
    expect(status?.restored).toBe('full')
  })

  it('bootstrap throws SandboxRestoreFailed when health says failed', async () => {
    const inst = mockInst({
      '/api/workspace/init': () => new Response(JSON.stringify(goodInit), { status: 200 }),
      '/health': () => new Response(JSON.stringify(failedHealth), { status: 200 }),
    })
    const e = new WorkspaceSnapshotEngine({ healthRetryDelayMs: 0 })
    await expect(e.bootstrap(inst as any, { credentials: {} })).rejects.toThrow(SandboxRestoreFailed)
  })

  it('bootstrap throws SandboxRestoreFailed when init 5xx (does not call /health)', async () => {
    const inst = mockInst({
      '/api/workspace/init': () => new Response('boom', { status: 500 }),
    })
    const e = new WorkspaceSnapshotEngine({ healthRetryDelayMs: 0 })
    await expect(e.bootstrap(inst as any, { credentials: {} })).rejects.toThrow(SandboxRestoreFailed)
  })

  it('bootstrap returns null when /health restoreStatus stays null after retries (graceful degrade)', async () => {
    const inst = mockInst({
      '/api/workspace/init': () => new Response(JSON.stringify(goodInit), { status: 200 }),
      '/health': () => new Response(JSON.stringify({ ok: true, restoreStatus: null }), { status: 200 }),
    })
    const e = new WorkspaceSnapshotEngine({ healthMaxAttempts: 2, healthRetryDelayMs: 0 })
    const status = await e.bootstrap(inst as any, { credentials: {} })
    expect(status).toBeNull()  // session 仍可用,只是不知道 restore 是否真完成
  })

  it('snapshot delegates to client', async () => {
    const inst = mockInst({
      '/api/workspace/snapshot': () => new Response(JSON.stringify(goodSnap), { status: 200 }),
    })
    const e = new WorkspaceSnapshotEngine()
    const r = await e.snapshot(inst as any)
    expect(r.ms).toBe(100)
  })

  it('getRestoreStatus reads /health (not retried)', async () => {
    const inst = mockInst({
      '/health': () => new Response(JSON.stringify({
        ok: true, restoreStatus: { restored: 'partial', restoredAt: 'x', source: 'cos' },
      }), { status: 200 }),
    })
    const e = new WorkspaceSnapshotEngine()
    expect(await e.getRestoreStatus(inst as any)).toBe('partial')
  })
})
```

- [ ] **Step 2: 跑 → FAIL**

- [ ] **Step 3: 实现 snapshot-engine.ts**

```typescript
import type { SandboxInstance } from '../types.js'
import { callWorkspaceInit } from './init-client.js'
import { callWorkspaceSnapshot } from './snapshot-client.js'
import { fetchRestoreStatus, getHealthRestoreStatus } from './health-client.js'
import { SandboxRestoreFailed } from './errors.js'
import type { SyncStatus, Restored } from './types.js'

export interface WorkspaceSnapshotEngineOptions {
  snapshotTimeoutMs?: number    // default 30_000
  initTimeoutMs?: number        // default 60_000
  retryBackoffMs?: number       // default 1_000(snapshot retryable backoff)
  healthMaxAttempts?: number    // default 3(bootstrap 阶段读 /health 重试次数)
  healthRetryDelayMs?: number   // default 200
}

interface ResolvedOpts extends Required<WorkspaceSnapshotEngineOptions> {}

const DEFAULT: ResolvedOpts = {
  snapshotTimeoutMs: 30_000,
  initTimeoutMs: 60_000,
  retryBackoffMs: 1_000,
  healthMaxAttempts: 3,
  healthRetryDelayMs: 200,
}

export class WorkspaceSnapshotEngine {
  private readonly opts: ResolvedOpts

  constructor(opts: WorkspaceSnapshotEngineOptions = {}) {
    this.opts = { ...DEFAULT, ...opts }
  }

  /**
   * startSession 时调用。两步序列:
   * 1. POST /api/workspace/init(同步触发 ensureWorkspace + restoreFromCos)
   * 2. GET /health 解析 body.restoreStatus 拿真实 SyncStatus
   *
   * - SyncStatus.restored === 'failed' → throw SandboxRestoreFailed
   * - SyncStatus 拿不到(/health 5xx 或 restoreStatus 一直 null)→ 返回 null,session 继续,
   *   但 OAK 应在调用方 log 提示"无法确认 restore 状态,假装 fresh"
   */
  async bootstrap(
    inst: SandboxInstance,
    args: { credentials: Record<string, string> },
  ): Promise<SyncStatus | null> {
    // 1. 触发 init(内部已等到 restoreFromCos 完成)
    await callWorkspaceInit(inst, {
      credentials: args.credentials,
      timeoutMs: this.opts.initTimeoutMs,
    })

    // 2. 读 /health 拿 SyncStatus(可能因为内部 race 暂时没刷新到,允许小重试)
    const status = await fetchRestoreStatus(inst, {
      maxAttempts: this.opts.healthMaxAttempts,
      retryDelayMs: this.opts.healthRetryDelayMs,
    })

    if (status?.restored === 'failed') {
      throw new SandboxRestoreFailed('restoreFromCos failed', { note: status.note })
    }
    return status
  }

  async snapshot(inst: SandboxInstance): Promise<{ ms: number }> {
    return callWorkspaceSnapshot(inst, {
      timeoutMs: this.opts.snapshotTimeoutMs,
      retryBackoffMs: this.opts.retryBackoffMs,
    })
  }

  async getRestoreStatus(inst: SandboxInstance): Promise<Restored | null> {
    return getHealthRestoreStatus(inst)
  }
}
```

- [ ] **Step 4: 写 index.ts(facade)**

```typescript
// workspace-snapshot/index.ts
export { WorkspaceSnapshotEngine, type WorkspaceSnapshotEngineOptions } from './snapshot-engine.js'
export {
  WorkspaceSnapshotError,
  SandboxRestoreFailed,
  SandboxRestoreTimeout,
  SandboxUnavailableError,
} from './errors.js'
export type { SyncStatus, Restored } from './types.js'
```

- [ ] **Step 5: 跑 → PASS**
- [ ] **Step 6: commit `feat(oak): add WorkspaceSnapshotEngine assembling init + health + snapshot clients`**

---

### Task 6: 公共 API 类型增量(`src/public/types.ts`、`src/sandbox/types.ts`、`src/internal/errors.ts`)

**Files:**
- Modify: `src/public/types.ts`
- Modify: `src/sandbox/types.ts`(注释升级)
- Modify: `src/internal/errors.ts`(若 ConfigError 不存在则补)

- [ ] **Step 1: 检查 ConfigError 是否存在**

Run: `grep -n "class ConfigError" src/internal/errors.ts`
Expected:
- 若已存在 → 跳到 Step 3
- 若不存在 → Step 2 补

- [ ] **Step 2(可选): 在 errors.ts 加 ConfigError**

```typescript
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}
```

- [ ] **Step 3: 改 src/sandbox/types.ts(L42 backend 注释升级)**

把:
```typescript
  /** 后端标识（用于诊断日志，不参与逻辑） */
  readonly backend: string
```
改成:
```typescript
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
```

- [ ] **Step 4: 改 src/public/types.ts(SandboxConfig + Session)**

在 SandboxConfig interface 末尾加 3 字段:
```typescript
  /** Spec B 新增。控制 cwd 是否在 send 边界自动快照到 COS。
   *  - 'auto'(默认):runtime.backend === 'ags-stateful' 时启用,其他 runtime 关闭
   *  - 'enabled':强制启用 — 若 runtime 不支持则 startSession 抛 ConfigError
   *  - 'disabled':显式关闭
   *  @default 'auto'
   *  @注意 启用时要求 sandbox.scope === 'shared'(详 Spec B §1.3)
   */
  workspaceSnapshot?: 'auto' | 'enabled' | 'disabled'

  /** snapshot HTTP timeout(ms)。默认 30_000。必须 < 600_000(镜像内部限制)*/
  workspaceSnapshotTimeoutMs?: number

  /** init(含 restore)HTTP timeout(ms)。默认 60_000。必须 < 1_200_000 */
  workspaceInitTimeoutMs?: number
```

在 Session interface 加 2 个 optional 方法:
```typescript
  /** Spec B 新增。手动触发一次 workspace snapshot;workspaceSnapshot 未启用时返回 { skipped: true } */
  snapshotWorkspace?(): Promise<{ ms: number; skipped?: boolean }>

  /** Spec B 新增。查询启动 restore 的状态。null = 未启用或仍在进行中 */
  getRestoreStatus?(): Promise<'full' | 'fresh' | 'partial' | 'failed' | null>
```

- [ ] **Step 5: 跑 type-check**

Run: `pnpm type-check`
Expected: 通过(只是类型增量,不影响现有实现)

- [ ] **Step 6: commit `feat(oak): public API types for workspace snapshot`**

---

### Task 7: agent-builder 接入 — `resolveSnapshotMode` + scope 校验

**Files:**
- Modify: `src/runtime/agent-builder.ts`
- Test: `src/runtime/__tests__/agent-builder.test.ts`(已存在,加新 describe)

- [ ] **Step 1: 写测试**

```typescript
// 在已有 agent-builder.test.ts 末尾加
describe('buildClaudeQueryOptions — workspaceSnapshot', () => {
  const goodRuntime = { backend: 'ags-stateful', acquire: vi.fn() }
  const otherRuntime = { backend: 'docker-local', acquire: vi.fn() }

  it('returns snapshotEngine when sandbox.runtime is ags-stateful and scope=shared', () => {
    const result = buildClaudeQueryOptions({
      sandbox: { runtime: goodRuntime, scope: 'shared', workspaceSnapshot: 'auto' },
      // ... 其他必要字段
    })
    expect(result.snapshotEngine).toBeDefined()
  })

  it('returns no snapshotEngine when workspaceSnapshot=disabled', () => {
    const result = buildClaudeQueryOptions({
      sandbox: { runtime: goodRuntime, scope: 'shared', workspaceSnapshot: 'disabled' },
    })
    expect(result.snapshotEngine).toBeUndefined()
  })

  it('returns no snapshotEngine when runtime backend != ags-stateful and mode=auto', () => {
    const result = buildClaudeQueryOptions({
      sandbox: { runtime: otherRuntime, scope: 'shared', workspaceSnapshot: 'auto' },
    })
    expect(result.snapshotEngine).toBeUndefined()
  })

  it('throws ConfigError when mode=enabled but runtime not supported', () => {
    expect(() =>
      buildClaudeQueryOptions({
        sandbox: { runtime: otherRuntime, scope: 'shared', workspaceSnapshot: 'enabled' },
      })
    ).toThrow(/does not support snapshot/)
  })

  it('throws ConfigError when snapshot enabled but scope=session', () => {
    expect(() =>
      buildClaudeQueryOptions({
        sandbox: { runtime: goodRuntime, scope: 'session', workspaceSnapshot: 'auto' },
      })
    ).toThrow(/scope='shared'/)
  })

  it('throws ConfigError when snapshot enabled but scope undefined (defaults to session)', () => {
    expect(() =>
      buildClaudeQueryOptions({
        sandbox: { runtime: goodRuntime, workspaceSnapshot: 'auto' },
      })
    ).toThrow(/scope='shared'/)
  })

  it('passes timeouts to engine constructor', () => {
    const result = buildClaudeQueryOptions({
      sandbox: {
        runtime: goodRuntime,
        scope: 'shared',
        workspaceSnapshot: 'enabled',
        workspaceSnapshotTimeoutMs: 5_000,
        workspaceInitTimeoutMs: 10_000,
      },
    })
    expect(result.snapshotEngine).toBeDefined()
    // 内部 opts 私有,不在公共测试断言;构造没抛即通过
  })
})
```

- [ ] **Step 2: 跑 → FAIL**

- [ ] **Step 3: 在 agent-builder.ts 加 resolveSnapshotMode + 在 buildClaudeQueryOptions 内调**

```typescript
import { WorkspaceSnapshotEngine } from '../sandbox/workspace-snapshot/index.js'
import { ConfigError } from '../internal/errors.js'

function resolveSnapshotMode(sandboxConfig: SandboxConfig | undefined): boolean {
  const mode = sandboxConfig?.workspaceSnapshot ?? 'auto'
  const scope = sandboxConfig?.scope ?? 'session'

  if (mode === 'disabled') return false
  const enabledByMode =
    mode === 'enabled' ||
    (mode === 'auto' && sandboxConfig?.runtime?.backend === 'ags-stateful')

  if (!enabledByMode) {
    if (mode === 'enabled') {
      throw new ConfigError(
        `workspaceSnapshot='enabled' but runtime.backend='${sandboxConfig?.runtime?.backend}' does not support snapshot`,
      )
    }
    return false
  }

  if (scope !== 'shared') {
    throw new ConfigError(
      `workspaceSnapshot 要求 sandbox.scope='shared'(同 envId 共享容器,跨 session 接续 cwd),` +
      `当前 scope='${scope}'。改为 createAgent({ sandbox: { scope: 'shared', ... } })。` +
      `详见 Spec B §1.3。`,
    )
  }
  return true
}

// 在 buildClaudeQueryOptions 末尾(返回前)
const enabled = resolveSnapshotMode(config.sandbox)
const snapshotEngine = enabled
  ? new WorkspaceSnapshotEngine({
      snapshotTimeoutMs: config.sandbox?.workspaceSnapshotTimeoutMs,
      initTimeoutMs: config.sandbox?.workspaceInitTimeoutMs,
    })
  : undefined

return { /* 既有 */, snapshotEngine }
```

- [ ] **Step 4: 跑 → PASS**
- [ ] **Step 5: commit `feat(oak): wire workspaceSnapshot in agent-builder with scope check`**

---

### Task 8: create-agent 触发点接入 — startSession bootstrap + send finally snapshot

**Files:**
- Modify: `src/public/create-agent.ts`

- [ ] **Step 1: 阅读 create-agent.ts 现状**

Run: `grep -nE "startSession|async function send|finally|sandboxRuntime\.acquire" src/public/create-agent.ts`
找到 startSession 闭包 + send 实现位置,记下行号。

- [ ] **Step 2: 在 startSession 中,acquire 之后调 bootstrap**

伪代码(具体改动按真实 create-agent.ts 结构调整):

```typescript
const inst = await sandboxRuntime.acquire(ctx)
if (snapshotEngine) {
  await snapshotEngine.bootstrap(inst, { credentials: derivedCreds })
}
const session = createSession(inst, snapshotEngine, ...)
return session
```

- [ ] **Step 3: 在 session.send 实现中,finally 块加 snapshot 调用 + warning event yield**

```typescript
async function* send(prompt) {
  try {
    yield* runAgentTurn(prompt)
  } finally {
    if (snapshotEngine && instAlive(inst)) {
      try {
        const { ms } = await snapshotEngine.snapshot(inst)
        // 不 yield,只记 metric;TODO 接入 metrics 后补 oak_workspace_snapshot_duration_ms
      } catch (err) {
        yield {
          type: 'warning',
          code: 'workspace_snapshot_failed',
          detail: (err as Error).message,
        }
      }
    }
  }
}
```

- [ ] **Step 4: 给 session 实例挂 `snapshotWorkspace` 和 `getRestoreStatus` 方法**

```typescript
session.snapshotWorkspace = async () => {
  if (!snapshotEngine) return { ms: 0, skipped: true }
  return snapshotEngine.snapshot(inst)
}
session.getRestoreStatus = async () => {
  if (!snapshotEngine) return null
  return snapshotEngine.getRestoreStatus(inst)
}
```

- [ ] **Step 5: 跑 type-check + 全套单测**

Run: `pnpm type-check && pnpm test -- --run`
Expected: 全绿(已有测试不应回归)

- [ ] **Step 6: commit `feat(oak): wire workspace snapshot bootstrap and send-end hooks`**

---

### Task 9: example 18(单进程演示)

**Files:**
- Create: `examples/18-workspace-snapshot.ts`
- 参考体例:`examples/16-user-memory.ts`

- [ ] **Step 1: 写 example**

```typescript
/**
 * Example 18: workspace snapshot(单进程演示)
 *
 * 验证目标:让 model 在 sandbox cwd 写文件,session.send 结束自动 snapshot 到 COS;
 *          重新 startSession 时自动 restore,model 能读到上次写的内容。
 *
 * 运行前提:
 *   - .env.local 配置 TCB_ENV_ID + TCB_SECRET_ID + TCB_SECRET_KEY
 *     + AGS sandbox tool 已 ensure(由 server 路径 / 手动 init)
 *
 * Run:
 *   OAK_DEBUG=1 pnpm dlx tsx packages/open-agent-kernel/examples/18-workspace-snapshot.ts
 */

import { createAgent } from '@cloudbase/open-agent-kernel'
import { AgsStatefulSandbox } from '@cloudbase/open-agent-kernel/sandbox'
import { loadEnv } from './_shared/env.js'

async function runOne(userId: string, prompt: string) {
  const agent = createAgent({
    envId: process.env.TCB_ENV_ID!,
    model: process.env.OAK_EXAMPLE_MODEL_ID ?? 'claude-opus-4-8',
    sandbox: {
      runtime: new AgsStatefulSandbox(),
      scope: 'shared',          // ← workspaceSnapshot 要求
      // workspaceSnapshot 默认 'auto',ags-stateful 自动启用
    },
  })
  const session = await agent.startSession({ userId })
  console.log(`\n[user=${userId}] restoreStatus=${await session.getRestoreStatus?.()}`)
  console.log(`[user=${userId}] sending: ${prompt}`)
  for await (const event of session.send(prompt)) {
    if (event.type === 'message_delta') process.stdout.write(event.text)
    if (event.type === 'warning') console.warn(`\n[warning] ${event.code}: ${event.detail}`)
  }
  console.log(`\n[user=${userId}] aborting (final snapshot 已在 send finally 完成)...`)
  await session.abort()
}

async function main() {
  loadEnv()
  const userId = `ws-demo-${Date.now()}`

  // 第一轮:写文件
  await runOne(userId, '请在工作区根目录创建一个 hello.txt,内容是 "OAK Spec B works!"')

  // 等几秒,让镜像内 periodic sync 也跑一下(不必要,但更稳)
  await new Promise((r) => setTimeout(r, 3_000))

  // 第二轮:同 userId 拉取上次 workspace,读文件
  await runOne(userId, 'cat hello.txt 看看里面有什么')

  // 第二轮模型应该能输出 "OAK Spec B works!"
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 2: 不要在本地跑(没有 AGS 环境)— 确认 type-check 通过即可**

Run: `pnpm type-check`
Expected: 通过

- [ ] **Step 3: commit `docs(oak): example 18 — workspace snapshot single-process`**

---

### Task 10: example 19(跨节点演示)

**Files:**
- Create: `examples/19-workspace-snapshot-distributed.ts`

- [ ] **Step 1: 写 example**

照 17-user-memory-distributed.ts 体例:Node A 写 → abort → 等几秒 → Node B 全新 createAgent → 读到 Node A 的产物。

- [ ] **Step 2: type-check**
- [ ] **Step 3: commit `docs(oak): example 19 — workspace snapshot cross-node`**

---

### Task 11: 最终回归 + README

**Files:**
- Modify: `packages/open-agent-kernel/README.md`(加 workspaceSnapshot 用法小节)
- Run: 全套测试 + type-check

- [ ] **Step 1: 跑全套测试**

Run: `pnpm test -- --run && pnpm type-check`
Expected: 87 + N 测试全绿(N 取决于本计划新增测试数,大约 +25-30)

- [ ] **Step 2: 在 README userManual 章节加用法示例**

```markdown
### Workspace Snapshot(Spec B)

启用 sandbox cwd 自动持久化(适用 AGS stateful sandbox):

\`\`\`typescript
const agent = createAgent({
  sandbox: {
    runtime: new AgsStatefulSandbox(),
    scope: 'shared',         // 必须为 'shared',否则 startSession 抛 ConfigError
    // workspaceSnapshot 默认 'auto',ags-stateful 自动启用
  },
})
\`\`\`

**关键约束**:`scope: 'shared'`(每 envId 单实例,跨 session 接续工作目录)。  
**触发**:每次 \`session.send()\` 结束自动 snapshot;失败 yield warning event(不抹掉 final answer)。  
**配置**:\`workspaceSnapshotTimeoutMs\`(默认 30s)/ \`workspaceInitTimeoutMs\`(默认 60s)。
```

- [ ] **Step 3: commit `docs(oak): README workspaceSnapshot section + final regression`**

---

## 跨 task 验证

每个 task 走 `superpowers:subagent-driven-development`,fresh subagent + 两阶段 review(spec compliance → code quality)。**禁止**:跨 task 一次提交大改。

## Self-review checklist

- [ ] 每个 task 都先写测试,然后实现,最后 commit
- [ ] 没有跨 task 的"将来可能会用到"代码
- [ ] zod schema 跟 tcb-remote-workspace v0.4.0 源码字段对得上(Task 0 — `SyncStatus` / `HealthResponse` / `WorkspaceInitResponse` 三个 schema)
- [ ] **init-client 不假设 init body 含 restoreStatus**(Task 2 — 真实 body 只有 workspace+git+env;restore 状态由 health-client 在 bootstrap 阶段单独读)
- [ ] **bootstrap 序列为 init → fetchRestoreStatus 两步**(Task 5 — engine 把这俩组装,失败语义清晰)
- [ ] retryable 错误码白名单只含 `'workspace_snapshot_failed'`(Task 0 RETRYABLE_ERROR_CODES)
- [ ] scope 校验在 agent-builder 单测覆盖(Task 7)
- [ ] AgsStatefulSandbox 类零改动(只 types.ts 注释升级)
- [ ] examples 18/19 用 `scope: 'shared'`,跟 spec §1.3 一致
- [ ] 全套测试 + type-check 全绿(Task 11)
