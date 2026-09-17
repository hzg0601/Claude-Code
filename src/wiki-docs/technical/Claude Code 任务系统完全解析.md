# Claude Code 任务系统完全解析（全景分析）

> 本文完全基于源码分析，不参考任何 doc 文档。目标是给出 Claude Code（下称 CC）任务系统的全景全貌，并按主题逐一深入剖析。
>
> 分析基准：`src/` 目录源码（TypeScript / React / Bun）。

---

## 0. 核心结论：CC 中"任务"是一个被严重重载的高频词

在整个 CC 代码库中，**"task"** 一词至少指向四个相互独立、机制完全不同的子系统。任何对任务系统的分析，如果不先厘清这四者的边界，都会陷入混乱。它们分别是：

| 子系统 | 核心文件 | 存储位置 | 生命周期 | 一句话定义 |
|---|---|---|---|---|
| **① 运行时后台任务注册表** | `src/Task.ts`、`src/utils/task/`、`src/tasks/` | **内存** `AppState.tasks` | 秒级（进程内） | 后台 shell / 后台 agent / 云端会话等后台执行的运行时追踪 |
| **② Agent 任务清单（TodoV2）** | `src/utils/tasks.ts`、`src/hooks/useTasksV2.ts`、`src/components/TaskListV2.tsx` | **磁盘** `~/.claude/tasks/<listId>/` | 跨会话（可持久化） | 面向 agent（含团队/swarm）的任务分配清单，可被 Task* 工具读写 |
| **③ TodoWrite 待办清单** | `src/tools/TodoWriteTool/`、`src/utils/todo/` | **内存** `AppState.todos[agentId]` | 单轮对话内 | 会话内"待办事项"checklist，由 LLM 通过 TodoWrite 工具维护 |
| **④ 定时任务（cron）** | `src/utils/cronTasks.ts`、`cronScheduler.ts` | 内存 + 磁盘 | 独立 | 与任务清单**无依赖**的独立计划任务系统 |

> 注意：①与②都出现在用户可见 UI 中，且都叫"任务"，极易混淆。①是后台执行进程的"任务"，②是可跨会话指派给团队 agent 的"任务"。两者共享了 `Task` 这个类型名，但**存储、状态机、数据结构完全不同**。本文会反复强调这一区分。

另外，`src/tasks.ts`（单数形式，`getAllTasks`/`getTaskByType`）与 `src/tasks/`（目录，各任务类型实现）是①子系统的注册与派发；`src/utils/tasks.ts`（复数形式）是**完全不同的文件**，属于②子系统。这是源码中一个诡异的命名陷阱，务必注意。

---

## 1. 分析主题清单

1. **四子系统辨识与全景架构** —— 四者如何共存、各自的技术底座、如何避免混淆（§0、§2）
2. **子系统①：运行时后台任务注册表**
   - 核心类型系统与状态机（§3.1）
   - 8 种任务类型逐一剖析（§3.2）
   - 任务生命周期：注册 → 状态流转 → 输出 → 轮询 → 通知 → 回收（§3.3）
   - 输出捕获与落盘机制（§3.4）
   - 任务停止：TaskStopTool 与 SDK `stop_task`（§3.5）
   - 恢复（--resume）与重挂载（§3.6）
   - 注册表派发与 feature-flag 门控（§3.7）
3. **子系统②：Agent 任务清单（TodoV2 / 团队编排）**
   - Schema 与状态机（§4.1）
   - 磁盘持久化与高水位 ID 分配（§4.2）
   - 锁机制（任务级 + 清单级）与并发安全（§4.3）
   - 函数 API 全景（创建/读取/更新/删除/认领/阻塞/取消指派）（§4.4）
   - 工具层：TaskCreate / TaskGet / TaskList / TaskUpdate（§4.5）
   - 团队 / swarm 编排：认领循环、忙碌检查、取消指派（§4.6）
   - UI 侧：TasksV2Store 与 TaskListV2（§4.7）
   - 清单 ID 解析优先级（§4.8）
4. **子系统③：TodoWrite 待办清单**
   - 类型与状态（§5.1）
   - TodoWriteTool 与 TaskListTool（§5.2）
   - 与 agentId 的绑定（§5.3）
5. **SDK 事件贯通**（task_started / task_progress / task_notification / task_terminated）（§6）
6. **输出系统的安全与性能设计**（§7）
7. **UI 表面：footer pill、Shift+Down 对话框、组件树**（§8）
8. **定时任务 cron 独立子系统**（§9）
9. **并发、一致性与反竞态设计**（§10）
10. **三子系统对比总结与辨析表**（§11）

---

## 2. 四子系统全景架构

```
┌────────────────────────────────────────────────────────────────────┐
│                        Claude Code CLI 会话                        │
│                                                                    │
│  ┌────────────── 子系统①：运行时后台任务注册表 ──────────────┐      │
│  │  AppState.tasks: { [taskId]: TaskState }   (纯内存)       │      │
│  │  ├─ LocalShellTask      local_bash (b)                    │      │
│  │  ├─ LocalAgentTask      local_agent (a)                   │      │
│  │  ├─ RemoteAgentTask     remote_agent (r)                  │      │
│  │  ├─ InProcessTeammate   in_process_teammate (t)           │      │
│  │  ├─ LocalMainSession    [background main] (s)             │      │
│  │  ├─ DreamTask           dream (d)                         │      │
│  │  ├─ LocalWorkflowTask   local_workflow (w, feature-gated) │      │
│  │  └─ MonitorMcpTask      monitor_mcp (m, feature-gated)    │      │
│  │  ├─ 生命周期框架: utils/task/framework.ts                  │      │
│  │  ├─ 输出落盘:   utils/task/diskOutput.ts                   │      │
│  │  ├─ 停止调度:   tasks/stopTask.ts                          │      │
│  │  └─ 注册派发:   tasks.ts (getAllTasks/getTaskByType)       │      │
│  └───────────────────────────────────────────────────────────┘      │
│                                                                    │
│  ┌────────────── 子系统②：Agent 任务清单 (TodoV2) ─────────┐      │
│  │  磁盘: ~/.claude/tasks/<listId>/{.lock,.highwatermark,   │      │
│  │                                       <id>.json}          │      │
│  │  数据层: utils/tasks.ts (锁/持久化/认领/团队)             │      │
│  │  UI层:   hooks/useTasksV2.ts (TasksV2Store) +            │      │
│  │          components/TaskListV2.tsx                        │      │
│  │  工具层: TaskCreate/TaskGet/TaskList/TaskUpdate + 团队    │      │
│  └───────────────────────────────────────────────────────────┘      │
│                                                                    │
│  ┌────────────── 子系统③：TodoWrite 待办清单 ────────────────┐      │
│  │  AppState.todos: { [agentId]: TodoList }   (纯内存)       │      │
│  │  工具层: TodoWriteTool / TaskListTool                      │      │
│  └───────────────────────────────────────────────────────────┘      │
│                                                                    │
│  ┌────────────── 子系统④：cron 定时任务 ──────────────────────┐     │
│  │  utils/cronTasks.ts + cronScheduler.ts + cronTasksLock.ts │      │
│  └───────────────────────────────────────────────────────────┘      │
└────────────────────────────────────────────────────────────────────┘
```

**关键辨识点：**
- ①是"**正在执行的后台东西**"的运行视图，标题栏右侧的 footer pill 和 `Shift+Down` 对话框即来源于此。
- ②是"**待办/指派清单**"的持久化数据，可跨进程/跨会话被多个 agent 共享读写，`/task` 任务 UI 面板即来源于此。
- ③是"**本会话 LLM 给自己列的 checklist**"，随内存存在。
- ④是"**到点自动触发的计划任务**"，与其余三者无依赖。

