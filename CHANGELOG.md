# Changelog

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
