# 代理系统

Claude Code 的代理系统允许将复杂任务委派给专门的子代理执行，支持并行执行、结果聚合和任务编排。

## 代理架构

```
┌─────────────────────────────────────────────────────────────┐
│                     Agent System                              │
├─────────────────────────────────────────────────────────────┤
│  Built-in Agents     │  Custom Agents   │  Agent Types      │
│  - Explore           │  - Code Reviewer │  - Read-only      │
│  - Plan              │  - Domain Spec   │  - Write-enabled  │
│  - Code Reviewer     │  - Test Gen      │  - Isolated       │
│                      │                  │                    │
│  Agent Orchestration │  Workflow        │  Communication    │
│  - Sequential        │  - Definitions   │  - Shared State   │
│  - Parallel          │  - Execution     │  - Messages       │
│  - Conditional       │  - Monitoring    │  - Events         │
└─────────────────────────────────────────────────────────────┘
```

## 内置代理

### 1. Explore 代理

**用途**: 代码库探索和搜索

```typescript
// Explore 代理配置
const exploreAgent = {
  type: 'Explore',
  description: 'Fast read-only search agent',
  tools: ['Read', 'Grep', 'Glob', 'Bash'],
  useCases: [
    'Finding files by pattern',
    'Searching for symbols',
    'Answering "where is X defined"'
  ]
}
```

**调用示例**:

```typescript
const result = await agent('Explore', {
  prompt: 'Find all authentication middleware files',
  searchDepth: 'medium'
})
```

### 2. Plan 代理

**用途**: 软件架构设计和实现计划

```typescript
// Plan 代理配置
const planAgent = {
  type: 'Plan',
  description: 'Software architect agent',
  capabilities: [
    'Design implementation strategy',
    'Identify critical files',
    'Consider architectural trade-offs'
  ]
}
```

**调用示例**:

```typescript
const plan = await agent('Plan', {
  prompt: 'Design a rate limiting system for our API',
  outputFormat: 'step-by-step'
})
```

### 3. Code Reviewer 代理

**用途**: 代码质量审查

```typescript
// Code Reviewer 配置
const reviewerAgent = {
  type: 'code-reviewer',
  description: 'Expert code reviewer',
  focusAreas: [
    'Quality',
    'Security', 
    'Maintainability'
  ]
}
```

## 代理类型分类

### 按功能分类

| 类型 | 描述 | 工具权限 |
|------|------|----------|
| Read-only | 只读操作 | Read, Grep, Glob |
| Write-enabled | 可写操作 | 所有工具 |
| Isolated | 工作树隔离 | 受限工具集 |

### 按执行模式分类

| 模式 | 描述 | 适用场景 |
|------|------|----------|
| Synchronous | 同步等待结果 | 依赖前序结果 |
| Parallel | 并行执行 | 独立任务 |
| Streaming | 流式输出 | 长运行任务 |

## 代理定义

### TypeScript 接口

```typescript
interface AgentConfig {
  // 基本信息
  name: string
  description: string
  
  // 工具配置
  allowedTools?: string[]
  maxIterations?: number
  
  // 模型配置
  model?: string
  effort?: 'low' | 'medium' | 'high'
  
  // 执行配置
  timeout?: number
  isolation?: 'worktree' | 'none'
  
  // 输出配置
  outputSchema?: object
}
```

### 代理注册

```typescript
// 自定义代理注册
import { registerAgent } from './agents/registry'

registerAgent({
  name: 'test-generator',
  description: 'Generate unit tests for code changes',
  allowedTools: ['Read', 'Write', 'Glob', 'Bash'],
  model: 'claude-sonnet-4-6',
  async execute(prompt, context) {
    // 代理逻辑
    return { tests: generatedTests }
  }
})
```

## 代理编排模式

### 1. 顺序执行

```typescript
// 顺序执行代理
const findings = []

const explorer = await agent('Explore', {
  prompt: 'Find all API endpoints',
  phase: 'Discover'
})

const analyzer = await agent('Analyze', {
  prompt: `Analyze these endpoints: ${explorer}`,
  phase: 'Analyze'
})

findings.push(analyzer)
```