**① 与 ③ / ② 的功能关系：**
- ③与②是"工作追踪模型"的**两种互斥替代**：当②开启（`isTodoV2Enabled()===true`）时，`TodoWriteTool` **自我禁用**（`isEnabled() = !isTodoV2Enabled()`）。即在任一模式下，模型的"工作清单"要么是内存 TODO 列表③，要么是文件支撑的任务清单②，**不会同时存在**。②的模型更丰富（owner、依赖 DAG、跨会话共享）。
- ①与③/②**完全正交**：①追踪**正在执行的进程/agent**（running/completed/failed/killed，运行时 ID）；③/②追踪**模型已规划/认领的工作**（pending/in_progress/completed）。一个 TODO 项或 v2 任务在其生命周期内可能映射到零个或多个运行时任务，但**没有自动关联**——由模型自行把"Running tests"待办项与某个 `local_bash` 运行时任务对应起来。

---

## 3. 子系统①：运行时后台任务注册表

### 3.1 核心类型系统与状态机（`src/Task.ts`，125 行）

**类型枚举：**

```ts
// TaskType —— 任务类型
type TaskType =
  | 'local_bash'          // 本地后台 shell（bash 或 monitor）
  | 'local_agent'         // 本地后台 agent（子 agent / async AgentTool）
  | 'remote_agent'        // 云端远程会话任务
  | 'in_process_teammate' // 进程内团队队友（swarm）
  | 'local_workflow'      // 本地工作流脚本（feature-gated）
  | 'monitor_mcp'         // MCP 监视器（feature-gated）
  | 'dream'               // Dream 后台进程

// TaskStatus —— 5 态
type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'

// 终止态（终结性判断）
const isTerminalTaskStatus = (s) => s === 'completed' || s === 'failed' || s === 'killed'
```

> 注意：① 子系统的 `TaskStatus` 与 ② 子系统的 `TASK_STATUSES`（`pending|in_progress|completed`）**完全不同**。①有 `running/killed/failed`，②用的是 `in_progress`。这是两个独立状态机。

**任务基态 `TaskStateBase`：**

```ts
interface TaskStateBase {
  id: string           // 类型前缀 + 8 位随机字符
  type: TaskType
  status: TaskStatus
  description: string
  toolUseId?: string   // 关联发起它的 tool_use
  startTime: number
  endTime?: number
  totalPausedMs?: number
  outputFile: string   // <taskId>.output 磁盘路径
  outputOffset: number // 上次读取的字节偏移（用于增量读取）
  notified: boolean    // 完成通知是否已产生（回收的门卫）
}
```

**`Task` 接口：**

```ts
interface Task {
  name: string                                  // 类型名，如 'LocalShellTask'
  type: TaskType
  kill(taskId: string, setAppState): void | Promise<void>  // 唯一操作
}
```

> 有趣的设计：`Task` 接口在 PR #22546 之后**只保留** `name/type/kill` 三个字段。spawn/render 逻辑已从接口中移除，各类型的 spawn 通过各自模块的 `registerXxxTask` 导出函数完成，`kill` 则成为注册表派发的唯一统一入口。`kill` 只接收 `(taskId, setAppState)`，去掉 `getAppState` —— 这是一个刻意收敛，防止 kill 路径读旧状态。

**任务 ID 生成与安全（`generateTaskId`，L98-106）：**

```ts
const TASK_ID_PREFIXES = {
  local_bash: 'b',
  local_agent: 'a',
  remote_agent: 'r',
  in_process_teammate: 't',
  local_workflow: 'w',
  monitor_mcp: 'm',
  dream: 'd',
}

function generateTaskId(type: TaskType): string {
  const raw = randomBytes(8)  // 8 字节 = 64 位随机
  const id = prefix + 把 raw 通过 36 进制字母表（0-9a-z，大小写不敏感）编码
  return id
}
```

- **随机空间**：36^8 ≈ **2.8 万亿**，足以抵抗对 `.output` 文件的暴力猜测攻击（见 §7 安全）。
- **大小写不敏感**：键值与文件路径在 XML/日志中出现时会**被引号包裹**；大小写不敏感避免"路径大小写混淆"带来的安全问题。
- 注：还存在一个 `'s'` 前缀用于 `LocalMainSessionTask`（后台化主会话，见 §3.2 第 8 条），它不在 `TASK_ID_PREFIXES` 表中而由该模块自行定义。

**`createTaskStateBase`：** 状态 `'pending'`、`startTime=Date.now()`、`outputFile=getTaskOutputPath(id)`、`outputOffset=0`、`notified=false`。

### 3.2 任务类型逐一剖析（8 种）

任务的 spawn / status 流转 / kill 都遵循"各类型自治 + 统一框架"的模式。每个类型有独立的 `XxxTaskState` 继承 `TaskStateBase`，并在 `src/tasks/<Type>/` 下实现。

#### (1) local_bash —— `src/tasks/LocalShellTask/`

- **状态** `LocalShellTaskState`（`guards.ts`）：
  ```ts
  {
    command: string                    // shell 命令文本
    result?: { code: number; interrupted?: boolean }
    completionStatusSentInAttachment?: boolean
    shellCommand?: ShellCommand        // 底层进程封装
    unregisterCleanup?: () => void
    cleanupTimeoutId?: number
    lastReportedTotalLines?: number
    isBackgrounded: boolean            // 是否被后台化
    agentId?: string
    kind?: 'bash' | 'monitor'          // bash 普通命令 or monitor 监视
  }
  ```

- **触发**：`spawnShellTask`（`LocalShellTask.tsx` L180-252）—— 命令通过 `shellCommand.background(taskId)` 后台化，进入 `running` 状态，注册清理回调；结果到达时按"是否已被 kill"决定设 `completed`/`failed`，随后 `evictTaskOutput`（回收输出）。
  - **调用点**：`src/tools/BashTool/BashTool.tsx:905` 与 `src/tools/PowerShellTool/PowerShellTool.tsx:767`（后台变体）。
  - **前台变体** `registerForeground`（L285），由 `BashTool.tsx:1113` / `PowerShellTool.tsx:960` 调用。

- **后台化**：`backgroundAll` / `registerForeground` / `backgroundExistingForegroundTask` 在 `isBackgrounded` 之间切换，决定输出走"文件模式"还是"管道模式"（见 §3.4）。

- **卡死看门狗**：`startStallWatchdog`（L46-104）每 5s 轮询，若连续 45s 无输出（匹配 `PROMPT_PATTERNS`，即等待交互提示符却无响应）则 kill。这防止"卡在等待用户输入"的僵尸 shell。

- **kill**：`killTask`（`killShellTasks.ts`）—— 非 `running` 直接返回；否则底层 `shellCommand?.kill()`、`unregisterCleanup()`、设 `killed:true` + `notified:true`、`evictTaskOutput`。
  - `killShellTasksForAgent(agentId)`：杀掉某个 agent 的全部孤儿 shell（agent 退出时清理）+ 出队其通知。

- **迭代**：以 `LocalShellTask: Task`（L173-179，`kill→killTask`）形式注册进 `getAllTasks()`。

#### (2) local_agent —— `src/tasks/LocalAgentTask/LocalAgentTask.tsx`

- **状态** `LocalAgentTaskState`：
  ```ts
  {
    agentId: string; prompt: string
    selectedAgent?: string; agentType: string; model?: string
    abortController?: AbortController
    unregisterCleanup?: () => void
    error?: string; result?: string
    progress?: AgentProgress          // token/工具计数等进度
    retrieved?: boolean
    messages?: ...                    // 保留的会话转录（供协调面板显示）
    lastReportedToolCount?: number; lastReportedTokenCount?: number
    isBackgrounded: boolean
    pendingMessages: string[]         // 排队中的待发送消息
    retain: boolean                   // 完成后是否保留在面板
    diskLoaded?: boolean
    evictAfter?: number               // 面板宽限期后回收
  }
  ```

- **触发**：`registerAsyncAgent`（L466-515）—— 立即后台化，输出文件用 `initTaskOutputAsSymlink` 软链到 agent 转录文件（见 §3.4）。调用点：`src/tools/AgentTool/AgentTool.tsx:688` 与 `resumeAgent.ts:198`。`registerAgentForeground`（L526-614，调用点 `AgentTool.tsx:819`）有**自动后台化计时器**（前台稍后自动降级后台）。`backgroundAgentTask`/`unregisterAgentForeground` 管理可见性。

