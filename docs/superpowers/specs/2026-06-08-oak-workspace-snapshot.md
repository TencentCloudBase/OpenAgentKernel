# OAK Spec B — Sandbox Workspace Snapshot

> **状态**:DRAFT v1.3(简化字段冗余)
> **日期**:2026-06-08
> **作者**:Luke + Claude(brainstorming → 调研 → 决策点对齐 → reviewer 自审 → v1.1 → scope 讨论 → v1.2 → 字段简化 → v1.3)
> **关联前置**:Spec A(`2026-06-01-oak-cwd-skills-user-memory-design.md` v3.2 — `~/.claude/` COS 同步)
> **关联后续**:无 — Spec B 是"非 AGS runtime 的 workspace 持久化"的 prerequisite,但本 spec 不实现该路径(留 Spec C)
>
> **v1.3 vs v1.2 主要修订**(字段冗余讨论后):
> 1. **删除新引入的 `SandboxRuntime.kind` 字段** — 直接复用既有的 `backend` 字段(语义一样,值一样,平白引入 `kind` 是冗余)
> 2. `types.ts:42` 的 `backend` 字段注释从"诊断日志用,不参与逻辑"改为"runtime 类型标识,供业务逻辑判定"— 正式承认它是判定字段
> 3. 保持 `'ags-stateful'` 字符串不变(为将来 `'ags-stateless'` / `'docker-local'` 等多 provider 多状态留位)
>
> **v1.2 vs v1.1 主要修订**(scope 约束讨论后):
> 1. **`workspaceSnapshot` 启用要求 `sandbox.scope === 'shared'`** — session scope 下每 session 一容器,跨 session 接续语义不成立;在 session scope 下启 snapshot 会让多个独立容器在同一 COS 命名空间互相覆盖
> 2. 删除 §3.4 / §4 D3 / §6 的"SDK in-flight 去重"复杂度 — shared scope 下同实例的 send 顺序进行,无并发问题;跨进程并发由镜像 mutex 一次拦截即可
> 3. §8 R2 简化为"业务方应保证同 envId 串行"(对齐 Spec A 模式)
> 4. §9 自审 checklist 加 scope 兼容性约束
>
> **v1.1 vs v1 主要修订**(基于 reviewer 反馈与源码交叉验证):
> 1. restore 流程修正 — 不是镜像 startup 自动,而是 `POST /api/workspace/init` 阻塞触发(init 200 = restore 完成)
> 2. `SyncStatus` 真实结构修正(对象,含 `'partial'` 第五种状态)
> 3. snapshot 返回外层 `{ success, result: { ms } }` wrapper
> 4. SandboxRuntime 加 `kind` 字段以支持 `'auto'` 模式(v1.3 删除,改用 `backend`)
> 5. 失败哲学跟 Spec A 的差异在 §1.3 显式说明
> 6. 配置默认值给出依据
> 7. 跨 spec metrics 命名统一

---

## 0. tl;dr

- OAK SDK 在 `AgsStatefulSandbox` runtime 上**新增"工作区快照"能力**,使 cwd 跨 session、跨节点持久化到 CloudBase COS。
- **不重新发明轮子** — 委托给 `tcb-remote-workspace` 沙箱业务镜像已有的 HTTP 接口;镜像内部跑 zstd tar + COS FUSE,OAK 只负责**触发与等待**。
- **触发模型**:`session.startSession()` 时调 `POST /api/workspace/init`(阻塞,内部完成 COS restore);每次 `session.send()` 结束后调 `POST /api/workspace/snapshot`(阻塞,timeout 30s,失败 throw)。
- **公共 API 变更极小**:`SandboxConfig.workspaceSnapshot: 'auto' | 'enabled' | 'disabled'`(默认 `auto`)+ `Session.snapshotWorkspace()` / `Session.getRestoreStatus()` 两个可选方法。`SandboxRuntime.backend` 字段语义升级(原本"诊断日志用",现作 `'auto'` 模式判定)。

---

## 1. 范围与边界

### 1.1 解决什么

业务方在云端跑 OAK SDK,model 通过 Bash/Edit tool 在 sandbox 里写代码、生成产物。**当 session 结束、进程退出或换节点重启时,这些工作要还在**。Spec B 让以下场景成为现实:

1. **同 user 连续接续**:同一 envId/userId 的下一次 session 自动加载上次的工作目录
2. **跨节点恢复**:Node A 上写的代码,Node B 重启后能拉到
3. **失败可见**:snapshot 写不进 COS 时,业务方能感知(不是 silent drop)

### 1.2 不做什么

| 不做 | 为什么 / 什么时候做 |
|---|---|
| 非 AGS sandbox runtime 的 workspace 持久化 | 留 Spec C(裸 cwd / 本地 docker / firecracker)|
| 业务方自定义 workspace 路径 | tcb-remote-workspace 镜像约定 `/home/user`,OAK 不跨这个边界 |
| 文件级 COS 同步(按 hash 推送) | 镜像已用 zstd tar + FUSE,OAK 不重复 |
| 镜像 restore 流程的内部细节 | OAK 只调 `POST /api/workspace/init`,init 返回即 restore 完成。**OAK 不轮询、不重试 restore**(失败由 init 返回 5xx 透传) |
| `~/.claude/` 同步 | 那是 Spec A 的范围(已实施)|
| Sandbox runtime 的 mutex / 队列 | 委托给镜像内的 `syncing` 互斥锁;OAK 仅在 retryable 错误下 backoff 重试 1 次 |
| Workspace 在 OAK SDK 进程里 mount/读写 | OAK 只发 HTTP,数据不经 OAK 进程 |
| 多版本 / 时间点 checkpoint 暴露 | 镜像保留 `COS_SNAPSHOT_KEEP=3`,但 OAK 不暴露选择 API,留 Spec D |
| **session scope 下的 workspace 持久化** | session scope 每 session 一容器,跨 session 接续语义不成立;详 §1.4 |

### 1.3 关键约束:`workspaceSnapshot` 要求 `sandbox.scope === 'shared'`

