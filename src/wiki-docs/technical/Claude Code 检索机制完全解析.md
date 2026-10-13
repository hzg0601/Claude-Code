# Claude Code 检索机制完全解析

> 本文基于 Claude Code 源码（`d:\codes\Claude-Code\src`）逐一分析，**不参考任何 doc 文档**，仅以 `.ts` / `.tsx` 源码为准。
> 文中所有引用均标注源码路径与行号，便于回溯验证。
> 相关主题：[[Claude Code 多智能体机制完全解析]]、[[tool-lifecycle]]、[[Query Loop 架构分析]]

"模型如何不打开文件就理解代码库"——这是 Claude Code 检索机制要解决的核心问题。
它并非用一个万能的"搜索框"，而是把"找代码"拆成**若干正交的检索通道**，由模型根据需求选择；
所有通道最终都汇聚到**同一个外部执行器 `ripgrep`** 上。

本文从**通道全景 → 每个通道的实现 → 底层统一执行器 → 模型如何编排**四个层次，给出完整图景。

---

## 一、全景：检索机制的总体架构

### 1.1 检索不是一个工具，而是一条决策链

Claude Code 的"检索"由**三组原语** + **两条辅助通道**组成。它们互不交换数据，
连接它们的是**模型在上下文窗口里的推理**（Grep 的输出是模型可读的输入，Read 的参数是模型写出的输出）。

```
┌────────────────────────────────────────────────────────────────────┐
│                        模型上下文（唯一的信息交换介质）                │
└────────────────────────────────────────────────────────────────────┘
        ▲ 注入工具体验                           ▲ 模型推理选择
        │                                           │
  工具定义（inputSchema 的 describe）          检索轨迹（Grep→Read→…）
        │                                           │
┌───────┴───────────────────────────────────────┴───────────────────┐
│                    内置工具通道（面向模型）                          │
│                                                                    │
│   Glob（按名/路径）▸ utils/glob.ts          ─┐                      │
│   Grep（按内容/正则）▸ GrepTool.ts           ├─▸ ripgrep（外部二进制）│
│   Read（定向读）▸ readFileInRange.ts          │                      │
│   readEditContext（编辑上下文窗）            ─┘                      │
└────────────────────────────────────────────────────────────────────┘
        │
┌───────┴───────────────────────────────────────────────────────────┐
│                    辅助通道（不面向模型工具调用）                     │
│   FileIndex（交互式路径补全，仅索引路径）                            │
│   MCP 代码索引 server（可选外部，Sourcegraph/LSP 等，仅遥测检测）    │
│   codegraph（本仓库实例化：src/.codegraph/ 预建符号索引）            │
└────────────────────────────────────────────────────────────────────┘
```

### 1.2 通道矩阵总览

| 通道 | 匹配对象 | 面向 | 底层 | 是否读文件内容 |
| ---- | -------- | ---- | ---- | --------------- |
| **Glob** 工具 | 文件名/路径 | 模型 | ripgrep `--files --glob` | ❌ 只匹配路径 |
| **Grep** 工具 | 文件内容 | 模型 | ripgrep `-n -e` | ✅ 实时扫内容 |
| **Read** 工具 | 目标文件区间 | 模型 | Node `readFile`/流 | ✅ 读文件 |
| **readEditContext** | 目标文件窗口 | 编辑链路 | 底层 `FileHandle` 扫描 | ✅ 读文件 |
| **FileIndex** | 文件名/路径 | 交互式补全 | Rust/原生内存索引 | ❌ 只索引路径 |
| **MCP 代码索引** | 符号/语义 | 模型（可选外部） | 外部 LSP/Sourcegraph | 取决于 server |
| **codegraph** | 符号图 | 模型（实例化时） | SQLite 预建索引 | 取决于索引 |

**核心洞察**：Claude Code 的**内置**检索在"文件名↔内容"之间**没有任何倒排索引缓存**。
"名字无关、内容相关"的检索一律靠 **ripgrep 实时扫内容**，没有预索引捷径。
唯一预建的路径索引 `FileIndex` 只服务交互式补全，不进入模型工具通道。

