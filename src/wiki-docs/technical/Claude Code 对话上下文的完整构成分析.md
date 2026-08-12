## 总体架构

一次 Claude Code 对话中发往模型的 API 请求包含以下顶层结构：

```
API Request
├── system: SystemPrompt (string[])    ← 系统提示词（含 systemContext 追加）
└── tools: ToolSchema[]                ← 工具定义（工具的描述信息）
├── messages: Message[]                ← 消息数组（含 userContext 前置 + 对话历史 + 附件）
```

关键源文件：

- [prompts.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/constants/prompts.ts) — 系统提示词的各个段落构建
- [context.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/context.ts) — `getUserContext()` 和 `getSystemContext()` 的定义
- [claudemd.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/utils/claudemd.ts) — CLAUDE.md 和 rules 文件的加载逻辑
- [api.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/utils/api.ts) — `prependUserContext()` 和 `appendSystemContext()` 的组装
- [QueryEngine.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/QueryEngine.ts) — 整体上下文的组装调度入口
- [attachments.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/utils/attachments.ts) — 每轮动态附件的生成

---

## 一、系统提示词（`system` 参数）

系统提示词是一个 `string[]` 数组，每一项是一个文本块。由 [prompts.ts:444 `getSystemPrompt()`](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/constants/prompts.ts#L444) 构建，然后由 [systemPrompt.ts:41 `buildEffectiveSystemPrompt()`](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/utils/systemPrompt.ts#L41) 处理优先级覆盖，最后由 [api.ts:437 `appendSystemContext()`](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/utils/api.ts#L437) 追加系统上下文。

### 按顺序排列的系统提示词段落：

#### 静态部分（跨会话可缓存，`cacheScope: 'global'`）

| 序号 | 段落                                                                                              | 来源函数           | 文件                                                                                                        | 变化级别                                                                         |
| ---- | ------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1    | **身份介绍 + 安全指令** (`getSimpleIntroSection`)                                        | `prompts.ts:175` | [prompts.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/constants/prompts.ts) | **全局不变**（内容固定，仅输出风格描述有变化）                             |
| 2    | **系统行为规则** (`getSimpleSystemSection`) — 输出格式、工具权限模式、hooks、上下文压缩 | `prompts.ts:186` | [prompts.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/constants/prompts.ts) | **全局不变**                                                               |
| 3    | **做任务的指导** (`getSimpleDoingTasksSection`) — 编码风格、安全、反馈路径              | `prompts.ts:199` | [prompts.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/constants/prompts.ts) | **全局不变**（ant-only 附加条目由构建时 `USER_TYPE` 决定，编译后固定） |
| 4    | **操作审慎性指令** (`getActionsSection`) — 可逆性、破坏性操作确认                       | `prompts.ts:255` | [prompts.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/constants/prompts.ts) | **全局不变**                                                               |
| 5    | **工具使用指导** (`getUsingYourToolsSection`) — 专用工具优先于 Bash、并行调用           | `prompts.ts:269` | [prompts.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/constants/prompts.ts) | **全局不变**（工具名称由编译时 feature flag 决定）                         |
| 6    | **语气和风格** (`getSimpleToneAndStyleSection`) — 不用 emoji、简洁回复                  | `prompts.ts:430` | [prompts.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/constants/prompts.ts) | **全局不变**                                                               |
| 7    | **输出效率** (`getOutputEfficiencySection`) — 精简输出                                  | `prompts.ts:403` | [prompts.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/constants/prompts.ts) | **全局不变**                                                               |

#### 动态边界标记

| 序号 | 内容                                   | 来源               | 变化级别                           |
| ---- | -------------------------------------- | ------------------ | ---------------------------------- |
| 8    | `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` | `prompts.ts:114` | **全局不变**（缓存分界标记） |

#### 动态部分（注册表管理，每轮可能变化）

| 序号 | 段落                                                                                                                                                                 | 来源函数           | 文件                                                                                                          | 变化级别                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 9    | **会话特定指导** (`getSessionSpecificGuidanceSection`) — Agent 工具、Skill 工具、Explore/Plan agent 指导                                                   | `prompts.ts:352` | [prompts.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/constants/prompts.ts)   | **会话级不变**（取决于本次会话启用的工具集） |
| 10   | **记忆机制提示** (`loadMemoryPrompt`) — auto-memory 的文件读写指导                                                                                         | `memdir.ts:419`  | [memdir/memdir.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/memdir/memdir.ts) | **会话级不变**（取决于是否启用 auto-memory） |
| 11   | **Ant 模型覆盖** (`getAntModelOverrideSection`)                                                                                                             | `prompts.ts:136` | [prompts.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/constants/prompts.ts)   | **会话级不变**（ant-only）                   |
| 12   | **环境信息** (`computeSimpleEnvInfo`) — CWD、git 仓库、平台、Shell、OS 版本、模型名称/ID、知识截止日期、最新模型家族、Claude Code 可用平台、Fast mode 说明 | `prompts.ts:651` | [prompts.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/constants/prompts.ts)   | **会话级不变**（启动时确定）                 |
| 13   | **语言偏好** (`getLanguageSection`) — 用户设置的 `language`                                                                                             | `prompts.ts:142` | [prompts.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/constants/prompts.ts)   | **用户级不变**（来自 settings）              |
| 14   | **输出风格** (`getOutputStyleSection`) — 用户选择的 output style                                                                                           | `prompts.ts:151` | [prompts.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/constants/prompts.ts)   | **用户级不变**（来自 settings）              |
| 15   | **MCP 服务器指令** (`getMcpInstructionsSection`) — 各 MCP server 的 instructions 字段                                                                      | `prompts.ts:160` | [prompts.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/constants/prompts.ts)   | **会话级可变**（MCP server 可中途连接/断开） |
| 16   | **Scratchpad 目录** (`getScratchpadInstructions`)                                                                                                           | `prompts.ts:797` | [prompts.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/constants/prompts.ts)   | **会话级不变**                               |
| 17   | **Function Result Clearing** (`getFunctionResultClearingSection`) — 建议模型保存重要信息                                                                   | `prompts.ts:821` | [prompts.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/constants/prompts.ts)   | **会话级不变**                               |
| 18   | **工具结果摘要提醒** (`SUMMARIZE_TOOL_RESULTS_SECTION`)                                                                                                     | `prompts.ts:841` | [prompts.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/constants/prompts.ts)   | **全局不变**                                 |
| 19   | **Token 预算指导** — 当用户指定 token 目标时的指导                                                                                                           | `prompts.ts:538` | [prompts.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/constants/prompts.ts)   | **会话级不变**                               |
| 20   | **Brief 段落** — Kairos 模式下的精简输出指导                                                                                                                 | `prompts.ts:843` | [prompts.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/constants/prompts.ts)   | **会话级不变**（feature-gated）              |

#### 系统提示词末尾追加：systemContext

由 [api.ts:437 `appendSystemContext()`](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/utils/api.ts#L437) 将 `systemContext` 以 `key: value` 格式追加到系统提示词数组末尾：

| 字段             | 内容                                                                                     | 来源                                                                                                                         | 变化级别                                                  |
| ---------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `gitStatus`    | 当前分支、主分支、git 用户、`git status --short`（截断到 2000 字符）、最近 5 条 commit | [context.ts:36 `getGitStatus()`](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/context.ts#L36) | **会话级不变**（会话启动时 snapshot，不随对话更新） |
| `cacheBreaker` | 缓存破坏标记（ant-only 调试用）                                                          | [context.ts:23](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/context.ts#L23)                     | **可变**（调试用）                                  |

#### 追加的系统提示词（如有）

| 来源                   | 条件                                                                         | 变化级别             |
| ---------------------- | ---------------------------------------------------------------------------- | -------------------- |
| `appendSystemPrompt` | SDK 调用者通过`--append-system-prompt` 指定                               | **会话级不变** |
| `customSystemPrompt` | SDK 调用者通过`--system-prompt` 指定（替换整个默认系统提示词）            | **会话级不变** |
| `agentSystemPrompt`  | 使用自定义 Agent 时，Agent 的`getSystemPrompt()` 返回值（替换默认提示词） | **会话级不变** |

---

## 二、工具数组(tools参数)

### 整体构成（请求体中 `tools` 字段）

[claude.ts:1396](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/services/api/claude.ts#L1396)：

```ts
const allTools = [...toolSchemas, ...extraToolSchemas]
```

* `toolSchemas`：把 `filteredTools` 逐个经 [toolToAPISchema](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/utils/api.ts#L119) 转换而来的工具 schema 数组（带缓存标记，[claude.ts:1235](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/services/api/claude.ts#L1235)）。
* `extraToolSchemas`：`options.extraToolSchemas` +（启用时）`advisor` server 工具，追加在 **末尾** （[claude.ts:1385-1395](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/services/api/claude.ts#L1385-L1395)），这样不扰动带缓存前缀的 `toolSchemas`。

### 工具的来源类型（`filteredTools` 是哪种工具的集合）

`filteredTools` 来自调用方传入的 `tools`（类型 `Tools`），它们是最上层工具注册表，典型包括：

| 类别                                     | 说明                                                                                                            | 缓存/处理特征                                                                                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Built-in 工具**                  | Bash/Edit/Read/Glob/Grep/PowerShell/NotebookEdit/WebFetch/WebSearch...（`Tool` 类实现，如 `tools/Bash` 等） | 总是发送（除非是 deferred）                                                                                                                                                          |
| **ToolSearchTool** (延迟工具搜索)  | 动态加载工具的工具                                                                                              | useToolSearch 时总保留，否则被过滤掉                                                                                                                                                 |
| **Resource/MCP 工具**              | `mcp__server__tool`，来自 MCP server 注册                                                                     | `isMcp: true`，动态段，不参与全局缓存 marker（[claude.ts:1210-1214](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/services/api/claude.ts#L1210-L1214)） |
| **defer_loading 延迟工具**         | tool-search 开启时默认不发送、命中了先前的`tool_reference` 才包含                                             | 用`discoveredToolNames` 过滤（[claude.ts:1154-1167](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/services/api/claude.ts#L1154-L1167)）                 |
| **自定义 agent 工具 / skill 工具** | 取决于 querySource/agents                                                                                       | 视 scheme 而定                                                                                                                                                                       |

 **过滤逻辑** （[claude.ts:1152-1172](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/services/api/claude.ts#L1152-L1172)）：

* `useToolSearch = true` 时（动态加载）：只保留非延迟工具 + ToolSearchTool + 已被 `tool_reference` 发现过的延迟工具。
* `useToolSearch = false` 时：只是去掉 ToolSearchTool。

### 单个工具 schema 的字段（`toolToAPISchema`，[api.ts:119-238](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/utils/api.ts#L119-L238)）

每个工具最终是一个 `BetaToolUnion`，核心字段：

```ts
{
  name:         tool.name,                       // 工具名，如 "Bash"
  description:  await tool.prompt({...}),        // 由 tool.prompt() 生成的描述文本
  input_schema: tool.inputJSONSchema ?? zodToJsonSchema(tool.inputSchema),  // JSON Schema 定义输入参数
  strict:       true,               // 可选：结构化输出时添加（feature tengu_tool_pear + tool.strict + 模型支持）
  eager_input_streaming: true,      // 可选：细粒度工具流式(1P + tengu_fgts / env)
  defer_loading: true,              // 可选：tool-search 延迟标记（per-request）
  cache_control: {...},             // 可选：prompt 缓存标记（per-request，type/scope/ttl）
}
```

要点：

* **字段分两批** （[api.ts:140](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/utils/api.ts#L140)）：`name`/`description`/`input_schema`/`strict`/`eager_input_streaming` 是"会话稳定基础"（按 inputJSONSchema 缓存，防止 GrowthBook 翻转或 `tool.prompt()` 漂移导致序列化字节变化、破坏缓存）；`defer_loading`/`cache_control` 是"每请求覆盖层"（每个 turn 可能变化）。
* `description` 来自 `tool.prompt()`， **动态渲染** ——可能包含权限上下文、agent 列表、其它工具列表（例如 ToolSearchTool 的 prompt 会列出**全部** MCP 工具，[claude.ts:1232-1234](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/services/api/claude.ts#L1232-L1234) 注释特别说明这里传的是完整 `tools` 而非 `filteredTools`）。
* `input_schema` 优先用工具的 `inputJSONSchema`（MCP/StructuredOutput），否则把 Zod schema 转 JSON Schema；swarm 字段在未启用时会被过滤（[api.ts:165](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/utils/api.ts#L165)）。

## 三、用户上下文（`userContext`，前置于消息数组）

由 [context.ts:155 `getUserContext()`](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/context.ts#L155) 生成，由 [api.ts:449 `prependUserContext()`](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/utils/api.ts#L449) 包装为一条 `<system-reminder>` 用户消息，**插入到消息数组最前面**（在所有对话消息之前）。

包装格式：

```
<system-reminder>
As you answer the user's questions, you can use the following context:
# claudeMd
{CLAUDE.md 内容}
# currentDate
Today's date is {YYYY-MM-DD}.

      IMPORTANT: this context may or may not be relevant to your tasks...
</system-reminder>
```

### userContext 包含的内容：

| 字段            | 内容                                   | 来源                                                                                                                                                                                                                                                                                   | 变化级别                                        |
| --------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `claudeMd`    | 所有 CLAUDE.md 和 rules 文件的内容拼接 | [claudemd.ts:790 `getMemoryFiles()`](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/utils/claudemd.ts#L790) → [claudemd.ts:1153 `getClaudeMds()`](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/utils/claudemd.ts#L1153) | **会话级不变**（会话启动时 memoize 缓存） |
| `currentDate` | `Today's date is YYYY-MM-DD.`        | [context.ts:186](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/context.ts#L186)                                                                                                                                                                             | **会话级不变**                            |

### CLAUDE.md 文件的加载顺序和来源：

加载顺序在 [claudemd.ts:1-26](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/utils/claudemd.ts#L1) 的注释中说明，**按优先级从低到高**（后加载的优先级更高，模型更关注）：

| 序号 | 类型                   | 文件路径                                                                          | MemoryType  | 变化级别                                               |
| ---- | ---------------------- | --------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------ |
| 1    | **托管内存**     | `/etc/claude-code/CLAUDE.md` + `~/.config/claude/managed_rules/*.md`        | `Managed` | **全局不变**（管理员策略）                       |
| 2    | **用户内存**     | `~/.claude/CLAUDE.md` + `~/.claude/rules/*.md`                              | `User`    | **用户级不变**                                   |
| 3    | **项目内存**     | 从根目录到 CWD 逐层：`CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/*.md` | `Project` | **项目级不变**（git 仓库中提交的文件）           |
| 4    | **本地内存**     | 从根目录到 CWD 逐层：`CLAUDE.local.md`                                          | `Local`   | **用户级不变**（个人私有项目指令，不提交到 git） |
| 5    | **自动记忆入口** | `~/.claude/projects/<project>/memory.md` (MEMORY.md)                           | `AutoMem` | **可变**（跨会话持久化，模型可写入）             |
| 6    | **团队记忆入口** | team memory 入口文件                                                              | `TeamMem` | **可变**（组织级共享同步）                       |

每个文件都支持 `@path` 指令引用其他文件（最多递归 5 层），支持 frontmatter 中的 `paths` 字段做条件匹配（glob 模式），以及 `<!-- -->` HTML 注释会被自动剥离。

`getClaudeMds()` 最终输出格式为：

```
Codebase and user instructions are shown below. Be sure to adhere to these instructions...

Contents of /path/to/file (description):

{content}
```

---

## 三、对话历史消息（`messages` 数组）

在 `userContext` 前置之后，是实际的对话消息。由 [QueryEngine.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/QueryEngine.ts) 管理，[query.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/query.ts) 中的 `queryLoop` 负责每轮迭代。

### 消息类型：

| 消息类型                    | 内容                                           | 来源               | 变化级别             |
| --------------------------- | ---------------------------------------------- | ------------------ | -------------------- |
| **UserMessage**       | 用户输入的文本、图片、@提及的文件内容          | 用户交互           | **每轮新增**   |
| **AssistantMessage**  | 模型的回复（文本 + tool_use 块 + thinking 块） | API 响应           | **每轮新增**   |
| **ToolResultMessage** | 工具执行结果（文件内容、命令输出等）           | 工具执行           | **每轮新增**   |
| **AttachmentMessage** | 系统注入的附件消息                             | `attachments.ts` | **每轮新增**   |
| **SystemMessage**     | 系统通知（压缩边界、错误信息等）               | 系统内部           | **每轮新增**   |
| **CompactMessage**    | 上下文压缩后的摘要                             | 压缩服务           | **触发时新增** |

### 压缩与截断：

当对话接近上下文窗口限制时：

- **自动压缩** (`autoCompact`)：将旧消息总结为一条摘要消息
- **Snip 压缩** (`snipCompact`)：截断历史消息
- **Microcompact**：工具结果级别的细粒度压缩
- 压缩边界之后的历史不再发送给模型

---

## 四、每轮动态附件（`AttachmentMessage`）

由 [attachments.ts:743 `getAttachments()`](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/utils/attachments.ts#L743) 生成，作为 `AttachmentMessage` 插入消息数组。这些是**每轮（每次查询迭代）都会重新计算**的动态上下文：

| 附件类型                     | 触发条件                     | 内容                                                        | 变化级别           |
| ---------------------------- | ---------------------------- | ----------------------------------------------------------- | ------------------ |
| `at_mentioned_files`       | 用户 @提及文件               | 被 @提及的文件内容                                          | **每轮可变** |
| `mcp_resources`            | 用户 @提及 MCP 资源          | MCP 资源内容                                                | **每轮可变** |
| `agent_mentions`           | 用户 @提及 Agent             | Agent 信息                                                  | **每轮可变** |
| `skill_discovery`          | 每轮自动触发                 | 与当前任务相关的 Skill 列表                                 | **每轮可变** |
| `queued_commands`          | 消息队列中有排队命令         | 排队的命令信息                                              | **每轮可变** |
| `date_change`              | 日期跨天                     | 日期变更通知                                                | **罕见变化** |
| `ultrathink_effort`        | 用户输入含 ultrathink 关键词 | 推理努力级别调整                                            | **每轮可变** |
| `deferred_tools_delta`     | 工具延迟加载                 | 可用工具增量                                                | **每轮可变** |
| `agent_listing_delta`      | Agent 列表变化               | 可用 Agent 增量                                             | **每轮可变** |
| `mcp_instructions_delta`   | MCP 指令变化                 | MCP 指令增量                                                | **每轮可变** |
| `changed_files`            | 文件被编辑                   | 已修改文件列表及 diff 摘要                                  | **每轮可变** |
| `nested_memory`            | 操作文件时触发               | 目标文件相关的条件规则（带`paths` frontmatter 的 rules） | **每轮可变** |
| `dynamic_skill`            | 自动触发                     | 动态匹配的 Skill                                            | **每轮可变** |
| `skill_listing`            | 需要列出可用 Skill 时        | Skill 列表                                                  | **每轮可变** |
| `plan_mode`                | 进入/退出 plan mode          | 计划模式状态和计划文件                                      | **会话可变** |
| `todo_reminders`           | 存在未完成 todo/task         | Todo/Task 列表提醒                                          | **每轮可变** |
| `teammate_mailbox`         | Agent Swarm 模式             | 队友发来的消息                                              | **每轮可变** |
| `team_context`             | Agent Swarm 模式             | 团队上下文信息                                              | **每轮可变** |
| `critical_system_reminder` | 特定条件                     | 关键系统提醒                                                | **每轮可变** |
| `compaction_reminder`      | 压缩相关                     | 压缩提醒                                                    | **每轮可变** |
| `context_efficiency`       | History Snip 模式            | 上下文效率信息                                              | **每轮可变** |

---

## 五、完整顺序总结

将以上所有部分按 API 请求中的实际顺序排列：

```
┌─────────────────────────────────────────────────────┐
│ system: SystemPrompt (string[])                      │
│                                                       │
│  ① 身份介绍 + 安全指令          [全局不变]            │
│  ② 系统行为规则                 [全局不变]            │
│  ③ 做任务的指导                 [全局不变]            │
│  ④ 操作审慎性指令               [全局不变]            │
│  ⑤ 工具使用指导                 [全局不变]            │
│  ⑥ 语气和风格                   [全局不变]            │
│  ⑦ 输出效率                     [全局不变]            │
│  ⑧ ── DYNAMIC BOUNDARY ──      [全局不变]            │
│  ⑨ 会话特定指导                 [会话级不变]          │
│  ⑩ 记忆机制提示 (auto-memory)   [会话级不变]          │
│  ⑪ Ant 模型覆盖                [会话级不变]          │
│  ⑫ 环境信息                     [会话级不变]          │
│  ⑬ 语言偏好                     [用户级不变]          │
│  ⑭ 输出风格                     [用户级不变]          │
│  ⑮ MCP 服务器指令               [会话级可变]          │
│  ⑯ Scratchpad 目录              [会话级不变]          │
│  ⑰ Function Result Clearing     [会话级不变]          │
│  ⑱ 工具结果摘要提醒             [全局不变]            │
│  ⑲ Token 预算指导               [会话级不变]          │
│  ⑳ Brief 段落                   [会话级不变]          │
│  ─── systemContext (追加) ───                          │
│  ㉑ gitStatus                   [会话级不变]          │
│  ㉒ cacheBreaker                [可变/调试用]          │
│  ㉓ appendSystemPrompt          [会话级不变]          │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ tools: ToolSchema[]                                   │
│                                                       │
│  每个工具的 JSON Schema 定义                          │
│  (Read, Write, Edit, Bash, Grep, Glob, Agent, ...)   │
│  以及 MCP 工具的 schema                               │
└─────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────┐
│ messages: Message[]                                   │
│                                                       │
│  ─── userContext (前置为 user message) ───             │
│  [0] <system-reminder>                                │
│       # claudeMd                                      │
│         1. Managed: /etc/claude-code/CLAUDE.md  [全局]│
│         2. User: ~/.claude/CLAUDE.md           [用户]│
│         3. Project: CLAUDE.md, .claude/CLAUDE.md     │
│            .claude/rules/*.md                [项目]  │
│         4. Local: CLAUDE.local.md            [用户]  │
│         5. AutoMem: MEMORY.md                [可变]  │
│         6. TeamMem: team memory              [可变]  │
│       # currentDate                                   │
│       Today's date is YYYY-MM-DD.                     │
│     </system-reminder>                                │
│                                                       │
│  ─── 对话历史 ───                                     │
│  [1] UserMessage        (用户第一条输入)               │
│  [2] AttachmentMessage  (附件：文件/技能/提醒等)       │
│  [3] AssistantMessage   (模型回复 + tool_use)          │
│  [4] UserMessage        (tool_result)                 │
│  [5] AssistantMessage   (模型继续回复)                 │
│  ...                                                  │
│  [N] UserMessage        (当前用户输入)                 │
│  [N+1] AttachmentMessage(当前轮附件)                   │
│                                                       │
│  ─── 压缩边界(如有) ───                               │
│  [M] SystemCompactBoundaryMessage                     │
│  [M+1] SummaryMessage   (历史摘要)                    │
│  ...                                                  │
└─────────────────────────────────────────────────────┘
```

---

## 六、变化级别分类总结

| 级别                 | 含义                                                        | 包含的上下文部分                                                       |
| -------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| **全局不变**   | 编译时确定，所有用户/所有会话完全相同                       | 系统提示词 ①-⑧、㉑ 工具结果摘要                                      |
| **用户级不变** | 由用户配置（settings、~/.claude/CLAUDE.md）决定，会话内不变 | ⑬ 语言偏好、⑭ 输出风格、CLAUDE.md 中的 User/Local 类型               |
| **项目级不变** | 由项目代码仓库中的文件决定                                  | CLAUDE.md 中的 Project 类型（git 提交的文件）                          |
| **会话级不变** | 会话启动时确定，整个会话期间不变                            | ⑨-⑫、⑯-⑲、㉑ gitStatus、㉓ appendSystemPrompt                      |
| **会话级可变** | 可在会话中途变化                                            | ⑮ MCP 指令、㉒ cacheBreaker                                           |
| **每轮可变**   | 每次查询迭代都会重新计算                                    | 所有 AttachmentMessage（附件）、对话历史消息、auto-memory/团队记忆内容 |

---

## 七、核心源文件索引

| 文件                                                                                                                          | 职责                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [src/constants/prompts.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/constants/prompts.ts)     | 系统提示词的所有静态和动态段落构建                                               |
| [src/context.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/context.ts)                         | `getUserContext()`（CLAUDE.md + 日期）和 `getSystemContext()`（git status） |
| [src/utils/claudemd.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/utils/claudemd.ts)           | CLAUDE.md、rules、@include 指令的发现与加载                                      |
| [src/utils/systemPrompt.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/utils/systemPrompt.ts)   | 系统提示词的优先级合并（override > agent > custom > default）                    |
| [src/utils/api.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/utils/api.ts)                     | `prependUserContext()`、`appendSystemContext()`、工具 schema 序列化          |
| [src/utils/queryContext.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/utils/queryContext.ts)   | `fetchSystemPromptParts()` 统一获取三部分上下文                               |
| [src/QueryEngine.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/QueryEngine.ts)                 | 查询引擎，组装 systemPrompt + userContext + systemContext + messages             |
| [src/query.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/query.ts)                             | 查询循环，管理消息迭代、压缩、工具执行                                           |
| [src/utils/attachments.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/utils/attachments.ts)     | 每轮动态附件的完整生成逻辑                                                       |
| [src/memdir/memdir.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/memdir/memdir.ts)             | auto-memory 的提示词和 MEMORY.md 索引管理                                        |
| [src/services/api/claude.ts](vscode-webview://0tbdo4dudq5hki050ppt0ep38dhc9r2224i6mlr7lbsflu7qeoij/src/services/api/claude.ts) | 最终 API 请求构建（`buildSystemPromptBlocks`、消息规范化）                     |