**问题**:OAK 的 `SandboxAcquireContext.scope`(`src/sandbox/types.ts:62-64`)有两种值:
- `'session'`(默认):每个 session 一个独立 sandbox 实例
- `'shared'`:同 envId 多 session 共享一个实例(stateful-infra 的"workspace 持久化"模式)

在 `'session'` scope 下启用 workspace snapshot 会**导致 silent data loss**:
- session A → instance I_A → init → 从 COS restore `/home/user`
- session B(并发或后续)→ instance I_B(全新容器)→ init → **从 COS restore 同一份**
- I_A 在自己的 `/home/user` 写了文件 X,snapshot 推到 COS
- I_B 在它的 `/home/user` 写了文件 Y(没有 X 因为 restore 在 I_A snapshot 前发生),snapshot 推到 COS — **覆盖掉 X**

**解法**:`workspaceSnapshot` 启用时强制要求 `sandbox.scope === 'shared'`。否则 startSession 抛 `ConfigError`(早 fail 优于运行时 silent broken)。

```ts
// agent-builder.ts
function resolveSnapshotMode(config: SandboxConfig | undefined): boolean {
  const mode = config?.workspaceSnapshot ?? 'auto'
  const scope = config?.scope ?? 'session'

  const enabledByMode = mode === 'enabled' || (mode === 'auto' && config?.runtime?.backend === 'ags-stateful')
  if (!enabledByMode) return false

  if (scope !== 'shared') {
    throw new ConfigError(
      `workspaceSnapshot 要求 sandbox.scope='shared'(同 envId 共享容器,跨 session 接续 cwd),` +
      `当前 scope='${scope}'。改为 createAgent({ sandbox: { scope: 'shared', ... } })。`,
    )
  }
  return true
}
```

**与 stateful-infra 的对齐**:stateful-infra 也是把"workspace 持久化"绑死在 shared mode 上 — `stateful-provider.ts:280-310 ensureTaskInstance()` (isolated mode) 在 `deleteConversation` 时直接 `destroy()`,根本没有跨 task 接续概念。OAK Spec B 沿用同一语义边界。

### 1.4 与 Spec A 的关系

| 关注点 | Spec A | Spec B |
|---|---|---|
| 目录 | `<CLAUDE_CONFIG_DIR>/.claude/`(用户级偏好)| `/home/user`(workspace cwd)|
| 数据来源 | OAK 进程本地文件 | sandbox 容器内文件 |
| 同步执行者 | OAK SDK 进程(直接调 `@cloudbase/manager-node`) | 沙箱镜像(OAK 只发 HTTP)|
| COS 上的形态 | 平铺文件,可直接 browse | zstd tar 块 + FUSE 内部结构 |
| 触发 | `session.send()` start/end | `startSession()` 调 init / `send()` end 调 snapshot |
| 失败语义 | `Promise.allSettled`(部分失败容忍,记 warn 继续)| 整体成败,失败 throw |

**关于失败哲学的差异**(reviewer 关切):
- Spec A `userMemory` 失败属"**偏好补强**"路径 — agent 没读到 CLAUDE.md 仍能工作,丢失只是体验降级,所以容忍部分失败合理
- Spec B `workspaceSnapshot` 失败属"**用户产物持久化**"路径 — cwd 是用户 session 期间的全部产出,不容许 silent drop;失败必须让业务方有机会处理(重试 / 警告用户 / 回滚)

实践上:**snapshot 失败不中断当前已完成的 send 响应**(用户已经看到回答),但下一次 send 会因状态不一致而拒绝(详 §5)。

**两套机制同时启用**没有冲突 — 完全不同的目录、不同的 COS 命名空间。

---

## 2. 上下文:已有事实

### 2.1 OAK 现状速查

OAK 当前 `src/sandbox/`(`feat/support-open-agent-kernel` HEAD):

- `types.ts:28` — `SandboxInstance.request(path, init): Promise<Response>` **已存在**
- `ags-stateful-sandbox.ts:647-654` — `AgsStatefulSandbox.acquire()` 返回的实例已经把 `request` 实现填好(`fetch(baseUrl + path, headers)`)
- `cloudbase-mcp.ts:274` — 已经在用 `inst.request('/api/workspace/env', ...)` 调镜像
- **OAK 当前 acquire flow 不调 `/api/workspace/init`** — 这是 Spec B 必须新增的关键步骤(否则 restore 不会触发)
- **零持久化** — 当前 sandbox 模块完全不做 cwd snapshot/restore

### 2.2 沙箱业务镜像的 HTTP 契约(`tcb-remote-workspace` v0.4.0)

经过对 `cos-sync.ts`(1436 行)、`workspace.ts:108`(`ensureWorkspace`)、`routes/api.ts`(workspace 路由)的逐行 review,对外契约固化如下:

| Endpoint | Method | OAK 是否调用 | 行为摘要 |
|---|---|---|---|
| `/health` | GET | **否(普通流程)** / 是(诊断 / `getRestoreStatus()`) | 含 `restoreStatus: SyncStatus \| null`(对象,详见下文)|
| `/api/workspace/init` | POST | **是,acquire 时阻塞调用** | 幂等;**内部同步执行 `restoreFromCos()` → restore 全程阻塞在这里** |
| `/api/workspace/env` | PUT | 是(已有逻辑,本 spec 不改)| 注入 CloudBase 凭证 |
| `/api/workspace/snapshot` | POST | **是,send_end 时调用** | 同步阻塞,内部跑 tar + zstd + FUSE flush + verify |
| `/api/workspace/restore` | POST | **否** | 镜像不接受 HTTP 触发 restore;必须由控制面创建新实例 |

#### 2.2.1 关键事实:restore 是 `POST /api/workspace/init` 的同步副作用

**这是 v1 → v1.1 最重要的修正**。reviewer 与源码挖掘揭示:

