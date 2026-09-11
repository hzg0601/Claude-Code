# Claude Code Hook 机制完全解析

> 本文全部结论来自源码分析，不引用任何现有 doc 文档。
> 核心代码文件：`src/utils/hooks.ts`（引擎）、`src/entrypoints/sdk/coreTypes.ts`（事件枚举）、`src/entrypoints/sdk/coreSchemas.ts`（事件输入契约）、`src/schemas/hooks.ts`（配置 schema）、`src/types/hooks.ts`（输出契约）。
> 代码引用仅到文件级（文件名）。

---

## 1. 总览与架构全景

Hook（钩子）是 Claude Code（后文简称 CC）面向外部扩展的一等公民能力：它允许 `settings.json`、插件、Skill、Agent 前端等以**事件驱动**的方式，在 CC 主流程的各个关键节点（工具调用前后、用户输入、会话开始/结束、压缩、权限、子代理等）注入自定义逻辑。

与 MCP、插件等其它扩展机制相比，Hook 的特点是**非侵入式、同步/异步皆可、可以在执行期改变主流程行为**（例如阻断工具调用、修改工具输入、追加上下文、代答权限、改写 MCP 输出）。

### 1.1 径向架构

整个 Hook 体系围绕一条主轴线呈径向展开，可以概括为四层：

```
┌────────────────────────────────────────────────────────────────┐
│  ① 数据契约层（类型 / schema / 事件枚举）                        │
│    coreTypes.ts   → HOOK_EVENTS（27 个事件）、EXIT_REASONS        │
│    coreSchemas.ts → 每个事件的 BaseHookInputSchema + *HookInputSchema│
│    schemas/hooks.ts→ HookCommandSchema（command/prompt/agent/http）│
│    types/hooks.ts → 输出契约（syncHookResponseSchema、            │
│                     promptRequestSchema、isSync/AsyncHookJSONOutput）
└──────────────────────────────┬─────────────────────────────────┘
                               ▼
┌────────────────────────────────────────────────────────────────┐
│  ② 执行引擎层（utils/hooks.ts + 各类专用执行器）                 │
│    executeHooks()   统一分发器（并行执行、聚合）                  │
│    execCommandHook() bash/powershell 子进程                       │
│    execPromptHook() / execAgentHook() / execHttpHook() 专用执行   │
│    getMatchingHooks() / getHooksConfig() 匹配与来源聚合           │
│    processHookJSONOutput() 输出解析（权限/阻塞/异步/追加上下文）   │
└──────────────────────────────┬─────────────────────────────────┘
                               ▼
┌────────────────────────────────────────────────────────────────┐
│  ③ 配置与注册层（来源汇总 / 快照 / 策略门控）                    │
│    hooksSettings.ts      HookSource 七类来源、isHookEqual         │
│    hooksConfigSnapshot.ts disableAllHooks / allowManagedHooksOnly │
│    sessionHooks.ts        会话级内存 function hook                │
│    loadPluginHooks.ts     插件 hooks.json 注册                    │
│    registerSkillHooks / registerFrontmatterHooks  skill/agent     │
│    bootstrap/state.ts     registerHookCallbacks（内部 callback）   │
└──────────────────────────────┬─────────────────────────────────┘
                               ▼
┌────────────────────────────────────────────────────────────────┐
│  ④ 消费 / 触发层（各业务模块在事件点调用执行器）                  │
│    toolHooks.ts（Pre/PostToolUse + 权限决策 deny>ask>allow）      │
│    query/stopHooks.ts、utils/sessionStart.ts、gracefulShutdown.ts│
│    services/compact、services/notifier、mcp/elicitationHandler  │
│    processUserInput、fileChangedWatcher、权限 PermissionContext  │
└────────────────────────────────────────────────────────────────┘
```

### 1.2 一次 Hook 调用的数据流（文字版）

1. 某个业务模块（触发点）在事件点上构造 **HookInput**（携带 `hook_event_name` + 该事件专属字段，见 coreSchemas.ts）。
2. 触发点调用对应的 `executeXxxHooks(...)`（utils/hooks.ts）。
3. `executeHooks()` 做 **trust 门控**（trusted 项目的 permit 规则、`CLAUDE_CODE_SIMPLE` 模式、`disableAllHooks`），随后调 `getMatchingHooks()`。
4. `getMatchingHooks()` 通过 `getHooksConfig()` 从 7 类来源汇总 hook → 按事件的 **matchQuery**（如工具名）做 matcher 匹配 → 按 `if` 条件过滤 → 按 `shell+command+if` 等做去重 → 得到 `MatchedHook[]`。
5. `executeHooks()` 对所有匹配的 hook **并行**执行（每个 hook 一个 async generator / 执行器），cast 到事件专属 HookInput，处理超时与中止。
6. 每个执行器产出 `{ stdout, stderr, output, status, aborted }`，由 `parseHookOutput()` 解析：
   - 首行 `{"async":true}` → 转为后台异步；
   - JSON（`syncHookResponseSchema` / `hookJSONOutputSchema`）→ 解析 `decision`、`permissionDecision`、`updatedInput`、`additionalContext`、`elicitResponse`、`preventContinuation` 等；
   - 非 JSON → 走 **退出码协议**（0 成功 / 2 阻塞 / 其它非零 非阻塞错误）。
7. 结果在 `executeHooks` 内部 **聚合**：权限行为按 `deny > ask > allow > passthrough` 优先级取其一；`preventContinuation`、`blockingError`、`additionalContext`、`updatedInput` 等逐个产出为 `AggregatedHookResult`。
8. 触发点消费聚合结果做最终决策（例如 toolHooks.ts 的 `resolveHookPermissionDecision` 把 hook 的 allow/deny/ask 与 setting 权限规则、交互对话框合并）。

---

## 2. Hook 的类型

Hook 的类型可以从两个正交的维度来理解。

### 2.1 按「命令形式」划分（六种）

由 `src/schemas/hooks.ts` 的 `HookCommandSchema = z.discriminatedUnion('type', [...])` 定义（command / prompt / agent / http），加上引擎内部处理的 `callback` 与 `function`，共六种:

