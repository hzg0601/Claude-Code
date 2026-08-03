# 远程会话

远程会话功能允许 Claude Code 在远程服务器上运行，同时保持与本地客户端的连接。

## 架构概述

```
┌─────────────────────────────────────────────────────────────┐
│                    Remote Session                            │
├─────────────────────────────────────────────────────────────┤
│  Local Client        │  Bridge          │  Remote Server    │
│  - Claude Code CLI   │  - Tunnel        │  - Agent Process  │
│  - Terminal UI       │  - Port Forward  │  - Tool Execution │
│  - Config Sync       │  - Auth Proxy    │  - File Access    │
└─────────────────────────────────────────────────────────────┘
```

## Bridge 模式

### Bridge 配置

```typescript
// Bridge 配置
interface BridgeConfig {
  // 连接配置
  remoteHost: string
  remotePort: number
  localPort: number
  
  // 认证配置
  authToken: string
  sessionToken?: string
  
  // 传输配置
  heartbeatInterval: number  // 心跳间隔 (ms)
  reconnectTimeout: number   // 重连超时 (ms)
  
  // 功能配置
  syncConfig: boolean        // 同步配置文件
  syncMemory: boolean        // 同步记忆文件
  forwardPorts: number[]     // 端口转发列表
}
```

### Bridge 连接

```typescript
// Bridge 连接管理
export class BridgeConnection {
  private ws: WebSocket
  private config: BridgeConfig
  private heartbeatTimer: NodeJS.Timeout
  
  constructor(config: BridgeConfig) {
    this.config = config
  }
  
  async connect(): Promise<void> {
    const wsUrl = `wss://${this.config.remoteHost}:${this.config.remotePort}/bridge`
    
    this.ws = new WebSocket(wsUrl, {
      headers: {
        'Authorization': `Bearer ${this.config.authToken}`
      }
    })
    
    await this.waitForConnection()
    this.startHeartbeat()
    this.setupEventHandlers()
  }
  
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }))
    }, this.config.heartbeatInterval)
  }
  
  private setupEventHandlers(): void {
    this.ws.on('message', (data) => {
      const message = JSON.parse(data.toString())
      this.handleMessage(message)
    })
    
    this.ws.on('close', () => {
      this.attemptReconnect()
    })
  }
}
```

## 会话管理

### 会话创建

```typescript
// 创建远程会话
export async function createRemoteSession(
  config: RemoteSessionConfig
): Promise<RemoteSession> {
  // 1. 认证
  const authResult = await authenticate(config.credentials)
  
  // 2. 创建桥接连接
  const bridge = new BridgeConnection({
    remoteHost: config.host,
    remotePort: config.port,
    authToken: authResult.token
  })
  await bridge.connect()
  
  // 3. 初始化远程环境
  const sessionInfo = await bridge.request('session/create', {
    workingDirectory: config.workingDirectory,
    environment: config.environment
  })
  
  // 4. 同步配置
  if (config.syncConfig) {
    await syncConfiguration(bridge)
  }
  
  return new RemoteSession(bridge, sessionInfo)
}
```

### 会话恢复

```typescript
// 恢复之前的会话
export async function resumeSession(
  sessionId: string
): Promise<RemoteSession> {
  const sessionData = await loadSessionState(sessionId)
  
  const bridge = new BridgeConnection(sessionData.bridgeConfig)
  await bridge.connect()
  
  // 恢复会话状态
  await bridge.request('session/resume', {
    sessionId: sessionData.sessionId,
    lastMessageId: sessionData.lastMessageId
  })
  
  return new RemoteSession(bridge, sessionData)
}
```

## 配置同步

### 配置同步策略

```typescript
// 同步配置文件
async function syncConfiguration(bridge: BridgeConnection): Promise<void> {
  const configFiles = [
    '.claude/settings.local.json',
    '.claude/settings.json',
    'CLAUDE.md',
    '.gitignore'
  ]
  
  for (const file of configFiles) {
    const localPath = path.join(process.cwd(), file)
    const content = await readFile(localPath)
    
    await bridge.request('file/write', {
      path: file,
      content: content.toString('base64')
    })
  }
}
```

### 记忆同步

```typescript
// 同步记忆文件
async function syncMemory(bridge: BridgeConnection): Promise<void> {
  const memoryDir = path.join(process.cwd(), '.claude', 'memory')
  
  const files = await glob('**/*.md', { cwd: memoryDir })
  
  for (const file of files) {
    const content = await readFile(path.join(memoryDir, file))
    await bridge.request('file/write', {
      path: `.claude/memory/${file}`,
      content: content.toString('base64')
    })
  }
}
```

## 端口转发

### 本地端口转发

```typescript
// 设置端口转发
export function setupPortForwarding(
  bridge: BridgeConnection,
  remotePort: number,
  localPort: number
): PortForwarder {
  const forwarder = new PortForwarder()
  
  bridge.on('tunnel/request', async (req) => {
    if (req.remotePort === remotePort) {
      return forwarder.forward(req.data)
    }
  })
  
  return forwarder
}

class PortForwarder {
  private connections: Map<string, Socket> = new Map()
  