```
ensureWorkspace()  (workspace.ts:108)
  ├─ canTryCosRestore = !hasRestoreStatus   ← 已 restore 过则 skip
  ├─ if canTryCosRestore:
  │    restored = await restoreFromCos(workspace)   ← 同步阻塞,可能耗时秒到分钟
  │    wsSteps.restoreFromCosMs = ...               ← 计时
  ├─ writeRestoreInStatus(workspace, { restored: 'full'|'fresh'|'partial'|'failed', ... })
  └─ return workspace
```

也就是:**`POST /api/workspace/init` 200 OK 返回 = restore 已完成**(成功或失败,状态写入了 `RESTORE_IN_STATUS_FILE`)。OAK 不需要轮询 `/health` 等 restore 状态;init 返回时一切已知。

唯一需要轮询 `/health` 的场景是:**业务方主动调 `Session.getRestoreStatus()`**(详 §3.2),那时直接读 `/health` 解析 `restoreStatus` 字段即可。

#### 2.2.2 `SyncStatus` 类型(直接复制自源码)

源:`tcb-remote-workspace/src/cos-sync.ts:135-144`

```ts
export interface SyncStatus {
  restored: 'full' | 'partial' | 'fresh' | 'failed'
  restoredAt: string             // ISO timestamp
  restoreMs?: number             // restore 耗时
  source: 'cos' | 'git' | 'none' // 数据源
  cosMetaSizeBytes?: number
  cosMetaFileCount?: number
  steps?: Record<string, number>
  note?: string
}
```

| `restored` 值 | 含义 | OAK 行为 |
|---|---|---|
| `'full'` | 从 COS 完整恢复 | session 可用 |
| `'fresh'` | 没有历史快照,workspace 是空的全新初始化 | session 可用 |
| `'partial'` | 部分恢复(COS 数据残缺)| session 可用,但 OAK 应在 metrics 上报 + log warn |
| `'failed'` | restore 失败 | session 不可用,init HTTP 应已经返回非 2xx;OAK throw `SandboxRestoreFailed` |

#### 2.2.3 snapshot 路由真实返回(reviewer ISSUE-2)

源:`tcb-remote-workspace/src/routes/api.ts:410-426`

成功:
```json
{ "success": true, "result": { "ms": 1234 } }
```

失败:
```json
{
  "errorCode": "workspace_snapshot_failed",
  "title": "Workspace Snapshot Failed",
  "detail": "<error message>",
  "retryable": true,
  "retryAfter": 2
}
```
HTTP status 500 + `Content-Type: application/problem+json`(详 `problemJson` 工具)。

OAK 解析时**必须**:
1. 检查 HTTP status(2xx vs 4xx/5xx 不同分支)
2. 成功路径:解外层 `success/result` wrapper
3. 失败路径:`retryable: true` 才重试

#### 2.2.4 关键性质

- **同步阻塞** — snapshot/init 都是 HTTP 请求等到 work 完成才 200 返回
- **互斥** — 镜像内 `syncState.syncing` 锁,详 `cos-sync.ts:1243-1264`;同时只能跑一个 snapshot,后到的返回 500 + `retryable: true`
- **依赖 restore 完成** — snapshot 调用时若 `restoreStatus !== 'full'/'fresh'/'partial'`(即 `'failed'` 或仍 null)会被 `canSyncOut()` 拒绝(`cos-sync.ts:183-190`)
- **internal timeout** — snapshot = 600s(`COS_SYNC_TIMEOUT_MS`)、init/restore = 1200s(`COS_RESTORE_TIMEOUT_MS`)— OAK HTTP timeout 须显著小于这些,以便提前给业务方失败信号

---

## 3. 设计

### 3.1 高层架构

```
业务方进程
  ┌───────────────────────────────────────────────────┐
  │ const agent = createAgent({                       │
  │   sandbox: { runtime: new AgsStatefulSandbox() }  │
  │   // workspaceSnapshot: 'auto'(默认)             │
  │ })                                                │
  │ const session = await agent.startSession()        │
  └────────────────────────┬──────────────────────────┘
                           │
                           ▼
  ┌────────── OAK SDK ─────────────────────────────────┐
  │                                                    │
  │  ── agent.startSession() ──                        │
  │    AgsStatefulSandbox.acquire()                    │
  │       └── 返回 SandboxInstance(健康检查 OK)       │
  │    if shouldEnableSnapshot(runtime, config):       │
  │      WorkspaceSnapshotEngine.bootstrap(inst)       │
  │       └── PUT /api/workspace/env(已有)            │
  │       └── POST /api/workspace/init                 │
  │           ⚠ 同步阻塞 ≤ 60s                         │
  │           ⚠ 内部触发 restoreFromCos(),返回时       │
  │             restore 已完成或失败                   │
  │           ⚠ 5xx → throw SandboxRestoreFailed      │
  │                                                    │
  │  ── session.send(prompt) ──                        │
  │    [model 调 Bash/Edit 改 cwd 内文件]              │
  │    finally:  // 用户已收到完整 response 后          │
  │      WorkspaceSnapshotEngine.snapshot(inst)        │
  │       └── POST /api/workspace/snapshot             │
  │           timeout 30s                              │
  │           成功 → 解析 { success, result: { ms } }  │
  │           500+retryable=true → backoff 1 次        │
  │           最终失败 → throw WorkspaceSnapshotError  │
  │             (但用户已经看到 response,session       │
  │              将处于"已生成但未持久化"状态)          │
  │                                                    │
  │  ── session.snapshotWorkspace() ──(可选,业务方手动)│
  │      WorkspaceSnapshotEngine.snapshot(inst)        │
  │                                                    │
  │  ── session.getRestoreStatus() ──                  │
  │      解析 GET /health → restoreStatus.restored     │
  │                                                    │
  └────────────────────┬───────────────────────────────┘
                       │ HTTP(over AGS gateway)
                       ▼
  ┌─── 沙箱业务镜像(tcb-remote-workspace,跑在 AGS 容器内)──┐
  │                                                         │
  │  POST /api/workspace/init                               │
  │    └── ensureWorkspace()                                │
  │        └── restoreFromCos() ──同步阻塞──►              │
  │            tar+zstd 解 /mnt/cos/.snapshot-*.tar.zst    │
  │                                                         │
  │  POST /api/workspace/snapshot                           │
  │    └── snapshotNow() ──同步阻塞──►                     │
  │        sudo tar -cf - /home/user | zstd > /mnt/cos/    │
  │                                                         │
  │  GET /health                                            │
  │    └── restoreStatus: SyncStatus | null                 │
  │                                                         │
  │  + 后台保险机制(OAK 不参与):                          │
  │    - debounced 2s(外部 file write 触发)              │
  │    - periodic 60s                                       │
  │    - shutdown(SIGTERM)                                 │
  │                                                         │
  └─────────────────────────────────────────────────────────┘
```

