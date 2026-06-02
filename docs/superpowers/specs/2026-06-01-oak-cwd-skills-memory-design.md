# Spec A:`cwd` + `skills` + `memory` 设计

> 文档编号:Spec A
> 创建日期:2026-06-01
> 分支:`feat/support-open-agent-kernel`
> 状态:待 review
> 关联后续:Spec B(沙箱工作区快照)

## 1. 背景与动机

### 1.1 现状问题

OAK SDK 当前(commit `8205190`)在 `agent-builder.ts:167` 硬编码 `settingSources: []`,目的是切断对宿主机 `~/.claude/` 配置的依赖,实现"云服务不依赖本机配置"的部署语义。

这个决策的代价是:
1. **Skills 能力被堵死** — Claude Agent SDK 的 `skills` 选项依赖 `settingSources` 含 `'project'` 才能扫描 SKILL.md(证据:`@anthropic-ai/claude-agent-sdk/sdk.d.ts:1742-1764, 2815-2817`)。
2. **Memory 能力被堵死** — SDK 的 CLAUDE.md 加载同样依赖 `settingSources` 含 `'project'`(`sdk.d.ts:1739`)。
3. **类型层有"幽灵 API"** — `SandboxCapabilities` 接口已声明 `skills` / `memory` / `compaction` 字段(`public/types.ts:130-138`),但 `agent-builder.ts` 完全不读取,用户配置无效但不报错。这比"未实现"更糟。

### 1.2 用户需求

业务方需要:
- **平台级 Skills**:在 SDK 上层业务服务里管理一份 SKILL.md 集合,所有节点共享同一套(如 SkillHub 安装到固定路径)。
- **用户级长期记忆**:跨 conversation 沉淀的"对这个用户的认知",必须分布式可用(任何节点接到该用户都能拿到)。
- **保持多租户隔离**:云服务部署的 SDK 不能引入跨租户串扰。

### 1.3 不在本 Spec 范围内

- 沙箱工作区快照 / 持久化 → Spec B
- 语义召回(向量库)→ 未来扩展,本 Spec 仅做 KV 形态长期记忆
- 沙箱内的工作区目录派生 → 由沙箱镜像负责(stateful-infra 既定语义,SDK 不感知)
- `compaction` 能力 → SDK 自带且默认开启,本 Spec 不动

## 2. 设计原则

1. **平台资产 vs 用户私产**:Skills 与项目级 CLAUDE.md 是平台/服务方的资产(共享、只读心智);用户级长期记忆是单个 user 的私产(独占、读写心智)。两者用不同载体。
2. **载体匹配心智**:平台资产走文件(SDK 自动加载),用户私产走工具调用(agent 主动 save/recall)。
3. **保持多租户安全边界**:`settingSources` 仅在受控 cwd 下打开,绝不读取宿主机 `~/.claude/`(避免开 `'user'` 这个 source)。
4. **零隐式行为**:SDK 不在用户背后偷偷做工作区派生、目录创建等不可见的事;所有边界透明。
5. **API 增量最小**:只新增 3 个顶层字段(`cwd` / `skills` / `memory`),不动现有 API。

## 3. 公共 API 增量

### 3.1 顶层 `AgentConfig` 新增字段

