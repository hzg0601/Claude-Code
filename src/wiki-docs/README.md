# Claude Code 项目知识文档

欢迎来到 Claude Code 项目的知识库。本文档提供了项目架构、核心模块、工具系统和服务的全面概述。

## 文档导航

### 核心文档
- [项目概述](./overview.md) - 项目简介和整体架构
- [快速开始](./getting-started.md) - 开发环境设置和构建指南
- [架构设计](./architecture.md) - 系统架构和模块关系

### 模块文档
- [命令系统](./modules/commands.md) - CLI 命令和 slash 命令系统
- [工具系统](./modules/tools.md) - 工具定义、注册和执行机制
- [技能系统](./modules/skills.md) - 技能定义和使用方法
- [服务层](./modules/services.md) - 核心服务和业务逻辑
- [组件系统](./modules/components.md) - UI 组件和交互系统
- [代理系统](./modules/agents.md) - Agent 定义和编排机制

### 技术文档
- [MCP 协议](./technical/mcp.md) - Model Context Protocol 实现
- [Bash 工具深度拆解](./technical/bash-tool.md) - Schema、权限、沙箱、执行与结果映射完整链路
- [Claude Code Skill 机制完全解析](./technical/Claude%20Code%20Skill%20机制完全解析.md) - Skill 定义/来源/发现匹配/注入执行全链路（含源码与字段表格）
- [Claude Code Skill 机制逻辑解析](./technical/Claude%20Code%20Skill%20机制逻辑解析.md) - 只讲逻辑：Skill 链路、概念、关系与设计意图
- [远程会话](./technical/remote-sessions.md) - 远程会话和桥接机制
- [权限系统](./technical/permissions.md) - 工具权限和用户授权
- [遥测和分析](./technical/telemetry.md) - 使用追踪和指标收集

### API 参考
- [工具 API](./api/tools.md) - 内置工具接口文档
- [命令 API](./api/commands.md) - 命令注册和执行 API
- [服务 API](./api/services.md) - 服务层接口文档

---

**最后更新**: 2026-06-25
**项目版本**: Claude Code Source