- **状态流转**：`completeAgentTask`（completed + `evictAfter`）、`failAgentTask`、`updateAgentProgress`、`updateAgentSummary`（gate `emitTaskProgress`）。真正驱动这些的是 `runAsyncAgentLifecycle`（`tools/AgentTool/agentToolUtils.ts:508-686`），由 AgentTool 的 async 模式与 `resumeAgentBackground` 共享。

- **kill**：`killAsyncAgent`（L281-303）—— abort `abortController`、`unregisterCleanup()`、设 `killed` + `evictAfter`（`retain ? undefined : now+PANEL_GRACE_MS`）。若 `retain` 为真则不设回收时间，让转录留在协调面板中供查看。

- **关键状态**：`retain`/`evictAfter`/`diskLoaded`/`pendingMessages` 共同支撑"协调者面板在 agent 运行期间显示保留的转录"这一交互。

#### (3) remote_agent —— `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx`

- **状态** `RemoteAgentTaskState`：
  ```ts
  {
    remoteTaskType: RemoteTaskType
    remoteTaskMetadata?; sessionId: string; command: string
    title?: string; todoList?: ...
    log: string; isLongRunning?: boolean
    pollStartedAt?: number            // 轮询开始时间（恢复不立即超时）
    isRemoteReview?: boolean; reviewProgress?;
    isUltraplan?: boolean; ultraplanPhase?;
  }
  // REMOTE_TASK_TYPES = 'remote-agent' | 'ultraplan' | 'ultrareview' | 'autofix-pr' | 'background-pr'
  ```

- **触发**：`registerRemoteAgentTask`（L386-466）—— `generateTaskId('remote_agent')`、`initTaskOutput`、`running`、`registerTask`、`persistRemoteAgentMetadata`，然后 `startRemoteSessionPolling`。返回 `{taskId, sessionId, cleanup}`。**与 shell/agent 不同**，remote 用 `initTaskOutput`/`appendTaskOutput` + 自己的轮询（RemoteAgentTask.tsx:417-420 注释），不走共享的磁盘增量路径。

- **状态流转**：轮询循环在会话归档/拿到结果时设 `completed`/`failed`；stop 时设 `killed`。

- **kill**：`RemoteAgentTask: Task`（L808-848）—— 若 `running`，设 `killed`+`notified:true`+`endTime`；随后 `emitTaskTerminatedSdk(id,'stopped')`、`archiveRemoteSession(sessionId)`（**停止云端资源消耗**）、`evictTaskOutput`、`removeRemoteAgentMetadata`。

#### (4) in_process_teammate —— `src/tasks/InProcessTeammateTask/`

- **状态** `InProcessTeammateTaskState`（`types.ts` L22-76）：`identity(TeammateIdentity)`、`prompt`、`model?`、`abortController?`、`currentWorkAbortController?`、`awaitingPlanApproval`、`permissionMode`、`error?`、`result?`、`progress?`、`messages?`、`inProgressToolUseIDs?`、`pendingUserMessages?`、`spinnerVerb?`、`pastTenseVerb?`、`isIdle`、`shutdownRequested`、`onIdleCallbacks?`、`lastReportedToolCount/LastReportedTokenCount`。`TEAMMATE_MESSAGES_UI_CAP = 50`（UI 消息上限）。

- **触发**：`spawnInProcessTeammate`（`utils/swarm/spawnInProcess.ts` **L191**）与 `src/tools/shared/spawnMultiAgent.ts`（**L819**）—— `generateTaskId('in_process_teammate')`、创建**独立** `AbortController`（**不随 leader 查询中断而被 abort**）、构建 `TeammateIdentity`、`createTeammateContext`（AsyncLocalStorage）、`running`、`registerCleanup→abort`、`registerTask`。实际进程通过 `utils/swarm/backends/PaneBackendExecutor.ts` 的 `spawn`（L79-209，构造 `claude --agent-id ... --team-name ...` CLI 命令）以 pane 形式拉起。

- **kill**：`InProcessTeammateTask: Task` → `killInProcessTeammate`（`spawnInProcess.ts` L227-328）—— abort 控制器、`unregisterCleanup()`、触发 `onIdleCallbacks`（解除 `waitForIdle` 阻塞）、从 `teamContext.teammates` + 团队文件移除成员（`removeMemberByAgentId`）、设 `killed`+`notified:true`+清空瞬时字段、`evictTaskOutput`、`emitTaskTerminatedSdk(id,'stopped')`、`setTimeout(evictTerminalTask, STOPPED_DISPLAY_MS)`、`unregisterPerfettoAgent`。

#### (5) dream —— `src/tasks/DreamTask/DreamTask.ts`

- **状态** `DreamTaskState`：`phase('starting'|'updating')`、`sessionsReviewing`、`filesTouched`、`turns`（上限 `MAX_TURNS=30`）、`abortController?`、`priorMtime`。
- **触发**：`registerDreamTask`（L72）；`addDreamTurn`；`completeDreamTask`（立即 `completed`+`notified`）；`failDreamTask`。
- **kill**：`DreamTask: Task`（L132-157）—— abort 控制器并调用 `rollbackConsolidationLock(priorMtime)`（**回滚文件整合锁的 mtime**，防止 kill 后留下过期的锁）。

> **Dream 的独特之处**：它是唯一一个 `kill` 需要"回滚磁盘状态"的任务 —— 因为它持有文件整合的乐观锁。

#### (6) 后台化主会话（`LocalMainSessionTask`，`src/tasks/LocalMainSessionTask.ts`）

`registerMainSessionTask`（L150）注册一个把**当前主会话后台化**的任务（Ctrl+B 两次触发），`'s'` 前缀 ID；由 `startBackgroundSession`（L338）接入。它把主动会话降级为后台运行视图，进入①的运行追踪。

#### (7) local_workflow —— `src/tasks/LocalWorkflowTask/`（**功能门控**）

**工作树中纯桩**：`LocalWorkflowTaskState = Record<string, unknown>`，`isLocalWorkflowTask` 返回 `false`。真实实现在 `feature('WORKFLOW_SCRIPTS')` 开启时通过 `require()` 动态加载（当前关闭）。呈现层仍存在（pill 有 "N background workflows"），但 spawn→register 完整流程不可追踪到可执行代码。

#### (8) monitor_mcp —— `src/tasks/MonitorMcpTask/`（**功能门控**）

同样为桩，门控于 `feature('MONITOR_TOOL')`（当前关闭）；`isMonitorMcpTask` 返回 `false`。`TaskType` 字面量、`'m'` 前缀、pill "N monitors"、`BackgroundTasksDialog` 的 widget 门控均已就位，但真实实现被剥离。

### 3.3 生命周期：注册 → 状态流转 → 输出 → 轮询 → 通知 → 回收

全部位于 `src/utils/task/framework.ts`，是①子系统的**核心生命周期框架**。`registerTask` 是**所有 spawn 的单一总闸**（每个 spawn 最终都调用它）。

**关键常量**：`POLL_INTERVAL_MS = 1000`（轮询间隔 1s）、`STOPPED_DISPLAY_MS = 3000`（停止后显示 3s 再淡出）、`PANEL_GRACE_MS = 30000`（面板宽限期 30s）。

#### 3.3.1 注册 `registerTask(task, setAppState)`（L77-117）

- 把任务写入 `AppState.tasks[taskId]`。
- 若是**重注册**（`resumeAgentBackground` 替换一个旧任务），会**向前迁移 UI 持有字段**：`retain, startTime, messages, diskLoaded, pendingMessages`（L87-97），保证恢复不丢失面板状态。
- 发出 `task_started` SDK 事件（L104-116），对适用类型携带 `workflow_name` / `prompt`。**替换时跳过发送**（避免重复）。

