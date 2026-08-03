# 权限系统

权限系统管理工具访问、MCP 服务器和用户授权的安全控制。

## 权限架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Permission Layer                          │
├─────────────────────────────────────────────────────────────┤
│  Channel Permissions │  Tool Permissions │  MCP Permissions │
│  - Allowed Tools     │  - Write Access   │  - Server Level  │
│  - Denied Tools      │  - Read Access    │  - Tool Level    │
│  - Always Ask        │  - Execute Access │  - Resource Level│
├─────────────────────────────────────────────────────────────┤
│  User Authorization  │  Session Permissions │  Safety      │
│  - Admin/User Modes  │  - Ephemeral State │  - Guardrails  │
│  - Role-based Access │  - Persistent State│  - Validation  │
└─────────────────────────────────────────────────────────────┘
```

## 通道权限管理

### 权限结构

```typescript
// 通道权限接口
interface ChannelPermissions {
  // 允许的工具列表
  allowedTools: Set<string>
  
  // 拒绝的工具列表
  deniedTools: Set<string>
  
  // 需要询问的工具列表
  alwaysAskTools: Set<string>
  
  // MCP 服务器权限
  allowedMCPServers: Set<string>
  deniedMCPServers: Set<string>
}

// 权限检查结果
interface PermissionResult {
  allowed: boolean
  reason?: 'allowed' | 'denied' | 'ask'
  requiresConfirmation?: boolean
}
```

### 权限检查

```typescript
// 检查工具权限
export function checkToolPermission(
  channel: string,
  toolName: string
): PermissionResult {
  const perms = getChannelPermissions(channel)
  
  // 检查拒绝列表
  if (perms.deniedTools.has(toolName)) {
    return { allowed: false, reason: 'denied' }
  }
  
  // 检查允许列表
  if (perms.allowedTools.has(toolName)) {
    return { allowed: true, reason: 'allowed' }
  }
  
  // 检查是否需要询问
  if (perms.alwaysAskTools.has(toolName)) {
    return { allowed: false, reason: 'ask', requiresConfirmation: true }
  }
  
  // 默认允许
  return { allowed: true, reason: 'allowed' }
}

// MCP 工具权限检查
function getMCPToolPermission(
  toolName: string,
  permissionContext: PermissionContext
): boolean {
  // MCP 工具格式：mcp__server__tool
  const [_, serverName] = toolName.split('__')
  
  // 检查服务器级别的拒绝规则
  if (permissionContext.deniedMCP.has(serverName)) {
    return false
  }
  
  return true
}
```

### 权限更新

```typescript
// 更新通道权限
export function updateChannelPermissions(
  channel: string,
  updates: PermissionUpdates
): void {
  const perms = getChannelPermissions(channel)
  
  if (updates.allowedTools) {
    updates.allowedTools.forEach(tool => perms.allowedTools.add(tool))
  }
  
  if (updates.deniedTools) {
    updates.deniedTools.forEach(tool => perms.deniedTools.add(tool))
  }
  
  if (updates.alwaysAskTools) {
    updates.alwaysAskTools.forEach(tool => perms.alwaysAskTools.add(tool))
  }
  
  saveChannelPermissions(channel, perms)
}
```

## 工具权限分类

### 高风险工具

需要明确授权的工具：

| 工具 | 风险等级 | 默认行为 |
|------|----------|----------|
| `Bash` | 高 | Always Ask |
| `Write` | 高 | Always Ask |
| `Edit` | 高 | Always Ask |
| `NotebookEdit` | 高 | Always Ask |

### 中风险工具

| 工具 | 风险等级 | 默认行为 |
|------|----------|----------|
| `Read` | 中 | Allowed |
| `Glob` | 中 | Allowed |
| `Grep` | 中 | Allowed |

### 低风险工具

| 工具 | 风险等级 | 默认行为 |
|------|----------|----------|
| `TaskCreate` | 低 | Allowed |
| `TaskUpdate` | 低 | Allowed |
| `AskUserQuestion` | 低 | Allowed |

## 用户授权模式

### 管理员模式

```typescript
// 管理员模式配置
interface AdminModeConfig {
  // 允许所有工具无需确认
  allowAllTools: boolean
  
  // 允许 MCP 连接
  allowMCPConnections: boolean
  
  // 允许写操作
  allowWriteOperations: boolean
  
  // 自定义允许列表
  customAllowedTools?: string[]
}

// 检查管理员权限
function isAdminMode(channel: string): boolean {
  const config = getChannelConfig(channel)
  return config.mode === 'admin'
}
```

### 用户模式

```typescript
// 用户模式配置
interface UserModeConfig {
  // 受限工具列表
  restrictedTools: string[]
  
  // 需要确认的操作
  requireConfirmation: string[]
  
  // 最大 token 预算
  maxTokenBudget: number
}