### 2. 并行执行

```typescript
// 并行执行多个代理
const [bugs, perf, security] = await parallel([
  () => agent('Find bugs', { schema: BUGS_SCHEMA }),
  () => agent('Check performance', { schema: PERF_SCHEMA }),
  () => agent('Review security', { schema: SECURITY_SCHEMA })
])
```

### 3. 条件执行

```typescript
// 基于条件选择代理
if (hasTypeScriptErrors) {
  return await agent('typescript-fix', { prompt: 'Fix TS errors' })
} else if (hasTestFailures) {
  return await agent('test-debug', { prompt: 'Debug failing tests' })
}
```

## 代理通信

### 共享状态

```typescript
// 代理间共享状态
const sharedState = {
  findings: [],
  verified: new Set(),
  pending: []
}

// 代理 A 写入
const result = await agent('finder', {
  prompt: 'Find potential issues',
  state: sharedState
})
sharedState.findings.push(...result)

// 代理 B 读取并验证
const verified = await agent('verifier', {
  prompt: 'Verify these findings',
  state: sharedState
})
```

### 消息传递

```typescript
// 代理间消息
interface AgentMessage {
  type: 'finding' | 'question' | 'result'
  from: string
  to: string
  payload: any
}

// 发送消息
await sendAgentMessage({
  type: 'finding',
  from: 'explorer',
  to: 'analyzer',
  payload: { file: 'auth.ts', issue: 'Missing validation' }
})
```

## 工作流系统

### 工作流定义

```typescript
// 工作流脚本
export const meta = {
  name: 'code-review-workflow',
  description: 'Comprehensive code review workflow',
  phases: [
    { title: 'Discover', detail: 'Find all changed files' },
    { title: 'Review', detail: 'Review each file' },
    { title: 'Verify', detail: 'Verify findings' }
  ]
}

// 执行工作流
const result = await workflow('code-review-workflow', {
  prNumber: 123
})
```

### 自定义工作流

```typescript
// 自定义工作流示例
const findings = []
while (findings.length < 10 && budget.remaining() > 50000) {
  const result = await agent('Find issues', { schema: ISSUES_SCHEMA })
  findings.push(...result.issues)
  log(`${findings.length} found`)
}
return findings
```

## 代理调试

### 日志记录

```typescript
// 代理执行日志
import { internalLogger } from './services/internalLogging'

internalLogger.info('Agent started', {
  agent: 'Explore',
  prompt: 'Find auth files',
  sessionId: getSessionId()
})

internalLogger.info('Agent completed', {
  duration: elapsedMs,
  tokensUsed: tokenCount
})
```

### 执行追踪

```typescript
// 追踪代理执行
const trace = {
  startTime: Date.now(),
  agent: 'Explore',
  prompt: '...',
  iterations: [],
  finalResult: null
}

// 记录每次迭代
trace.iterations.push({
  step: i,
  tool: toolName,
  duration: elapsedMs
})
```

## 最佳实践

### 代理设计

1. **单一职责**: 每个代理只做一件事
2. **明确接口**: 定义清晰的输入输出 schema
3. **错误处理**: 优雅处理失败和超时
4. **结果验证**: 验证代理输出的正确性

### 性能优化

```typescript
// 批量处理
const results = await parallel(
  files.map(file => () => 
    agent('analyze', { file, schema: RESULT_SCHEMA })
  )
)

// 避免重复工作
const seen = new Set()
const uniqueResults = results.filter(r => {
  const key = hash(r)
  if (seen.has(key)) return false
  seen.add(key)
  return true
})
```

### 成本控制

```typescript
// 预算控制
while (budget.total && budget.remaining() > 100000) {
  const result = await agent('Find issues', { schema: ISSUES_SCHEMA })
  issues.push(...result.issues)
  log(`${issues.length} found, ${budget.remaining()} tokens remaining`)
}
```

## 相关文档

- [架构设计](../architecture.md) - 系统架构
- [技能系统](./skills.md) - 技能系统文档
- [工作流](../technical/workflows.md) - 工作流系统
- [工具系统](./tools.md) - 工具接口文档
