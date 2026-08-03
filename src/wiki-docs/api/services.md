# 服务 API

服务 API 层（`services/api/`）封装了与 Anthropic Claude API 及其配套后端的所有交互，包括模型查询、重试、错误处理、计费配额、会话持久化、账户订阅与文件上传下载。

## API 层架构

```
┌─────────────────────────────────────────────────────────────┐
│                    API Service Layer                         │
├─────────────────────────────────────────────────────────────┤
│  客户端层           │  查询管道          │  重试与错误        │
│  client.ts          │  claude.ts         │  withRetry.ts     │
│  (Direct/Bedrock/   │  (queryModel*)     │  errors.ts        │
│   Vertex/Foundry)   │                    │  errorUtils.ts    │
├─────────────────────────────────────────────────────────────┤
│  计费与配额         │  会话持久化        │  账户与订阅        │
│  usage.ts           │  sessionIngress.ts │  grove.ts         │
│  bootstrap.ts       │                    │  referral.ts      │
│  metricsOptOut.ts   │                    │  adminRequests.ts │
│  overageCreditGrant │                    │  firstTokenDate.ts│
│  ultrareviewQuota   │                    │                   │
├─────────────────────────────────────────────────────────────┤
│  文件 API           │  遥测辅助          │  状态             │
│  filesApi.ts        │  logging.ts        │  emptyUsage.ts    │
│                     │  promptCacheBreak  │  dumpPrompts.ts   │
└─────────────────────────────────────────────────────────────┘
```

所有 OAuth 类端点基于 `getOauthConfig().BASE_API_URL`（生产 `https://api.anthropic.com`，staging `https://api-staging.anthropic.com`）。

## 客户端

位置：`services/api/client.ts`。

### getAnthropicClient

```typescript
export async function getAnthropicClient({
  apiKey, maxRetries, model, fetchOverride, source,
}: { ... }): Promise<Anthropic>
```

支持四种 API provider：

| Provider | 触发环境变量 | 说明 |
|---------|-------------|------|
| Direct API | `ANTHROPIC_API_KEY` | 直连 Anthropic API |
| AWS Bedrock | `CLAUDE_CODE_USE_BEDROCK` | 通过 `@anthropic-ai/bedrock-sdk`，region 可按模型覆盖 |
| Vertex AI | `ANTHROPIC_VERTEX_PROJECT_ID` + GCP 凭证 | region 可按模型硬编码（`VERTEX_REGION_CLAUDE_*`） |
| Foundry (Azure) | `ANTHROPIC_FOUNDRY_RESOURCE` 或 `ANTHROPIC_FOUNDRY_BASE_URL` | API key 或 Azure AD DefaultAzureCredential |

默认 headers：

```typescript
const defaultHeaders = {
  'x-app': 'cli',
  'User-Agent': getUserAgent(),
  'X-Claude-Code-Session-Id': getSessionId(),
  ...customHeaders,                                          // ANTHROPIC_CUSTOM_HEADERS
  ...(containerId ? { 'x-claude-remote-container-id': containerId } : {}),
  ...(remoteSessionId ? { 'x-claude-remote-session-id': remoteSessionId } : {}),
  ...(clientApp ? { 'x-client-app': clientApp } : {}),       // SDK 消费方标识
}
```

### 请求 ID 注入

`buildFetch` 在 firstParty + 官方 base URL 时为每个请求注入 `x-client-request-id`（`randomUUID()`），让超时（无服务端 request ID）也能与服务端日志关联：

```typescript
export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'
```

### OAuth token 刷新

`checkAndRefreshOAuthTokenIfNeeded()` 在创建客户端前检查并刷新过期 token；非订阅者走 `configureApiKeyHeaders`。

## 查询管道

位置：`services/api/claude.ts`（3419 行，API 层核心）。

### 查询入口

| 函数 | 说明 |
|------|------|
| `queryModelWithStreaming({ messages, systemPrompt, thinkingConfig, tools, signal, options })` | 流式查询，返回 `AsyncGenerator<StreamEvent \| AssistantMessage \| SystemAPIErrorMessage>` |
| `queryModelWithoutStreaming(...)` | 非流式，返回单个 `AssistantMessage`（内部仍消费流式生成器） |
| `queryHaiku({ systemPrompt, userPrompt, outputFormat, signal, options })` | 用 small fast model 做一次性非流式查询（thinking 禁用、无工具） |
| `queryWithModel({ ... })` | 指定模型的查询管道，走完整鉴权与 betas |

