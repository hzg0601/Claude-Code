# 命令系统

命令系统提供用户与 Claude Code 交互的接口，包括斜杠命令、快捷键和自然语言指令。

## 命令架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Command Layer                              │
├─────────────────────────────────────────────────────────────┤
│  Slash Commands     │  Keyboard       │  Natural Language  │
│  - /help            │  - Ctrl+C       │  - "create a file"  │
│  - /compact         │  - Ctrl+D       │  - "explain this"   │
│  - /skills          │  - Ctrl+T       │  - "run the tests"  │
├─────────────────────────────────────────────────────────────┤
│  Command Registry   │  Permission     │  Hook System       │
│  - Registration     │  - Auth Check   │  - Pre/Post Hooks  │
│  - Discovery        │  - Rate Limit   │  - Event Bus       │
└─────────────────────────────────────────────────────────────┘
```

## 斜杠命令

### 内置命令

```typescript
// 命令定义
interface SlashCommand {
  name: string
  description: string
  handler: (args: string[]) => Promise<void>
  permissions?: PermissionLevel
  aliases?: string[]
}

// 内置命令列表
const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    name: 'help',
    description: '显示帮助信息',
    handler: showHelp
  },
  {
    name: 'compact',
    description: '压缩会话上下文',
    handler: compactContext
  },
  {
    name: 'skills',
    description: '列出可用技能',
    handler: listSkills
  },
  {
    name: 'clear',
    description: '清除当前会话',
    handler: clearSession
  }
]
```

### 命令注册

```typescript
// 命令注册表
class CommandRegistry {
  private commands: Map<string, SlashCommand> = new Map()
  
  // 注册命令
  register(command: SlashCommand): void {
    this.commands.set(command.name, command)
    
    // 注册别名
    if (command.aliases) {
      for (const alias of command.aliases) {
        this.commands.set(alias, command)
      }
    }
  }
  
  // 获取命令
  getCommand(name: string): SlashCommand | undefined {
    return this.commands.get(name)
  }
  
  // 列出所有命令
  listCommands(): SlashCommand[] {
    return Array.from(this.commands.values())
  }
  
  // 执行命令
  async execute(name: string, args: string[]): Promise<void> {
    const command = this.getCommand(name)
    
    if (!command) {
      throw new CommandNotFoundError(name)
    }
    
    // 权限检查
    if (!await this.checkPermission(command)) {
      throw new PermissionDeniedError(`Insufficient permission for /${name}`)
    }
    
    await command.handler(args)
  }
}
```

### 命令发现

```typescript
// 命令发现 API
interface CommandDiscovery {
  // 搜索命令
  searchCommands(query: string): SlashCommand[]
  
  // 获取命令详情
  getCommandHelp(name: string): CommandHelp
  
  // 自动补全
  autocomplete(prefix: string): string[]
}

// 命令帮助信息
interface CommandHelp {
  name: string
  description: string
  usage: string
  examples: string[]
  relatedCommands: string[]
}

// 使用示例
const help = getCommandHelp('compact')
console.log(`
  Command: /${help.name}
  Description: ${help.description}
  Usage: ${help.usage}
  
  Examples:
  ${help.examples.map(e => `  - ${e}`).join('\n')}
`)
```

## 键盘快捷键

### 内置快捷键

```typescript
// 快捷键定义
interface KeyboardShortcut {
  key: string
  description: string
  handler: () => void
  context?: 'input' | 'output' | 'always'
}

// 默认快捷键
const DEFAULT_SHORTCUTS: KeyboardShortcut[] = [
  {
    key: 'Ctrl+C',
    description: '中断当前操作',
    handler: interruptCurrentTask,
    context: 'always'
  },
  {
    key: 'Ctrl+D',
    description: '确认/发送',
    handler: submitInput,
    context: 'input'
  },
  {
    key: 'Ctrl+T',
    description: '切换任务面板',
    handler: toggleTaskPanel,
    context: 'always'
  },
  {
    key: 'Ctrl+K',
    description: '命令面板',
    handler: openCommandPalette,
    context: 'always'
  },
  {
    key: 'Escape',
    description: '取消/关闭',
    handler: cancelOrClose,
    context: 'always'
  }
]
```

### 快捷键注册

```typescript
// 快捷键管理器
class ShortcutManager {
  private shortcuts: Map<string, KeyboardShortcut> = new Map()
  
  register(shortcut: KeyboardShortcut): void {
    this.shortcuts.set(shortcut.key, shortcut)
  }
  
  handleKeyEvent(event: KeyboardEvent): void {
    const key = normalizeKeyEvent(event)
    const shortcut = this.shortcuts.get(key)
    
    if (shortcut) {
      // 检查上下文
      if (shortcut.context && !this.matchesContext(shortcut.context)) {
        return
      }
      
      shortcut.handler()
      event.preventDefault()
    }
  }
}

