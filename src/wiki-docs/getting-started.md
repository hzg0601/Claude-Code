# 快速开始

本指南介绍如何在本还原仓库中搭建开发环境、运行 Claude Code CLI，以及如何验证改动。

## 环境要求

| 工具 | 最低版本 | 说明 |
|------|---------|------|
| Bun | 1.3.5 | 包管理器与运行时（`packageManager: bun@1.3.5`） |
| Node.js | 24.0.0 | 部分子进程与原生模块依赖 |
| 操作系统 | — | Windows 11 / macOS / Linux 均可 |

仓库为 TypeScript + ESM，无独立 lint / test 套件，验证以「跑通对应路径」为准（见 [AGENTS.md](../../AGENTS.md)）。

## 安装

```bash
bun install
```

`bun install` 会安装 `package.json` 中的全部依赖，以及 `shims/` 目录下的本地包（`color-diff-napi`、`modifiers-napi`、`url-handler-napi`、`@ant/*` 等）。这些 shim 包是还原树中替代原生二进制模块的占位实现。

## 运行

`package.json` 暴露三个脚本：

| 命令 | 作用 |
|------|------|
| `bun run dev` | 启动还原版 CLI 入口，交互式 REPL |
| `bun run start` | `dev` 的别名 |
| `bun run version` | 验证 CLI 能启动并打印版本号 |

### 启动链路

```bash
bun run dev
  ↓
src/dev-entry.ts        # 还原工作区入口
  ↓ 扫描 src/ 与 vendor/ 中的缺失相对导入
  ↓ 若 missing_relative_imports > 0 → 打印报告并退出
  ↓ 若为 0 → 转发到原始 CLI 引导
src/entrypoints/cli.tsx # 启动引导，处理 --version / --dump-system-prompt 等快速路径
  ↓ 动态 import('../main.js')
src/main.tsx            # main()：渲染 Ink TUI、注册命令、启动查询引擎
```

`dev-entry.ts` 的核心职责是「在源码尚未完整还原前给出可用的工作区报告」；当缺失相对导入数降到 0，它会自动转发到 `entrypoints/cli.tsx`，最终调用 `main.tsx` 的 `main()`。

### 快速验证

```bash
bun run version
# 期望输出：999.0.0-restored (Claude Code)
```

若 `dev-entry.ts` 检测到缺失相对导入，`--version` 会附加 `(restored dev workspace)` 与 `missing_relative_imports=N`。

## 项目结构

```
Claude-Code/
├── src/                # TypeScript 源码（还原主体）
│   ├── main.tsx        # 主入口
│   ├── dev-entry.ts    # 还原工作区入口
│   ├── entrypoints/    # CLI / SDK / MCP 引导
│   ├── commands/       # 102 个 slash 命令实现
│   ├── tools/          # 内置工具
│   ├── services/       # 服务层（api / analytics / mcp / oauth / plugins ...）
│   ├── components/     # React + Ink UI 组件
│   ├── utils/          # 工具函数
│   ├── wiki-docs/      # 本知识库
│   └── ...
├── vendor/             # 还原的原生模块源码
├── shims/              # 本地 shim 包（替代原生二进制）
├── docs/               # 隐藏功能分析文档（buddy / kairos / ultraplan ...）
├── package.json
├── tsconfig.json
└── AGENTS.md           # 仓库贡献指南
```

## TypeScript 配置要点

`tsconfig.json` 的关键设置：

```jsonc
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": false,            // 非严格模式，匹配还原源码风格
    "paths": { "src/*": ["./src/*"] }  // 允许 src/* 路径别名
  },
  "include": ["src/**/*", "vendor/**/*", "shims/**/*"]
}
```

- **ESM**：`"type": "module"`，导入路径需带 `.js` 后缀（指向 `.ts` 源文件）
- **JSX**：`react-jsx`，无需 `import React`
- **路径别名**：`src/*` 映射到 `./src/*`，跨目录导入用 `src/utils/...` 形式
- **非严格**：`strict: false`，允许隐式 any 与未检查 null

## 开发工作流

1. **改 TypeScript 模块**：直接编辑 `src/` 下对应文件
2. **烟囱验证**：`bun run dev` 启动 CLI，手动复现改动路径
3. **聚焦验证**：仓库无统一 test 脚本，按 [AGENTS.md](../../AGENTS.md) 指引对改动的命令 / 服务 / UI 路径做手动验证
4. **类型检查**：可选，用 `bunx tsc --noEmit` 检查（`strict: false` 下宽松）

### 改动后验证示例

```bash
# 改了 commands/ 下的命令
bun run dev
> /help          # 确认命令注册正常
> /your-command  # 确认命令执行

# 改了 services/api/ 下的 API 调用
bun run dev
> 触发一次对话    # 确认 API 请求链路正常

# 改了 UI 组件
bun run dev
# 观察终端渲染
```

## 还原说明

本仓库是从 `@anthropic-ai/claude-code` npm 包的 source map 还原的源码树，**非上游原始仓库**。注意：

- **非官方**：仅供研究学习，版权归 Anthropic 所有
- **编译时裁剪**：外部发布版通过 `feature()` 编译开关移除了大量内部功能（见 [docs/07-feature-gates.md](../../docs/07-feature-gates.md)）
- **`USER_TYPE` 门控**：`USER_TYPE=ant` 解锁内部功能，外部默认 `external`
- **dev-entry 守卫**：`dev-entry.ts` 扫描所有相对导入，缺失时不会尝试启动完整 REPL，避免运行时崩溃
- **shims 替代**：原生二进制模块（图像处理、修饰键、URL handler）由 `shims/` 下的占位包替代，功能可能不完整

### 三层门控速查

```
第一层  feature('FLAG')     编译时 DCE，外部版代码被移除
第二层  USER_TYPE === 'ant' 运行时内部/外部判断
第三层  GrowthBook tengu_*  远程 A/B 开关，动态控制
```

详细分析见 [docs/07-feature-gates.md](../../docs/07-feature-gates.md)。

## 常见问题

### `bun run dev` 打印 missing_relative_imports 并退出

说明还原尚未完整，部分 `.ts` 文件引用了不存在的相对路径。按报告的 `importer -> specifier` 列表补齐缺失文件，或继续还原工作。

### 启动后立即崩溃

检查是否设置了 `USER_TYPE=ant` 但缺少对应内部模块；或原生 shim 包未正确安装（重跑 `bun install`）。

### 如何查看系统提示词

```bash
# ant-only，外部版被 feature() 裁剪
USER_TYPE=ant bun run dev -- --dump-system-prompt
```

## 相关文档

- [项目概述](./overview.md) - 项目简介与整体架构
- [架构设计](./architecture.md) - 系统分层与模块依赖
- [工具系统](./modules/tools.md) - 工具开发指南
- [命令系统](./modules/commands.md) - 命令注册机制