| 类型                   | 定义位置                                                | 执行方式                                | 典型用途                                                      | 说明                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`command`**  | `BashCommandHookSchema`                               | 子进程（bash / powershell）             | 任意事件的外挂命令                                            | 最通用；支持`shell`/`timeout`/`statusMessage`/`once`/`async`/`asyncRewake`/`if`                                                                             |
| **`prompt`**   | `PromptHookSchema`                                    | 由 LLM 评价（返回 ok/reason）           | 主观审核（涉及某路径的写入需 LLM 判断）                       | `prompt` 字段即给 LLM 的指令；见 execPromptHook.ts（默认 30s）                                                                                                          |
| **`agent`**    | `AgentHookSchema`                                     | 多轮子代理作为 hook（agentic verifier） | 需要完整思考链/多步验证的审核                                 | `model` 默认 Haiku、`timeout` 默认 60s；注：`execAgentHook.ts` 中 **不要加 `.transform()`**，否则会丢弃用户在 settings.json 中填的 prompt（gh-24920/CC-79） |
| **`http`**     | `HttpHookSchema`                                      | POST JSON 到远端 URL                    | 企业级联 / 云端策略 / 远程审核                                | 支持`headers` 中 `$VAR` 插值、`allowedEnvVars`、SSRF 防护（见 execHttpHook.ts）、默认超时 10 分钟                                                                   |
| **`callback`** | `src/types/hooks.ts`（`HookCallback`）              | 进程内同步调用已注册回调                | 内部机制（如 sessionFileAccessHooks、attribution）与 SDK 注册 | 不能来自用户 settings.json，只能由`registerHookCallbacks` 注册；走 executeHooks 的快速路径                                                                              |
| **`function`** | `src/utils/hooks/sessionHooks.ts`（`FunctionHook`） | 会话级内存回调（TypeScript 闭包）       | 以代码判断 true/false 作为是否放行                            | 仅 session 内有效、无法持久化到 settings.json；`errorMessage` 为失败时提示；默认 timeout 5s                                                                             |

**四种「命令形式」的子字段差异（schemas/hooks.ts）**：

- `command`：`{ type:'command', command, if?, shell?, timeout?, statusMessage?, once?, async?, asyncRewake? }`。
- `prompt`：`{ type:'prompt', prompt, if?, timeout?, model?, statusMessage?, once? }`。
- `agent`：`{ type:'agent', prompt, if?, timeout?(=60), model?(=haiku), statusMessage?, once? }`。
- `http`：`{ type:'http', url, if?, timeout?, headers?($VAR 插值), allowedEnvVars?, statusMessage?, once? }`。

所有「命令形式」都支持可选的 **`if`**（权限规则语法条件，见 §5.3）与 **`statusMessage`**（执行期间的 UI 进度提示）。

### 2.2 按「身份与生命周期」维度（isHookEqual）

`src/utils/hooks/hooksSettings.ts` 定义了 `isHookEqual(a, b)`，用于判断两个 hook 是否"同一个"，从而支持去重与移除：

- **参与身份的字段**：`command`（命令文本）、`prompt`/`url`、`shell`、`if`。
- **不参与身份的字段**：`timeout`（改超时不算新 hook）。
- `function` 型 hook **永远不相等**（每次都是独立实例）。

这个"身份"定义是 §5 去重（`hookDedupKey`）与 sessionHook 移除（`removeSessionHook`）的基础。

---

## 3. Hook 事件及其作用（27 个逐个分析）

事件枚举定义在 `src/entrypoints/sdk/coreTypes.ts` 的 `HOOK_EVENTS`（共 28 个，顺序固定）。每个事件的**输入契约**（`*HookInputSchema`）与**统一联合**（`HookInputSchema`）在 `src/entrypoints/sdk/coreSchemas.ts`。

下面按语义分组，逐个事件分析：**触发时机**、**HookInput 承载字段**、**hook 输出可改变什么**、**作用与设计意图**。

### 3.1 工具类（5 个）

**PreToolUse** — 工具调用**之前**。

- 触发：`services/tools/toolHooks.ts` 的 `runPreToolUseHooks`（在工具真正执行前，权限决策流程初始化时）。
- Input 承载：`tool_name`、`tool_input`、`tool_use_id`、`tool_use_message`、`tool_use_invocation_count`。
- 输出可改变：`permissionDecision`（allow/deny/ask，见 §7.1）、`updatedInput`（改写工具入参）、`additionalContext`（注入上下文）、`blockingError`。
- 作用：**拦截与改写工具调用**。例如：审计某命令、禁止危险命令、自动补充参数、修改 MCP 工具入参。是权限系统之外第一条防线，也是 hook 驱动权限决策的主入口。

**PostToolUse** — 工具调用**成功返回后**。

- 触发：`runPostToolUseHooks`（工具结果产生后、进入模型上下文前）。
- Input 承载：`tool_name`、`tool_input`、`tool_response`、`tool_use_id`。
- 输出可改变：`updatedMCPToolOutput`（**替换** MCP 工具的真实输出）、`additionalContext`。
- 作用：对工具结果做后处理。典型如：清洗/摘要安全工具输出、对 MCP 结果注入解读、记录副作用。

**PostToolUseFailure** — 工具调用**抛出错误后**。

- 触发：`runPostToolUseFailureHooks`（工具执行异常时）。
- Input 承载：`tool_name`、`tool_input`、`tool_response`（错误信息）、`tool_use_id`。
- 输出可改变：`additionalContext` 等（不改变已失败的事实）。
- 作用：对失败做兜底/告警/上报，不影响失败结果本身。

**PermissionRequest** — 权限确认对话框**准备弹出时**。

- 触发：`PermissionContext.runHooks`（`services/tools/toolHooks.ts` / `hooks/toolPermission/PermissionContext.ts`），在交互式权限弹窗前。
- Input 承载：`tool_name`、`tool_input`、`permission_mode`（当前权限模式）、`suggestions`（建议的权限变更）、`blocking`。
- 输出可改变：`permissionRequestResult`（`{behavior:'allow'|'deny', message, updatedInput, updatedPermissions, interrupt}`）—— allow 则代答通过（可顺带持久化权限、改写输入），deny 且 `interrupt` 则中止工具。
- 作用：**把「是否通过」外包给 hook**。企业可在云端策略钩子里决定是否放行，无需用户手动弹窗；也把 hook 与 settings 权限规则解耦（见 §7.1）。

**PermissionDenied** — 工具调用被**拒绝**后。