### 3.2 公共 API 改动

#### `SandboxRuntime`(`src/sandbox/types.ts`)— 升级 `backend` 字段语义

`SandboxRuntime.backend` 字段已存在(类型 `string`),v1.3 起将其语义从"诊断日志用,不参与逻辑"升级为"runtime 类型标识,供业务逻辑(包括 `workspaceSnapshot: 'auto'` 模式)判定"。**不引入新字段**。

```ts
export interface SandboxRuntime {
  /**
   * Runtime 类型标识。诊断日志 + 业务逻辑判定(如 `workspaceSnapshot: 'auto'`)。
   *
   * 当前可识别值:
   * - 'ags-stateful'  → AGS 沙箱 stateful 模式(支持 /api/workspace/snapshot)
   * - 其他            → 'auto' 不启用快照
   *
   * 未来扩展:'ags-stateless' / 'docker-local' / 'firecracker' / 'e2b' 等。
   */
  readonly backend: string

  acquire(ctx: SandboxAcquireContext): Promise<SandboxInstance>
}
```

`AgsStatefulSandbox` 实现(`src/sandbox/ags-stateful-sandbox.ts:595`)**零改动**:

```ts
export class AgsStatefulSandbox implements SandboxRuntime {
  readonly backend = 'ags-stateful'   // ← 既有,不变
  // ...
}
```

#### `SandboxConfig`(`src/public/types.ts`)

```ts
export interface SandboxConfig {
  /** 既有字段保留 */
  runtime: SandboxRuntime
  scope?: 'session' | 'shared'
  // ... 其他

  /**
   * Spec B 新增。控制 cwd 是否在 send 边界自动快照到 COS。
   *
   * - 'auto'(默认):runtime.backend === 'ags-stateful' 时启用,其他 runtime 关闭
   * - 'enabled':强制启用 — 若 runtime 不支持(无 /api/workspace/snapshot)则
   *               在 startSession 阶段抛 ConfigError(早 fail 优于运行时错)
   * - 'disabled':显式关闭(本地调试 / 不需要持久化的场景)
   *
   * @default 'auto'
   */
  workspaceSnapshot?: 'auto' | 'enabled' | 'disabled'

  /**
   * Spec B 新增。snapshot HTTP 调用超时(毫秒)。
   * 必须 < 600_000(镜像内 `COS_SYNC_TIMEOUT_MS`)。
   *
   * 默认 30_000 的依据:正常 workspace ≤ 50MB 时 snapshot 实测 ≤5s;
   * 网络往返 + AGS gateway 开销 ≤10s;余量 15s → 30s。
   * 业务方若有大型 workspace(GB 级)应显式上调。
   *
   * @default 30_000
   */
  workspaceSnapshotTimeoutMs?: number

  /**
   * Spec B 新增。startSession 调用 init(包含 restore)的 HTTP 超时(毫秒)。
   * 必须 < 1_200_000(镜像内 `COS_RESTORE_TIMEOUT_MS`)。
   *
   * 默认 60_000 的依据:正常 restore ≤10s,大 workspace 可能 ≤30s;
   * 余量给到 60s。超出意味着 restore 异常,应 fail-fast。
   *
   * @default 60_000
   */
  workspaceInitTimeoutMs?: number
}
```

#### `Session`(`src/public/types.ts`)

```ts
export interface Session {
  /** 既有方法保留 */
  send(prompt: string | Multimodal): AsyncIterable<Event>
  abort(): Promise<void>
  // ...

  /**
   * Spec B 新增。手动触发一次 workspace snapshot(rare path)。
   *
   * - 调用即同步等待 snapshot 完成或超时
   * - 仅在 `workspaceSnapshot` 启用时有意义;否则返回 `{ skipped: true }`
   * - 业务方常见场景:在用户"主动保存"按钮上挂这个,而非依赖 send 边界
   */
  snapshotWorkspace?(): Promise<{ ms: number; skipped?: boolean }>

  /**
   * Spec B 新增。查询启动 restore 的状态。
   *
   * - 'full':从已有 snapshot 完整恢复
   * - 'fresh':没有历史 snapshot,workspace 是空的全新初始化
   * - 'partial':部分恢复(COS 数据残缺,session 仍可用但应警告)
   * - 'failed':恢复失败,session 不能用(实际上 startSession 已 throw,这里不应见到)
   * - null:还在恢复中(正常情况下 startSession 已等到完成,此值仅在 race 时短暂出现)
   *
   * 业务方典型用法:UI 上提示"workspace 部分恢复"或在 session 元信息里展示 source。
   * 实现:GET /health → 解析 body.restoreStatus.restored 字段。
   */
  getRestoreStatus?(): Promise<'full' | 'fresh' | 'partial' | 'failed' | null>
}
```

### 3.3 内部模块布局

```
src/sandbox/workspace-snapshot/
  ├── index.ts                 — 公共出口(只导出类型 + Engine 类)
  ├── snapshot-engine.ts       — 主类 WorkspaceSnapshotEngine
  ├── snapshot-client.ts       — 调 POST /api/workspace/snapshot 的客户端 + retry
  ├── init-client.ts           — 调 POST /api/workspace/init 的客户端(bootstrap 时用)
  ├── health-client.ts         — 调 GET /health 解析 restoreStatus
  ├── types.ts                 — SyncStatus / HealthResponse 的 zod schema(对应镜像源码 v0.4.0)
  ├── errors.ts                — WorkspaceSnapshotError / SandboxRestoreFailed / SandboxRestoreTimeout
  └── __tests__/
      ├── snapshot-client.test.ts
      ├── init-client.test.ts
      ├── health-client.test.ts
      └── snapshot-engine.test.ts
```

