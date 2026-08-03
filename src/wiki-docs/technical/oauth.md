# OAuth 2.0 认证

OAuth 2.0 认证系统支持本地和远程会话的安全授权流程。

## 认证架构

```
┌─────────────────────────────────────────────────────────────┐
│                    OAuth 2.0 Layer                           │
├─────────────────────────────────────────────────────────────┤
│  Authorization Code  │  Device Code     │  Token Mgmt       │
│  - Local Callback    │  - Remote Auth   │  - Refresh       │
│  - PKCE Flow         │  - Polling       │  - Storage       │
│  - State Param       │  - User Code     │  - Keytar        │
├─────────────────────────────────────────────────────────────┤
│  Security                                                    │
│  - Code Challenge    │  - Token Revocation │  - Auto-expiry │
└─────────────────────────────────────────────────────────────┘
```

## 认证模式

### 1. 授权码流程 (本地)

```typescript
// OAuth 授权码流程
interface AuthorizationCodeFlow {
  // 1. 生成 PKCE 参数
  const { codeVerifier, codeChallenge } = await generatePKCEParams()
  
  // 2. 启动本地回调服务器
  const server = createAuthCodeListener(port: 3000)
  
  // 3. 打开浏览器进行授权
  const authUrl = buildAuthUrl({
    clientId,
    redirectUri: 'http://localhost:3000/callback',
    codeChallenge,
    state: generateState()
  })
  await openBrowser(authUrl)
  
  // 4. 等待回调
  const { code } = await server.waitForCallback()
  
  // 5. 交换 token
  const tokens = await exchangeCodeForToken({
    code,
    codeVerifier,
    clientId,
    redirectUri
  })
  
  return tokens
}
```

### 2. 设备码流程 (远程)

```typescript
// 设备码认证流程
interface DeviceCodeFlow {
  // 1. 获取设备代码
  const deviceCode = await getDeviceCode({
    clientId,
    scope: 'read write'
  })
  
  // 2. 显示用户指令
  console.log(`Visit: ${deviceCode.verificationUri}`)
  console.log(`Enter code: ${deviceCode.userCode}`)
  
  // 3. 轮询等待授权
  const tokens = await pollForTokens({
    deviceCode: deviceCode.deviceCode,
    interval: deviceCode.interval || 5000,
    expiresInSeconds: deviceCode.expiresIn
  })
  
  return tokens
}
```

## OAuthClient 实现

### 核心类

