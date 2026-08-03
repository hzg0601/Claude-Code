# 钩子系统

钩子系统在 Claude Code 的关键生命周期事件上运行用户自定义逻辑，可用于拦截工具调用、注入上下文、阻止退出、校验输出等。钩子定义在 `settings.json`、插件 `hooks/hooks.json` 或技能 frontmatter 中。

## 钩子架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Hook System                               │
├─────────────────────────────────────────────────────────────┤
│  事件触发           │  匹配               │  执行             │
│  (HookEvent)        │  getMatchingHooks   │  command/prompt   │
│  PreToolUse         │  (matcher + if)     │  agent/http       │
│  PostToolUse        │                     │                   │
│  SessionStart ...   │                     │                   │
├─────────────────────────────────────────────────────────────┤
│  聚合               │  退出码             │  JSON 输出         │
│  AggregatedHookResult│ 0 / 2 / 其他        │  decision/permit/ │
│                     │                     │  additionalContext│
├─────────────────────────────────────────────────────────────┤
│  集成                                                 │
│  services/tools/toolExecution.ts (pre/post tool)      │
│  utils/hooks.ts (execute* 系列)                       │
│  utils/hooks/ (execAgentHook/execPromptHook/execHttp) │
└─────────────────────────────────────────────────────────────┘
```

## 钩子事件

`HOOK_EVENTS`（`entrypoints/sdk/coreSchemas.ts`）定义全部 27 个事件：

| 类别 | 事件 |
|------|------|
| **工具** | `PreToolUse`、`PostToolUse`、`PostToolUseFailure` |
| **会话** | `SessionStart`、`SessionEnd`、`Setup`、`SubagentStart`、`SubagentStop` |
| **对话** | `UserPromptSubmit`、`Stop`、`StopFailure` |
| **压缩** | `PreCompact`、`PostCompact` |
| **权限** | `PermissionRequest`、`PermissionDenied` |
| **任务** | `TaskCreated`、`TaskCompleted`、`TeammateIdle` |
| **通知** | `Notification` |
| **交互** | `Elicitation`、`ElicitationResult` |
| **环境** | `ConfigChange`、`CwdChanged`、`FileChanged`、`InstructionsLoaded` |
| **Worktree** | `WorktreeCreate`、`WorktreeRemove` |

```typescript
// entrypoints/sdk/coreSchemas.ts
export const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification',
  'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop', 'StopFailure',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact',
  'PermissionRequest', 'PermissionDenied', 'Setup', 'TeammateIdle',
  'TaskCreated', 'TaskCompleted', 'Elicitation', 'ElicitationResult',
  'ConfigChange', 'WorktreeCreate', 'WorktreeRemove',
  'InstructionsLoaded', 'CwdChanged', 'FileChanged',
] as const
```

`SessionStart` 和 `Setup` 是 `ALWAYS_EMITTED_HOOK_EVENTS`——即使无匹配 matcher 也会触发。

## 钩子类型

`schemas/hooks.ts` 定义四种钩子类型（`HookCommandSchema` 的 discriminated union）：

### command（shell 命令）

```typescript
{
  type: 'command',
  command: string,                              // shell 命令
  if?: string,                                  // 权限规则过滤，如 "Bash(git *)"
  shell?: 'bash' | 'powershell',               // 默认 bash
  timeout?: number,                             // 秒
  statusMessage?: string,                       // spinner 文案
  once?: boolean,                               // 运行一次后移除
  async?: boolean,                              // 后台运行不阻塞
  asyncRewake?: boolean,                        // 后台运行，exit 2 时唤醒模型
}
```

通过 `child_process.spawn` 执行（`utils/hooks.ts`），bash 走 `$SHELL`（Git Bash on Windows），powershell 走 `pwsh -NoProfile -NonInteractive`。

### prompt（LLM 评估）

```typescript
{
  type: 'prompt',
  prompt: string,                               // $ARGUMENTS 占位 hook 输入 JSON
  if?: string,
  timeout?: number,
  model?: string,                               // 默认 small fast model
  statusMessage?: string,
  once?: boolean,
}
```

用小模型评估 prompt，结果作为 `additionalContext` 注入。

### agent（agentic verifier）

```typescript
{
  type: 'agent',
  prompt: string,                               // 校验描述，如 "Verify tests ran and passed"
  if?: string,
  timeout?: number,                             // 默认 60
  model?: string,                               // 默认 Haiku
  statusMessage?: string,
  once?: boolean,
}
```

启动子代理校验某个条件。注意：此 schema 不可加 `.transform()`（会被 `updateSettingsForSource` 的 JSON.stringify 丢掉，见 gh-24920）。

### http（HTTP POST）

```typescript
{
  type: 'http',
  url: string,
  if?: string,
  timeout?: number,
  headers?: Record<string, string>,            // 支持 $VAR / ${VAR} 插值
  allowedEnvVars?: string[],                   // 允许插值的 env var 名单（必需）
  statusMessage?: string,
  once?: boolean,
}
```

POST hook 输入 JSON 到指定 URL；`allowedEnvVars` 是 env var 插值白名单，未列入的 `$VAR` 引用留空。

## matcher 与 if 条件

### HookMatcher

```typescript
// schemas/hooks.ts
const HookMatcherSchema = z.object({
  matcher?: z.string().optional(),    // 按事件类型匹配 tool_name / source / trigger / reason
  hooks: z.array(HookCommandSchema()),
})
```

`matcher` 的语义按事件分（`getMatchingHooks`）：

| 事件 | matchQuery 来源 |
|------|----------------|
| `PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `PermissionRequest` / `PermissionDenied` | `hookInput.tool_name` |
| `SessionStart` | `hookInput.source` |
| `Setup` / `PreCompact` / `PostCompact` | `hookInput.trigger` |
| `Notification` | `hookInput.notification_type` |
| `SessionEnd` | `hookInput.reason` |