内部 `queryModel` 是核心 async generator，负责：off-switch 检查、previousRequestId 推导、模型解析、betas 合并、cache breakpoint 注入、请求构建、流处理、usage 累积、成本累加。

### Options 类型

```typescript
export type Options = {
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  model: string
  toolChoice?: BetaToolChoiceTool | BetaToolChoiceAuto
  isNonInteractiveSession: boolean
  extraToolSchemas?: BetaToolUnion[]
  maxOutputTokensOverride?: number
  fallbackModel?: string
  onStreamingFallback?: () => void
  querySource: QuerySource
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
  hasAppendSystemPrompt: boolean
  fetchOverride?: ClientOptions['fetch']
  enablePromptCaching?: boolean
  skipCacheWrite?: boolean
  temperatureOverride?: number
  effortValue?: EffortValue
  mcpTools: Tools
  hasPendingMcpServers?: boolean
  queryTracking?: QueryChainTracking
  agentId?: AgentId
  outputFormat?: BetaJSONOutputFormat
  fastMode?: boolean
  advisorModel?: string
  addNotification?: (notif: Notification) => void
  taskBudget?: { total: number; remaining?: number }
}
```

### Prompt 缓存

```typescript
export function getCacheControl({ scope, querySource }: { ... }): { type: 'ephemeral'; ttl?: '1h'; scope?: CacheScope }
```

- **1h TTL 门控**：`should1hCacheTTL(querySource)` 检查用户资格（ant 或订阅者未超额）+ GrowthBook `allowlist`（如 `["repl_main_thread*", "sdk", "agent:*"]`）；资格在 `STATE` 中 latch，防止会话中翻转破坏服务端缓存
- **Bedrock 例外**：3P Bedrock 用户通过 `ENABLE_PROMPT_CACHING_1H_BEDROCK` 开启 1h TTL，无需 GrowthBook
- **`addCacheBreakpoints`**：在每个请求的最后一条消息放唯一 `cache_control` marker（`skipCacheWrite` 时移到倒数第二条，让 fork 不污染 KVCC）
- **`buildSystemPromptBlocks`**：把 system prompt 拆分为 text 块，按 `cacheScope` 注入 `cache_control`
- **`getPromptCachingEnabled(model)`**：按模型判断是否启用 prompt caching

### Usage 累积

```typescript
export function updateUsage(usage: Readonly<NonNullableUsage>, partUsage: BetaMessageDeltaUsage | undefined): NonNullableUsage
export function accumulateUsage(totalUsage, messageUsage): NonNullableUsage
```

流式过程中用 `updateUsage` 合并增量 delta usage（input/cache_creation/cache_read/output/server_tool_use/cache_creation.ephemeral_*），`accumulateUsage` 累加总额。

### 其他工具

| 函数 | 作用 |
|------|------|
| `getAPIMetadata()` | 构造 `metadata.user_id`（含 device_id/account_uuid/session_id），从 `CLAUDE_CODE_EXTRA_METADATA` 合并额外字段 |
| `verifyApiKey(apiKey, isNonInteractiveSession)` | 用 small fast model 发一条 `max_tokens:1` 请求验证 key |
| `getExtraBodyParams(betaHeaders?)` | 构造 `extra_body` 参数 |
| `getPromptCachingEnabled(model)` | 模型是否支持 prompt caching |
| `cleanupStream(stream)` | 流结束后清理 |
| `MAX_NON_STREAMING_TOKENS = 64_000` | 非流式请求的 max_tokens 上限（绕过 SDK 的 21333 限制） |
| `getMaxOutputTokensForModel(model)` | 模型最大输出 token |

## 重试

位置：`services/api/withRetry.ts`。

### withRetry

```typescript
export async function* withRetry<T>(
  getClient: () => Promise<Anthropic>,
  operation: (client: Anthropic, attempt: number, context: RetryContext) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T>
```

