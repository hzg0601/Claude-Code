# 工具系统

Claude Code 的工具系统提供了与外部世界交互的能力，包括文件操作、命令执行、网络请求、代理调用等。

## 工具架构

### 工具接口定义

所有工具都实现了统一的 `Tool` 接口：

```typescript
interface Tool {
  // 工具唯一标识
  name: string
  
  // 工具描述（发送给 AI 模型）
  description: string
  
  // 输入参数 JSON Schema
  input_schema: ToolInputJSONSchema
  
  // 工具是否可用
  isEnabled(): boolean
  
  // 执行工具
  execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResponse>
}
```

### 工具注册

工具在 `tools.ts` 中统一注册和管理：

```typescript
// 工具注册示例
export function getAllBaseTools(): Tools {
  return [
    AgentTool,
    BashTool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    GlobTool,
    GrepTool,
    // ... 更多工具
  ]
}
```

## 内置工具分类

### 1. 文件操作工具

| 工具 | 描述 | 主要方法 |
|------|------|----------|
| `FileReadTool` | 读取文件内容 | `readFile()` |
| `FileEditTool` | 编辑文件（查找替换） | `editFile()` |
| `FileWriteTool` | 写入新文件 | `writeFile()` |
| `NotebookEditTool` | 编辑 Jupyter Notebook | `editNotebook()` |

### 2. 搜索工具

| 工具 | 描述 | 特点 |
|------|------|------|
| `GlobTool` | 文件路径匹配 | 支持 glob 模式 |
| `GrepTool` | 内容搜索 | 支持正则表达式 |
| `ToolSearchTool` | 工具搜索 | 查找可用工具 |

### 3. 执行工具

| 工具 | 描述 | 特性 |
|------|------|------|
| `BashTool` | 执行 shell 命令 | 支持超时、工作目录 |
| `PowerShellTool` | 执行 PowerShell 命令 | Windows 专用 |
| `TaskCreateTool` | 创建任务 | 任务跟踪 |
| `TaskGetTool` | 获取任务状态 | - |
| `TaskUpdateTool` | 更新任务 | - |
| `TaskListTool` | 列出所有任务 | - |
| `TaskStopTool` | 停止任务执行 | - |
| `TaskOutputTool` | 获取任务输出 | - |

### 4. 网络工具

| 工具 | 描述 | 用途 |
|------|------|------|
| `WebFetchTool` | 抓取网页内容 | 读取 URL 内容 |
| `WebSearchTool` | Web 搜索 | 搜索互联网信息 |

### 5. 代理和工具

| 工具 | 描述 | 子代理类型 |
|------|------|-----------|
| `AgentTool` | 调用子代理 | Explore, Plan, Code-Reviewer 等 |
| `SkillTool` | 执行技能 | 预定义技能模板 |
| `WorkflowTool` | 执行工作流 | 多代理编排 |

### 6. 交互工具

| 工具 | 描述 |
|------|------|
| `AskUserQuestionTool` | 向用户提问 |
| `ExitPlanModeV2Tool` | 退出计划模式 |
| `EnterPlanModeTool` | 进入计划模式 |

### 7. 开发工具

| 工具 | 描述 |
|------|------|
| `ConfigTool` | 配置管理（Ant 专属） |
| `TungstenTool` | Tungsten 调试（Ant 专属） |
| `LSPTool` | 语言服务器协议 |
| `ListMcpResourcesTool` | 列出 MCP 资源 |
| `ReadMcpResourceTool` | 读取 MCP 资源 |

### 8. 会话工具

| 工具 | 描述 |
|------|------|
| `BriefTool` | 生成会话摘要 |
| `SnipTool` | 历史快照 |
| `SendUserFileTool` | 发送文件给用户 |
| `PushNotificationTool` | 推送通知 |

### 9. 工作区工具

| 工具 | 描述 |
|------|------|
| `EnterWorktreeTool` | 进入工作树 |
| `ExitWorktreeTool` | 退出工作树 |
| `TodoWriteTool` | 写入待办事项 |

### 10. 条件加载工具

根据功能标志动态加载：

```typescript
// 功能标志控制的工具
const SleepTool = feature('PROACTIVE') || feature('KAIROS')
  ? require('./tools/SleepTool/SleepTool.js').SleepTool
  : null

const cronTools = feature('AGENT_TRIGGERS')
  ? [CronCreateTool, CronDeleteTool, CronListTool]
  : []

const MonitorTool = feature('MONITOR_TOOL')
  ? require('./tools/MonitorTool/MonitorTool.js').MonitorTool
  : null
```

## 工具执行流程

```
模型请求工具调用
        ↓
工具名称匹配
        ↓
权限检查 (PermissionContext)
        ↓
    ┌───┴───┐
    │       │
  允许    拒绝
    │       │
    ↓       ↓
执行工具  返回错误
    │
    ↓
结果处理
    │
    ├─→ 成功 → 返回结果
    │
    └─→ 失败 → 错误处理
```

