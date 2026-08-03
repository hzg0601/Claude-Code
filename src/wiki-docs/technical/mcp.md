# MCP 协议实现

Model Context Protocol (MCP) 是 Claude Code 与外部服务和工具集成的核心协议。

## MCP 架构

```
┌─────────────────────────────────────────────────────────────┐
│                      MCP Layer                               │
├─────────────────────────────────────────────────────────────┤
│  Client Layer        │  Transport       │  Server Layer     │
│  - MCPClient         │  - SSE           │  - MCP Server     │
│  - Connection Pool   │  - Stdio         │  - Tools          │
│  - Tool Registry     │  - WebSocket     │  - Resources      │
│                      │                  │  - Prompts        │
├─────────────────────────────────────────────────────────────┤
│  Security Layer                                              │
│  - OAuth 2.0         │  - Token Mgmt    │  - Permissions    │
└─────────────────────────────────────────────────────────────┘
```

## 核心组件

### 1. MCP 客户端

```typescript
// services/mcp/client.ts
export class MCPClient {
  private connection: MCPConnection
  private toolRegistry: ToolRegistry
  
  constructor(config: MCPConfig) {
    this.connection = new MCPConnection(config)
    this.toolRegistry = new ToolRegistry()
  }
  
  async connect(): Promise<void> {
    await this.connection.establish()
    await this.discoverTools()
  }
  
  async callTool(name: string, params: Record<string, unknown>): Promise<MCPResult> {
    return this.connection.request('tools/call', { name, params })
  }
  
  async listTools(): Promise<Tool[]> {
    return this.connection.request('tools/list', {})
  }
}
```

### 2. 传输层

#### SSE 传输

```typescript
// SSE 传输实现
export class SSETransport implements Transport {
  private eventSource: EventSource
  private messageQueue: Message[]
  
  constructor(url: string) {
    this.eventSource = new EventSource(url)
    this.setupEventListeners()
  }
  
  private setupEventListeners() {
    this.eventSource.onmessage = (event) => {
      const message = JSON.parse(event.data)
      this.handleMessage(message)
    }
  }
  
  async send(message: Message): Promise<void> {
    await fetch(this.endpoint, {
      method: 'POST',
      body: JSON.stringify(message)
    })
  }
}
```

#### Stdio 传输

```typescript
// Stdio 传输实现
export class StdioTransport implements Transport {
  private child: ChildProcess
  private reader: ReadlineStream
  
  constructor(command: string, args: string[]) {
    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.reader = readline.createInterface({
      input: this.child.stdout
    })
  }
  
  async send(message: Message): Promise<void> {
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }
}
```

### 3. OAuth 认证

```typescript
// services/oauth/client.ts
export async function startOAuthFlow(config: OAuthConfig): Promise<OAuthResult> {
  const { authUrl, state, codeVerifier } = await generateAuthRequest()
  
  // 启动本地服务器接收回调
  const server = createAuthCodeListener()
  const authUrlWithParams = `${authUrl}?${new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    state,
    code_challenge: generateCodeChallenge(codeVerifier)
  })}`
  
  // 打开浏览器进行授权
  await openBrowser(authUrlWithParams)
  
  // 等待授权码
  const { code } = await server.waitForCallback()
  
  // 交换 token
  const tokens = await exchangeCodeForToken({
    code,
    codeVerifier,
    clientId: config.clientId
  })
  
  return { tokens, state }
}
```

## MCP 服务器管理

### 服务器配置

```typescript
// MCP 服务器配置
interface MCPServerConfig {
  id: string
  name: string
  transport: 'sse' | 'stdio' | 'websocket'
  url?: string  // SSE/WebSocket
  command?: string  // Stdio
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
}

// 配置示例
const servers: MCPServerConfig[] = [
  {
    id: 'filesystem',
    name: 'Filesystem Server',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@anthropic/mcp-server-filesystem']
  },
  {
    id: 'github',
    name: 'GitHub Server',
    transport: 'sse',
    url: 'http://localhost:8000/sse',
    headers: {
      'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`
    }
  }
]
```

### 服务器注册表

```typescript
// services/mcp/registry.ts
export class MCPServerRegistry {
  private servers: Map<string, MCPServer> = new Map()
  
  async register(config: MCPServerConfig): Promise<void> {
    const server = new MCPServer(config)
    await server.connect()
    this.servers.set(config.id, server)
  }
  