- **`RetryOptions`**：`maxRetries`、`model`、`fallbackModel`、`thinkingConfig`、`fastMode`、`signal`、`querySource`、`initialConsecutive529Errors`
- **`CannotRetryError`**：不可重试的错误（包装 originalError + retryContext）
- **`FallbackTriggeredError`**：模型降级触发（originalModel → fallbackModel）
- **`getRetryDelay(attempt, retryAfterHeader, maxDelayMs=32000)`**：指数退避 `BASE_DELAY_MS * 2^(attempt-1)` + 25% jitter，优先用 `retry-after` 头
- **`getDefaultMaxRetries()`**：读 `CLAUDE_CODE_MAX_RETRIES`，否则默认值
- **529 处理**：连续 529 计数，达阈值触发 fallback；`initialConsecutive529Errors` 让流式 529 计入非流式 fallback 的额度
- **`parseMaxTokensContextOverflowError`**：解析 `input length and max_tokens exceed context limit` 错误，返回 `{ inputTokens, maxTokens, contextLimit }`
- **`is529Error(error)`**：判断过载错误
- **fast mode 冷却**：`isFastModeCooldown` / `triggerFastModeCooldown` / `handleFastModeOverageRejection`
- **mock rate limit**：`USER_TYPE=ant` 时 `checkMockRateLimitError` 用于 `/mock-limits` 命令

```typescript
export const BASE_DELAY_MS = 500
```

## 错误处理

位置：`services/api/errors.ts` + `services/api/errorUtils.ts`。

### 错误消息常量

```typescript
export const API_ERROR_MESSAGE_PREFIX = 'API Error'
export const PROMPT_TOO_LONG_ERROR_MESSAGE = 'Prompt is too long'
export const CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE = 'Credit balance is too low'
export const INVALID_API_KEY_ERROR_MESSAGE = 'Not logged in · Please run /login'
export const INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL = /* ... */
```

### 错误构建

- `createSystemAPIErrorMessage` / `NO_RESPONSE_REQUESTED`：构造系统 API 错误消息，`NO_RESPONSE_REQUESTED` 表示不向用户显示
- `createAssistantAPIErrorMessage`：构造助手消息形式的错误
- 特定错误识别：`isPromptTooLongMessage`、`isMediaSizeError`、`isRateLimitError`、`isOverloadedError`

### 连接错误诊断（errorUtils.ts）

```typescript
export function extractConnectionErrorDetails(error: unknown): ConnectionErrorDetails | undefined
export function getSSLErrorHint(error: unknown): string | null
export function sanitizeAPIError(apiError: APIError): string   // 清理 HTML 等
export function formatAPIError(error: APIError): string         // 友好格式化
```

`SSL_ERROR_CODES` 集合覆盖 OpenSSL 证书错误（`UNABLE_TO_VERIFY_LEAF_SIGNATURE`、`CERT_HAS_EXPIRED`、`DEPTH_ZERO_SELF_SIGNED_CERT`、`ERR_TLS_CERT_ALTNAME_INVALID` 等），`formatAPIError` 为每种 SSL 错误给出针对性提示。

## 日志

位置：`services/api/logging.ts`。

```typescript
export function logAPIQuery({ model, messagesLength, temperature, betas, permissionMode, querySource, ... }): void
export function logAPIError({ ... }): void
export function logAPISuccessAndDuration({ model, start, ttftMs, usage, attempt, costUSD, ... }): void
```

- **事件**：发 `tengu_api_query` / `tengu_api_error` / `tengu_api_success` 到 1P + Datadog
- **OTel 事件**：同时 `logOTelEvent('api_request'/'api_error')` 发 3P OTel 事件
- **指标**：`addToTotalDurationState` 累加 API 耗时；`textContentLength` / `thinkingContentLength` / `toolUseContentLengths` 按块类型统计
- **网关检测**：`detectGateway({ headers, baseUrl })` 识别请求经过的网关
- **`GlobalCacheStrategy`**：`'tool_based' | 'system_prompt' | 'none'`

```typescript
// emptyUsage.ts — 零初始化 usage，避免循环依赖
export const EMPTY_USAGE: Readonly<NonNullableUsage> = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: 'standard',
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  inference_geo: '',
  iterations: [],
  speed: 'standard',
}
```