#### `WorkspaceSnapshotEngine`

```ts
export interface WorkspaceSnapshotEngineOptions {
  snapshotTimeoutMs?: number       // default 30_000
  initTimeoutMs?: number           // default 60_000
  retryMax?: number                // default 1(单次任务总尝试 = 2)
  retryBackoffMs?: number          // default 1_000(retryable 错误下单次回退)
}

export class WorkspaceSnapshotEngine {
  constructor(options?: WorkspaceSnapshotEngineOptions)

  /**
   * startSession 调用一次。包含两步:
   * 1. PUT /api/workspace/env(注入凭证;沿用现有逻辑)
   * 2. POST /api/workspace/init(同步阻塞,内部触发 restoreFromCos)
   * init 返回的 SyncStatus.restored === 'failed' → throw SandboxRestoreFailed
   * init timeout → throw SandboxRestoreTimeout
   *
   * shared scope 下,同实例第二次调用 init 是 fast no-op(镜像内 workspaceReady 标志)。
   */
  bootstrap(inst: SandboxInstance, opts: { credentials: ... }): Promise<SyncStatus>

  /** send finally 调用。retryable 错误 backoff 重试一次,最终失败 throw */
  snapshot(inst: SandboxInstance): Promise<{ ms: number }>

  /** 仅查 /health 状态,不阻塞、不触发 */
  getRestoreStatus(inst: SandboxInstance): Promise<SyncStatus['restored'] | null>
}
```

> **设计简化(v1.2)**:Engine 内部**不维护 in-flight Promise 去重**。
> shared scope 下同 envId 同 OAK 进程内,session 之间共用同一个 `SandboxInstance`,而每个 session 内部 `send()` 是 await 串行的 — 不会出现"同一 inst 上多个并发 snapshot"。跨进程并发由镜像内 mutex(`cos-sync.ts:1243-1264`)拦截。

### 3.4 触发点接入

修改文件:
- `src/runtime/agent-builder.ts` — 在 `createAgent` 中:
  1. 根据 `workspaceSnapshot` 配置和 `runtime.backend` 决定是否启用快照
  2. 启用时校验 `sandbox.scope === 'shared'`(否则 `ConfigError`,详 §1.3)
  3. 启用时构造 `WorkspaceSnapshotEngine`
- `src/public/create-agent.ts` — 在 `agent.startSession()` 中插入 `engine.bootstrap()`,在 `session.send()` 的 `finally`(或 send_end hook)插入 `engine.snapshot()`

伪代码:

```ts
// agent-builder.ts: 启用模式 + scope 约束
function resolveSnapshotMode(config: SandboxConfig | undefined): boolean {
  const mode = config?.workspaceSnapshot ?? 'auto'
  const scope = config?.scope ?? 'session'

  // 1. 是否按 mode + runtime.backend 启用?
  if (mode === 'disabled') return false
  const enabledByMode = mode === 'enabled' || (mode === 'auto' && config?.runtime?.backend === 'ags-stateful')
  if (!enabledByMode) {
    if (mode === 'enabled') {
      throw new ConfigError(
        `workspaceSnapshot='enabled' but runtime.backend='${config?.runtime?.backend}' does not support snapshot`,
      )
    }
    return false
  }

  // 2. scope 约束
  if (scope !== 'shared') {
    throw new ConfigError(
      `workspaceSnapshot 要求 sandbox.scope='shared',当前 scope='${scope}'。` +
      `详见 spec §1.3 — session scope 下多容器在同一 COS 命名空间会互相覆盖。`,
    )
  }
  return true
}

// agent.startSession()
const inst = await sandboxRuntime.acquire(ctx)
if (snapshotEngine) {
  await snapshotEngine.bootstrap(inst, { credentials })   // throw on failed/timeout
}
return new Session(inst, snapshotEngine, ...)

// session.send 内层
async function* send(prompt) {
  try {
    yield* runAgentTurn(prompt)
  } finally {
    if (snapshotEngine) {
      try {
        const { ms } = await snapshotEngine.snapshot(inst)
        // metrics 记录,不 yield(用户已经看到 final answer)
      } catch (err) {
        // 不中断当前 send 的 final response,但记录错误。
        // 业务方可在下次 send 前查 session.lastSnapshotError(可选 V1.5)
        yield { type: 'warning', code: 'workspace_snapshot_failed', detail: err.message }
      }
    }
  }
}
```

**关键决策**:snapshot 失败**不抛出**到当前 send 的 final 用户(已经看到响应);改为 yield 一个 `warning` event 让业务方知道。下一次 send 调用时,业务方可决定是否让 user 重试 / abort。这避免了"对话已完成但 snapshot 一失败就把 final answer 抹掉"的糟糕体验(详 §4 D2)。

---

## 4. 关键决策与取舍

### D1:`workspaceSnapshot` 默认 = `'auto'`

**选**:`AgsStatefulSandbox` runtime 自动开启,其他 runtime(未来 Spec C 加入的本地 docker / firecracker)默认关。

**为什么不是 enabled**:enabled 意味着任何 runtime 都期待 `/api/workspace/snapshot` HTTP 存在,本地 docker runtime 没这接口会 startup throw,体验差。

**为什么不是 disabled**:CloudBase 平台上跑 OAK 是第一优先级,默认就该有快照能力(业务方零配置)。

### D2:send 边界的 snapshot 阻塞 ≤ 30s,失败降级为 warning event

**选**:每次 `session.send()` 在 `finally` 调 snapshot HTTP,timeout 30s。失败时**不中断当前已生成的 response**,而是 yield 一个 `warning` event。

