# 系统架构

## 架构总览

Claude Code 采用分层架构设计，从用户界面到基础设施共分为五个层次：

```
┌─────────────────────────────────────────────────────────────┐
│                    Presentation Layer                        │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐    │
│  │ Ink UI      │  │ Components   │  │ Interactive     │    │
│  │ (Terminal)  │  │ (React)      │  │ Helpers         │    │
│  └─────────────┘  └──────────────┘  └─────────────────┘    │
├─────────────────────────────────────────────────────────────┤
│                    Application Layer                         │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐    │
│  │ QueryEngine │  │ Commands     │  │ Skills          │    │
│  │             │  │ (Slash/Local)│  │ (Templates)     │    │
│  └─────────────┘  └──────────────┘  └─────────────────┘    │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐    │
│  │ Agents      │  │ Tasks        │  │ Workflows       │    │
│  └─────────────┘  └──────────────┘  └─────────────────┘    │
├─────────────────────────────────────────────────────────────┤
│                    Service Layer                             │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐    │
│  │ MCP Client  │  │ Analytics    │  │ OAuth           │    │
│  └─────────────┘  └──────────────┘  └─────────────────┘    │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐    │
│  │ Plugins     │  │ Settings     │  │ Skills Search   │    │
│  └─────────────┘  └──────────────┘  └─────────────────┘    │
├─────────────────────────────────────────────────────────────┤
│                      Tool Layer                              │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐    │
│  │ Bash        │  │ File I/O     │  │ Search          │    │
│  └─────────────┘  └──────────────┘  └─────────────────┘    │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐    │
│  │ Web         │  │ Agent        │  │ MCP Tools       │    │
│  └─────────────┘  └──────────────┘  └─────────────────┘    │
├─────────────────────────────────────────────────────────────┤
│                  Infrastructure Layer                        │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐    │
│  │ State Mgmt  │  │ History      │  │ Telemetry       │    │
│  └─────────────┘  └──────────────┘  └─────────────────┘    │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐    │
│  │ Feature     │  │ Remote       │  │ Bridge          │    │
│  │ Flags       │  │ Sessions      │  │                 │    │
│  └─────────────┘  └──────────────┘  └─────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## 核心组件

### 1. 入口点 (main.tsx)

应用启动和初始化的核心文件：

- **功能**: 设置 Ink 渲染上下文、注册全局状态、初始化服务
- **依赖**: commands.ts, tools.ts, bootstrap/state.ts, services/*
- **关键流程**:
  1. 加载 GrowthBook 功能标志
  2. 初始化引导数据（Bootstrap Data）
  3. 注册 MCP 工具和服务
  4. 设置远程管理配置
  5. 导入并注册所有命令
  6. 启动 Ink 渲染循环

### 2. 查询引擎 (QueryEngine.ts)

处理用户输入和查询路由：

- **功能**: 解析用户输入、识别命令类型、路由到正确的处理器
- **输入**: 用户文本输入、Slash 命令、文件上传
- **输出**: 工具调用、命令执行、代理响应

### 3. 工具系统 (Tool.ts)

所有工具的基类和接口定义：

```typescript
// 工具接口核心结构
interface Tool {
  name: string
  description: string
  parameters: JSON Schema
  execute: (params: object, context: ToolContext) => Promise<ToolResponse>
  isEnabled: () => boolean
}
```

### 4. 状态管理 (bootstrap/state.ts)

全局应用状态：

- **originalCwd**: 原始工作目录
- **projectRoot**: 项目根目录
- **totalCostUSD**: 累计 API 成本
- **modelUsage**: 各模型使用统计
- **sessionId**: 当前会话 ID
- **Telemetry**: 使用指标（会话数、LOC、PR 数、提交数、成本、Token）

## 模块依赖关系

```
main.tsx
├── commands.ts (命令注册)
│   └── commands/* (具体命令实现)
├── tools.ts (工具注册)
│   └── tools/* (具体工具实现)
├── bootstrap/state.ts (状态初始化)
├── services/* (服务层)
│   ├── mcp/client.ts (MCP 客户端)
│   ├── analytics/* (分析服务)
│   ├── oauth/* (认证服务)
│   └── plugins/* (插件管理)
└── components/* (UI 组件)
    ├── screens/* (屏幕组件)
    └── interactiveHelpers.tsx (交互辅助)
```

## 数据流

### 请求处理流程

```
用户输入
    ↓
命令解析 (QueryEngine)
    ↓
    ├─→ Slash 命令 → 命令处理器 → 工具执行
    ├─→ 本地命令 → 命令处理器 → 结果返回
    └─→ 自然语言 → 代理系统 → 工具编排
                                  ↓
                            状态更新 ←→ 服务层
                                  ↓
                            历史记录
                                  ↓
                            UI 渲染 (Ink)
```

### 工具执行流程

```
工具调用请求
    ↓
权限检查 (PermissionContext)
    ↓
    ├─→ 允许 → 执行工具 → 返回结果
    └─→ 拒绝 → 抛出错误 → 用户提示
```

## 扩展机制

### 添加新工具

1. 在 `tools/` 目录创建新工具类，继承 `Tool` 基类
2. 实现 `name`, `description`, `parameters`, `execute` 方法
3. 在 `tools.ts` 中导入并注册到 `getAllBaseTools()`
4. 根据需要添加功能标志控制（`feature('FLAG_NAME')`）

### 添加新命令

1. 在 `commands/` 目录创建命令模块
2. 实现命令处理器函数
3. 在 `commands.ts` 中注册（Slash 命令或本地命令）
4. 根据需要添加功能标志控制

### 添加新技能

1. 在 `skills/` 目录创建技能定义文件
2. 包含元数据（名称、描述、参数）和实现
3. 技能自动被发现和加载

### 添加新代理

1. 在 `components/agents/` 目录定义代理配置
2. 设置代理行为、工具白名单/黑名单
3. 配置代理间的协作关系

## 配置系统

### 功能标志 (Feature Flags)

使用 GrowthBook 进行功能标志管理：

```typescript
// 功能标志使用示例
if (feature('COORDINATOR_MODE')) {
  // 协调器模式功能
}

if (feature('KAIROS')) {
  // Kairos 功能
}
```

### 环境变量

```bash
# 用户类型
USER_TYPE=ant

# 功能启用
CLAUDE_CODE_SIMPLE=true
ENABLE_LSP_TOOL=true
MONITOR_TOOL=true

# 验证模式
CLAUDE_CODE_VERIFY_PLAN=true
```

## 安全模型

### 权限控制

- **ToolPermissionContext**: 工具权限上下文
- **Deny Rules**: 工具拒绝规则（支持通配符和 MCP 服务器前缀）
- **User Authorization**: 用户授权检查

### 工具过滤

```typescript
// 工具过滤流程
1. 获取所有基础工具 (getAllBaseTools)
2. 根据权限上下文过滤 (filterToolsByDenyRules)
3. 根据模式过滤 (REPL 模式、简单模式等)
4. 根据启用状态过滤 (isEnabled())
5. 合并 MCP 工具 (assembleToolPool)
```

## 性能优化

### 工具缓存

- **系统提示缓存**: 工具列表排序后缓存以保持一致性
- **MCP 工具缓存**: MCP 服务器工具列表缓存
- **技能缓存**: 技能搜索结果缓存

### 懒加载

- 条件加载工具（根据功能标志和用户类型）
- 循环依赖模块使用懒加载（`require()` 在函数内）

## 测试策略

### 单元测试

- 工具测试：`tools/*/index.test.ts`
- 命令测试：`commands/*/index.test.ts`
- 服务测试：`services/*/index.test.ts`

### 集成测试

- CLI 集成测试
- MCP 集成测试
- 远程会话测试

### E2E 测试

- 用户交互流程
- 多代理协作场景
- 长时间运行任务

## 相关文档

- [项目概述](./overview.md) - 项目简介和核心特性
- [工具系统](./modules/tools.md) - 工具开发和注册机制
- [命令系统](./modules/commands.md) - 命令系统和交互设计
- [MCP 协议](./technical/mcp.md) - MCP 协议实现细节