// 检查用户权限
function canExecuteAction(
  channel: string,
  action: string
): boolean {
  const config = getUserModeConfig(channel)
  
  // 检查是否在限制列表中
  if (config.restrictedTools.includes(action)) {
    return false
  }
  
  return true
}
```

## MCP 权限管理

### 服务器权限

```typescript
// MCP 服务器权限配置
interface MCPServerPermissions {
  serverId: string
  allowed: boolean
  allowedTools?: string[]  // 允许的工具子集
  deniedTools?: string[]   // 拒绝的工具子集
  requiresApproval: boolean
}

// 注册 MCP 服务器权限
export function registerMCPServerPermissions(
  serverId: string,
  config: MCPServerPermissions
): void {
  const registry = getMCPPermissionRegistry()
  registry.set(serverId, config)
}

// 检查 MCP 工具调用权限
function canCallMCPTool(
  serverId: string,
  toolName: string
): boolean {
  const perms = getMCPServerPermissions(serverId)
  
  if (!perms.allowed) {
    return false
  }
  
  // 检查工具级别的允许/拒绝列表
  if (perms.deniedTools?.includes(toolName)) {
    return false
  }
  
  if (perms.allowedTools) {
    return perms.allowedTools.includes(toolName)
  }
  
  return true
}
```

### 资源访问权限

```typescript
// MCP 资源权限
interface MCPResourcePermission {
  uri: string
  read: boolean
  write: boolean
  allowedChannels: string[]
}

// 检查资源访问权限
export function checkResourcePermission(
  uri: string,
  channel: string,
  operation: 'read' | 'write'
): boolean {
  const perms = getResourcePermissions(uri)
  
  if (!perms.allowedChannels.includes(channel)) {
    return false
  }
  
  return operation === 'read' ? perms.read : perms.write
}
```

## 会话权限状态

### 临时权限

```typescript
// 会话级别的权限覆盖
interface SessionPermissionOverride {
  sessionId: string
  overrides: Map<string, boolean>  // tool -> allowed
  expiresAt: number
}

// 设置临时权限
export function setSessionPermission(
  sessionId: string,
  toolName: string,
  allowed: boolean,
  durationMs: number
): void {
  const override: SessionPermissionOverride = {
    sessionId,
    overrides: new Map([[toolName, allowed]]),
    expiresAt: Date.now() + durationMs
  }
  
  sessionOverrides.set(sessionId, override)
  
  // 设置自动过期
  setTimeout(() => {
    sessionOverrides.delete(sessionId)
  }, durationMs)
}
```

### 权限继承

```typescript
// 权限继承链
function getEffectivePermissions(channel: string): ChannelPermissions {
  const global = getGlobalPermissions()
  const channelPerms = getChannelPermissions(channel)
  const session = getSessionOverride(channel)
  
  // 合并权限：session > channel > global
  return {
    allowedTools: new Set([
      ...global.allowedTools,
      ...channelPerms.allowedTools,
      ...session.allowedTools
    ]),
    deniedTools: new Set([
      ...global.deniedTools,
      ...channelPerms.deniedTools,
      ...session.deniedTools
    ]),
    alwaysAskTools: new Set([
      ...global.alwaysAskTools,
      ...channelPerms.alwaysAskTools
    ])
  }
}
```

## 安全检查点

### 写操作验证

```typescript
// 写操作前的安全检查
interface WriteSafetyCheck {
  // 文件路径检查
  isPathSafe: boolean
  isExcluded: boolean
  isBinary: boolean
  
  // 内容检查
  containsSecrets: boolean
  containsPII: boolean
  
  // 影响范围
  isCriticalFile: boolean
  affectsBuild: boolean
}

export async function validateWriteOperation(
  filePath: string,
  content: string
): Promise<WriteSafetyCheck> {
  const checks: WriteSafetyCheck = {
    isPathSafe: isPathWithinAllowedDirs(filePath),
    isExcluded: !isExcludedByGitignore(filePath),
    isBinary: await isBinaryFile(filePath),
    containsSecrets: containsSecrets(content),
    containsPII: containsPII(content),
    isCriticalFile: isCriticalFile(filePath),
    affectsBuild: affectsBuild(filePath)
  }
  
  return checks
}
```

### Bash 命令验证

```typescript
// Bash 命令安全检查
const DANGEROUS_PATTERNS = [
  /^rm\s+(-rf|--recursive)/,      // 递归删除
  /^dd\s+/,                        // 磁盘写入
  /^mkfs/,                         // 格式化
  /^:\(\)\{.*\}/,                 // Fork bomb
  /\/dev\/[hs]d[a-z]/,            // 直接磁盘访问
  /chmod\s+[0-7]*777/,            // 过度权限
]