**为什么不是 throw**(v1.0 → v1.1 修订):
- 当前 send 的 final answer 已经返回,throw 会让用户看到完整答案被一个"保存失败"错误覆盖,体验糟糕
- 业务方仍然能感知失败 — `warning` event 在 stream 里可观测,且下一轮 send 调用前业务方可查 `session.lastSnapshotError`(V1.5 可选)

**为什么不是 fire-and-forget**:fire-and-forget 让业务方完全感知不到,违反"显式失败"原则。yield warning 是中庸路径。

**为什么不是更长 timeout**:镜像内 600s 是兜底,正常 workspace ≤50MB 时实测 snapshot ≤5s。30s 给重网络 + AGS gateway 留余量,30s 都不行就该让业务方知道有问题。

### D3:并发安全 — 完全委托镜像 mutex,SDK 仅 backoff 重试 1 次

**选**(v1.2 简化):
- shared scope 下,**同 OAK 进程内多 session 共用同一个 `SandboxInstance`**
- session 内部 `send()` 是 `await` 串行,不会出现"同 inst 上多个并发 snapshot"
- 跨进程并发(业务方多副本)— 镜像内 `syncing` 互斥锁(`cos-sync.ts:1243-1264`)是单一真理源,后到的拿到 500 + `retryable: true`
- SDK 收到 retryable 错误时 backoff 1 秒后重试 1 次,仍失败则抛 `WorkspaceSnapshotError`

**为什么不在 SDK 加 mutex / in-flight 去重**(v1.1 → v1.2 删除):
1. 进程内顺序保证已经存在(send 串行),不需要去重
2. 跨进程 SDK mutex 不能生效
3. 镜像 mutex 已经经过 verify,加层等于偏离真理源

**为什么 retry max = 1 不是 0**(轻微保守):
- 高频场景下,镜像 mutex 偶发拒绝是常态(periodic sync 与 manual snapshot 撞车,镜像内最多等 12s,详 `cos-sync.ts` `prepareForManualSnapshot()`)
- 一次重试足以跳出绝大多数瞬态冲突
- 跨进程并发即使重试也不解决根本(详 §8 R2,业务方需保证同 envId 串行)

### D4:公开 `session.getRestoreStatus()`

**选**:把 restore 状态作为 SDK first-class API 暴露。

**为什么不是隐藏**:业务方在 UI 上有真实需求("workspace 部分恢复"或者"显示 source: cos | git | none"),如果 OAK 不暴露,业务方就要自己绕去调 `/health`。

**对其他 runtime 的兼容**:非 stateful runtime 的 `getRestoreStatus()` 永远返回 `null`,业务方代码不用分支判断。

### D5(v1.2 新增):`workspaceSnapshot` 启用要求 `sandbox.scope === 'shared'`

**选**:启用 `workspaceSnapshot` 时校验 scope === 'shared',否则 startSession 抛 `ConfigError`。

**为什么必须强制**:详 §1.3 的 silent data loss 分析。session scope 下两个独立容器在同一 COS 命名空间会互相覆盖。这种 bug 在测试时不容易暴露(单 session 都 work),但生产并发场景必触发,且 debug 极难。**早 fail 优于运行时 silent broken**。

**为什么不是 mode === 'auto' 时自动改 scope = 'shared'**:
1. scope 是业务方明确选择的隔离边界,OAK 不该悄悄改
2. session vs shared 影响计费、安全审计、容器生命周期 — 业务方应有意识地选

**为什么不是 enabled 时强制 + auto 时关闭**:
- `auto` 是默认值,如果业务方默认拿到一个 silent disable,他们不会知道为什么 snapshot 没工作
- 让 `auto` 在 scope 不对时也 throw,push 业务方做明确选择,跟"open agent kernel"的"显式失败"哲学一致

---

## 5. 错误语义

### 5.1 `bootstrap()`(startSession 时调 init)

| 后端响应 | OAK 行为 | 抛给业务方 |
|---|---|---|
| 200 + body 中 `restoreStatus.restored === 'full'/'fresh'/'partial'` | 正常,session 可用;`partial` 时记 metric `oak_workspace_restore_partial_total` | — |
| 200 + `restoreStatus.restored === 'failed'` | 视为 `failed` | `SandboxRestoreFailed`(含 `restoreStatus.note` 作 detail)|
| 5xx | 不重试(restore 是 expensive,失败再来一次会让用户多等几十秒)| `SandboxRestoreFailed` |
| HTTP timeout(超过 `workspaceInitTimeoutMs`)| — | `SandboxRestoreTimeout` |

**`bootstrap()` 不重试**:init 内部已经包了 restore,timeout/失败应快速 fail 让业务方决定(可能要换 envId、换 sandbox)。

### 5.2 `snapshot()`(send finally 时调)

| 后端响应 | OAK 行为 | 抛给业务方(以 warning event 形式,详 D2) |
|---|---|---|
| 200 + `{success:true, result:{ms}}` | 正常,记 `oak_workspace_snapshot_duration_ms` | — |
| 500 + `errorCode:'workspace_snapshot_failed'` + `retryable:true` | backoff 1 秒后重试 1 次 | `WorkspaceSnapshotError`(若重试仍失败) |
| 500 + `retryable:false` | 不重试,直接报错 | `WorkspaceSnapshotError` |
| 502 / 503 | 不重试(基础设施问题) | `SandboxUnavailableError` |
| HTTP timeout(超过 `workspaceSnapshotTimeoutMs`)| 不重试 | `WorkspaceSnapshotError`(message 含 `timeout`) |

### 5.3 错误类型定义

```ts
// errors.ts
export class WorkspaceSnapshotError extends Error {
  constructor(message: string, public readonly retryable: boolean, public readonly cause?: unknown)
}
export class SandboxRestoreFailed extends Error { /* note: SyncStatus.note */ }
export class SandboxRestoreTimeout extends Error { /* timeout: number */ }
export class SandboxUnavailableError extends Error { /* httpStatus: number */ }
```

---

## 6. 配置默认值汇总

