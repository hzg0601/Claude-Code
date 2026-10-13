# Claude Code 多智能体（Multi-Agent）机制完全解析

> 本文基于 Claude Code 源码（`d:\codes\Claude-Code\src`）逐一分析，**不参考任何 doc 文档**，仅以 `.ts` / `.tsx` 源码为准。
> 文中所有引用均标注源码路径与行号，便于回溯验证。

多智能体是 Claude Code 中最具纵深的一层架构。它并不仅仅是一个能"调用子代理"的工具，
而是由**四个递进层次**共同构成的完整系统：

1. **Subagent**（`Agent` 工具）—— 最基础的单元，主智能体按需派发一次性子任务；
2. **Swarm / Team**（团队）—— 最高层的编排，一个 lead + 多个并行 teammate 组成持久化团队，各自有身份与信箱；
3. **Coordinator**（协调器模式）—— 单一协调器派发"worker"型异步子代理的组合模式；
4. **Remote / CCR**（云端 teleport）—— 把执行迁移到 Claude.ai 云端会话，本地只负责轮询结果。

在深入每一层之前，先建立整套系统的**类型全景**与**门控机制**。

---

## 一、多智能体的总体架构与类型全景

### 1.1 七个任务类型（TaskType）——多智能体的运行时形态

无论哪种"智能体"，在运行时都会被登记为一个 **Task**。CC 把所有后台可追踪的实体统一建模为任务状态机。任务类型的全集定义在 [Task.ts:6-13](src/Task.ts#L6-L13)：

```ts
export type TaskType =
  | 'local_bash'
  | 'local_agent'
  | 'remote_agent'
  | 'in_process_teammate'
  | 'local_workflow'
  | 'monitor_mcp'
  | 'dream'
```

其中与"智能体"直接相关的有 **4 种**，其余为支撑型：

| 任务类型                | 前缀  | 对应文件                                         | 本质                                 | 是否"智能体"  |
| ----------------------- | ----- | ------------------------------------------------ | ------------------------------------ | ------------- |
| `local_agent`         | `a` | `tasks/LocalAgentTask/LocalAgentTask.tsx`      | 本机进程内运行的子代理（Agent 工具） | ✅            |
| `in_process_teammate` | `t` | `tasks/InProcessTeammateTask/`                 | 同进程运行的 swarm teammate          | ✅            |
| `remote_agent`        | `r` | `tasks/RemoteAgentTask/RemoteAgentTask.tsx`    | 云端（CCR）远程会话                  | ✅            |
| `local_workflow`      | `w` | `tasks/LocalWorkflowTask/LocalWorkflowTask.ts` | `workflow` 工具（特性开关门控）    | ⚠️ 编排脚本 |
| `local_bash`          | `b` | `tasks/LocalShellTask/`                        | 持久化 PTY shell 进程                | ❌            |
| `monitor_mcp`         | `m` | `tasks/MonitorMcpTask/`                        | `monitor` 工具（门控）             | ❌            |
| `dream`               | `d` | `tasks/DreamTask/`                             | 空闲"梦游"后台进程                   | ❌            |

任务 ID 由前缀 + 8 字节随机数组成（[Task.ts:98-106](src/Task.ts#L98-L106)），字母表为
36 进制小写，`36^8 ≈ 2.8 万亿` 组合，旨在抵御暴力符号链接攻击（[Task.ts:95-96](src/Task.ts#L95-L96)）：

```ts
const TASK_ID_PREFIXES: Record<string, string> = {
  local_bash: 'b', local_agent: 'a', remote_agent: 'r',
  in_process_teammate: 't', local_workflow: 'w',
  monitor_mcp: 'm', dream: 'd',
}
export function generateTaskId(type: TaskType): string { /* 前缀 + randomBytes(8) */ }
```

所有任务共享 `TaskStateBase`（[Task.ts:45-57](src/Task.ts#L45-L57)）：
`id / type / status / description / toolUseId / startTime / endTime / outputFile / outputOffset / notified`。
状态机有 5 态：`pending / running / completed / failed / killed`，终止态有守卫函数
`isTerminalTaskStatus`（[Task.ts:27-29](src/Task.ts#L27-L29)）。

### 1.2 任务注册表

任务的注册与查询统一在 [tasks.ts:22-39](src/tasks.ts#L22-L39)：

```ts
export function getAllTasks(): Task[] {
  const tasks: Task[] = [LocalShellTask, LocalAgentTask, RemoteAgentTask, DreamTask]
  if (LocalWorkflowTask) tasks.push(LocalWorkflowTask)
  if (MonitorMcpTask) tasks.push(MonitorMcpTask)
  return tasks
}
export function getTaskByType(type: TaskType): Task | undefined {
  return getAllTasks().find(t => t.type === type)
}
```

注意两点设计：

- `LocalWorkflowTask` 与 `MonitorMcpTask` 是**条件加载**的——分别由 `feature('WORKFLOW_SCRIPTS')`
  与 `feature('MONITOR_TOOL')` 门控，特性关闭时为 `null`（[tasks.ts:9-14](src/tasks.ts#L9-L14)）。
- 每个 `Task` 只暴露 `{ name, type, kill }` 三个字段（[Task.ts:72-76](src/Task.ts#L72-L76)）。
  历史版本曾有 `spawn`/`render` 多态分发，但已在重构中移除（PR #22546），
  派发改为各调用点直接调用（如 `registerLocalAgent`、`registerRemoteAgentTask`）。

### 1.3 四层架构的门控（feature flag）

多智能体的每一层都有**独立的开关**，这是理解"什么功能在什么环境下可用"的关键：

**① Agent 工具（Subagent）**——始终可用，无门控。但嵌套能力在非 ant 构建上有差异：
`constants/tools.ts` 的 `ALL_AGENT_DISALLOWED_TOOLS` 会把 `Agent` 本身从非 ant 构建的工具池剔除
（见 §2.6），即外部用户默认**不能**父子随意无限嵌套，而在 ant 构建内部可以。

**② Swarm / Team**——集中门控在 [agentSwarmsEnabled.ts:24-44](src/utils/agentSwarmsEnabled.ts#L24-L44)：

```ts
export function isAgentSwarmsEnabled(): boolean {
  if (process.env.USER_TYPE === 'ant') return true       // 内部 ant 构建：永远开启
  if (!isEnvTruthy(process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) &&
      !isAgentTeamsFlagSet()) return false               // 外部：需 env 或 --agent-teams 二选一
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_flint', true)) return false  // GrowthBook 熔断
  return true
}
```

外部用户必须同时满足：(a) 设置 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` **或** 传 `--agent-teams`
（直接查 `process.argv` 以避免循环依赖，见 [agentSwarmsEnabled.ts:10-12](src/utils/agentSwarmsEnabled.ts#L10-L12)）；
(b) GrowthBook 门 `tengu_amber_flint` 处于开启（作为远程熔断开关）。

**③ Coordinator 模式**——门控在 [coordinatorMode.ts:36-41](src/coordinator/coordinatorMode.ts#L36-L41)：

```ts
export function isCoordinatorMode(): boolean {
  return feature('COORDINATOR_MODE') && isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
}
```

需同时满足 bundle 编译特性 `COORDINATOR_MODE` 与环境变量 `CLAUDE_CODE_COORDINATOR_MODE`。

**④ Remote / CCR**——由 ant 内部能力驱动（`isolation: 'remote'` 仅在 ant 可用），
另由 `/ultraplan`、`/ultrareview`、`autofix-pr` 等命令触发。

---

## 二、Subagent：Agent 工具（最基础的单元）

Subagent 是整个多智能体系统的**地基**。其余所有层次（coordinator 的 worker、作用域更大的团队）都建立在这一层的派发机制之上。

### 2.1 AgentDefinition：智能体的"角色定义"

`AgentDefinition` 是一个**判别联合类型**（[loadAgentsDir.ts:105-165](src/tools/AgentTool/loadAgentsDir.ts#L161-L165)），
统一在 `BaseAgentDefinition` 之下：

```ts
export type BaseAgentDefinition = {
  agentType: string                 // 智能体类型名（工具的 subagent_type 选择依据）
  whenToUse: string                 // 告诉模型"何时该用"的描述（注入提示词）
  tools?: string[]                  // 允许的工具（'*' 通配）
  disallowedTools?: string[]
  skills?: string[]
  mcpServers?: AgentMcpServerSpec[]
  hooks?: HooksSettings             // 智能体级钩子
  color?: AgentColorName
  model?: string                    // 'inherit' / 'sonnet' / 'opus' / 'haiku' / 具体模型
  effort?: EffortValue
  permissionMode?: PermissionMode
  maxTurns?: number
  filename?: string; baseDir?: string
  memory?: AgentMemoryScope         // 'user' | 'project' | 'local'
  isolation?: 'worktree' | 'remote'
  background?: boolean
  initialPrompt?: string
  ...
}
```

根据 `source` 字段细分为三种（[loadAgentsDir.ts:166-184](src/tools/AgentTool/loadAgentsDir.ts#L166-L184)）：

- **BuiltIn**（`source: 'built-in'`）：内置智能体，如 `general-purpose`、`Explore`、`Plan` 等；
- **Custom**（`source: 'user' | 'project' | ...`）：用户自定义，来自 `.claude/agents/*.md` 或 settings JSON；
- **Plugin**（`source: 'plugin'`）：来自插件目录。

**加载位置与优先级**：`getAgentDefinitionsWithOverrides(cwd)`（[loadAgentsDir.ts:296](src/tools/AgentTool/loadAgentsDir.ts#L296)）
通过 `loadMarkdownFilesForSubdir('agents', cwd)` 从配置层级扫描 markdown，
再与插件、内置合并，最后由 `getActiveAgentsFromList`（[loadAgentsDir.ts:193-221](src/tools/AgentTool/loadAgentsDir.ts#L193-L221)）
按 **内置 → 插件 → 用户 → 项目 → flag → managed** 的优先级去重（后加载者通过 `Map.set` 覆盖前者）。
agent 文件是 **frontmatter + 正文 markdown** 格式，由 `parseAgentFromMarkdown`
（[loadAgentsDir.ts:541](src/tools/AgentTool/loadAgentsDir.ts#L541)）解析：YAML 头映射到字段、正文成为系统提示词。
同样支持 **settings JSON** 定义（`AgentJsonSchema`，[loadAgentsDir.ts:73-99](src/tools/AgentTool/loadAgentsDir.ts#L73-L99)）。

一个值得注意的细节：当 `memory` 开启时，系统会**强制追加** `Write / Edit / Read` 工具
（[loadAgentsDir.ts:662-674](src/tools/AgentTool/loadAgentsDir.ts#L662-L674)），以便智能体维护自己的记忆文件，
并追加记忆提示词 `loadAgentMemoryPrompt`（见 §2.8）。

### 2.2 内置智能体类型

[builtInAgents.ts](src/tools/AgentTool/builtInAgents.ts) 集中定义了内置智能体：

| 类型                  | 定位                           | 关键约束                                                                                                                              |
| --------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `general-purpose`   | 通用工作者                     | `tools: ['*']`，`model: 'inherit'`（`getDefaultSubagentModel()`）                                                               |
| `Explore`           | 只读搜索/定位                  | `disallowedTools: [Agent, ExitPlanMode, Edit, Write, NotebookEdit]`，`omitClaudeMd: true`                                         |
| `Plan`              | 架构/实现规划                  | 同 Explore 的禁用清单，`tools: EXPLORE_AGENT.tools`                                                                                 |
| `statusline-setup`  | 状态栏配置向导                 | —                                                                                                                                    |
| `claude-code-guide` | CC/Agent SDK 使用问答          | —                                                                                                                                    |
| `verification`      | 代码验证（门控）               | —                                                                                                                                    |
| `fork`              | 隐式分支专用（`FORK_AGENT`） | `tools:['*']`, `maxTurns:200`, `permissionMode:'bubble'`（[forkSubagent.ts:60-71](src/tools/AgentTool/forkSubagent.ts#L60-L71)） |

`Explore`/`Plan` 由 `areExplorePlanAgentsEnabled()` 门控（[builtInAgents.ts:13-20](src/tools/AgentTool/builtInAgents.ts#L13-L20)）。
在 coordinator 模式下，`getCoordinatorAgents()` 会**替换**默认内置集（[builtInAgents.ts:35-43](src/tools/AgentTool/builtInAgents.ts#L35-L43)）。

### 2.3 触发条件与时机：Agent 工具的 5 条路径

Subagent 的**唯一触发源**是主智能体的 LLM 调用 **`Agent` 工具**（工具名 `AGENT_TOOL_NAME = 'Agent'`，
旧别名 `'Task'`，见 [constants.ts:1-3](src/tools/AgentTool/constants.ts#L1-L3)）。当模型认为某任务需要
"自主处理复杂多步任务"时，就发出 `Agent({ prompt, description, subagent_type, ... })`。

工具的输入模式（[AgentTool.tsx:82-101](src/tools/AgentTool/AgentTool.tsx#L82-L101)）含：
`description`、`prompt`、`subagent_type`（选择智能体类型）、`model`、`run_in_background`、
以及多智能体相关参数 `name` / `team_name` / `mode`、隔离参数 `isolation` / `cwd`。

`call()` 中的类型选择逻辑（[AgentTool.tsx:322-356](src/tools/AgentTool/AgentTool.tsx#L322-L356)）：

```ts
const effectiveType = subagent_type ?? (isForkSubagentEnabled() ? undefined : GENERAL_PURPOSE_AGENT.agentType)
const isForkPath = effectiveType === undefined
let selectedAgent: AgentDefinition
if (isForkPath) { selectedAgent = FORK_AGENT }        // 走隐式分支
else { /* 按 effectiveType 在 activeAgents 中匹配 */ }
```

据此，Agent 工具有 **5 条触发路径**：

1. **同步子代理** —— 最常规。`subagent_type` 指定类型，`call()` 同步 `await runAgent`，
   返回 `status: 'completed'`；
2. **后台子代理** —— `run_in_background: true`（或定义 `background: true`），
   立即返回 `status: 'async_launched'`，通过 `runAsyncAgentLifecycle` 在后台跑，完成时投递通知
   （[AgentTool.tsx:686-764](src/tools/AgentTool/AgentTool.tsx#L686-L764)）；
3. **隐式 fork 分支** —— fork 实验开启且**省略** `subagent_type`（`isForkPath`），注入 `FORK_AGENT`；
4. **Teammate 生成** —— 传入 `name` + `team_name`，转调 `spawnTeammate`，
   返回 `status: 'teammate_spawned'`（[AgentTool.tsx:284-316](src/tools/AgentTool/AgentTool.tsx#L284-L316)）；
5. **远程隔离** —— `isolation: 'remote'`（ant 专用），转调 `teleportToRemote`，
   返回 `status: 'remote_launched'`（[AgentTool.tsx:435-482](src/tools/AgentTool/AgentTool.tsx#L435-L482)）。

另外，`SendMessage` 续跑已结束的智能体（`resumeAgentBackground`）也是一种"重激活"触发。

**适用任务**：Subagent 适合**一次性、可委派、结果可汇总**的任务——代码探索、独立调研、
并行子任务等。其核心约束是**父智能体需用一条 prompt 完整体述任务**，子代理不自动携带父上下文
（见 §2.8）。

### 2.4 运行机制：不是独立进程，而是嵌套的 query 循环

这是理解 CC 子代理最重要的一点：**子代理不是单独的操作系统进程**，而是在同一进程内、
**嵌套调用与主智能体完全相同的 LLM 循环 `query()`**（[query.ts:219](src/query.ts#L219)）的
另一次等价执行。

核心驱动是 `runAgent`（[runAgent.ts:248-860](src/tools/AgentTool/runAgent.ts#L248-L860)），其关键步骤：

- **模型解析**：`getAgentModel`（[utils/model/agent.ts:37-123](src/utils/model/agent.ts#L37-L123)）
  把 `'inherit'` 解析为运行时主循环的模型（对 Bedrock 保留跨区域推断前缀），
  并尊重 `CLAUDE_CODE_SUBAGENT_MODEL` 环境变量覆盖；`aliasMatchesParentTier()` 防止意外降级。
- **上下文消息**：`contextMessages = forkContextMessages ? filterIncompleteToolCalls(forkContextMessages) : []`，
  再拼接 prompt 消息，`filterIncompleteToolCalls`（[runAgent.ts:866-904](src/tools/AgentTool/runAgent.ts#L866-L904)）
  剥离没有结果的 assistant tool_use 块以防 API 报错。
- **上下文组装**：`getUserContext()` / `getSystemContext()`，`Explore`/`Plan` 支持 `omitClaudeMd`。
- **权限模式**：可从 AgentDefinition 覆盖（除非父为 bypass/acceptEdits），异步智能体设置
  `shouldAvoidPermissionPrompts`，`allowedTools` 作为会话允许规则。
- **系统提示词**：`getAgentSystemPrompt`（[runAgent.ts:906-932](src/tools/AgentTool/runAgent.ts#L906-L932)）。
- **钩子 / skill / MCP**：触发 `SubagentStart` 钩子、注册 frontmatter 钩子（`Stop → SubagentStop`）、
  预载 skills、`initializeAgentMcpServers` 增量初始化 per-agent MCP 并 `uniqBy(name)` 合并工具。
- **智能体上下文**：`createSubagentContext`（[utils/forkedAgent.ts:345-487](src/utils/forkedAgent.ts#L345-L487)）
  克隆文件状态缓存、新 agentId、增量深度的新 queryTracking 链。
- **循环**：[runAgent.ts:748-806](src/tools/AgentTool/runAgent.ts#L748-L806) 中
  `for await (const message of query({ messages, systemPrompt, ..., maxTurns })) { ... }`。

> **隔离的本质差异（同步 vs 异步）**：
> **同步**子代理共享父的 `setAppState` / `setResponseLength` / `abortController`（父取消会传导杀死它）；
> **异步**子代理完全隔离——no-op 的 setter、全新的独立 `AbortController`（父 ESC 不影响它）、
> 独立的 `localDenialTracking`，仅通过 `setAppStateForTasks` 到达根 store，以支持进/后台转换。

### 2.5 工具过滤：filterToolsForAgent / resolveAgentTools

子代理能用到哪些工具，由 [agentToolUtils.ts:70-116](src/tools/AgentTool/agentToolUtils.ts#L70-L116) 的
`filterToolsForAgent` 决定：

```ts
export function filterToolsForAgent({ tools, isBuiltIn, isAsync = false, permissionMode }): Tools {
  return tools.filter(tool => {
    if (tool.name.startsWith('mcp__')) return true                // MCP 恒放行
    if (EXIT_PLAN_MODE && permissionMode === 'plan') return true
    if (ALL_AGENT_DISALLOWED_TOOLS.has(tool.name)) return false   // 递归/规划守卫
    if (!isBuiltIn && CUSTOM_AGENT_DISALLOWED_TOOLS.has(tool.name)) return false
    if (isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(tool.name)) return false
    return true
  })
}
```

- `ALL_AGENT_DISALLOWED_TOOLS`（[constants/tools.ts](src/constants/tools.ts)）剔除
  `TaskOutput / ExitPlanModeV2 / EnterPlanMode / AskUserQuestion / TaskStop / Workflow`——
  **`Workflow` 被禁是递归守卫**（防止子代理再衍生 workflow）；`Agent` 在非 ant 构建中也被禁（嵌套守卫）。
- `ASYNC_AGENT_ALLOWED_TOOLS` 只白名单文件/读/网页/todo/grep/glob/shell/skill 等——**后台异步智能体
  不允许**交互类工具，防止后台进程卡在等用户输入上。
- `resolveAgentTools`（[agentToolUtils.ts:122-225](src/tools/AgentTool/agentToolUtils.ts#L122-L225)）再叠加
  该智能体自己的 `disallowedTools`、通配展开，并把 `Agent(worker, researcher)` 中的类型限制提取为
  `allowedAgentTypes`（[agentToolUtils.ts:191-201](src/tools/AgentTool/agentToolUtils.ts#L191-L201)）。

### 2.6 结果回传：finalizeAgentTool 与 agentId 续跑

子代理跑完后，消息列表被收拢为 **`AgentToolResult`**（[agentToolUtils.ts:276-357](src/tools/AgentTool/agentToolUtils.ts#L276-L357)）：

- 提取最后一个非空 assistant 消息的文本内容；
- 统计 `tool_use` 次数、token 总量、耗时；
- 发出遥测事件并返回 `{ agentId, agentType, content, totalDurationMs, totalTokens, totalToolUseCount, usage }`。

`mapToolResultToToolResultBlockParam`（[AgentTool.tsx:1298-1379](src/tools/AgentTool/AgentTool.tsx#L1298-L1379)）
把它转成父智能体看到的 `tool_result` 块，末尾追加**续跑引导**：

```
agentId: <id> (use SendMessage with to: '<id>' to continue this agent)
<usage>total_tokens: ...  tool_uses: ...  duration_ms: ...</usage>
```

对**一次性内置智能体**（`Explore`/`Plan`，见 `ONE_SHOT_BUILTIN_AGENT_TYPES`，[constants.ts:9-12](src/tools/AgentTool/constants.ts#L9-L12)），
续跑提示与 agentId 被**跳过**以节省 token。`isReadOnly()` 返回 `true`（[AgentTool.tsx:1264-1266](src/tools/AgentTool/AgentTool.tsx#L1264-L1266)）——
父的读安全校验委托给子代理内部的工具级权限检查。`classifyHandoffIfNeeded`
（[agentToolUtils.ts:389-481](src/tools/AgentTool/agentToolUtils.ts#L389-L481)）还会对交接内容做安全审查，
必要时前置 `SECURITY WARNING`。

### 2.7 隔离：worktree 与 cwd

`isolation: 'worktree'`（或 AgentDefinition 的 `isolation`）通过 `createAgentWorktree(slug)`
（[utils/worktree.ts:902-955](src/utils/worktree.ts#L902-L955)）创建临时 git worktree，
slug 形如 `agent-<8hex>`，落地在 `<repoRoot>/.claude/worktrees/<slug>/`，
优先用 `WorktreeCreate` 钩子、回退 `git worktree`。它**不** `process.chdir`，只包裹执行路径。

完成后 `cleanupWorktreeIfNeeded`（[AgentTool.tsx:644-685](src/tools/AgentTool/AgentTool.tsx#L644-L685)）：

- 无改动 → `removeAgentWorktree`（删目录 + 分支）；
- 有改动 → **保留**，把 `worktreePath`/`worktreeBranch` 放进结果返回；
- 钩子型 worktree 恒保留（无法探测 VCS 改动）。

`cwd` override（`runWithCwdOverride` + `wrapWithCwd`）与 worktree 互斥（[AgentTool.tsx:100](src/tools/AgentTool/AgentTool.tsx#L100)）。

### 2.8 跨智能体会话：parent→child 与持久记忆

- **parent→child**：普通/spawn 路径只发**一条** `createUserMessage({content: prompt})`
  （[AgentTool.tsx:538-540](src/tools/AgentTool/AgentTool.tsx#L538-L540)），**零父上下文**——prompt 必须自包含。
- **fork 路径**：`buildForkedMessages`（[forkSubagent.ts:107-169](src/tools/AgentTool/forkSubagent.ts#L107-L169)）
  克隆父**整条最后 assistant 消息**（全部 tool_use/thinking/text 块），构造占位 tool_result，再加 per-child 指令——
  最大化 prompt-cache 复用：`[...history, assistant(all_tool_uses), user(placeholder_results, directive)]`。
- **持久智能体记忆**：`agentMemory` 按 `AgentMemoryScope = 'user' | 'project' | 'local'` 落盘
  （[agentMemory.ts:13](src/tools/AgentTool/agentMemory.ts#L13)）：

  - `user` → `<memoryBase>/agent-memory/<agentType>/`
  - `project` → `<cwd>/.claude/agent-memory/<agentType>/`
  - `local` → `<cwd>/.claude/agent-memory-local/<agentType>/`
    加载时 `loadAgentMemoryPrompt`（[agentMemory.ts:138-177](src/tools/AgentTool/agentMemory.ts#L138-L177)）
    注入指向 `MEMORY.md` 的提示词，智能体用被自动追加的 Write/Edit/Read 维护记忆。
- **记忆快照**：`agentMemorySnapshot`（`<cwd>/.claude/agent-memory-snapshots/<agentType>/`，
  [agentMemorySnapshot.ts:31-33](src/tools/AgentTool/agentMemorySnapshot.ts#L31-L33)）在加载时由
  `checkAgentMemorySnapshot`（[agentMemorySnapshot.ts:98-144](src/tools/AgentTool/agentMemorySnapshot.ts#L98-L144)）
  决定 `initialize` / `prompt-update` / `none`，实现"首跑播种 + 更新提示"。
- **child→parent**：除文本结果外，还通过**转录 sidechain**（`recordSidechainTranscript`，[runAgent.ts:735](src/tools/AgentTool/runAgent.ts#L735)）
  持久化到磁盘（供 resume/SendMessage 重建）；异步完成时由 `enqueueAgentNotification`
  （[agentToolUtils.ts:624-637](src/tools/AgentTool/agentToolUtils.ts#L624-L637)）把结果作为 user 消息
  注入父的后续轮次。

### 2.9 适用场景小结

| 维度     | Subagent                                                               |
| -------- | ---------------------------------------------------------------------- |
| 触发     | 父模型调用`Agent` 工具，`subagent_type` 选型                       |
| 并发     | 可同步（阻塞等待）/ 后台（异步 + 通知）                                |
| 上下文   | prompt 自包含；fork 可克隆父消息；持久记忆按需                         |
| 生命周期 | 随父会话；`SendMessage` 可续跑；`/clear`/压缩后可用 sidechain 恢复 |
| 适用任务 | 一次性委派：探索、调研、并行子任务、独立功能开发                       |

---

## 三、Swarm / Team：团队协同（最高层编排）

如果说 Subagent 是"一主一仆"，Swarm 就是**多智能体真正并行协同**的形态：一个 **team lead** 加多个
**teammate**，各自有持久化身份、文件信箱、可选的独立终端窗格，通过消息彼此协作。

### 3.1 概念与身份模型

- **team**：一个有名字的智能体群，由单一 lead 协调，持久化为 **`TeamFile`** JSON
  （`~/.claude/teams/{team-name}/config.json`），运行时映射到 `AppState.teamContext`。
- **swarm** 是特性名（tmux 会话就叫 `claude-swarm`，平铺视图也称 swarm view）。
- **身份**：lead 的固定名 `TEAM_LEAD_NAME = 'team-lead'`（[utils/swarm/constants.ts:1](src/utils/swarm/constants.ts#L1)），
  其 **agentId 确定性地**是 `team-lead@teamName`；teammate 为 `agentName@teamName`。
  确定性 ID 是**崩溃/断线后重连**的关键前提（见 §3.6）。
- **团队/任务列表协作**：`utils/tasks.ts` 提供基于任务列表的团队任务分配原语——`claimTask`
  （[utils/tasks.ts](src/utils/tasks.ts)）、`unassignTeammateTasks`（[utils/tasks.ts:818](src/utils/tasks.ts#L818)），
  支持 `owner` 归属、`blocked` 依赖、`agent_busy` 忙检查，teammate 退出时自动把未完成任务转回 `pending`
  并通知 lead 重新分配。

### 3.2 触发：TeamCreate 与 SpawnTeammate

**创建团队**由 `TeamCreateTool` 触发（`tools/TeamCreateTool/TeamCreateTool.ts`）：

- 当前会话若已是某团队成员则报错（"leader 一次只能管理一个团队"）；
- `generateUniqueTeamName()`、建 TeamFile（`leadAgentId`、`leadSessionId`、一个 `team-lead` 成员）、
  `writeTeamFileAsync`、注册会话清理、`setLeaderTeamName`。
- 刻意**不**给 lead 设 `CLAUDE_CODE_AGENT_ID`——lead 的 `isTeammate()` 应为 `false`，
  身份就是确定性的 `team-lead@teamName`。

**生成队友**由 `Teammate` 工具与 `AgentTool`（`name`+`team_name`）共用同一模块
`tools/shared/spawnMultiAgent.ts` 的 `spawnTeammate`（[spawnMultiAgent.ts:1088-1093](src/tools/shared/spawnMultiAgent.ts#L1088-L1093)）。
其 `handleSpawn`（[spawnMultiAgent.ts:1044-1077](src/tools/shared/spawnMultiAgent.ts#L1044-L1077)）按环境分派 4 条路径：

```ts
if (isInProcessEnabled()) return handleSpawnInProcess(input, context)   // 同进程
try { await detectAndGetBackend() } catch { /* auto 模式回退 in-process */ }
if (useSplitPane) return handleSpawnSplitPane(input, context)            // 平铺窗格（默认）
return handleSpawnSeparateWindow(input, context)                         // 独立窗口
```

其中 `handleSpawnSplitPane`（leader 在左、teammate 在右）是默认视图。

### 3.3 执行后端：tmux / iTerm2 / in-process

`utils/swarm/backends/` 定义了三种后端（`BackendType = 'tmux' | 'iterm2' | 'in-process'`，
[types.ts:9](src/utils/swarm/backends/types.ts#L9)）：

| 后端                 | OS      | 本质                                                     | 取舍                                                                                                            |
| -------------------- | ------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **tmux**       | 类 Unix | 每个 teammate 一个 tmux pane / 独立`claude-swarm` 会话 | 真实多进程隔离、Swarm 平铺视图；需 tmux、启动重、进程间消息走文件信箱                                           |
| **iTerm2**     | macOS   | iTerm 原生 split pane                                    | 好看的原生分屏；需`it2` Python CLI（`it2Setup.ts` 可自动装）；`supportsHideShow=false`，颜色/标题是 no-op |
| **in-process** | 跨平台  | 同进程，`AsyncLocalStorage` 上下文隔离                 | 最快、无进程开销、共享内存；隔离性弱、无视觉窗格                                                                |

**探测优先级**（`registry.ts detectAndGetBackend`，[registry.ts:136-254](src/utils/swarm/backends/registry.ts#L136-L254)）：

1. 在 tmux 内 → 恒用 tmux（native，最省最稳）；
2. 在 iTerm2（且有 `it2`）→ 用 iTerm2（用户偏好 tmux 则用 tmux）；
3. 有 tmux → 外部 `claude-swarm` 会话；
4. 都没有 → 抛装 tmux 的指引。

探测谓词在 `detection.ts`（`isInsideTmuxSync` 读捕获的 `ORIGINAL_USER_TMUX` 环境变量而非跑命令；
`isIt2CliAvailable` 跑 `it2 session list` 而非 `--version`，因为后者在 Python API 禁用时也成功）。

`TeammateExecutor`（[types.ts:279-300](src/utils/swarm/backends/types.ts#L279-L300)）是统一生命周期抽象：
`spawn / sendMessage / terminate / kill / isActive`；`PaneBackendExecutor` 把 `PaneBackend` 适配成它。

### 3.4 通信机制：文件信箱 + SendMessage

teammate 之间**不直接**传内存对象（in-process 除外），而是通过**文件信箱**：

- 每个 teammate 有文件收件箱 `~/.claude/teams/{team}/inboxes/{agent_name}.json`
  （`utils/teammateMailbox.ts` 的 `getInboxPath`，[teammateMailbox.ts:56-66](src/utils/teammateMailbox.ts#L56-L66)），
  含文件锁、读/写/标读等操作、结构化协议消息的创建/校验。
- 消息形状 `TeammateMessage = { text, from, color?, timestamp?, summary? }`（[backends/types.ts:259-270](src/utils/swarm/backends/types.ts#L259-L270)）。
- **`SendMessageTool`**（`tools/SendMessageTool/SendMessageTool.ts`）把消息写入目标信箱：`to` 可以是
  teammate 名、`"*"`（广播，遍历 `teamFile.members` 并跳过发送者）或 `uds:`/`bridge:` 地址。
  还有关停请求/批准/拒绝、计划批准/拒绝等协议处理器。
- **模型侧引导**：`TEAMMATE_SYSTEM_PROMPT_ADDENDUM`（[teammatePromptAddendum.ts:8-18](src/utils/swarm/teammatePromptAddendum.ts#L8-L18)）明确告知：
  "写文本对其他队友不可见，必须用 SendMessage；主要通过 lead 与用户交互"。
- **收信侧**：in-process 运行时的 `waitForNextPromptOrShutdown`（[inProcessRunner.ts:689-868](src/utils/swarm/inProcessRunner.ts#L689-L868)）
  每 **500ms** 轮询信箱，优先级：关停请求 > lead 消息 > FIFO；并用 `formatAsTeammateMessage`
  （[inProcessRunner.ts:457-466](src/utils/swarm/inProcessRunner.ts#L457-L466)）把入站消息包成
  `<teammate-message>` XML 给模型。
- **@mention / DM 摘要**：`getLastPeerDmSummary`（[teammateMailbox.ts:1149](src/utils/teammateMailbox.ts#L1149)）
  从 `"[to {name}] {summary}"` 提取，给模型紧凑的近期 DM 上下文。
- **订阅字段**：`members[].subscriptions` 虽在 schema 中存在（初始 `[]`），实际投递是发送时解析
  `to` 目标 inbox、广播 `*` 遍历所有成员，并不按订阅扇出。

### 3.5 权限委派：leaderPermissionBridge + permissionSync

teammate 的权限请求如何让用户/leader 批准？两套配合：

1. **leader 权限桥**（`utils/swarm/leaderPermissionBridge.ts`）：把 REPL 的 `ToolUseConfirm` 对话框机制
   暴露给非 React 代码，**in-process teammate 的权限请求借 leader 的确认对话框**弹出（带 worker 徽章）。
2. **权限同步**（`utils/swarm/permissionSync.ts`）：文件式 `~/.claude/teams/{team}/permissions/{pending,resolved}/`
   或较新的 **mailbox 路由**（`sendPermissionRequestViaMailbox` / `sendPermissionResponseViaMailbox` /
   `sendSandboxPermissionRequestViaMailbox`，[permissionSync.ts:676-882](src/utils/swarm/permissionSync.ts#L676-L882)），
   用结构化协议消息（permission_request/response、sandbox_permission_request/response）走信箱。
   `isTeamLeader()` / `isSwarmWorker()`（[permissionSync.ts:581-596](src/utils/swarm/permissionSync.ts#L581-L596)）区分角色。
   此外 `BASH_CLASSIFIER` 可对 bash 自动放行（[inProcessRunner.ts:159-176](src/utils/swarm/inProcessRunner.ts#L159-L176)）。

`teammateInit.ts` 会在 teammate 启动时用 `addRules` 施加 `teamAllowedPaths`（`//path/**` 或 `path/**` 通配）。

### 3.6 连接与重连

`utils/swarm/reconnection.ts`：

- `computeInitialTeamContext`（[reconnection.ts:23-66](src/utils/swarm/reconnection.ts#L23-L66)）：`isLeader = !agentId`；
  读 `getDynamicTeamContext()`。
- `initializeTeammateContextFromSession`（[reconnection.ts:75-119](src/utils/swarm/reconnection.ts#L75-L119)）：
  恢复会话时读 TeamFile、按 name 找成员确定 agentId、设入 AppState.teamContext。

身份优先级链（`utils/teammate.ts:1-14`）：**AsyncLocalStorage（in-process）> dynamicTeamContext（CLI 参数）> 环境变量**。
tmux teammate 的身份经 CLI 参数（`--agent-id` / `--agent-name` / `--team-name` / `--agent-color` / `--parent-session-id` 等）注入；
in-process 则放 AsyncLocalStorage。**它们都能精确重连**，正因 `agentId = agentName@teamName` + TeamFile 在磁盘持久化。

`initializeTeammateHooks`（[teammateInit.ts:28-129](src/utils/swarm/teammateInit.ts#L28-L129)）给非 lead 注册 `Stop` 钩子：
标记成员不活跃 + 发 idle 通知给 lead。

---

## 四、Coordinator 模式：协调器 + worker

Coordinator 是**单一协调器**驱动**多个异步 worker 子代理**的组合模式，与 swarm 的"对等团队"有本质区别。

### 4.1 触发与门控

`isCoordinatorMode()`（[coordinatorMode.ts:36-41](src/coordinator/coordinatorMode.ts#L36-L41)）：
`feature('COORDINATOR_MODE') && CLAUDE_CODE_COORDINATOR_MODE`。`matchSessionMode`（[coordinatorMode.ts:49-78](src/coordinator/coordinatorMode.ts#L49-L78)）
按会话模式判断适用性。

### 4.2 worker 智能体类型

`coordinator/workerAgent.ts:1` 定义 `export const WORKER_AGENT = 'worker'`——这是 coordinator 模式下
`Agent` 工具使用的 `subagent_type`（`'worker'`）。核心可注入工具 `INTERNAL_WORKER_TOOLS = [TeamCreate, TeamDelete, SendMessage, SyntheticOutput]`（[coordinatorMode.ts:29-34](src/coordinator/coordinatorMode.ts#L29-L34)）。

### 4.3 运行与控制流

`getCoordinatorSystemPrompt`（[coordinatorMode.ts:111-369](src/coordinator/coordinatorMode.ts#L111-L369)）描述协调器角色：

- 用 `Agent` 工具以 `subagent_type 'worker'` 派发**异步 worker**；
- 用 `SendMessage` **续跑** worker；
- 用 `TaskStopTool` **停止** worker；
- worker 结果以 `<task-notification>` XML 在 user 消息中返回。

`getCoordinatorUserContext`（[coordinatorMode.ts:80-109](src/coordinator/coordinatorMode.ts#L80-L109)）暴露 worker 工具清单与
草稿本（scratchpad）账户。

### 4.4 与 Swarm / Team 的本质差异

| 维度 | Swarm / Team                                 | Coordinator 模式                                          |
| ---- | -------------------------------------------- | --------------------------------------------------------- |
| 结构 | 1 lead + 多个对等 teammate，持久化身份       | 1 协调器 + 多个**异步 worker 子代理**               |
| 身份 | `agentName@teamName`，有 TeamFile 成员条目 | 短命的 worker，无团队文件条目                             |
| 运行 | 常驻并发（客户端进程间或同进程）             | 短生命周期 Subagent 派发                                  |
| 通信 | 文件信箱 + SendMessage                       | SendMessage 续跑 + TaskStop 停止 +`<task-notification>` |
| 视觉 | tmux/iTerm2 Swarm 窗格                       | CoordinatorTaskPanel（后台任务面板）                      |
| 数据 | 无                                           | 有"草稿本"（scratchpad）账户供 worker 共享中间结果        |

两者是"**对等协作** vs **主从派发**"两种不同的编排哲学。

### 4.5 Subagent 与 Coordinator worker 的差异

一个常见误区是把"Subagent 由主智能体派发"与"Coordinator 派发 worker"视为两套并列机制。实际上它们**共享底层**：
Coordinator 的 worker 本质上就是一种**被编排的后台 subagent**——都通过同一 `Agent` 工具、都走嵌套 `query()`。
差异在**编排哲学**与**角色定义**，而非机制本身：

| 维度 | **Subagent（§二）** | **Coordinator worker（§四）** |
| ---- | ------------------- | ----------------------------- |
| 派发者 | 常规交互会话的主智能体 | 专门的协调器智能体（`getCoordinatorSystemPrompt`，[coordinatorMode.ts:111](src/coordinator/coordinatorMode.ts#L111)） |
| 角色名 | `general-purpose` / `Explore` / `Plan` / 自定义 | 固定 `WORKER_AGENT = 'worker'`（[workerAgent.ts:1](src/coordinator/workerAgent.ts#L1)） |
| 触发形态 | 主模型调 `Agent({ subagent_type })`，同步/后台皆可 | 协调器调 `Agent({ subagent_type: 'worker', run_in_background })`，几乎总是异步 |
| 生命周期 | 主循环处理中的**一步**（等待结果拼回上下文） | **并发、可续跑、可停止**的一组工人，协调器不阻塞等待 |
| 通信 | 一次性结果回传（`tool_result`） | 双向编排：派发 → `SendMessage` 续跑 → `TaskStopTool` 停止 → `<task-notification>` 回报 |
| 管理手段 | 主智能体没有专属编排工具 | `INTERNAL_WORKER_TOOLS = { TeamCreate, TeamDelete, SendMessage, SyntheticOutput }`（[coordinatorMode.ts:29-34](src/coordinator/coordinatorMode.ts#L29-L34)） |
| 共享数据 | 无 | 草稿本（scratchpad）账户经依赖注入（[QueryEngine.ts:112](src/QueryEngine.ts#L112)）供 worker 共享中间结果 |
| 适用 | 一次性、聚焦、结果可汇聚 | 需要**并行 + 迭代 + 编排多个子任务**的复杂工作流 |

三者的区分（易混淆点）：**Subagent = 无身份的临时执行单元**；**Coordinator worker = 被编排的"后台 subagent"**（比 subagent 多编排能力，但同样短命、无团队身份、无持久通信）；**Swarm teammate = 有身份、可持久通信、可重连的对等体**（见 §4.6、§3）。

### 4.6 Coordinator 协调者与 Swarm Leader 的差异

两者都是多智能体的"指挥者"，共享底层（都依赖 SendMessage / TeamCreate / `Agent` 工具），但**角色定位完全不同**：

| 维度 | **Coordinator 协调者** | **Swarm Leader** |
| ---- | ---------------------- | ---------------- |
| 归属 | 独立会话，**无团队身份** | **团队一员**，确定性身份 `team-lead@teamName`，写入 `TeamFile` 成员列表，可被 teammate 用 SendMessage 找到 |
| 身份判定 | 仅靠 `CLAUDE_CODE_COORDINATOR_MODE` 激活 | `isTeamLeader()`：`getAgentId()` 为空**或**为 `'team-lead'`（[permissionSync.ts:581-591](src/utils/swarm/permissionSync.ts#L581-L591)）；`isSwarmWorker()` = `teamName && agentId && !isTeamLeader()`（[permissionSync.ts:596-601](src/utils/swarm/permissionSync.ts#L596-L601)） |
| 下层身份 | 一次性 worker（无身份、不在任何团队登记） | 持久 teammate（`name@teamName`，可重连） |
| 派发工具 | `Agent({ subagent_type: 'worker' })` | `Teammate` / `Agent({ name, team_name })` |
| 权限方式 | worker 是**子代理**，权限可被父（协调者）覆盖 | teammate 是**对等会话**，权限请求经 mailbox 发回 leader，由 `leaderPermissionBridge`（借 leader 的确认对话框）批准 |
| 通信方向 | **单向管理**（派发 / 续跑 / 停止） | **双向对等协作**（teammate 可主动发消息、发权限请求、`*` 广播、`@mention`） |
| 共享数据 | 草稿本 scratchpad（[QueryEngine.ts:112](src/QueryEngine.ts#L112)） | mailbox 消息 + 团队任务列表（`claimTask` / `unassignTeammateTasks`，[utils/tasks.ts](src/utils/tasks.ts)） |
| 关系哲学 | **主从派发、集中编排**（单人指挥中心） | **对等团队、领导协调**（团队协作网络） |

**一句话概括**：Coordinator 是"行政主管"，临时雇一批无身份的合同工（worker）并行干活，用草稿本分派资料；
Swarm leader 是"团队的项目经理"，带一群有档案的正式员工（teammate），靠消息与任务列表管理，权限还要跟每个成员来回确认。
前者是集中编排，后者是对等团队协作。

### 4.7 三种模式是否有明确界限？是"配置门控"而非"LLM 判断"

**核心结论：subagent / coordinator / swarm 之间没有"由大模型依据任务自动挑选"的模糊边界。**
它们是三个**相互独立、各自被不同开关门控**的特性；代码里不存在"该用哪种模式"的判定逻辑，
只有"这个模式是否已启用"的布尔判断。大模型的自由度只体现在**启用之后**的工具选择层，
而"模式能不能用"完全由配置/构建决定。

| 模式 | 启用开关（源码） | 判定点 |
| ---- | ---------------- | ------ |
| **Subagent（Agent 工具）** | 无运行时装；内置 agents 无条件注册，非 ant 构建移除该工具 | [constants/tools.ts:41](src/constants/tools.ts#L41)、[builtInAgents.ts:45-48](src/tools/AgentTool/builtInAgents.ts#L45-L48) |
| **Coordinator** | `feature('COORDINATOR_MODE') && CLAUDE_CODE_COORDINATOR_MODE` | [coordinatorMode.ts:36-41](src/coordinator/coordinatorMode.ts#L36-L41) |
| **Swarm / Team** | ant 恒开；外部需 `--agent-teams`/`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` + GrowthBook `tengu_amber_flint` | [agentSwarmsEnabled.ts:24-44](src/utils/agentSwarmsEnabled.ts#L24-L44) |

**"模式开关"与"工具选择"是两个分离的关注点**：

- **模式开不开**＝配置/环境门控，与 LLM 无关；
- **用哪个工具**＝LLM 自主调用 `Agent`(`subagent_type`)、`Teammate`、workflow 的选择行为。

Coordinator 一旦开启，会通过 `COORDINATOR_MODE_ALLOWED_TOOLS` 把协调者的工具**裁剪**为
只剩 `Agent + TaskStop + SendMessage + SyntheticOutput`（[constants/tools.ts:107-112](src/constants/tools.ts#L107-L112)），
并在简单模式下把 Agent/TaskStop/SendMessage 追加进协调者工具集（[tools.ts:280-296](src/tools.ts#L280-L296)）。
也就是说，开启 coordinator 后，LLM"能选"的范围被代码强制收窄到只剩派发/管理工具——
它不是"自己判断要不要当协调者"，而是被配置锁死在这个角色里。

**那"模式是如何流传到下个会话的"？靠会话状态 + 环境变量回写，而非大模型的输出**：
会话模式被存为 `'coordinator' | 'normal'`，通过 `saveMode()` 写入
（[conversation.ts:230-237](src/commands/clear/conversation.ts#L230-L237)、[main.tsx:3776-3777](src/main.tsx#L3776-L3777)）；
恢复会话时 `matchSessionMode()` 会**改写环境变量** `CLAUDE_CODE_COORDINATOR_MODE` 去匹配保存的模式
（[coordinatorMode.ts:49-78](src/coordinator/coordinatorMode.ts#L49-L78)），使 `isCoordinatorMode()` 在下一生命周期仍为真。
这个框架依赖的是会话状态 + env 回写，与 LLM 的任何推理输出无关。

**Coordinator 默认开启吗？——不。它是"双重门控"，且默认关闭**：

1. **编译期**：`feature('COORDINATOR_MODE')`（来自 `bun:bundle`）在**外部分发版为 `false`**，
   `feature('COORDINATOR_MODE') ? require('...') : null` 的 DCE 条件导入（[main.tsx:76](src/main.tsx#L76)）
   会把整个 coordinator 模块在打包阶段删除，外部产物中**根本不存在**该代码；
2. **运行期**：即便某构建（ant）启用该 feature，`isCoordinatorMode()` 仍需
   `isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)` 为真（[coordinatorMode.ts:36-41](src/coordinator/coordinatorMode.ts#L36-L41)），
   而该环境变量默认不设置。

**对外默认版是否"只有 subagent 一种多智能体机制"？——严格上是的（开箱即用层面），但三种状态不同**：

| 机制 | 对外默认版状态 | 能否开启 |
| ---- | -------------- | -------- |
| **Subagent** | ✅ 默认可用（无需配置） | 无条件存在 |
| **Swarm / Team** | ⛔ 默认关 | 可：`--agent-teams` / `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` + `tengu_amber_flint` |
| **Coordinator** | ❌ 产物中不存在（编译期 DCE） | 外部版不可用 |
| **Remote / CCR** | ⛔ 默认关 | 可：登录 claude.ai + 配置云端环境 + 安装 GitHub app（[RemoteAgentTask.tsx:148-160](src/tasks/RemoteAgentTask/RemoteAgentTask.tsx#L148-L160)） |

**关键区分：两种"关"的本质不同**——

- **Coordinator 是唯一被编译期"杀死"的特性**，对外版从二进制层面不存在，无法开启；
- **Swarm 与 Remote 是"代码还在、默认不激活"**：Swarm 靠运行时 env/flag + GrowthBook，
  Remote 靠登录/云端环境/GitHub app 的**资格检查**（`not_logged_in`/`no_remote_environment`/
  `not_in_git_repo`/`no_git_remote`/`github_app_not_installed`/`policy_blocked`，[RemoteAgentTask.tsx:148-160](src/tasks/RemoteAgentTask/RemoteAgentTask.tsx#L148-L160)），
  均无 `USER_TYPE==='ant'` 硬门槛，因此是对**外部开放**的公开能力，只是默认不触发。

**一句话总结**：对外默认版唯一"开箱即用"的多智能体机制确实只有 **Subagent**；
Swarm 与 Remote 是"代码存在、默认关、可配置开启"的公开能力，只有 Coordinator 是被编译期彻底移除、
外部版完全不可用的那一个。三种模式的"边界"本质是**配置门控**，而非 LLM 的任务判断。

#### 4.7.1 澄清：Coordinator 与 Subagent 不是"两种机制"，而是"身份模式 ↔ 底层机制"

常有人问："coordinator 和 subagent 不都是一个 agent 调另一个 agent 吗，有什么区别？"
这个疑问源于**把两个不同层级的抽象摆在了同一台面上**。二者的差别不在"怎么调用"，
而在**主 agent 被配置成了什么身份、手里剩下哪些工具**：

| 概念 | 层级 | 是什么 |
| ---- | ---- | ------ |
| **Subagent** | **机制层** | `Agent` 工具 + `subagent_type`，任何主 agent 都能调用，是最基础的"一个 agent 调用另一个 agent" |
| **Coordinator 模式** | **身份/运行模式层** | 主 agent 换上专门的协调者 system prompt + 被裁剪的工具集，**被刻意限定成"专职派发 subagent（worker）"的角色** |

**Coordinator 的 worker 本身就是 subagent**。证据链：

- 协调者 system prompt 明确指示：用 `Agent` 工具时传 `subagent_type: 'worker'`，并示范并行 fan-out
  （[coordinatorMode.ts:194](src/coordinator/coordinatorMode.ts#L194)）；
- `WORKER_AGENT = 'worker'`（[workerAgent.ts:1](src/coordinator/workerAgent.ts#L1)），
  且 coordinator 开启时 `getBuiltInAgents()` 返回 coordinator 专属的 agents 组
  （[builtInAgents.ts:35-41](src/tools/AgentTool/builtInAgents.ts#L35-L41)）。

所以"coordinator 调 worker"在机制上**就是主 agent 通过 `Agent` 工具调 subagent**——同一套执行系统、
同一个 query 循环。二者共享底层机制，区别全在于**包裹它的角色/权限/工具环境**。

**真正的差异在"主 agent 自己"身上**：

| | 普通 subagent 场景 | Coordinator 模式 |
| -- | ----------------- | ---------------- |
| 主 agent 工具集 | 完整（Bash/Read/Edit/Agent/MCP…） | 被裁剪成 `Agent + TaskStop + SendMessage + SyntheticOutput`（[constants/tools.ts:107-112](src/constants/tools.ts#L107-L112)） |
| 主 agent 能否直接干活 | 能，工具齐全 | **不能直接改文件**——没有 Bash/Read/Edit，只能派发 worker |
| 系统提示词 | 通用助手提示词 | `getCoordinatorSystemPrompt()`，教它拆任务/并行派发/综合结果（[coordinatorMode.ts:111-369](src/coordinator/coordinatorMode.ts#L111-L369)） |
| 定位 | 按需调用 subagent 的助手 | **被强制限定成编排中心/调度员** |

一句话分清：**subagent 是"机制"（Agent 工具），coordinator 是"主 agent 的一种身份模式"**
——它本身不创造新机制，而是通过**裁剪工具 + 更换编排提示词**，把自己特化成"只靠 subagent 机制干活"的调度者。
拿复印机打比方：subagent 是"你会用复印机（Agent 工具）"，coordinator 是"把你关进只有一台复印机的房间、
再给你一本《复印机调度员手册》"——复印的机制没变，变的是你的身份被限定成了复印机调度员。

---

这是范围最新、最"不同"的一层：**把智能体执行迁移到 Claude.ai 云端会话**，本地 CLI 不再跑 LLM 循环，
只负责创建/恢复云端会话并轮询结果。

### 5.1 远程任务子类型

`tasks/RemoteAgentTask/RemoteAgentTask.tsx` 定义 5 种远程子类型（[RemoteAgentTask.tsx:60](src/tasks/RemoteAgentTask/RemoteAgentTask.tsx#L60)）：

```ts
const REMOTE_TASK_TYPES = ['remote-agent', 'ultraplan', 'ultrareview', 'autofix-pr', 'background-pr'] as const
```

`RemoteAgentTaskState`（[RemoteAgentTask.tsx:22-59](src/tasks/RemoteAgentTask/RemoteAgentTask.tsx#L22-L59)）携带
`remoteTaskType / sessionId / command / title / todoList / log / isLongRunning / pollStartedAt / isRemoteReview / reviewProgress / isUltraplan / ultraplanPhase`。每种子类型可注册**完成判定器**（completion checker），
用于判定"何时算完成"（返回非 null 字符串即完成）。

### 5.2 触发与前置校验

触发来源三处（grep 确认）：

- `Agent` 工具 `isolation: 'remote'`（ant 专用）→ `remoteTaskType: 'remote-agent'`（[AgentTool.tsx:456](src/tools/AgentTool/AgentTool.tsx#L456)）；
- `/ultraplan` 命令 → `'ultraplan'`（[ultraplan.tsx:368](src/commands/ultraplan.tsx#L368)）；
- `/ultrareview` 命令 → `'ultrareview'`（[reviewRemote.ts:298](src/commands/review/reviewRemote.ts#L298)）。

发起前 `checkRemoteAgentEligibility()` 校验前置条件（[RemoteAgentTask.tsx:124-146](src/tasks/RemoteAgentTask/RemoteAgentTask.tsx#L124-L146)），
前置类型含：`not_logged_in / no_remote_environment / not_in_git_repo / no_git_remote / github_app_not_installed / policy_blocked`。

### 5.3 通信与运行机制：teleport + 事件轮询

**teleport**（[utils/teleport.tsx](src/utils/teleport.tsx)）：

- `teleportToRemote`（[teleport.tsx:730](src/utils/teleport.tsx#L730)）创建 Claude.ai 会话，两种模式：
  - **GitHub 模式**：后端从 origin 克隆（需 GitHub remote + CCR GitHub 连接）；
  - **Bundle 模式**（`CCR_FORCE_BUNDLE=1`）：CLI 本地 `git bundle --all`、经 Files API 上传、
    传 `seed_bundle_file_id`——无需 GitHub，本地仓库也能上云。
    标题/分支名生成委托给一次 Haiku 调用（`generateTitleAndBranch`）。

**关键点**：CLI **不**在本地跑该智能体的 LLM 循环。`registerRemoteAgentTask`
（[RemoteAgentTask.tsx:386](src/tasks/RemoteAgentTask/RemoteAgentTask.tsx#L386)）建 task 后，
`startRemoteSessionPolling` 用 1 秒轮询 `pollRemoteSessionEvents`（[teleport.tsx:633](src/utils/teleport.tsx#L633)）：

```ts
const eventsUrl = `${getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}/events`
// ?after_id=cursor 分页，MAX_EVENT_PAGES=50 防卡死；过滤 env_manager_log / control_response
// 收集带 session_id 的事件成为 SDKMessage[]，返回 { newEvents, lastEventId, branch, sessionStatus }
```

即：**远端会话执行 → 本地轮询 CCR `/v1/sessions/{id}/events` → 把 SDKMessage 喂给
RemoteAgentTaskState.log/Pill UI**。完成判定：普通远程任务按结果驱动；`ultraplan`/`isLongRunning`
跳过结果驱动，改用自己的 completion checker 或 `STABLE_IDLE_POLLS=5` 空闲启发式。
`REMOTE_REVIEW_TIMEOUT_MS`（30 分钟）审查超时从 `pollStartedAt` 起算——到期仍不完成即判失败。

### 5.4 生命周期与前/后台

- **persist**：`persistRemoteAgentMetadata` 写 sidecar，`--resume` 时 `restoreRemoteAgentTasks`
  （[RemoteAgentTask.tsx:477](src/tasks/RemoteAgentTask/RemoteAgentTask.tsx#L477)）扫描 sidecar、`fetchSession`，
  对 404/已归档的丢弃。**远程任务跨进程重启存活**。
- **kill**：置 `killed` + `archiveRemoteSession()`（[teleport.tsx:1200](src/utils/teleport.tsx#L1200)）归档云端会话。

### 5.5 与本地多智能体对比

| 维度     | 本地 Subagent / Swarm            | Remote / CCR                                                |
| -------- | -------------------------------- | ----------------------------------------------------------- |
| 执行位置 | 本机进程                         | Claude.ai 云端（CCR）                                       |
| LLM 循环 | 本地`query()`                  | 云端跑，本地只轮询 events                                   |
| 触发     | `Agent` 工具 `subagent_type` | `isolation:'remote'`、`/ultraplan`、`/ultrareview` 等 |
| 传输     | 内存 / 文件 / mailbox            | HTTPS 轮询`/v1/sessions/{id}/events`                      |
| 前置     | 无                               | 需登录、远程环境、git remote / bundle                       |
| 持久     | 会话内                           | sidecar + 云端会话，可跨重启恢复                            |

---

## 六、任务生命周期与 UI 渲染

### 6.1 local_agent 生命周期（AgentTool.tsx / LocalAgentTask.tsx）

两种 spawn 路径：

- **异步/后台**（[AgentTool.tsx:688](src/tools/AgentTool/AgentTool.tsx#L688)）：`registerAsyncAgent` +
  `runAsyncAgentLifecycle`，**立即** `isBackgrounded: true`，后台跑、完成时通知；
- **同步/前台**（[AgentTool.tsx:819](src/tools/AgentTool/AgentTool.tsx#L819)）：`registerAgentForeground`，
  带 `autoBackgroundMs` 超时 + `backgroundSignal` promise，超时后 UI 提供 `ctrl+b` 转后台。

关键状态字段（`LocalAgentTaskState`，[LocalAgentTask.tsx:116-148](src/tasks/LocalAgentTask/LocalAgentTask.tsx#L116-L148)）：
`agentId / agentType / abortController / progress / result / messages / isBackgrounded / pendingMessages / retain / diskLoaded / evictAfter`。

**完成/失败/杀除**：`completeAgentTask` / `failAgentTask` 设 `evictAfter`（尊重 `retain`）；
`killAsyncAgent`（[LocalAgentTask.tsx:281](src/tasks/LocalAgentTask/LocalAgentTask.tsx#L281)）置 `killed` +
`abortController.abort()` + 设 `PANEL_GRACE_MS = 30_000` 宽限驱逐。

**驱逐机制**（`utils/task/framework.ts`）：`evictTerminalTask`（framework.ts:125）只在任务**终止 + 已通知 +
过 evictAfter** 时才从 AppState.tasks 移走；`pollTasks`（framework.ts:255）是 1s 循环驱动附件生成与驱逐。

注册时 `registerTask`（framework.ts:77）对 resume 场景合并已有 `retain/messages/diskLoaded/pendingMessages`，
避免 `task_started` 重复发出。

### 6.2 UI 渲染

- **工具转录**：`tools/AgentTool/UI.tsx` 的 `AgentPromptDisplay` / `AgentResponseDisplay` /
  `renderToolUseProgressMessage`，用 `SubAgentProvider`（[CtrlOToExpand.tsx](src/components/CtrlOToExpand.tsx)）封装
  子代理的"展开/收拢"交互。
- **后台任务 pill**：`components/tasks/BackgroundTask.tsx` 按 `task.type` 分派：`local_bash`→ShellProgress、
  `remote_agent`→RemoteSessionProgress（菱形图标，表示云会话）、`local_agent`→智能体专用 pill。
- **协调器面板**：`components/CoordinatorAgentStatus.tsx` 提供 `CoordinatorTaskPanel` / `AgentLine` / `MainLine`，
  1s 间隔 tick 驱逐已到期任务，支持 `enterTeammateView` / `exitTeammateView`。

### 6.3 并发归属：AsyncLocalStorage

为什么需要 `utils/agentContext.ts`？当多个后台智能体**共享一个进程**（ctrl+b 后台化）时，全局 `AppState`
会被相互覆盖。因此用 **AsyncLocalStorage**（`runWithAgentContext` / `getAgentContext`）隔离每个智能体的
异步链，用于**遥测归属**。`AgentContext = SubagentContext | TeammateAgentContext`，按
`agentType: 'subagent' | 'teammate'` 判别。

与此相关的一些支撑：

- **agentId**（`utils/agentId.ts`）：agent ID `agentName@teamName`；request ID
  `{requestType}-{timestamp}@{agentId}`，确定性 ID 支撑崩溃重连。
- **模型解析**（`utils/model/agent.ts`）：`getDefaultSubagentModel() → 'inherit'`；
  `getAgentModel` 解析顺序 `CLAUDE_CODE_SUBAGENT_MODEL env > 工具指定 model > 配置/'inherit'`。

---

## 七、代码位置速查表

| 主题                   | 关键文件                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 任务类型/ID/注册表     | [Task.ts](src/Task.ts)、[tasks.ts](src/tasks.ts)                                                                                                                                                                                                                                                                                         |
| Agent 工具（入口）     | [AgentTool.tsx](src/tools/AgentTool/AgentTool.tsx)、[runAgent.ts](src/tools/AgentTool/runAgent.ts)                                                                                                                                                                                                                                       |
| Agent 定义/加载        | [loadAgentsDir.ts](src/tools/AgentTool/loadAgentsDir.ts)、[builtInAgents.ts](src/tools/AgentTool/builtInAgents.ts)                                                                                                                                                                                                                       |
| 工具过滤/结果          | [agentToolUtils.ts](src/tools/AgentTool/agentToolUtils.ts)                                                                                                                                                                                                                                                                              |
| Fork/续跑/记忆/UI      | [forkSubagent.ts](src/tools/AgentTool/forkSubagent.ts)、[resumeAgent.ts](src/tools/AgentTool/resumeAgent.ts)、[agentMemory.ts](src/tools/AgentTool/agentMemory.ts)、[agentMemorySnapshot.ts](src/tools/AgentTool/agentMemorySnapshot.ts)、[UI.tsx](src/tools/AgentTool/UI.tsx)                                                              |
| 上下文隔离/模型/工作树 | [forkedAgent.ts](src/utils/forkedAgent.ts)、[model/agent.ts](src/utils/model/agent.ts)、[worktree.ts](src/utils/worktree.ts)                                                                                                                                                                                                              |
| Swarm 门控             | [agentSwarmsEnabled.ts](src/utils/agentSwarmsEnabled.ts)                                                                                                                                                                                                                                                                                |
| Swarm 后端             | [backends/](src/utils/swarm/backends/)（types/registry/detection/InProcessBackend/TmuxBackend/ITermBackend/PaneBackendExecutor）                                                                                                                                                                                                        |
| 团队/信箱/权限/重连    | [teamHelpers.ts](src/utils/swarm/teamHelpers.ts)、[teammateMailbox.ts](src/utils/teammateMailbox.ts)、[permissionSync.ts](src/utils/swarm/permissionSync.ts)、[leaderPermissionBridge.ts](src/utils/swarm/leaderPermissionBridge.ts)、[reconnection.ts](src/utils/swarm/reconnection.ts)、[teammateInit.ts](src/utils/swarm/teammateInit.ts) |
| Spawn/运行时           | [spawnMultiAgent.ts](src/tools/shared/spawnMultiAgent.ts)、[spawnInProcess.ts](src/utils/swarm/spawnInProcess.ts)、[inProcessRunner.ts](src/utils/swarm/inProcessRunner.ts)                                                                                                                                                               |
| 团队工具               | TeamCreateTool、SendMessageTool、[promptAddendum.ts](src/utils/swarm/teammatePromptAddendum.ts)                                                                                                                                                                                                                                         |
| 团队任务分配           | [utils/tasks.ts](src/utils/tasks.ts)（claimTask/unassignTeammateTasks）                                                                                                                                                                                                                                                                 |
| Coordinator            | [coordinatorMode.ts](src/coordinator/coordinatorMode.ts)、[workerAgent.ts](src/coordinator/workerAgent.ts)                                                                                                                                                                                                                               |
| 远程/CCR               | [RemoteAgentTask.tsx](src/tasks/RemoteAgentTask/RemoteAgentTask.tsx)、[teleport.tsx](src/utils/teleport.tsx)、[ultraplan.tsx](src/commands/ultraplan.tsx)、[reviewRemote.ts](src/commands/review/reviewRemote.ts)                                                                                                                          |
| local_agent 任务/UI    | [LocalAgentTask.tsx](src/tasks/LocalAgentTask/LocalAgentTask.tsx)、[BackgroundTask.tsx](src/components/tasks/BackgroundTask.tsx)、[CoordinatorAgentStatus.tsx](src/components/CoordinatorAgentStatus.tsx)                                                                                                                                 |
| 并发归属               | [agentContext.ts](src/utils/agentContext.ts)、[agentId.ts](src/utils/agentId.ts)                                                                                                                                                                                                                                                         |

---

## 结语：四层多智能体的心智模型

Claude Code 的多智能体是一个**按"持久性 × 并行度"分层**的系统：

- **Subagent（Agent 工具）**——最轻、最常用。同一进程内嵌套调用 `query()`，prompt 自包含，
  一次性委派；fork 可最大化缓存复用；worktree/cwd 做隔离。
- **Swarm / Team**——最高层编排。lead + teammates 持久化团队，文件信箱通信，三类执行后端
  （tmux/iTerm2/in-process），权限经 leader 桥或 mailbox 协议委派，靠确定性身份 + 磁盘 TeamFile 重连。
- **Coordinator**——主从派发哲学。单协调器派发异步 worker 子代理，SendMessage 续跑、TaskStop 停止。
- **Remote / CCR**——云端执行。teleport 到 Claude.ai 会话，本地只轮询 events，跨重启存活。

四层**共享**同一套底层设施：统一的 `Task` 注册表与状态机、`AsyncLocalStorage` 并发归属、
`SendMessage` 跨智能体通信、`agentId = agentName@teamName` 确定性身份。
这解释了为什么这些看似独立的特性能无缝互操作——它们本就是同一架构的不同层次。
