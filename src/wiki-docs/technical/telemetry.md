# 遥测和分析

Claude Code 的遥测系统采集使用指标、性能数据与事件日志，用于产品改进、问题诊断与计费。系统基于 OpenTelemetry，叠加 Anthropic 自有的 1P 事件管道与 Datadog 日志集成，并通过三层门控精确控制数据出口。

## 遥测架构

```
┌─────────────────────────────────────────────────────────────┐
│                    事件层 (Event Layer)                       │
│  logEvent()         logEventAsync()        logOTelEvent()    │
│  (services/analytics/index.ts)  (utils/telemetry/events.ts) │
├─────────────────────────────────────────────────────────────┤
│                    Sink 层 (Sink Layer)                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ 1P Event     │  │ Datadog      │  │ OTel Metrics/    │  │
│  │ Logger       │  │ Tracker      │  │ Logs/Traces      │  │
│  │ (sink.ts)    │  │ (datadog.ts) │  │ (instrumentation)│  │
│  └──────────────┘  └──────────────┘  └──────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                    出口层 (Export Layer)                      │
│  /api/event_logging/batch   Datadog Logs API   OTLP / BQ    │
│  (1P privileged BQ column)  (us5.datadoghq)    (metrics)    │
└─────────────────────────────────────────────────────────────┘
```

位置：`services/analytics/`（事件与 sink）、`utils/telemetry/`（OTel instrumentation）、`utils/telemetryAttributes.ts`（属性构造）、`utils/privacyLevel.ts`（隐私层级）、`bootstrap/state.ts`（计数器与状态）、`cost-tracker.ts`（成本追踪）。

## 三大数据通道

### 1. 1P 事件日志（第一方）

**链路**：`logEvent(eventName, metadata)` → `sink.ts` 的 `logEventImpl` → `firstPartyEventLogger.logEventTo1P` → OTel `BatchLogRecordProcessor` → `FirstPartyEventLoggingExporter` → POST `/api/event_logging/batch`。

```typescript
// services/analytics/index.ts
export function logEvent(eventName: string, metadata: LogEventMetadata): void {
  if (sink === null) {
    eventQueue.push({ eventName, metadata, async: false })  // sink 未就绪时排队
    return
  }
  sink.logEvent(eventName, metadata)
}
```

- **排队机制**：sink 未 attach 前，事件进入 `eventQueue`，`attachAnalyticsSink` 时通过 `queueMicrotask` 异步排空，避免阻塞启动
- **幂等 attach**：`attachAnalyticsSink` 重复调用为 no-op，允许 preAction hook 与 setup() 同时调用
- **批处理配置**：`tengu_1p_event_batch_config`（GrowthBook 动态配置）控制 `scheduledDelayMillis`、`maxExportBatchSize`、`maxQueueSize`、`path`、`baseUrl`
- **失败重试**：`FirstPartyEventLoggingExporter` 内置追加日志、二次退避、401 鉴权降级、健康恢复后立即重试排队事件
- **端点**：默认 `https://api.anthropic.com/api/event_logging/batch`；staging 通过 `ANTHROPIC_BASE_URL` 自动切换

### 2. Datadog 日志

**链路**：`trackDatadogEvent` → 内存批处理 → 定时/批量 flush → POST `https://http-intake.logs.us5.datadoghq.com/api/v2/logs`。

```typescript
// services/analytics/datadog.ts
const DATADOG_LOGS_ENDPOINT = 'https://http-intake.logs.us5.datadoghq.com/api/v2/logs'
const DATADOG_CLIENT_TOKEN = 'pubbbf48e6d78dae54bceaa4acf463299bf'
const DEFAULT_FLUSH_INTERVAL_MS = 15000
const MAX_BATCH_SIZE = 100
```