| OAK 配置项 | 默认值 | 依据 | 镜像内对应 |
|---|---|---|---|
| `workspaceSnapshot` | `'auto'` | runtime backend 自动识别(决策 D1)+ scope 校验(D5) | — |
| `workspaceSnapshotTimeoutMs` | 30_000 | normal ≤5s,加 AGS gateway 网络余量 ≤10s,余 15s → 30s | `COS_SYNC_TIMEOUT_MS` 600_000 |
| `workspaceInitTimeoutMs` | 60_000 | normal restore ≤10s,大 workspace ≤30s,余 30s → 60s | `COS_RESTORE_TIMEOUT_MS` 1_200_000 |
| `retryMax`(内部) | 1(共尝试 2 次) | 一次重试足以跳出镜像 mutex 的瞬态冲突,跨进程并发 retry 无济于事 | — |
| `retryBackoffMs`(内部) | 1_000 | 镜像 manual snapshot 等待 in-flight sync 最长 12s(`COS_MANUAL_SNAPSHOT_IDLE_WAIT_MS`),1s backoff 是合理起点 | — |

### 6.1 Metrics(跨 spec 命名规范)

为跟 Spec A 对齐,统一采用 `oak_<module>_<operation>_<unit>` 模板:

| Metric | 类型 | 来源 |
|---|---|---|
| `oak_workspace_snapshot_duration_ms` | Histogram | snapshot 成功耗时 |
| `oak_workspace_snapshot_errors_total` | Counter | snapshot 失败计数(按 errorCode 标签)|
| `oak_workspace_init_duration_ms` | Histogram | bootstrap 调 init 的耗时 |
| `oak_workspace_restore_partial_total` | Counter | restoreStatus 为 partial 的次数 |

(Spec A 的 metrics 命名按本表回填,统一为 `oak_user_memory_*` — Spec A 实施 plan 已记 follow-up)。

---

## 7. 测试策略

### 单元测试(`__tests__/`)

| 测试文件 | 覆盖 |
|---|---|
| `snapshot-client.test.ts` | mock fetch:成功(`{success,result:{ms}}`) / 500-retryable retries / 500-non-retryable / 502 不重试 / timeout 五种路径;还原 `application/problem+json` 解析 |
| `init-client.test.ts` | mock fetch:成功 + restoreStatus 各值(full/fresh/partial/failed) / 5xx / timeout |
| `health-client.test.ts` | mock fetch:`/health` 返回各种 SyncStatus 形态(含 `null` 字段缺失场景);zod schema 验证容错 |
| `snapshot-engine.test.ts` | 整合 client + bootstrap + snapshot:`'auto'` 在 `backend === 'ags-stateful'` 上启用 / 其他 runtime 关闭;scope !== 'shared' 时抛 ConfigError |

### Examples(`packages/open-agent-kernel/examples/`)

| 文件 | 演示 |
|---|---|
| `18-workspace-snapshot.ts` | 单进程:写文件 → send_end snapshot → 重启 OAK → restore → 看到上次的文件 |
| `19-workspace-snapshot-distributed.ts` | Node A 写文件 + Node B 接续 |

### 端到端(可选,V2)

需要真实 AGS 环境,放在 `verify-workspace-snapshot-e2e.ts` 风格的脚本里。V1 文档化"如何在腾讯云上跑"即可,不入 CI(避免 e2e 依赖外部网络)。

---

## 8. 实施风险与已知限制

### R1:`/health` 返回结构在镜像不同版本可能漂移

**风险**:`tcb-remote-workspace` 升级后 `restoreStatus` 字段结构变化(我们读了 v0.4.0)。

**缓解**:
- `types.ts` 用 zod schema 解析 `/health` 响应,字段缺失或类型不对时 graceful degrade(当作 `null`)
- 关键字段(`restoreStatus.restored`)是 enum,用 `z.enum(['full','partial','fresh','failed'])` 强校验,新增值会被 reject 让我们及早发现
- pnpm 锁定镜像版本(在 OAK README 里记录已验证的镜像 tag)

### R2:跨进程并发(业务方多副本部署)snapshot 互斥拒绝

**场景**:业务方把 OAK 部署到多副本(同 envId 同 userId 复用 sandbox 容器),两个副本同时 send_end → 都打 `/api/workspace/snapshot` → 镜像 mutex 让一个返回 500 + retryable;SDK backoff 1 秒后重试,如果仍冲突则失败。

**严重程度评估**:
- **轻**:常见 OAK 业务场景下,同 envId 同时被多副本激活 send 的概率低 — 一个 envId 通常对应一个用户的活跃会话窗口
- **设计前提**:OAK 假设业务方已经在更高层做了同 envId 串行(对齐 Spec A §5.3 同样承诺)

**当前 spec 的处理**:
- SDK 层:retryMax = 1,失败抛 `WorkspaceSnapshotError`,业务方决定后续动作
- 文档要求:**业务方应保证同 envId 的 OAK send 调用在更高层串行**(单进程内由 session 自带 await 保证;跨进程由业务方调度层保证)

**不在本 spec 内的优化(留 V2 评估)**:
- SDK 层加更长 backoff + jitter
- 镜像层提供"等当前 sync 完再排队"而非直接拒绝

### R3:镜像 snapshot 内部失败但返回 200

**风险**:zstd 写部分成功,镜像 verify 阶段可能漏过。

**缓解**:不归 OAK 管;镜像方有 `verifySnapshotIntegrity` 二次校验(`cos-sync.ts:706-724`),信任之。

### R4:Workspace 巨大(GB 级)

**风险**:30s timeout 不够。

**缓解**:`workspaceSnapshotTimeoutMs` 是公开 config,业务方可调。spec 假设默认值适合普通场景(workspace ≤ 几百 MB);超大 workspace 业务方应:
1. 把 `workspaceSnapshotTimeoutMs` 上调至 120s+
2. 考虑用 `.gitignore` / 类似机制让镜像端排除 `node_modules/dist/build` 等大目录(镜像内自身有 ignore 列表,详 `cos-sync.ts:492-500`)

### R5:bootstrap 失败让 startSession 整体不可用