- 触发：`runPermissionDeniedHooks`（权限系统判定 deny 之后）。
- Input 承载：`tool_name`、`tool_input`。
- 输出可改变：`retry`（布尔，决定系统是否重试该工具调用）。
- 作用：失败后的智能重试/纠偏。例如被规则拒绝后，hook 判断可安全重试。

### 3.2 用户与会话类（6 个）

**UserPromptSubmit** — 用户**提交提示词**时。

- 触发：`utils/processUserInput/processUserInput.ts`（用户消息进入处理管线时）。
- Input 承载：`prompt`（用户输入的完整文本）。
- 输出可改变：`additionalContext`（往本次输入注入上下文）。
- 作用：用户层面的"前置处理器"——审计用户输入、注入额外指令/上下文。`prompt` 类型常在此做内容审核。

**SessionStart** — 会话**首次启动**时。

- 触发：`utils/sessionStart.ts` 的 `processSessionStartHooks`（并 await `loadPluginHooks()` 确保插件 hooks 已注册）。
- Input 承载：`source`（会话来源，如 `startup`/`resume`/`print_mode` 等）。
- 输出可改变：`initialUserMessage`、`watchPaths`（启动文件监听）。
- 作用：会话初始化最早期钩子。可注入首条用户消息（如欢迎/引导）、注册文件监听路径；也是 **ALWAYS_EMITTED** 事件之一（见 §7.4）。
- 注：`CLAUDE_ENV_FILE`、`CLAUDE_PROJECT_DIR` 等环境变量在此类启动钩子中注入（见 execCommandHook.ts）。

**SessionEnd** — 会话**关闭**时。

- 触发：`utils/gracefulShutdown.ts`（退出流程）。
- Input 承载：`reason`（退出原因，如用户退出/错误）。
- 输出可改变：无重大行为影响（主要做清理/上报）；默认超时极短（`SESSION_END_HOOK_TIMEOUT_MS_DEFAULT=1500ms`，可被 `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` 调整），避免拖慢退出。
- 作用：善后清理、遥测上报、落盘收尾的**最后机会**。

**Stop** — 模型一次**响应停止**（每轮回复结束）。

- 触发：`query/stopHooks.ts`（`handleStopHooks`，每轮 assistant 回复后）。
- Input 承载：`stop_hook_active`、`stop_reason`。
- 输出可改变：`additionalContext`（下一轮注入）、`promptSuggestion`（由 post-sampling / Stop hook 驱动，见 §7.2）、`preventContinuation`。
- 作用：**每轮循环的"检查点"**。可注入上下文、给出后续建议、或阻止继续生成。配合 `async` 可在后台跑，形成"慢评估 + 每轮复查"模式。

**StopFailure** — 响应对应 **Stop 判定失败/出错** 时。

- 触发：`gracefulShutdown.ts` 相关失败路径。
- Input 承载：`error`。
- 作用：对 Stop 处理失败的兜底上报，常与 SessionEnd 一起在关闭流程处理。

**Setup** — 会话**工具环境初始化完成**时（`settings.json` 加载后、工具就绪）。

- 触发：`utils/sessionStart.ts` 的 `processSetupHooks`。
- Input 承载：`trigger`（触发来源）。
- 输出可改变：`additionalContext`（注入工具环境说明）、`watchPaths`。
- 作用：在工具环境就绪后再做一次注入，适合给工具补充说明、启动 watcher；也是 **ALWAYS_EMITTED** 事件。

### 3.3 子代理与任务类（5 个）

**SubagentStart** — **子代理启动**时。

- 触发：`tools/AgentTool/runAgent.ts`。
- Input 承载：`agent_id`、`agent_type`、`subagent_type`、`prompt`。
- 输出可改变：`additionalContext`。
- 作用：为子代理注入上下文/针对其类型做审计（`agent_type` 用于 matcher，见 §5.1）。

**SubagentStop** — **子代理结束**时。

- 触发：`query/stopHooks.ts`（子代理 Stop 时，实际触发 SubagentStop 而非 Stop，见 registerFrontmatterHooks 中 Stop→SubagentStop 的转换）。
- Input 承载：`agent_id`、`agent_type`、`subagent_type`。
- 作用：子代理善后；同一套 hooks 也可由 agent 前端以 SubagentStop 注册。

**TeammateIdle** — **团队成员空闲**时（Swarm/多代理协作场景）。

- 触发：`query/stopHooks.ts`。
- Input 承载：`agent_id`、`agent_type`、`teammate_id`。
- 作用：多代理协作中的空闲检测钩子，用于任务分发/心跳。

**TaskCreated** — **任务被创建**时（Swarm 协作）。

- 触发：`query/stopHooks.ts`。
- Input 承载：`task_title`、`task_description`。
- 作用：新任务生成时的旁路处理（记录/审计）。

**TaskCompleted** — **任务完成**时（Swarm 协作）。

- 触发：`query/stopHooks.ts`。
- Input 承载：`task_id`、`task_result`。
- 作用：任务完成的收尾/上报。

### 3.4 上下文与状态类（6 个）

**PreCompact** — **上下文压缩开始前**。

- 触发：`services/compact/compact.ts`。
- Input 承载：`trigger`（触发原因，如上下文超限/manual）。
- 输出可改变：（可注入/记录，为压缩做准备）。
- 作用：给出"即将压缩"的提前通知，让外部可备份状态或做标记。

**PostCompact** — **上下文压缩完成后**。

- 触发：`services/compact/compact.ts`。
- Input 承载：`trigger`。
- 作用：压缩后通知，可清理/校验压缩结果。

**ConfigChange** — **运行时配置变更**时。

- 触发：`utils/hooks.ts` 的 `executeConfigChangeHooks`（配置文件被更改后）。
- Input 承载：`source`。
- 作用：配置热更新后的联动（如重启子服务、重新鉴权）。

**InstructionsLoaded** — **指令/规则加载完成**时。

- 触发：`executeInstructionsLoadedHooks`。
- Input 承载：`load_reason`。
- 作用：CLAUDE.md / 技能指令加载后的钩子，适合注入"规则已就绪"后处理。

**FileChanged** — **被监听文件变化**时。

- 触发：`utils/hooks/fileChangedWatcher.ts`。
- Input 承载：`file_path`（**matchQuery 用 basename**，即用文件名匹配，见 §5.1）。
- 作用：基于文件系统的响应式钩子——文件变化即触发，驱动增量处理。