- **白名单**：仅 `DATADOG_ALLOWED_EVENTS` 集合内的事件名会发送（`tengu_started`、`tengu_api_error`、`tengu_tool_use_success`、`tengu_oauth_*` 等）
- **门控**：`shouldTrackDatadog()` 检查 `tengu_log_datadog_events` GrowthBook gate + `isSinkKilled('datadog')` killswitch
- **基数控制**：外部用户的 model 名归一化为 `MODEL_COSTS` 短名或 `other`；dev 版本截断为 `base+date`；`userBucket` 把 user ID 哈希到 30 个桶
- **tag 字段**：`TAG_FIELDS`（arch/clientType/errorType/http_status/model/platform/provider/subscriptionType/toolName/userType/version 等）转为 `ddtags`
- **flush 控制**：`CLAUDE_CODE_DATADOG_FLUSH_INTERVAL_MS` 可覆盖默认 15s

### 3. OTel 指标 / 日志 / Trace（第三方）

**链路**：`initializeTelemetry()`（`utils/telemetry/instrumentation.ts`）→ 创建 `MeterProvider` / `LoggerProvider` / `TracerProvider` → OTLP exporter 或 BigQuery exporter。

```typescript
// utils/telemetry/instrumentation.ts
export function isTelemetryEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_TELEMETRY)
}
```

- **三信号**：metrics（`OTEL_METRICS_EXPORTER`）、logs（`OTEL_LOGS_EXPORTER`）、traces（`OTEL_TRACES_EXPORTER`），各自 `console` / `otlp` / `none`
- **OTLP 协议**：`grpc` / `http/json` / `http/protobuf`，通过 `OTEL_EXPORTER_OTLP_PROTOCOL` 选择
- **懒加载**：gRPC exporter（~700KB）在用到的协议分支内动态 import，非 gRPC 启动不付费
- **资源属性**：`service.name=claude-code`、`service.version=MACRO.VERSION`、OS / host.arch / WSL 版本

## 隐私层级

`utils/privacyLevel.ts` 定义三级隐私，从宽到严：

| 层级 | 触发环境变量 | 效果 |
|------|-------------|------|
| `default` | — | 全部启用 |
| `no-telemetry` | `DISABLE_TELEMETRY` | 关闭 Datadog / 1P 事件 / 反馈调研 |
| `essential-traffic` | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | 关闭全部非必要流量（遥测 + 自动更新 + grove + 发布说明 + 模型能力等） |

```typescript
// utils/privacyLevel.ts
export function isTelemetryDisabled(): boolean {
  return getPrivacyLevel() !== 'default'
}
```

`services/analytics/config.ts` 的 `isAnalyticsDisabled()` 在以下情况禁用分析：

- `NODE_ENV === 'test'`
- 第三方云提供商（`CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY`）
- 隐私层级为 no-telemetry 或 essential-traffic

## GrowthBook 三层门控

```
┌─────────────────────────────────────────────────┐
│  第一层：编译时 feature()                         │
│  bun:bundle，DCE 移除未启用代码                    │
├─────────────────────────────────────────────────┤
│  第二层：运行时 USER_TYPE                          │
│  'ant'（内部）vs 'external'（外部）                │
├─────────────────────────────────────────────────┤
│  第三层：GrowthBook 远程开关                       │
│  tengu_* 前缀，动态 A/B 控制                       │
└─────────────────────────────────────────────────┘
```

位置：`services/analytics/growthbook.ts`。

- **客户端**：`@growthbook/growthbook`，client key 来自 `constants/keys.ts`
- **用户属性**：`GrowthBookUserAttributes`（id/sessionId/deviceID/platform/accountUUID/subscriptionType/rateLimitTier/firstTokenTime/email/appVersion/github）
- **缓存读取**：`getFeatureValue_CACHED_MAY_BE_STALE` / `getDynamicConfig_CACHED_MAY_BE_STALE` 优先用磁盘缓存，避免阻塞启动；`_BLOCKS_ON_INIT` 变体会等待 GrowthBook 初始化
- **刷新监听**：`onGrowthBookRefresh` 用于在配置刷新后重建 1P logger provider
- **事件采样**：`tengu_event_sampling_config` 动态配置，按事件名配置 `sample_rate`（0–1），`shouldSampleEvent` 决定是否记录
- **per-sink killswitch**：`tengu_frond_boric` 配置（`{ datadog?: boolean, firstParty?: boolean }`），`isSinkKilled(sink)` 在分发点检查；fail-open（缺失配置 = sink 保持开启）