### IfConditionSchema

```typescript
const IfConditionSchema = z.string().optional()
// 用权限规则语法，如 "Bash(git *)"、"Read(*.ts)"
```

`if` 在 spawn 前用权限规则语法匹配 `tool_name` 与 `tool_input`，避免为不匹配的命令起进程。

## 配置位置

### settings.json

```typescript
// schemas/hooks.ts
export const HooksSchema = lazySchema(() =>
  z.partialRecord(z.enum(HOOK_EVENTS), z.array(HookMatcherSchema())),
)
export type HooksSettings = Partial<Record<HookEvent, HookMatcher[]>>
```

`.claude/settings.json` 的 `hooks` 字段以事件名为键：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/usr/local/bin/audit-bash.sh"
          }
        ]
      }
    ]
  }
}
```

### 插件 hooks

插件通过 `hooks/hooks.json`（`PluginHooksSchema`）或 manifest 内联定义，加载时转为 `PluginHookMatcher`（含 `pluginRoot`/`pluginName`/`pluginId` 上下文）。

### 技能 frontmatter

技能可在 frontmatter 声明 hooks，转为 `SkillHookMatcher`（含 `skillRoot`/`skillName`）。

## 退出码语义（command 类型）

| 退出码 | 含义 |
|--------|------|
| 0 | 成功，继续 |
| 2 | **blocking error**——阻塞当前操作，stderr 作为错误消息 |
| 其他 | 非阻塞错误，记录但不阻塞 |

```typescript
// utils/hooks.ts
// code 2 (blocking error), enqueue as a task-notification so it wakes the
exitCode: result.code,
outcome: result.code === 0 ? 'success' : 'error',
```

## JSON 输出协议

command 类型钩子可在 stdout 输出 JSON 控制行为：

```typescript
{
  "continue": true,                 // 是否继续
  "suppressOutput": false,          // 是否抑制输出
  "stopReason": "string",           // 停止原因
  "decision": "approve" | "block",  // 决策
  "reason": "string",               // 决策原因
  "systemMessage": "string",        // 系统消息
  "permissionDecision": "allow" | "deny" | "ask",
  "hookSpecificOutput": {           // 按事件分支
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow" | "deny" | "ask",
    "permissionDecisionReason": "string",
    "updatedInput": { ... }         // 修改后的工具输入
  }
}
```

### 按事件的 hookSpecificOutput

| 事件 | 专属字段 |
|------|---------|
| `PreToolUse` | `permissionDecision`、`permissionDecisionReason`、`updatedInput`、`additionalContext` |
| `UserPromptSubmit` | `additionalContext`（必填） |
| `SessionStart` | `additionalContext`、`initialUserMessage`、`watchPaths` |
| `Setup` / `SubagentStart` | `additionalContext` |
| `PostToolUse` | `additionalContext`、`updatedMCPToolOutput` |
| `PostToolUseFailure` | `additionalContext` |
| `PermissionDenied` | `retry` |
| `PermissionRequest` | `decision` |

校验会检查 `hookSpecificOutput.hookEventName` 与期望事件名一致，否则报错。

```typescript
// utils/hooks.ts
if (json.hookSpecificOutput.hookEventName !== expectedHookEvent) {
  throw new Error(`Hook returned incorrect event name: expected '${expectedHookEvent}' but got '${json.hookSpecificOutput.hookEventName}'`)
}
```

## 执行流程

`utils/hooks.ts` 为每个事件提供 `execute*` async generator：

```typescript
export async function* executePreToolHooks<ToolInput>(
  toolName: string, toolUseID: string, toolInput: ToolInput,
  toolUseContext: ToolUseContext, permissionMode?: string, signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  ...
): AsyncGenerator<AggregatedHookResult>