  async forward(data: Buffer): Promise<Buffer> {
    // 转发数据到本地服务
    const response = await fetch(`http://localhost:${this.localPort}`, {
      method: 'POST',
      body: data
    })
    return Buffer.from(await response.arrayBuffer())
  }
}
```

## 认证流程

### OAuth 远程认证

```typescript
// 远程会话 OAuth 流程
export async function remoteOAuthFlow(
  config: RemoteOAuthConfig
): Promise<AuthToken> {
  // 1. 获取设备代码
  const deviceCode = await getDeviceCode({
    clientId: config.clientId,
    scope: config.scope
  })
  
  // 2. 显示用户验证码
  console.log(`Visit ${deviceCode.verificationUri}`)
  console.log(`Enter code: ${deviceCode.userCode}`)
  
  // 3. 轮询等待授权
  const tokens = await pollForTokens({
    deviceCode: deviceCode.deviceCode,
    interval: deviceCode.interval
  })
  
  return tokens
}
```

### Token 刷新

```typescript
// 刷新访问令牌
export async function refreshAccessToken(
  refreshToken: string,
  config: TokenConfig
): Promise<TokenResponse> {
  const response = await fetch(config.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret
    })
  })
  
  return response.json()
}
```

## 文件传输

### 文件上传

```typescript
// 上传文件到远程
export async function uploadFile(
  bridge: BridgeConnection,
  localPath: string,
  remotePath: string
): Promise<void> {
  const content = await readFile(localPath)
  const stats = await stat(localPath)
  
  await bridge.request('file/upload', {
    path: remotePath,
    content: content.toString('base64'),
    mode: stats.mode,
    mtime: stats.mtimeMs
  })
}
```

### 文件下载

```typescript
// 从远程下载文件
export async function downloadFile(
  bridge: BridgeConnection,
  remotePath: string,
  localPath: string
): Promise<void> {
  const result = await bridge.request('file/download', {
    path: remotePath
  })
  
  await writeFile(localPath, Buffer.from(result.content, 'base64'), {
    mode: result.mode
  })
}
```

## 错误处理

### 连接错误

```typescript
// 连接错误处理
export class RemoteSessionError extends Error {
  constructor(
    message: string,
    public code: 'CONNECTION_FAILED' | 'AUTH_FAILED' | 'TIMEOUT' | 'DISCONNECTED'
  ) {
    super(message)
  }
}

// 自动重连逻辑
export async function withReconnect<T>(
  fn: () => Promise<T>,
  options: ReconnectOptions
): Promise<T> {
  const { maxRetries = 5, initialDelay = 1000 } = options
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (error.code === 'AUTH_FAILED') {
        throw error  // 认证失败不重试
      }
      
      const delay = initialDelay * Math.pow(2, attempt)
      await sleep(delay)
    }
  }
  
  throw new RemoteSessionError('Max retries exceeded', 'CONNECTION_FAILED')
}
```

### 会话超时

```typescript
// 会话超时检测
export class SessionMonitor {
  private lastActivity: number = Date.now()
  private timeoutMs: number
  
  constructor(timeoutMs: number = 30 * 60 * 1000) {
    this.timeoutMs = timeoutMs
  }
  
  recordActivity(): void {
    this.lastActivity = Date.now()
  }
  
  isTimedOut(): boolean {
    return Date.now() - this.lastActivity > this.timeoutMs
  }
  
  async checkAndReconnect(bridge: BridgeConnection): Promise<boolean> {
    if (this.isTimedOut()) {
      try {
        await bridge.reconnect()
        this.recordActivity()
        return true
      } catch {
        return false
      }
    }
    return true
  }
}
```

## 最佳实践

### 连接优化

```typescript
// 连接池管理
export class BridgeConnectionPool {
  private pool: Map<string, BridgeConnection> = new Map()
  
  async getConnection(sessionId: string): Promise<BridgeConnection> {
    let conn = this.pool.get(sessionId)
    if (!conn || !conn.isConnected()) {
      conn = await createBridgeConnection(sessionId)
      this.pool.set(sessionId, conn)
    }
    return conn
  }
  
  async cleanup(): Promise<void> {
    for (const conn of this.pool.values()) {
      await conn.close()
    }
    this.pool.clear()
  }
}
```

### 带宽优化

```typescript
// 压缩大文件传输
export async function uploadCompressedFile(
  bridge: BridgeConnection,
  localPath: string,
  remotePath: string
): Promise<void> {
  const content = await readFile(localPath)
  const compressed = await gzip(content)
  
  await bridge.request('file/upload', {
    path: remotePath,
    content: compressed.toString('base64'),
    encoding: 'gzip'
  })
}
```

## 安全考虑

### 传输加密

```typescript
// TLS 配置
const tlsConfig: TLSConfig = {
  rejectUnauthorized: true,
  minVersion: 'TLSv1.3',
  ciphers: [
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256'
  ].join(':')
}
```

### 凭证管理

```typescript
// 安全存储凭证
import keytar from 'keytar'

const SERVICE_NAME = 'claude-code-remote'

export async function storeCredentials(
  sessionId: string,
  token: string
): Promise<void> {
  await keytar.setPassword(SERVICE_NAME, sessionId, token)
}

export async function getCredentials(
  sessionId: string
): Promise<string | null> {
  return keytar.getPassword(SERVICE_NAME, sessionId)
}
```

## 相关文档

- [服务层](../modules/services.md) - Remote Services 实现
- [MCP 协议](./mcp.md) - MCP 协议规范
- [权限系统](./permissions.md) - 远程权限管理