## 指标计数器

`bootstrap/state.ts` 的 `setMeter()` 在 meter 初始化时创建 8 个归因计数器：

| 计数器名 | 单位 | 描述 |
|---------|------|------|
| `claude_code.session.count` | — | 启动的 CLI 会话数 |
| `claude_code.lines_of_code.count` | — | 修改的代码行数（`type=added/removed`） |
| `claude_code.pull_request.count` | — | 创建的 PR 数 |
| `claude_code.commit.count` | — | 创建的 commit 数 |
| `claude_code.cost.usage` | USD | 会话成本 |
| `claude_code.token.usage` | tokens | token 用量（`type=input/output/cacheRead/cacheCreation`） |
| `claude_code.code_edit_tool.decision` | — | Edit/Write/NotebookEdit 权限决策（accept/reject） |
| `claude_code.active_time.total` | s | 总活跃时间 |

```typescript
// entrypoints/init.ts
const createAttributedCounter = (name, options) => {
  const counter = meter?.createCounter(name, options)
  return {
    add(value, additionalAttributes = {}) {
      counter?.add(value, { ...getTelemetryAttributes(), ...additionalAttributes })
    },
  }
}
setMeter(meter, createAttributedCounter)
```

每个计数器在 `add` 时合并 `getTelemetryAttributes()`（user.id / session.id / organization.id / app.version / terminal.type 等，受 `OTEL_METRICS_INCLUDE_*` 基数控制）。

### statsStore（观测值）

`STATE.statsStore` 是一个轻量 `{ observe(name, value) }` 接口，用于非计数型观测：

| 观测名 | 来源 |
|--------|------|
| `hook_duration_ms` | `utils/hooks.ts` 钩子总耗时 |
| `pre_tool_hook_duration_ms` | `services/tools/toolExecution.ts` pre-tool 钩子耗时 |
| `frame_duration_ms` | `interactiveHelpers.tsx` Ink 帧耗时 |

## 成本追踪

位置：`cost-tracker.ts` + `bootstrap/state.ts`。

```typescript
// cost-tracker.ts
export function addToTotalSessionCost(cost: number, usage: Usage, model: string): number {
  const modelUsage = addToTotalModelUsage(cost, usage, model)
  addToTotalCostState(cost, modelUsage, model)

  const attrs = isFastModeEnabled() && usage.speed === 'fast' ? { model, speed: 'fast' } : { model }
  getCostCounter()?.add(cost, attrs)
  getTokenCounter()?.add(usage.input_tokens, { ...attrs, type: 'input' })
  getTokenCounter()?.add(usage.output_tokens, { ...attrs, type: 'output' })
  getTokenCounter()?.add(usage.cache_read_input_tokens ?? 0, { ...attrs, type: 'cacheRead' })
  getTokenCounter()?.add(usage.cache_creation_input_tokens ?? 0, { ...attrs, type: 'cacheCreation' })
  return cost
}
```

- **状态**：`STATE.totalCostUSD`、`STATE.modelUsage[model]`（inputTokens/outputTokens/cacheRead/cacheCreation/webSearchRequests/costUSD/contextWindow/maxOutputTokens）
- **持久化**：`saveCurrentSessionCosts()` 写入 project config（`lastCost`、`lastAPIDuration`、`lastModelUsage`、`lastSessionId` 等）
- **输出**：`formatTotalCost()` 用 chalk 输出成本摘要（退出时由 `costHook.ts` 的 `useCostSummary` 触发）
- **未知成本**：`hasUnknownModelCost` 标记使用了不在 `MODEL_COSTS` 表中的模型，输出时附加警告

## 元数据富化

位置：`services/analytics/metadata.ts` 的 `getEventMetadata()`。

每个 1P 事件在记录时富化以下字段：