**全部 `registerTask` spawn 点（穷举）：**
1. `src/tasks/LocalShellTask/LocalShellTask.tsx:216` — `spawnShellTask`（后台 bash），上游 `BashTool.tsx:905`、`PowerShellTool.tsx:767`
2. `src/tasks/LocalShellTask/LocalShellTask.tsx:285` — `registerForeground`（前台 bash），上游 `BashTool.tsx:1113`、`PowerShellTool.tsx:960`
3. `src/tasks/LocalAgentTask/LocalAgentTask.tsx:513` — `registerAsyncAgent`（后台 agent），上游 `AgentTool.tsx:688`、`resumeAgent.ts:198`
4. `src/tasks/LocalAgentTask/LocalAgentTask.tsx:578` — `registerAgentForeground`（前台 agent），上游 `AgentTool.tsx:819`
5. `src/tasks/LocalMainSessionTask.ts:150` — `registerMainSessionTask`（后台主会话，`'s'` 前缀），经 `startBackgroundSession` L338
6. `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx:437` — `registerRemoteAgentTask`（云端会话）；`:528` — `restoreRemoteAgentTasksImpl`（--resume 重注册）
7. `src/tasks/DreamTask/DreamTask.ts:72` — `registerDreamTask`
8. `src/tools/shared/spawnMultiAgent.ts:819` 与 `src/utils/swarm/spawnInProcess.ts:191` — in-process teammate

#### 3.3.2 更新 `updateTaskState(taskId, setAppState, updater)`（L48-72）

- 通用不可变更新。若 updater 返回的是**同一个引用**则提前 no-op（早期短路），使 `AppState.tasks` 的订阅者无需重渲染。这是性能优化的关键：频繁的进度更新不会触发 UI 重渲染，除非状态真正变化。

#### 3.3.3 回收（Eviction）—— "终止 + notified"双条件

**两条回收路径：**

1. **主动回收** `evictTerminalTask`（L125-144）：要求终止态 + `notified` + 通过 `evictAfter` 面板宽限检查（用 `'retain' in task` 收窄到 LocalAgentTaskState 才能读 `evictAfter`）。
2. **惰性 GC**：在 `generateTaskAttachments`（L158-206）中，遍历 `state.tasks`，任何 `notified` 的终止任务被推入 `evictedTaskIds`。

> `notified` 是**去重门卫**：一个任务只有在它的**完成通知已被产出**之后才允许被回收。这保证用户**不会丢失"任务完成"提示**——如果完成通知还没送达就回收，用户会困惑"任务哪去了"。

#### 3.3.4 轮询 `pollTasks(getAppState, setAppState)`（L255-269）

每轮（每 1s）执行：
1. `generateTaskAttachments` —— 读取各任务输出的增量（`getTaskOutputDelta`），生成 attachment + 待回收 ID + 更新后的偏移。
2. `applyTaskOffsetsAndEvictions` —— 把偏移补丁与回收动作**作用到最新的 `prev.tasks`**（而非 await 前的陈旧快照），重新校验"终止+notified"以避免 TOCTOU 覆盖并发状态流转（§10 详述）。
3. 逐个把通知以**词法顺序**入队。

`getRunningTasks`（L149-152）返回当前 running 任务用于 UI/轮询。

> **轮询驱动点**：`pollTasks` / `generateTaskAttachments` / `applyTaskOffsetsAndEvictions` 在 `src/utils/attachments.ts` 的 `getUnifiedTaskAttachments` 中每轮对话都会被调用，把后台任务的输出与状态增量并入给模型的上下文。

### 3.4 输出捕获与落盘（`src/utils/task/diskOutput.ts`）

**目录布局**：`<projectTempDir>/<sessionId>/tasks/<taskId>.output`

- `getTaskOutputDir()`（L50-55）：`join(getProjectTempDir(), getSessionId(), 'tasks')`。**sessionId 在首次调用时被捕获**，不每次重读 —— 因为 `/clear` 会调用 `regenerateSessionId()`，若每次重读会造成打开的 TaskOutput 文件句柄指向旧路径而后 `open()` ENOENT。后台 bash 任务跨 `/clear` 存活，其输出文件必须保持可达。
- **会话隔离**：路径含 sessionId，保证同一项目并发会话不互相覆盖输出文件。代码注释甚至记录了具体事故编号（inc-4586 / boris-20260309-060423）：一个会话的启动清理曾 unlink 另一会话正在写的输出文件（写入进程 fd 保活 inode，但路径读取 ENOENT，导致 `getStdout()` 返回空串）。

**`DiskTaskOutput` 类（L97-231）—— 高性能异步落盘：**

- 用**扁平字符串数组作为写队列**，由**单一 drain 循环**消费。每个 chunk 在写完即时 GC，避免链式 `.then()` 闭包造成的内存滞留（每个反应函数会捕获其数据直到整链 resolve）。
- **内存关键约束**：`#writeAllChunks` 内**绝不 `await`**（L178-186），否则内存会随队列增长而暴涨。把 `await` 放在调用方 `#drainAllChunks` 是安全的位置。队列转 Buffer 用 `#queueToBuffers`（单独方法，让 GC 能尽快释放）。
- **磁盘上限**：`MAX_TASK_OUTPUT_BYTES = 5GB`。`append` 用 `content.length`（UTF-16 code unit，最多低估 UTF-8 字节 ~3×，作为粗粒度磁盘防护可接受）累计，超限后置 `#capped` 并写入截断标记，后续内容丢弃。
- **瞬态错误重试**：`#drain` 捕获 EMFILE（CI 繁忙）/ Windows 挂起删除的 EPERM，若队列非空重试一次再放弃，避免"flush 正常 resolve 但文件为空"的静默失败。
- `flush()` / `cancel()` 提供冲刷与取消语义。

**文件级安全（§7 详述）：**
- `O_NOFOLLOW`：禁止跟随符号链接。
- `initTaskOutput`：`O_EXCL` + `O_NOFOLLOW`（Windows 用字符串式 `'wx'`，避免 libuv 对数值 `O_EXCL` 返回 EINVAL）。
- `initTaskOutputAsSymlink`：先尝试建软链，失败则删旧文件重试（用于把任务输出软链到 agent 转录）。

**模块级 API：**
- `appendTaskOutput(taskId, content)` —— 异步追加。
- `flushTaskOutput(taskId)` —— 等待冲刷（读前调用保证数据落盘）。
- `evictTaskOutput(taskId)` —— 冲刷并从内存 map 删除（**不删文件**）。
- `cleanupTaskOutput(taskId)` —— 取消 + 删除内存 + `unlink` 文件。
- `getTaskOutputDelta(taskId, fromOffset, maxBytes=8MB)` —— 从字节偏移增量读取（`readFileRange`），**永不整文件加载**；ENOENT 返回空。
- `getTaskOutput(taskId, maxBytes)` —— `tailFile` 读尾；若字节总数超过读取量，前缀 `[NKB of earlier output omitted]`。
- `getTaskOutputSize(taskId)` —— 文件大小。

> **读写都是"追加 + 偏移"模型**：写入端 append，读取端按 offset 增量拉取新内容，二者通过字节偏移对齐。这让后台任务的大量输出（可达数 GB）既不撑爆内存也不撑爆每次传给模型的上下文。

### 3.5 任务停止：TaskStopTool 与 SDK `stop_task`（`src/tasks/stopTask.ts`）

StopTask 是①子系统"用户/外部可主动停止任务"的**唯一统一入口**，由 `TaskStopTool`（LLM 调用）与 SDK 的 `stop_task` 控制请求共用。

**错误码** `StopTaskError`：`not_found`（任务不存在）、`not_running`（非 running 状态）、`unsupported_type`（类型不支持停止）。

**`stopTask(taskId, ctx)`（L38-100）流程：**
1. `appState.tasks[taskId]` 查找任务。
2. 校验 `status === 'running'`，否则抛 `not_running`。
3. 通过 `getTaskByType` 获取该类型的 `Task` 实现（`name/type/kill`）。
4. `await taskImpl.kill()` —— 调用类型专属 kill。

**bash 特例**：为 bash 任务，stop 会**抑制 "exit code 137" 的 XML 通知**（直接设 `notified:true`）并改为直接 `emitTaskTerminatedSdk(id,'stopped')`。原因：bash 被 kill 时的 "exit code 137" 是**噪音**，不应作为"任务完成"通知呈现给用户；而 agent 被 kill 需要保留完成通知，因为 `extractPartialResult(agentMessages)` 提取的**部分结果**是有价值的信息负载而非噪音。

