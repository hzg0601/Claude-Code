# 工具调用全流程安全防御分析

> 本文档深入分析 Claude Code 在**调用工具（Tool）**全流程中各类安全防御机制的实现。重点覆盖从"模型发出工具调用请求"到"工具真正执行"之间所有校验环节的主要脚本、实现流程与判断逻辑。

---

## 1. 总体架构：多层纵深防御（Defense in Depth）

Claude Code 的权限与安全不是单点校验，而是一条贯穿"请求 → 规则 → 模式 → 工具实现 → 钩子 → 落盘"的**多层流水线**。任何一层放行，都不代表工具可以执行；只有所有允许条件同时满足才会真正运行。

```
┌────────────────────────────────────────────────────────────────────┐
│  模型发出 tool_use 请求（QueryEngine 循环中）                        │
└───────────────────────────────┬────────────────────────────────────┘
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│  L1  canUseTool（useCanUseTool hook，CanUseToolFn）                 │
│      └─ hasPermissionsToUseTool（utils/permissions/permissions.ts） │
│          = 核心权限评估流水线（Pipeline）                            │
│             ├─ 1a~1g  规则/工具实现/安全校验（bypass 免疫）          │
│             ├─ 2a     模式层（bypassPermissions / plan）            │
│             ├─ 2b     整工具 allow 规则                              │
│             └─ ask 分支：dontAsk / auto(分类器) / 无头钩子           │
└───────────────────────────────┬────────────────────────────────────┘
                                ▼  (仅当返回 allow)
┌────────────────────────────────────────────────────────────────────┐
│  L2  交互式确认（ask 时）：handleInteractivePermission               │
│      / handleCoordinatorPermission / handleSwarmWorkerPermission    │
│      ├─ PermissionRequest 钩子（PreToolUse / PermissionRequest）    │
│      └─ 用户对话框（BashPermissionRequest 等）                      │
└───────────────────────────────┬────────────────────────────────────┘
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│  L3  工具实现内部校验（tool.checkPermissions）                       │
│      └─ Bash：bashToolHasPermission（bashPermissions.ts）           │
│          ├─ tree-sitter AST 解析（utils/bash/ast.ts）               │
│          ├─ checkSemantics（危险内建/别名包装）                     │
│          ├─ 规则匹配（exact/prefix/通配）                            │
│          └─ bashSecurity 注入检测（bashSecurity.ts）                 │
└────────────────────────────────────────────────────────────────────┘
```

---

## 2. 调用入口与核心脚本清单

| 层级 | 主要脚本 | 职责 |
|------|---------|------|
| 入口编排 | `QueryEngine.ts` | 主查询循环，在工具调用时调用 `canUseTool` |
| **核心评估** | `utils/permissions/permissions.ts` | **最简单的安全评估总线**：`hasPermissionsToUseTool` / `checkRuleBasedPermissions` |
| **编排 hook** | `hooks/useCanUseTool.tsx` | 把决策结果分发给：放行 / 拒绝 / 交互确认 |
| 交互确认 | `hooks/toolPermission/handlers/*Handler.ts` | interactive / coordinator / swarm 三种确认路径 |
| 上下文 | `hooks/toolPermission/PermissionContext.ts` | 构造单个待确认请求的上下文与队列 |
| 规则装载 | `utils/permissions/permissionsLoader.ts` | 从多来源装载 allow/deny/ask 规则 |
| 危险规则 | `utils/permissions/permissionSetup.ts` | 识别"过于宽泛/危险"的规则，禁用 bypass |
| 模式 | `utils/permissions/PermissionMode.ts` | 权限模式（default/plan/acceptEdits/bypass/auto…） |
| 杀开关 | `utils/permissions/bypassPermissionsKillswitch.ts` | 远程策略/Statsig 关闭 bypass |
| 钩子集成 | `services/tools/toolHooks.ts` | PreToolUse / PermissionRequest 钩子与规则配合 |
| **Bash 规则引擎** | `tools/BashTool/bashPermissions.ts` | Bash 专用的多层次权限判断 `bashToolHasPermission` |
| **Bash 注入防御** | `tools/BashTool/bashSecurity.ts` | 命令注入/混淆检测的验证器集合 |
| AST 解析 | `utils/bash/ast.ts` | tree-sitter 安全解析 + `checkSemantics` |
| 命令助手 | `tools/BashTool/bashCommandHelpers.ts` | 命令解析、前缀提取、subcommand 切分 |