export function validateBashCommand(command: string): SafetyValidation {
  const violations: string[] = []
  
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      violations.push(`Dangerous pattern: ${pattern}`)
    }
  }
  
  return {
    safe: violations.length === 0,
    violations
  }
}
```

## 权限提示

### 用户确认对话框

```typescript
// 权限确认请求
interface PermissionPrompt {
  tool: string
  description: string
  risk: 'low' | 'medium' | 'high'
  details: {
    filePath?: string
    command?: string
    impact?: string
  }
  actions: {
    allow: string
    deny: string
    allowSession: string  // 本次会话允许
    allowAlways: string   // 始终允许
  }
}

// 显示确认对话框
async function showPermissionPrompt(
  prompt: PermissionPrompt
): Promise<'allow' | 'deny' | 'allow-session' | 'allow-always'> {
  // 显示对话框等待用户响应
  return waitForUserDecision(prompt)
}
```

### 权限决策缓存

```typescript
// 权限决策缓存
interface PermissionCache {
  key: string  // hash(tool + context)
  decision: 'allow' | 'deny'
  expiresAt: number
  scope: 'session' | 'channel' | 'global'
}

const permissionCache = new Map<string, PermissionCache>()

// 检查缓存
function getCachedPermission(
  tool: string,
  context: PermissionContext
): 'allow' | 'deny' | null {
  const key = hashPermissionKey(tool, context)
  const cached = permissionCache.get(key)
  
  if (!cached || cached.expiresAt < Date.now()) {
    permissionCache.delete(key)
    return null
  }
  
  return cached.decision
}
```

## 错误处理

### 权限拒绝错误

```typescript
// 权限拒绝错误
export class PermissionDeniedError extends Error {
  constructor(
    message: string,
    public tool: string,
    public channel: string,
    public reason: 'denied' | 'not-allowed' | 'requires-approval'
  ) {
    super(message)
    this.name = 'PermissionDeniedError'
  }
}

// 处理权限拒绝
function handlePermissionDenied(
  error: PermissionDeniedError
): void {
  switch (error.reason) {
    case 'denied':
      logSecurityEvent('TOOL_DENIED', {
        tool: error.tool,
        channel: error.channel
      })
      break
      
    case 'requires-approval':
      requestUserApproval(error.tool)
      break
      
    case 'not-allowed':
      suggestUpgradePermissions(error.tool)
      break
  }
}
```

### 安全事件日志

```typescript
// 记录安全事件
interface SecurityEvent {
  type: 'PERMISSION_GRANTED' | 'PERMISSION_DENIED' | 'ESCALATION'
  timestamp: number
  tool: string
  channel: string
  userId: string
  details: Record<string, unknown>
}

export function logSecurityEvent(
  type: string,
  details: Partial<SecurityEvent>
): void {
  const event: SecurityEvent = {
    type,
    timestamp: Date.now(),
    tool: details.tool || 'unknown',
    channel: details.channel || 'default',
    userId: getCurrentUserId(),
    details: details as Record<string, unknown>
  }
  
  securityLogger.info('SECURITY_EVENT', event)
}
```

## 最佳实践

### 最小权限原则

```typescript
// 默认拒绝，按需允许
const DEFAULT_PERMISSIONS: ChannelPermissions = {
  allowedTools: new Set(['Read', 'Glob', 'Grep']),
  deniedTools: new Set(['Bash', 'Write', 'Edit']),
  alwaysAskTools: new Set(['Bash', 'Write', 'Edit'])
}

// 授予最小必要权限
function grantMinimalPermissions(
  task: string,
  requiredTools: string[]
): ChannelPermissions {
  return {
    allowedTools: new Set(requiredTools),
    deniedTools: new Set(),
    alwaysAskTools: new Set(
      requiredTools.filter(isHighRisk)
    )
  }
}
```

### 权限审计

```typescript
// 定期权限审计
export function auditPermissions(): AuditReport {
  const channels = getAllChannels()
  const issues: PermissionIssue[] = []
  
  for (const channel of channels) {
    const perms = getChannelPermissions(channel)
    
    // 检查过度授权
    if (perms.allowedTools.size > MAX_ALLOWED_TOOLS) {
      issues.push({
        type: 'EXCESSIVE_PERMISSIONS',
        channel,
        severity: 'medium'
      })
    }
    
    // 检查危险组合
    if (perms.allowedTools.has('Bash') && 
        perms.allowedTools.has('Write')) {
      issues.push({
        type: 'DANGEROUS_COMBINATION',
        channel,
        severity: 'high'
      })
    }
  }
  
  return { issues, recommendations: generateRecommendations(issues) }
}
```

## 相关文档

- [MCP 协议](./mcp.md) - MCP 权限集成
- [远程会话](./remote-sessions.md) - 远程权限管理
- [工具系统](../modules/tools.md) - 工具接口规范
