# 工具调用编排与执行：三个核心文件的分工与调用关系

本文分析 [services/tools/StreamingToolExecutor.ts](src/services/tools/StreamingToolExecutor.ts)、[services/tools/toolExecution.ts](src/services/tools/toolExecution.ts)、[services/tools/toolOrchestration.ts](src/services/tools/toolOrchestration.ts) 三个文件的功能、相互调用关系，以及它们在 Claude Code 整体工具调用编排与执行中的角色。

## 结论先看

Claude Code 存在**两条平行的"编排层"**，它们负责不同的调度策略，但**最终都汇入同一个"执行层"**：

```
                    ┌──────────────────────────────────────┐
                    │            query.ts 查询循环           │
                    │   (按流式消息到达逐个处理 tool_use)      │
                    └──────────────────────────────────────┘
                       │                             │
          一路走"流式单条到达"                 一路走"批量到达后分区"
                       ▼                             ▼
        ┌─────────────────────────┐      ┌──────────────────────────┐
        │   StreamingToolExecutor  │      │  toolOrchestration.runTools│
        │  (增量 addTool / 队列)    │      │  (partitionToolCalls 分区) │
        └─────────────────────────┘      └──────────────────────────┘
                       │                             │
                       ▼                             ▼
        ┌──────────────────────────────────────────────────────────┐
        │        toolExecution.runToolUse  (唯一执行核心)           │
        │  checkPermissionsAndCallTool → 权限/钩子/执行/遥测/结果    │
        └──────────────────────────────────────────────────────────┘
```

- **编排（Orchestration）= 决定"哪些工具一起跑、以什么顺序返回结果"** → 由 `StreamingToolExecutor` 和 `toolOrchestration.runTools` 负责。
- **执行（Execution）= 决定"单个工具怎么从输入到结果"**（校验、权限、钩子、调用、遥测、结果映射）→ 由 `toolExecution.runToolUse` 统一负责。

两条编排路径是**并存的**，分别对应处理 assistant 流式输出的两种消费方式：流式逐条到达用 `StreamingToolExecutor`，非流式/批量拿到完整 `tool_use` 集合后用 `runTools`。

---

## 一、StreamingToolExecutor.ts —— 流式增量编排器

**文件**：[services/tools/StreamingToolExecutor.ts](src/services/tools/StreamingToolExecutor.ts)，约 530 行。

### 职责

在**工具调用随 LLM 输出流逐个到达**的场景下，每收到一个 `tool_use` block 就立刻 `addTool()` 入队，并**尽可能早地开始执行**（不等后续 block）。核心价值：既要**尽早执行**（并发）又要**保持结果顺序可预测**。

### 关键机制