```typescript
interface AgentConfig {
  // ────── 既有字段(零改动)──────
  envId: string
  model: string | ModelSpec
  systemPrompt?: string
  sandbox?: SandboxConfig            // 完全不动
  session?: SessionConfig
  permissions?: PermissionConfig
  mcpServers?: Record<string, McpServerConfig>
  storage?: StorageProvider
  hooks?: AgentHooks
  
  // ────── 新增 1:平台资产层(宿主机 cwd)──────
  /**
   * SDK 加载本机文件型资产的根目录。
   * 影响:Skills 扫描根、项目级 CLAUDE.md 查找根、SDK 子进程 spawn cwd。
   * 默认:OAK 自管的纯净 ephemeral 目录(无 skills、无 CLAUDE.md,等价当前 v0 行为)。
   * 业务方通常传镜像内的固定路径(如 '/app/skills-bundle')。
   * 
   * ⚠️ 安全:OAK 内部强制 settingSources 仅含 'project',永远不读 'user'(宿主机 ~/.claude)。
   */
  cwd?: string
  
  /**
   * 启用 Claude Agent SDK 的 skills 能力。
   * SDK 在 cwd/.claude/skills/ 下扫描 SKILL.md,按 enabled 过滤后注入到 system prompt。
   * 不传或 enabled 未配 → skills 关闭(等价 v0 行为)。
   */
  skills?: {
    enabled?: 'all' | string[]
  }
  
  // ────── 新增 2:用户级长期记忆(工具型)──────
  /**
   * 用户级长期记忆。启用后,SDK 会注入一组 mcp__oak_memory__* 工具,
   * agent 通过工具调用主动 save/recall。namespace = (envId, userId)。
   * 默认:disabled。
   *
   * 启用条件:
   *   - 必须传 enabled: true
   *   - 必须显式传 store(无默认 store,避免误以为有静默实现)
   *
   * 业务方常见用法:
   *   memory: {
   *     enabled: true,
   *     store: new CloudBaseMemoryStore({
   *       driver: new CloudBaseDbMemoryDriver(),
   *       projectKey: envId,
   *     }),
   *   }
   *
   * 仅做开发/测试时可用 InMemoryMemoryStore(进程退出即丢失,不持久化)。
   */
  memory?: {
    enabled?: boolean
    store?: MemoryStore
  }
}
```

### 3.2 `MemoryStore` 抽象

```typescript
interface MemoryStore {
  /**
   * 写入或覆盖一条记忆。
   * @param ctx namespace 上下文
   * @param key 业务定义的 key(如 'preferences.language' / 'fact.cat-name')
   * @param value 字符串内容(由 agent 自主决定结构,SDK 不强制 schema)
   */
  put(ctx: MemoryContext, key: string, value: string): Promise<void>
  
  /** 读取一条记忆。不存在时返回 null。 */
  get(ctx: MemoryContext, key: string): Promise<string | null>
  
  /** 列出该 namespace 下所有 key(用于 agent 探索"我记得这个 user 的什么")。 */
  list(ctx: MemoryContext): Promise<Array<{ key: string; updatedAt: number }>>
  
  /** 删除一条记忆。不存在时不报错。 */
  delete(ctx: MemoryContext, key: string): Promise<void>
}

interface MemoryContext {
  envId: string
  userId: string
}
```

### 3.3 内置 MCP 工具(用户启用 memory 后自动暴露)

- `mcp__oak_memory__save({ key: string, value: string })` → `{ ok: true }`
- `mcp__oak_memory__recall({ key: string })` → `{ value: string | null }`
- `mcp__oak_memory__list()` → `{ items: Array<{ key, updatedAt }> }`
- `mcp__oak_memory__delete({ key: string })` → `{ ok: true }`

namespace 来自 SDK 内部 session context(`envId` 来自 AgentConfig,`userId` 来自 `agent.startSession({ userId })`),agent 不能伪造,业务方也不能跨 user 操作。

### 3.4 默认实现:`CloudBaseMemoryStore`

包结构:`@cloudbase/open-agent-kernel`(主包 export)
```typescript
import { CloudBaseMemoryStore, CloudBaseDbMemoryDriver } from '@cloudbase/open-agent-kernel'

const store = new CloudBaseMemoryStore({
  driver: new CloudBaseDbMemoryDriver(),
  projectKey: envId,
})
```

后端 DB 集合:`oak_user_memory`(前缀 `oak_` 与既有体系一致)

集合 schema:
```typescript
interface OakUserMemoryRecord {
  _id: string                  // CloudBase 生成
  projectKey: string           // = envId,多租户隔离键
  userId: string               // 业务 user ID
  key: string                  // 业务自定义 key
  value: string                // 记忆内容(字符串,无 schema 限制)
  createdAt: number            // ms timestamp
  updatedAt: number            // ms timestamp
}
```

索引:`(projectKey, userId, key)` 唯一索引(用于 put 的 upsert + get 的 O(1) 查询)。

### 3.5 沙箱配置 — 零改动