// 标准化键盘事件
function normalizeKeyEvent(event: KeyboardEvent): string {
  const parts: string[] = []
  
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.metaKey) parts.push('Meta')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  
  parts.push(event.key)
  
  return parts.join('+')
}
```

## 自然语言命令

### 命令解析

```typescript
// 自然语言命令解析
interface NLCommand {
  type: 'create' | 'explain' | 'run' | 'find' | 'fix'
  intent: string
  entities: Record<string, string>
  confidence: number
}

// 解析器
class NLCommandParser {
  parse(input: string): NLCommand | null {
    // 1. 意图分类
    const intent = this.classifyIntent(input)
    
    // 2. 实体抽取
    const entities = this.extractEntities(input, intent)
    
    // 3. 置信度评分
    const confidence = this.scoreConfidence(input, intent, entities)
    
    if (confidence < THRESHOLD) {
      return null
    }
    
    return { type: intent.type, intent, entities, confidence }
  }
  
  private classifyIntent(input: string): Intent {
    // 基于关键词和模式匹配
    if (/create|make|add/i.test(input)) {
      return { type: 'create', action: 'create' }
    }
    if (/explain|what|how/i.test(input)) {
      return { type: 'explain', action: 'explain' }
    }
    if (/run|execute|test/i.test(input)) {
      return { type: 'run', action: 'execute' }
    }
    
    return { type: 'unknown', action: 'unknown' }
  }
  
  private extractEntities(input: string, intent: Intent): Record<string, string> {
    const entities: Record<string, string> = {}
    
    // 提取文件路径
    const fileMatch = input.match(/['"]([^'"]+)['"]/)
    if (fileMatch) {
      entities.file = fileMatch[1]
    }
    
    // 提取命令
    if (intent.type === 'run') {
      const cmdMatch = input.match(/run\s+(.+)/i)
      if (cmdMatch) {
        entities.command = cmdMatch[1]
      }
    }
    
    return entities
  }
}
```

### 命令执行

```typescript
// 执行自然语言命令
async function executeNLCommand(command: NLCommand): Promise<void> {
  switch (command.type) {
    case 'create':
      await handleCreate(command)
      break
      
    case 'explain':
      await handleExplain(command)
      break
      
    case 'run':
      await handleRun(command)
      break
      
    case 'find':
      await handleFind(command)
      break
      
    case 'fix':
      await handleFix(command)
      break
      
    default:
      throw new Error(`Unknown command type: ${command.type}`)
  }
}

// 创建文件示例
async function handleCreate(command: NLCommand): Promise<void> {
  const { file, type } = command.entities
  
  if (!file) {
    throw new Error('No file specified')
  }
  
  // 使用 Agent 创建文件
  const result = await Agent({
    description: `Create ${type || 'file'}: ${file}`,
    prompt: `Create a new ${type || 'file'} at ${file} with appropriate content`
  })
  
  console.log(`Created: ${file}`)
}
```

## 钩子系统

### 钩子注册

```typescript
// 钩子类型
type HookType = 
  | 'pre:command'
  | 'post:command'
  | 'pre:tool'
  | 'post:tool'
  | 'pre:compact'
  | 'post:compact'

// 钩子处理器
interface HookHandler {
  type: HookType
  handler: (context: HookContext) => Promise<HookResult>
  priority?: number  // 高优先级先执行
}

// 钩子注册表
class HookRegistry {
  private hooks: Map<HookType, HookHandler[]> = new Map()
  
  register(handler: HookHandler): void {
    const hooks = this.hooks.get(handler.type) || []
    hooks.push(handler)
    hooks.sort((a, b) => (b.priority || 0) - (a.priority || 0))
    this.hooks.set(handler.type, hooks)
  }
  
  async execute(type: HookType, context: HookContext): Promise<HookContext> {
    const handlers = this.hooks.get(type) || []
    
    for (const handler of handlers) {
      const result = await handler.handler(context)
      
      if (result.abort) {
        throw new HookAbortError(`Hook ${handler.type} aborted the operation`)
      }
      
      // 合并结果到上下文
      Object.assign(context, result.updates)
    }
    
    return context
  }
}
```

### 钩子示例

```typescript
// Pre-compact 钩子
const preCompactHook: HookHandler = {
  type: 'pre:compact',
  priority: 10,
  handler: async (context) => {
    // 保存当前状态
    const state = await saveSessionState()
    
    return {
      updates: { preservedState: state },
      abort: false
    }
  }
}