**CwdChanged** — **当前工作目录变化**时。

- 触发：`executeCwdChangedHooks`（目录切换后）。
- Input 承载：`old_cwd`、`cwd`。
- 作用：目录切换后的重配置（如重新加载该目录相关规则）。

### 3.5 外部集成类（5 个）

**Notification** — 系统**发出通知**时。

- 触发：`services/notifier.ts`（如通知音、补丁提示、升级提醒等内部通知）。
- Input 承载：`notification_type`（**matchQuery**）、`message`、`title`、`timeframe`。
- 作用：把系统事件转发给外部（如把 CC 的通知推送到手机/IM）。
  - 注意：其触发点是系统的"通知"而非所有事件；`notification_type` 用于 matcher 细分。

**Elicitation** — MCP 工具**发出澄清请求**（需要用户/外部补充）时。

- 触发：`services/mcp/elicitationHandler.ts`。
- Input 承载：`mcp_server_name`、`interrupt`、`response_format`、`__rawRequest`。
- 输出可改变：`elicitationResponse`（结构化回复，见 `promptRequestSchema` / `hookJSONOutputSchema`）。
- 作用：**让 hook 替代用户回答 MCP 的澄清问题**——即把交互式澄清转化为程序化应答。

**ElicitationResult** — **澄清结果产生后**（MCP 拿到回复）。

- 触发：`mcp/elicitationHandler.ts`。
- Input 承载：`mcp_server_name`、`response`。
- 输出可改变：`elicitationResultResponse`（`{ action? }`，`decline` → 构造 blockingError）。
- 作用：对澄清结果做后处理/决定是否继续。

**WorktreeCreate** — **创建工作树**后。

- 触发：worktree 相关流程（Worktree 工具 / 会话工作树）。
- Input 承载：`path`、`branch`、`reference`。
- 作用：工作树创建后的联动（如初始化、记录路径）。

**WorktreeRemove** — **移除工作树**后。

- 触发：worktree 移除流程。
- Input 承载：`path`、`branch`、`reference`。
- 作用：工作树删除后的清理联动。

> 说明：`WorktreeCreate` / `WorktreeRemove` 事件在事件枚举中确实存在且被 `convertPluginHooksToMatchers` / `loadPluginHooks` 列出，但**没有独立的 `execute*Hooks` 生成器**——它们被归入通用事件分发（并在 `hooksConfigManager.ts` 元数据中提供 matcher 字段语义），因此二者更多是"注册可用、随引擎统一执行"，而没有像 PreToolUse 那样的专属触发封装。

---

## 4. Hook 的执行流程

本节从"触发点到最终决策"完整展开一条 hook 的生命周期。核心代码在 `src/utils/hooks.ts`。

### 4.1 入口与门控

触发点（如 `runPreToolUseHooks`）构造 HookInput 后调用对应的 `executeXxxHooks(...)`。`executeHooks()`（统一分发器）在真正执行前做三重门控：

1. **`shouldDisableAllHooksIncludingManaged()`** — 若 policySettings 的 `disableAllHooks` 为 true，则所有 hook（含 managed）都不执行（见 hooksConfigSnapshot.ts）。
2. **`CLAUDE_CODE_SIMPLE`** 模式 — 简单模式下跳过 hooks。
3. **trust 门控 `shouldSkipHookDueToTrust`** — 若处理的是 Bash 等工具且当前为非 trusted 项目，则按安全性跳过（避免不经允许的进程执行）。

### 4.2 匹配（getMatchingHooks，见 §5）

- 从 `getHooksConfig()` 聚合 7 类来源 → 提取 `matchQuery` → matcher 匹配 → 提取 plugin/skill 上下文 → 去重。

### 4.3 并行执行与每-hook 分发

- `executeHooks` 对每个匹配到的 hook 用一个 async generator 并行包裹（`matchingHooks.map(...)` + `all(...)`）。
- `hookName` 形如 `"${hookEvent}:${matchQuery}"` 或仅 `hookEvent`（无 matchQuery 时）。
- `sessionId` 取自 `toolUseContext?.agentId ?? getSessionId()`（子代理内的 hook 归属到子代理，外面归属主会话）。
- **内部 callback 快速路径**：若 hook 类型为 `callback`，直接 `hook.callback(hookInput, toolUseID, signal, i, context)`，不 spawn 子进程（也是 §5 中 44x 快速路径的收益来源）。
- 每个 hook 有独立 **timeout**（`hook.timeout*1000` 或默认 `TOOL_HOOK_EXECUTION_TIMEOUT_MS` = 10 分钟）与**取消**（`createCombinedAbortSignal` 合并传入信号）。
- **进度广播**：`startHookProgressInterval` 周期性 `emitHookProgress`（默认 1s），执行结果 `emitHookResponse`（走 hookEvents.ts）。

hook 按类型分派到执行器：

| 类型     | 执行器                                                            | 关键文件                                      |
| -------- | ----------------------------------------------------------------- | --------------------------------------------- |
| command  | `execCommandHook`                                               | utils/hooks.ts                                |
| prompt   | `execCommandHook`（内部走 prompt 协议） / `execPromptHook.ts` | utils/hooks.ts、utils/hooks/execPromptHook.ts |
| agent    | `execAgentHook.ts`                                              | utils/hooks/execAgentHook.ts                  |
| http     | `execHttpHook.ts`                                               | utils/hooks/execHttpHook.ts                   |
| callback | 直接调用回调                                                      | bootstrap/state.ts、types/hooks.ts            |
| function | `executeFunctionHook`（内存回调）                               | utils/hooks.ts、sessionHooks.ts               |

### 4.4 command 子进程执行（execCommandHook 详解）