```typescript
sandbox: {
  runtime: SandboxRuntime,
  scope?: 'session' | 'shared',     // 既有,语义不变(AGS 实例粒度)
  cloudbaseTools?: boolean,
  userCredentials?: ...,
}
```

不引入 `workspaceRoot` / `workspaceLayout`,工作区目录派生由沙箱镜像负责(`STATEFUL_WORKSPACE_ROOT='/home/user'` + 镜像内按 conversationId 分子目录,见 server `feature/stateful-infra:packages/server/src/sandbox/git-archive.ts:150` 注释)。

### 3.6 注释术语对齐(顺手改)

`public/types.ts:70-74` 对 `scope` 的注释补充与 server `sandboxMode` 的对应:

```typescript
/**
 * - 'session'(默认):每个 startSession 一个独立 AGS 实例
 *   (对应 server feature/stateful-infra 的 sandboxMode: 'isolated')
 * - 'shared':同 envId 多个 session 共享一个 AGS 实例
 *   (对应 server feature/stateful-infra 的 sandboxMode: 'shared')
 *
 * 注意:这两个 scope 是 AGS 实例粒度,与"沙箱内工作区目录"是两层正交关系。
 * 工作区目录派生由沙箱镜像负责(/home/user/{conversationId}/ 约定),SDK 不感知。
 */
scope?: 'session' | 'shared'
```

## 4. 内部实现要点

### 4.1 `agent-builder.ts` 改动

#### 4.1.1 cwd 处理

```typescript
// 1) 用户传了 cwd:走"受控 settingSources"路径
//    - 透传 SDK 的 cwd option
//    - settingSources 设为 ['project']
// 2) 用户没传 cwd:走"isolation mode"路径(等价 v0)
//    - SDK 用 ephemeral 临时目录作 cwd
//    - settingSources 设为 []

const userCwd = config.cwd
const effectiveCwd = userCwd ?? deriveEphemeralCwd(/* per-instance */)
const settingSources: SettingSource[] = userCwd ? ['project'] : []
```

`deriveEphemeralCwd()` 派生策略:`os.tmpdir() + '/oak-ephemeral-' + randomId()`,**每个 SDK 进程实例化时生成一次**,进程生命周期内复用,进程退出时清理。**不依赖 userId / conversationId** — 这个目录是空目录(无 CLAUDE.md / 无 skills / settingSources=[]),所有用户共用同一个空目录是安全的,因为里面没有任何会被 SDK 加载的内容。

注意:这与本仓库 `agent-builder.ts:42-46` 当前的 `getSessionLocalDir()` (返回 `process.env.OAK_SESSION_LOCAL_DIR ?? process.env.TMPDIR ?? '/tmp'`) 是**两个独立用途**:
- `getSessionLocalDir()` 用于 SDK 子进程的 `CLAUDE_CONFIG_DIR`(dual-write JSONL 落盘) — 保持现状不动
- `deriveEphemeralCwd()` 用于 SDK 的 `cwd` option(skills/CLAUDE.md 加载根) — 本 spec 新增

两者互不影响。`CLAUDE_CONFIG_DIR` 的多租户隔离问题(原 Q2 议题)**不在本 spec 范围内**(等价于既有行为风险),将在未来另起 spec 处理。

#### 4.1.2 skills 处理

```typescript
if (config.skills?.enabled !== undefined) {
  options.skills = config.skills.enabled       // 透传 'all' | string[]
}
// 注意:仅当 settingSources 含 'project' 时 SDK 才会扫到 SKILL.md。
// 用户没传 cwd 但传了 skills.enabled → settingSources=[],SDK 扫不到任何 SKILL.md
// → skills 配置实际无效,但不报错(SDK 自然 degrade,等同未配置)。
// 文档明确说明这一约束:启用 skills 必须同时传 cwd。
```

启动期 warning(可选,提升 DX):若 `skills.enabled` 已配但 `cwd` 未配,在 startSession 时 `console.warn`("skills configured but cwd not set — SKILL.md will not be discovered")。

#### 4.1.3 memory MCP server 注入

