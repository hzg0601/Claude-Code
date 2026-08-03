# 工具系统

工具系统是 Claude Code 与外部环境交互的核心接口，提供文件操作、代码执行、网络通信等能力。

## 工具架构

```
┌─────────────────────────────────────────────────────────────┐
│                     Tool Layer                               │
├─────────────────────────────────────────────────────────────┤
│  Built-in Tools      │  MCP Tools       │  Custom Tools    │
│  - Read/Glob/Grep    │  - Server Tools  │  - Skills        │
│  - Bash/Edit/Write   │  - Resources     │  - Workflows     │
│  - Agent/Task*       │  - Prompts       │  - Extensions    │
├─────────────────────────────────────────────────────────────┤
│  Permission Layer    │  Safety          │  Rate Limiting   │
│  - Allow/Deny        │  - Validation    │  - Budget        │
│  - Always Ask        │  - Guardrails    │  - Quotas        │
└─────────────────────────────────────────────────────────────┘
```

## 内置工具分类

### 读取工具 (Read-only)

| 工具 | 描述 | 风险等级 |
|------|------|----------|
| `Read` | 读取文件内容 | 低 |
| `Glob` | 文件模式匹配 | 低 |
| `Grep` | 内容搜索 | 低 |
| `Agent` (Explore) | 只读代理 | 低 |

### 写入工具 (Write-enabled)

| 工具 | 描述 | 风险等级 |
|------|------|----------|
| `Write` | 创建/覆盖文件 | 高 |
| `Edit` | 编辑文件内容 | 高 |
| `NotebookEdit` | 编辑 Jupyter 单元格 | 高 |

### 执行工具 (Execution)

| 工具 | 描述 | 风险等级 |
|------|------|----------|
| `Bash` | 执行 shell 命令 | 高 |
| `PowerShell` | 执行 PowerShell 命令 | 高 |

### 编排工具 (Orchestration)

| 工具 | 描述 | 风险等级 |
|------|------|----------|
| `Agent` | 启动子代理 | 中 |
| `TaskCreate` | 创建任务 | 低 |
| `TaskUpdate` | 更新任务 | 低 |
| `Workflow` | 执行工作流 | 中 |

## 工具接口定义

### 基础接口

```typescript
// 工具定义
interface Tool {
  name: string
  description: string
  inputSchema: JSONSchema
  
  // 执行
  execute(params: Record<string, unknown>): Promise<ToolResult>
  
  // 权限
  requiredPermission?: PermissionLevel
  alwaysAsk?: boolean
}

// 工具结果
interface ToolResult {
  success: boolean
  output?: string
  error?: string
  metadata?: Record<string, unknown>
}
```

### 工具注册

```typescript
// 工具注册表
class ToolRegistry {
  private tools: Map<string, Tool> = new Map()
  
  // 注册工具
  register(tool: Tool): void {
    this.tools.set(tool.name, tool)
  }
  
  // 获取工具
  getTool(name: string): Tool | undefined {
    return this.tools.get(name)
  }
  
  // 列出所有工具
  listTools(): Tool[] {
    return Array.from(this.tools.values())
  }
}
```

## 内置工具详解

### Read 工具

```typescript
// Read 工具参数
interface ReadParams {
  file_path: string      // 绝对路径
  offset?: number        // 起始行号
  limit?: number         // 最大行数
  pages?: string         // PDF 页码范围 "1-5"
}

// 使用示例
const content = await Read({
  file_path: '/path/to/file.ts',
  offset: 0,
  limit: 100
})
```

### Glob 工具

```typescript
// Glob 工具参数
interface GlobParams {
  pattern: string        // Glob 模式
  path?: string          // 搜索目录
}

// 使用示例
const files = await Glob({
  pattern: '**/*.ts',
  path: '/src'
})
```

### Grep 工具

```typescript
// Grep 工具参数
interface GrepParams {
  pattern: string        // 正则表达式
  path?: string          // 搜索目录
  type?: string          // 文件类型
  glob?: string          // Glob 过滤
  output_mode?: 'content' | 'files_with_matches' | 'count'
  -n?: boolean           // 显示行号
  -i?: boolean           // 忽略大小写
}

// 使用示例
const matches = await Grep({
  pattern: 'function\\s+\\w+',
  type: 'ts',
  output_mode: 'content',
  -n: true
})
```

### Bash 工具

```typescript
// Bash 工具参数
interface BashParams {
  command: string        // 命令
  description?: string   // 描述
  timeout?: number       // 超时 (ms)
  run_in_background?: boolean
}

// 使用示例
const result = await Bash({
  command: 'git status',
  description: 'Show working tree status',
  timeout: 30000
})
```