- **Shell 选择**：`hook.shell ?? DEFAULT_HOOK_SHELL`（bash / powershell）。Windows 上 bash 走 Git Bash 或 `/bin/sh`；powershell 走 `pwsh`（带特定参数）。
- **路径转换**：`windowsPathToPosixPath`（Windows→POSIX）。
- **环境变量注入**（execCommandHook.ts）：`CLAUDE_PROJECT_DIR`、`CLAUDE_PLUGIN_ROOT`、`CLAUDE_PLUGIN_DATA`、`CLAUDE_PLUGIN_OPTION_*`、以及特定事件（SessionStart/Setup/CwdChanged/FileChanged）注入 `CLAUDE_ENV_FILE`。
- **变量替换**：`${CLAUDE_PLUGIN_ROOT}`、`${CLAUDE_PLUGIN_DATA}` 在命令文本中替换（sessionHooks/skillRoot 提供 CLAUDE_PLUGIN_ROOT）；`substituteUserConfigVariables` 做插件 option 替换。
- **Windows 细节**：bash 下对 `.sh` 文件自动补全；`CLAUDE_CODE_SHELL_PREFIX` 包裹命令；`windowsHide: true` spawn。
- **cwd 兜底**：`pathExists` 检查，不存在则回退。
- **异步处理**：
  - 配置式后台化：`hook.async || hook.asyncRewake`（且非 `forceSyncExecution`）→ `executeInBackground` 后台执行，先向 stdin 写入 `'\n'`（触发唤醒）。
  - **首行协议**：若子进程 stdout 首行是 `{"async":true}`（`isAsyncHookJSONOutput`）→ 转为后台执行。
- **Prompt 协议**（command 型也支持 prompt elicitation）：对输出逐行 `promptRequestSchema.safeParse`，命中的行从最终 stdout 剥除，并序列化回复写入 `child.stdin.write(JSON.stringify(response) + '\n')`——实现"command 进程内与模型交互"。
- **stdin 要求**：进程可能需要读取 stdin（`stdin: 'pipe'`）；对不读 stdin 的进程写入需防止阻塞（处理 EPIPE）。

### 4.5 输出解析与退出码协议

`execCommandHook` 结束后得到 `{ stdout, stderr, output, status, aborted }`，进入 `parseHookOutput()`（utils/hooks.ts:399）：

1. 若以 `{` 开头 → 尝试 JSON 解析（`processHookJSONOutput`）；解析失败且有 schema hint 则提示。
2. 否则视为 **plainText** → 走退出码协议。

**退出码协议**（非 JSON 分支，`exec` 过程体 utils/hooks.ts:2446+）：