```typescript
if (config.memory?.enabled) {
  if (!config.memory.store) {
    throw new InvalidConfigError(
      'memory.enabled=true requires memory.store to be set explicitly. ' +
      'Use CloudBaseMemoryStore for production or InMemoryMemoryStore for tests.'
    )
  }
  const memoryMcp = createOakMemoryMcpServer({
    store: config.memory.store,
    ctx: { envId: config.envId, userId: /* 来自 session 创建时的 userId */ },
  })
  // 合并到 mergedMcpServers,key 为 'oak_memory' → 工具名 mcp__oak_memory__*
  merged.oak_memory = memoryMcp
}
```

memory 工具的 namespace 上下文从 session 派生(每个 session 持有 userId),通过 SDK MCP server 实例的闭包传递,**不依赖 agent 传参**(agent 只传 key/value,namespace SDK 内部固定)。

### 4.2 新增模块结构

```
packages/open-agent-kernel/src/memory/
  ├─ types.ts                       # MemoryStore / MemoryContext 接口
  ├─ in-memory-memory-store.ts      # 默认 InMemory 实现(开发/测试)
  ├─ cloudbase-memory-store.ts      # CloudBaseMemoryStore + 默认 CloudBaseDbMemoryDriver
  ├─ mcp-server.ts                  # createOakMemoryMcpServer (mcp__oak_memory__*)
  └─ index.ts                       # 公共 export
```

`src/index.ts` 增量 export:
```typescript
export type { MemoryStore, MemoryContext } from './memory/index.js'
export {
  CloudBaseMemoryStore,
  CloudBaseDbMemoryDriver,
  InMemoryMemoryStore,
} from './memory/index.js'
```

### 4.3 `CloudBaseDbMemoryDriver` 实现要点

复用既有 `cloudbase-session-store/drivers/cloudbase-db-driver.ts` 的连接抽象(从 envId + 用户凭证派生 CloudBase DB 客户端)。新建 `oak_user_memory` 集合,提供 4 个方法:

```typescript
class CloudBaseDbMemoryDriver implements MemoryDriver {
  async put(ctx, key, value): Promise<void>      // upsert by (projectKey, userId, key)
  async get(ctx, key): Promise<string | null>    // findOne
  async list(ctx): Promise<...>                  // find by (projectKey, userId)
  async delete(ctx, key): Promise<void>          // deleteOne
}
```

错误处理:遵循既有 `internal/errors.ts` 模式,DB 不可达时抛 `CloudBaseDbError`。

### 4.4 `mcp-server.ts` 关键实现

使用 `@anthropic-ai/claude-agent-sdk` 的 `createSdkMcpServer + tool` 构造:

```typescript
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

export function createOakMemoryMcpServer(opts: {
  store: MemoryStore
  ctx: MemoryContext
}): McpServerInstance {
  return createSdkMcpServer({
    name: 'oak_memory',
    version: '1.0.0',
    tools: [
      tool('save', 'Persist a fact about the current user...',
        { key: z.string(), value: z.string() },
        async (args) => {
          await opts.store.put(opts.ctx, args.key, args.value)
          return { content: [{ type: 'text', text: 'saved' }] }
        }),
      tool('recall', 'Retrieve a previously saved fact...',
        { key: z.string() },
        async (args) => {
          const v = await opts.store.get(opts.ctx, args.key)
          return { content: [{ type: 'text', text: v ?? 'not found' }] }
        }),
      tool('list', 'List all keys saved for the current user',
        {},
        async () => {
          const items = await opts.store.list(opts.ctx)
          return { content: [{ type: 'text', text: JSON.stringify(items) }] }
        }),
      tool('delete', 'Delete a saved fact',
        { key: z.string() },
        async (args) => {
          await opts.store.delete(opts.ctx, args.key)
          return { content: [{ type: 'text', text: 'deleted' }] }
        }),
    ],
  })
}
```