```typescript
// services/oauth/client.ts
export class OAuthClient {
  private config: OAuthConfig
  private tokenStore: TokenStorage
  private refreshTimer?: NodeJS.Timeout
  
  constructor(config: OAuthConfig) {
    this.config = config
    this.tokenStore = new SecureTokenStorage()
  }
  
  // 启动授权流程
  async authorize(): Promise<AuthToken> {
    const pkce = await this.generatePKCE()
    const state = this.generateState()
    
    // 启动本地服务器
    const server = createAuthCodeListener({
      port: this.config.redirectPort || 3000,
      path: '/callback'
    })
    
    // 构建授权 URL
    const authUrl = this.buildAuthorizationUrl({
      state,
      codeChallenge: pkce.codeChallenge
    })
    
    // 打开浏览器
    await openBrowser(authUrl)
    
    // 等待回调
    const callback = await server.waitForCallback()
    
    // 验证 state
    if (callback.state !== state) {
      throw new OAuthError('State mismatch')
    }
    
    // 交换 token
    const tokens = await this.exchangeCodeForToken({
      code: callback.code,
      codeVerifier: pkce.codeVerifier
    })
    
    // 存储 tokens
    await this.tokenStore.save(tokens)
    
    // 设置自动刷新
    this.scheduleRefresh(tokens)
    
    return tokens
  }
  
  // 刷新 token
  async refreshToken(refreshToken: string): Promise<AuthToken> {
    const response = await fetch(this.config.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret
      })
    })
    
    if (!response.ok) {
      throw new OAuthError(`Token refresh failed: ${response.status}`)
    }
    
    const tokens = await response.json()
    await this.tokenStore.save(tokens)
    
    return tokens
  }
  
  // 获取当前 token (自动刷新)
  async getToken(): Promise<string> {
    const tokens = await this.tokenStore.load()
    
    if (!tokens) {
      throw new OAuthError('No tokens available')
    }
    
    // 检查是否需要刷新 (提前 5 分钟)
    const expiresAt = tokens.expiresAt || 0
    const needsRefresh = expiresAt - Date.now() < 5 * 60 * 1000
    
    if (needsRefresh && tokens.refreshToken) {
      return (await this.refreshToken(tokens.refreshToken)).accessToken
    }
    
    return tokens.accessToken
  }
  
  // 撤销 token
  async revokeToken(token: string): Promise<void> {
    await fetch(this.config.revocationEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        token,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret
      })
    })
    
    await this.tokenStore.clear()
  }
  
  // PKCE 参数生成
  private async generatePKCE(): Promise<PKCEParams> {
    const codeVerifier = generateRandomString(64)
    const codeChallenge = await generateCodeChallenge(codeVerifier)
    
    return { codeVerifier, codeChallenge }
  }
  
  // State 参数生成
  private generateState(): string {
    return generateRandomString(32)
  }
  
  // 调度自动刷新
  private scheduleRefresh(tokens: AuthToken): void> {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
    }
    
    const refreshTime = tokens.expiresIn * 1000 - 5 * 60 * 1000
    this.refreshTimer = setTimeout(async () => {
      if (tokens.refreshToken) {
        await this.refreshToken(tokens.refreshToken)
      }
    }, refreshTime)
  }
}
```

### PKCE 实现

```typescript
// PKCE 代码挑战生成
async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  
  // Base64URL 编码
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function generateRandomString(length: number): string {
  const array = new Uint8Array(length)
  crypto.getRandomValues(array)
  return Array.from(array)
    .map(b => b.toString(36).charAt(0))
    .join('')
}
```

## Token 存储

### 安全存储

```typescript
// services/oauth/storage.ts
import keytar from 'keytar'

const SERVICE_NAME = 'claude-code-oauth'

export class SecureTokenStorage {
  private readonly accountName: string
  
  constructor(sessionId: string) {
    this.accountName = `session:${sessionId}`
  }
  
  async save(tokens: AuthToken): Promise<void> {
    const encrypted = this.encrypt(tokens)
    await keytar.setPassword(SERVICE_NAME, this.accountName, encrypted)
  }
  
  async load(): Promise<AuthToken | null> {
    const encrypted = await keytar.getPassword(SERVICE_NAME, this.accountName)
    if (!encrypted) return null
    
    return this.decrypt(encrypted)
  }
  
  async clear(): Promise<void> {
    await keytar.deletePassword(SERVICE_NAME, this.accountName)
  }
  
  private encrypt(tokens: AuthToken): string {
    // 使用系统密钥加密
    const cipher = createCipheriv('aes-256-gcm', this.getEncryptionKey(), this.getIV())
    let encrypted = cipher.update(JSON.stringify(tokens), 'utf8', 'base64')
    encrypted += cipher.final('base64')
    return encrypted
  }
  
  private decrypt(encrypted: string): AuthToken {
    const decipher = createDecipheriv('aes-256-gcm', this.getEncryptionKey(), this.getIV())
    let decrypted = decipher.update(encrypted, 'base64', 'utf8')
    decrypted += decipher.final('utf8')
    return JSON.parse(decrypted)
  }
}
```

## 回调服务器

### 本地服务器实现