| 字段 | 来源 |
|------|------|
| `platform` / `platformRaw` | `getHostPlatformForAnalytics()` / `process.platform` |
| `arch` / `nodeVersion` | `utils/env.ts` |
| `terminal` | `envDynamic.terminal` |
| `packageManagers` / `runtimes` | `env.getPackageManagers()` / `getRuntimes()` |
| `isRunningWithBun` / `isCi` / `isClaubbit` | 环境检测 |
| `isClaudeCodeRemote` / `isLocalAgentMode` / `isConductor` | 运行模式 |
| `version` | `MACRO.VERSION` |
| `isInteractive` / `clientType` / `userType` | `bootstrap/state.ts` |
| `subscriptionType` | `utils/auth.ts` |
| `sweBenchRunId` / `sweBenchInstanceId` / `sweBenchTaskId` | SWE-bench 环境 |

### PII 与脱敏

- **`sanitizeToolNameForAnalytics`**：MCP 工具名 `mcp__<server>__<tool>` 归一化为 `mcp_tool`（避免泄露用户服务器配置），内置工具名（Bash/Read/Write）原样保留
- **`_PROTO_*` 键**：标记为 PII-tagged 的值路由到 BQ 的特权 proto 列；`stripProtoFields` 在 Datadog fanout 前剥离，确保通用后端看不到未脱敏值
- **标记类型**：`AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`（`never` 类型）强制开发者确认字符串值不含代码/路径；`AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED` 标记 PII 路由

## BigQuery 指标出口

位置：`utils/telemetry/bigqueryExporter.ts`。

```typescript
const defaultEndpoint = 'https://api.anthropic.com/api/claude_code/metrics'
```

- **启用条件**（`isBigQueryMetricsEnabled`）：1P API 客户（非订阅者、非 Bedrock/Vertex）或 C4E/Team 用户
- **组织级 opt-out**：`checkMetricsEnabled()`（`services/api/metricsOptOut.ts`）GET `/api/claude_code/organizations/metrics_enabled`，内存 1h + 磁盘 24h 缓存（让 N 次 `claude -p` 合并为 ~1 次/天）
- **导出间隔**：5 分钟（`PeriodicExportingMetricReader`）

## Beta 追踪

### Beta Session Tracing

位置：`utils/telemetry/betaSessionTracing.ts`。

```typescript
export function isBetaTracingEnabled(): boolean {
  return isEnvTruthy(process.env.ENABLE_BETA_TRACING_DETAILED)
    && Boolean(process.env.BETA_TRACING_ENDPOINT)
}
```

- **启用**：`ENABLE_BETA_TRACING_DETAILED=1` + `BETA_TRACING_ENDPOINT=<url>`
- **可见性**：外部用户在 SDK/headless 模式或 gate 允许时启用；ant 用户全模式启用
- **内容规则**：系统提示词 / 模型输出 / 工具对外部可见；思考输出仅 ant 可见
- **功能**：每 agent 消息跟踪（hash 去重）、系统提示词一次性记录、hook 执行 span、详细 `new_context` 属性

### Enhanced Telemetry

位置：`utils/telemetry/sessionTracing.ts`。

```typescript
export function isEnhancedTelemetryEnabled(): boolean {
  if (feature('ENHANCED_TELEMETRY_BETA')) {
    const env = process.env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA ?? process.env.ENABLE_ENHANCED_TELEMETRY_BETA
    // ant 用户或 gate enhanced_telemetry_beta=true
  }
}
```

启用后创建 OTel span 追踪完整工作流：每个用户交互产生 root interaction span，包含 LLM 请求 / 工具调用等子 span。

### Perfetto 追踪（ant-only）

位置：`utils/telemetry/perfettoTracing.ts`。

```bash
CLAUDE_CODE_PERFETTO_TRACE=1              # 输出到 ~/.claude/traces/trace-<session>.json
CLAUDE_CODE_PERFETTO_TRACE=<path>         # 自定义路径
CLAUDE_CODE_PERFETTO_WRITE_INTERVAL_S=30  # 周期写入
```

生成 Chrome Trace Event 格式，可在 ui.perfetto.dev 可视化。包含 agent 层级、API 请求（TTFT/TTLT/prompt 长度/缓存统计）、工具执行、用户输入等待时间。