工具的 description 需引导 agent 在合适时机主动调用,例如:
- `save`: "Persist a fact about the current user that should be remembered across conversations. Use when the user mentions a personal preference, profile detail, or instruction that should apply to future sessions."
- `recall`: "Retrieve a previously saved fact about the current user. Call this near the start of a conversation when context about the user would help, e.g. preferences, past projects, or stated facts."
- `list`: "List all keys saved for the current user. Use when you need to discover what facts are already known."
- `delete`: "Delete a saved fact when the user explicitly asks to forget it or correct outdated information."

**业务方在 systemPrompt 中应明确引导 agent 主动使用这组工具**(例:"You have access to mcp__oak_memory__* tools. At conversation start, list available memories. When the user shares preferences or facts, save them.")。SDK 不强制 systemPrompt 模板,留给业务方自定义。

### 4.5 删除"幽灵 API"

`public/types.ts:124-139` 的 `SandboxCapabilities` 接口里 `skills` / `memory` / `compaction` 三个字段:
- `skills` → 删除(取代为顶层 `skills`)
- `memory` → 删除(取代为顶层 `memory`)
- `compaction` → 删除(SDK 自带,无需暴露;若未来要调阈值,届时再开新字段)

`SandboxCapabilities` 仅保留 `filesystem` / `shell`(这两个 SDK 工具层面有意义)。这是**破坏性改动**,但因为这些字段从未真正生效,实际无业务方依赖,接受。

## 5. 边界与约束

### 5.1 安全约束

| 约束 | 位置 | 实现策略 |
|---|---|---|
| 永远不打开 `settingSources: 'user'` | `agent-builder.ts` | 内部硬编码 settingSources 派生只产出 `[]` 或 `['project']`,不接受用户传入完整 SettingSource 数组 |
| 永远不打开 `settingSources: 'local'` | 同上 | 同上 |
| 用户传的 `cwd` 安全检查 | 运行时 validate | 拒绝以下值:`~/.claude` / `~/.claude/...` / `/Users/.../.claude` / 任何包含 `.claude` 段且指向 `os.homedir()` 子树的路径 |
| memory 工具的 namespace 不接受 agent 传参 | `mcp-server.ts` 闭包 | namespace ctx 在 server 实例化时通过闭包注入,工具 schema 不暴露 envId/userId 字段 |

### 5.2 兼容性

- 三个新字段全为 optional,默认值与 v0 行为完全一致
- 现有用户零迁移成本
- 唯一破坏性改动:`SandboxCapabilities` 删 3 个未生效字段(可接受)

### 5.3 不解决的问题

- **沙箱工作区文件持久化** → Spec B
- **跨节点同 user 的"工作区"复用** → Spec B(快照 + 恢复)
- **memory 的语义召回 / 向量化** → 未来 v2,本 spec 仅 KV
- **memory 的"自动 compact"(超大记忆体如何摘要)** → 未来 v2

## 6. 测试策略

### 6.1 单元测试

| 测试对象 | 关键场景 |
|---|---|
| `CloudBaseDbMemoryDriver` | put/get/list/delete + 多 user 隔离 + 多 envId 隔离 |
| `createOakMemoryMcpServer` | 4 个工具均能正确调用底层 store + ctx 闭包正确 |
| `agent-builder.ts` cwd 分支 | 用户传 cwd → settingSources=['project'];未传 → settingSources=[] |
| `agent-builder.ts` skills 透传 | skills.enabled=string[] / 'all' 都正确透传 |
| `agent-builder.ts` memory 注入 | memory.enabled 时 mcp__oak_memory__ 出现在 mergedMcpServers |

### 6.2 集成示例(examples/)

新增 3 个 example:
- `15-skills.ts`:演示业务方在 `cwd: '/path/to/skills-bundle'` 下放 `.claude/skills/foo/SKILL.md`,启用 `skills: { enabled: 'all' }`,agent 自动用上 skill
- `16-memory.ts`:演示开启 memory 后,首轮对话告诉 agent 一个事实 → 第二个 conversation(同 userId)里 agent 主动 recall 出这个事实
- `17-memory-distributed.ts`:演示 memory 跨节点 — 节点 A save,节点 B recall(同 userId 同 envId)

### 6.3 多租户隔离验证

