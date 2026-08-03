# 项目概述

## 什么是 Claude Code

Claude Code 是一个基于 Anthropic Claude API 的命令行智能助手项目，通过 MCP（Model Context Protocol）协议与各种工具和服务集成，提供代码理解、文件操作、任务管理、技能执行等能力。

## 核心特性

### 1. 工具系统
- **文件操作工具**: 读取、写入、编辑文件
- **搜索工具**: 全局搜索 (Grep)、文件匹配 (Glob)
- **执行工具**: Bash 命令执行、任务管理
- **网络工具**: Web 搜索、网页抓取
- **MCP 工具**: 通过 MCP 协议连接外部服务

### 2. 命令系统
- **Slash 命令**: 以 `/` 开头的交互式命令
- **本地命令**: 直接执行的 CLI 命令
- **技能命令**: 通过技能系统扩展的命令

### 3. 代理系统
- **内置代理**: 预定义的专用代理（Explore、Plan、Code Reviewer 等）
- **自定义代理**: 用户可创建和配置自定义代理
- **代理编排**: 支持多代理协作和任务分解

### 4. 技能系统
- **内置技能**: 预定义的技能模板
- **自定义技能**: 用户可创建和注册技能
- **技能发现**: 自动发现和加载技能

## 项目结构

```
src/
├── main.tsx                 # 主入口文件
├── commands.ts              # 命令注册和导出
├── tools.ts                 # 工具注册和导出
├── QueryEngine.ts           # 查询引擎
├── Task.ts                  # 任务定义
├── Tool.ts                  # 工具接口定义
├── context.ts               # 上下文管理
├── history.ts               # 会话历史
├── interactiveHelpers.tsx   # 交互辅助组件
│
├── assistant/               # 助手会话模块
├── bootstrap/               # 启动引导模块
├── bridge/                  # 桥接通信模块
├── buddy/                   # 伙伴系统模块
├── cli/                     # CLI 核心模块
├── commands/                # 命令实现目录
├── components/              # React UI 组件
├── constants/               # 常量定义
├── coordinator/             # 协调器模块
├── entrypoints/             # 入口点定义
├── hooks/                   # React Hooks
├── ink/                     # Ink 渲染引擎
├── jobs/                    # 后台任务
├── keybindings/             # 快捷键绑定
├── memdir/                  # 内存目录管理
├── migrations/              # 数据迁移
├── native-ts/               # Native 模块
├── plugins/                 # 插件系统
├── proactive/               # 主动建议模块
├── query/                   # 查询处理
├── remote/                  # 远程功能
├── schemas/                 # 数据模式
├── screens/                 # 屏幕组件
├── server/                  # 服务器模块
├── services/                # 服务层
├── skills/                  # 技能定义
├── ssh/                     # SSH 功能
├── state/                   # 状态管理
├── tasks/                   # 任务系统
├── tools/                   # 工具实现
├── types/                   # TypeScript 类型
├── utils/                   # 工具函数
├── vim/                     # Vim 模式
└── voice/                   # 语音模式
```

## 技术栈

- **运行时**: Node.js / Bun
- **语言**: TypeScript
- **UI 框架**: React + Ink (终端 UI)
- **协议**: MCP (Model Context Protocol)
- **AI**: Anthropic Claude API

## 核心模块说明

### 入口点 (entrypoints/)
定义应用的启动流程和初始化逻辑。

### 桥接层 (bridge/)
处理远程会话、消息传递和状态同步。

### 命令行界面 (cli/)
实现核心 CLI 功能，包括输入处理、输出渲染和传输层。

### 命令 (commands/)
包含所有 slash 命令和本地命令的实现。

### 组件 (components/)
React 组件库，包括 UI 组件、对话框、列表等。

### 服务 (services/)
业务逻辑层，包括：
- 分析服务 (analytics)
- MCP 客户端
- OAuth 认证
- 插件管理
- 设置同步
- 技能搜索

### 工具 (tools/)
实现所有内置工具，如 Bash、文件操作、搜索等。

### 工具函数 (utils/)
通用工具函数和辅助模块。

## 数据流

```
用户输入 → 命令解析 → 查询引擎 → 工具执行 → 结果渲染
                ↓
            状态管理 ←→ 服务层
                ↓
            历史记录
```

## 扩展机制

### 添加新命令
在 `commands/` 目录创建新模块，并在 `commands.ts` 中注册。

### 添加新工具
在 `tools/` 目录实现工具类，继承 `Tool` 基类，并在 `tools.ts` 中注册。

### 添加新技能
在 `skills/` 目录创建技能定义文件，包含元数据和实现。

### 添加新代理
在 `components/agents/` 目录定义代理配置和行为。

## 相关文档

- [架构设计](./architecture.md) - 详细的系统架构
- [快速开始](./getting-started.md) - 开发和构建指南
- [工具系统](./modules/tools.md) - 工具开发指南