## 3P OTel 环境变量

| 变量 | 作用 |
|------|------|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | 总开关，启用 3P OTel 出口 |
| `OTEL_METRICS_EXPORTER` / `OTEL_LOGS_EXPORTER` / `OTEL_TRACES_EXPORTER` | 各信号出口（`console` / `otlp` / `none`） |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | OTLP 协议（`grpc` / `http/json` / `http/protobuf`） |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` | OTLP 端点与头 |
| `ANT_OTEL_*` | ant 专用前缀，构建时映射到 `OTEL_*` |
| `OTEL_METRICS_INCLUDE_SESSION_ID` / `_VERSION` / `_ACCOUNT_UUID` | 基数控制（默认 session=true、version=false、account=true） |
| `OTEL_LOG_USER_PROMPTS` | 记录用户 prompt 内容（默认 redacted） |
| `OTEL_LOG_TOOL_DETAILS` | 记录工具详情 |
| `CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS` | 关停超时（默认 2000） |
| `CLAUDE_CODE_OTEL_FLUSH_TIMEOUT_MS` | flush 超时（默认 5000） |
| `CLAUDE_CODE_DATADOG_FLUSH_INTERVAL_MS` | Datadog flush 间隔（默认 15000） |

```typescript
// utils/telemetry/instrumentation.ts — ant 前缀映射
if (process.env.USER_TYPE === 'ant') {
  if (process.env.ANT_OTEL_METRICS_EXPORTER) process.env.OTEL_METRICS_EXPORTER = process.env.ANT_OTEL_METRICS_EXPORTER
  if (process.env.ANT_OTEL_LOGS_EXPORTER) process.env.OTEL_LOGS_EXPORTER = process.env.ANT_OTEL_LOGS_EXPORTER
  // ...
}
```

## 初始化与关停

### 启动顺序

```
1. init() (entrypoints/init.ts)
   ├─ enableConfigs()
   ├─ applySafeConfigEnvironmentVariables()
   ├─ initialize1PEventLogging()  ← 异步，加载 OTel sdk-logs
   └─ initializeGrowthBook()      ← 异步

2. initSinks() (utils/sinks.ts)   ← preAction hook + setup() 都调用，幂等
   ├─ initializeErrorLogSink()
   └─ initializeAnalyticsSink()   ← attachAnalyticsSink，排空队列

3. initializeAnalyticsGates()     ← main.tsx 调用，读取 Datadog gate

4. initializeTelemetryAfterTrust() ← trust 对话后
   └─ doInitializeTelemetry()
      └─ setMeterState() → initializeTelemetry() → setMeter()
```

### 关停

`utils/gracefulShutdown.ts` 在退出前（500ms cap）执行：

```typescript
await Promise.race([
  Promise.all([shutdown1PEventLogging(), shutdownDatadog()]),
  sleep(500),
])
```

OTel provider 的 `shutdownTelemetry` 通过 `registerCleanup` 注册，在 `CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS` 内 forceFlush + shutdown。

`/logout` 命令显式调用 `flushTelemetry()` 防止 org 切换时数据泄漏。

## 事件命名约定

- **`tengu_*`**：内部事件名前缀（如 `tengu_api_query`、`tengu_api_success`、`tengu_api_error`、`tengu_tool_use_success`、`tengu_oauth_success`、`tengu_init`、`tengu_exit`）
- **API 日志**：`services/api/logging.ts` 的 `logAPIQuery` / `logAPISuccessAndDuration` / `logAPIError` 发 `tengu_api_*` 事件，同时通过 `logOTelEvent('api_request'/'api_error')` 发 3P OTel 事件
- **`claude_code.*`**：OTel event logger 的 body 前缀（`com.anthropic.claude_code.events`）

## 相关文档

- [架构设计](../architecture.md) - 系统分层总览
- [服务层](../modules/services.md) - 分析服务实现
- [OAuth 认证](./oauth.md) - 账户与订阅类型
- [服务 API](../api/services.md) - 计费与配额接口