## 工具权限系统

### 权限上下文

```typescript
interface ToolPermissionContext {
  mode: PermissionMode  // 'default' | 'auto' | 'bypass'
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
  alwaysAllowRules: ToolPermissionRulesBySource
  alwaysDenyRules: ToolPermissionRulesBySource
  alwaysAskRules: ToolPermissionRulesBySource
}
```

### 工具过滤

```typescript
// 根据拒绝规则过滤工具
export function filterToolsByDenyRules<T extends { name: string }>(
  tools: readonly T[],
  permissionContext: ToolPermissionContext
): T[] {
  return tools.filter(tool => 
    !getDenyRuleForTool(permissionContext, tool)
  )
}
```

### MCP 工具前缀规则

MCP 服务器工具使用前缀匹配：

```typescript
// MCP 工具名称格式：mcp__server__tool
// 拒绝规则：mcp__server  → 拒绝该服务器所有工具
```

## 工具实现示例

### BashTool

```typescript
export class BashTool implements Tool {
  name = 'Bash'
  description = '执行 bash 命令'
  
  input_schema = {
    type: 'object',
    properties: {
      command: { type: 'string' },
      working_directory: { type: 'string' },
      timeout: { type: 'number' }
    },
    required: ['command']
  }
  
  async execute(params, context) {
    const { command, working_directory, timeout } = params
    // 执行命令逻辑
    return { output, exitCode }
  }
}
```

### FileReadTool

```typescript
export class FileReadTool implements Tool {
  name = 'Read'
  description = '读取文件内容'
  
  input_schema = {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      limit: { type: 'number' },
      offset: { type: 'number' }
    },
    required: ['file_path']
  }
  
  async execute(params, context) {
    const { file_path, limit, offset } = params
    // 读取文件逻辑
    return { content }
  }
}
```

## 工具启用状态

工具可以通过 `isEnabled()` 方法控制是否可用：

```typescript
// 条件启用示例
const isPowerShellToolEnabled = () => {
  return process.env.ENABLE_POWERSHELL_TOOL === 'true'
}

const hasEmbeddedSearchTools = () => {
  // 检查是否有嵌入的搜索工具
}
```

## REPL 模式工具

REPL 模式使用简化的工具集：

```typescript
const REPL_ONLY_TOOLS = new Set([
  'Bash',
  'Read', 
  'Edit',
  'Write'
])

// REPL 模式下隐藏原始工具
if (isReplModeEnabled()) {
  allowedTools = allowedTools.filter(
    tool => !REPL_ONLY_TOOLS.has(tool.name)
  )
}
```

## 简单模式

简单模式只提供最基础的工具：

```typescript
if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
  const simpleTools: Tool[] = [
    BashTool,
    FileReadTool,
    FileEditTool
  ]
  // 可选：添加 AgentTool 和 TaskStopTool
  if (feature('COORDINATOR_MODE')) {
    simpleTools.push(AgentTool, TaskStopTool)
  }
  return simpleTools
}
```

## 工具缓存策略

### 系统提示缓存

工具列表排序后缓存以保持一致性：

```typescript
// 工具排序（用于缓存键稳定性）
const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
return uniqBy(
  [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
  'name'
)
```

### MCP 工具缓存

MCP 服务器工具列表被缓存以避免重复获取。

## 工具发现

### 工具搜索

```typescript
// 工具搜索启用检查
export function isToolSearchEnabledOptimistic(): boolean {
  // 检查工具搜索是否应该启用
}
```

### MCP 工具发现

通过 MCP 协议自动发现外部工具：

```typescript
// MCP 工具发现
const mcpTools = await mcpClient.listTools()
```

## 最佳实践

### 添加工具

1. 在 `tools/` 目录创建新工具类
2. 继承 `Tool` 基类或使用工具构建器
3. 实现必需的方法和属性
4. 在 `tools.ts` 中注册
5. 添加测试用例

### 工具命名

- 使用描述性名称（如 `FileReadTool`, `WebSearchTool`）
- 遵循 PascalCase 命名约定
- 避免与现有工具名称冲突

### 错误处理

```typescript
try {
  const result = await tool.execute(params, context)
  return { success: true, result }
} catch (error) {
  return { 
    success: false, 
    error: error.message 
  }
}
```

### 测试

```typescript
describe('BashTool', () => {
  it('should execute simple commands', async () => {
    const tool = new BashTool()
    const result = await tool.execute({ command: 'echo hello' })
    expect(result.output).toBe('hello\n')
  })
})
```

## 相关文档

- [架构设计](../architecture.md) - 系统架构
- [命令系统](./commands.md) - 命令系统文档
- [API 参考](../api/tools.md) - 工具 API 接口
- [MCP 协议](../technical/mcp.md) - MCP 工具集成