### 3.6 恢复（--resume）与重挂载

#### 远程 agent 恢复（RemoteAgentTask）

- `persistRemoteAgentMetadata` → 写入**会话 sidecar**（`utils/sessionStorage.ts`，`remote-agents` 集合，按 taskId 键）。**故意不存储状态** —— 状态从 CCR 实时获取。完成/kill 时 `removeRemoteAgentMetadata` 删除。
- `restoreRemoteAgentTasks(context)` → `restoreRemoteAgentTasksImpl`（L484-532），**必须**在 `switchSession()` 之后运行，使 `getSessionId()` 指向恢复会话的 sidecar 目录。逐条处理：
  1. `listRemoteAgentMetadata()`；为空即返回。
  2. 对每条 `fetchSession(meta.sessionId)`：`Session not found:`（404）→ 丢弃并删 sidecar 文件；其他错误（401/缺 OAuth）→ 视为仍在运行，跳过。
  3. `session_status === 'archived'`（客户端离线期间已结束）→ 删 sidecar，不复活。
  4. 重建 `RemoteAgentTaskState`：`createTaskStateBase` + `startTime=meta.spawnedAt` + `pollStartedAt=Date.now()`（避免 >30min 前的旧任务恢复后立即超时），`registerTask`、`initTaskOutput`、`startRemoteSessionPolling`。

#### 本地 agent 恢复（`tools/AgentTool/resumeAgent.ts`）

- `resumeAgentBackground`（L42-265）：读转录 + `readAgentMetadata(asAgentId(agentId))`（agent sidecar 元数据），过滤空白/孤儿 thinking/未解析工具引用消息，必要时重建 fork 系统提示，然后 **`registerAsyncAgent`**（L198）替换/重注册任务。用 `rootSetAppState = toolUseContext.setAppStateForTasks ?? setAppState`，使 teammate 的任务能"电报式地"注册进根 store。运行 `runAsyncAgentLifecycle`（与 AgentTool async 共享）。
- 调用方：`screens/REPL.tsx`、`tools/SendMessageTool/SendMessageTool.ts`。

#### bash 任务不恢复

**bash 任务无 sidecar 持久化** —— 它们与活进程绑定，不跨 `--resume` 存活。只有可被磁盘转录重新驱动的 agent 与云端分离的远程会话能恢复。

### 3.7 注册表派发与 feature-flag 门控（`src/tasks.ts`）

```ts
getAllTasks(): Task[] {
  return [
    LocalShellTask, LocalAgentTask, RemoteAgentTask, DreamTask,
    ...(feature('WORKFLOW_SCRIPTS') ? [require(LocalWorkflowTask)] : []),
    ...(feature('MONITOR_TOOL') ? [require(MonitorMcpTask)] : []),
  ]
}
getTaskByType(type): Task | undefined {
  return getAllTasks().find(t => t.type === type)  // kill 的唯一派发点
}
```

- 核心 4 类型（shell/agent/remote/dream）**始终注册**。
- `LocalWorkflowTask` / `MonitorMcpTask` 通过 `require()` **惰性加载**，仅在对应 feature flag 开启时进入注册表（当前均关闭，故为桩）。
- `getTaskByType` 是 `kill` 的唯一派发点 —— 因此 **InProcessTeammateTask 不在注册表内**（它由 swarm 的 `killInProcessTeammate` 独立管理 kill）。这是一个值得注意的设计缺口：teammate 任务不走统一的 `getTaskByType` kill 派发。

---

## 4. 子系统②：Agent 任务清单（TodoV2 / 团队编排）

### 4.1 Schema 与状态机（`src/utils/tasks.ts`）

```ts
interface TaskSchema {
  id: string
  subject: string          // 任务主题
  description?: string
  activeForm?: string      // 进行时表述
  owner?: string           // 分配给谁的 agentId
  status: TaskListStatus   // 'pending' | 'in_progress' | 'completed'
  blocks?: string[]        // 本任务阻塞哪些任务（id 列表）
  blockedBy?: string[]     // 本任务被哪些任务阻塞（id 列表）
  metadata?: Record<string, unknown>  // 自由元数据（_internal 字段被 UI 过滤）
}
const TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const
```

> 与①的状态机（`pending|running|completed|failed|killed`）对比：②**没有** `failed/killed`，多了 `in_progress`。②是一个"计划 → 进行 → 完成"的工作流状态机，不含错误/终止语义。

**DAG 依赖**：`blocks` / `blockedBy` 构成任务间依赖图。`listTasks`/`getTask` 会过滤已完成的任务作为 `blockedBy`（完成的任务不再阻塞）。

**`isTodoV2Enabled()`（utils/tasks.ts:133）**：`CLAUDE_CODE_ENABLE_TASKS` 环境变量为真 或 非交互会话。这是②的启用开关，同时**反向控制③**（TodoWrite 在 v2 开启时禁用）。

### 4.2 磁盘持久化与高水位 ID 分配

- **根目录**：`~/.claude/tasks/<taskListId>/`（`getTasksDir(taskListId)`）。
- **每清单三个文件**：
  ```
  ~/.claude/tasks/<listId>/
    ├── .lock              # 清单级锁文件
    ├── .highwatermark     # 高水位计数器（ID 分配）
    └── <id>.json          # 每任务一文件（如 "3.json"）
  ```
- **高水位文件** `HIGH_WATER_MARK_FILE = '.highwatermark'`：单调递增计数器。**创建任务时分配唯一整数 ID**（读-写-回写，在清单锁保护下），避免并发创建冲突，且复用旧 ID（比如删除 2.json 后新建可能拿到 2）。
- **`sanitizePathComponent`**：净化任务 ID 为合法文件名字段，防路径穿越。
- **默认清单 ID**：`DEFAULT_TASKS_MODE_TASK_LIST_ID = 'tasklist'`。

### 4.3 锁机制（任务级 + 清单级）

使用 `proper-lockfile`：

```ts
const LOCK_OPTIONS = { retries: { retries: 30, maxTimeout: 300, randomize: true } }  // 重试 30 次 + 退避
```

- **任务级锁**：对 `<id>.json` 加锁，保护对单个任务的读-改-写（`createTask`/`updateTask`/`deleteTask`/`claimTask`）。
- **清单级锁**：对 `.lock` 加锁，保护高水位 ID 分配与跨任务操作。

**并发安全的两次锁设计**：
- `updateTask(taskId, updater)`：**加载（加锁读）→ 应用 updater → 加锁写回**，用 proper-lockfile 保证同一时刻只有写者能改。
- `claimTaskWithBusyCheck` 用**两阶段**阻止 TOCTOU：先读快照判断计划，再在锁内二次确认（见 §4.6）。

### 4.4 函数 API 全景

| 函数 | 作用 |
|---|---|
| `getTaskListId()` | 解析当前清单 ID（§4.8，多级优先级） |
| `getTasksDir(taskListId)` / `getTaskPath(listId, id)` | 路径计算 |
| `createTask(taskListId, input)` | 按高水位分配 ID 创建任务 |
| `getTask(taskListId, id)` / `listTasks(taskListId)` | 读取 |
| `updateTask(taskListId, id, updater)` | 锁内读-改-写 |
| `updateTaskUnsafe` | 无锁快速更新（需调用方自行保证） |
| `deleteTask(taskListId, id)` | 删除任务文件 |
| `blockTask` / `claimTask` | 阻塞 / 认领任务 |
| `claimTaskWithBusyCheck(...)` | 认领 + 忙碌检查（防 TOCTOU） |
| `getAgentStatuses()` | 读取团队 agent 状态（team config.json） |
| `unassignTeammateTasks(agentId)` | 队友离线时收回其任务 |
| `setLeaderTeamName` / `clearLeaderTeamName` | 设置/清除 leader 团队名（影响清单 ID） |
| `onTasksUpdated` / `notifyTasksUpdated` | 进程内更新信号 |
| `isTodoV2Enabled()` / `resetTaskList` | 启用开关 / 重置清单 |

**`ClaimTaskResult` 的失败原因枚举**：`task_not_found`、`already_claimed`、`already_resolved`、`blocked`、`agent_busy`。

