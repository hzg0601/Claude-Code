# 工具调用权限安全策略：公共流程抽象 与 双 Shell 工具独特策略对比

> 本文档把 Claude Code 的权限安全策略拆成两个层次来理解：
> 1. **公共流程**（所有工具共享的权限骨架）
> 2. **工具独特策略**（Bash / PowerShell 各自针对自身攻击面的专属防御）
>
> 与 [security.md](security.md)（公共流水线 + Bash 深度）、[bash-tool.md](bash-tool.md)、[powershell-tool.md](powershell-tool.md) 互补——本文档只讲**"公共 vs 独特"的分界线**，不重复三份文档的全文。

---

## 0. 一句话结论

权限安全不是单点检查，而是一条**分层流水线**：**公共层**保证"拦截机制统一且不可绕过"（bypass 免疫、dontAsk/auto 模式变换、钩子防绕过），**工具特有层**针对各自的攻击面（Bash＝命令注入与解析器差异；PowerShell＝Windows 凭据泄漏、cmdlet 别名规范化、脚本伪装）。任何一层放行都不等于工具能执行，只有所有允许条件同时满足才会真正运行。

---

## 1. 公共流程抽象（所有工具共享）

### 1.1 公共安全契约（Tool 接口）

任何工具都注册同一组"权限感知"方法（[Tool.ts:362](../src/Tool.ts#L362)），构成统一契约：

| 契约方法 | 职责 | 关键点 |
|---|---|---|
| `validateInput(input, ctx)` | 执行前校验，返回 `ValidationResult` | **不展示 UI**，只告诉模型为何失败 |
| `checkPermissions(input, ctx)` | 判权限，返回 `PermissionResult` | **只在 validateInput 通过后**调用；含工具特有逻辑 |
| `preparePermissionMatcher(input)` | 为 hook `if` 条件预编译匹配器 | 如 `Bash(git *)` |
| `isReadOnly(input)` | 只读判定 | 只读命令可自动放行 |
| `isDestructive(input)` | 不可逆操作标记 | 默认 false |
| `getPath(input)` | 暴露文件路径（供路径约束校验） | 可选 |
| `toAutoClassifierInput` | 供 auto 分类器生成紧凑表示 | 无关工具返回 `''` |

**核心分工**：`validateInput` 和 `checkPermissions` 是**分离的两道闸**——校验失败不触发 UI，权限失败才走规则/UI（Tool.ts:495 明确注释"checkPermissions 只在 validateInput 通过后调用"）。

### 1.2 公共权限评估总线 `hasPermissionsToUseTool`

入口在 [utils/permissions/permissions.ts:473](../src/utils/permissions/permissions.ts#L473)，是 `CanUseToolFn` 的总实现，分内外两层：

```
hasPermissionsToUseTool（总入口）
└─ hasPermissionsToUseToolInner（逐步骤核心评估，permissions.ts:1158）
    ├─ 1a 整工具 deny 规则        → deny
    ├─ 1b 整工具 ask 规则         → ask
    ├─ 1c 工具实现 checkPermissions → 委托给工具特有逻辑（Bash/PS 各自入口）
    ├─ 1d checkPermissions=deny    → deny
    ├─ 1e requiresUserInteraction  → 强制 ask（bypass 免疫）
    ├─ 1f content 级 ask 规则      → ask（bypass 免疫）
    ├─ 1g safetyCheck             → ask（bypass 免疫，如 .git/ 路径）
    ├─ 2a 模式层 bypass/plan      → allow
    ├─ 2b 整工具 allow 规则        → allow
    └─ 3 passthrough → 转 ask
└─ 外层：对 ask 做模式变换
    ├─ dontAsk       → 降级 deny
    ├─ auto          → AI 分类器（先试 acceptEdits 快路径 → 白名单 → classify）
    └─ 无头           → PermissionRequest 钩子 → 否则自动 deny
```

**最关键设计（bypass 免疫）**：步骤 1a~1g **全部发生在 2a（bypassPermissions 检查）之前**。即使开启完全绕过模式，**deny 规则、safety check、需要用户交互的工具依然生效**。同理，外层 `dontAsk`/`auto` 变换对不可分类器审批的 `safetyCheck` 免疫（permissions.ts:532-548），`acceptEdits` 快路径也对 `Agent`/`REPL` 工具跳过（防 VM 逃逸，permissions.ts:600）。

### 1.3 钩子专用变体 `checkRuleBasedPermissions`

[permissions.ts:1071](../src/utils/permissions/permissions.ts#L1071) 只跑 1a~1g 的规则子集（2a 之前），供 `services/tools/toolHooks.ts`：**PreToolUse 钩子返回 allow 时仍尊重 deny/ask/safety 规则**，防止钩子绕过权限系统。

### 1.4 半公共的半工具层（shellRuleMatching）

[utils/permissions/shellRuleMatching.ts](../src/utils/permissions/shellRuleMatching.ts) 被 Bash 与 PowerShell **共同复用**：`parsePermissionRule`、`matchWildcardPattern`、`suggestionForExactCommand`。这是"公共"的第二个层次——比整工具契约更具体，但仍是共享代码，两工具在此之上各自做规范化扩展。

---

## 2. 独特 vs 独立的判定标准

如何判断一个机制是"公共的"还是"工具独特的"？**看代码所属目录与是否被复用**：

| 归属 | 判定 | 例子 |
|---|---|---|
| 公共 | 在 `utils/permissions/`，被所有工具引用 | `hasPermissionsToUseTool`、`shellRuleMatching` |
| 工具独特 | 在 `tools/<Tool>/` 下，实现与另一工具**同名但独立** | `pathValidation.ts`、`modeValidation.ts`、`readOnlyValidation.ts`（两工具各有一份） |
| 工具独占 | 只在某工具目录出现，另一工具没有对应物 | Bash：`shouldUseSandbox.ts`、`sedValidation.ts`；PS：`gitSafety.ts` |

> 注意：Bash 和 PowerShell 都有 `pathValidation.ts` / `modeValidation.ts` / `readOnlyValidation.ts`，**但它们是完全独立的实现**（防御思路相近，代码不同），属于"工具独特策略"，不属于公共层。两工具唯一真正共享的工具层代码是 `shellRuleMatching`。

---

## 3. Bash 的独特安全策略

Bash 是最大攻击面（命令注入），防御最深（[bashPermissions.ts](../src/tools/BashTool/bashPermissions.ts) 2621 行）。详见 [bash-tool.md](bash-tool.md)、[security.md](security.md)，此处只提炼"独特"点：

### 3.1 tree-sitter 树级安全解析（独有边界）
`bashToolHasPermission`（[bashPermissions.ts:1663](../src/tools/BashTool/bashPermissions.ts#L1663)）用 tree-sitter 产出干净 `SimpleCommand[]`，三态分发：
- **simple** → `checkSemantics` 按名拒绝危险内建（`eval`/`source`/`exec`/`trap`/zsh 内建）
- **too-complex** → 保守 ask；`checkEarlyExitDeny` 保证 deny 规则**不被降级为 ask**
- **parse-unavailable** → 回退 legacy 正则

**独特点**：AST 解析成功时**跳过** legacy 注入 regex（避免误报），两者互为补充而非叠加。

### 3.2 沙箱机制（PowerShell 无）
- `shouldUseSandbox`（[shouldUseSandbox.ts:130](../src/tools/BashTool/shouldUseSandbox.ts#L130)）：全局启用 + `dangerouslyDisableSandbox`策略允许 + excludedCommands，三者决定是否进沙箱
- `checkSandboxAutoAllow`（[bashPermissions.ts:1270](../src/tools/BashTool/bashPermissions.ts#L1270)）：沙箱+autoAllow 时自动放行，但对**复合命令每个子命令先查 deny/ask**，且 **subcommand deny 先于 full-command ask**（防 `rm:*` 被 `echo hi && rm -rf /` 绕过，防 deny 降级 ask）
- **安全声明**：`excludedCommands` 是用户便利功能，**非安全边界**（真正的安全控制是沙箱权限系统）

### 3.3 sed 预览批准通道（独家）
`_simulatedSedEdit` 隐藏字段（[BashTool.tsx:243](../src/tools/BashTool/BashTool.tsx#L243)）配套 `sedValidation.ts`——只读 checkPermissions 前先算好的 sed 编辑结果，经用户预览审批后回填；**从模型可见 schema 中剔除**，防止模型用无关命令 + 任意文件写绕过沙箱和权限。

### 3.4 Bash 分类器（BASH_CLASSIFIER）
`buildPendingClassifierCheck` / `startSpeculativeClassifierCheck` / `awaitClassifierAutoApproval`：权限请求发出前先跑 Haiku 分类器，可自动批准或裁决；deny 描述集优先于 ask 描述集。

---

## 4. PowerShell 的独特安全策略

详见 [powershell-tool.md](powershell-tool.md)，此处提炼"独特"点：

### 4.1 collect-then-reduce 决策归并（与 Bash 根本架构差异）
`powershellToolHasPermission`（[powershellPermissions.ts:639](../src/tools/PowerShellTool/powershellPermissions.ts#L639)）把 post-parse 所有决策推入 `decisions[]`，最后统一 **reduce：deny > ask > allow > passthrough**。
- Bash 是**顺序早期返回**（早期 `return ask` 可能掩盖后续 `deny`）
- PowerShell 从**结构上封闭"ask 掩盖 deny"漏洞类别**（bash 曾有 stash 单点修复，这里更彻底）

### 4.2 原生 PowerShell AST 解析（非 tree-sitter）
用 `parsePowerShellCommand` 得可靠 AST，校验资源全用于**能力枚举**（cmdlet 白名单、参数类型），而非对抗解析器差异。

### 4.3 elementTypes 逐参数 AST 白名单（独家）
对命令**每个参数**做元素类型白名单，只有 `StringConstant`/`Parameter` 才静态可证，捕获 `-Path:(1 > /tmp/x)`（colon-bound 表达式）与 `Remove-Item $env:PATH`（变量展开）；`argLeaksValue` 兜底。

### 4.4 provider / UNC 双重凭据防线（独家，Windows 特有）
`env:`/`HKLM:`/`Registry::` 等**非文件系统 provider 路径**扫描 + `containsVulnerableUncPath`（防 NTLM/Kerberos 凭据泄漏）。

### 4.5 6 处 nameType 门控（独家）
`scripts\Get-Content` 剥离模块前缀后误匹配 cmdlet allow 规则 → 在 6 个位置门控 `nameType === 'application'`，防"无害命令名 + 相对路径脚本执行"绕过（`Path:\Build.ps1` 执行本地脚本而非 cmdlet）。

### 4.6 git 复合守卫（比 Bash 更全）
cd+git、裸 git 仓库（bare-repo）、git-internal 写、**归档解压 TOCTOU**（`tar -xf x.tar; git status` 检查后植入造仓库指示）。

### 4.7 acceptEdits 模式校验（checkPermissionMode）
[modeValidation.ts:132](../src/tools/PowerShellTool/modeValidation.ts#L132)：acceptEdits 模式要求命令**仅由文件系统修改 cmdlet** 组成才自动放行，对子表达式/脚本块/成员调用/splatting/赋值/stop-parsing/可展开字符串逐一拒绝。

### 4.8 auto 模式内置闸（非 ant 构建）
非 ant 构建下 PowerShell 在 auto 模式**不参与分类器审批**，必须显式交互确认（permissions.ts:572）。这是对 PS 破坏力的保守默认。

---

## 5. 总对比表：公共 vs 独特

| 维度 | 公共（所有工具） | Bash 独特 | PowerShell 独特 |
|---|---|---|---|
| 权限入口 | `hasPermissionsToUseTool` | `bashToolHasPermission` | `powershellToolHasPermission` |
| 规则引擎 | 整工具 deny/ask/allow | 子命令前缀/通配 + 路径约束 | 子命令 + **规范化命令名**（别名→原命令）+ 路径约束 |
| 规则解析 | `shellRuleMatching`（共享） | 在其上做 AST argv 重解析 | 在其上做 **canonical 别名解析**（`rm`→`Remove-Item`） |
| 解析器 | — | tree-sitter + legacy 正则 | **原生 PS AST** |
| 决定语义 | allow/deny/ask/passthrough | 顺序早期返回 | **collect-then-reduce** |
| 沙箱 | — | **有**（shouldUseSandbox + auto-allow） | **无**（策略强制时整体拒绝 `WINDOWS_SANDBOX_POLICY_REFUSAL`） |
| 隐藏字段 | — | `_simulatedSedEdit` + `sedValidation` | 无 |
| 注入检测 | — | regex 验证器（AST 成功则跳过） | `powershellCommandIsSafe`（AST 强化） |
| 参数校验 | — | 字符串 `$` 检查 | **elementTypes 逐参数白名单** |
| 凭据/路径 | — | UNC | **provider 路径 + UNC 双重** |
| 模式自动放行 | auto 分类器通用 | 分类器 + 沙箱 auto-allow | **非 ant 下 auto 模式强制人工确认** |
| nameType 门控 | — | 无直接对应 | **6 处** |

---

## 6. 相关文档

- [security.md](security.md) — 工具调用全流程安全防御（公共流水线 + Bash 深度）
- [bash-tool.md](bash-tool.md) — Bash 工具全拆解（含权限检查 / 沙箱）
- [powershell-tool.md](powershell-tool.md) — PowerShell 工具全拆解（含权限 / 校验器 / 与 Bash 关键差异 14.4）
- 源码目录：
  - `src/utils/permissions/` — 公共权限核心（`permissions.ts`、`shellRuleMatching.ts`）
  - `src/tools/BashTool/` — Bash 防御（`bashPermissions.ts`、`bashSecurity.ts`、`shouldUseSandbox.ts`、`sedValidation.ts`）
  - `src/tools/PowerShellTool/` — PowerShell 防御（`powershellPermissions.ts`、`powershellSecurity.ts`、`modeValidation.ts`、`gitSafety.ts`）