export async function* executePostToolHooks<ToolInput, ToolResponse>(...)
export async function* executePostToolUseFailureHooks<ToolInput>(...)
export async function* executePermissionDeniedHooks<ToolInput>(...)
export async function executeNotificationHooks(...)
export async function executeStopFailureHooks(...)
export async function* executeStopHooks(...)
export async function* executeTeammateIdleHooks(...)
export async function* executeTaskCreatedHooks(...)
export async function* executeTaskCompletedHooks(...)
export async function* executeUserPromptSubmitHooks(...)
export async function* executeSessionStartHooks(...)
export async function* executeSetupHooks(...)
export async function* executeSubagentStartHooks(...)
export async function executePreCompactHooks(...)
export async function executePostCompactHooks(...)
export async function executeSessionEndHooks(...)
export async function* executePermissionRequestHooks<ToolInput>(...)
export async function executeConfigChangeHooks(...)
```

每个 executor：

1. 检查 `hasHookForEvent(event, appState, sessionId)`，无配置直接返回
2. 构造 `createBaseHookInput(permissionMode, ...)` + 事件专属字段
3. `getMatchingHooks(appState, sessionId, hookEvent, hookInput, tools)` 按 `matchQuery` 筛选
4. 对每个匹配 matcher 执行其 hooks（command/prompt/agent/http）
5. 聚合为 `AggregatedHookResult`

### 聚合结果

`AggregatedHookResult` 合并所有匹配 hook 的输出：

- `permissionBehavior: 'allow' | 'deny' | 'ask'`
- `blockingError`（code 2 时）
- `additionalContext`（注入下一条消息）
- `stopReason` / `shouldPreventContinuation`
- `updatedInput` / `updatedMCPToolOutput`
- `retry`（PermissionDenied）

## 工具执行集成

`services/tools/toolExecution.ts` 在每次工具调用前后集成 pre/post hook：

```typescript
// pre-tool hook 计时
const preToolHookStart = Date.now()
for await (const result of executePreToolHooks(tool.name, toolUseID, toolInput, toolUseContext, ...)) {
  // 处理 permissionBehavior / stopReason / additionalContext / stop
}
const preToolHookDurationMs = Date.now() - preToolHookStart
getStatsStore()?.observe('pre_tool_hook_duration_ms', preToolHookDurationMs)
if (preToolHookDurationMs >= SLOW_PHASE_LOG_THRESHOLD_MS) {
  logForDebugging(`Slow PreToolUse hooks: ${preToolHookDurationMs}ms for ${tool.name}`)
}
```

`statsStore.observe('pre_tool_hook_duration_ms', ...)` 与 `'hook_duration_ms'`（`utils/hooks.ts`）记录耗时指标。

## 生命周期钩子

### SessionStart

- **always emitted**：即使无 matcher 也触发（`ALWAYS_EMITTED_HOOK_EVENTS`）
- `matchQuery = hookInput.source`（如 `startup`、`resume`、`clear`）
- 可输出 `initialUserMessage`（注入首条用户消息）、`watchPaths`（触发文件监听）
- 用于计算 `CLAUDE_ENV_FILE` 路径

### Setup

- always emitted
- `matchQuery = hookInput.trigger`

### SessionEnd

- `getSessionEndHookTimeoutMs()` 返回关停超时
- `matchQuery = hookInput.reason`（如 `normal`、`crash`）

### Trust 检查

`shouldSkipHookDueToTrust()` 在未通过 trust 对话时跳过部分 hook，避免在不受信项目里执行用户 hook 命令。

## 配置示例

### PreToolUse 拦截 Bash

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.tool_input.command' | grep -qE '^(rm|dd|mkfs)' && exit 2 || exit 0",
            "shell": "bash",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

匹配 `Bash` 工具，检查命令是否危险；危险则 exit 2 阻塞。

### UserPromptSubmit 注入上下文

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"当前分支：$(git branch --show-current)\"}}'"
          }
        ]
      }
    ]
  }
}
```

每次用户提交 prompt 时注入当前 git 分支。

### Stop 阻止退出

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "git status --porcelain | grep -q . && { echo '有未提交改动'; exit 2; } || exit 0"
          }
        ]
      }
    ]
  }
}
```

有未提交改动时阻止 Claude 退出。

### SessionStart 注入环境

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"项目文档在 docs/\"}}'"
          }
        ]
      }
    ]
  }
}
```

### HTTP hook 通知外部服务

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "http",
            "url": "https://hooks.example.com/file-changed",
            "headers": { "Authorization": "Bearer $NOTIFY_TOKEN" },
            "allowedEnvVars": ["NOTIFY_TOKEN"],
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

## 相关文档

- [命令系统](../api/commands.md) - 命令与钩子集成
- [权限系统](./permissions.md) - 工具权限与 matcher 语法
- [服务层](../modules/services.md) - 钩子服务实现
- [技能系统](../modules/skills.md) - 技能 frontmatter hooks
