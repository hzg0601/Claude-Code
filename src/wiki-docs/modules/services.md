# 服务层

服务层提供了业务逻辑、外部服务集成和核心功能的实现。

## 服务架构

```
┌─────────────────────────────────────────────────────────────┐
│                      Service Layer                           │
├─────────────────────────────────────────────────────────────┤
│  Analytics Services  │  MCP Services  │  API Services       │
│  - GrowthBook        │  - Client      │  - Claude API       │
│  - Telemetry         │  - OAuth       │  - Bootstrap        │
│  - Event Logging     │  - Resources   │  - Usage            │
│                      │                │                     │
│  Context Services    │  LSP Services  │  Compact Services   │
│  - SessionMemory     │  - LSPClient   │  - AutoCompact      │
│  - ContextCollapse   │  - Manager     │  - MicroCompact     │
│                      │                │                     │
│  Diagnostic Services │  OAuth         │  Remote Services    │
│  - DiagnosticTracking│  - Auth        │  - Bridge           │
│  - InternalLogging   │  - Token       │  - Session Mgmt     │
└─────────────────────────────────────────────────────────────┘
```

## 核心服务分类

### 1. 分析服务 (Analytics Services)

位置：`services/analytics/`

| 服务 | 描述 |
|------|------|
| `GrowthBook` | 功能标志和 A/B 测试 |
| `Telemetry` | 使用指标收集 |
| `FirstPartyEventLogger` | 第一方事件日志 |
| `Datadog` | Datadog 日志集成 |
| `MetadataService` | 会话元数据管理 |

```typescript
// GrowthBook 功能标志示例
import { feature } from './services/analytics/growthbook'

if (feature('COORDINATOR_MODE')) {
  // 协调器模式功能
}
```

### 2. MCP 服务 (MCP Services)

位置：`services/mcp/`

| 服务 | 描述 |
|------|------|
| `MCP Client` | MCP 协议客户端 |
| `OAuth` | OAuth 2.0 认证 |
| `Channel Permissions` | 通道权限管理 |
| `Elicitation Handler` | 用户确认处理 |
| `Official Registry` | 官方服务器注册表 |

```typescript
// MCP 客户端示例
import { createMCPClient } from './services/mcp/client'

const client = await createMCPClient({
  transport: 'sse',
  url: 'http://localhost:3000/sse'
})

const tools = await client.listTools()
```

### 3. API 服务 (API Services)

位置：`services/api/`

| 服务 | 描述 |
|------|------|
| `Claude API` | Anthropic Claude API 封装 |
| `Bootstrap` | 引导数据加载 |
| `Usage` | API 使用量追踪 |
| `Files API` | 文件上传下载 |
| `Retry Utils` | 请求重试逻辑 |

```typescript
// API 请求示例
import { createChatCompletion } from './services/api/claude'

const response = await createChatCompletion({
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'Hello' }]
})
```

### 4. 上下文服务 (Context Services)

位置：`services/contextCollapse/`, `services/SessionMemory/`

| 服务 | 描述 |
|------|------|
| `ContextCollapse` | 上下文折叠策略 |
| `SessionMemory` | 会话记忆管理 |
| `AutoCompact` | 自动会话压缩 |
| `MicroCompact` | 微型压缩 |

```typescript
// 会话压缩示例
import { compactHistory } from './services/compact/compact'

await compactHistory({
  sessionId: 'abc123',
  strategy: 'summarize'
})
```

### 5. LSP 服务 (Language Server Protocol)

位置：`services/lsp/`

| 服务 | 描述 |
|------|------|
| `LSPClient` | LSP 客户端实现 |
| `LSPServerManager` | 服务器管理 |
| `DiagnosticRegistry` | 诊断注册表 |
| `PassiveFeedback` | 被动反馈收集 |

```typescript
// LSP 客户端示例
import { LSPClient } from './services/lsp/LSPClient'

const client = new LSPClient({
  command: 'typescript-language-server',
  args: ['--stdio']
})

await client.initialize({
  rootUri: process.cwd()
})
```

### 6. OAuth 服务

位置：`services/oauth/`

| 服务 | 描述 |
|------|------|
| `Auth Code Listener` | 授权码监听 |
| `Token Manager` | Token 管理 |
| `PKCE` | PKCE 流程支持 |

```typescript
// OAuth 流程示例
import { startOAuthFlow } from './services/oauth/client'

const { authUrl, state } = await startOAuthFlow({
  clientId: process.env.OAUTH_CLIENT_ID,
  redirectUri: 'http://localhost:3000/callback'
})
```

## 服务注册和发现

### 服务初始化

```typescript
// main.tsx 中的服务初始化
import { initializeGrowthBook } from './services/analytics/growthbook'
import { setupMCPClient } from './services/mcp/client'
import { bootstrapState } from './bootstrap/state'

async function main() {
  // 1. 初始化分析服务
  await initializeGrowthBook()
  
  // 2. 初始化 MCP 服务
  await setupMCPClient()
  
  // 3. 加载引导数据
  await bootstrapState.load()
  
  // 4. 启动应用
  renderApp()
}
```

### 服务依赖注入

```typescript
// 服务容器示例
interface ServiceContainer {
  analytics: AnalyticsService
  mcp: MCPClient
  api: ClaudeAPI
  lsp: LSPService
}

const container: ServiceContainer = {
  analytics: new AnalyticsService(),
  mcp: new MCPClient(),
  api: new ClaudeAPI(),
  lsp: new LSPService()
}
```

## 分析服务详解

### GrowthBook 功能标志

