# Claude Code 其他工具分类拆解（调用流程与安全策略）

> 基于源码分析，聚焦 **BashTool / PowerShellTool 之外** 的内置工具、外部 MCP 工具、自定义工具，按「内置/外部/自定义」与「只读/编写」两个维度分类，剖析各自调用流程与安全策略。
> 核心文件：`src/tools/`、`src/Tool.ts`、`src/services/tools/toolExecution.ts`、`src/utils/permissions/permissions.ts`
>
> 本文重点：**所有工具共用同一执行管线**，安全差异 100% 来自各工具对 `isReadOnly` / `isConcurrencySafe` / `checkPermissions` 的覆写与否。读懂 `checkPermissions` 的决策骨架，就能理解全部工具的权限行为。

## 目录

1. [全景：统一骨架与工具形态](#1-全景统一骨架与工具形态)
2. [权限决策骨架（checkPermissions 管线）](#2-权限决策骨架checkpermissions-管线)
3. [维度一：内置工具分类](#3-维度一内置工具分类)
4. [维度二：外部 MCP 工具](#4-维度二外部-mcp-工具)
5. [维度三：自定义 / 插件工具](#5-维度三自定义--插件工具)
6. [维度四：只读类工具](#6-维度四只读类工具)
7. [维度五：编写类工具](#7-维度五编写类工具)
8. [元工具：AgentTool 与 SkillTool](#8-元工具agenttool-与-skilltool)
9. [网络 / 外部工具的特殊防护](#9-网络--外部工具的特殊防护)
10. [任务 / 调度 / 消息工具](#10-任务--调度--消息工具)
11. [贯穿性安全结论](#11-贯穿性安全结论)
12. [关键源码速查](#12-关键源码速查)

---

## 1. 全景：统一骨架与工具形态

### 1.1 buildTool 与 TOOL_DEFAULTS

所有工具——内置、外部 MCP、自定义——都实现同一个 `Tool` 接口（[Tool.ts:362-695](../src/Tool.ts#L362)），由 `buildTool()`（[Tool.ts:783](../src/Tool.ts#L783)）构造：

```typescript
const built = { ...TOOL_DEFAULTS, ...def };
```

**`TOOL_DEFAULTS`（[Tool.ts:757-769](../src/Tool.ts#L757)）是安全语义的关键**——所有工具共享这些默认值：

| 方法 | 缺省 | 含义 |
| --- | --- | --- |
| `isEnabled()` | `true` | 工具可用 |
| `isConcurrencySafe()` | `false` | 默认**不可并发** |
| `isReadOnly()` | `false` | 默认**视为写操作** |
| `isDestructive()` | `false` | 仅不可逆操作（删除/覆盖/发送）才置 true |
| `checkPermissions()` | `allow` | **默认直接放行，不弹权限框** |
| `toAutoClassifierInput()` | `''` | `''` = 无安全相关性，跳过 auto 分类器 |

> **核心洞察**：工具**只有显式覆写** `isReadOnly: true` / `checkPermissions` 才会表现出不同的安全行为。默认的 `checkPermissions` 返回 `allow`，靠的是上游 auto 分类器 + 安全白名单 + 细致 `validateInput`。

### 1.2 主调用流

所有工具共用同一条执行管线。模型调用工具后，经 `streamedCheckPermissionsAndCallTool`（[toolExecution.ts:492](../src/services/tools/toolExecution.ts#L492)）→ `checkPermissionsAndCallTool`（[toolExecution.ts:599](../src/services/tools/toolExecution.ts#L599)）：

```
① Zod inputSchema.safeParse           ← 参数校验，失败返回 InputValidationError
② tool.validateInput()                ← 工具级无 I/O 预检（先于权限，如 TaskStop 校验任务存在）
③ 剥离 _simulatedSedEdit 内部字段     ← 防止模型注入内部字段
④ PreToolUse hooks                    ← 可覆盖决策 / 替换入参 / 阻止继续
⑤ tool.checkPermissions() → canUseTool()  ← 权限决策（工具逻辑 + 通用规则）
⑥ 非 allow → 拒绝（返回错误消息）
⑦ tool.call()  → mapToolResultToToolResultBlockParam → tool_result
```

关键节点：

- **Zod schema 校验**（:615）：`tool.inputSchema.safeParse(input)`，失败返回 `InputValidationError`，并附 `buildSchemaNotSentHint`（:578，用于延迟/未发送 schema 的工具）。
- **Defense-in-depth**（:761-773）：剥离模型提供的 `_simulatedSedEdit` 内部字段，只允许权限系统注入。
- **PreToolUse hooks**（:800-862）：遍历 `runPreToolUseHooks`，可产生 `hookPermissionResult` / `hookUpdatedInput` / `stop`。
- **`resolveHookPermissionDecision`**（:921，实现在 [toolHooks.ts:332](../src/services/tools/toolHooks.ts#L332)）：解析 hook 决定 + 规则，产出最终 `PermissionDecision`。
- 结果由各工具的 `mapToolResultToToolResultBlockParam` 序列化为 tool_result block。

---

## 2. 权限决策骨架（checkPermissions 管线）

`checkPermissions` 并不孤立运行——它被嵌入 **[permissions.ts:1158](../src/utils/permissions/permissions.ts#L1158) `hasPermissionsToUseToolInner`** 的完整决策管线中：

```
① 整体 deny 规则 getDenyRuleForTool              → deny
② 整体 ask 规则 getAskRuleForTool                → ask（Bash 沙箱自动允许例外）
③ tool.checkPermissions(parsedInput, context)     ← 工具特定逻辑
④ toolPermissionResult.behavior === 'deny'        → deny
⑤ requiresUserInteraction?.() 且 result 为 ask    → 即使 bypass 也弹框
⑥ 内容特定 ask 规则（decisionReason.type==='rule' && ruleBehavior==='ask'）→ 绕过 bypassPermissions
⑦ safetyCheck（.git/、.claude/、shell 配置等路径）→ 绕过 bypassPermissions
⑧ bypass 判定（mode==='bypassPermissions' 或 plan 且可用）→ 直接 allow
⑨ toolAlwaysAllowedRule                          → allow
⑩ 兜底：passthrough 转 ask
```

### 2.1 权限模式

权限模式定义于 [types/permissions.ts:21-29](../src/utils/permissions/types.ts#L21)：

- **外部**：`default | acceptEdits | plan | bypassPermissions`
- **内部**：`ExternalPermissionMode | 'auto' | 'bubble'`

### 2.2 checkRuleBasedPermissions（hook 也不能绕过规则）

[permissions.ts:1071](../src/utils/permissions/permissions.ts#L1071) 被 hook-allow 路径调用（toolHooks.ts:373），**保证 hook 放行仍需规则检查**——deny / ask / safetyCheck 规则**不能被 PreToolUse hook 绕过**。这是纵深防御：hook 能拦截，但不能豁免安全规则。

### 2.3 Auto 模式分类器路径

[permissions.ts:560-699](../src/utils/permissions/permissions.ts#L560)：

- **acceptEdits 快路径**（:600-656）：`tool.checkPermissions` 在 `mode:'acceptEdits'` 下返回 allow 则跳过分类器。**显式排除 `AGENT_TOOL` 与 `REPL_TOOL`**（:602-603），防止 Agent 的工具 checkPermissions 返回 allow 被误放行——Agent 的子代理必须走分类器。
- **安全工具白名单快路径**（:660 `isAutoModeAllowlistedTool`）→ 直接 allow，省 API 调用。
- 否则跑 `classifyYoloAction` 分类器（:693）。
- **风控**：`permissionSetup.ts` 有 `AutoModeEnabledState`（:1311）与 `getAutoModeUnavailableReason`（:1294，settings / circuit-breaker / model 三重闸）；**安全工具白名单**在 [classifierDecision.ts:56-94](../src/utils/permissions/classifierDecision.ts#L56)（`SAFE_YOLO_ALLOWLISTED_TOOLS`）。

---

## 3. 维度一：内置工具分类

全部内置工具在 `getAllBaseTools()`（[tools.ts:193](../src/tools.ts#L193)）中注册，按族划分：

| 族 | 工具 | 安全特征 |
| --- | --- | --- |
| **文件读写** | `FileReadTool` / `FileEditTool` / `FileWriteTool` / `NotebookEditTool` / `GrepTool` / `GlobTool` | 安全策略最重，见 §6 / §7 |
| **命令执行** | `BashTool` / `PowerShellTool` | 已有专文，本文略 |
| **状态/流程/审批门** | `TodoWriteTool`、TaskCreate/Get/List/Update、`EnterPlanModeTool`、`ExitPlanModeV2Tool`、`AskUserQuestionTool` | 多不碰文件系统，`checkPermissions` 直接 `allow` 或恒 `ask` |
| **元工具** | `AgentTool`、`SkillTool` | 能派生子代理 / 执行任意技能，安全最敏感，见 §8 |
| **网络** | `WebFetchTool`、`WebSearchTool` | URL 级 / 服务端，见 §9 |
| **任务/后台** | `TaskOutputTool`、`TaskStopTool` | 后台任务管理，见 §10 |
| **调度** | CronCreate/Delete/List，ScheduleWakeup | feature-gated，见 §10 |
| **通信** | `SendMessageTool`、`PushNotificationTool`、`BriefTool` | 见 §10 |

---

## 4. 维度二：外部 MCP 工具

MCP 工具**不是** `buildTool()` 直接定义的。服务启动时，`fetchToolsForClient`（[client.ts:1743](../src/services/mcp/client.ts#L1743)）把远程服务器 `tools/list` 声明的每个工具包装成一个本地 `Tool`：

- 名字映射为 `mcp__<server>__<tool>`（[mcpStringUtils.ts:19](../src/services/mcp/mcpStringUtils.ts#L19)）
- `mcpInfo: { serverName, toolName }` 记录原始名（[Tool.ts:455](../src/Tool.ts#L455)）
- 只读 / 并发 / 破坏性由服务器的 `annotations`（`readOnlyHint` 等）驱动
- 远程调用时 `tool.call()` → `callMCPTool`（[client.ts:3029](../src/services/mcp/client.ts#L3029)）→ MCP SDK 的 `client.callTool` 把**原始名 + 参数**发给远端

### 4.1 MCP 的权限模型

MCP 工具的 `checkPermissions` 通常只返回 `passthrough`（"我没有工具内部细节，交给通用权限系统"）。真正的授权靠**前缀规则**（[permissions.ts:238](../src/utils/permissions/permissions.ts#L238) `toolMatchesRule`）：

| 规则形态 | 匹配范围 |
| --- | --- |
| `mcp__server__tool` | 精确单个工具 |
| `mcp__server` | 该服务器所有工具 |
| `mcp__server__*` | 通配该服务器工具 |

`passthrough` 在无规则时兜底为 `ask`，所以**陌生的 MCP 工具默认要用户确认**。

---

## 5. 维度三：自定义 / 插件工具

Claude Code 里"自定义工具"有两个含义：

### 5.1 通过 MCP / 插件接入

本质就是外部 MCP 工具，走 §4，受 `mcp__` 前缀规则管理。

### 5.2 通过 SDK 注册

`entrypoints/agentSdkTypes.ts` 里的 `tool()` 只是一个包装：写 `tool('name', 'desc', schema, handler)`，SDK 用它构造一个标准 `Tool`，同样走 `checkPermissions → call` 管线。

**关键安全结论**：自定义工具**没有特权**——它们只是带自定义 `call` + 自定义 `checkPermissions` 的 `Tool`。若不覆写 `checkPermissions`，就默认 `allow`（`TOOL_DEFAULTS`），**完全靠调用方写的 `validateInput` / `call` 自保**。且 SDK 工具的输入参数同样过 Zod safeParse，不能被注入内部字段。

---

## 6. 维度四：只读类工具

只读是**显式声明**的：`isReadOnly: true` 且通常 `isConcurrencySafe: true`（只读命令可并发安全执行）。这一维度对**文件工具**界定最严。

### 6.1 FileReadTool（[FileReadTool.ts:337](../src/tools/FileReadTool/FileReadTool.ts#L337)）

`isReadOnly: true`、`isConcurrencySafe: true`。安全点：

- **设备文件黑名单**（:98）：拒绝 `/dev/zero/random/urandom/tty/...` 等无限输出 / 阻塞路径。
- **双重容量上限**：`maxSizeBytes` 256KB + `maxTokens` 25000，防 OOM / 上下文爆炸。
- 二进制扩展名检查、UNC 路径提前放行（防 NTLM 凭据泄露）。
- **Read 去重**：同路径同区间且 mtime 未变返回 `file_unchanged`，省 token。
- 恶意代码读取附加 `CYBER_RISK_MITIGATION_REMINDER` 提示。

### 6.2 GrepTool / GlobTool

`isReadOnly: true`、`isConcurrencySafe: true`。Grep 自动 `--hidden` + 排除 VCS 目录，`--max-columns 500` 防 base64 刷屏，默认 head_limit 250；Glob 结果上限 100。

### 6.3 交互/流程门（只读但特殊）

- **AskUserQuestionTool**：`isReadOnly: true`，`checkPermissions` **恒 `ask`**。`validateInput` 做 **HTML preview 防 XSS**（[AskUserQuestionTool.tsx:250](../src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx#L250)）——禁止 `<script>/<style>/<html>` 等标签。
- **EnterPlanModeTool**：纯状态机，禁止在 agent 上下文调用。

---

## 7. 维度五：编写类工具

写工具**未覆写** `isReadOnly` / `isConcurrencySafe` → 取缺省 `false/false`（写、不可并发）。文件写工具共享三重防线 + 各自特例。

### 7.1 FileEditTool（[FileEditTool.ts:86](../src/tools/FileEditTool/FileEditTool.ts#L86)）

核心安全三重防线：

1. **必须先 Read**（[FileEditTool.ts:275](../src/tools/FileEditTool/FileEditTool.ts#L275)："Read it first before writing"）。
2. **防陈旧写**：mtime 已变 → 拒绝。
3. **1GiB 巨型文件 OOM 保护**（Edit 专有）。

外加：`checkTeamMemSecrets`（防机密写入团队记忆）、deny 规则预检、BOM 编码检测、`settings.json` 专属校验。

### 7.2 FileWriteTool / NotebookEditTool

同为写、不可并发。Write 无 1GiB 上限但同样强制先 Read + 防陈旧；Notebook 强制 `.ipynb` 扩展名 + 三种模式白名单。

### 7.3 TodoWriteTool / TodoV2（写状态，非文件）

`checkPermissions` 直接 `allow`（"todo operations don't need permission"），只写进程内存 `appState.todos`，不碰文件系统。

---

## 8. 元工具：AgentTool 与 SkillTool

这是唯二能"递归派生计算"的工具，安全设计最为特殊。

### 8.1 AgentTool（[AgentTool.tsx](../src/tools/AgentTool/AgentTool.tsx)）

`isReadOnly: true`（注释直言"委托权限检查给其底层工具"）、`isConcurrencySafe: true`。

**权限模型**：
- `checkPermissions`（:1281-1297）：**仅当 `mode === 'auto'`** 时返回 `{ behavior: 'passthrough', message: 'Agent tool requires permission to spawn sub-agents.' }`（:1287）→ 强制走 auto 分类器。
- **其余所有模式（default/acceptEdits/plan/bypass）默认 `allow`**（:1293）——即默认模式**不需要用户批准即可 spawn 子代理**。
- **关键防线**：permissions.ts:602-603 把 `AGENT_TOOL` 与 `REPL_TOOL` **显式排除在 acceptEdits 快路径之外**，保证子代理 spawn 始终过分类器而非被静默放行。

**call() 的安全隔离**：
1. **agent 选择 + 拒绝规则**（:337-356）：`filterDeniedAgents` 按 `Agent(AgentName)` 权限规则过滤，被 deny 抛明确错误；`allowedAgentTypes` 白名单。
2. **MCP 前置检查**（:367-410）：`requiredMcpServers` 缺失/未连接 → 拒绝 spawn。
3. **远程隔离**（:435-482，ant-only）：`isolation:'remote'` → 到 CCR 远程环境。
4. **worker 工具池与权限隔离**（:568-577）：子代理获得**独立 `workerPermissionContext`，模式默认 `acceptEdits`**，并用 `assembleToolPool` 独立组池——"不受父进程工具限制影响"。
5. **worktree 隔离**（:582-593）：`isolation:'worktree'` → 临时 git worktree。
6. **fork 递归守卫**（:332-334）：fork 子代理内禁止再次 fork。
7. **预算限制**：`max_turns_reached` 终止信号（runAgent.ts:772）。

### 8.2 SkillTool（执行任意技能）

`checkPermissions` 是**完全自定义的规则引擎**，不走文件系统权限：
- deny 规则（精确 + 前缀 `name:*`）→ deny。
- **`skillHasOnlySafeProperties` 安全属性白名单**（[SkillTool.ts:875](../src/tools/SkillTool/SkillTool.ts#L875)）：技能属性全在安全集合内才自动 allow；**新增的任意未知属性默认要求授权**（fail-closed）。
- 默认 `ask`（"Execute skill"）。
- fork 上下文里以独立 sub-agent 运行隔离 token 预算。

---

## 9. 网络 / 外部工具的特殊防护

### 9.1 WebFetchTool（URL 级，最细）

`checkPermissions` 三层判定（[WebFetchTool.ts:104](../src/tools/WebFetchTool/WebFetchTool.ts#L104)）：**预批准主机 → 规则内容级匹配（`domain:<hostname>`）→ 兜底 ask**。

网络层：
- **不自动跟随重定向**（`maxRedirects: 0`），手动判定同源后才递归，最多 10 跳；**跨主机重定向不跟随**，把新 URL 丢回给模型重新授权。
- 域名块名单预检 `api.anthropic.com/api/web/domain_info`。
- 拒绝带用户名/密码的 URL、单段主机名（防内网）。
- 10MB 内容上限、60s 超时、100k markdown 长度截断。
- **关键设计**：预批准主机列表 `PREAPPROVED_HOSTS` 仅用于 GET，sandbox 网络**故意不继承**——含上传能力的站点任意 POST 会数据外泄。

### 9.2 WebSearchTool

`checkPermissions` 返回 `passthrough`——搜索在 **Anthropic 服务端**实现，没有域名级规则，只有整工具级 allow 规则，且受 provider/model 门控。

---

## 10. 任务 / 调度 / 消息工具

### 10.1 TaskStopTool（[TaskStopTool.ts](../src/tools/TaskStopTool/TaskStopTool.ts)）

alias **`'KillShell'`**（:44）；`isConcurrencySafe: true`（:54）。

- **`validateInput`（:60-91）**：task_id 必填；从 `appState.tasks[id]` 查找；**必须存在且 `status === 'running'`**，否则返回错误（含 errorCode 区分）。
- **`call`（:107-130）**：调 `stopTask(id, ...)`（[stopTask.ts](../src/tasks/stopTask.ts)）停止后台任务。
- 位于 auto 安全白名单（classifierDecision.ts:72）。

### 10.2 TaskOutputTool（[TaskOutputTool.tsx](../src/tools/TaskOutputTool/TaskOutputTool.tsx)）

alias **`['AgentOutputTool','BashOutputTool']`**（:150）；`isEnabled()` 仅 external；**`isReadOnly: true`**（:166）。

- **`validateInput`（:183-207）**：task_id 必填且任务必须存在。
- **`call`（:208-282）**：`block`（默认 true）时用 `waitForTaskCompletion` 轮询等待完成（默认 30s，上限 600s）；输出用 XML 标签序列化（:283-308）。
- 标注 **Deprecated**——官方推荐用 Read 读 task 输出文件路径。

### 10.3 TodoWriteTool + TodoV2

- **TodoWriteTool**：`isEnabled = !isTodoV2Enabled()`（:52）；`checkPermissions` 直接 `allow`（:58-61）；call 仅写 `appState.todos[todoKey]`。
- **TodoV2 工具**：`TaskCreateTool`（:80）调 `createTask()`，失败可回滚删除（:110-113，调 `deleteTask`），并跑 TaskCreated hooks；`TaskGetTool` / `TaskListTool` 只读；`TaskUpdateTool` 修改状态。均在安全白名单。

### 10.4 MonitorTool / ScheduleCronTool / SendMessageTool / BriefTool

- **MonitorTool**：本构建中 `export const MonitorTool = null`（stub），由 `feature('MONITOR_TOOL')` 门控。
- **ScheduleCronTool 族**（`CronCreate/Delete/List`）：`feature('AGENT_TRIGGERS')` 门控。**CronCreateTool** `validateInput` 最强：cron 语法校验、`nextCronRunMs` 一年内有效性、`MAX_JOBS` 上限（:98）、teammate 不能建 durable cron（:107）。CronListTool `isReadOnly: true`。
- **SendMessageTool**（[SendMessageTool.ts](../src/tools/SendMessageTool/SendMessageTool.ts)）：**安全最严格的之一**。`checkPermissions`（:585-602）：当 `UDS_INBOX` 且地址 scheme 为 `'bridge'`（跨机器 Remote Control 消息）时返回 **`{behavior:'ask', decisionReason:{type:'safetyCheck', classifierApprovable:false}}`**。注释（:590-597）强调：safetyCheck 在权限上**先于 bypassPermissions 和 auto 白名单/分类器**，**跨机器 prompt injection 必须保持 bypass-immune**。`call`（:741）会**重查 handle**（checkPermissions 可能阻塞数分钟，validateInput 的检查会过期）。
- **PushNotificationTool**：本构建中无实现文件，由 `feature('KAIROS') || feature('KAIROS_PUSH_NOTIFICATION')` 门控。
- **BriefTool**：[BriefTool.ts](../src/tools/BriefTool/BriefTool.ts) `isReadOnly: true`（:157）；`validateInput`（:163-168）校验附件路径；call 发消息给用户，可选附件经 `resolveAttachments` 校验。无 checkPermissions（默认 allow）。

---

## 11. 贯穿性安全结论

1. **所有工具共享一条管线**，安全差异 100% 来自 `checkPermissions` 覆写与否 + `isReadOnly` / `isConcurrencySafe` 是否显式置 true。
2. **写工具铁律** = 必须先 Read + 防陈旧写 + deny 优先 + UNC 提前放行。
3. **深度路径 / 符号链接防御**集中在共享权限层 [filesystem.ts](../src/utils/permissions/filesystem.ts)（对"原路径 + 全部符号链接解析目标"同时判定，`getPathsForPermissionCheck` 遍历 readlink 链），对所有文件工具生效。
4. **元工具靠排除而非放行**：AgentTool 被排除在自动快路径外，SkillTool 用属性白名单 fail-closed。
5. **MCP 外部工具的信任边界是前缀规则 + 兜底 ask**，不信任远端声明的元数据。
6. **safetyCheck 决策是 bypass-immune 的最高级安全机制**（permissions.ts:1255），用于跨机器消息等不可被权限模式绕过的场景。
7. **Auto 模式安全白名单**（classifierDecision.ts:56-94）是多数非敏感工具能高速免分类运行的机制，而 AgentTool / REPLTool 被特意排除——防"元工具静默绕过分类器"。

---

## 12. 关键源码速查

| 机制 | 核心函数 / 常量 | 文件 |
| --- | --- | --- |
| 工具构造 | `buildTool()` / `TOOL_DEFAULTS` | `Tool.ts:783` / `:757` |
| 工具接口 | `Tool` 类型（isReadOnly/isConcurrencySafe） | `Tool.ts:362` |
| 主调用流 | `streamedCheckPermissionsAndCallTool` / `checkPermissionsAndCallTool` | `toolExecution.ts:492` / `:599` |
| 权限骨架 | `hasPermissionsToUseToolInner` | `permissions.ts:1158` |
| 规则检查 | `checkRuleBasedPermissions` | `permissions.ts:1071` |
| Auto 分类器 | `isAutoModeAllowlistedTool` / `SAFE_YOLO_ALLOWLISTED_TOOLS` | `permissions.ts:660` / `classifierDecision.ts:56` |
| MCP 包装 | `fetchToolsForClient` / `mcp__` 前缀 | `client.ts:1743` / `mcpStringUtils.ts:19` |
| MCP 调用 | `callMCPTool` | `client.ts:3029` |
| 前缀规则 | `toolMatchesRule` | `permissions.ts:238` |
| 元工具 | `AgentTool` / `SkillTool` | `AgentTool.tsx` / `SkillTool.ts:875` |
| 只读文件 | `FileReadTool` | `FileReadTool.ts:337` |
| 写文件 | `FileEditTool`（先 Read + 防陈旧 + 1GiB） | `FileEditTool.ts:86` |
| 网络 | `WebFetchTool`（URL 级判定） | `WebFetchTool.ts:104` |
| 后台 | `TaskStopTool` / `TaskOutputTool` | `TaskStopTool.ts:60` / `TaskOutputTool.tsx:208` |
| 消息 | `SendMessageTool`（bridge safetyCheck） | `SendMessageTool.ts:585` |

---

## 附录：与 BashTool / PowerShellTool 的对照

三维框架中，Bash / PowerShell 属于**内置 + 编写（命令执行）+ 深度权限检查**的工具，其安全模型是其他工具的"完整版"参照系：

| 维度 | Bash / PowerShell | 其他大多数工具 |
| --- | --- | --- |
| `checkPermissions` | 覆写为 AST 深度检查（deny>ask>allow） | 默认 `allow` 或轻量覆写（如 AgentTool） |
| 只读声明 | AST + heuristic 动态判定 | 静态 `isReadOnly: true` |
| 沙箱 | macOS/Linux 沙箱 / Windows 整体拒绝 | 无（非 shell 不跑进程） |
| 危险命令检测 | `bashCommandIsSafe` / `powershellCommandIsSafe` | 无（参数即元数据，不执行） |
| 依赖 | tree-sitter / PowerShell parser | 各自 `validateInput` + 通用规则层 |