---

## 3. 核心流水线：hasPermissionsToUseTool

`hasPermissionsToUseTool`（[utils/permissions/permissions.ts:473](../src/utils/permissions/permissions.ts#L473)）是整个权限评估的**总入口**。它有两部分：

- `hasPermissionsToUseToolInner`（[permissions.ts:1158](../src/utils/permissions/permissions.ts#L1158)）：**逐步骤**评估工具是否可用，返回 `allow / deny / ask`。
- 外层 `hasPermissionsToUseTool`：对 `ask` 结果做**模式变换**（dontAsk 降级为 deny、auto 模式走分类器、无头环境走钩子后自动拒绝）。

### 3.1 hasPermissionsToUseToolInner 逐步骤逻辑

这是最核心的判断链，编号与代码注释中的步骤一致：

```
1a. 整工具 deny 规则      → getDenyRuleForTool         → 命中即 deny
1b. 整工具 ask 规则       → getAskRuleForTool          → 命中即 ask（Bash+沙箱除外）
1c. 工具实现子规则        → tool.checkPermissions(input)
                             （如 Bash(npm publish:*) 前缀规则）
1d. checkPermissions 返回 deny           → 直接 deny
1e. requiresUserInteraction && ask       → 直接 ask（即使用户在 bypass 模式）
1f. content 级 ask 规则（ruleBehavior=ask）→ 直接 ask（bypass 免疫）
1g. safetyCheck 结果                    → 直接 ask（bypass 免疫，如 .git/）
────────────────────────────────────────────────────────
2a. 模式层：bypassPermissions / plan+可用 → 直接 allow
2b. 整工具 allow 规则（toolAlwaysAllowedRule）→ allow
3.  passthrough → 转 ask；ask 进入模式变换
```

**要点**：步骤 1a~1g 都发生在 `bypassPermissions` 检查（2a）**之前**。这意味着**即使开启了完全绕过权限模式（bypassPermissions），deny 规则、safety check、需要用户交互的工具依然有效**——这就是"bypass 免疫"设计。

### 3.2 ask 结果的模式变换（外层函数）

当内部流水线最终返回 `ask` 后，外层根据会话模式做进一步处理：

```
ask 结果
 ├─ mode === 'dontAsk'      → 降级为 deny（用户明确要求不弹窗）
 ├─ mode === 'auto'（自动）  → 走 AI 分类器（yoloClassifier）
 │    ├─ 不可分类器审批的 safetyCheck → 保持 ask
 │    ├─ 需要用户交互的工具        → 保持 ask
 │    ├─ 工具允许 acceptEdits 模式   → 用 acceptEdits 快路径判断（省分类器调用）
 │    ├─ 工具在安全白名单（isAutoModeAllowlistedTool）→ 直接 allow
 │    └─ 否则调用 classifyYoloAction(...) 由 LLM 分类
 │         ├─ shouldBlock 且 fail-closed → deny
 │         └─ 不阻断 → allow
 └─ 无头/后台（shouldAvoidPermissionPrompts）
      ├─ 先跑 PermissionRequest 钩子（runPermissionRequestHooksForHeadlessAgent）
      └─ 无钩子决策 → 自动 deny（AUTO_REJECT）
```

**安全要点**：
- **fail-closed**：auto 模式分类器不可用且 `tengu_iron_gate_closed` 开启时，直接 **deny**（不会因分类器故障而放行）。
- **拒绝上限**（denialTracking）：连续/总拒绝超过阈值（`DENIAL_LIMITS`）后，headless 用 `AbortError` 终止 agent，交互式则回退到普通弹窗。
- **PowerShell 特例**：非 ant 构建下，PowerShell 在 auto 模式不做分类器审批，必须显式交互确认。

---

## 4. 编排层：useCanUseTool 与决策分发

`useCanUseTool`（[hooks/useCanUseTool.tsx](../src/hooks/useCanUseTool.tsx)）把上一步的 `PermissionDecision` 翻译成实际动作：

- **allow** → 立即 `resolve(buildAllow(...))`，工具放行。
- **deny** → 记录 `logPermissionDecision`，auto 模式下记录 denial、发通知，返回拒绝。
- **ask** → 按优先级尝试自动化解：
  1. `handleCoordinatorPermission`（先等待自动化检查，如分类器）
  2. `handleSwarmWorkerPermission`（swarm worker 转发给 leader）
  3. Bash 的**投机分类器**（speculative classifier，2 秒宽限期内用高置信结果跳过对话框）
  4. `handleInteractivePermission`（真正弹窗 + 启动 PermissionRequest 钩子）

---

## 5. 工具实现层：Bash 的多层安全

Bash 是最危险的攻击面（命令注入），因此拥有**最复杂的独立防御**（`tools/BashTool/bashPermissions.ts`，2621 行）。

### 5.1 bashToolHasPermission：树级安全解析

`bashToolHasPermission`（[bashPermissions.ts:1663](../src/tools/BashTool/bashPermissions.ts#L1663)）是 BashTool 的 `checkPermissions` 主实现，流程：

```
0. AST 安全解析（tree-sitter，utils/bash/ast.ts）
   ├─ parseForSecurityFromAst(cmd, root)
   │    先跑已知的 tree-sitter/bash "差分" 预检：
   │      控制字符 / Unicode 空白 / 反斜杠空白 /
   │      zsh ~[ 动态目录 / =cmd 等号展开 / 花括号引号混淆
   ├─ 返回 three kinds：
   │    simple        → 干净的 SimpleCommand[]（引号已解析）
   │    too-complex   → 无法静态分析（命令替换/展开/控制流）→ 保守 ask
   │    parse-unavailable → tree-sitter 不可用 → 回退 legacy
   └─ PARSE_ABORTED（解析超时/资源限制，可被对抗性输入触发）→ 判定 too-complex → fail closed

1. too-complex 分支：仅尊重 exact deny/ask/allow + prefix deny，否则 ask
2. simple 分支：checkSemantics(commands)
   ├─ 剥离安全包装命令（time、nohup、timeout、nice）看被包装命令
   ├─ 检测 eval / source / exec / trap / enable / mapfile / hash ...（EVAL_LIKE_BUILTINS）
   ├─ 检测 zsh 危险内建（zmodload / sysopen / syswrite ...）
   └─ 语义不通过 → ask（先检查 deny 规则不降级）
3. parse-unavailable：legacy shell-quote 路径（tryParseShellCommand）
4. 沙箱 auto-allow（须同时启用沙箱 + autoAllowBashIfSandboxed + shouldUseSandbox）
5. exact match 规则
6. Bash prompt 规则分类器（Haiku，deny 优先于 ask）
7. 复合命令操作符（> | ; && 等，checkCommandOperatorPermissions）
8. 最终：bashToolCheckPermission 细粒度规则匹配
```

### 5.2 bashToolCheckPermission：细粒度规则引擎

`bashToolCheckPermission`（[bashPermissions.ts:1050](../src/tools/BashTool/bashPermissions.ts#L1050)）执行顺序：

```
1.  exact match 规则（Bash(rm -rf /)）
2.  matchingRulesForInput（prefix + 通配匹配，deny > ask）
2a. deny 命中 → deny
2b. ask 命中  → ask
3.  checkPathConstraints（路径约束，防绝对路径绕过项目目录——HackerOne 修复）
4.  exact allow 命中 → allow
5.  prefix allow 命中 → allow
5b. checkSedConstraints（阻断危险 sed）
6.  checkPermissionMode（模式相关处理）
7.  BashTool.isReadOnly → 只读命令直接 allow
8.  否则 passthrough（触发权限弹窗 + 建议规则）
```

**安全要点**：步骤 3 的 path constraints **在 deny/ask 规则之后**，避免用绝对路径绕过"命令前缀 deny"；同时用 AST argv 而非 shell-quote 解析（规避单引号反斜杠 bug 导致路径校验被跳过的问题）。

### 5.3 bashSecurity.ts：命令注入/混淆验证器

`checkCommandAndSuggestRules` 在**AST 解析未成功**且未禁用注入检查时调用 `bashCommandIsSafeAsync`（[bashSecurity.ts:2426](../src/tools/BashTool/bashSecurity.ts#L2426)）。命中危险模式一律返回 `ask` 且**不生成规则建议**（防止把危险命令保存成 allow 规则）。

验证器覆盖（`bashSecurity.ts` 内）：
- **命令/进程替换**：`$()`、`${}`、`<()`、`>()`、backtick
- **zsh 等号展开**（`=cmd`）：绕过 `Bash(curl:*)` deny——解析器把 `=curl` 当基命令而非 `curl`
- **反斜杠转义**空白/操作符（`validateBackslashEscaped*`）
- **变量注入**：`IFS`、`/proc/self/environ` 访问（`validateProcEnvironAccess`）
- **花括号展开 / 数学扩展 / Unicode 空白**
- **heredoc 安全替换**（`hasSafeHeredocSubstitution`）
- **return/echo 混淆、注释引号失配、引号内换行**

> 关键设计：当 **tree-sitter AST 解析成功**（`astParseSucceeded`）时，**跳过** legacy regex 验证器——因为 AST 已从结构上排除了隐藏替换/结构技巧，regex 只会带来误报。两者是**互为补充**而非叠加。

---

## 6. 其他安全组件

### 6.1 checkRuleBasedPermissions（钩子专用）
[permissions.ts:1071](../src/utils/permissions/permissions.ts#L1071) 只跑 1a~1g 的**规则子集**（bypass 之前的部分），用于 `services/tools/toolHooks.ts` 中让 **PreToolUse 钩子返回 allow 时仍要尊重 deny/ask/safety 规则**，避免钩子绕过权限系统。

### 6.2 危险规则识别（permissionSetup.ts）
对 `Bash(*)`、`Bash(python:*)`、PowerShell 的 `iex/Start-Process` 等**过宽规则**进行识别，防止其被用于 auto 模式或 bypass 模式的无审查执行。

### 6.3 bypass 权限杀开关
`bypassPermissionsKillswitch.ts` + `checkAndDisableBypassPermissions`（[permissionSetup.ts:1411](../src/utils/permissions/permissionSetup.ts#L1411)）：当远程策略/Statsig gate 要求关闭时，即使本地开了 `bypassPermissions` 也会**优雅停机**。

### 6.4 拒绝状态追踪（denialTracking.ts）
统计连续/总拒绝次数，用于触发"拒绝上限回退"与防止无限自动拒绝。

---

## 7. 单向流程总结

对一次 `Bash rm -rf /tmp/x` 调用，完整安全链路为：

```
QueryEngine 循环
  └─ canUseTool (useCanUseTool)
       └─ hasPermissionsToUseTool
            ├─ 1a deny 规则？ (Bash(rm:*) deny) → DENY
            ├─ 1c Bash.checkPermissions → bashToolHasPermission
            │     ├─ tree-sitter AST（simple → checkSemantics）
            │     ├─ checkCommandOperatorPermissions
            │     └─ bashToolCheckPermission（exact/prefix/path/sed/readonly）
            └─ ask（无规则匹配）→ 模式变换
                 ├─ auto → 分类器
                 ├─ 无头 → PermissionRequest 钩子 → deny
                 └─ 交互 → handleInteractivePermission → 弹窗 → 用户允许
```

每一步的放行条件都必须满足；任何一步 `deny` 立即终止；`safetyCheck`/`deny`/`requiresUserInteraction` 即使开启 `bypassPermissions` 也无法绕过。

---

## 8. 相关文档

- [权限系统概览](permissions.md) — 权限规则/通道高层设计
- [Bash 工具分析](bash-tool.md) — Bash 工具实现细节
- 源码目录：
  - `src/utils/permissions/` — 权限核心
  - `src/hooks/toolPermission/` — 确认处理
  - `src/tools/BashTool/` — Bash 防御
  - `src/utils/bash/` — AST 安全解析