| 退出码    | 语义                       | 产物                                                   |
| --------- | -------------------------- | ------------------------------------------------------ |
| `0`     | 成功                       | `hook_success` attachment（携带 stdout）             |
| `2`     | **阻塞**             | `blockingError`：`[${hook.command}]: ${result.stderr |
| 其它非零  | **非阻塞错误**       | `hook_non_blocking_error` attachment（不阻断主流程） |
| EPIPE     | 部分输出即挂（stdin 关闭） | status 1（partial）                                    |
| ABORT_ERR | 被取消                     | aborted                                                |

**JSON 分支（processHookJSONOutput 的责任）**，按 schema（types/hooks.ts `hookJSONOutputSchema`）解析：

- `continue`：`false` → `preventContinuation` + `stopReason`（停止继续生成）。
- `decision`：`approve`→allow、`block`→deny（+blockingError）。
- `permissionDecision`：`allow / deny / ask`（主要 PreToolUse 用）。
- `hookSpecificOutput` 按事件：
  - PreToolUse → `updatedInput`、`additionalContext`
  - UserPromptSubmit → `additionalContext`
  - SessionStart → `initialUserMessage`、`watchPaths`
  - Setup / SubagentStart →（上下文等）
  - PostToolUse → `updatedMCPToolOutput`
  - PostToolUseFailure →（记录）
  - PermissionDenied → `retry`
  - PermissionRequest → `decision.behavior` + `updatedInput`
  - Elicitation / ElicitationResult → `action`（decline → blockingError）
- 创建 `hook_blocking_error` / `hook_success` attachment 消息（`createAttachmentMessage`）。

> **异步识别顺序**：异步的判定要么靠**配置**（`hook.async`），要么靠**输出首行 `{"async":true}`**。两者都导致 `executeInBackground`，主流程立即继续，后台 hook 通过 `basePrompter`/重唤醒机制在后续轮次回灌结果。

### 4.6 结果聚合（executeHooks 尾部）

遍历每个 hook 的 yield 结果，聚合进最终：

- `preventContinuation` / `stopReason`（任一触发即停）。
- `blockingError`（任一 hook 阻塞即阻断）。
- `additionalContext`、`initialUserMessage`、`watchPaths`、`updatedMCPToolOutput`（逐条产出）。
- **权限行为聚合**（核心）：按优先级 `deny > ask > allow`，`passthrough` 不设值。只有上一优先级未占用时才写入：
  - `deny` 总是抢占；
  - `ask` 仅当当前不是 deny；
  - `allow` 仅当当前为空。
  - 若为 allow/ask 且 hook 给了 `updatedInput`，则一并产出（deny 时丢弃 updatedInput）。
- `permissionRequestResult`、`retry`、`elicitationResponse` 等按事件产出。

### 4.7 REPL 内 / 外两条执行路径

- **REPL 内**：`executeHooks`（与主 query loop 同在一个渲染/执行上下文，聚合结果可直接驱动 UI）。由 `toolExecution.ts` 与 REPL 工具包裹层调用。
- **REPL 外**：`executeHooksOutsideREPL`（utils/hooks.ts:3003）用于后台/无 UI 环境（如 hook 触发的子流程），共享同一套匹配与 schema，但不依赖 React 状态。

### 4.8 超时与生命周期

- `TOOL_HOOK_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000`（10 分钟）为 command/http 默认上限。
- SessionEnd 特殊：默认 `1500ms`（`SESSION_END_HOOK_TIMEOUT_MS_DEFAULT`），可由 `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` 覆盖，避免阻塞退出。
- 遥测：每次 hook 执行记录 `tengu_run_hook`，并用 OTEL span（`startHookSpan`/`endHookSpan`）包裹（配置了 OTEL 时）。

---

## 5. Hook 的匹配机制

### 5.1 matchQuery —— 每个事件"拿什么去匹配"

`getMatchingHooks`（utils/hooks.ts:1603）先从 HookInput 抽取 `matchQuery`，再与 `matcher.matcher` 匹配。各事件的 matchQuery 来源（与 hooksConfigManager.ts 元数据保持一致）：

| 事件                                                                                 | matchQuery 来源                                   |
| ------------------------------------------------------------------------------------ | ------------------------------------------------- |
| PreToolUse / PostToolUse / PostToolUseFailure / PermissionRequest / PermissionDenied | `tool_name`（工具名）                           |
| SessionStart                                                                         | `source`                                        |
| Setup / PreCompact / PostCompact                                                     | `trigger`                                       |
| Notification                                                                         | `notification_type`                             |
| SessionEnd                                                                           | `reason`                                        |
| StopFailure                                                                          | `error`                                         |
| SubagentStart / SubagentStop                                                         | `agent_type`                                    |
| TeammateIdle / TaskCreated / TaskCompleted                                           | 无 matchQuery（所有此类 hooks 均触发）            |
| Elicitation / ElicitationResult                                                      | `mcp_server_name`                               |
| ConfigChange                                                                         | `source`                                        |
| InstructionsLoaded                                                                   | `load_reason`                                   |
| FileChanged                                                                          | `basename(file_path)`（用**文件名**匹配） |
| CwdChanged / Stop / WorktreeCreate / WorktreeRemove / UserPromptSubmit               | 无 matchQuery（全局触发）                         |

### 5.2 matcher 的匹配规则（matchesPattern, utils/hooks.ts:1346）

对给定 `matchQuery` 与 `matcher` 串：

- `matcher === '*'` → 总是匹配。
- 简单串（字符集 `[a-zA-Z0-9_|]+`）→ 精确匹配，或者是 `|` 分隔的多值任一匹配；同时会对 legacy 工具名做归一化（`normalizeLegacyToolName`，兼容旧名）。
- 其它 → 当作**正则**匹配（同样也测试 legacy 名字）；非法正则 → false（不匹配）。

### 5.3 `if` 条件（权限规则语法预过滤）

每个 hook 可带 `if`，其语法与权限规则一致，例如 `"Bash(git *)"`（"当 Bash 工具的参数匹配 `git *` 时"）。

- 作用：在**匹配阶段**用 `prepareIfConditionMatcher` 评估，**命中才作为候选 hook**，从而**避免不必要的子进程 spawn**。
- `if` 也参与 hook 去重键（见下）。

### 5.4 来源聚合与去重（getHooksConfig + getMatchingHooks）

`getHooksConfig`（utils/hooks.ts:1492）合并：

1. **配置快照**来源（`getHooksConfigFromSnapshot`，settings 合并，见 §6.3）；若 `managedOnly`（managed hooks only）则跳过带 `pluginRoot` 的检出项。
2. **已注册回调**（`bootstrap/state.ts` 的 registered callbacks，含插件与内部）；managedOnly 时跳过带 pluginRoot 的。
3. **会话 hooks**（`sessionHooks.ts`；managedOnly 时跳过，含 skillRoot 区分）。
4. **会话 function hooks**（`getSessionFunctionHooks`）。

`getMatchingHooks` 在 matcher 列表后为每个 hook 附上 **plugin/skill 上下文**（`pluginRoot`/`pluginId`/`skillRoot`/`hookSource`），再按来源去重：

- **去重键 `hookDedupKey`** 以 `pluginRoot`/`skillRoot` 命名空间化（防止跨插件模板键冲突，gh-29724）。
- 分类型去重：
  - command：键 = `shell + '\0' + command + '\0' + if`（shell 是身份的一部分，默认 bash，兼容无 shell 的旧配置）。
  - prompt：键 = `prompt + '\0' + if`。
  - agent：键 = `prompt + '\0' + if`。
  - http：键 = `url + '\0' + if`（依同规则）。
- **快速路径**：若全部是 callback/function 型（如内部 sessionFileAccessHooks/attributionHooks），跳过 6 趟过滤 + 4×Map + 4×Array.from，直接返回（微基准提速 44x）。
- 注意 `new Map(entries)` 在键冲突时保留**最后一个**条目——settings 合并时最后合并的作用域胜出；同插件的重复因 pluginRoot 相同无影响。

### 5.5 顺序

- 匹配到的多个 hook **并行**执行（不保证串行顺序）。
- 但**来源合并在 getHooksConfig 中的顺序**（快照 → 注册 → 会话 → 会话 function）决定了去重碰撞时的胜出者（后者覆盖前者）。

---

## 6. Hook 的来源与配置

### 6.1 七类来源（HookSource）

`src/utils/hooks/hooksSettings.ts` 定义 `HookSource`：

| 来源                | 含义                          | 载体                                |
| ------------------- | ----------------------------- | ----------------------------------- |
| `userSettings`    | 用户级 settings.json          | `~/.claude/settings.json`         |
| `projectSettings` | 项目级 settings.json          | `<project>/.claude/settings.json` |
| `localSettings`   | 本地（不进版本控制）settings  | `.claude/settings.local.json`     |
| `policySettings`  | 策略/托管级 settings          | 企业/托管下发的 settings            |
| `pluginHook`      | 插件声明                      | 插件`hooks.json` / 清单           |
| `sessionHook`     | 会话级（前端/运行时动态注册） | AppState.sessionHooks               |
| `builtinHook`     | 内置                          | 代码`registerHookCallbacks` 注册  |

### 6.2 settings.json 的 `hooks` 键结构

`schema/hooks.ts`：`HooksSchema = z.partialRecord(z.enum(HOOK_EVENTS), array(HookMatcherSchema))`，其中：

- `HookMatcherSchema = { matcher?: string, hooks: HookCommand[] }`。
- 即：`hooks: { PreToolUse: [{ matcher: "Bash", hooks: [ {...} ] }] }`。

`keysToExpand=['permissions','sandbox','hooks']`（utils/settings/settings.ts）——这些键在 settings 合并时按源叠加而非覆盖。

### 6.3 配置快照与策略门控（hooksConfigSnapshot.ts）

- **`captureHooksConfigSnapshot()`**：启动时调用一次，调用 `getHooksFromAllowedSources()` 生成 `initialHooksConfig`。
- **`updateHooksConfigSnapshot()`**：`/hooks` 修改或文件 watcher 后调用，先 `resetSettingsCache()` 再重取（避免读陈旧缓存）。
- **`getHooksFromAllowedSources()` 的过滤链**（自上而下短路）：
  1. policySettings `disableAllHooks` → 返回空。
  2. policySettings `allowManagedHooksOnly` → 仅返回 policy hooks。
  3. `strictPluginOnlyCustomization`（`isRestrictedToPluginOnly('hooks')`）→ 仅返回 policy hooks（插件 hooks 走单独注册通道，不受影响；agent 前端 hooks 在注册时按 agent source 门控）。
  4. 非 policy 的 `disableAllHooks` → 仅返回 policy hooks（非托管设置无法禁用托管 hooks）。
  5. 否则 → 返回全部来源合并的 `mergedSettings.hooks`。
- **`shouldAllowManagedHooksOnly()`**：policy `allowManagedHooksOnly` 或"非 policy disableAllHooks"时为 true。
- **`shouldDisableAllHooksIncludingManaged()`**：仅 policy `disableAllHooks` 时为 true（执行期门控用，见 §4.1）。

### 6.4 插件 hooks

- 插件在 manifest 声明含 hooks，其 `hooks.json` 由 `utils/plugins/schemas.ts` 的 `PluginHooksSchema` 校验（外层描述 + `hooks` 属性）。
- `utils/plugins/loadPluginHooks.ts`：
  - `convertPluginHooksToMatchers` 把插件的 hooks 翻译成带 `pluginRoot`/`pluginName`/`pluginId` 的 `PluginHookMatcher`。
  - `loadPluginHooks`（memoize）加载所有 enabled 插件的 hooks，**先清后注**（原子交换，避免插件管理操作后 Stop hooks 静默失效，gh-29767）。
  - **热重载**：`settingsChangeDetector` 订阅，插件启用/禁用变更即重新加载。
- HTTP hooks 的 **SSRF 防护**与 `allowedHttpHookUrls` / `httpHookAllowedEnvVars` 在 `execHttpHook.ts` 落实（不能打到内网任意地址、只能透传允许的 env）。

### 6.5 回调解耦注册（bootstrap/state.ts）

`registerHookCallbacks(callbacks)` 把 `RegisteredHookMatcher`（`HookCallbackMatcher | PluginHookMatcher`）写入 `STATE.registeredHooks`，`getRegisteredHooks` 读取，`clearRegisteredPluginHooks` 清插件部分。这是 **callback 型** hook 的唯一注册通道，也是内部机制（如 `utils/sessionFileAccessHooks.ts` 的 `registerSessionFileAccessHooks`）的实现方式。

### 6.6 会话级函数 hook / 会话 hook（sessionHooks.ts）

- `addSessionHook`（command/prompt 型，会话级，可带 `onHookSuccess` 回调）；`removeSessionHook`（按 isHookEqual 移除）。
- `addFunctionHook`（`FunctionHook`，内存 TS 回调，返回 boolean 决定放行；可 `removeFunctionHook` 按 id 移除）。
- `getSessionHooks`（不含 function）、`getSessionFunctionHooks`（仅 function，因为 function 无法持久化）、`clearSessionHooks`（会话结束清理）。
- `SessionHooksState` 用 Map 而非 Record，`.set` 不改变容器身份 → store 的 `Object.is` 短路 → 高并发下避免 O(N²) 复制与回调风暴。

### 6.7 /hooks UI 与 /hooks 命令

- `components/hooks/HooksConfigMenu.tsx`：`/hooks` 的交互 UI，可查看/增删改各事件的 hooks，改动后走 `updateHooksConfigSnapshot`。
- `commands/hooks/index.ts`：`/hooks` 命令入口。

### 6.8 环境变量（hook 子进程可见）

`CLAUDE_PROJECT_DIR`、`CLAUDE_PLUGIN_ROOT`、`CLAUDE_PLUGIN_DATA`、`CLAUDE_PLUGIN_OPTION_*`、`CLAUDE_ENV_FILE`（启动类事件）；`CLAUDE_CODE_SHELL_PREFIX`（bash 前缀包裹）；`CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`（SessionEnd 超时）。

---

## 7. Hook 与其他系统的协作机制

### 7.1 与权限系统

这是 hook 影响主流程最深的一环，见 `services/tools/toolHooks.ts` 的 `resolveHookPermissionDecision` 与 `hooks/toolPermission/PermissionContext.ts` 的 `runHooks`。

**PreToolUse → 权限合并**（resolveHookPermissionDecision）：

- hook `allow`：跳过交互弹窗，但**仍需过 `canUseTool` 与 `checkRuleBasedPermissions`**：
  - 若工具需要用户交互（`requiresUserInteraction`）且 hook 给了 `updatedInput` → 视为交互已由 hook 满足（例如 headless wrapper 收集了 AskUserQuestion 答案）；
  - 若 `requireCanUseTool`（如沙箱/泳道）→ 仍走 `canUseTool`；
  - 规则检查为 null（无 deny/ask 规则）→ 直接放行；
  - 规则为 deny → **规则覆盖 hook 的 allow**；
  - 规则为 ask → 仍需弹窗（hook 的 allow 不能绕过 ask 规则）。
- hook `deny`：直接返回 deny（`hookPermissionResult` 作为 decision）。
- 无 hook 决策或 `ask`：走正常 `canUseTool`，但若 hook 是 ask，则用 `forceDecision=hookPermissionResult` 让弹窗显示 hook 的 ask 消息，且用 hook 的 updatedInput 作为初始 input。

**PermissionRequest → 代答权限**（PermissionContext.runHooks）：

- hook 返回 `{behavior:'allow'}` → `handleHookAllow`：可携带 `updatedPermissions` 持久化权限、`updatedInput` 改写输入，返回 allow decision（source: hook）。
- hook 返回 `{behavior:'deny'}` → 构建 deny decision；若 `interrupt` → `abortController.abort()` 中止工具。
- 聚合也是在 executeHooks 层按 `deny>ask>allow` 完成（见 §4.6）。

**coordinator / interactive / swarm worker 三种 UI 后端**：权限弹窗在不同 UI 后端（交互式、协调器、泳道 worker）中实现，但共享同一套 hook 权限语义（`PermissionContext` 与 `useSwarmPermissionPoller` 等共用 `resolve`/处理协议）。

### 7.2 与 Skill 系统

Skill 通过在**前端（frontmatter）声明 hooks** 获得执行级扩展能力，由两类文件承载（实现基本相同，均落到 session 级 hook）：

- `utils/hooks/registerSkillHooks.ts`：从 skill 的 frontmatter `hooks` 注册为 session hooks；`once:true` 的 hook 在首次成功执行后自动移除（onHookSuccess 回调）。
- `utils/hooks/registerFrontmatterHooks.ts`：供 agent 与 skill 通用注册；**对 agent 会把 `Stop` 转换为 `SubagentStop`**（因为子代理完成触发的是 SubagentStop 而非 Stop），并按 agent/skill 来源门控注册。

其它协作点：

- `utils/hooks/skillImprovement.ts`：skill 改进相关——通过 hook 捕获 Stop/交互信号驱动 prompt/技能改进建议。
- `utils/hooks/postSamplingHooks.ts`：`registerPostSamplingHook` 可为"采样后"阶段注册回调，常与 Stop hook 配合做 prompt suggestion。
- skill 的 `skillRoot` 会作为 `CLAUDE_PLUGIN_ROOT` 注入其 hook 的 env。

### 7.3 与插件系统

- 插件通过 `hooks.json` 声明 hooks（`PluginHooksSchema` 校验），经 `loadPluginHooks` 翻译成带 plugin 上下文的 matcher 后 `registerHookCallbacks` 注册。
- 插件 hooks 在 executeHooks 中带 `pluginRoot`/`pluginId`/`pluginName`、`hookSource='plugin:name'`；`CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA`/`CLAUDE_PLUGIN_OPTION_*` 注入其子进程 env。
- 插件管理（`utils/plugins/refresh.ts`、`hooks/useManagePlugins.ts`）触发热重载，"先清后注"保证原子性。

### 7.4 与 SDK / Agent SDK / 远程模式

- `src/entrypoints/sdk/coreTypes.ts` 与 `coreSchemas.ts` 即 SDK 对外的契约：`HOOK_EVENTS`、各事件 `*HookInputSchema` 与统一 `HookInputSchema` 联合。
- **事件流**：`src/utils/hooks/hookEvents.ts` 提供 `registerHookEventHandler`/`emitHookStarted`/`emitHookProgress`/`emitHookResponse`；
  - `ALWAYS_EMITTED_HOOK_EVENTS = ['SessionStart','Setup']`（低噪声、向后兼容，始终广播）；
  - `setAllHookEventsEnabled(true)`（SDK 设置 `includeHookEvents` 或 `CLAUDE_CODE_REMOTE` 模式）后，所有 28 个事件都会广播；
  - 无 handler 时事件进入 `pendingEvents`（上限 100，FIFO 丢弃）。
- `AsyncHookRegistry.ts`：异步 hook 注册/唤醒管理（配合配置 `async`/`asyncRewake` 与首行 `{"async":true}` 协议）。
- `apiQueryHookHelper.ts`：把 API 查询包装成可复用 hook 执行器（`createApiQueryHook`，供内部 agent/prompt 评估复用）。

### 7.5 与消息 / UI 系统

- `utils/messages.ts`：定义 `hook_*` 附件类型（`hook_success`、`hook_blocking_error`、`hook_non_blocking_error`、`hook_system_message` 等），由 `createAttachmentMessage` 生成，渲染进会话。
- `utils/collapseHookSummaries.ts`：把多条 hook 进度/响应折叠为摘要，控制 UI 噪音。
- `HookProgressMessage`：UI 中展示"某 hook 正在运行/其输出"。
- `/hooks` 菜单（HooksConfigMenu.tsx）提供可视化管理与实时改动生效。

### 7.6 与 file watcher / 记忆 / startup 通知

- `utils/hooks/fileChangedWatcher.ts`：维护监听路径，`FileChanged` 事件触发；`CwdChanged` 在目录切换触发；`SessionStart`/`Setup` hook 可返回 `watchPaths` 动态注册监听。
- 内部 **callback hook** 范例：`utils/sessionFileAccessHooks.ts` 的 `registerSessionFileAccessHooks`（内置、进程内、同 session 的授权钩子）；`utils/attribution.ts` / `commitAttribution.ts` 也用内部 hook 做 git 责任归属（commit 后的处理）。
- `services/notifier.ts`：`Notification` 事件源（通知音/补丁/升级提醒），可被 hook 桥接到外部（如推送手机）。
- `utils/sessionStart.ts`：`processSessionStartHooks`/`processSetupHooks` 在启动/工具环境就绪时触发，并 await `loadPluginHooks()` 确保插件 hooks 已注册。

---

## 8. 总结：设计哲学与机制亮点

1. **事件驱动、非侵入**：28 个事件覆盖"工具、会话、上下文、子代理、外部集成"全部关键节点，主流程代码只需在事件点调用统一的 `executeXxxHooks`，扩展逻辑完全外挂。
2. **统一的执行引擎 + 分型执行器**：`executeHooks` 作为单一分发/聚合器，command/prompt/agent/http/callback/function 六种形态共享同一套匹配、门控、解析、聚合与遥测。
3. **强契约、可编程的返回协议**：JSON 输出（sync/async、decision、permissionDecision、updatedInput、additionalContext、elicitation、preventContinuation）把"hook 能否影响主流程"定义得非常明确；退出码协议（0/2/其它）为无 JSON 的简单命令提供"成功/阻塞/非阻塞错误"三态。
4. **多来源、可托管、有策略门控**：七类来源 + 快照机制 + `disableAllHooks`/`allowManagedHooksOnly`/`strictPluginOnlyCustomization`/`allowedHttpHookUrls` 等策略，兼顾个人扩展、插件生态与企业托管安全。
5. **权限深度融合**：PreToolUse/PermissionRequest 的 allow/deny/ask 与 settings 权限规则、交互弹窗在 `resolveHookPermissionDecision` 与 `PermissionContext` 中精确合并（deny>ask>allow、规则可覆盖 hook、交互可由 hook 代答），是 CC 权限模型的有机组成。
6. **与 Skill/Plugin/SDK 无缝协作**：Skill/agent 前端把 hooks 注册为会话级（含 Stop→SubagentStop 转换与 once 自动移除）；插件以 `PluginHookMatcher` 带上下文注册并热重载；SDK 通过 `includeHookEvents` 订阅完整事件流。
7. **性能与工程细节**：callback/function 快速路径（44x）、去重键按来源命名空间化、sessionHooks 用 Map 避免高并发回调风暴、SessionEnd 短超时保障退出、OTEL span 与 `tengu_run_hook` 遥测——都为"可扩展但不拖累主循环"做了扎实的工程取舍。