## 计费与配额

### 使用量（usage.ts）

```typescript
export type RateLimit = { utilization: number | null; resets_at: string | null }  // 0-100 / ISO8601
export type ExtraUsage = { is_enabled: boolean; monthly_limit: number | null; used_credits: number | null; utilization: number | null }
export type Utilization = {
  five_hour?: RateLimit | null
  seven_day?: RateLimit | null
  seven_day_oauth_apps?: RateLimit | null
  seven_day_opus?: RateLimit | null
  seven_day_sonnet?: RateLimit | null
  extra_usage?: ExtraUsage | null
}

export async function fetchUtilization(): Promise<Utilization | null>  // GET /api/oauth/usage
```

仅在 Claude.ai 订阅者 + 有 profile scope 时查询；OAuth token 过期则跳过避免 401。

### 引导数据（bootstrap.ts）

```typescript
export async function fetchBootstrapData(): Promise<void>  // GET /api/claude_cli/bootstrap
```

返回 `client_data`（客户端配置）与 `additional_model_options`（额外可选模型）。仅 firstParty provider + 有可用 OAuth/API key 时查询；essential-traffic 模式跳过。

### 指标 opt-out（metricsOptOut.ts）

```typescript
export async function checkMetricsEnabled(): Promise<MetricsStatus>  // GET /api/claude_code/organizations/metrics_enabled
```

- 响应 `{ metrics_logging_enabled: boolean }`
- 内存 TTL 1h + 磁盘 TTL 24h，让多次 `claude -p` 合并为 ~1 次/天
- `memoizeWithTTLAsync` 包装

### 其他配额

| 文件 | 端点 | 说明 |
|------|------|------|
| `overageCreditGrant.ts` | GET `/api/oauth/organizations/{org}/overage_credit_grant` | 超额信用赠金资格（1h 缓存） |
| `ultrareviewQuota.ts` | GET `/v1/ultrareview/quota` | ultrareview 配额预览（`reviews_used/limit/remaining/is_overage`） |

## 会话持久化

位置：`services/api/sessionIngress.ts`。

```typescript
export async function appendSessionLog(sessionId: string, entry: TranscriptMessage, url: string): Promise<boolean>
export async function getSessionLogs(sessionId: string, url: string): Promise<Entry[] | null>
export async function getSessionLogsViaOAuth(sessionId: string, accessToken: string, orgUUID: string): Promise<Entry[] | null>
export async function getTeleportEvents(sessionId: string, url: string, accessToken: string, orgUUID: string): Promise<...>
```

- **端点**：`POST/GET /v1/session_ingress/session/{sessionId}`、`GET /v1/code/sessions/{sessionId}/teleport-events`
- **鉴权**：Bearer JWT（`getSessionIngressAuthToken()`，来自文件描述符或 well-known 文件 `CLAUDE_SESSION_INGRESS_TOKEN_FILE`）
- **顺序写入**：per-session `sequential` wrapper 防止并发 append 乱序
- **重试**：`MAX_RETRIES=10`、`BASE_DELAY_MS=500` 指数退避
- **`clearSession` / `clearAllSessions`**：清理 lastUuid 缓存

## 账户与订阅

### Grove（条款确认）

位置：`services/api/grove.ts`。

```typescript
export const getGroveSettings = memoize(async (): Promise<ApiResult<AccountSettings>> => { ... })  // GET /api/oauth/account/settings
export async function updateGroveSettings(settings): Promise<ApiResult<AccountSettings>>          // PUT /api/oauth/account/settings
export async function markGroveNoticeViewed(): Promise<void>                                      // POST /api/oauth/account/grove_notice_viewed
export async function isQualifiedForGrove(): Promise<boolean>                                      // GET /api/claude_code_grove
export async function checkGroveForNonInteractive(): Promise<void>                                 // 非交互模式条款门控
```

`checkGroveForNonInteractive` 在 grace period 内输出信息并继续；grace period 结束后 `gracefulShutdown(1)` 强制用户运行交互式 CLI 确认条款。

### 推荐计划（referral.ts）