**风险**:网络瞬时故障让 init HTTP 5xx,startSession 抛 `SandboxRestoreFailed`,业务方看到 session 没启动。

**缓解**:
- bootstrap 不重试是有意为之(restore expensive,不该自动重)
- 业务方可在更高层加 startSession 重试(类似 cold start 容错)
- 文档建议:用 `try { await agent.startSession() } catch (e instanceof SandboxRestoreFailed) { /* 创建新 envId 重试 */ }`

---

## 9. 自审 checklist(给 reviewer)

- [x] **范围正交**:Spec B 是否动了 Spec A 已经稳定的 `~/.claude/` 同步路径?**没有** — 不同目录、不同 store、不同 trigger 实现
- [x] **API 增量最小化**:`SandboxConfig` 加 3 个 optional 字段;`Session` 加 2 个 optional 方法;`SandboxRuntime.backend` 字段语义升级(无新字段)。无 breaking change
- [x] **scope 约束清晰**:`workspaceSnapshot` 启用要求 `sandbox.scope === 'shared'`,在 startSession 阶段 fail-fast(详 §1.3 / §3.4 / D5);避免 session scope 下的 silent data loss
- [x] **无幽灵字段**:本 spec 不引入"看着像但不实现"的字段(对照 Spec A 删 `SandboxCapabilities` 那段教训)
- [x] **错误类型不滥**:4 个错误类(SnapshotError / RestoreFailed / RestoreTimeout / SandboxUnavailable)+ 1 个 ConfigError(scope 校验)— 各有清晰的语义边界
- [x] **测试可覆盖**:client 层用 mock fetch,engine 用 mock instance — 全部可单测;scope 校验在 agent-builder 单测覆盖
- [x] **依赖边界**:仅依赖 `SandboxInstance.request` 已有接口 + 复用既有的 `SandboxRuntime.backend` 字段(语义升级,无新字段)
- [x] **失败可见**:bootstrap 失败 throw;snapshot 失败 yield warning event(不抹掉已生成的 final answer);scope 错配 startSession throw — 业务方三条路径都能感知
- [x] **可观测性**:metrics 命名按 `oak_<module>_<operation>_<unit>` 模板,详 §6.1
- [x] **跟镜像源码交叉验证**:HTTP contract、SyncStatus 类型、snapshot 返回结构都直接引用 `tcb-remote-workspace` v0.4.0 源码
- [x] **跟 stateful-infra 语义对齐**:workspace 持久化绑死 shared mode,跟 stateful-infra `ensureSingleEnvInstance()` 一致(详 §1.3 末尾)

---

## 10. 与 Spec A 的关键对照

| 维度 | Spec A | Spec B |
|---|---|---|
| 立项问题 | 用户级偏好(CLAUDE.md / agent-memory)跨节点共享 | 工作区(cwd)跨 session 持久化 |
| 数据所在 | OAK 进程本地的 `<CLAUDE_CONFIG_DIR>` | sandbox 容器内 `/home/user` |
| 同步执行 | OAK 进程直接调 `@cloudbase/manager-node` | 委托镜像 HTTP `POST /api/workspace/snapshot` |
| Bootstrap 触发 | session.send 内 pull(无 init 概念) | session.startSession 调 `POST /api/workspace/init`(同步触发 restore)|
| Push 触发 | session.send_end push(file diff) | session.send finally 调 snapshot |
| 增量 | 文件级 hash diff,文件粒度上传/删除 | 镜像内 zstd tar 全量(增量在 COS FUSE 层)|
| 失败容忍 | `Promise.allSettled` — 部分文件失败仍继续 | bootstrap 失败 throw(让 startSession 报错);snapshot 失败 yield warning(不抹 final answer)|
| 业务方零配置 | `userMemory: { enabled: true }` 启 | `workspaceSnapshot: 'auto'` 默 |
| Runtime 范围 | 任何 runtime(只看 CONFIG_DIR) | **仅** `SandboxRuntime.backend === 'ags-stateful'`(其他 runtime 留 Spec C)|

**关键区别**:Spec A 是"OAK 主动管 COS",Spec B 是"OAK 协调镜像管 COS"。两套都正确,各为其所需。

---

## 11. Out of scope(明确留给后续 spec)

- **Spec C**:非 AGS runtime 的 workspace 持久化(本地 docker / firecracker / 裸 cwd)。设计可借鉴 Spec A(file-level hash diff + COS),但 trigger 和打包策略要重新评估
- **Spec D**:Workspace 多版本/checkpoint(允许业务方"回滚到 1 小时前的 cwd")— 镜像层已经保留 `COS_SNAPSHOT_KEEP=3` 个版本,V2 把这个能力暴露给业务方
- **Spec E**:多用户共享同一 workspace(协作场景)— 完全不在当前架构里,需要从镜像那一层开始重设计

---

## 12. 实施 plan 启动条件

本 spec 通过 review 后,产出实施 plan 文档 `2026-06-XX-oak-workspace-snapshot-plan.md`,拆 ~8-10 个 task:

1. `workspace-snapshot/types.ts`(zod schema for `/health` 响应、`SyncStatus`)
2. `workspace-snapshot/errors.ts`(4 个错误类)
3. `workspace-snapshot/snapshot-client.ts`(POST /api/workspace/snapshot + 1 次 retry on retryable)
4. `workspace-snapshot/init-client.ts`(POST /api/workspace/init,不重试)
5. `workspace-snapshot/health-client.ts`(GET /health 解析 restoreStatus)
6. `workspace-snapshot/snapshot-engine.ts`(组装 bootstrap + snapshot + scope 校验)
7. `SandboxRuntime.backend` 字段注释升级(语义从"诊断日志用"改为"业务判定";`AgsStatefulSandbox` 实现零改动)
8. 公共 API:`SandboxConfig` + `Session` 加字段/方法
9. `agent-builder.ts` / `create-agent.ts` 接入触发点(bootstrap + send finally)
10. example 18 + 19(可选 V1)

每个 task 走 subagent-driven-development,带 TDD,跟 Spec A 一致。

---

**END OF SPEC v1 — awaiting review**