```typescript
// 功能标志评估
import { feature } from './services/analytics/growthbook'

// 基本用法
if (feature('NEW_FEATURE')) {
  // 新功能逻辑
}

// 带默认值
const isEnabled = feature('EXPERIMENT', false)

// 多变量标志
const variant = feature('VARIANT_TEST', 'control')
```

### 遥测和数据收集

```typescript
// 事件日志示例
import { logEvent } from './services/analytics/firstPartyEventLogger'

logEvent('command_executed', {
  command: '/compact',
  sessionId: getSessionId(),
  duration: elapsedMs
})
```

## MCP 服务详解

### MCP 客户端配置

```typescript
import { createMCPClient } from './services/mcp/client'

// SSE 传输
const sseClient = await createMCPClient({
  transport: 'sse',
  url: 'http://localhost:8080/sse'
})

// Stdio 传输
const stdioClient = await createMCPClient({
  transport: 'stdio',
  command: 'mcp-server',
  args: ['--stdio']
})

// WebSocket 传输
const wsClient = await createMCPClient({
  transport: 'websocket',
  url: 'ws://localhost:9000'
})
```

### MCP 资源访问

```typescript
import { ListMcpResourcesTool, ReadMcpResourceTool } from './tools'

// 列出所有资源
const resources = await ListMcpResourcesTool.execute({})

// 读取特定资源
const content = await ReadMcpResourceTool.execute({
  uri: 'file:///path/to/resource'
})
```

## 会话压缩服务

### 自动压缩触发

```typescript
// 基于 token 数量的压缩
import { shouldTriggerCompact } from './services/compact/autoCompact'

if (shouldTriggerCompact({
  tokenCount: currentTokenCount,
  threshold: 100000
})) {
  await compactHistory()
}
```

### 压缩策略

```typescript
// 不同的压缩策略
const strategies = {
  // 基于时间分组
  timeBased: groupByTimeWindow(messages, 3600),
  
  // 基于重要性
  importanceBased: filterByImportance(messages),
  
  // 基于对话结构
  groupingBased: groupByConversation(messages)
}
```

## LSP 服务详解

### LSP 客户端生命周期

```typescript
import { LSPClient } from './services/lsp/LSPClient'

const client = new LSPClient({
  command: 'typescript-language-server',
  args: ['--stdio']
})

// 初始化
await client.initialize({
  processId: process.pid,
  rootUri: `file://${process.cwd()}`,
  capabilities: {
    textDocument: {
      completion: { completionItem: { snippetSupport: true } }
    }
  }
})

// 打开文档
await client.notify('textDocument/didOpen', {
  textDocument: {
    uri: 'file:///path/to/file.ts',
    languageId: 'typescript',
    version: 1,
    text: fileContent
  }
})

// 请求补全
const completions = await client.request('textDocument/completion', {
  textDocument: { uri: 'file:///path/to/file.ts' },
  position: { line: 10, character: 5 }
})
```

## 错误处理

### API 错误处理

```typescript
import { isAPIError, retryRequest } from './services/api/errors'

try {
  const result = await callAPI()
} catch (error) {
  if (isAPIError(error, 'rate_limit')) {
    await handleRateLimit()
  } else if (isAPIError(error, 'timeout')) {
    await retryRequest()
  } else {
    throw error
  }
}
```

### 重试逻辑

```typescript
import { withRetry } from './services/api/withRetry'

const result = await withRetry(
  () => callAPI(),
  {
    maxRetries: 3,
    backoff: 'exponential',
    onRetry: (attempt, error) => {
      console.log(`Retry ${attempt}: ${error.message}`)
    }
  }
)
```

## 服务测试

### 单元测试示例

```typescript
describe('GrowthBook Service', () => {
  it('should evaluate feature flags', async () => {
    const growthbook = new GrowthBook()
    await growthbook.init({ features: TEST_FEATURES })
    
    expect(growthbook.eval('test_feature', false)).toBe(true)
  })
})

describe('MCP Client', () => {
  it('should connect to MCP server', async () => {
    const client = await createMCPClient({
      transport: 'stdio',
      command: 'echo-server'
    })
    
    const tools = await client.listTools()
    expect(tools.length).toBeGreaterThan(0)
  })
})
```

### 服务模拟

```typescript
// 测试用模拟服务
const mockServices = {
  analytics: {
    logEvent: jest.fn(),
    feature: jest.fn().mockReturnValue(true)
  },
  mcp: {
    listTools: jest.fn().mockResolvedValue([]),
    callTool: jest.fn()
  },
  api: {
    createChatCompletion: jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'mock' }]
    })
  }
}
```

## 最佳实践

### 服务分层

1. **服务层**：业务逻辑和外部服务集成
2. **工具层**：具体操作的实现
3. **组件层**：UI 渲染和用户交互

### 错误边界

```typescript
// 服务层错误边界
class ServiceError extends Error {
  constructor(
    message: string,
    public service: string,
    public code?: string
  ) {
    super(message)
  }
}

// 使用示例
try {
  await mcpClient.callTool('my-tool', params)
} catch (error) {
  throw new ServiceError(
    `MCP tool call failed: ${error.message}`,
    'MCP',
    'TOOL_CALL_FAILED'
  )
}
```

### 日志记录

```typescript
import { internalLogger } from './services/internalLogging'

// 结构化日志
internalLogger.info('Service initialized', {
  service: 'MCPClient',
  config: { transport: 'sse', url: '...' }
})

internalLogger.error('Service failed', {
  service: 'ClaudeAPI',
  error: error.message,
  stack: error.stack
})
```

## 相关文档

- [架构设计](../architecture.md) - 系统架构总览
- [MCP 协议](../technical/mcp.md) - MCP 协议实现
- [远程会话](../technical/remote-sessions.md) - 远程服务集成
- [工具系统](./tools.md) - 工具层接口