### Write 工具

```typescript
// Write 工具参数
interface WriteParams {
  file_path: string      // 绝对路径
  content: string        // 文件内容
}

// 使用示例
await Write({
  file_path: '/path/to/file.ts',
  content: 'export const hello = "world"'
})
```

### Edit 工具

```typescript
// Edit 工具参数
interface EditParams {
  file_path: string      // 绝对路径
  old_string: string     // 要替换的内容
  new_string: string     // 替换后的内容
  replace_all?: boolean  // 替换所有匹配
}

// 使用示例
await Edit({
  file_path: '/path/to/file.ts',
  old_string: 'const x = 1',
  new_string: 'const x = 2'
})
```

### Agent 工具

```typescript
// Agent 工具参数
interface AgentParams {
  description: string    // 任务描述
  prompt: string         // 提示词
  subagent_type?: string // 代理类型
  run_in_background?: boolean
  model?: string         // 模型覆盖
}

// 使用示例
const result = await Agent({
  description: 'Code review',
  subagent_type: 'code-reviewer',
  prompt: 'Review this code for security issues'
})
```

## MCP 工具集成

### 工具发现

```typescript
// MCP 工具发现
async function discoverMCPTools(): Promise<Tool[]> {
  const servers = await listMCPServers()
  const tools: Tool[] = []
  
  for (const server of servers) {
    const serverTools = await callMCP(server.id, 'tools/list')
    
    for (const tool of serverTools) {
      tools.push({
        name: `mcp__${server.id}__${tool.name}`,
        description: tool.description,
        inputSchema: tool.inputSchema,
        requiredPermission: 'medium'
      })
    }
  }
  
  return tools
}
```

### 工具调用

```typescript
// 调用 MCP 工具
async function callMCPTool(
  serverId: string,
  toolName: string,
  params: Record<string, unknown>
): Promise<ToolResult> {
  // 权限检查
  if (!isToolAllowed(serverId, toolName)) {
    throw new PermissionDeniedError(toolName)
  }
  
  // 调用
  const result = await callMCP(serverId, 'tools/call', {
    name: toolName,
    arguments: params
  })
  
  return {
    success: !result.isError,
    output: result.content,
    error: result.isError ? result.message : undefined
  }
}
```

## 权限检查

### 工具权限级别

```typescript
enum PermissionLevel {
  LOW = 'low',           // 无需确认
  MEDIUM = 'medium',     // 通道允许即可
  HIGH = 'high'          // 总是询问
}

// 工具权限分类
const TOOL_PERMISSIONS: Record<string, PermissionLevel> = {
  'Read': PermissionLevel.LOW,
  'Glob': PermissionLevel.LOW,
  'Grep': PermissionLevel.LOW,
  
  'Bash': PermissionLevel.HIGH,
  'Write': PermissionLevel.HIGH,
  'Edit': PermissionLevel.HIGH,
  'NotebookEdit': PermissionLevel.HIGH,
  
  'Agent': PermissionLevel.MEDIUM,
  'TaskCreate': PermissionLevel.LOW
}
```

### 权限检查流程

```typescript
// 检查工具权限
function checkToolPermission(
  channel: string,
  toolName: string
): PermissionResult {
  const perms = getChannelPermissions(channel)
  
  // 1. 检查拒绝列表
  if (perms.deniedTools.has(toolName)) {
    return { allowed: false, reason: 'denied' }
  }
  
  // 2. 检查允许列表
  if (perms.allowedTools.has(toolName)) {
    return { allowed: true, reason: 'allowed' }
  }
  
  // 3. 检查是否需要询问
  if (perms.alwaysAskTools.has(toolName)) {
    return { allowed: false, reason: 'ask', requiresConfirmation: true }
  }
  
  // 4. 默认允许 (低风险工具)
  if (TOOL_PERMISSIONS[toolName] === PermissionLevel.LOW) {
    return { allowed: true }
  }
  
  // 5. 需要询问
  return { allowed: false, reason: 'ask', requiresConfirmation: true }
}
```

## 安全检查

### Bash 命令验证

```typescript
// 危险模式检测
const DANGEROUS_PATTERNS = [
  /^rm\s+(-rf|--recursive)/,      // 递归删除
  /^dd\s+/,                        // 磁盘写入
  /^mkfs/,                         // 格式化
  /:\(\)\{.*\}/,                  // Fork bomb
  /\/dev\/[hs]d[a-z]/,            // 直接磁盘访问
  /chmod\s+[0-7]*777/,            // 过度权限
  /curl.*\|\s*(ba)?sh/,           // 远程执行
  /wget.*\|\s*(ba)?sh/,           // 远程执行
]

function validateBashCommand(command: string): SafetyValidation {
  const violations: string[] = []
  
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      violations.push(`Dangerous pattern: ${pattern}`)
    }
  }
  
  return {
    safe: violations.length === 0,
    violations,
    requiresConfirmation: violations.length > 0
  }
}
```