---

## 二、Glob —— 按名 / 按路径检索

### 2.1 工具壳：`GlobTool`

[GlobTool.ts:57-198](src/tools/GlobTool/GlobTool.ts#L57-L198) 定义了工具。关键属性：

- `name: GLOB_TOOL_NAME`、`searchHint: 'find files by name pattern or wildcard'`（[GlobTool.ts:59](src/tools/GlobTool/GlobTool.ts#L59)）——**这是模型判断"按名找"的关键提示词**；
- `maxResultSizeChars: 100_000`；
- `isSearchOrReadCommand() → { isSearch: true, isRead: false }`（[GlobTool.ts:85-87](src/tools/GlobTool/GlobTool.ts#L85-L87)）；
- 输入只有 `pattern` + 可选 `path`（[GlobTool.ts:26-36](src/tools/GlobTool/GlobTool.ts#L26-L36)）；
- 输出 `durationMs / numFiles / filenames / truncated`（[GlobTool.ts:39-52](src/tools/GlobTool/GlobTool.ts#L39-L52)）。

权限与校验：
- `validateInput` 校验 `path` 是存在的目录，并**跳过 UNC 路径**（`\\` / `//` 开头）以防 NTLM 凭据泄露（[GlobTool.ts:100-103](src/tools/GlobTool/GlobTool.ts#L100-L103)）；
- `checkPermissions` 走 `checkReadPermissionForTool`（读权限）。

### 2.2 核心：`glob()` —— 外包给 ripgrep

`call()` 调用 [glob.ts:66-130](src/utils/glob.ts#L66-L130) 的 `glob()`。它**不使用任何 glob 库**（无 picomatch/fast-glob），直接调用与 Grep 相同的 `ripGrep()`：

```ts
// glob.ts:119
const allPaths = await ripGrep(args, searchDir, abortSignal)
```

构造的 rg 参数（[glob.ts:100-107](src/utils/glob.ts#L100-L107)）：

```
--files            // 只列文件路径，不搜内容
--glob <pattern>   // 用 glob 模式过滤（rg 内建 glob 语法）
--sort=modified    // 按修改时间排序（旧→新）
--no-ignore        // 默认不 respect .gitignore（可环境变量关闭）
--hidden           // 默认含隐藏文件（可环境变量关闭）
--glob !<ignore>   // 追加权限层忽略规则
```

**模式拆分**：rg 的 `--glob` 只接受相对模式，故绝对路径要先拆 baseDir 与相对 pattern，
由 [extractGlobBaseDirectory:17-64](src/utils/glob.ts#L17-L64) 处理（找到第一个 `*?[{`，前缀为 baseDir，并处理 `/` 根与 Windows 盘符 `C:`）。例如 `src/**/*.ts` → 对 `src/` 目录跑 `--glob '**/*.ts'`。

**过滤叠加**：除了用户 pattern，还追加 `--glob '!<pattern>'` 排除权限忽略模式与孤立插件目录（[glob.ts:109-117](src/utils/glob.ts#L109-L117)）。

### 2.3 后处理

`GlobTool.call` 拿到绝对路径列表后 `toRelativePath` 相对化（省 token）、记 `durationMs`、按 `limit`（默认 100，来自 `globLimits?.maxResults`）切片。generated `truncated` 标记超限（[glob.ts:126-129](src/utils/glob.ts#L126-L129)），并在返回给模型时追加提示"请用更具体的 path 或 pattern"（[GlobTool.ts:190-194](src/tools/GlobTool/GlobTool.ts#L190-L194)）。

> **要点**：Glob 只在**文件名/路径**上匹配，从不读文件内容。这是它与 Grep 的分界。

---

## 三、Grep —— 按内容 / 正则检索

### 3.1 工具壳与输入 Schema

[GrepTool.ts](src/tools/GrepTool/GrepTool.ts) 的 `isSearchOrReadCommand() → { isSearch: true, isRead: false }`（[GrepTool.ts:264-266](src/tools/GrepTool/GrepTool.ts#L264-L266)），`maxResultSizeChars: 20_000`（[GrepTool.ts:172](src/tools/GrepTool/GrepTool.ts#L172)）。

其 `inputSchema`（[GrepTool.ts:33-90](src/tools/GrepTool/GrepTool.ts#L33-L90)）是**模型能力的唯一来源**，包含：

- `pattern`、`path`、`glob`、`type`、`-i`、`-n`、`multiline`；
- **上下文参数** `-B` / `-A` / `-C` / `context`，均被 `semanticNumber(z.number().optional()).describe(...)` 说明（[GrepTool.ts:58-67](src/tools/GrepTool/GrepTool.ts#L58-L67)）；
- `output_mode`：`content` / `files_with_matches` / `count`，默认 `files_with_matches`；
- `head_limit`（默认 250）、`offset`。

> **关键**：工具的**文字描述**（`getDescription()`，见 [GrepTool/prompt.ts:6-17](src/tools/GrepTool/prompt.ts#L6-L17)）**不提 `-C`/`-A`/`-B`**，只讲 output mode。模型知道这些参数存在，**完全来自 inputSchema 的 `.describe()`**。详见"模型的决策依据"一节。

### 3.2 结果处理与限流

- `DEFAULT_HEAD_LIMIT = 250`（[GrepTool.ts:108](src/tools/GrepTool/GrepTool.ts#L108)）：`applyHeadLimit` 只在显式传 `head_limit=0` 时无限，否则默认截断到 250 条（[GrepTool.ts:110-128](src/tools/GrepTool/GrepTool.ts#L110-L128)）；
- `--max-columns 500` 截断超长行（[GrepTool.ts:338](src/tools/GrepTool/GrepTool.ts#L338)）；
- content 模式：先 `applyHeadLimit`，再逐行 `toRelativePath`，并把 `appliedLimit`/`appliedOffset` 返回给模型；超出时追加 `[Showing results with pagination = limit: N]` 横幅（[GrepTool.ts:270-272](src/tools/GrepTool/GrepTool.ts#L270-L272)）——**这是触发模型 `offset` 翻页的机制**。

---

## 四、Read —— 定向读取文件

### 4.1 工具与分页

`Read` 工具的提示词（[FileReadTool/prompt.ts:27-49](src/tools/FileReadTool/prompt.ts#L27-L49)）定义了 `MAX_LINES_TO_READ = 2000`（[prompt.ts:10](src/tools/FileReadTool/prompt.ts#L10)），并给模型两条**行为引导**：

- 默认引导 `OFFSET_INSTRUCTION_DEFAULT`："建议不提供 offset/limit 读整文件"；
- 定向引导 `OFFSET_INSTRUCTION_TARGETED`："当你已知需要文件的哪部分时，只读那部分，对大文件很重要"（[prompt.ts:20-21](src/tools/FileReadTool/prompt.ts#L20-L21)）。

### 4.2 读取引擎：`readFileInRange`

[readFileInRange.ts:73-122](src/utils/readFileInRange.ts#L73-L122) 提供**两条代码路径**：

- **快路径**（普通文件 < 10MB，`FAST_PATH_MAX_SIZE`，[readFileInRange.ts:44](src/utils/readFileInRange.ts#L44)）：`readFile` 整读 + 内存按行切分（[readFileInRange.ts:95-112](src/utils/readFileInRange.ts#L95-L112)）；
- **流式路径**（大文件/管道/设备）：`createReadStream`（512KB `highWaterMark`）+ 手动 `indexOf('\n')` 扫描；**范围外的行只计数不累积**，读 100GB 文件的第 1 行不会撑爆内存（[readFileInRange.ts:344-383](src/utils/readFileInRange.ts#L344-L383)）。

语义：返回 `[offset, offset+maxLines)` 的连续行区间；**同时返回 `totalLines`**（[readFileInRange.ts:188](src/utils/readFileInRange.ts#L188)）供模型驱动分页。BOM 与 CRLF 均被剥离。

**大小保护**：
- `maxSizeBytes` 上限，超限时**抛 `FileTooLargeError`**，其 message 明确引导模型"用 offset/limit 或搜索具体内容代替整读"（[readFileInRange.ts:57-67](src/utils/readFileInRange.ts#L57-L67)）；
- `truncateOnByteLimit` 模式（默认 false）则截断输出并置 `truncatedByBytes`，不抛错。

---

## 五、readEditContext —— 编辑链路的上下文窗

与模型检索不同，**编辑工具**（FileEdit 等）需要在"已知一个 needle（锚点字符串）"的前提下，
读取它周围的一小段上下文。实现见 [readEditContext.ts:31-43](src/utils/readEditContext.ts#L31-L43)。

- `readEditContext(path, needle, contextLines=3)`：找到 `needle` 并返回**±contextLines 的窗口切片** + `lineOffset`；
- **8KB 分块扫描**（`CHUNK_SIZE`）带跨块重叠（`overlap = needleLF.length + nlCount - 1`），保证跨 chunk 边界的命中不漏（[readEditContext.ts:74-110](src/utils/readEditContext.ts#L74-L110)）；
- 兼容 CRLF（模型发 LF，先按 LF 扫，miss 再试 CRLF 缓冲）（[readEditContext.ts:86-90](src/utils/readEditContext.ts#L86-L90)）；
- 扫描上限 `MAX_SCAN_BYTES = 10MB`，超限置 `truncated`（[readEditContext.ts:112](src/utils/readEditContext.ts#L112)）；
- `sliceContext` 双向找 contextLines 个换行，计算 `lineOffset`，复用扫描缓冲实现零分配（[readEditContext.ts:171-227](src/utils/readEditContext.ts#L171-L227)）；
- `readCapped`（[readEditContext.ts:123-145](src/utils/readEditContext.ts#L123-L145)）用于 FileEditToolDiff 多编辑路径，需全量字符串时用**倍增缓冲**读完整文件。

---

## 六、底层统一执行器：ripgrep

无论 Glob 还是 Grep，底层都是 **[utils/ripgrep.ts:345-463](src/utils/ripgrep.ts#L345-L463) 的 `ripGrep()`**。

### 6.1 机制

```ts
// ripgrep.ts 内部 ripGrepRaw → execFile('rg', [全局配置, ...args, target], ...)
```

- 用 `execFile` 拉起**外部 rg 二进制**（首次使用前 `codesignRipgrepIfNecessary` 与 `testRipgrepOnFirstUse` 探测）；
- **退出码 1 = 正常"无匹配"**，`resolve([])`（[ripgrep.ts:376-380](src/utils/ripgrep.ts#L376-L380)）；
- **关键错误码** `ENOENT/EACCES/EPERM` → `reject`（说明 rg 坏了，而非无结果）（[ripgrep.ts:384-388](src/utils/ripgrep.ts#L384-L388)）；
- **EAGAIN**（瞬时资源错误）→ 用 `-j 1` 单线程重试**一次**，不持久化（[ripgrep.ts:394-409](src/utils/ripgrep.ts#L394-L409)）；
- **超时**：WSL 60s / 其它 20s；超时且无结果时**抛 `RipgrepTimeoutError`**，让模型知道"搜索未完成而非无结果"（[ripgrep.ts:446-454](src/utils/ripgrep.ts#L446-L454)）；
- **缓冲溢出**/超时且部分结果 → 丢弃最后一行（可能不完整）后返回部分结果（[ripgrep.ts:427-431](src/utils/ripgrep.ts#L427-L431)）。

另有 `ripGrepStream`（[ripgrep.ts:295-343](src/utils/ripgrep.ts#L295-L343)）用于交互式场景（如输入时即时建议，可逐行回传、可被 abort）。

### 6.2 为什么统一到 rg？

- **内存性能**：rg 以极低内存递归文件系统，比 Node 递归 fs 更优（注释明确"Use ripgrep for better memory performance"）；
- **一套 glob/正则语法**：Glob 和 Grep 共享 rg 的模式引擎；
- **忽略/隐藏处理**：rg 原生的 `--no-ignore`/`--hidden` 让两个工具行为一致。

---

## 七、辅助通道：FileIndex 与 MCP 代码索引

### 7.1 FileIndex —— 交互式路径补全（非模型通道）

[native-ts/file-index/index.ts](src/native-ts/file-index/index.ts) 的 `FileIndex` 是 Rust/原生实现的**模糊匹配索引**，服务 [hooks/fileSuggestions.ts:34](src/hooks/fileSuggestions.ts#L34)（输入框里的文件补全，如 Ctrl+O 跳转）。

- **只索引路径**：`indexPath` 预计算 `lowerPaths` / `charBits`（a–z 位图）/ `pathLens`（[index.ts:156-167](src/native-ts/file-index/index.ts#L156-L167)）——**不含任何文件内容**；
- `search()`（[index.ts:173-291](src/native-ts/file-index/index.ts#L173-L291)）：**O(1) 位图预淘汰**（路径必须含 needle 每个字母）→ 融合的 `indexOf` 扫描 + gap/consecutive 计分 → boundary/camelCase 加分 → **top-k 堆**（避免全排）；
- 路径来源：git tracked 文件 + merge untracked（`loadFromFileListAsync`，[index.ts:83-93](src/native-ts/file-index/index.ts#L83-L93)），带签名去重（[fileSuggestions.ts:184-194](src/hooks/fileSuggestions.ts#L184-L194)）。

> **这是整条链路上唯一预建的"路径索引缓存"**，但它**只服务 UI 补全**，模型工具通道（Glob/Grep）都不用它。

### 7.2 MCP 代码索引 —— 可选外部，仅遥测检测

[codeIndexing.ts:12-42](src/utils/codeIndexing.ts#L12-L42) 定义了 `CodeIndexingTool` 类型（Sourcegraph/Cody/…/本地 LSP-like/MCP server）。但这个文件本身**不执行检索**——它只提供 `detectCodeIndexingFromCommand/McpTool/McpServerName`（[codeIndexing.ts:126-206](src/utils/codeIndexing.ts#L126-L206)）用于**埋点遥测**，识别用户是否调用了外部代码索引工具。

结论：Claude Code 的**符号检索 / LSP 语义检索并非内置**；只有用户自行接入 MCP 代码索引 server（如 Sourcegraph、本地 LSP）时，模型才有这类通道，而内置从零到有一律走 rg 实时扫。

---

## 八、codegraph：本仓库实例化的符号索引

CLAUDE.md 规定：仓库被 CodeGraph 索引（存在 `.codegraph/`）时，应**优先用 codegraph 而非 grep/Read** 理解代码。本仓库已实例化：

```
src/.codegraph/{codegraph.db, codegraph.db-shm, codegraph.db-wal, daemon.log}
```

codegraph 是 SQLite 符号知识图谱（每个符号/边/文件的预计算结构），通过 `codegraph_explore` 返回**逐行源码 + 调用路径 + 影响面**。它是"**符号→定义/调用**"的第三类语义检索通道，能补 grep 追不上的动态派发（回调/React 重渲染/JSX children）。

> **注意**：`src/.codegraph` 与 `native-ts/file-index` 是**两条不同索引**——前者是 SQLite 符号图（服务模型理解），后者是内存路径补全（服务 UI）。勿混。

---

## 九、模型如何编排这些通道

### 9.1 "Grep 定位 + 定向 Read"的典型工作流

模型面对"理解某段代码"时，默认的省钱检索模式是**两阶段**：

```
第一阶段（定位，token 便宜）   →  Grep/Glob 只拿"命中行号 + 路径"
    ↓ 模型在上下文里推理（无程序级传参）
第二阶段（取值，只读"证明有用"的行） →  Read(file, offset, limit) 精确取区间
```

Grep 输出**只开销在"被证明有价值"的行**；Read 的 `offset`/`limit` 由模型启发式决定（以命中行为中心包一个窗口，或用 `totalLines`/`MAX_LINES_TO_READ(2000)` 分页）。

### 9.2 通道选择的判定规则

| 需求 | 通道 | 依据 |
| ---- | ---- | ---- |
| "哪个文件含某内容/函数名" | **Grep**（`files_with_matches`） | 内容检索，函数名几乎不进文件名 |
| "按名字/路径结构找文件" | **Glob** | `searchHint: find files by name` |
| "看某文件某区间全文" | **Read**(offset, limit) | `OFFSET_INSTRUCTION_TARGETED` |
| "某锚点字符串周围一小段（编辑）" | **readEditContext** | 编辑链路内部，非模型选择 |
| "从符号跳到定义/调用/影响面" | **codegraph**（实例化时） | CLAUDE.md 强制优先 |
| 交互式输入补全 | **FileIndex** | UI 层，非模型工具 |

### 9.3 模型怎么知道"Grep 能不能带 -C"？（决策依据）

1. **知道能力存在** → 来自 `GrepTool` 的 **inputSchema**（`-B`/`-A`/`-C`/`context` 及各自 `.describe()`），**不是**来自 `getDescription()` 文字（那个不提 context）；
2. **决定带不带** → 模型启发式权衡：需要"命中周围上下文"且**不想再补一次 Read** → 带 `-C`；只要行号/清单或有 Read 计划 → 不带；
3. **机制层面** → `call()` 只在模型主动传 `context` 时才 `args.push('-C', ...)`（[GrepTool.ts:363-376](src/tools/GrepTool/GrepTool.ts#L363-L376)）——**无默认、无强制**，纯靠模型临场判断。

### 9.4 数量变量如何影响决策？

不是"文件多→带 -C、少→不带"这条直线，而是：

- **多文件、未聚焦** → 不带 -C，用 `files_with_matches` 拿路径 → 定向 Read（此时 -C 的上下文在"一屏几十个文件"里纯浪费 token）；
- **单文件、已聚焦、要上下文** → 带 -C 一次拿全，省一次 Read。

真正触发的变量是"**能否用 -C 便宜地替代一次 Read**"。

### 9.5 "名字无关、内容相关"如何解决？

Glob **定义上只匹配名字**，从结构上漏掉这类需求——**这是设计使然，不是缺陷**。解法是分工：
- **Grep（内容 → 路径）** 专门接这类；
- **Glob（名字/路径 → 路径）** 管另一类；
- 模型读工具的 `searchHint`/描述即可判断用哪个，无需记忆。

整条链路**没有"文件名↔内容"的倒排索引**，内容检索一律 rg 实时扫。

---

## 十、结论：一图流

```
找代码 = 选通道（模型推理）
  按名/路径   → Glob ─────────────────┐
  按内容/正则 → Grep（可带 -C）──────┤
  读区间      → Read(offset,limit) ──┤── 统一执行器 ripgrep / Node fs
  编辑上下文  → readEditContext ─────┘
  语义符号    → codegraph（可选，实例化时）
  交互补全    → FileIndex（UI 专用，只索引路径）

底层分工：
  rg --files + --glob   → 按名列路径    （Glob）
  rg -n -e + 过滤       → 按内容扫      （Grep）
  Node readFile / 流     → 定向读区间    （Read）
  文件句柄分块扫描       → 锚点上下文窗   （readEditContext）
```

**一句话总结**：Claude Code 不提供单一搜索框，而是以 **inputSchema 描述**为能力说明书、以 **ripgrep 为统一执行引擎**，构建了"按名 / 按内容 / 定向读 / 上下文窗 / 语义符号"五条正交通道，靠**模型在上下文中的推理**把它们串成检索轨迹。**没有全读的捷径，也没有文件名↔内容的缓存索引**——"如何高效检索"本身，就是模型在 token 成本与信息增量之间不断权衡的决策问题。