1. **TrackedTool 状态机**（[StreamingToolExecutor.ts:21-32](src/services/tools/StreamingToolExecutor.ts#L21-L32)）
   每个被跟踪的工具经历 `queued → executing → completed → yielded` 四个状态。

2. **并发安全判断**（[addTool:76](src/services/tools/StreamingToolExecutor.ts#L76)）
   用 `inputSchema.safeParse` + `tool.isConcurrencySafe(input)` 计算 `isConcurrencySafe`，决定该工具能否与其它并发安全工具并行。

3. **并发控制**（[canExecuteTool:129](src/services/tools/StreamingToolExecutor.ts#L129)）
   规则：**要么当前没有工具在执行；要么"要执行的是并发安全"且"所有正在执行的也都是并发安全"**。否则排队。这保证了：
   - 并发安全工具（Read、WebFetch 等只读）可以彼此并行；
   - 非并发安全工具（写操作、Bash）独占执行。

4. **顺序保持**（[getCompletedResults:412](src/services/tools/StreamingToolExecutor.ts#L412)）
   结果**不是按完成时间**而是按 `this.tools`（addTool 到达顺序）yield。遇到正在执行的**非并发安全**工具时 `break`，等待它完成再继续，从而维持整体顺序。

5. **进度消息即时性**（[getCompletedResults:418-422](src/services/tools/StreamingToolExecutor.ts#L418-L422)）
   `progress` 消息单独存放于 `pendingProgress`，**无论工具状态**都立即 yield（用于 UI 实时刷新），不与最终结果混在一起。

6. **错误级联 / 合成错误**（[executeTool:265](src/services/tools/StreamingToolExecutor.ts#L265)、[createSyntheticErrorMessage:153](src/services/tools/StreamingToolExecutor.ts#L153)）
   - 只有当 **Bash** 工具出错时（`BASH_TOOL_NAME`，[executeTool:359](src/services/tools/StreamingToolExecutor.ts#L359)），才设置 `hasErrored` 并 `siblingAbortController.abort('sibling_error')`，好让其它并行子进程立即被杀死（Bash 命令常有隐式依赖链，一个失败后续无意义；Read/WebFetch 彼此独立，不应互相连坐）。
   - 对因 `sibling_error` / `user_interrupted` / `streaming_fallback` 被取消的工具，生成**合成 `tool_use_error` tool_result**。用户中断时用 `REJECT_MESSAGE` 让 UI 显示 "User rejected edit"。
   - 用 `thisToolErrored` 防止"出错的工具自己"再收到一份重复的 sibling error。

7. **分层的 AbortController**（[executeTool:301](src/services/tools/StreamingToolExecutor.ts#L301)）
   `toolUseContext.abortController → siblingAbortController（子）→ 每个工具的 toolAbortController（孙）`。这条链让 Bash 出错能级联杀死兄弟进程，同时**不中断父级 query 循环**；而权限弹窗的拒绝会反向冒泡 abort 到父级，从而正确结束整个 turn（注释提到 #21056 回归）。

8. **discard()（流式回退）**（[discard:69](src/services/tools/StreamingToolExecutor.ts#L69)）
   当流式失败需回退时，丢弃所有排队/进行中的工具；已入队的不再启动，进行中的收到合成 streaming_fallback 错误。

### 对外接口

- `addTool(block, assistantMessage)`：入队并触发 `processQueue()`。
- `getCompletedResults()` / `getRemainingResults()`：供消费方逐条 yield 结果。
- `discard()`、`getUpdatedContext()`。

---

## 二、toolOrchestration.ts —— 批量分区编排器

**文件**：[services/tools/toolOrchestration.ts](src/services/tools/toolOrchestration.ts)，约 188 行。

### 职责

在**一次性拿到一批（多个）tool_use block** 的场景下，把**"可并发的批"和"必须串行的批"**分开，然后按批执行。它与 `StreamingToolExecutor` 是两条**并列**的编排路径，处理的是"批量到达"而非"流式单条到达"。

### 关键机制

1. **分区**（[partitionToolCalls:91](src/services/tools/toolOrchestration.ts#L91)）
   把 `ToolUseBlock[]` 分组为 `Batch[]`：
   - **连续的并发安全（只读）block** 归为一组 → 可并行；
   - 每个**非并发安全**工具 → 单独一个 batch → 串行。
   依据 `isConcurrencySafe`（与 StreamingToolExecutor 相同），且按**连续**性分组。

2. **串行与并发执行**
   - `runToolsSerially`（[toolOrchestration.ts:118](src/services/tools/toolOrchestration.ts#L118)）：对非并发 batch，逐个 `runToolUse`。
   - `runToolsConcurrently`（[toolOrchestration.ts:152](src/services/tools/toolOrchestration.ts#L152)）：对并发 batch，用 `all()`（来自 [utils/generators.js]）并发执行，最大并发数取 `getMaxToolUseConcurrency()`（`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`，默认 10）。

3. **contextModifier 缓冲**（[runTools]）
   并发执行时先按 `toolUseID` 缓冲各工具的 `contextModifier`，batch 完成后统一应用。

4. **markToolUseAsComplete**（[toolOrchestration.ts:179](src/services/tools/toolOrchestration.ts#L179)）
   每个工具完成后从 `setInProgressToolUseIDs` 中移除该 ID，与 StreamingToolExecutor 里的同名函数做一样的事。

### 对外接口

- `runTools(...)`（[toolOrchestration.ts:19](src/services/tools/toolOrchestration.ts#L19)）：异步生成器，产出 `MessageUpdate`。

---

## 三、toolExecution.ts —— 单一执行核心

**文件**：[services/tools/toolExecution.ts](src/services/tools/toolExecution.ts)，约 1745 行。**三个文件里最核心、最"重"的**。

### 职责

把"**单个**工具调用"从输入一路走到结果，是所有编排器真正执行工具的地方。它只管"一个工具怎么跑完"，**不关心和谁并行、以什么顺序返回**——那是编排层的事。

### 关键机制

1. **runToolUse（异步生成器）**（[toolExecution.ts:337](src/services/tools/toolExecution.ts#L337)）
   入口。解析工具（`findToolByName` + 别名回退 `getAllBaseTools`），处理未知工具 / 已 abort、cancel 的情形，然后委托给 `streamedCheckPermissionsAndCallTool`。

2. **streamedCheckPermissionsAndCallTool**（[toolExecution.ts:492](src/services/tools/toolExecution.ts#L492)）
   用 `new Stream<MessageUpdateLazy>()` 把**进度事件**（`onToolProgress` → `tengu_tool_use_progress` 事件 + `createProgressMessage`）和**最终结果**合并成一个异步可迭代对象统一 yield。这就是编排层能拿到 `progress` 消息的原因。

3. **checkPermissionsAndCallTool**（[toolExecution.ts:599](src/services/tools/toolExecution.ts#L599)）—— 完整流水线：
   - **入参校验**：`inputSchema.safeParse`（Zod），失败时附加 `TOOL_SEARCH_HINT`（见 `buildSchemaNotSentHint` [line 578]）。
   - **validateInput**：工具自定义校验。
   - **Bash 投机式分类器**（[line 740-752]）：`startSpeculativeClassifierCheck`（Auto 模式下的 allow 分类器，校验可异步跑）。
   - **防御性清理**（[line 761-773]）：剥离模型自带的 `_simulatedSedEdit` 字段。
   - **backfillObservableInput**（[line 784-793]）：克隆以便遥测。
   - **PreToolUse 钩子循环**（[line 800]）：`runPreToolUseHooks`。
   - **权限决策**（`resolveHookPermissionDecision` → [line 921]）：得到 `permissionDecision`（allow/ask/deny）。
   - **拒绝路径**（[line 995-1103]）：构造 `tool_result`（可含图片 contentBlocks），若 `feature('TRANSCRIPT_CLASSIFIER')` 且为 classifier/auto-mode 拒绝，则跑 PermissionDenied 钩子以支持"钩子重试"。
   - **允许 → 调用**（[line 1207]）：`tool.call(...)` → 遥测 → `mapToolResultToToolResultBlockParam` → 解析 `git_commit_id` → 发 `tool_result` OTel 事件。
   - **PostToolUse 钩子**（[line 1397]）：`runPostToolUseHooks`，MCP 工具可更新输出（`updatedMCPToolOutput`），非 MCP 先把结果入 `resultingMessages` 再并发跑钩子；`shouldPreventContinuation` 时产出 `hook_stopped_continuation`。
   - **addToolResult 组装**（[line 1403]）：工具结果 + 可选 acceptFeedback + 权限决策附带的 contentBlocks（如粘贴的图片），为图片生成连续 `imagePasteIds`，构造 user 消息。
   - **错误路径 / 失败钩子**（[line 1589 起]）：`runPostToolUseFailureHooks`；MCP auth 错误更新客户端为 `needs-auth`；发 `tengu_tool_use_error` 和 `tool_result(success=false)` 事件；`isInterrupt`（AbortError）判定。
   - **finally**（[line 1738]）：`stopSessionActivity('tool_exec')`，清理 `toolDecisions`。

### 对外接口

- `runToolUse(...)`：被两个编排器同时调用（见下）。

---

## 四、调用关系

| 调用方 | 被调函数 | 位置 |
|---|---|---|
| `StreamingToolExecutor.executeTool` | `runToolUse` | [StreamingToolExecutor.ts:320](src/services/tools/StreamingToolExecutor.ts#L320) |
| `toolOrchestration.runToolsSerially` | `runToolUse` | 各 batch 逐个调用 |
| `toolOrchestration.runToolsConcurrently` | `runToolUse` + `markToolUseAsComplete` | 并发调用 |
| `query.ts` | `new StreamingToolExecutor` | [query.ts:562](src/query.ts#L562) |
| `query.ts` | `addTool` / `getRemainingResults` / `getCompletedResults` | query 查询循环 |
| `query.ts` | `runTools`（toolOrchestration） | 非流式/批量路径 |

**import 证据**：
- StreamingToolExecutor.ts:11 `import { createChildAbortController } from '../../utils/abortController.js'`
- StreamingToolExecutor.ts:12 `import { runToolUse } from './toolExecution.js'`
- toolOrchestration.ts 内部依赖 `all()`、`getMaxToolUseConcurrency()`、`runToolUse`、`markToolUseAsComplete`。

**关键点**：`StreamingToolExecutor`（流式单条）与 `toolOrchestration.runTools`（批量分区）在调用图上是**兄弟关系**，彼此不互调；它们作为**两种编排策略**共同汇聚到唯一的 `runToolUse` 执行核心。

---

## 五、在整体工具编排与执行中的作用

1. **分层架构清晰可读**：
   - 编排层关心"调度"：谁并行、谁串行、结果按什么顺序、出错怎么级联、用户中断怎么处理。
   - 执行层关心"履约"：入参校验、权限、钩子、实际调用、遥测、结果映射、失败兜底。
   - "多种编排策略复用同一执行核心"的设计，避免了权限/钩子/遥测逻辑在两条路径里各写一份。

2. **两条路径的取舍**：
   - `StreamingToolExecutor` 侧重**响应性与顺序可预测**，适合流式交互（尽早执行 + 保持到达顺序），额外处理了 Bash 错误级联、中断、流式回退等精细场景。
   - `toolOrchestration.runTools` 侧重**批量吞吐**，用分区 + 最大并发 10 的方式整体调度一批工具。

3. **runToolUse 是唯一事实来源**：无论工具从哪条路径进来，其权限决策、钩子、执行、遥测、结果格式都完全一致——这也是为何两条编排路径产出能被 query 循环统一消费的原因。

---

## 关联

- [bash-permissions.md](bash-permissions.md)（Bash 权限/分类器）
- [tool-lifecycle.md](tool-lifecycle.md)（工具定义与生命周期，含 `isConcurrencySafe` / `interruptBehavior`）
- [StreamingToolExecutor.ts](src/services/tools/StreamingToolExecutor.ts)
- [toolExecution.ts](src/services/tools/toolExecution.ts)
- [toolOrchestration.ts](src/services/tools/toolOrchestration.ts)