### 4.5 工具层

- **`TaskListTool`**（`src/tools/TaskListTool/`）：`buildTool`，`isEnabled() = isTodoV2Enabled()`。过滤 `metadata._internal`（内部任务不暴露）、过滤已完成阻塞者，输出表格化视图。
- **TaskCreate / TaskGet / TaskUpdate 等 `Task*` 工具**：面向 LLM 与团队 agent，作为②子系统的读写接口，操作 `utils/tasks.ts` 的持久化函数。
- 模型侧通过 `getTaskReminderAttachments`（`utils/attachments.ts:3375`）以 `task_reminder` attachment 接收任务清单提醒。

### 4.6 团队 / swarm 编排

**认领循环**（`src/utils/swarm/inProcessRunner.ts`）：
- `tryClaimNextTask`（624-657）：teammate 空闲时从清单中按顺序找 `pending` 且无未满足 `blockedBy` 且未被认领的任务。认领时把任务置为 `in_progress`。

**忙碌检查 `claimTaskWithBusyCheck`**：
- 两阶段：先读目标 agent 的忙碌状态（`getAgentStatuses` 读 team `config.json`），若忙则返回 `agent_busy`；再在锁内二次确认状态未变以防 TOCTOU。

**取消指派 `unassignTeammateTasks(agentId)`**：队友退出（kill/崩溃）时，把它名下 `in_progress` 的任务回退为 `pending` 并清空 owner，使其可被其他 agent 重新认领 —— 这是 swarm 容错的关键。

**团队 leader 的清单 ID**：`TeamCreateTool` 可 `setLeaderTeamName`，团队 leader 的任务清单 ID 变为 team 相关值（§4.8）。

### 4.7 UI 侧：TasksV2Store 与 TaskListV2

**`TasksV2Store`**（`src/hooks/useTasksV2.ts`）是一个单例 store，实现 `useSyncExternalStore` 契约（`subscribe`/`getSnapshot`），专门为 TodoV2 任务清单 UI 服务：

- **单一文件监听器**：多个 hook 实例（REPL、Spinner、PromptInputFooterLeftSide）共享一个 store，**共用同一个 `fs.watch`**，而非各自 setup —— 因为 Spinner 每轮对话 mount/unmount，若各自监听会造成频繁 watch/unwatch 抖动。
- 数据源：`listTasks(taskListId).filter(t => !t.metadata?._internal)`（过滤内部任务）。
- 触发刷新三通道：
  1. `onTasksUpdated` —— **进程内**更新信号。
  2. `fs.watch` on `<listId>/` 目录 —— 跨进程/跨会话文件变化。
  3. 兜底 `FALLBACK_POLL_MS = 5000` 轮询（防 fs.watch 丢事件）。
- **隐藏逻辑**：全部完成 > `HIDE_DELAY_MS = 5000` 后隐藏列表；列表为空也隐藏。`#hidden` 时 `getSnapshot` 返回 `undefined`，UI 不显示。
- `#rewatch`：检测到清单 ID 变化（如 TeamCreateTool 设 leaderTeamName）就重定向 watch 目标目录。

**UI 渲染**：`src/components/TaskListV2.tsx` 是②的任务清单面板组件（与 `components/tasks/` 后台任务对话框**相互独立**）。`src/commands/tasks/tasks.tsx` 是 `/tasks` 命令入口。

### 4.8 清单 ID 解析优先级（`getTaskListId()`）

多级优先级解析当前任务清单 ID：环境变量 → teammateContext → 团队/leader 名（`setLeaderTeamName` 设置）→ 会话 ID，最终兜底默认 `'tasklist'`。跨进程/跨会话共享同一清单时 ID 解析是其一致性的前提。

---

## 5. 子系统③：TodoWrite 待办清单

### 5.1 类型与状态（`src/utils/todo/types.ts`）

```ts
const TodoStatusSchema = z.enum(['pending', 'in_progress', 'completed'])
const TodoItemSchema = z.object({
  content: z.string().min(1, 'Content cannot be empty'),
  status: TodoStatusSchema(),
  activeForm: z.string().min(1, 'Active form cannot be empty'),
})
const TodoListSchema = z.array(TodoItemSchema())
```

**存储**：`AppState.todos: { [agentId: string]: TodoList }`（`src/state/AppStateStore.ts:220`）。

> ①是 `AppState.tasks`，③是 `AppState.todos`，两字段并列但语义完全不同：tasks 存后台执行进程，todos 存会话内待办清单。

### 5.2 TodoWriteTool 与 TaskListTool

**`TodoWriteTool`**（`src/tools/TodoWriteTool/`）：
- Schema：`{ todos: TodoListSchema }`（strict，整表替换语义）。
- 输出：`{ oldTodos, newTodos, verificationNudgeNeeded? }`。
- `isEnabled() = !isTodoV2Enabled()` —— **与②互斥**：TodoWrite 工具仅在 TodoV2（任务清单）关闭时启用。二者是"会话内简单待办" vs "持久化任务清单"的两种模式，由 flag 二选一。
- `call`：
  - `todoKey = context.agentId ?? getSessionId()` —— **每个 agent 一份清单**，上报上下文中没有 agentId 用会话 ID。
  - `allDone = todos.every(t => t.status === 'completed')` → 全完成则 `newTodos = []`（**清空清单**）。
  - **验证助推（verification nudge）**：若主线程 agent 收尾一个 **≥3 项**且无任何项为验证步骤的清单，则 `verificationNudgeNeeded = true`，在 ToolResult 中追加一段，提示调用方（subagent）**先派生验证 agent 再写最终总结**，且不能通过在总结里列举 caveat 自封 PARTIAL —— "只有验证者能给出 verdict"。门控于 `feature('VERIFICATION_AGENT')` 与 `getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence')`。
  - `setAppState` 写 `prev.todos[todoKey] = newTodos`。
- `mapToolResultToToolResultBlockParam` 把 `verificationNudgeNeeded` 转成回给模型的提示文本。

**模型侧消费**：`getTodoReminderAttachments`（`utils/attachments.ts:3280`）在距上次 TodoWrite 超过阈值轮数时发出 `todo_reminder` attachment（`TODO_REMINDER_CONFIG`，`TURNS_SINCE_WRITE:10`）。

**`TaskListTool`**：任务清单的只读查询工具（§4.5），与 TodoWrite 的"会话内清单"不同，它读**磁盘上的 TodoV2 任务清单**。

### 5.3 与 agentId 的绑定

- 每个 agent（含 team 里的队友）维护自己的 `todos[agentId]`。
- 主线程 agent 的清单键是 `getSessionId()`（无 agentId）。
- 派生 agent 前应先用 TodoWrite 建清单（系统的 todo 使用模式：`CheckTodo`/`TodoWrite` 每轮交互）。

---

## 6. SDK 事件贯通

后台任务系统通过 SDK 事件队列（`src/utils/sdkEventQueue.ts`）把内部状态暴露给 SDK 用户。

**事件类型**：`TaskStartedEvent`（`task_started`）、`TaskProgressEvent`（`task_progress`，含 `workflow_progress` 批量）、`TaskNotificationSdkEvent`（`task_notification`）、`SessionStateChangedEvent`。

**入队规则 `enqueueSdkEvent`（L77-87）**：
- **仅在非交互/headless 模式入队**（`getIsNonInteractiveSession()`）。
- TUI 交互模式下，本可推送的事件被累积且永远不被读取（即被丢弃），避免 TUI 被 SDK 事件流干扰。
- 队列上限 `MAX_QUEUE_SIZE = 1000`，溢出时**丢弃最旧**（shift）。

**出队 `drainSdkEvents()`**：splice 队列，盖章 `uuid` + `session_id`。

