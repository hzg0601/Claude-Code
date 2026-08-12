# Claude Code 记忆系统全链路（类型 · 作用域 · 主体 · 召回 · 注入 · 写入）

> 本文从可运行源码出发，**穷尽** Claude Code 记忆系统的所有细节：记忆的**类型**、**作用域**、**写入主体**、**运行模式**、**写入方式（two-step vs skipIndex）**、**召回方式**、**注入方式与对象**、**存储位置**、**提取原则**、**主要函数/脚本**、**触发条件**、**feature-gated 开关**、**触发频率**。
> 配套：`memory.md`（设计原则/类型/目录/启动判断）、`Claude Code 记忆机制架构分析.md`（读+写全链路时序）。
> 本文末尾附**详细 mermaid 架构图**与**九大维度总表**。

---

## 目录

1. [总览：记忆系统的三大支柱](#1-总览记忆系统的三大支柱)
2. [记忆类型 taxonomy（MEMORY_TYPES）](#2-记忆类型-taxonomymemory_types)
3. [记忆作用域（Scope）三套系统](#3-记忆作用域scope三套系统)
4. [记忆主体（Writers）：谁在写](#4-记忆主体writers谁在写)
5. [运行模式：auto / KAIROS / TEAMMEM](#5-运行模式auto--kairos--teammem)
6. [写入方式：two-step vs skipIndex](#6-写入方式two-step-vs-skipindex)
7. [提示词构建：buildMemoryLines / buildMemoryPrompt / loadMemoryPrompt](#7-提示词构建buildmemorylines--buildmemoryprompt--loadmemoryprompt)
8. [召回机制：scanMemoryFiles → Sonnet sideQuery → 注入](#8-召回机制scanmemoryfiles--sonnet-sidequery--注入)
9. [注入方式与对象](#9-注入方式与对象)
10. [存储位置汇总](#10-存储位置汇总)
11. [提取原则（什么该记 / 什么不该记）](#11-提取原则什么该记--什么不该记)
12. [feature-gated 开关总表](#12-feature-gated-开关总表)
13. [触发条件与频率专项](#13-触发条件与频率专项)
14. [九大维度总表](#14-九大维度总表)
15. [详细 mermaid 架构图](#15-详细-mermaid-架构图)

---

## 1. 总览：记忆系统的三大支柱

Claude Code 的记忆不是单一存储，而是三套**并行、隔离**的系统：

```
┌──────────────────────────────────────────────────────────────────────┐
│  A. 静态记忆层（CLAUDE.md / CLAUDE.rules / --append-system-prompt）      │
│     无条件、全 token 进入 system 提示词——不是"记忆"但常被误认            │
├──────────────────────────────────────────────────────────────────────┤
│  B. 自动记忆层（auto memory）——本文主题                                  │
│     storage:  ~/.claude/projects/{hash}/memory/*.md                   │
│     索引(MEMORY.md)    → 同步进 system 提示词                          │
│     正文(主题文件)      → 异步召回注入 messages 的 <system-reminder>     │
│     写入(主体)          → 主 agent / extractMemories / autoDream       │
├──────────────────────────────────────────────────────────────────────┤
│  C. 子 Agent 记忆层（agent memory scope: user|project|local）           │
│     storage:  agent-memory/… 与 agent-memory-local/…                  │
│     通过 AgentTool 的 AgentMemoryScope 隔离，注入子 agent 的 system     │
└──────────────────────────────────────────────────────────────────────┘
```

**三大支柱一句话**：`B`（自动记忆）是默认的持久记忆；`C`（子 agent 记忆）是多 agent 场景下的隔离记忆；`A`（静态层）是项目规则。另有 **TEAMMEM**（团队记忆）把 `B` 升级为仓库级共享存储，以及 **KAIROS**（常驻模式）把 `B` 换成 append-only 日志范式。

---

## 2. 记忆类型 taxonomy（MEMORY_TYPES）

类型枚举定义在 `src/memdir/memoryTypes.ts`：

```ts
MEMORY_TYPES = ['user', 'feedback', 'project', 'reference']
```

每条记忆是一个**带 frontmatter 的 Markdown 文件**。frontmatter 格式（`MEMORY_FRONTMATTER_EXAMPLE`）：

```
---
name: <short-kebab-case-slug>
description: <one-line summary — used to decide relevance during recall>
metadata:
  type: <user|feedback|project|reference>
---
<正文>
```

| 类型 | 用途 | 特殊要求 |
|---|---|---|
| **user** | 用户画像：身份、偏好、领域、背景 | 无 |
| **feedback** | 用户对 Agent 行为的反馈（正/负向） | 必须含 **Why** 和 **How to apply** 两节 |
| **project** | 项目目标、进展、决策、约束 | 相对日期 → **绝对日期** 转换 |
| **reference** | 外部系统位置（URL、dashboards、tickets） | 无 |

**两条提示词变体**（memoryTypes.ts）：
- `TYPES_SECTION_INDIVIDUAL`：单机/auto 模式使用，无 `<scope>` 标签。
- `TYPES_SECTION_COMBINED`：TEAMMEM 团队模式使用，每个 `<type>` 块内嵌 `<scope>` 指引（private 偏向 / team 偏向），其中 **user 始终 private**，**feedback 偏向 private**，**project/reference 偏向 team**。

记忆正文与索引分离：**`MEMORY.md` 是索引而非正文**，正文存放于各类型主题文件（topic files）。

---

## 3. 记忆作用域（Scope）三套系统

作用域是"记忆属于谁、被谁看到"的隔离单位，共有三套互相独立的机制：

### 3.1 自动记忆作用域（主会话）

- 按 **project hash 隔离**：`~/.claude/projects/{sanitized-project-root-hash}/memory/`
- 路径计算：`getAutoMemPath()`（`src/memdir/paths.ts`）
- 优先级：`CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` env → `settings.json` 的 `autoMemoryDirectory` → 默认 `.claude/projects` 下的记忆目录
- 同一仓库的 git worktree **共享**一个记忆目录

### 3.2 子 Agent 记忆作用域（AgentTool）

定义于 `src/tools/AgentTool/agentMemory.ts`：`AgentMemoryScope = 'user' | 'project' | 'local'`。

| Scope | 目录 | 语义 |
|---|---|---|
| **user** | `{base}/agent-memory/user/{type}/` | 全局 Agent 知识，跨所有项目共享 |
| **project** | `<cwd>/.claude/agent-memory/{type}/` | 项目特定知识，随仓库走、**可提交进 git** |
| **local** | `<cwd>/.claude/agent-memory-local/{type}/` | 本机+本 session，**不入 git** |

- `getLocalAgentMemoryDir`（agentMemory.ts:29-44）：支持 `CLAUDE_CODE_REMOTE_MEMORY_DIR` 重定向，否则 `<cwd>/.claude/agent-memory-local/<agentType>/`。
- scopeNote（agentMemory.ts:144-155）：
  - user：「global to all projects…boldly canonicalize」
  - project：「stored in .claude/agent-memory/…checked into version control」
  - **local**：「not checked into version control…tailor to this project and machine」（任何**不适合进 git、只对当前开发者在当前机器有效**的项目记忆）
- 配套函数：`isAgentMemoryPath`（防越界写入校验）、`loadAgentMemoryPrompt`（把对应 scope 指令注入该 agent 的 system，走 `buildMemoryPrompt` 家族）。

### 3.3 团队记忆作用域（TEAMMEM）

- 按 **repo 隔离**（不是按机器）：`~/.claude/projects/{hash}/memory/team/`
- `getTeamMemPath()` = `join(getAutoMemPath(), 'team')`（teamMemPaths.ts:84）
- 远端：`GET/PUT /api/claude_code/team_memory?repo=<repo>`
- 一致性：per-key SHA-256 校验和 + HTTP ETag/304（本地没变不重复下载）；冲突返回 **412** 走合并逻辑
- `isTeamMemoryEnabled()`（teamMemPaths.ts:73）：需要 `isAutoMemoryEnabled()` 且 `tengu_herring_clock` 为真。

---

## 4. 记忆主体（Writers）：谁在写

记忆可以被六个主体写入，它们**互补而非替代**：

| 主体 | 触发点 | 本质 |
|---|---|---|
| **主 agent** | 收到用户 `/remember` 或用户明确要求记住时 | system 提示词中的记忆指令指导它直接 `Write` 主题文件 + 更新 MEMORY.md |
| **extractMemories**（后台提取） | stop hook（自然回合结束） | turn-end 增量提取：把该回合新信息 fork 出子模型挑选、写回 |
| **autoDream**（后台整合） | stop hook（自然回合结束） | 低频跨会话整合：consolidate 分散记忆成精炼主题文件（**dream 命令**） |
| **/remember skill** | 用户主动 `/remember` | ant-only（`USER_TYPE !== 'ant'` 时 no-op）；是记忆**审查/迁移入 CLAUDE.md** 工具，不是 writer |
| **/dream skill**（KAIROS） | 定时/手动 | 对 append-only 日志**蒸馏**成主题记忆（本快照为 feature-gated 空壳） |
| **sessionMemory** | post-sampling hook | **会话记忆快照**（供 compaction 用），与面向用户的持久记忆语义不同 |

**关键区分**：
- `extractMemories`（提取新信息）与 `autoDream`（整合既有记忆）是**配合关系**：前者把点滴信息写新文件，后者定期把它们合并去重。二者都复用 `runForkedAgent`，但**互不调用、互不感知**（无直接耦合），共享 `createAutoMemCanUseTool`。
- `/remember`（本快照）**不写持久记忆文件**，而是引导用户把重要约定**迁移进 CLAUDE.md**（审查 + promote）。
- `sessionMemory` 虽写 "memory" 文件，但语义是**会话/压缩上下文**，服务 compaction，与面向用户的持久记忆（extract/autoDream 写 memdir）不同。

---

## 5. 运行模式：auto / KAIROS / TEAMMEM

记忆系统有四种运行模式，由 `loadMemoryPrompt`（memdir.ts:419）按优先级分派：

```
loadMemoryPrompt()
 ├─ KAIROS && autoEnabled && getKairosActive()
 │    → buildAssistantDailyLogPrompt(skipIndex)    # ① 常驻日志模式（优先级最高）
 ├─ TEAMMEM && isTeamMemoryEnabled()
 │    → teamMemPrompts.buildCombinedMemoryPrompt() # ② 团队记忆合成
 ├─ autoEnabled
 │    → buildMemoryLines('auto memory', …)         # ③ 单机自动记忆（默认）
 └─ 否则 → logEvent('tengu_memdir_disabled') + 返回 null  # ④ 禁用
```

### 5.1 auto（默认，单机自动记忆）

- 目录：`~/.claude/projects/{hash}/memory/`
- 索引（MEMORY.md）进 system；正文按需召回进 messages
- 写入：主 agent（mixed）+ extractMemories（two-step）+ autoDream（维护索引）

### 5.2 KAIROS（常驻/assistant 模式）

- 前置：`feature('KAIROS')` 且 `getKairosActive()` 为真。
- 会话是**永久（perpetual）**的，因此 agent 把新记忆以 **append-only 方式追加到日期命名的日志文件**，而非维护 MEMORY.md 实时索引：

```
${memoryDir}/logs/YYYY/MM/YYYY-MM-DD.md
```

- 日志是 append-only：每条为短时间戳子弹；跨午夜滚动到新日期文件；不重写不重组。
- **MEMORY.md 仍被加载**（已蒸馏的索引），但 agent **不直接编辑它**（"do not edit it directly — record new information in today's log instead"）。
- 一台 **nightly /dream skill** 把日志蒸馏成主题文件 + MEMORY.md。
- `skipIndex=true` 时日志模式也不输出 MEMORY.md 相关章节（KAIROS 本来就是 skipIndex）。
- **提示词缓存**：日志路径写成模式 `YYYY/MM/YYYY-MM-DD.md` 而非今天的字面路径，因为该段被 `systemPromptSection('memory')` 缓存、日期变化时不失效；模型从 `date_change` 附件（午夜翻转时附加在尾部）而非 user-context 消息推导当前日期——后者被刻意保持陈旧以在午夜保留 prompt cache 前缀。

### 5.3 TEAMMEM（团队记忆）

- 前置：`feature('TEAMMEM')` 且 `isTeamMemoryEnabled()`（需 `tengu_herring_clock`，且 auto memory 开）。
- 双目录并存：`autoDir`（private）+ `teamDir`（team，= autoDir/team）。
- `buildCombinedMemoryPrompt` 把两目录合成一段 system 提示词，含 `<scope>` 指引 + "private / team" 双 MEMORY.md 索引。
- 本地写 + push 同步（ETag/校验和/412 合并）。
- **与 KAIROS 互斥**：append-only 日志范式与共享 MEMORY.md 读写模型冲突。

### 5.4 四模式优先级与互斥

```
KAIROS 常驻日志   ⊥  TEAMMEM 团队共享      （数据源范式冲突，互斥）
auto 单机         ⊆ 其 上可叠加 TEAMMEM     （团队是 auto 的超集）
禁用 env/setting → 全部关闭（tengu_memdir_disabled）
```

---

## 6. 写入方式：two-step vs skipIndex

是否维护 MEMORY.md 索引，由 **`tengu_moth_copse`** 开关（默认 `false`）决定：

### 6.1 two-step（默认，非 skipIndex）

两步写入（buildMemoryLines 的 howToSave）：
- **Step 1**：把记忆写成本身的文件（带 frontmatter：name/description/type）。
- **Step 2**：在该目录的 `MEMORY.md` 加一行指针 `- [Title](file.md) — one-line hook`（每行 <150 字符，无 frontmatter，正文绝不写入索引）。

这也正是主 agent / extractMemories / autoDream 默认采纳的模式。

### 6.2 skipIndex（KAIROS / `tengu_moth_copse`=true）

- 只写记忆文件，**不维护 MEMORY.md**。
- 常与 KAIROS 日志模式配合：只追加日期命名的日志文件，索引由夜间 /dream 蒸馏维护。

### 6.3 索引体积治理（truncateEntrypointContent，memdir.ts:57）

- `MAX_ENTRYPOINT_LINES = 200`、`MAX_ENTRYPOINT_BYTES = 25_000`。
- 超限截断并追加**诊断+修复指引**：`"...Keep index entries to one line under ~200 chars; move detail into topic files."` —— 警告不只是报问题，还**教模型如何修复**。
- 多个构建器（buildMemoryLines / buildMemoryPrompt / buildCombinedMemoryPrompt / buildAssistantDailyLogPrompt）都会用 `truncateEntrypointContent` 对 MEMORY.md 内容做截断。

---

## 7. 提示词构建：buildMemoryLines / buildMemoryPrompt / loadMemoryPrompt

记忆系统提示词分三层构建函数：

### 7.1 `buildMemoryLines`（memdir.ts:199，核心指令模板）

产物是一段**指令文案**（不含 MEMORY.md 正文），按序拼接：

```
# {displayName}
You have a persistent, file-based memory system at `{memoryDir}`…（DIR_EXISTS_GUIDANCE）
You should build up this memory system over time…
If the user explicitly asks you to remember…/forget…
[TYPES_SECTION_INDIVIDUAL]                       <- 四种类型，无 <scope>
[WHAT_NOT_TO_SAVE_SECTION]                       <- 明确排除
[howToSave]                                      <- 取决于 skipIndex：two-step vs skipIndex
[WHEN_TO_ACCESS_SECTION + MEMORY_DRIFT_CAVEAT]   <- 何时访问
[TRUSTING_RECALL_SECTION]                        <- "Before recommending…" 验证章节
## Memory and other forms of persistence
- 何时用 plan 而不是 memory
- 何时用 tasks 而不是 memory
[extraGuidelines ?? []]                          <- Cowork env 注入
[buildSearchingPastContextSection(memoryDir)]    <- 搜索历史上下文指引（tengu_coral_fern）
```

### 7.2 `buildMemoryPrompt`（memdir.ts:272，子 agent 版）

在 `buildMemoryLines` 的指令段后 **push 一段 `## MEMORY.md`**，把索引全文灌进提示词。它服务的"读者"是**子 agent**——子 agent **没有主会话的 `getClaudeMds()` 索引加载链路**，所以必须在此显式载入索引：
1. 该记忆目录的完整可用索引（t.content）。
2. 截断后的边界感知（经 `truncateEntrypointContent`，基于真实字节/行数给出 `was_line4truncated` 精确诊断）。
3. telemetry：`logMemoryDirCounts` 埋 `tengu_memdir_loaded`。

### 7.3 `loadMemoryPrompt`（memdir.ts:419，主会话统一分派器）

见 §5。额外职责：`ensureMemoryDirExists` 保证目录存在、`logMemoryDirCounts` 遥测、`teamMemPaths`/`teamMemPrompts` 条件 require、Cowork env 策略注入、禁用时返回 null 使 memory 段整体消失。

---

## 8. 召回机制：scanMemoryFiles → Sonnet sideQuery → 注入

> 核心：召回**不是向量检索**，而是**Sonnet 侧查询（sideQuery）**——拿用户 query + 记忆清单（只看 frontmatter 的 description）去问一个独立模型"挑哪些最相关"。

### 8.1 全链路

```
用户 Query（回合开始）
  └─ startRelevantMemoryPrefetch()（utils/attachments.ts:2361，异步 fire-and-forget）
       ├─ 门控：isAutoMemoryEnabled() && feature('tengu_moth_copse')   <- 默认关
       ├─ 取最后一条真实 user prompt（跳过 isMeta）；单次词条太短则放弃
       ├─ 会话累计字节 >= MAX_SESSION_BYTES 则放弃
       ├─ createChildAbortController（用户 Esc 立即取消）
       └─ getRelevantMemoryAttachments(...)（不 await）
            ├─ @agent 提及 → 只搜该 agent 记忆目录（隔离）；否则搜 auto mem 目录
            ├─ findRelevantMemories(query, dir, signal, recentTools, alreadySurfaced)
            │    ├─ scanMemoryFiles() → MemoryHeader 清单（读 frontmatter）
            │    ├─ 过滤 alreadySurfaced（不重复挑已示过的）
            │    ├─ selectRelevantMemories() → Sonnet sideQuery 挑 5 槽
            │    └─ 命中 → 返回 {path, mtimeMs}
            ├─ 过滤 readFileState（主模型 FileRead 过的） + alreadySurfaced，slice(0,5)
            └─ readMemoriesForSurfacing()（截断读正文）
  └─ 返回 MemoryPrefetch 句柄 {promise, settledAt, consumedOnIteration, [Symbol.dispose]}

主循环逐轮迭代
  └─ 消费点 query.ts:1600
       if (settledAt !== null && consumedOnIteration === -1):
           await promise -> 过滤重复 -> relevant_memories 附件 yield 给后续轮次
           consumedOnIteration = turnCount - 1

若主回合先结束
  └─ [Symbol.dispose] -> controller.abort() 掐掉 sideQuery + 遥测弃置
```

### 8.2 `scanMemoryFiles`（memoryScan.ts:35）

- 读 `readdir` → 只收 `.md` / 排除 `MEMORY.md`。
- 每文件只读**前 30 行** frontmatter（`FRONTMATTER_MAX_LINES`）→ `MemoryHeader { filename, filePath, mtimeMs, description, type }`。
- 按 mtime 新→旧排序，上限 `MAX_MEMORY_FILES = 200`。

### 8.3 `selectRelevantMemories`（findRelevantMemories.ts:77）——Sonnet 侧查询

```ts
const result = await sideQuery({
  model: getDefaultSonnetModel(),                    // 固定默认 Sonnet（可被 ANTHROPIC_DEFAULT_SONNET_MODEL 覆盖）
  system: SELECT_MEMORIES_SYSTEM_PROMPT,
  skipSystemPromptPrefix: true,
  messages: [{ role: 'user', content: `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}` }],
  max_tokens: 256,
  output_format: { type: 'json_schema', schema: { properties: { selected_memories: { type:'array', items:{type:'string'} } }, required:['selected_memories'] } },
  querySource: 'memdir_relevance',
})
```

`SELECT_MEMORIES_SYSTEM_PROMPT` 原文要点：
- 返回**最多 5 个**文件名；**只挑确信有帮助的**（"Be selective and discerning"）。
- 不确定就不选；没有明确有用的就返回空表。
- 若提供 `recentTools`：**不要选**这些工具的使用参考/API 文档类记忆（CC 正在用它们，报警告/gotcha/已知问题类则**要选**——正在用正是它们要紧的时候）。

> **重要模型差异**：召回固定用**默认 Sonnet**（`getDefaultSonnetModel`），而不是主会话当前模型。这与 extractMemories / autoDream（用主会话当前模型以命中 prompt cache）不同。

### 8.4 `readMemoriesForSurfacing`（attachments.ts:2279）——截断读正文

- `MAX_MEMORY_LINES = 200`、`MAX_MEMORY_BYTES = 4096`（每文件）。
- 经 `readFileInRange`（`truncateOnByteLimit: true`）；截断则追加 `"> This memory file was truncated (…). Use the {FILE_READ_TOOL} tool to view the complete file at: {path}"` 提示。
- 预计算 `header`（`memoryHeader` → `memoryFreshnessText`/`memoryAge` 的"保存于 N 天前"字符串），**避免每次 Date.now() 字节变化击穿 prompt cache**。

### 8.5 三道总量闸控

`alreadySurfaced` 去重 + `readFileState`（主模型 FileRead 过的不再注入）+ 会话累计字节 `MAX_SESSION_BYTES`，避免记忆附件无限膨胀。

---

## 9. 注入方式与对象

记忆进入 API 请求体的**两条路径**：

### 9.1 索引 → system（同步、无条件）

- MEMORY.md 索引经 `loadMemoryPrompt` → `buildMemoryLines`/`buildCombinedMemoryPrompt` 进入 **system** 提示词。
- 主会话还通过 **`getClaudeMds()`**（claudemd.ts）与 CLAUDE.md 同批次加载 MEMORY.md——**模型第一个回合就知道有哪些记忆**。

### 9.2 正文 → messages（异步、按需、`<system-reminder>`）

- 召回命中的正文，经 `createAttachmentMessage` 渲染为 `<system-reminder>` 附件，**注入最新一条 user message**。
- 附件类型：`{ type: 'relevant_memories', memories: [{ path, content, mtimeMs, header, limit? }] }`。
- `normalizeMessagesForAPI`（claude.ts:1266）+ `addCacheBreakpoints`（claude.ts:3063）处理，最终进请求体的 `messages` 数组。

### 9.3 注入对象矩阵

| 注入对象 | 内容 | 机制 |
|---|---|---|
| 主会话 system | MEMORY.md 索引 | `loadMemoryPrompt` + `getClaudeMds` |
| 主会话 user message | 召回正文 | `relevant_memories` `<system-reminder>` 附件 |
| 子 agent system | MEMORY.md 索引全文 | `loadAgentMemoryPrompt` → `buildMemoryPrompt` |
| @agent 提及的子 agent | 该 agent 记忆目录召回 | `getRelevantMemoryAttachments` 定向搜索 |

---

## 10. 存储位置汇总

| 系统 | 路径 | 内容 |
|---|---|---|
| 自动记忆 auto | `~/.claude/projects/{hash}/memory/` | user/feedback/project/reference 主题文件 + `MEMORY.md` 索引 |
| 团队记忆 team | `…/memory/team/` | 与 auto 同构，含 `team/MEMORY.md` 索引 |
| KAIROS 日志 | `…/memory/logs/YYYY/MM/YYYY-MM-DD.md` | append-only 每日日志 |
| 子 agent user | `{base}/agent-memory/user/{type}/` | 全局 Agent 知识 |
| 子 agent project | `<cwd>/.claude/agent-memory/{type}/` | 项目知识（可提交 git） |
| 子 agent local | `<cwd>/.claude/agent-memory-local/{type}/` | 本机+项目专属（不入库） |
| autoDream 锁 | `…/memory/.consolidate-lock` | mtime=lastConsolidatedAt 的整合锁 |
| 会话记忆 | （sessionMemory 专属） | 供 compaction 的快照（非持久用户记忆） |

**记忆目录启动判断链**（`src/memdir/paths.ts:isAutoMemoryEnabled`）：

```
CLAUDE_CODE_DISABLE_AUTO_MEMORY env   → 禁用
--bare 启动标识                        → 禁用
远程模式(getIsRemoteMode)              → 禁用
settings.json 的 autoMemoryEnable      → 按配置（默认 true）
默认                                  → 启用
```

---

## 11. 提取原则（什么该记 / 什么不该记）

### 11.1 决策树（memory.md + memoryTypes.ts WHAT_NOT_TO_SAVE_SECTION）

```
获取到一条信息
 ├─ Q1 能从代码 / Git / 文档直接读到？─是→ 不保存
 ├─ Q2 已在 CLAUDE.md？─是→ 不保存
 └─ Q3 属于哪一类？
     ├─ 用户身份/偏好      → user.md
     ├─ 行为纠正/肯定      → feedback.md（必须 Why + How to apply）
     ├─ 项目动态/决策       → project.md（相对日期→绝对日期）
     ├─ 外部系统位置        → reference.md
     └─ 都不是            → 不保存
```

### 11.2 明确排除（WHAT_NOT_TO_SAVE_SECTION）

1. 代码模式、约定、架构、文件路径、项目结构。
2. git 信息（历史、改动、改动人）。
3. 调试方案或修复记录。
4. 已写在 CLAUDE.md 的内容。
5. 临时任务细节（进行中细项、临时状态、当前对话上下文）。

### 11.3 召回信任原则（TRUSTING_RECALL_SECTION）

记忆认为存在 ≠ 真的存在；记忆提到的文件/函数/路径**必须验证**。

### 11.4 记忆新鲜度（memoryAge.ts）

- `memoryAgeDays` / `memoryAge`（today/yesterday/N days ago）/ `memoryFreshnessText` / `memoryFreshnessNote`。
- 记忆 >1 天自动注入陈旧警告：`"Memories are point-in-time observations, not live state — claims about code behavior or file:line citations may be outdated."`
- 新鲜度拼进侧查询清单，让 Sonnet 挑选时对旧记忆降权。

### 11.5 与其他持久化机制的边界

- **plan**：实施前对齐方案（跨轮次用 plan，不是 memory）。
- **tasks**：当前会话内步骤追踪（用 tasks，不用 memory）。
- **memory**：未来会话才有用的信息。

---

## 12. feature-gated 开关总表

| 开关 | 默认 | 作用 |
|---|---|---|
| `autoMemoryEnable`（settings）/ `CLAUDE_CODE_DISABLE_AUTO_MEMORY`（env） | 开 / 无 | 自动记忆总开关 |
| `tengu_passport_quail`（GB） | **false** | `EXTRACT_MEMORIES` 后台提取门控 |
| `tengu_bramble_lintel`（GB） | 1 | extract 节流：每 N 个合格回合一次 |
| `tengu_moth_copse`（GB） | **false** | skipIndex 模式 + 召回预取门控 |
| `tengu_herring_clock`（GB） | false | 团队记忆总开关 |
| `tengu_onyx_plover`（GB） | enabled=false | autoDream 开关（settings `autoDreamEnabled` 未设时） |
| `autoDreamEnabled`（settings） | optional（无默认） | autoDream 显式开关 |
| `KAIROS` / `KAIROS_DREAM`（feature） | 关 | KAIROS 常驻模式 + nightly /dream skill |
| `TEAMMEM`（feature） | 关 | 团队记忆代码路径 |
| `EXTRACT_MEMORIES`（feature） | 关 | conditional require extractMemories |
| `MEMORY_SHAPE_TELEMETRY`（feature） | 关 | 召回形状遥测 |
| `tengu_coral_fern`（GB） | false | "Searching past context" 段 |
| `ANTHROPIC_DEFAULT_SONNET_MODEL`（env） | 无 | 覆盖召回侧 Sonnet 模型 |

> **潜台词**：本快照（外部用户视角，无远端 GrowthBook payload）默认只有：auto memory 开、`tengu_moth_copse` 关 → 即 **two-step 双步骤 + 召回预取门控关闭**。但**注意漂移**：`tengu_moth_copse` 默认值决定 skipIndex 与预取，需以当前 GB 配置为准。

---

## 13. 触发条件与频率专项

### 13.1 extractMemories（后台提取）

**入口**：`stopHooks.ts:149` `executeExtractMemories(context, appendSystemMessage)`（自然回合结束）。

**门控（executeExtractMemoriesImpl）**：
1. `toolUseContext.agentId` 存在 → **跳过**（仅主 agent）。
2. `feature('EXTRACT_MEMORIES')` + GB `tengu_passport_quail` 关闭 → 跳过（ant 记 `tengu_extract_memories_gate_disabled`）。
3. `!isAutoMemoryEnabled()` → 跳过。
4. `getIsRemoteMode()` → 跳过。
5. `inProgress`（已有一次在跑）→ 不并行：context stash 进 `pendingContext`，等当前跑完做一次 **trailing run**（合并）。
6. 通过 → `runExtraction()`。

**频率（名义每回合，实际被多重闸控）**：
- **节流闸** `tengu_bramble_lintel`（默认 1）：`turnsSinceLastExtraction++`，达到阈值才真跑；**trailing run 跳过此闸**。
- **游标增量** `lastMemoryMessageUuid`：每次只处理游标后的新消息（`countModelVisibleMessagesSince`）。
- **主 agent 已写则跳过** `hasMemoryWritesSince`：检测到主 agent 在游标后写过 memory 文件 → 跳过并推进游标到末尾（`tengu_extract_memories_skipped_direct_write`），不重复提取。
- **单线程互斥 + trailing 合并**：`inProgress` 保证唯一运行；期间来的调用合并成 trailing run。
- 异步：`void` fire-and-forget；`drainPendingExtraction`（60s）退出时收口。

**实现（runExtraction → runForkedAgent）**：
1. 预注入记忆清单：`formatMemoryManifest(await scanMemoryFiles(dir))`。
2. 构建提示词：`buildExtractAutoOnlyPrompt` / `buildExtractCombinedPrompt(newMessageCount, existingMemories, skipIndex)`。
3. `runForkedAgent`：隔离 context + 复用主会话 cache-safe params + `maxTurns:5` + `skipTranscript:true` + `createAutoMemCanUseTool`（限权记忆目录）。
4. 成功才推进游标；出错游标不动、下次重试。
5. `extractWrittenPaths` → 过滤掉 MEMORY.md（`basename !== 'MEMORY.md'`）得"真正记忆" → 写记忆则 `createMemorySavedMessage` 通知主会话 + 遥测。
6. best-effort：catch 只记日志。

### 13.2 autoDream（dream 命令 / 后台整合）

**入口**：`stopHooks.ts:154-156` `executeAutoDream(context, appendSystemMessage)`（自然回合结束）；`runner` 由 `initAutoDream`（utils/backgroundHousekeeping.ts:37）注入。

**多级门控（runAutoDream，autoDream.ts:125-198，先便宜后贵）**：
```
isGateOpen()
 ├─ getKairosActive() → false
 ├─ getIsRemoteMode() → false
 ├─ isAutoMemoryEnabled() → false
 └─ isAutoDreamEnabled()   # settings autoDreamEnabled ?? tengu_onyx_plover.enabled===true（默认 false）
readLastConsolidatedAt()            # ② 时间闸：距上次整合 >= minHours(默认24)
scan throttle                       # ③ 扫描节流：SESSION_SCAN_INTERVAL_MS=10min
listSessionsTouchedSince()          # ④ 会话闸：>= minSessions(默认5)，排除当前会话
tryAcquireConsolidationLock()       # ⑤ 单锁：防多进程（拿不到→跳过）
```

**实现**：`buildConsolidationPrompt` → `runForkedAgent`（cache-safe params、`createAutoMemCanUseTool`、`querySource:'auto_dream'`、`skipTranscript:true`、bg-task UI + kill + 锁回滚 `rollbackConsolidationLock(priorMtime)`）。

**默认模型**：无固定默认——通过 `createCacheSafeParams` 只透传参数、不传 model override，因此**用主会话当前模型**（命中 prompt cache）。修复/完成用 `failDreamTask`/`completeDreamTask` + `createMemorySavedMessage`（"Improved N files"）。

**频率**：默认关闭；开启后受 24h + 5 会话 + 单锁三重门槛，扫描节流 10min。

### 13.3 promptSuggestion（对照）

单次生成预测下一条输入，**不走 runForkedAgent/query**。

### 13.4 sessionMemory

post-sampling hook；token 阈值驱动（`minimumMessageTokensToInit` + `minimumTokensBetweenUpdate` + `toolCallsBetweenUpdates`）。

### 13.5 频率对照总表

见 §14 表格。

---

## 14. 九大维度总表

### 14.1 写入主体对照

| 维度 | 主 agent | extractMemories | autoDream | /remember | /dream(KAIROS) | sessionMemory |
|---|---|---|---|---|---|---|
| 触发 | /remember 或用户要求 | stop hook | stop hook | 用户 `/remember` | 定时/手动 | post-sampling hook |
| 本质 | 直接写 | 增量提取 | 低频整合 | 审查+迁移进 CLAUDE.md | 日志蒸馏 | 会话快照 |
| 模式 | two-step/skipIndex | two-step（skipIndex 从 moth_copse） | two-step（维护索引） | 不写持久记忆 | skipIndex 日志蒸馏 | 专属文件 |
| 目标目录 | memdir | memdir | memdir | 升级 CLAUDE.md | logs → 主题文件 | session 专属 |
| 模型 | 主会话 | 主会话（cache hit） | 主会话（cache hit） | — | — | — |
| 工具权限 | 正常 | createAutoMemCanUseTool | createAutoMemCanUseTool | — | 正常 | — |

### 14.2 四种 turn-end 后台任务对照

| 维度 | extractMemories | autoDream | promptSuggestion | sessionMemory |
|---|---|---|---|---|
| 触发点 | stop hook | stop hook | stop hook | post-sampling hook |
| 目标 | 提取新信息成记忆 | 跨会话整合 | 预测下条输入 | 会话快照（compaction） |
| 用 runForkedAgent？ | 是 | 是 | **否**（单次生成） | 是 |
| 频率/闸控 | 每回合候选；bramble_lintel 节流+游标+去重+trailing | 24h + 5 会话 + 扫描节流 + 整合锁 | 每回合；冷缓存抑制 | token 阈值驱动 |
| 作用域 | 仅主 agent | 仅主 agent | 仅主线程 | 仅主线程 |

---

## 15. 详细 mermaid 架构图

### 15.1 系统全貌（flowchart LR）

```mermaid
flowchart LR
    subgraph Modes[运行模式分派 · loadMemoryPrompt]
        direction TB
        L[loadMemoryPrompt] -->|KAIROS && active| KD[buildAssistantDailyLogPrompt<br/>logs/YYYY/MM/YYYY-MM-DD.md]
        L -->|TEAMMEM && enabled| KC[buildCombinedMemoryPrompt<br/>private + team 双索引]
        L -->|autoEnabled| KI[buildMemoryLines<br/>auto memory]
        L -->|否则|null + tengu_memdir_disabled
    end

    subgraph Types[记忆类型 MEMORY_TYPES]
        direction TB
        T1[user] --> T1f{frontmatter<br/>name/description/type}
        T2[feedback] -->|Why + How to apply| T1f
        T3[project] -->|相对日期→绝对日期| T1f
        T4[reference] --> T1f
    end

    subgraph Scopes[作用域 Scope]
        direction TB
        S1[auto · 主会话<br/>projects/{hash}/memory]
        S2[team · 仓库级<br/>memory/team + 远端同步]
        S3[agent user · agent-memory/user]
        S4[agent project · agent-memory/project]
        S5[agent local · agent-memory-local]
    end

    subgraph Writers[写入主体]
        direction TB
        W1[主 agent /remember]
        W2[extractMemories<br/>stop hook 增量]
        W3[autoDream<br/>stop hook 低频整合]
        W4[/dream KAIROS 蒸馏]
        W5[sessionMemory 快照]
    end

    subgraph Recall[召回注入]
        direction TB
        R1[用户 Query]
        R2[scanMemoryFiles<br/>frontmatter 清单 ≤200]
        R3[Sonnet sideQuery<br/>5 槽 JSON Schema]
        R4[readMemoriesForSurfacing<br/>200 行 / 4KB 截断]
        R1 --> R2 --> R3 --> R4
        R4 -->|relevant_memories 附件| R5[<br/>注入 user message]
    end

    Modes --> Types
    Modes --> Scopes
    Modes --> Writers
    Writers -->|写主题文件+MEMORY.md| Scopes
    Scopes -->|系统提示词索引| INJ1[system 提示词]
    Recall -->|正文| INJ2[messages]
    INJ1 --> REQ[API 请求体]
    INJ2 --> REQ
```

### 15.2 读侧：索引进 system + 正文异步召回时序

```mermaid
sequenceDiagram
    participant U as 用户
    participant Q as Query Loop
    participant SYS as 系统提示词(system)
    participant SCAN as scanMemoryFiles
    participant SQ as Sonnet sideQuery
    participant API as API 请求
    participant W as extractMemories/autoDream

    U->>Q: 发送 Query
    Q->>SYS: loadMemoryPrompt → 记忆指令 + MEMORY.md 索引
    Note over Q: 同步：索引无条件进 system（getClaudeMds 同批）
    Q->>SCAN: startRelevantMemoryPrefetch（异步 fire-and-forget）
    SCAN->>SCAN: 读 frontmatter 清单（≤200 文件，新→旧）
    SCAN->>SQ: 格式化清单 + Query → Sonnet sideQuery（5 槽）
    Note over Q,SQ: 主回合第一轮请求不等待 SQ
    Q->>API: 第一轮"无记忆附件"请求先发出
    SQ-->>SCAN: selected_filenames
    SCAN->>SCAN: readMemoriesForSurfacing（200行/4KB 截断）
    Note over SCAN: promise.finally() 写 settledAt
    loop 每轮迭代
        Q->>Q: 轮询 settledAt && 未消费
    end
    Q->>API: 命中 → relevant_memories <system-reminder> 附件注入后续轮
    API-->>U: 回复
    Q->>W: 自然回合结束 → runForkedAgent（隔离 context + cache-safe params）
    W-->>SYS: 写回主题文件 + MEMORY.md（下回合索引可见）
```

### 15.3 写入侧：turn-end 后台提取（runForkedAgent 全流程）

```mermaid
flowchart TD
    E[自然回合结束 · handleStopHooks] --> G0{agentId 存在?}
    G0 -->|是| SKIP[不提取·仅主agent]
    G0 -->|否| G1{EXTRACT_MEMORIES<br/>+ tengu_passport_quail?}
    G1 -->|关| SKIP
    G1 -->|开| G2{isAutoMemoryEnabled?}
    G2 -->|否| SKIP
    G2 -->|是| G3{远程模式?}
    G3 -->|是| SKIP
    G3 -->|否| G4{inProgress 已有一次?}
    G4 -->|是| STASH[stash 进 pendingContext<br/>→ trailing run 合并]
    G4 -->|否| THR{节流闸<br/>bramble_lintel?}
    THR -->|turnsSinceLastExtraction < N| SKIP
    THR -->|达到| RUN[runExtraction]
    RUN --> HK{主agent已写记忆?<br/>hasMemoryWritesSince}
    HK -->|是| ADV[推进游标到末尾<br/>跳过不重复提取]
    HK -->|否| PRE[预注入记忆清单<br/>formatMemoryManifest]
    PRE --> PR[构建提取提示词<br/>buildExtractAutoOnlyPrompt]
    PR --> F[runForkedAgent<br/>隔离context+cache-safe params<br/>maxTurns:5 skipTranscript:true<br/>createAutoMemCanUseTool]
    F --> OK{成功?}
    OK -->|成功| C[推进 lastMemoryMessageUuid 游标]
    OK -->|失败| KEEP[游标不动·下次重试]
    C --> W[extractWrittenPaths<br/>过滤掉 MEMORY.md]
    W --> NOTIFY[createMemorySavedMessage<br/>通知主会话 + 遥测]
    NOTIFY --> NEXTR[(主题文件 + MEMORY.md<br/>下回合索引可见)]
```

### 15.4 作用域与目录总览

```mermaid
flowchart TD
    ROOT[~/.claude/projects/{hash}/memory/]
    ROOT --> A1[user.md]
    ROOT --> A2[feedback.md]
    ROOT --> A3[project.md]
    ROOT --> A4[reference.md]
    ROOT --> AI[MEMORY.md 索引<br/>200 行 / 25KB]
    ROOT --> AL[.consolidate-lock<br/>autoDream 整合锁]
    ROOT --> LG[logs/YYYY/MM/YYYY-MM-DD.md<br/>KAIROS append-only]
    ROOT --> TM[team/ 目录<br/>TEAMMEM 仓库级]
    TM --> TM1[team/MEMORY.md]
    TM --> TM2[team 主题文件]
    TM -.ETag/校验和.-> TSRV[(远端<br/>/api/claude_code/team_memory)]

    AGT[agent-memory/ 与 agent-memory-local/]
    AGT --> AU[agent-memory/user/{type}<br/>全局]
    AGT --> AP[agent-memory/project/{type}<br/>可提交 git]
    AGT --> AL2[agent-memory-local/{type}<br/>本机不入库]
```

---

## 附：关键文件索引

| 模块 | 文件 | 关键符号 |
|---|---|---|
| 系统提示词注入 | `src/memdir/memdir.ts` | `loadMemoryPrompt:419`、`buildMemoryPrompt:272`、`buildMemoryLines:199`、`buildAssistantDailyLogPrompt:327`、`truncateEntrypointContent:57` |
| 类型 | `src/memdir/memoryTypes.ts` | `MEMORY_TYPES`、`TYPES_SECTION_INDIVIDUAL/COMBINED`、`WHAT_NOT_TO_SAVE_SECTION`、`MEMORY_FRONTMATTER_EXAMPLE` |
| 扫描/清单 | `src/memdir/memoryScan.ts` | `scanMemoryFiles:35`、`formatMemoryManifest:84`、`MAX_MEMORY_FILES=200` |
| 正文召回 | `src/memdir/findRelevantMemories.ts` | `findRelevantMemories:39`、`selectRelevantMemories:77`、`SELECT_MEMORIES_SYSTEM_PROMPT` |
| 预取/注入 | `src/utils/attachments.ts` | `startRelevantMemoryPrefetch:2361`、`getRelevantMemoryAttachments`、`readMemoriesForSurfacing:2279`、`memoryHeader`、`MAX_MEMORY_LINES/BYTES` |
| 新鲜度 | `src/memdir/memoryAge.ts` | `memoryAgeDays`、`memoryFreshnessText/Note` |
| 路径/开关 | `src/memdir/paths.ts` | `isAutoMemoryEnabled`、`getAutoMemPath` |
| 团队路径/提示词 | `src/memdir/teamMemPaths.ts` / `teamMemPrompts.ts` | `isTeamMemoryEnabled`、`getTeamMemPath`、`buildCombinedMemoryPrompt` |
| 侧查询 | `src/utils/sideQuery.ts` | `sideQuery:107` |
| 模型 | `src/utils/model/model.ts` | `getDefaultSonnetModel:119`（召回模型） |
| 后台提取 | `src/services/extractMemories/extractMemories.ts` + `prompts.ts` | `executeExtractMemoriesImpl:527`、`runExtraction:329`、`runForkedAgent:415`、`buildExtractAutoOnlyPrompt`、`createAutoMemCanUseTool:171` |
| 整合 | `src/services/autoDream/autoDream.ts` / `consolidationPrompt.ts` / `config.ts` / `consolidationLock.ts` | `runAutoDream`、`isGateOpen`、`buildConsolidationPrompt`、`isAutoDreamEnabled`、`.consolidate-lock` |
| 后台执行器 | `src/utils/forkedAgent.ts` | `runForkedAgent:489`、`createCacheSafeParams:131` |
| 子 agent 作用域 | `src/tools/AgentTool/agentMemory.ts` | `AgentMemoryScope`、`getLocalAgentMemoryDir:29`、`loadAgentMemoryPrompt` |
| stop hook | `src/query/stopHooks.ts` | `executeExtractMemories:149`、`executeAutoDream:154-156` |
| 团队同步 | `src/services/teamMemorySync/` | fetch/push、ETag、校验和、412 冲突 |
| 启动注入 | `src/services/api/claude.ts` | `addCacheBreakpoints:3063`、`createAttachmentMessage` |
