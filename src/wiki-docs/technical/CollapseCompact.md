# applyCollapsesIfNeeded 与 Context Collapse 完整分析

## 函数签名

路径：[services/contextCollapse/index.ts](../../services/contextCollapse/index.ts#L38-L43)

```typescript
export async function applyCollapsesIfNeeded<T>(messages: T): Promise<{
  messages: T
  changed: boolean
}> {
  return { messages, changed: false }
}
```

> **注意：** 当前实现是**空存根**（`isContextCollapseEnabled()` 返回 `false`），说明 CONTEXT_COLLAPSE 功能虽已预留完整架构但尚未在生产环境中启用。

---

## 1. 触发时机

`applyCollapsesIfNeeded` 在 `query.ts` 的 `query` 生成器函数中调用，位于**每轮 LLM 请求发送之前**的消息构建管道中。

### 消息构建管道顺序（[query.ts:365-447](../../query.ts#L365-L447)）

```
1. getMessagesAfterCompactBoundary(messages)   ← 取最后一次 compact boundary 之后的消息
2. applyToolResultBudget()                     ← 替换过大的 tool result
3. snipCompactIfNeeded()                       ← 裁剪对话历史
4. microcompact()                              ← 微观压缩
5. applyCollapsesIfNeeded()                    ← ← ← 这里
6. autocompact()                               ← 自动摘要压缩
```

**精确触发位置**：[query.ts:440-447](../../query.ts#L440-L447)

```typescript
if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
  const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
    messagesForQuery,
    toolUseContext,
    querySource,
  )
  messagesForQuery = collapseResult.messages
}
```

**触发条件：** 仅当 `feature('CONTEXT_COLLAPSE')` 为 true 时才执行（目前是 `false`）。

**调用频率：** 每次 `query()` 生成器进入**新一轮 while 循环**时都会调用一次。也就是每次准备发送 LLM 请求之前。

### 第二个触发关联：413/溢出恢复

当 API 返回 413 (payload too large) 错误时，[query.ts:1086-1117](../../query.ts#L1086-L1117) 会调用 `recoverFromOverflow()` 来强制提交所有已暂存（staged）的 collapse span，然后用 `collapse_drain_retry` 过渡重新进入循环，执行**新一轮的 `applyCollapsesIfNeeded`**。

```typescript
if (feature('CONTEXT_COLLAPSE') && contextCollapse &&
    state.transition?.reason !== 'collapse_drain_retry') {
  const drained = contextCollapse.recoverFromOverflow(
    messagesForQuery, querySource,
  )
  if (drained.committed > 0) {
    state = {
      messages: drained.messages,
      transition: { reason: 'collapse_drain_retry', committed: drained.committed },
    }
    continue  // 重新进入循环 → 再次调用 applyCollapsesIfNeeded
  }
}
```

---

## 2. 实现流程（预期设计，基于类型定义）

虽然当前代码是存根，但从类型定义和相关文件可以推断完整流程。

### 架构层次

```
┌─────────────────────────────────────────────────┐
│                    REPL UI                       │
│  (Messages 组件 — 显示 collapse 视图)              │
└──────────────────────┬──────────────────────────┘
                       │ RenderableMessage[]
┌──────────────────────▼──────────────────────────┐
│              projectView()                       │
│  (重组消息：替换为 summary placeholder + 可展开)    │
└──────────────────────┬──────────────────────────┘
                       │ Message[]
┌──────────────────────▼──────────────────────────┐
│           applyCollapsesIfNeeded()               │
│  (由 ctx-agent 自动暂存 → 提交 → 替换消息)        │
└──────────────────────┬──────────────────────────┘
                       │ Message[]
┌──────────────────────▼──────────────────────────┐
│              query.ts                            │
│  (发送给 LLM 的消息)                               │
└──────────────────────────────────────────────────┘
```

### 核心概念（来自类型定义）

**ContextCollapseCommitEntry**（[types/logs.ts:255-269](../../types/logs.ts#L255-L269)）— 持久化到 transcript `.jsonl` 文件：

```typescript
{
  type: 'marble-origami-commit',
  collapseId: string,        // 16位 collapse ID
  summaryUuid: string,       // summary placeholder 的 uuid
  summaryContent: string,    // <collapsed id="...">text</collapsed> 占位符
  summary: string,           // 纯文本摘要
  firstArchivedUuid: string, // 被归档消息的起始 uuid
  lastArchivedUuid: string   // 被归档消息的结束 uuid
}
```

**ContextCollapseSnapshotEntry**（[types/logs.ts:282-295](../../types/logs.ts#L282-L295)）— 暂存队列快照：

```typescript
{
  type: 'marble-origami-snapshot',
  staged: Array<{ startUuid, endUuid, summary, risk, stagedAt }>,
  armed: boolean,
  lastSpawnTokens: number
}
```

### 预期流程

1. **暂存（Staging）：** 一个后台代理（ctx-agent）持续扫描消息列表，识别哪些消息段可以折叠。对每个候选段，生成摘要并暂存到内存队列中。
2. **提交（Commit）：** 当 `applyCollapsesIfNeeded` 被调用时，将暂存的 collapse span 提交为不可变的 commit entry，同时向 `.jsonl` 写入 `marble-origami-commit` 记录。
3. **替换消息：** 将被折叠的消息段替换为 summary placeholder（`<collapsed id="...">text</collapsed>`）。
4. **projectView 重组：** REPL 显示时，`projectView()` 根据 commit 日志将 placeholder 替换回可展开的初始摘要视图。

---

## 3. Collapse 视图如何呈现

### 面向用户的视图（REPL UI）

- 用户看到的是**经过 projectView 重组后的消息列表**
- 被折叠的消息段在终端中显示为一个**可展开/折叠的摘要行**，例如：
  ```
  ── 📎 collapsed 8 messages (tool results from previous turn) ──
  ```
- 用户可以通过交互展开查看原始内容

### 面向 LLM 的视图（messagesForQuery）

- LLM 看到的是**被压缩后的消息** — 原始消息被替换为 `<collapsed id="...">` 摘要标签
- 摘要内容由后台代理生成，旨在保留关键信息的同时减少 token 占用

### 存储层面

- **本地 `.jsonl` 文件：** `marble-origami-commit` 和 `marble-origami-snapshot` 条目持久化到 transcript 文件
- **不在服务端：** Collapse 是完全本地的操作，不影响 API 调用格式

---

## 4. 各层次的定位总结

| 层次 | 内容 | 面向谁 | 位置 |
|------|------|--------|------|
| **REPL 终端显示** | 可展开的 collapse summary 交互组件 | **用户** | 本地 REPL |
| **messagesForQuery** | `<collapsed>` 摘要占位符替代原始消息 | **LLM**（减少 token 消耗） | 内存/API 请求 |
| **`.jsonl` transcript** | `marble-origami-commit/snapshot` 条目 | **本地持久化**（恢复用） | 本地文件系统 |
| **API 请求体** | 不包含 collapse 元数据 | 不涉及 | 网络传输 |

---

## 5. 完整会话如何恢复

### 恢复时机

完整会话恢复发生在以下入口点，均通过 `loadConversationForResume()` 统一加载：

| 入口 | 触发方式 | 路径 |
|------|----------|------|
| `--continue` | 命令行启动 | [conversationRecovery.ts:488](../../utils/conversationRecovery.ts#L488) |
| `--resume <id>` | 命令行指定会话 ID | [conversationRecovery.ts:522](../../utils/conversationRecovery.ts#L522) |
| `--resume <path.jsonl>` | 命令行指定文件路径 | [conversationRecovery.ts:517](../../utils/conversationRecovery.ts#L517) |
| `/resume` | REPL 交互命令 | [commands/resume/index.ts](../../commands/resume/index.ts#L3) |
| ResumeConversation 屏幕 | 从会话列表选择 | [screens/ResumeConversation.tsx](../../screens/ResumeConversation.tsx) |

### 恢复流程

```
loadConversationForResume()                           [conversationRecovery.ts:456]
  └→ loadMessagesFromJsonlPath() / getLastSessionLog()
       └→ 解析 .jsonl 文件，提取所有 entry 类型
            ├── TranscriptMessage     → 消息主体
            ├── ContextCollapseCommitEntry   → collapse 提交记录（contextCollapseCommits）
            └── ContextCollapseSnapshotEntry → 暂存队列状态（contextCollapseSnapshot）
```

返回结果中包含（[conversationRecovery.ts:570-597](../../utils/conversationRecovery.ts#L570-L597)）：

```typescript
return {
  messages,
  contextCollapseCommits: log?.contextCollapseCommits,   // 所有 commit 记录
  contextCollapseSnapshot: log?.contextCollapseSnapshot,  // 暂存队列快照
  // ...
}
```

### 恢复后的内部操作

1. **从 .jsonl 读取 commit 条目：** `ContextCollapseCommitEntry` 记录被反序列化
2. **重建 collapse 存储：** Collapse store 读取所有 commit 条目，重建 `CommittedCollapse` 对象（但 `archived=[]`，不加载完整原始消息）
3. **懒加载归档消息：** 当 `projectView()` 首次处理这些 collapse span 时，它会在消息数组中找到 `firstArchivedUuid` 到 `lastArchivedUuid` 对应的消息，填充 archive
4. **暂存队列恢复：** `ContextCollapseSnapshotEntry` 恢复之前未提交的暂存 span，并为它们重新分配 collapse ID

### 恢复后的视图

恢复后，之前的 collapse span 仍然有效：

- 用户看到正常的 collapse 摘要（与 collapse 前一样）
- LLM 仍然只看到摘要版本
- 展开操作仍然可以查看原始内容（因为原始消息还在消息数组中）

---

## 6. 关键设计特点

1. **持久化策略：** commit 是 **append-only**（累计所有历史），snapshot 是 **last-wins**（只保留最新暂存状态）
2. **UUID 稳定性：** staged span 使用 UUID 标识，跨会话稳定；collapse ID 在每次恢复后重新分配
3. **投影（Projection）模式：** Collapse 视图是**只读投影** — 原始消息一直保存在 REPL 的消息数组中，只有 LLM 看到的 `messagesForQuery` 被压缩。这保证了：
   - 跨 turn 持久化（commit 日志在每次 entry 时重放）
   - turn 内的连续性（`state.messages` 保持完整，下一次 `projectView()` 对已归档消息无操作）
4. **自恢复（Self-healing）：** 没有 commit 记录时自动退化为普通消息，不需要额外错误处理
5. **分层协调：** Collapse 与 Snip、Microcompact、Autocompact 组成多层压缩体系，Collapse 位于 Snip/Microcompact 之后、Autocompact 之前

---

## 7. Collapse 的压缩粒度

collapse 的压缩单位是 **messages 数组中的连续消息段**（a contiguous span of messages），其特征：

1. **基于消息类型筛选** — 从 `collapseReadSearch.ts` 可以看到，目前只针对 **Tool Search / Read 类工具** 的 `tool_use` + `tool_result` 消息对进行折叠（`isCollapsibleToolUse` 和 `isCollapsibleToolResult` 检查）
2. **以工具调用边界为单位** — 一个 collapse span 从 `assistant` 消息（含 tool_use）到对应的 `user` 消息（含 tool_result），形成完整的调用-结果对
3. **连续同类消息合并** — 连续的 Read/Search 工具调用会被合并为一个 collapse 组
4. **非折叠工具打断分组** — 遇到 Edit/Write/Bash 等非折叠工具消息会打断当前的 collapse 分组（`isNonCollapsibleToolUse`）

**collapse 不涉及 system prompt 和 tools 数组：**

从 [query.ts:659-663](../../query.ts#L659-L663) 可以看到完整的 API 请求构建：

```typescript
for await (const message of deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),  // ← messages
  systemPrompt: fullSystemPrompt,   // ← system prompt（独立参数）
  tools: toolUseContext.options.tools,  // ← tools（独立参数）
  ...
})
```

`applyCollapsesIfNeeded` 的签名只接受 `messagesForQuery`，system prompt 在 collapse 之后才构建（[query.ts:449](../../query.ts#L449)），tools 来自 `toolUseContext.options.tools`：

| 组件 | collapse 是否涉及？ | 原因 |
|------|---------------------|------|
| **messages 数组** | **是** | 输入就是 messages，将连续消息段替换为 `<collapsed>` 占位符 |
| **system prompt** | **否** | 在 collapse **之后**构建，是独立 API 参数 |
| **tools 数组** | **否** | 来自 `toolUseContext.options.tools`，完全独立 |

---

## 8. Autocompact 分析

### 8.1 触发时机

`autocompact` 在 `query.ts` 的消息构建管道中调用，位于 `applyCollapsesIfNeeded` **之后**。

```typescript
// query.ts:453-467
queryCheckpoint('query_autocompact_start')
const { compactionResult, consecutiveFailures } = await deps.autocompact(
  messagesForQuery,   // ← 已经是 collapse 处理后的消息
  toolUseContext,
  { systemPrompt, userContext, systemContext, toolUseContext, forkContextMessages: messagesForQuery },
  querySource,
  tracking,
  snipTokensFreed,
)
queryCheckpoint('query_autocompact_end')
```

**触发条件**由 `shouldAutoCompact()`（[autoCompact.ts:160-239](../../services/compact/autoCompact.ts#L160-L239)）决定：

1. `querySource` 不能是 `session_memory`、`compact`、`marble_origami`（递归保护）
2. 用户配置未禁用自动压缩（`DISABLE_COMPACT` / `DISABLE_AUTO_COMPACT` / `autoCompactEnabled`）
3. 当 CONTEXT_COLLAPSE 启用时，autocompact 被**静默抑制**（collapse 接管上下文管理，[autoCompact.ts:215-223](../../services/compact/autoCompact.ts#L215-L223)）
4. Token 计数超过阈值：`effectiveContextWindow - 13_000`

```
threshold = contextWindow - maxOutputTokens - AUTOCOMPACT_BUFFER_TOKENS(13_000)
当 tokenCountWithEstimation(messages) >= threshold 时触发
```

**熔断机制：** 连续失败 3 次后停止重试（`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`）。

### 8.2 作用流程

```
autoCompactIfNeeded()                    [autoCompact.ts:241]
  │
  ├─ shouldAutoCompact()                 ← 判断是否需要压缩
  │   └─ tokenCount >= threshold(窗口-13K)
  │
  ├─ trySessionMemoryCompaction()        ← 实验性：尝试会话内存压缩
  │   └─ 成功则返回 CompactResult
  │
  └─ compactConversation()               [compact.ts:387]
       │
       ├─ executePreCompactHooks()       ← 执行前置 hook
       │
       ├─ getCompactPrompt()             ← 构建压缩 prompt
       │
       ├─ streamCompactSummary()         ← 调用 LLM 生成摘要
       │   └─ 发送完整 messages + 摘要请求给 LLM
       │   └─ 如果 413，用 truncateHeadForPTLRetry() 重试（最多 3 次）
       │
       ├─ createPostCompactFileAttachments()  ← 重建文件附件
       ├─ createAsyncAgentAttachmentsIfNeeded()
       ├─ createPlanAttachmentIfNeeded()
       ├─ createPlanModeAttachmentIfNeeded()
       ├─ createSkillAttachmentIfNeeded()
       ├─ getDeferredToolsDeltaAttachment()   ← 重新声明工具差量
       ├─ getAgentListingDeltaAttachment()
       ├─ getMcpInstructionsDeltaAttachment()
       │
       └─ buildPostCompactMessages()     [compact.ts:330]
            └─ 组装结果：
               [boundaryMarker, summaryMessages, messagesToKeep, attachments, hookResults]
```

### 8.3 作用对象

从 `compactConversation` 的实现可以明确作用范围：

**messages 数组 — 是：**

```
streamCompactSummary({
  messages: messagesToSummarize,  // ← 输入的完整 messages 数组
  summaryRequest,                 // ← "请总结这段对话" 的 user message
  ...
})
```

**system prompt — 间接涉及：**

`systemPrompt` 作为 `cacheSafeParams` 的一部分传入，用于**压缩请求的 fork 代理上下文**（确保 fork 的 LLM 有正确的 system context 来理解要压缩的内容），但 system prompt **本身不会被压缩或改变**。

**tools 数组 — 不涉及：**

- tools 数组本身不会作为压缩对象
- 但压缩**结果**中会附带 `getDeferredToolsDeltaAttachment()` 重新声明工具配置
- 这是**重新注入**而非压缩

### 8.4 压缩结果的结构

```typescript
// CompactionResult [compact.ts:299-310]
{
  boundaryMarker: SystemMessage,           // compact_boundary 标记消息
  summaryMessages: UserMessage[],          // LLM 生成的摘要（多条 user 消息）
  attachments: AttachmentMessage[],        // 重新生成的附件（文件、技能、工具声明等）
  hookResults: HookResultMessage[],        // hook 执行结果
  messagesToKeep?: Message[],              // 保留的原始消息（靠近尾部的关键消息）
  preCompactTokenCount?: number,           // 压缩前 token 数
  postCompactTokenCount?: number,          // 压缩后 token 数
  compactionUsage?: ReturnType<typeof getTokenUsage>,  // 压缩消耗的 token
}
```

`buildPostCompactMessages()` 组装为最终消息数组：

```typescript
[boundaryMarker, ...summaryMessages, ...messagesToKeep, ...attachments, ...hookResults]
```

### 8.5 Autocompact vs Collapse 对比

| 维度 | Autocompact | Collapse |
|------|-------------|----------|
| **触发时机** | 超过 token 阈值时主动触发 | 每轮 query 中被动检查 |
| **工作原理** | fork 代理调用 LLM 生成摘要 | 本地 ctx-agent 暂存+提交 |
| **作用粒度** | 整个 messages 数组，从头部开始 | 连续 tool_use+tool_result 对 |
| **是否调用 LLM** | **是**（每次触发都调用） | **是**（ctx-agent 后台调用） |
| **对原始消息** | **替换**为摘要，丢弃原始消息 | 保留原始消息，只对 LLM 视图投影 |
| **用户视图** | compact_boundary 之后只能看到摘要 | 可展开的交互式摘要 |
| **system prompt** | 作为 fork 上下文间接使用，不压缩 | **不涉及** |
| **tools** | 结果中**重新注入**工具声明 | **不涉及** |
| **持久化** | 写入 transcript 的 messages | 写入 `marble-origami-commit/snapshot` |
| **互斥关系** | Collapse 启用时自动抑制 | 优先于 autocompact |

### 8.6 多层压缩体系总结

```
输入: messages[]（来自 getMessagesAfterCompactBoundary）
  │
  ├─ 1. applyToolResultBudget()    → 替换过大的 tool_result 内容
  │    范围: messages 中的 tool_result block
  │    不涉及: system, tools
  │
  ├─ 2. snipCompactIfNeeded()      → 裁剪头部过期消息
  │    范围: messages 头部（pre-compact 部分）
  │    不涉及: system, tools
  │
  ├─ 3. microcompact()             → 压缩单个 tool_result 的文本内容
  │    范围: messages 中的 tool_result 内容块
  │    不涉及: system, tools
  │
  ├─ 4. applyCollapsesIfNeeded()   → 折叠连续的 tool 调用-结果对
  │    范围: messages 中的 tool_use+tool_result 对
  │    不涉及: system, tools
  │
  ├─ 5. autocompact()              → LLM 摘要压缩整个对话
  │    范围: messages 整个数组（头部→尾部）
  │    system: 作为 fork 上下文间接使用
  │    tools: 不压缩，结果中重新注入声明
  │
  └─ 输出: messagesForQuery（发送给 LLM）
```

**所有压缩层都只缩减 messages 数组中的 token，system prompt 和 tools 数组本身不在任何压缩层的处理范围内。**