**发送链**：
- `registerTask()` 总是发 `task_started`。
- 后台 agent 每次 tool_use 通过 `agentToolUtils.ts` → `emitTaskProgress`（`sdkProgress.ts`）发 `task_progress`（含 `total_tokens`/`tool_uses`/`duration_ms`/`last_tool_name`/`summary`/`workflow_progress`）。
- 完成时通过 `task_notification` 收尾。**`emitTaskTerminatedSdk`（L114-134）** 是 `task_notification` 的闭合封底：对"不走 `enqueuePendingNotification` + `<task-id>` 标签"的退出路径（如 stop），直接发终止事件。之所以要区分：因为 `print.ts` 已会把带 `<task-id>` 的通知解析成同一个 SDK 事件，若两处都发会**双重发送**，所以专门有此函数避免该问题。

**SDK `stop_task` 控制**：见 §3.5，与 `TaskStopTool` 共享 `stopTask`。

---

## 7. 输出系统的安全与性能设计

### 安全

1. **符号链接攻击防御（O_NOFOLLOW）**：
   ```ts
   const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0
   ```
   注释明确指出：**没有它，沙箱中的攻击者可在 tasks 目录创建指向任意文件的符号链接**，导致宿主机上的 CC 向这些文件写入内容。O_NOFOLLOW 在 Windows 不可用（值为 0），但沙箱攻击向量仅限 Unix。`initTaskOutput` 进一步用 `O_EXCL`（Windows 用 `'wx'`，规避 libuv 对数值 `O_EXCL` 的 EINVAL）确保创建的是新文件，不覆盖已存在文件。
2. **ID 熵防爆破**：36 位字母表 × 8 字符 ≈ 2.8 万亿组合，防止攻击者猜测/遍历其他任务的输出文件路径。
3. **路径隔离**：输出目录在项目 temp 目录下，使读取被 `checkReadableInternalPath` 自动放行（内部路径读取白名单）。
4. **会话隔离**：路径含 sessionId，防并发会话串扰。

### 性能

1. **增量/偏移读取**：`getTaskOutputDelta` 按字节偏移读新内容，绝不整文件加载（单轮最大 8MB，但偏移制使它可持续推进）。
2. **扁平队列 + 单一 drain**：避免闭包链内存滞留；`#writeAllChunks` 内无 `await` 阻断 GC。
3. **单实例复用**：`outputs` Map 按 taskId 缓存 `DiskTaskOutput`，`appendTaskOutput` 复用同一写者。
4. **内存输出上限 5GB + 截断标记**：超限丢弃并标记，防止磁盘被后台任务撑爆。
5. **Tail 读取提示**：大输出读取前缀 `[NKB of earlier output omitted]`。
6. **5s 卡死看门狗**：防止僵尸 shell 空耗资源。

### 测试性细节

- `_pendingOps` Set 追踪 fire-and-forget promise，`_clearOutputsForTest` 在 teardown 前 drain，防止"异步 ENOENT-after-teardown"的 flaky 测试类（注释引用 #24957、#25065）。这类细节暴露了输出系统的工程严谨度。

---

## 8. UI 表面：footer pill、Shift+Down 对话框、组件树

### 8.1 Footer pill（`src/components/tasks/BackgroundTaskStatus.tsx` + `src/tasks/pillLabel.ts`）

**pill 渲染** `BackgroundTaskStatus.tsx`：
- `tasks = useAppState(s => s.tasks)`（L40）订阅整个 `AppState.tasks`。
- 过滤可见任务（L43-49）：`Object.values(tasks).filter(t => isBackgroundTask(t) && !(ant && isPanelAgentTask(t)))`。`isBackgroundTask`（`src/tasks/types.ts:37`）= status 为 `running`/`pending` 且（若存在 `isBackgrounded`）为 `true` —— **终止任务被排除**，前台任务（`isBackgrounded:false`）被排除。
- 过滤后为空则返回 `null`（L194-197）—— **没有东西在运行时不显示 pill**。
- 否则 `getPillLabel(runningTasks)`（L200）渲染进 `SummaryPill`；`pillNeedsCta`（L218）追加 `" · ↓ to view"`。
- 团队模式还会渲染 `@name` 队友 pill（`expandedView === 'teammates'`）。

**标签聚合** `getPillLabel`（`src/tasks/pillLabel.ts` L10-67）—— 按 `task.type` 分组并以计数 + 符号图标呈现：

| 类型 | 标签 |
|---|---|
| local_bash (bash) | `N shells` |
| local_bash (monitor) | `N monitors` |
| in_process_teammate | `N teams` |
| local_agent | `N local agents` |
| remote_agent | `N cloud sessions` |
| remote_agent ultraplan | `◆ ultraplan ready` / `◇ ultraplan needs your input` |
| local_workflow | `N background workflows` |
| monitor_mcp | `N monitors` |
| dream | `dreaming` |
| 兜底 | `N background tasks` |

`pillNeedsCta`（L74-82）：仅当**单个** remote_agent 且 `isUltraplan && ultraplanPhase !== undefined` 时返回 true（提示下拉查看）。

**`shouldHideTasksFooter`**（`taskStatusUtils.tsx:93`）：当 spinner 树激活且所有可见任务都是 in-process teammate（已在树中展示）时，允许隐藏 pill，避免重复。

### 8.2 后台任务判定（`src/tasks/types.ts`）

```ts
isBackgroundTask = (t) =>
  (t.status === 'running' || t.status === 'pending') && t.isBackgrounded !== false
```
`BackgroundTaskState` 是多种 TaskState 的联合类型。判定"后台任务" = 运行/挂起 且 `isBackgrounded !== false`（显式 `isBackgrounded===false` 的前台任务不算）。

### 8.3 UI 接线位置

- **pill**：`src/components/tasks/BackgroundTaskStatus.tsx`（footer 状态栏组件）。
- **Shift+Down 对话框**：`src/components/PromptInput/PromptInput.tsx:2125` 渲染 `<BackgroundTasksDialog/>`；`Shift+Down` 键绑定在 `src/screens/REPL.tsx:4440`。
- **`/tasks` 命令**：`src/commands/tasks/tasks.tsx`。

### 8.4 Shift+Down 对话框（`src/components/tasks/BackgroundTasksDialog.tsx`）

- 遍历 `isBackgroundTask` 过滤后的任务列表，渲染 `BackgroundTask` 行。
- `BackgroundTask.tsx` 按 `task.type` 分发到各类型进度组件：shell → `ShellProgress`，remote → `RemoteSessionProgress`，agent → `TaskStatusText`，teammate → `InProcessTeammateDetailDialog`，dream → `DreamDetailDialog` 等。
- 详情对话框：`AsyncAgentDetailDialog` / `ShellDetailDialog` / `RemoteSessionDetailDialog`（+ `RemoteSessionProgress`）/ `DreamDetailDialog` / `InProcessTeammateDetailDialog` / `MonitorMcpDetailDialog` / `WorkflowDetailDialog`。
- 辅助件：`taskStatusUtils.tsx`（`isTerminalStatus`/`getTaskStatusIcon`/`getTaskStatusColor`/`describeTeammateActivity`/`shouldHideTasksFooter`）、`renderToolActivity.tsx`（把 `ToolActivity` 解析为 `<userFacingName>(args)`）、`BackgroundTaskStatus.tsx`。
- 功能门控：`WorkflowDetailDialog` 门控于 `feature('WORKFLOW_SCRIPTS')`（L109-119）；monitor-mcp 模块门控于 `feature('MONITOR_TOOL')`。
- 对话框 imported 每个 `*Task: Task` 对象，以便调 `kill` 停止任务。

### 8.5 组件树（globbing 验证）

`src/components/tasks/` 实际存在的组件：
```
AsyncAgentDetailDialog.tsx        BackgroundTask.tsx
BackgroundTaskStatus.tsx          BackgroundTasksDialog.tsx
DreamDetailDialog.tsx             InProcessTeammateDetailDialog.tsx
MonitorMcpDetailDialog.tsx        RemoteSessionDetailDialog.tsx
RemoteSessionProgress.tsx         renderToolActivity.tsx
ShellDetailDialog.tsx             ShellProgress.tsx
TaskStatusText.tsx (引用的辅助件)
WorkflowDetailDialog.tsx          taskStatusUtils.tsx
```