// Post-tool 钩子 (安全审计)
const postToolAuditHook: HookHandler = {
  type: 'post:tool',
  priority: 5,
  handler: async (context) => {
    const { toolName, result } = context
    
    // 记录审计日志
    await logSecurityEvent({
      type: 'TOOL_EXECUTION',
      tool: toolName,
      result: result.success ? 'SUCCESS' : 'FAILURE',
      timestamp: Date.now()
    })
    
    return { abort: false }
  }
}
```

## 命令管道

### 管道配置

```typescript
// 命令管道
interface CommandPipeline {
  name: string
  stages: PipelineStage[]
  onError?: 'abort' | 'continue' | 'rollback'
}

interface PipelineStage {
  name: string
  command: string
  args?: string[]
  timeout?: number
}

// 执行管道
async function executePipeline(
  pipeline: CommandPipeline,
  context: PipelineContext
): Promise<PipelineResult> {
  const results: StageResult[] = []
  
  for (const stage of pipeline.stages) {
    try {
      const result = await executeStage(stage, context)
      results.push(result)
      
      if (result.status === 'failed' && pipeline.onError === 'abort') {
        break
      }
    } catch (error) {
      if (pipeline.onError === 'rollback') {
        await rollbackPipeline(results)
      }
      throw error
    }
  }
  
  return { stages: results, success: true }
}
```

### 管道示例

```typescript
// 代码审查管道
const codeReviewPipeline: CommandPipeline = {
  name: 'code-review',
  stages: [
    {
      name: 'find-changes',
      command: 'git',
      args: ['diff', '--name-only', 'HEAD~1']
    },
    {
      name: 'review-changes',
      command: 'agent',
      args: ['Review changed files for bugs and security issues']
    },
    {
      name: 'run-tests',
      command: 'npm',
      args: ['test'],
      timeout: 300000
    },
    {
      name: 'generate-report',
      command: 'agent',
      args: ['Generate code review report']
    }
  ],
  onError: 'continue'
}
```

## 错误处理

### 命令错误

```typescript
// 命令错误类
class CommandError extends Error {
  constructor(
    message: string,
    public code: CommandErrorCode,
    public command?: string
  ) {
    super(message)
    this.name = 'CommandError'
  }
}

type CommandErrorCode =
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'INVALID_ARGS'
  | 'EXECUTION_FAILED'
  | 'TIMEOUT'
  | 'ABORTED_BY_USER'
```

### 错误恢复

```typescript
// 带重试的命令执行
async function executeWithRetry<T>(
  command: string,
  args: string[],
  options: RetryOptions = {}
): Promise<T> {
  const { maxRetries = 3, backoff = 'exponential' } = options
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await executeCommand(command, args)
    } catch (error) {
      // 不重试的错误
      if (error.code === 'PERMISSION_DENIED' || 
          error.code === 'INVALID_ARGS') {
        throw error
      }
      
      if (attempt === maxRetries - 1) {
        throw error
      }
      
      // 指数退避
      const delay = Math.pow(2, attempt) * 1000
      await sleep(delay)
    }
  }
  
  throw new Error('Unreachable')
}
```

## 最佳实践

### 命令设计

```typescript
// 命令设计原则
const COMMAND_DESIGN_PRINCIPLES = {
  // 1. 单一职责
  singleResponsibility: '每个命令只做一件事',
  
  // 2. 组合优于继承
  composition: '使用管道组合简单命令',
  
  // 3. 明确的错误
  clearErrors: '错误信息说明如何修复',
  
  // 4. 干模式支持
  dryRun: '支持 --dry-run 预览效果',
  
  // 5. 进度反馈
  progress: '长时间操作显示进度'
}

// 使用示例
async function createFileWithProgress(
  filePath: string,
  content: string
): Promise<void> {
  console.log(`Creating ${filePath}...`)
  
  // 显示进度
  const progress = new Progress({ total: 100 })
  
  await Write({ file_path: filePath, content }, {
    onProgress: (p) => progress.update(p)
  })
  
  console.log(`✓ Created ${filePath}`)
}
```

### 命令发现

```typescript
// 命令发现 API
async function discoverCommands(): Promise<CommandCatalog> {
  const catalog: CommandCatalog = {
    builtin: [],
    custom: [],
    mcp: []
  }
  
  // 内置命令
  catalog.builtin = BUILTIN_COMMANDS.map(cmd => ({
    name: cmd.name,
    description: cmd.description,
    source: 'builtin'
  }))
  
  // MCP 命令
  const mcpServers = await listMCPServers()
  for (const server of mcpServers) {
    const commands = await callMCP(server.id, 'commands/list')
    catalog.mcp.push(...commands.map(cmd => ({
      ...cmd,
      source: `mcp:${server.id}`
    })))
  }
  
  return catalog
}
```

## 相关文档

- [权限系统](../technical/permissions.md) - 命令权限管理
- [钩子系统](../technical/hooks.md) - 钩子配置和事件
- [MCP 协议](../technical/mcp.md) - MCP 命令集成
