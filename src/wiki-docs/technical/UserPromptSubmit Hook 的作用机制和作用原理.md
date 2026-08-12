# UserPromptSubmit Hook 的作用机制和作用原理

## 1. 事件定义

`UserPromptSubmit` 是 Claude Code hook 系统中的 27 个事件之一，它在用户提交 prompt 后触发。

**所有 HookEvent 列表**（[coreTypes.ts:25-53](src/entrypoints/sdk/coreTypes.ts#L25-L53)）：

```
PreToolUse, PostToolUse, PostToolUseFailure, Notification,
UserPromptSubmit,           ← ← ← 本文分析对象
SessionStart, SessionEnd, Stop, StopFailure,
SubagentStart, SubagentStop, PreCompact, PostCompact,
PermissionRequest, PermissionDenied, Setup,
TeammateIdle, TaskCreated, TaskCompleted,
Elicitation, ElicitationResult, ConfigChange,
WorktreeCreate, WorktreeRemove, InstructionsLoaded,
CwdChanged, FileChanged
```

---

## 2. 注册方式

Hook 可以通过以下四种途径注册：

| 注册途径 | 持久性 | 来源 |
|----------|--------|------|
| **settings.json** | 持久化 | `~/.claude/settings.json` 或项目级 `.claude/settings.json` |
| **session hooks** | 当前会话有效 | 通过 `addSessionHook()` 动态注册 |
| **function hooks** | 当前会话有效 | 通过 `addFunctionHook()` 注册，TypeScript 回调 |
| **internal hooks** | 系统内置 | 系统内部回调（文件访问控制、attribution 等） |

**Matcher 机制**：每个 hook 可以关联一个 matcher（内容匹配模式），用于按 prompt 内容选择性触发。同一个事件下可以注册多个不同 matcher 的 hook。

### 注册数据结构

```
UserPromptSubmit → [{ matcher: "review:*", hooks: [HookCommand, ...] },
                    { matcher: "*",         hooks: [HookCommand, ...] }]
```

---

## 3. 触发位置与时机

**文件路径**：[processUserInput.ts:178-263](src/utils/processUserInput/processUserInput.ts#L178-L263)

**触发时序**：

```
用户提交 prompt
     │
     ▼
processUserInputBase()
  └ 解析 slash 命令（/compact, /resume 等）
  └ 处理 bash 命令
  └ 处理 @agent 提及
  └ 提取附件（文件/截图/IDE 选择/agent mention）
  └ 构建 UserMessage
  └ 返回 { messages, shouldQuery }
     │
     ▼  (仅当 shouldQuery === true)
     │
executeUserPromptSubmitHooks()  ← ← ← 此处触发
     │
     ▼
query loop → callModel()  ← API 调用
```

**关键条件**：Hook 仅在 `processUserInputBase()` 返回 `shouldQuery=true` 时执行。如果输入是 `/compact` 这样的 slash 命令（shouldQuery=false），则**不会**触发 UserPromptSubmit hooks。

---

## 4. 执行流程

### 4.1 executeUserPromptSubmitHooks

**文件路径**：[hooks.ts:3826-3855](src/utils/hooks.ts#L3826-L3855)

```typescript
export async function* executeUserPromptSubmitHooks(
  prompt: string,           // 用户的原始 prompt 内容
  permissionMode: string,    // 权限模式
  toolUseContext,            // 当前 tool use 上下文
  requestPrompt?,            // UI 提示回调
): AsyncGenerator<AggregatedHookResult> {

  // 1. 快速检查——不存在该事件的 hook 时直接 return
  if (!hasHookForEvent('UserPromptSubmit', appState, sessionId)) {
    return
  }

  // 2. 构建 hook 输入
  const hookInput: UserPromptSubmitHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'UserPromptSubmit',
    prompt,  // ← 用户的原始 prompt
  }

  // 3. 委托给 executeHooks 执行
  yield* executeHooks({ hookInput, toolUseID, signal, timeoutMs, ... })
}
```

### 4.2 executeHooks 核心执行逻辑

**文件路径**：[hooks.ts:1952-2067](src/utils/hooks.ts#L1952-L2067)

```
executeHooks()
  │
  ├─ 1. 安全检查
  │   └─ shouldDisableAllHooksIncludingManaged()  ← 全局禁用
  │   └─ CLAUDE_CODE_SIMPLE 模式跳过
  │   └─ shouldSkipHookDueToTrust()               ← workspace trust 检查
  │
  ├─ 2. 查找匹配 hooks
  │   └─ getMatchingHooks(appState, sessionId, 'UserPromptSubmit', hookInput, tools)
  │   └─ 无匹配时直接 return
  │
  ├─ 3. 快速路径（所有 hook 都是 internal callback）
  │   └─ 直接遍历调用 callback()
  │   └─ 跳过 IO/超时/span 开销（~70% 加速）
  │
  └─ 4. 正常路径（有用户定义的 shell hook）
      │
      ├─ 打开每个 hook 的子进程
      ├─ 设置超时（TOOL_HOOK_EXECUTION_TIMEOUT_MS）
      ├─ 设置 abortController.signal
      ├─ 将 hookInput JSON 写入子进程 stdin
      ├─ 读取 stdout/stderr
      ├─ 进度输出时 yield AggregatedHookResult
      └─ 解析输出 → Zod Schema 验证 → yield 最终结果
```

### 4.3 Hook Input 结构（UserPromptSubmitHookInput）

**文件路径**：[coreSchemas.ts:484-491](src/entrypoints/sdk/coreSchemas.ts#L484-L491)

```typescript
{
  // 继承 BaseHookInput
  config_dir: string,
  transcript_dir: string,
  transcript_file: string,
  session_id: string,
  permission_mode: string,
  user_id?: string,
  agent_type?: string,
  model?: string,

  // UserPromptSubmit 专属字段
  hook_event_name: 'UserPromptSubmit',
  prompt: string,   // 用户的原始 prompt
}
```

---

## 5. Hook 输出协议

Hook 通过 stdout 输出 JSON，由 `AggregatedHookResult` 类型定义。`processUserInput` 按以下优先级处理：

| Hook 输出 | 处理方式 | 最终效果 |
|-----------|----------|----------|
| `blockingError` | 返回系统级错误消息 | `shouldQuery=false`，**不发送 LLM 请求**，显示错误信息 + 原始 prompt |
| `preventContinuation` | 追加停止原因消息 | `shouldQuery=false`，停止处理但保留原始 prompt 在上下文中 |
| `additionalContexts[]` | 追加 `hook_additional_context` 类型附件 | 附加内容**与用户输入一起发送给 LLM** |
| `message.attachment.type === 'hook_success'` | 追加 hook 返回的附件消息（截断到 10K 字符） | **发送给 LLM** |
| 其他 attachment 类型 | 按对应类型追加 | **发送给 LLM** |
| 无特殊输出（默认） | 不修改消息列表 | `shouldQuery=true`，**正常发送给 LLM** |

**输出截断保护**：`MAX_HOOK_OUTPUT_LENGTH = 10,000` 字符，超过时截断并追加截断标记。

---

## 6. 完整数据流

```
用户输入 "请帮我重构这个函数"
     │
     ▼
processUserInput("请帮我重构这个函数", ...)
     │
     ├─ processUserInputBase()
     │   ├─ 检测非 slash 命令 → 进入常规 prompt 路径
     │   ├─ 提取附件（文件、IDE 选择等）
     │   └─ 返回 { messages: [UserMessage], shouldQuery: true }
     │
     ├─ hasHookForEvent('UserPromptSubmit') ?
     │   ├─ NO  ─→ 直接返回，无 Hook 开销 ✅
     │   └─ YES ─→ 继续
     │
     ├─ executeUserPromptSubmitHooks("请帮我重构这个函数", ...)
     │   ├─ getMatchingHooks() → 从 settings + session 中过滤
     │   │   ├─ userSettings:  [UserPromptSubmit, matcher="*", command="..."]
     │   │   └─ sessionHooks: []
     │   │
     │   ├─ 对每个匹配 hook:
     │   │   ├─ 创建子进程
     │   │   ├─ 写入 hookInput（JSON）
     │   │   ├─ 读取 stdout
     │   │   └─ yield AggregatedHookResult
     │   │
     │   └─ for await...of 处理结果:
     │       ├─ blockingError?       → return { shouldQuery: false }
     │       ├─ preventContinuation? → push stop message, return
     │       ├─ additionalContexts?   → push hook_additional_context attachment
     │       ├─ hook_success?        → push attachment message
     │       └─ (其他)               → push message
     │
     └─ return { messages, shouldQuery: true/false }
              │
              ▼
         query loop → callModel() 或 停止
```

---

## 7. 关键设计要点

### 7.1 客户端层拦截

Hook 完全在本地 REPL 进程内执行，不修改 API 请求格式。它发生在用户消息构建完成之后、API 调用之前，是一个**预处理拦截点**。

### 7.2 快路径短路

`hasHookForEvent('UserPromptSubmit', ...)` 在 `executeUserPromptSubmitHooks` 的最开头检查，未配置任何该事件 hook 时直接 return。这使得零配置用户的开销接近零。

### 7.3 安全设计

- **Workspace Trust**：所有 hook 需要 workspace trust（防止 RCE）
- **CLAUDE_CODE_SIMPLE 模式**：hook 自动禁用
- **超时保护**：`TOOL_HOOK_EXECUTION_TIMEOUT_MS`
- **AbortController signal**：支持取消

### 7.4 输出截断

`MAX_HOOK_OUTPUT_LENGTH = 10,000` 字符，防止 hook 输出过大致使上下文膨胀。

### 7.5 Matcher 过滤

支持按 prompt 内容做模式匹配，不同内容的 prompt 可以走不同的 hook 逻辑。同一个事件下可以注册多个不同 matcher 的 hook。

### 7.6 内部 Hook 快路径

当所有匹配的 hook 都是 internal callback（而非 shell 命令）时，走快速路径直接调用回调函数，跳过子进程创建、IO、超时等开销，实测加速约 70%（6.01μs → ~1.8μs）。

---

## 8. 与相邻机制的对比

| 机制 | 触发时机 | 作用域 | 是否影响 API 请求 |
|------|----------|--------|-------------------|
| **PreToolUse** | tool 调用前 | 单个 tool 调用 | 可修改 tool input |
| **PostToolUse** | tool 调用后 | 单个 tool 调用 | 可修改 tool output |
| **UserPromptSubmit** | 用户提交 prompt、API 调用前 | 整个用户输入 | 可阻断、可附加上下文 |
| **PreCompact** | 压缩前 | 整个会话 | 影响压缩行为 |
| **PostCompact** | 压缩后 | 整个会话 | 影响压缩结果 |

---

## 9. 用途场景

- **内容过滤**：通过 `blockingError` 阻止不当输入到达 LLM
- **上下文增强**：通过 `additionalContexts` 自动附加外部信息（数据库记录、API 响应等）
- **输入预处理**：通过 `hook_success` 附件注入预处理结果
- **审计日志**：记录所有用户提交的 prompt
- **权限控制**：与 `permissionBehavior` 结合实现细粒度访问控制
- **RAG 集成**：根据 prompt 内容查询外部知识库，将结果作为 `additionalContexts` 注入