```typescript
export async function fetchReferralEligibility(orgUUID, accessToken): Promise<ReferralEligibilityResponse | null>  // GET /api/oauth/organizations/{org}/referral/eligibility
export async function fetchReferralRedemptions(orgUUID, accessToken): Promise<ReferralRedemptionsResponse | null> // GET .../referral/redemptions
export async function fetchAndStorePassesEligibility(): Promise<...>
export async function getCachedOrFetchPassesEligibility(): Promise<...>
```

24h 缓存 + in-flight fetch 去重。

### 管理员请求（adminRequests.ts）

```typescript
export type AdminRequestType = 'limit_increase' | 'seat_upgrade'
export type AdminRequestStatus = 'pending' | 'approved' | 'dismissed'

export async function createAdminRequest(params: AdminRequestCreateParams): Promise<AdminRequest>   // POST /api/oauth/organizations/{org}/admin_requests
export async function getMyAdminRequests(requestType, statuses): Promise<AdminRequest[] | null>     // GET .../admin_requests/me?request_type=...&statuses=...
export async function checkAdminRequestEligibility(requestType): Promise<{ is_allowed: boolean }>  // GET .../admin_requests/eligibility
```

### 首次 token 日期（firstTokenDate.ts）

```typescript
export async function fetchAndStoreClaudeCodeFirstTokenDate(): Promise<void>  // GET /api/organization/claude_code_first_token_date
```

登录成功后调用，缓存用户首次使用 Claude Code 的日期到 global config（`claudeCodeFirstTokenDate`）。

## 文件 API

位置：`services/api/filesApi.ts`。

```typescript
export type File = { fileId: string; relativePath: string }
export type FilesApiConfig = { oauthToken: string; baseUrl?: string; sessionId: string }

export async function downloadFile(config, fileId): Promise<DownloadResult>          // GET /v1/files/{id}/content
export async function downloadAndSaveFile(config, file: File): Promise<DownloadResult>
export async function downloadSessionFiles(config, files: File[]): Promise<DownloadResult[]>
export async function uploadFile(config, content, mimeType?): Promise<UploadResult>  // POST /v1/files
export async function uploadSessionFiles(config, files): Promise<UploadResult[]>
```

- **Beta header**：`files-api-2025-04-14,oauth-2025-04-20`（启用 Bearer OAuth on public-api routes）
- **anthropic-version**：`2023-06-01`
- **base URL**：`ANTHROPIC_BASE_URL` > `CLAUDE_CODE_API_BASE_URL` > `https://api.anthropic.com`
- **用途**：会话启动时下载文件附件、上传会话文件

## 遥测辅助

### Prompt 缓存破坏检测（promptCacheBreakDetection.ts）

```typescript
export function recordPromptState(snapshot: PromptStateSnapshot): void
export async function checkResponseForCacheBreak({ messages, system, tools, ... }): Promise<void>
export function notifyCacheDeletion({ deletedTokens, ... }): void
export function notifyCompaction({ ... }): void
export function cleanupAgentTracking(agentId: AgentId): void
export function resetPromptCacheBreakDetection(): void
export const CACHE_TTL_1HOUR_MS = 60 * 60 * 1000
```

当响应的 cache_read_input_tokens 异常下降时，生成 diff 落盘到 `getClaudeTempDir()/cache-break-<4char>.diff` 用于诊断。

### Prompt 转储（dumpPrompts.ts）

```typescript
export function getLastApiRequests(): Array<{ timestamp: string; request: unknown }>
export function getDumpPromptsPath(agentIdOrSessionId?: string): string
export function createDumpPromptsFetch(fetchOverride): ClientOptions['fetch']
```

- **缓存**：内存保留最近 5 个 API 请求（`MAX_CACHED_REQUESTS=5`），供 `/issue` 命令使用
- **落盘**：按 session/agent 分别转储到 `~/.claude/` 下，含 sha256 去重
- **用途**：ant 调试，提交 issue 时附上最近请求

## 相关文档

- [服务层](../modules/services.md) - 服务层总览
- [遥测和分析](../technical/telemetry.md) - 事件与指标收集
- [远程会话](../technical/remote-sessions.md) - 会话持久化与桥接
- [MCP 协议](../technical/mcp.md) - MCP 工具集成
