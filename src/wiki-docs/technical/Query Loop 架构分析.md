# Claude Code Query Loop 架构分析

## 概述

Claude Code 的 query loop 是一个 **`while(true)` 异步生成器**（`queryLoop`），位于 [query.ts:241-1729](src/query.ts#L241-L1729)。每轮迭代称为一个 **turn**，包含消息预处理 → API 流式调用 → 工具执行 → 消息组装 → 判断是否继续的完整生命周期。

---

## 1. 外层调用链

```
CLI/REPL/SDK/Remote
    │
    ▼
query({ messages, systemPrompt, toolUseContext, ... })
    │
    ├─ consumedCommandUuids: string[]  ← 记录消费的命令
    │
    ▼
queryLoop(params, consumedCommandUuids)
    │
    ├─ while(true)  ← 核心循环，每轮 = 一个 turn
    │
    ▼
return { reason: 'completed' | 'aborted_streaming' | 'max_turns' | ... }
    │
    ▼
notifyCommandLifecycle(uuid, 'completed')  ← 通知命令完成
```

---

## 2. 单轮 Turn 的完整数据流

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          QUERY LOOP (while true)                                │
│                                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │ PHASE 1: 消息预处理 (Message Preprocessing)                                 │  │
│  │                                                                           │  │
│  │  messages = state.messages                                                │  │
│  │  toolUseContext = state.toolUseContext                                     │  │
│  │                                                                           │  │
│  │  1. getMessagesAfterCompactBoundary(messages)   ← 取 compact boundary 之后 │  │
│  │  2. applyToolResultBudget(messagesForQuery)      ← 过大 tool_result 替换    │  │
│  │  3. snipCompactIfNeeded(messagesForQuery)        ← 裁剪对话头部            │  │
│  │  4. microcompact(messagesForQuery)               ← 微观压缩               │  │
│  │  5. applyCollapsesIfNeeded(messagesForQuery)     ← 上下文折叠（当前禁用的） │  │
│  │  6. autocompact(messagesForQuery)                ← 自动摘要压缩            │  │
│  │      ├─ 超过阈值 → compactConversation()          ← fork agent 调用 LLM   │  │
│  │      └─ 压缩后 → buildPostCompactMessages()       ← 替换为摘要消息        │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
│                                    │                                            │
│                                    ▼                                            │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │ PHASE 2: 阻塞检查 (Blocking Check)                                        │  │
│  │                                                                           │  │
│  │  if 超过 blocking limit → yield error → return { reason: 'blocking_limit'} │  │
│  │  (跳过条件: 刚发生过 compact / querySource 是 compact/session_memory)       │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
│                                    │                                            │
│                                    ▼                                            │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │ PHASE 3: API 流式调用 (Streaming API Call)                                 │  │
│  │                                                                           │  │
│  │  try {                                                                   │  │
│  │    while (attemptWithFallback) {    ← fallback model 重试循环              │  │
│  │      for await (message of callModel({                                    │  │
│  │        messages: prependUserContext(messagesForQuery, userContext),       │  │
│  │        systemPrompt: fullSystemPrompt,                                   │  │
│  │        tools: toolUseContext.options.tools,                               │  │
│  │        signal: abortController.signal,                                    │  │
│  │        options: { model, thinkingConfig, toolChoice, ... }                │  │
│  │      })) {                                                                │  │
│  │        // 收模型响应流                                                   │  │
│  │        yield message                 ← 向上游 yield 消息（用户可见）      │  │
│  │                                                                           │  │
│  │        if (message.type === 'assistant') {                                │  │
│  │          assistantMessages.push(message)                                  │  │
│  │          // 提取 tool_use block                                          │  │
│  │          toolUseBlocks.push(...msgToolUseBlocks)                          │  │
│  │          needsFollowUp = true      ← 有 tool_use 需要继续执行             │  │
│  │          // StreamingToolExecutor 流水线处理                              │  │
│  │          streamingToolExecutor.addTool(toolBlock, message)                │  │
│  │          // 即时 yield 已完成的工具结果                                    │  │
│  │          yield* streamingToolExecutor.getCompletedResults()               │  │
│  │        }                                                                  │  │
│  │      }                                                                    │  │
│  │    }                                                                      │  │
│  │  } catch (FallbackTriggeredError) {                                       │  │
│  │    // 模型不可用 → 切换到 fallback model 重试                              │  │
│  │    currentModel = fallbackModel;                                          │  │
│  │    attemptWithFallback = true;                                            │  │
│  │    continue;                                                              │  │
│  │  }                                                                        │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
│                                    │                                            │
│              ┌─────────────────────┼─────────────────────┐                      │
│              ▼                     ▼                     ▼                      │
│        错误处理              流中断                流完成                        │
│              │                     │                     │                      │
│              ▼                     ▼                     ▼                      │
│  ┌─────────────────────┐ ┌──────────────────┐ ┌──────────────────────────┐    │
│  │ PHASE 4a: 错误恢复   │ │ PHASE 4b: 中断处理 │ │ PHASE 4c: 流完成处理    │    │
│  │                     │ │                  │ │                          │    │
│  │ FallbackTriggered→  │ │ abortController  │ │ needsFollowUp = false    │    │
│  │   switch model 重试  │ │   .signal.aborted│ │   (= 没有 tool_use 块)    │    │
│  │                     │ │                  │ │   ↓                      │    │
│  │                     │ │ yield missing    │ │   PostSamplingHooks      │    │
│  │                     │ │   tool_results   │ │   ↓                      │    │
│  │                     │ │ yield interruption│ │   413 恢复(collapse/RC) │    │
│  │                     │ │ return {aborted}  │ │   max_tokens 恢复       │    │
│  │                     │ │                  │ │   StopHook 处理          │    │
│  │                     │ │                  │ │   TokenBudget 检查       │    │
│  │                     │ │                  │ │   return {completed}    │    │
│  │                     │ │                  │ │                          │    │
│  │                     │ │                  │ │   ┌──────────────────────┤    │
│  │                     │ │                  │ │   │ 若 413 恢复成功 →    │    │
│  │                     │ │                  │ │   │ state = messages     │    │
│  │                     │ │                  │ │   │ continue (重试本轮)  │    │
│  │                     │ │                  │ │   └──────────────────────┘    │
│  └─────────────────────┘ └──────────────────┘ └──────────────────────────┘  │
│                              │                     │                          │
│                              ▼                     ▼                          │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │ PHASE 5: 工具执行 (如果 needsFollowUp = true)                              │  │
│  │                                                                           │  │
│  │  toolUpdates = streamingToolExecutor                                      │  │
│  │    ? streamingToolExecutor.getRemainingResults()                          │  │
│  │    : runTools(toolUseBlocks, assistantMessages, canUseTool, ...)          │  │
│  │                                                                           │  │
│  │  for await (update of toolUpdates) {                                      │  │
│  │    yield update.message        ← yield 工具结果给上游                     │  │
│  │    toolResults.push(...)       ← 收集 tool_result 用于下一轮              │  │
│  │  }                                                                        │  │
│  │                                                                           │  │
│  │  // 后台生成 tool use summary（Haiku 异步生成）                            │  │
│  │  nextPendingToolUseSummary = generateToolUseSummary(...)                  │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
│                                    │                                            │
│                                    ▼                                            │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │ PHASE 6: 消息组装 and 继续决策 (Assembly & Continue Decision)              │  │
│  │                                                                           │  │
│  │  1. 获取队列中等待的命令 → getCommandsByMaxPriority()                       │  │
│  │  2. 生成附件消息 → getAttachmentMessages(queuedCommands)                   │  │
│  │  3. 处理内存预取 → memoryPrefetch.consume()                                │  │
│  │  4. 处理技能预取 → skillPrefetch.collect()                                 │  │
│  │  5. 刷新工具列表 → refreshTools()                                          │  │
│  │  6. 检查 maxTurns → 超限则 return { max_turns }                           │  │
│  │                                                                           │  │
│  │  7. state = {                                                             │  │
│  │       messages: [...messagesForQuery, ...assistantMessages, ...toolResults],│
│  │       toolUseContext: updatedToolUseContext,                               │  │
│  │       turnCount: nextTurnCount,                                           │  │
│  │       transition: { reason: 'next_turn' },                                │  │
│  │       ...                                                                 │  │
│  │     }                                                                     │  │
│  │  8. continue  ← 进入下一轮 turn                                           │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
│                                    │                                            │
│                                    ▼                                            │
│                           回到 PHASE 1 (继续)                                    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 循环退出路径

| 退出位置 | reason | 条件 |
|----------|--------|------|
| 消息预处理 | `blocking_limit` | token 超过硬限制，autocompact 关闭 |
| API 流式调用完成 | `completed` | 模型无 tool_use，stop hook 允许通过，token budget 耗尽 |
| API 流式调用完成 | `stop_hook_prevented` | Stop hook 返回 preventContinuation |
| API 流式调用中断 | `aborted_streaming` | 流中 abort |
| API 流式调用错误 | `model_error` | API 返回非恢复性错误 |
| API 流式调用完成 | `prompt_too_long` | 413 恢复失败 |
| API 流式调用完成 | `image_error` | 媒体错误恢复失败 |
| 工具执行中断 | `aborted_tools` | 工具执行中 abort |
| 工具执行完成 | `hook_stopped` | 工具中的 hook 阻止继续 |
| 消息组装 | `max_turns` | 超过 maxTurns |

---

## 4. 过渡状态机（Continue Transitions）

```
                        ┌─────────────────┐
                        │   首次进入循环    │
                        │ transition: undefined │
                        └────────┬────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │    PHASE 1-3 执行      │
                    └────────┬───────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
      ┌──────────────┐  ┌──────────┐  ┌──────────┐
      │ needsFollowUp │  │ 413/媒体 │  │ max_     │
      │ = true        │  │ 错误     │  │ output_  │
      │ (有 tool_use) │  │         │  │ tokens   │
      └───────┬───────┘  └────┬─────┘  └────┬─────┘
              │               │             │
              ▼               ▼             ▼
      ┌──────────────┐  ┌──────────┐  ┌──────────┐
      │ PHASE 5-6    │  │ 恢复机制  │  │ 恢复机制  │
      │ → next_turn  │  │ → 压缩重试 │  │ → 升级重试│
      └───────┬───────┘  └────┬─────┘  └────┬─────┘
              │               │             │
              └───────────────┼─────────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │ state = { ... }     │
                    │ continue            │
                    │ → 回到 PHASE 1      │
                    └─────────────────────┘
```

一次循环中可能出现**多次嵌套 transition**。例如：`max_output_tokens_escalate` → 重试 → 仍然超限 → `max_output_tokens_recovery` → 重试 → 3 次后 → return `completed`。

---

## 5. 关键设计特点

1. **Mutable State 模式**：`state` 对象在循环顶部解构为局部变量，continue 时通过 `state = { ... }` 整体赋值，每次只写一个表达式而非 9 个变量
2. **AsyncGenerator 输出**：整个循环是 `AsyncGenerator`，每次迭代可 yield 任意数量消息（流事件/消息/墓碑/摘要），消费者无需等待整个循环完成
3. **StreamingToolExecutor 流水线**：工具结果可在模型流式输出的同时开始执行，无需等待模型完成全部输出
4. **多层压缩体系**：Snip → Microcompact → Collapse → Autocompact，逐层递进，CacheBreakDetection 跟踪压缩边界
5. **错误恢复链**：413 错误先尝试 Collapse Drain（轻量），失败后尝试 Reactive Compact（重量级），再失败则透出错误
6. **Fallback Model**：当主模型不可用时自动切换到 fallback model 并重试整个请求（含 thinking signature 清理）
7. **Token Budget 延续**：`+500k` 指令可在一次循环中触发多次 continuation，自动注入 nudge message
8. **后台预取**：Memory Prefetch + Skill Prefetch + ToolUseSummary 在后台异步完成，不阻塞主流程