example 16 / 17 必须显式验证:
- 同 envId 不同 userId → memory 完全隔离
- 不同 envId(同 userId 字符串)→ memory 完全隔离
- 同 envId 同 userId 不同 conversation → memory 共享(这就是长期记忆的目的)

## 7. 实施阶段拆分(给 writing-plans 的提示)

| 阶段 | 内容 | 可独立合并 |
|---|---|---|
| **A1** | 新增 `MemoryStore` 抽象 + `InMemoryMemoryStore`(无 DB 依赖) + 单元测试 | ✅ |
| **A2** | `createOakMemoryMcpServer` + 接入 `agent-builder.ts` | ✅ |
| **A3** | `CloudBaseDbMemoryDriver` + `CloudBaseMemoryStore` + 集合 schema 添加到 README | ✅ |
| **A4** | cwd / skills 透传到 SDK + settingSources 受控解封 + 安全 validate | ✅ |
| **A5** | 删除 `SandboxCapabilities` 的 3 个幽灵字段 + sandbox scope 注释术语对齐 | ✅(破坏性,minor 版本) |
| **A6** | examples 15/16/17 + README 章节(平台资产 vs 用户私产 + 两层粒度) | ✅ |

每个阶段独立可合并,顺序 A1 → A2 → A3 → A4 → A5 → A6 推荐,但 A4/A5 可与 A1-A3 并行。

## 8. 已驳回的方案与理由

### 8.1 ❌ 用户级 CLAUDE.md 走文件物化

**驳回理由**:Claude Agent SDK 不支持"per-user CLAUDE.md"概念 — `'user'` settingSource 指**宿主机** `~/.claude/`,不是业务用户级。强行用 per-user ephemeral cwd 物化文件会引入"分布式节点本地 FS"的串扰风险与同步成本,违反"stateless workers + stateful store"业界共识。

### 8.2 ❌ 暴露 `sandbox.workspaceLayout`

**驳回理由**:工作区目录派生由沙箱镜像负责(stateful-infra 既定语义),SDK 在这一层做配置只会增加用户理解成本,不解决任何问题。

### 8.3 ❌ scope 默认改为 'shared'(对齐 server)

**驳回理由**:虽然 server feature/stateful-infra 默认 'shared',但 OAK SDK 的目标用户场景更广泛(包含纯 stateless API 网关型用法),保持 'session' 作为默认更安全。注释说明对应关系即可,不强制对齐默认值。

### 8.4 ❌ 暴露 SDK 的 `autoMemoryEnabled` / `autoMemoryDirectory`

**驳回理由**:SDK 自带的 `autoMemoryDirectory` 默认指向宿主机 `~/.claude/`(`sdk.d.ts:5267-5269`),与 OAK 多租户部署冲突;且 SDK 内置工具列表无 Memory 工具,agent 调不出来,是"有路径但无工具"的死循环。改用工具型 memory(本 spec 方案)绕开这个问题。

## 9. 引用证据

- Claude Agent SDK 类型(本机路径):
  `packages/open-agent-kernel/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1265,1267,1739,1742-1764,2815-2817,5265-5273,5316-5318,5413`
- OAK 当前实现:
  `packages/open-agent-kernel/src/runtime/agent-builder.ts:167,189`
  `packages/open-agent-kernel/src/public/types.ts:70-74,124-139`
  `packages/open-agent-kernel/src/sandbox/ags-stateful-sandbox.ts:605-657`
- Server feature/stateful-infra(同仓库其他分支):
  `packages/server/src/lib/sandbox-config.ts:13`(STATEFUL_WORKSPACE_ROOT)
  `packages/server/src/sandbox/provider/stateful-provider.ts:480-516`(prepare)
  `packages/server/src/agent/cloudbase-agent.service.ts:880`(workspaceHint 写死)
  `packages/server/src/sandbox/git-archive.ts:150`("同一分支上有多个 conversation 目录")

## 10. 后续 Spec 关联

- **Spec B(沙箱工作区快照)**:本 spec 完成后的下一份。基于 SandboxInstance 增加 `snapshot()` / `restore()` API,后端走 envId 对应租户 COS。Spec B 与本 spec 在公共 API 上**完全解耦**,实施可并行。