### 写操作验证

```typescript
// 写操作安全检查
interface WriteSafetyCheck {
  isPathSafe: boolean      // 路径在允许目录内
  isExcluded: boolean      // 是否在 .gitignore 中
  isBinary: boolean        // 是否二进制文件
  isCritical: boolean      // 是否关键文件
  containsSecrets: boolean // 是否包含密钥
}

async function validateWriteOperation(
  filePath: string,
  content: string
): Promise<WriteSafetyCheck> {
  return {
    isPathSafe: isPathWithinAllowedDirs(filePath),
    isExcluded: !isExcludedByGitignore(filePath),
    isBinary: await isBinaryFile(filePath),
    isCritical: isCriticalFile(filePath),
    containsSecrets: containsSecrets(content)
  }
}
```

## 工具编排

### 顺序执行

```typescript
// 顺序执行工具
const files = await Glob({ pattern: 'src/**/*.ts' })

for (const file of files) {
  const content = await Read({ file_path: file })
  const analysis = await analyzeCode(content)
  
  if (analysis.hasIssues) {
    await Edit({
      file_path: file,
      old_string: analysis.oldCode,
      new_string: analysis.newCode
    })
  }
}
```

### 并行执行

```typescript
// 并行读取多个文件
const contents = await Promise.all(
  files.map(f => Read({ file_path: f }))
)

// 并行执行独立任务
const [gitStatus, gitDiff, gitLog] = await Promise.all([
  Bash({ command: 'git status' }),
  Bash({ command: 'git diff' }),
  Bash({ command: 'git log --oneline -5' })
])
```

### 条件执行

```typescript
// 基于条件选择工具
if (needsExploration) {
  const findings = await Agent({
    description: 'Explore codebase',
    subagent_type: 'Explore',
    prompt: 'Find all API endpoints'
  })
  
  // 基于发现继续
  if (findings.length > 0) {
    await Write({
      file_path: 'docs/endpoints.md',
      content: formatFindings(findings)
    })
  }
}
```

## 错误处理

### 工具错误类型

```typescript
// 工具错误
class ToolError extends Error {
  constructor(
    message: string,
    public toolName: string,
    public code: ToolErrorCode
  ) {
    super(message)
    this.name = 'ToolError'
  }
}

type ToolErrorCode =
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'INVALID_PARAMS'
  | 'EXECUTION_FAILED'
  | 'RATE_LIMITED'
```

### 错误恢复

```typescript
// 带重试的工具调用
async function callWithRetry<T>(
  tool: string,
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxRetries = 3, backoff = 'exponential' } = options
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn()
    } catch (error) {
      if (error.code === 'PERMISSION_DENIED') {
        throw error  // 权限错误不重试
      }
      
      if (i === maxRetries - 1) {
        throw error
      }
      
      // 指数退避
      const delay = Math.pow(2, i) * 1000
      await sleep(delay)
    }
  }
  
  throw new Error('Unreachable')
}
```

## 最佳实践

### 工具选择

```typescript
// 优先使用专用工具
const files = await Glob({ pattern: '**/*.ts' })  // ✅ 优于 find
const content = await Read({ file_path: file })   // ✅ 优于 cat
const matches = await Grep({ pattern: 'foo' })    // ✅ 优于 grep
```

### 路径安全

```typescript
// 验证路径
function isSafePath(filePath: string, allowedDirs: string[]): boolean {
  const resolved = path.resolve(filePath)
  
  for (const dir of allowedDirs) {
    if (resolved.startsWith(path.resolve(dir))) {
      return true
    }
  }
  
  return false
}
```

### 资源清理

```typescript
// 确保资源清理
async function withCleanup<T>(
  setup: () => Promise<T>,
  fn: (resource: T) => Promise<void>,
  cleanup: (resource: T) => Promise<void>
): Promise<void> {
  const resource = await setup()
  try {
    await fn(resource)
  } finally {
    await cleanup(resource)
  }
}

// 使用示例
await withCleanup(
  () => createTempFile(),
  async (file) => {
    await processFile(file)
  },
  async (file) => {
    await deleteFile(file)
  }
)
```

## 相关文档

- [权限系统](../technical/permissions.md) - 工具权限管理
- [MCP 协议](../technical/mcp.md) - MCP 工具集成
- [代理系统](../modules/agents.md) - Agent 工具使用