> **重要区分**：此目录是①后台任务的对话框组件；**②TodoV2 任务清单的 UI 在 `src/components/TaskListV2.tsx`**（位于 `components/` 根，不在 `components/tasks/` 下），由 `TasksV2Store` 驱动，两者是完全独立的 UI。

---

## 9. 定时任务 cron 独立子系统

`src/utils/cronTasks.ts` + `cronScheduler.ts` + `cronTasksLock.ts` 构成 **④独立计划任务**系统：
- 与任务清单（②）**无依赖**（已验证导入关系）。
- 维护自己的调度器（`cronScheduler.ts`）与锁（`cronTasksLock.ts`）。
- 这是"到点自动执行预定义命令/会话"的机制，不同于后台任务（运行时视图）与任务清单（持久化指派清单）。

**边界**：cron 任务在触发后可能作为后台任务运行而进入①，但 cron 的**定义/调度/触发**与①的运行时追踪、②的指派清单、③的会话内待办**都不共享代码**。

---

## 10. 并发、一致性与反竞态设计

① 子系统（运行时）落在**单线程事件循环 + 不可变 state 更新**之上，它面临的竞态有几类，均有专门设计：

1. **回收 vs 状态变更（TOCTOU "僵尸化"防护）**：`applyTaskOffsetsAndEvictions`（L213-249）在应用偏移补丁与回收动作时，**读的是 await 后的最新 `prev.tasks`**（而非 `generateTaskAttachments` 的陈旧快照），并**重新校验"终止 + notified"**。防止：在读取快照与真正应用之间的空隙里，任务被并发地再次推进状态（比如从 completed 被外部 kill），从而造成"回收了一个仍在活跃变化的任务"或"覆盖了更新的状态"。
2. **notified 去重门卫**：回收要求 `notified=true`，确保完成通知先于回收送达，用户的"任务完成"提示绝不丢失。
3. **重注册字段迁移**：`registerTask` 的重注册路径显式迁移 UI 持有字段，防止恢复时状态丢失。
4. **kill 与状态变更的竞争**：各类型 kill 都先检查 `status !== 'running'` 再动手；stopTask 也是在锁内校验 running 才 kill。远程任务的轮询在循环里**重查 `status==='running'`** 以裁决与 `stopTask` 的竞争。
5. **输出写读偏移对齐**：写入 append、读取按 offset 增量，偏移在状态里携带，随不可变更新流转，天然一致。

② 子系统（磁盘清单）的并发是**跨进程**的，用**文件锁**保证：
- proper-lockfile 任务级 + 清单级双层锁。
- 高水位计数器在清单锁内 读-改-写，防止并发 ID 分配冲突。
- `claimTaskWithBusyCheck` 两阶段（先读快照判断计划 → 锁内二次确认）防 TOCTOU。
- 多 agent 并发认领时，`already_claimed` / `agent_busy` 等结果枚举让调用方能优雅重试。

**反竞态设计总原则**："**先快照做决策，再在锁/最新状态下二次确认**"，贯穿①②两个子系统，是任务系统健壮性的灵魂。

---

## 11. 三子系统对比总结与辨析表

| 维度 | ① 运行时后台任务 | ② Agent 任务清单 (TodoV2) | ③ TodoWrite 待办 |
|---|---|---|---|
| **核心文件** | `src/Task.ts`、`utils/task/`、`tasks/` | `utils/tasks.ts`、`hooks/useTasksV2.ts`、`components/TaskListV2.tsx` | `tools/TodoWriteTool/`、`utils/todo/` |
| **存储** | 内存 `AppState.tasks` | 磁盘 `~/.claude/tasks/<id>/` | 内存 `AppState.todos` |
| **状态机** | `pending/running/completed/failed/killed` | `pending/in_progress/completed` | `pending/in_progress/completed` |
| **生命周期** | 进程内秒级 | 跨会话持久化 | 会话内 |
| **数据类型** | `TaskStateBase` + 类型专属状态 | `TaskSchema`（含 DAG 依赖、owner） | `TodoItem` |
| **用户视角** | footer pill / Shift+Down 后台对话框 | TodoV2 任务面板（团队/任务指派） | 会话内 checklist |
| **并发** | 单线程 + 不可变 state + TOCTOU 防护 | proper-lockfile 文件锁 + 高水位 | 单线程 `setAppState` |
| **持久化** | 输出落盘，任务状态不持久化（agent/remote 可恢复） | 全量持久化 | 不持久化 |
| **SDK 事件** | `task_started/progress/notif/terminated` | 工具读写 | 无专用 SDK 事件 |
| **工具** | TaskStopTool（stop）、AgentTool async 注册 | TaskCreate/Get/List/Update、Team 系列 | TodoWriteTool、TaskListTool |
| **互斥关系** | 与②③正交 | 与③互斥（v2 开则 TodoWrite 关） | 与②互斥 |

**一句话记忆**：
- **①** = 咖啡店里**正在被演出/排队**的"演出单"（后台进程的运行视图）。
- **②** = 项目经理**分配给人**的"任务清单"（可跨天持久化、可指派给团队）。
- **③** = 开发者**自己桌面的**"今日待办便签"（随会话内存消失）。
- **④** = 设定好的**闹钟/调度**（到点自动触发）。

---

## 附录 A：关键文件索引

| 文件 | 角色 |
|---|---|
| `src/Task.ts` | ①核心类型/ID |
| `src/tasks.ts` | ①注册表派发（getAllTasks/getTaskByType） |
| `src/utils/task/framework.ts` | ①生命周期框架（register/update/evict/poll） |
| `src/utils/task/diskOutput.ts` | ①输出落盘 |
| `src/utils/task/sdkProgress.ts` | SDK task_progress |
| `src/utils/task/outputFormatting.ts` | 输出截断（TASK_MAX_OUTPUT_LENGTH 32k 默认 / 160k 上限） |
| `src/utils/sdkEventQueue.ts` | SDK 事件队列 |
| `src/tasks/stopTask.ts` | ①停止统一入口 |
| `src/tasks/pillLabel.ts` / `src/tasks/types.ts` | pill 标签 / 后台任务判定 |
| `src/components/tasks/BackgroundTaskStatus.tsx` | footer pill 渲染 |
| `src/tasks/LocalShellTask/` | local_bash |
| `src/tasks/LocalAgentTask/` | local_agent |
| `src/tasks/LocalMainSessionTask.ts` | 后台化主会话（'s'） |
| `src/tasks/RemoteAgentTask/` | remote_agent |
| `src/tasks/InProcessTeammateTask/` + `utils/swarm/`、`tools/shared/spawnMultiAgent.ts` | in_process_teammate |
| `src/tasks/DreamTask/` | dream |
| `src/tasks/LocalWorkflowTask/` | local_workflow（gated） |
| `src/tasks/MonitorMcpTask/` + `tools/MonitorTool/` | monitor_mcp（gated） |
| `src/utils/tasks.ts` | ②数据层（持久化/锁/认领/团队） |
| `src/hooks/useTasksV2.ts` | ②UI 层（TasksV2Store） |
| `src/components/TaskListV2.tsx` / `src/commands/tasks/tasks.tsx` | ②UI 面板 / `/tasks` 命令 |
| `src/utils/swarm/inProcessRunner.ts` | ②认领循环 |
| `src/utils/swarm/backends/PaneBackendExecutor.ts` | teammate pane 拉起 |
| `src/tools/TaskListTool/` | ②查询工具 |
| `src/tools/TodoWriteTool/` | ③TodoWrite |
| `src/utils/todo/types.ts` | ③类型 |
| `src/state/AppStateStore.ts`（L160/L220/L470） | tasks/todos 字段 |
| `src/components/tasks/` | ①对话框组件树 |
| `src/utils/attachments.ts`（L3280/L3375） | 每轮把任务/todo/task 提醒并入模型上下文 |
| `src/tools/AgentTool/agentToolUtils.ts`、`resumeAgent.ts` | local_agent 生命周期/恢复 |
| `src/utils/cronTasks.ts` 等 | ④cron |

---

*（文档完。本文基于源码静态分析，feature-gated 的 local_workflow / monitor_mcp 因当前 flag 关闭仅为桩，后续 flag 开启或有新源码时需重新核验。）*