```typescript
// services/oauth/callback-server.ts
import { createServer, Server } from 'http'
import { parse } from 'url'

interface CallbackRequest {
  code: string
  state: string
}

export function createAuthCodeListener(options: {
  port: number
  path: string
}): Promise<CallbackRequest> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const parsed = parse(req.url || '', true)
      
      if (parsed.pathname === options.path) {
        const query = parsed.query
        
        if (query.error) {
          res.writeHead(400)
          res.end(`Authorization failed: ${query.error}`)
          server.close()
          reject(new OAuthError(query.error_description as string))
          return
        }
        
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`
          <html>
            <body>
              <h1>Authorization Successful</h1>
              <p>You can close this window and return to Claude Code.</p>
            </body>
          </html>
        `)
        
        server.close()
        resolve({
          code: query.code as string,
          state: query.state as string
        })
      } else {
        res.writeHead(404)
        res.end('Not found')
      }
    })
    
    server.listen(options.port, () => {
      console.log(`Callback server listening on port ${options.port}`)
    })
    
    // 5 分钟超时
    setTimeout(() => {
      server.close()
      reject(new OAuthError('Callback timeout'))
    }, 5 * 60 * 1000)
  })
}
```

## 错误处理

### OAuth 错误类型

```typescript
// OAuth 错误类
export class OAuthError extends Error {
  constructor(
    message: string,
    public code?: OAuthErrorCode,
    public description?: string
  ) {
    super(message)
    this.name = 'OAuthError'
  }
}

export type OAuthErrorCode =
  | 'invalid_request'
  | 'unauthorized_client'
  | 'access_denied'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'server_error'
  | 'temporarily_unavailable'
  | 'invalid_grant'
  | 'invalid_client'
  | 'unsupported_grant_type'
  | 'scope_required'
  | 'token_expired'
```

### 错误处理

```typescript
// 处理 OAuth 错误
function handleOAuthError(error: OAuthError): void {
  switch (error.code) {
    case 'access_denied':
      console.error('Authorization denied by user')
      break
      
    case 'invalid_grant':
    case 'token_expired':
      // 清除本地存储，重新授权
      clearStoredTokens()
      console.error('Token expired, please re-authorize')
      break
      
    case 'unauthorized_client':
      console.error('Client not authorized. Check client ID configuration.')
      break
      
    default:
      console.error(`OAuth error: ${error.message}`)
  }
}
```

## 最佳实践

### 安全实践

```typescript
// 必须使用 PKCE
async function secureOAuthFlow(): Promise<AuthToken> {
  // 1. 生成强随机 verifier
  const verifier = generateRandomString(64)
  
  // 2. 使用 S256 code challenge
  const challenge = await generateCodeChallenge(verifier)
  
  // 3. 生成随机 state 防 CSRF
  const state = generateRandomString(32)
  
  // 4. 验证 state 回调
  // (在回调处理中验证)
  
  return tokens
}

// Token 刷新策略
async function refreshTokenIfNeeded(): Promise<string> {
  const tokens = await loadTokens()
  
  // 提前 5 分钟刷新
  const bufferMs = 5 * 60 * 1000
  const expiresAt = tokens.expiresAt || 0
  
  if (expiresAt - Date.now() < bufferMs) {
    return (await refreshAccessToken(tokens.refreshToken)).accessToken
  }
  
  return tokens.accessToken
}
```

### 错误恢复

```typescript
// 带重试的 token 刷新
async function refreshWithRetry(
  refreshToken: string,
  maxRetries = 3
): Promise<AuthToken> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await oauthClient.refreshToken(refreshToken)
    } catch (error) {
      if (error.code === 'invalid_grant') {
        // refresh token 失效，需要重新授权
        throw error
      }
      
      if (i === maxRetries - 1) {
        throw error
      }
      
      // 指数退避
      await sleep(Math.pow(2, i) * 1000)
    }
  }
  throw new Error('Unreachable')
}
```

## 相关文档

- [MCP 协议](./mcp.md) - MCP OAuth 集成
- [远程会话](./remote-sessions.md) - 远程认证流程
- [权限系统](./permissions.md) - 认证后权限管理
