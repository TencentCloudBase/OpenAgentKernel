# Changelog

## 0.1.3 — 2026-09-23

### 新增

- `ModelSpec.options` 按 allowlist 透传到 Claude Agent SDK `query()` options：`thinking` / `effort` / `maxThinkingTokens` / `maxTurns` / `maxBudgetUsd` / `taskBudget` / `fallbackModel` / `betas` / `extraArgs` / `outputFormat`
- `options.env` 与网关环境变量浅合并；`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CONFIG_DIR` 仍由 kernel 覆盖，其余键丢弃

## 0.1.2 — 2026-08-24

正式版，功能同 `0.1.2-beta.1`。

### 变更

- 向用户提问改为 Claude Agent SDK 内置 `AskUserQuestion`，不再使用进程内 MCP stub。HITL 通过 `PreToolUse` 把答案写入 `updatedInput`（`0.1.2-beta.0`，2026-08-21）

### 修复

- 非交互 SDK 会话中启用 `AskUserQuestion`：传入 no-op `canUseTool`，让 CLI 挂载该内置工具；审批仍走 `PreToolUse`（`0.1.2-beta.1`）

## 0.1.1 — 2026-08-13

正式版，功能同 `0.1.0-beta.18`。`0.1.1-beta.0` 只有版本号变化。

## 0.1.0-beta.18 — 2026-08-13

### 变更

- 运行时要求从 Node.js >= 22 调整为 >= 20.19
- 省略 `sandbox` 时默认启用 local sandbox。公开 `SandboxConfig` 只保留 `enabled` 与 `workspaceRoot`；AGS 通过自定义 `runtime`（如 `AgsStatefulSandbox`）接入
- local sandbox 的 CloudBase 工具走进程内 MCP，`@cloudbase/cloudbase-mcp` 成为 optional peer
- 文档与示例中的服务端 API Key 环境变量统一为 `CLOUDBASE_APIKEY`

### 修复

- workspace snapshot 的超时配置改经内部 `SandboxConfig` 类型传递

## 0.1.0 — 2026-08-06

正式版。`0.1.0-beta.17`（2026-08-05）与此版本代码相同。

### 新增

- 默认会话流改为 ACP `session/update`（`AcpSessionUpdate`），并导出 `AcpStreamAdapter`
- 启用 sandbox 且未指定 provider 时默认 `local`（宿主进程文件系统 + Claude SDK 内置工具）；`ags-stateful` 仍可显式选择
- 客户端工具结果回传：`session.respondToolUse()`
- `agent.sessions.get()` 按 conversationId 读取会话
- 环境变量 `OAK_CLAUDE_CODE_EXECUTABLE_PATH` 可指定 Claude Code 可执行文件

### 变更

- 模型网关与沙箱数据面的环境变量由 `TCB_API_KEY` 改为 `CLOUDBASE_APIKEY`

### 说明

- 仍要求 Node.js >= 22
- 未配置 `sandbox` 时不启用 sandbox

## 0.1.0-beta.15 — 2026-07-31

### 新增

- 单 API Key 持久化：只有 `TCB_API_KEY` 时，会话与 HITL 可走数据面 accessKey 写入 FlexDB；同时提供 CAM 凭证时仍优先使用 CAM
- `userMemory` 可用 `TCB_API_KEY` 走 COS 数据面（sidecar manifest）。该模式下不能自动发现历史 `projects/*` 与 `agent-memory/*`

### 说明

- 多模态附件上传仍需要 CAM `credentials`
- 要求 Node.js >= 22

## 0.1.0-beta.0 — 2026-06-15

首个 beta 版本。

### 新增

- `createAgent()` 服务端 Agent SDK，基于 Claude Agent SDK，默认对接 CloudBase AI gateway
- 会话：`startSession` / `resumeSession` / `session.send` 流式事件
- CloudBase FlexDB session 持久化（传 `credentials` 后默认启用）
- CloudBase Storage 多模态附件
- Sandbox（AGS Stateful）：文件系统 / Shell / CloudBase MCP 工具
- HITL 工具审批：`permissions.requireApproval` + `session.respondApproval`
- `userMemory` 用户级长期记忆（CloudBase COS 同步）
- Workspace snapshot（sandbox cwd 跨进程恢复）
- Skills / MCP（进程内、stdio、HTTP）扩展

### 说明

- 要求 Node.js >= 22
- 安装包已内置 `@cloudbase/node-sdk`、`@cloudbase/manager-node`、`zod`
- Sandbox 默认镜像可通过 `OAK_SANDBOX_IMAGE` 覆盖；beta 内置 fallback 为开发镜像
- 部分 API 仍为预留或 stub：`handoffs`、`AgentConfig.metadata`、`agent.sessions.get()` 等，见 README