  async unregister(id: string): Promise<void> {
    const server = this.servers.get(id)
    await server?.disconnect()
    this.servers.delete(id)
  }
  
  getServer(id: string): MCPServer | undefined {
    return this.servers.get(id)
  }
  
  getAllServers(): MCPServer[] {
    return Array.from(this.servers.values())
  }
}
```

## 工具发现

### 工具列表

```typescript
// 列出所有可用工具
const tools = await mcpClient.listTools()

// 工具结构
interface Tool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, SchemaProperty>
    required?: string[]
  }
}
```

### 资源发现

```typescript
// 列出 MCP 资源
const resources = await mcpClient.listResources()

// 读取资源内容
const content = await mcpClient.readResource({
  uri: 'file:///path/to/resource'
})
```

## 权限管理

### 通道权限

```typescript
// 通道权限管理
interface ChannelPermissions {
  allowedTools: Set<string>
  deniedTools: Set<string>
  alwaysAskTools: Set<string>
}

export function checkToolPermission(
  channel: string,
  toolName: string
): PermissionResult {
  const perms = getChannelPermissions(channel)
  
  if (perms.deniedTools.has(toolName)) {
    return { allowed: false, reason: 'denied' }
  }
  
  if (perms.allowedTools.has(toolName)) {
    return { allowed: true }
  }
  
  return { allowed: false, reason: 'ask' }
}
```

### MCP 工具前缀规则

```typescript
// MCP 工具名称格式：mcp__server__tool
// 权限检查
function getMCPToolPermission(
  toolName: string,
  permissionContext: PermissionContext
): boolean {
  // 解析服务器名称
  const [_, serverName] = toolName.split('__')
  
  // 检查服务器级别的拒绝规则
  if (permissionContext.deniedMCP.has(serverName)) {
    return false
  }
  
  return true
}
```

## 错误处理

### 连接错误

```typescript
// 连接错误处理
export class MCPConnectionError extends Error {
  constructor(
    message: string,
    public code: 'TIMEOUT' | 'AUTH_FAILED' | 'NETWORK_ERROR'
  ) {
    super(message)
  }
}

// 重试逻辑
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxRetries = 3, backoff = 'exponential' } = options
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn()
    } catch (error) {
      if (i === maxRetries - 1) throw error
      await sleep(getBackoffDelay(i, backoff))
    }
  }
}
```

### 超时处理

```typescript
// 请求超时
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), timeoutMs)
    )
  ])
}
```

## 最佳实践

### 连接管理

```typescript
// 连接池管理
export class MCPConnectionPool {
  private pool: Map<string, MCPConnection> = new Map()
  
  async getConnection(serverId: string): Promise<MCPConnection> {
    let conn = this.pool.get(serverId)
    if (!conn || !conn.isConnected()) {
      conn = new MCPConnection(serverId)
      await conn.connect()
      this.pool.set(serverId, conn)
    }
    return conn
  }
  
  async closeAll(): Promise<void> {
    for (const conn of this.pool.values()) {
      await conn.close()
    }
    this.pool.clear()
  }
}
```

### 资源清理

```typescript
// 资源清理
process.on('SIGINT', async () => {
  await mcpClient.disconnect()
  await oauthClient.cleanup()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await mcpClient.disconnect()
  process.exit(0)
})
```

## 测试

### 单元测试

```typescript
describe('MCP Client', () => {
  it('should connect to server', async () => {
    const client = new MCPClient({
      transport: 'stdio',
      command: 'echo-server'
    })
    
    await client.connect()
    expect(client.isConnected()).toBe(true)
  })
  
  it('should call tool', async () => {
    const result = await client.callTool('test-tool', { param: 'value' })
    expect(result.success).toBe(true)
  })
})
```

### 集成测试

```typescript
describe('MCP Integration', () => {
  let server: TestMCPServer
  
  beforeEach(async () => {
    server = await startTestServer()
  })
  
  afterEach(async () => {
    await server.stop()
  })
  
  it('should discover tools', async () => {
    const client = await createClient(server.url)
    const tools = await client.listTools()
    expect(tools.length).toBeGreaterThan(0)
  })
})
```

## 相关文档

- [服务层](../modules/services.md) - MCP 服务实现
- [工具系统](../modules/tools.md) - MCP 工具集成
- [OAuth 认证](./oauth.md) - OAuth 2.0 流程
