# Claude Code Skill 机制完全解析

> 基于源码分析（忽略 doc 文档），从 Skill 的定义与类型、配置与注册、发现与加载、匹配与注入、执行链路到与其他系统的协作，覆盖 Skill 机制的完整全貌。
> 核心文件：`src/skills/`、`src/commands.ts`、`src/tools/SkillTool/`

## 目录

1. [架构总览](#1-架构总览)
2. [Skill 的定义与类型](#2-skill-的定义与类型)
3. [Skill 的配置与注册](#3-skill-的配置与注册)
4. [Skill 的发现与加载](#4-skill-的发现与加载)
5. [Skill 的匹配机制](#5-skill-的匹配机制)
6. [Skill 的注入与执行](#6-skill-的注入与执行)
7. [Skill 与其他系统的协作](#7-skill-与其他系统的协作)
8. [关键源码速查](#8-关键源码速查)

---

## 1. 架构总览

Skill 是 Claude Code 中让模型按需加载**领域指令与参考上下文**的机制。从类型系统看，**Skill 就是 `type: 'prompt'` 的 `Command`**——没有独立的 Skill 类型，`Command` 是贯穿全系统的统一模型。

一个 Skill 的完整生命周期：

```
定义（BundledSkillDefinition / frontmatter）
  → 注册（registerBundledSkill / parseSkillFrontmatterFields → createSkillCommand）
  → 发现（loadSkillsFromSkillsDir / loadSkillsFromCommandsDir / 插件 / MCP）
  → 匹配（用户 /skill 斜杠调用 或 模型 Skill 工具调用）
  → 注入（getPromptForCommand → 参数替换 → 生成 ContentBlockParam 注入上下文）
  → 执行（inline 内联 或 fork 子代理）
  → 协作（hooks / plugins / agents / tools / mcp）
```

**关键文件分布**：

| 文件 | 职责 |
|------|------|
| `types/command.ts` | `Command` / `PromptCommand` / `CommandBase` 统一类型 |
| `skills/loadSkillsDir.ts` | Skill 核心：发现、解析 frontmatter、去重、条件/动态技能、Command 构造 |
| `skills/bundledSkills.ts` | 内置技能注册 registry、`files` 参考文件抽取 |
| `skills/bundled/index.ts` + `skills/bundled/*.ts` | 各内置技能实现与注册入口 |
| `skills/mcpSkills.ts` / `mcpSkillBuilders.ts` | MCP 技能发现（当前为占位） |
| `plugins/builtinPlugins.ts` + `types/plugin.ts` | 插件技能接线 |
| `commands.ts` | 命令聚合、查询、模型可见性过滤 |
| `tools/SkillTool/SkillTool.ts` | 模型端 Skill 工具 |
| `utils/hooks/*` | 技能级 hooks 注册与执行 |

---

## 2. Skill 的定义与类型

### 2.1 统一模型：`Command`

Skill 没有独立类型，而是 `Command` 的一种。见 [types/command.ts](../src/types/command.ts#L25-L57)：

```typescript
Command = CommandBase & (PromptCommand | LocalCommand | LocalJSXCommand)   // :205
```

#### `CommandBase`（[command.ts:175](../src/types/command.ts#L175)）公共字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `'prompt' \| 'local' \| 'local-jsx'` | Skill 用的是 `'prompt'` |
| `name` | string | 命令/技能名 |
| `description` | string | 描述，用于模型发现 |
| `aliases` | string[]? | 别名 |
| `isEnabled` | `() => boolean`? | 条件启用（feature flag、env 检查），默认 true（`isCommandEnabled` :214） |
| `isHidden` | boolean? | 从 typeahead/help 隐藏 |
| `argumentHint` | string? | 参数提示 |
| `whenToUse` | string? | 「From the Skill spec」：详细使用场景 |
| `disableModelInvocation` | boolean? | 禁止模型调用（仍可用户斜杠调用） |
| `userInvocable` | boolean? | 用户能否 `/skill` 调用 |
| `loadedFrom` | 见下 | 来源枚举 |
| `kind` | `'workflow'`? | workflow 支撑的命令（autocomplete 带徽标） |
| `userFacingName` | string? | 用户面对的名称 |

#### `PromptCommand`（[command.ts:25](../src/types/command.ts#L25)）Skill 特有字段

| 字段 | 说明 |
|------|------|
| `allowedTools` | 调用后自动授权的工具白名单 |
| `source` | `SettingSource \| 'builtin' \| 'mcp' \| 'plugin' \| 'bundled'`（:32） |
| `pluginInfo` | `{ pluginManifest, repository }`，插件标记 |
| `hooks` | 技能级 hooks 配置 `HooksSettings`（:39） |
| `skillRoot` | 技能根目录（为 skill hooks 设置 `CLAUDE_PLUGIN_ROOT`，:41） |
| `context` | `'inline' \| 'fork'`：内联展开 vs 子代理执行（:45） |
| `agent` | fork 时使用的 agent 类型（:48） |
| `effort` | 推理 effort 覆盖（:49） |
| `paths` | 条件技能：只在模型触碰匹配文件后可见（:52） |
| `getPromptForCommand` | 生成要注入的 ContentBlockParam（:53-56） |

#### `getCommandName` / `isCommandEnabled`（[command.ts:209-216](../src/types/command.ts#L209)）

```typescript
getCommandName(cmd)      // :209  取 name（别名解析用）
isCommandEnabled(cmd)    // :214  cmd.isEnabled?.() ?? true
```

### 2.2 按来源分类（`loadedFrom`）

[command.ts:191-197](../src/types/command.ts#L191) 定义了 Skill 的来源枚举，这是 Skill 类型的**主分类维度**：

| `loadedFrom` | 来源 | 说明 |
|--------------|------|------|
| `'bundled'` | 内置技能 | `registerBundledSkill` 程序化注册，随二进制打包 |
| `'plugin'` | 插件技能 | 来自第三方/官方插件的 `skills` 目录 |
| `'skills'` | 用户/项目 skills 目录 | 磁盘上的 `~/.claude/skills/*/SKILL.md` 等 |
| `'commands_DEPRECATED'` | 废弃 commands 目录 | 旧版 `/commands` 目录兼容 |
| `'managed'` | 受管技能 | 企业/受管策略注入（`policySettings`） |
| `'mcp'` | MCP 技能 | MCP server 提供的 prompt，受 `feature('MCP_SKILLS')` 门控 |

辅助构建函数 `createSkillCommand({ source: 'skillDir' | 'plugin' | 'managed', loadedFrom, ... })`（[loadSkillsDir.ts:270](../src/skills/loadSkillsDir.ts#L270)）在解析时用 `SettingSource` 从内容标识（`loadedFrom`）派生 `source`。

> **`source` 与 `'builtin'` 的语义坑**：`Command.source` 中的 `'builtin'` 表示**硬编码斜杠命令**（/help、/clear），与 `'bundled'` 不同。`skillDefinitionToCommand`（[builtinPlugins.ts:132](../src/plugins/builtinPlugins.ts#L132)）的注释（:145-149）特别强调：插件技能必须用 `'bundled'` 而非 `'builtin'`，因为 `'builtin'` 不出现在 Skill 工具列表、analytics 命名和 prompt 截断豁免中。

### 2.3 内置技能定义：`BundledSkillDefinition`

内置技能用独立的定义类型 [bundledSkills.ts:15-41](../src/skills/bundledSkills.ts#L15)，比 `PromptCommand` 多一个 `files` 字段（参考文件，首次调用解压）：

```typescript
type BundledSkillDefinition = {
  name: string
  description: string
  aliases?: string[]
  whenToUse?: string
  argumentHint?: string
  allowedTools?: string[]
  model?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
  isEnabled?: () => boolean
  hooks?: HooksSettings
  context?: 'inline' | 'fork'
  agent?: string
  files?: Record<string, string>          // 参考文件（首次调用解压到磁盘）
  getPromptForCommand: (args, context) => Promise<ContentBlockParam[]>
}
```

### 2.4 其他类型维度

除来源外，还有两个正交的分类维度：

1. **文件组织**：SKILL.md 目录格式（`skill-name/SKILL.md`）、单个 .md 文件（技能名 = 文件名）、废弃 `/commands/` 目录格式（详见 §4）。
2. **激活方式**：**普通技能**（无条件）、**条件技能**（`paths` frontmatter，只在模型触碰匹配文件后可见）、**动态技能**（`addSkillDirectories` 按需向上发现，详见 §4.3）。

### 2.5 四个过滤器语义

`disableModelInvocation` / `userInvocable` / `isEnabled` / `isHidden` 四者容易混淆，实际关系如下：

| 字段 | 定义 | 实践影响 |
|------|------|----------|
| `disableModelInvocation` | 禁止模型调用（command.ts:189） | 不在 `getSkillToolCommands`；Skill 工具调用报错码 4（SkillTool.ts:412-418）；用户 `/skill` 仍可调用。例：batch、debug、skillify |
| `userInvocable` | 用户能否 `/skill`（command.ts:190） | **派生 isHidden**：`isHidden = !userInvocable`（bundledSkills.ts:95、builtinPlugins.ts:155、loadSkillsDir.ts:335 → typeahead/help 隐藏）。例：keybindings-help（:298） |
| `isEnabled` | 条件启用（command.ts:180） | 在 `getCommands` 每次调用**新鲜求值**（commands.ts:484），auth/flag 变化即时生效。例：claude-in-chrome、loop、remember 等 |
| `isHidden` | 从 typeahead/help 隐藏（command.ts:182） | 通常由 `userInvocable` 派生，一般不直接设置 |

> **`disableModelInvocation` 与两个列表的微妙关系**：它不出现在 `getSkillToolCommands`（commands.ts:569 `!cmd.disableModelInvocation`），却在 `getSlashCommandToolSkills` 中**反而成为技能标识条件**（commands.ts:598 `或 disableModelInvocation`）——因为后者用于技能计数/发现而非调用授权。

---

## 3. Skill 的配置与注册

### 3.1 frontmatter 解析

磁盘 Skill 的配置写在 SKILL.md 的 YAML frontmatter 中，由 [loadSkillsDir.ts:185 parseSkillFrontmatterFields](../src/skills/loadSkillsDir.ts#L185) 解析：

| 解析函数 | 行号 | 职责 |
|----------|------|------|
| `parseSkillFrontmatterFields` | :185 | 主解析，产出 `Command` 所需字段 |
| `parseHooksFromFrontmatter` | :136 | `HooksSchema().safeParse` 校验 hooks，无效警告但不阻止 |
| `parseSkillPaths` | :159 | 解析条件技能的 `paths` 字段 |
| `estimateSkillFrontmatterTokens` | :100 | 估算 frontmatter token 数（描述预算用） |

frontmatter 支持的关键字段覆盖 `PromptCommand` 的能力：`description`、`allowed-tools`、`argument-hint`、`disable-model-invocation`、`model`、`agent`、`allowed-tools`、`hooks`（Zod 校验）、`paths`（条件技能）、`context` 等。

### 3.2 配置目录路径

[getSkillsPath(cwd)](../src/skills/loadSkillsDir.ts#L78) 按 source 返回加载目录。核心目录集合（[getSkillDirCommands :638](../src/skills/loadSkillsDir.ts#L638) 内部）：

| 目录 | SettingSource | 说明 |
|------|---------------|------|
| managed skills 目录 | `policySettings` | 受管/企业策略注入（:688） |
| 用户 skills 目录（`~/.claude/skills`） | `userSettings` | 用户级（:690） |
| 项目 `.claude/skills` | `projectSettings` | 项目级（:695） |
| `--add-dir` 附加目录 | `projectSettings` | 额外目录（:702） |
| 废弃 `commands` 目录 | — | `skillsLocked` 为 false 时加载（:713） |

### 3.3 内置技能程序化注册

内置技能不走 frontmatter，而是通过 [registerBundledSkill](../src/skills/bundledSkills.ts#L53) 程序化注册（映射见 §2.3）。注册入口 [initBundledSkills()](../src/skills/bundled/index.ts#L24)：

**无条件注册**（:25-34）：`update-config`、`keybindings-help`、`verify`、`debug`、`lorem-ipsum`、`skillify`、`remember`、`simplify`、`batch`、`stuck`。

**feature-flag 条件注册**（:35-78，动态 require）：

| 条件 | 技能 | 备注 |
|------|------|------|
| `KAIROS \|\| KAIROS_DREAM` | dream | **空实现占位** |
| `REVIEW_ARTIFACT` | hunter | **空实现占位** |
| `AGENT_TRIGGERS` | loop | `isEnabled` 委托 `isKairosCronEnabled` |
| `AGENT_TRIGGERS_REMOTE` | schedule | `scheduleRemoteAgents` |
| `BUILDING_CLAUDE_APPS` | claude-api | |
| `shouldAutoEnableClaudeInChrome()` | claude-in-chrome | |
| `RUN_SKILL_GENERATOR` | runSkillGenerator | **空实现占位** |

> **注意**：`dream.ts`、`hunter.ts`、`runSkillGenerator.ts` 是**空实现占位**（`registerDreamSkill() {}` 等），仅由 flag 门控但不注册任何真实技能——为未来功能预留的脚手架，不应误述为激活功能。

### 3.4 MCP 与插件技能注册

- **MCP 技能**：`fetchMcpSkillsForClient()`（[mcpSkills.ts:1](../src/skills/mcpSkills.ts#L1)）在当前恢复快照中是**占位桩**（返回 `[]`）。`mcpSkillBuilders.ts` 提供 `registerMCPSkillBuilders`/`getMCPSkillBuilders`（:33/:37）注册表，注入 `createSkillCommand` + `parseSkillFrontmatterFields`，是依赖图叶子避免 client↔loadSkillsDir 循环依赖。
- **插件技能**：`getBuiltinPluginSkillCommands()`（[builtinPlugins.ts:108](../src/plugins/builtinPlugins.ts#L108)）逐个调用 `skillDefinitionToCommand`（:132）把 `BuiltinPluginDefinition.skills`（`BundledSkillDefinition[]`，[plugin.ts:26](../src/types/plugin.ts#L26)）转换为 `Command`。第三方插件磁盘技能同样走 `createSkillCommand`/`parseSkillFrontmatterFields`。

### 3.5 去重与优先级

磁盘技能加载时以 `SkillWithPath`（[loadSkillsDir.ts:127](../src/skills/loadSkillsDir.ts#L127)）带路径追踪同名冲突，用 `getFileIdentity`（:118，基于 `realpath` 解析 symlink）判定唯一性。**先到先得**优先级：

```
managed（受管）> 用户 skills 目录 > 项目 skills 目录 > --add-dir 附加 > 废弃 commands 目录
```

高优先级来源先注册，同名技能后续来源被去重丢弃。

---

## 4. Skill 的发现与加载

### 4.1 主加载链路：`loadSkillsFromSkillsDir`

[loadSkillsDir.ts:407](../src/skills/loadSkillsDir.ts#L407) 扫描目录，核心流程：

```
扫描目录下的 Markdown 文件
  → isSkillFile(:484) 判定技能文件（SKILL.md 或 .md）
  → transformSkillFiles(:493) 规范化
  → parseSkillFrontmatterFields 解析
  → parseSkillPaths 提取条件路径
  → createSkillCommand(:270) 构造 Command
```

[loadSkillsFromCommandsDir](../src/skills/loadSkillsDir.ts#L566) 处理废弃的 `/commands/` 目录格式，产出 `loadedFrom: 'commands_DEPRECATED'` 的技能，保证向后兼容。

### 4.2 文件监视与热重载

[utils/skills/skillChangeDetector.ts](../src/utils/skills/skillChangeDetector.ts) 用 chokidar 监视技能目录，Bun 环境有 polling workaround。变更触发 `onDynamicSkillsLoaded`（loadSkillsDir.ts:839）回调并清除缓存（`clearSkillCaches` :806），下次调用重新加载。

### 4.3 条件技能与动态技能

| 类型 | 机制 | 触发 |
|------|------|------|
| **条件技能** | `paths` frontmatter 指定匹配文件 | 模型触碰匹配文件后可见：`activateConditionalSkillsForPaths`（:997） |
| **动态技能** | `addSkillDirectories`（:923）按需发现 | 从被触碰文件路径向上寻找技能目录：`discoverSkillDirsForPaths`（:861）；`getDynamicSkills`（:981）返回 |

### 4.4 命令聚合

[commands.ts loadAllCommands:449](../src/commands.ts#L449) 把所有来源聚合成一个数组：

```typescript
return [...bundledSkills, ...builtinPluginSkills, ...skillDirCommands,
        ...workflowCommands, ...pluginCommands, ...pluginSkills, ...COMMANDS()]
```

`getSkills`（:353）汇总 skill 目录、插件、内置、内置插件四处；`getCommands`（:476）过滤 `meetsAvailabilityRequirement && isCommandEnabled`（:484），并插入动态技能（:490-516）。

---

## 5. Skill 的匹配机制

### 5.1 名称/别名解析

[findCommand](../src/commands.ts#L688) 用 **name / getCommandName / aliases 三重匹配**；`getCommand`（:704）是基础查询。所有 Skill 工具调用和斜杠命令都经此解析。

用户侧自动补全：`getBestCommandMatch`（[commandSuggestions.ts:164](../src/utils/suggestions/commandSuggestions.ts#L164)）+ `applyCommandSuggestion`（:503）——这是用户输入 `/skill` 前缀时的模糊匹配，与模型侧无关。

### 5.2 用户斜杠调用 vs 模型调用（双调用）

Skill 存在**两条调用入口**：

```
用户：输入 /skill-name
  → processSlashCommand(:309)
  → userInvocable === false 则拒绝(:535)
  → getMessagesForPromptSlashCommand(:827) → processPromptSlashCommand(:817)

模型：调用 Skill 工具
  → SkillTool.validateInput → findCommand
  → disableModelInvocation 拦截（错误码4）
  → call → processPromptSlashCommand（内联）或 executeForkedSkill（fork）
```

用户斜杠调用检查 `userInvocable`（[processSlashCommand.tsx:529-535](../src/utils/processUserInput/processSlashCommand.tsx#L529)）；模型调用检查 `disableModelInvocation`。两条路径最终汇合于 `processPromptSlashCommand`，保证 `addInvokedSkill`/`registerSkillHooks` 只注册一次（SkillTool.ts:761-764 注释）。

### 5.3 模型可见性过滤：三个列表

| 列表 | 函数 | 条件 |
|------|------|------|
| Skill 工具可调用列表 | `getSkillToolCommands`（commands.ts:563） | `type==='prompt'` 且 `!disableModelInvocation` 且 `source!=='builtin'` 且（bundled/skills/commands_DEPRECATED，或显式描述，或 `whenToUse`） |
| 斜杠工具技能列表 | `getSlashCommandToolSkills`（:586） | `type==='prompt'` 且 `source!=='builtin'` 且描述/whenToUse 且（skills/plugin/bundled **或 disableModelInvocation**）——用于技能计数 |
| MCP 技能列表 | `getMcpSkillCommands`（:547） | `type==='prompt'` 且 `loadedFrom==='mcp'` 且 `!disableModelInvocation`，feature 门控 |

插件/MCP 命令需**显式 description** 才会出现在 Skill 工具列表中。

---

## 6. Skill 的注入与执行

### 6.1 `getPromptForCommand` 的注入管线

生成注入内容的核心管线（磁盘技能在 [loadSkillsDir.ts:270 createSkillCommand](../src/skills/loadSkillsDir.ts#L270)，内置技能各自实现）：

```
base-dir 前缀（Base directory for this skill: …）
  → substituteArguments 参数替换（$ARGUMENTS / $1 等，argumentSubstitution.ts:94）
  → ${CLAUDE_SKILL_DIR} / ${CLAUDE_SESSION_ID} 变量替换
  → executeShellCommandsInPrompt 执行 prompt 内 shell 命令（promptShellExecution.ts:69）
     （MCP 技能出于安全跳过）
  → 输出 ContentBlockParam[]
```

**`Base directory for this skill:` 前缀**（[bundledSkills.ts:208 prependBaseDir](../src/skills/bundledSkills.ts#L208)）告知模型技能参考文件所在目录，让模型可按需 `Read`/`Grep`。内置技能（有 `files` 时）与磁盘技能（loadSkillsDir.ts:346）使用**同一契约**。

### 6.2 inline vs fork

`context` 字段决定执行方式：

| 方式 | 执行 | 适用 |
|------|------|------|
| `inline`（默认） | `processPromptSlashCommand`，内容直接注入当前上下文 | 大多数技能 |
| `fork` | `executeForkedSkill`（SkillTool.ts:122）→ 子代理执行，独立上下文/token 预算 | 大型任务 |

fork 时子代理类型由 `agent` 字段决定：`prepareForkedCommandContext`（[forkedAgent.ts:191](../src/utils/forkedAgent.ts#L191)）取 `command.agent ?? 'general-purpose'`，找不到则回退 `general-purpose`/首个 agent（:212-217）。同时解析 `allowedTools` 构造受限工具上下文，`command.model` 覆盖模型。

### 6.3 模型侧 Skill 工具

[SkillTool](../src/tools/SkillTool/SkillTool.ts#L331) 注册在 `TOOLS`（tools.ts:212），工具名 `SKILL_TOOL_NAME = 'Skill'`。

| 阶段 | 函数/行号 | 关键逻辑 |
|------|-----------|----------|
| 输入 schema | :291-298 | `{ skill: string, args?: string }` |
| 描述 | :342 | `Execute skill: ${skill}` |
| 自动分类输入 | :352 | `skill ?? ''`（skill-coach 避免误报） |
| `validateInput` | :354 | 去前导 `/` → 远程 canonical skill → `findCommand` → disableModelInvocation 拦截(错误码4) → 非 prompt 拦截(错误码5) |
| `checkPermissions` | :432 | deny/allow 规则；远程 canonical auto-grant；**安全属性自动放行**（`skillHasOnlySafeProperties` :910 + `SAFE_SKILL_PROPERTIES` 白名单 :875）；默认 ask |
| `call` | :580 | 远程 canonical → `executeRemoteSkill`(:969)；fork 分派(:623)；内联 `processPromptSlashCommand`(:635) |

`call` 返回的 `contextModifier`（:775-839）把 `allowedTools` 合并进 alwaysAllowRules、`model` 用 `resolveSkillModelOverride` 保留 `[1m]` 后缀、`effort` 覆盖。

### 6.4 技能列表注入（`skill_listing` attachment）

模型并不是一开始就知道所有技能，而是通过**可变注入**的 `skill_listing` attachment 了解：

- 位置：轮次变化时 `maybe('skill_listing', …)`（[attachments.ts:875](../src/utils/attachments.ts#L875)）
- 实现：`getSkillListingAttachments`（:2661）——只对拥有 Skill 工具的 agent 注入；`getSkillToolCommands` + `getMcpSkillCommands` 合并（:2676-2679）
- **三重约束**：`SKILL_BUDGET_CONTEXT_PERCENT = 0.01`（上下文 1% 预算，prompt.ts:21）、`MAX_LISTING_DESC_CHARS = 250`（每项描述上限，:29）、`sentSkillNames`（attachments.ts:2607）模块级**增量去重**——每 agent 只发送新技能，避免每次重复注入
- **bundled skills 永不截断**（prompt.ts:92-110）；非 bundled 描述按预算截断（:120-171），极端只剩名称
- compaction 后重新暴露（`resetSentSkillNames`，compact.ts:204）

### 6.5 内置技能参考文件抽取（`files`）

带 `files` 的内置技能（如 `verify`，唯一使用此机制者）首次调用时解压参考文件：

```
getBundledSkillExtractDir → getBundledSkillsRoot（filesystem.ts:365，每进程随机 nonce）
  → writeSkillFiles（按父目录分组 mkdir + 并行写）
  → safeWriteFile（O_EXCL|O_NOFOLLOW，Windows 'wx'，0o600 权限）
  → prependBaseDir 注入 Base directory 行
```

**安全设计**（bundledSkills.ts:169-175 注释）：每进程 nonce + 0o700/0o600 显式权限防预建 symlink/目录攻击；`resolveSkillFilePath`（:196）拒绝绝对路径及含 `..` 的目录穿越；**不做 unlink+retry**（unlink 会跟随中间 symlink）。同一路径判定在 permission allowlist 中复用（filesystem.ts:1760-1764）。

---

## 7. Skill 与其他系统的协作

### 7.1 与 Hooks

Skill 可在 frontmatter/定义中携带 `hooks`，运行时注册为 **session-scoped** hooks：

- 存储：`SessionHooksState = Map<sessionId, SessionStore>`（[sessionHooks.ts:62](../src/utils/hooks/sessionHooks.ts#L62)）——**按 sessionId 隔离**；`SessionHookMatcher = { matcher, skillRoot?, hooks }`（:33-40）
- 注册时机：**调用时才注册**（懒加载）。`registerSkillHooks`（[registerSkillHooks.ts:20](../src/utils/hooks/registerSkillHooks.ts#L20)）在 [processSlashCommand.tsx:877](../src/utils/processUserInput/processSlashCommand.tsx#L877) 被调用，同时受 `hooks` 权限门控（`isRestrictedToPluginOnly('hooks')` 且非受信来源则跳过）
- `once: true` 的 hook 首次成功后自动移除（:36-43，`onHookSuccess` 回调）
- `CLAUDE_PLUGIN_ROOT`：`skillRoot` 传给 skill hooks 的环境变量（:18, :52）
- 归并去重：`addHookToSession` 按 `matcher + skillRoot` 归并（:181-183）
- 与配置 hooks 的关系：skill hooks 作为 **session-scoped 附加层**叠加在 settings 的全局/项目 hooks 之上，执行层通过 `AggregatedHookResult`（hooks.ts）汇合

### 7.2 与 Plugins

- `BuiltinPluginDefinition.skills?: BundledSkillDefinition[]`（[plugin.ts:26](../src/types/plugin.ts#L26)）——插件通过 `BundledSkillDefinition[]` 贡献技能
- 未启用的插件其技能被过滤（`getBuiltinPlugins` 按 `enabledPlugins` + `defaultEnabled` + `isAvailable` 判定）
- 插件命令用 `pluginInfo`（pluginManifest + repository）标记（command.ts:33-36）

### 7.3 与 Agents

- `agent` 字段绑定 fork 子代理类型（见 §6.2）
- `addInvokedSkill` 按 **agentId 作用域** 标记技能，compaction 保留时只恢复当前 agent 的技能，防止跨 agent 泄漏（processSlashCommand.tsx:882-886）
- agent frontmatter hooks 也转为 session hooks（`registerFrontmatterHooks`，`Stop` → `SubagentStop` 转换）

### 7.4 与工具系统

- `allowedTools`：调用 Skill 后自动加入 alwaysAllowRules（SkillTool.ts:779-806）
- 权限白名单：`SAFE_SKILL_PROPERTIES`（SkillTool.ts:875-908）— 若技能所有属性都在安全集内则免授权
- `skill_listing` 只对有权使用 Skill 工具的 agent 注入

### 7.5 与 MCP

- `getMcpSkillCommands` 提供 MCP 技能（`feature('MCP_SKILLS')` 门控）
- MCP 技能在 `executeShellCommandsInPrompt` 中被**跳过**（安全考虑，不执行 prompt 内 shell 命令）
- 当前快照中 `mcpSkills.ts` 为占位实现

---

## 8. 关键源码速查

| 机制 | 核心函数 | 文件 |
|------|----------|------|
| Command 统一类型 | `Command` / `PromptCommand` / `CommandBase` | `types/command.ts:25,175,205` |
| 启用判定 | `isCommandEnabled` | `types/command.ts:214` |
| 内置技能定义与注册 | `BundledSkillDefinition` / `registerBundledSkill` | `skills/bundledSkills.ts:15,53` |
| files 抽取（含安全） | `extractBundledSkillFiles` / `safeWriteFile` / `prependBaseDir` | `skills/bundledSkills.ts:131,186,208` |
| 解压根目录（per 进程 nonce） | `getBundledSkillsRoot` | `utils/permissions/filesystem.ts:365` |
| 打包技能注册入口 | `initBundledSkills` | `skills/bundled/index.ts:24` |
| frontmatter 解析 | `parseSkillFrontmatterFields` / `parseHooksFromFrontmatter` / `parseSkillPaths` | `skills/loadSkillsDir.ts:185,136,159` |
| Command 构造 | `createSkillCommand` | `skills/loadSkillsDir.ts:270` |
| Skill 目录加载 | `loadSkillsFromSkillsDir` | `skills/loadSkillsDir.ts:407` |
| 废弃目录兼容 | `loadSkillsFromCommandsDir` | `skills/loadSkillsDir.ts:566` |
| 条件/动态技能 | `activateConditionalSkillsForPaths` / `discoverSkillDirsForPaths` / `getDynamicSkills` | `skills/loadSkillsDir.ts:997,861,981` |
| 命令聚合 | `loadAllCommands` / `getCommands` / `getSkills` | `commands.ts:449,476,353` |
| 模型可见性过滤 | `getSkillToolCommands` / `getSlashCommandToolSkills` / `getMcpSkillCommands` | `commands.ts:563,586,547` |
| 名称/别名匹配 | `findCommand` / `getCommand` | `commands.ts:688,704` |
| 用户侧补全 | `getBestCommandMatch` / `applyCommandSuggestion` | `utils/suggestions/commandSuggestions.ts:164,503` |
| 参数替换 | `substituteArguments` | `utils/argumentSubstitution.ts:94` |
| prompt 内 shell 执行 | `executeShellCommandsInPrompt` | `utils/promptShellExecution.ts:69` |
| 斜杠命令执行 | `processPromptSlashCommand` / `getMessagesForPromptSlashCommand` | `utils/processUserInput/processSlashCommand.tsx:817,827` |
| Skill hook 注册 | `registerSkillHooks` | `utils/hooks/registerSkillHooks.ts:20` |
| 会话 hook 存储 | `SessionHooksState` / `addSessionHook` | `utils/hooks/sessionHooks.ts:62,68` |
| Skill 工具定义 | `SkillTool` | `tools/SkillTool/SkillTool.ts:331` |
| Skill 工具校验 | `validateInput` / `checkPermissions` / `call` | `tools/SkillTool/SkillTool.ts:354,432,580` |
| fork 子代理绑定 | `prepareForkedCommandContext` | `utils/forkedAgent.ts:191` |
| 安全属性白名单 | `SAFE_SKILL_PROPERTIES` / `skillHasOnlySafeProperties` | `tools/SkillTool/SkillTool.ts:875,910` |
| 技能列表注入 | `getSkillListingAttachments` | `utils/attachments.ts:2661` |
| 注入预算/截断 | `formatCommandsWithinBudget` | `tools/SkillTool/prompt.ts:70` |
| 插件技能→Command | `getBuiltinPluginSkillCommands` / `skillDefinitionToCommand` | `plugins/builtinPlugins.ts:108,132` |
| 文件监视热重载 | `skillChangeDetector.ts` | `utils/skills/skillChangeDetector.ts` |
