# 插件系统

插件系统是 Claude Code 的扩展机制，允许用户从 marketplace 安装命令、agent、技能、钩子、MCP 服务器、LSP 服务器、输出样式与通道。插件通过 manifest 声明组件，由 loader 加载，按 scope（user/project/local）安装与启用。

## 插件架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Plugin System                             │
├─────────────────────────────────────────────────────────────┤
│  Manifest           │  Loader             │  Components     │
│  plugin.json        │  loadPluginManifest │  commands       │
│  (PluginManifest    │  loadPluginFromDir  │  agents         │
│   Schema)           │                     │  skills         │
│                     │                     │  hooks          │
├─────────────────────────────────────────────────────────────┤
│  Marketplace        │  安装与作用域        │  内置插件        │
│  marketplace.json   │  install/uninstall  │  builtinPlugins │
│  (PluginMarketplace │  enable/disable     │  (@builtin)     │
│   Schema)           │  update             │                 │
├─────────────────────────────────────────────────────────────┤
│  配置                                                 │
│  settings.json: enabledPlugins / extraKnownMarketplaces│
│  / strictKnownMarketplaces (hostPattern/pathPattern)   │
└─────────────────────────────────────────────────────────────┘
```

位置：`plugins/`（内置）、`utils/plugins/`（schema 与 loader）、`services/plugins/`（安装操作）、`types/plugin.ts`（类型）。

## 插件目录结构

`utils/plugins/pluginLoader.ts` 定义的标准结构：

```
my-plugin/
├── plugin.json          # 可选 manifest（PluginManifestSchema）
├── commands/            # 自定义 slash 命令
│   ├── build.md
│   └── deploy.md
├── agents/              # 自定义 AI agent
│   └── test-runner.md
├── skills/              # 技能目录
├── hooks/
│   └── hooks.json       # 钩子配置（HooksSchema）
├── output-styles/       # 输出样式
├── channels/            # 通道定义
├── mcp-servers/         # MCP 服务器配置
└── lsp-servers/         # LSP 服务器配置
```

加载器容忍缺失组件——插件可以只有任意子集；缺失组件记为错误但不阻止加载其他组件。

## Manifest Schema

`PluginManifestSchema`（`utils/plugins/schemas.ts`）由多个分 schema 合成：

```typescript
export const PluginManifestSchema = lazySchema(() =>
  z.object({
    ...PluginManifestMetadataSchema().shape,
    ...PluginManifestHooksSchema().partial().shape,
    ...PluginManifestCommandsSchema().partial().shape,
    ...PluginManifestAgentsSchema().partial().shape,
    ...PluginManifestSkillsSchema().partial().shape,
    ...PluginManifestOutputStylesSchema().partial().shape,
    ...PluginManifestChannelsSchema().partial().shape,
    ...PluginManifestMcpServerSchema().partial().shape,
    ...PluginManifestLspServerSchema().partial().shape,
    ...PluginManifestSettingsSchema().partial().shape,
    ...PluginManifestUserConfigSchema().partial().shape,
  }),
)
```

### 元数据字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 唯一标识（kebab-case，无空格） |
| `version` | string? | semver，如 `1.2.3` |
| `description` | string? | 用户可见说明 |
| `author` | PluginAuthor? | 作者信息 |
| `homepage` | url? | 主页 URL |
| `repository` | string? | 源码仓库 URL |
| `license` | string? | SPDX 标识（如 `MIT`） |
| `keywords` | string[]? | 搜索关键词 |

### 组件字段

每个组件字段允许内联声明或指向外部文件路径（相对 plugin root）：

| 字段 | 说明 |
|------|------|
| `hooks` | 钩子配置（见 [钩子系统](./hooks.md)） |
| `commands` | 额外命令文件/目录，或 `{name: CommandMetadata}` 映射 |
| `agents` | 额外 agent markdown 文件 |
| `skills` | 额外技能目录 |
| `outputStyles` | 输出样式 |
| `channels` | 通道定义 |
| `mcpServers` | MCP 服务器配置（`Record<string, McpServerConfig>`） |
| `lspServers` | LSP 服务器配置（`Record<string, LspServerConfig>`） |
| `settings` | 插件提供的设置 |
| `userConfig` | 用户配置定义 |

## 插件组件类型

`types/plugin.ts` 的 `PluginComponent` 描述插件可提供的组件类型：

- **commands**：slash 命令（`/plugin-name:command`）
- **agents**：自定义 agent 定义
- **skills**：技能
- **hooks**：钩子配置
- **mcpServers**：MCP 服务器
- **lspServers**：LSP 服务器
- **outputStyles**：输出样式
- **channels**：通道

`LoadedPlugin` 是加载完成的插件实例，包含 manifest 与各组件的加载结果；`PluginError` 描述加载错误，`getPluginErrorMessage` 提取错误消息。

## Marketplace 系统

### marketplace.json

`PluginMarketplaceSchema`（`utils/plugins/schemas.ts`）：

```typescript
export const PluginMarketplaceSchema = lazySchema(() =>
  z.object({
    name: MarketplaceNameSchema(),
    owner: PluginAuthorSchema(),
    plugins: z.array(PluginMarketplaceEntrySchema()),
    forceRemoveDeletedPlugins: z.boolean().optional(),
    metadata: z.object({
      pluginRoot: z.string().optional(),
      version: z.string().optional(),
      description: z.string().optional(),
    }).optional(),
    allowCrossMarketplaceDependenciesOn: z.array(z.string()).optional(),
  }),
)
```

- **`name`**：marketplace 名（与 `ALLOWED_OFFICIAL_MARKETPLACE_NAMES` 校验）
- **`owner`**：维护者信息
- **`plugins`**：插件条目数组
- **`forceRemoveDeletedPlugins`**：从 marketplace 移除的插件自动卸载
- **`allowCrossMarketplaceDependenciesOn`**：允许作为依赖自动安装的 marketplace 名单（仅根 marketplace 的 allowlist 生效，无传递信任）

### Marketplace 来源

`MarketplaceSourceSchema`（discriminated union by `source`）：

| source | 字段 | 说明 |
|--------|------|------|
| `url` | `url`, `headers?` | 直接 URL 到 marketplace.json |
| `github` | `repo`, `ref?`, `path?`, `sparsePaths?` | GitHub 仓库（owner/repo），支持稀疏检出 |
| `git` | `url`, `ref?`, `path?` | 任意 git URL |
| `npm` | `package`, `version?`, `registry?` | npm 包含 marketplace.json |
| `file` / `directory` | path | 本地文件/目录 |
| `hostPattern` | `hostPattern` | 主机名白名单 |
| `pathPattern` | `pathPattern` | 文件路径正则白名单 |
| `settings` | `name`, `plugins`, `owner?` | settings.json 内联 marketplace |

### 插件来源（PluginSourceSchema）

每个 marketplace 条目的 `source` 描述如何获取插件：

| source | 字段 | 说明 |
|--------|------|------|
| 相对路径 | path | 相对 marketplace root |
| `npm` | `package`, `version?`, `registry?` | npm 包 |
| `pip` | `package`, `version?`, `registry?` | Python PyPI 包 |
| `url` | `url` | 直接 URL |
| `github` | `repo`, `ref?`, `path?` | GitHub 仓库 |
| `git` | `url`, `ref?`, `path?` | git URL |
| `file` / `directory` | path | 本地 |

### 官方 marketplace

- **`anthropics/*`**：官方 GitHub 来源（`ALLOWED_OFFICIAL_MARKETPLACE_NAMES`）
- **`BUILTIN_MARKETPLACE_NAME = 'builtin'`**：内置插件专用 marketplace 名

```typescript
// plugins/builtinPlugins.ts
export const BUILTIN_MARKETPLACE_NAME = 'builtin'
```

## 安装与作用域

`services/plugins/pluginOperations.ts` 提供安装操作：

```typescript
export const VALID_INSTALLABLE_SCOPES = ['user', 'project', 'local'] as const

export async function installPluginOp(...)
export async function uninstallPluginOp(...)
export async function enablePluginOp(...)
export async function disablePluginOp(...)
export async function disableAllPluginsOp(): Promise<PluginOperationResult>
export async function updatePluginOp(...)
export async function setPluginEnabledOp(...)
```

### 作用域

| Scope | 存储位置 | 说明 |
|-------|---------|------|
| `user` | 全局用户设置 | 对该用户所有项目生效 |
| `project` | 项目 `.claude/settings.json` | 仅当前项目（用 `getOriginalCwd()`） |
| `local` | 本地项目设置 | 仅当前项目、当前用户 |

`getProjectPathForScope` 对 `project`/`local` 返回 `getOriginalCwd()`，对 `user` 返回 `undefined`。

### 缓存管理

`services/plugins/PluginInstallationManager.ts` + `utils/plugins/pluginLoader.ts` 管理插件缓存：

```typescript
export function getPluginCachePath(): string
export function getVersionedCachePathIn(...)
export function getVersionedZipCachePath(...)
export async function probeSeedCacheAnyVersion(...)
export function getLegacyCachePath(pluginName: string): string
export async function installFromNpm(...)
export async function gitClone(...)
export async function installFromGitSubdir(...)
export async function cachePlugin(...)
export async function copyPluginToVersionedCache(...)
```

支持 npm、git、git-subdir、url 四种安装来源，缓存按版本号隔离。

## 内置插件

位置：`plugins/builtinPlugins.ts` + `plugins/bundled/index.ts`。

```typescript
// plugins/builtinPlugins.ts
const BUILTIN_PLUGINS: Map<string, BuiltinPluginDefinition> = new Map()

export function registerBuiltinPlugin(definition: BuiltinPluginDefinition): void
export function isBuiltinPluginId(pluginId: string): boolean  // 以 @builtin 结尾
```

```typescript
// plugins/bundled/index.ts
export function initBuiltinPlugins(): void {
  // No built-in plugins registered yet — scaffolding for migrating bundled skills
}
```

`initBuiltinPlugins()` 在 CLI 启动时由 `main.tsx` 调用（`process.env.CLAUDE_CODE_ENTRYPOINT !== 'local-agent'` 时），目前为空脚手架，预留给未来从 bundled skills 迁移的功能。

### BuiltinPluginDefinition

```typescript
export type BuiltinPluginDefinition = {
  name: string
  description: string
  version?: string
  skills?: BundledSkillDefinition[]
  hooks?: HooksSettings
  mcpServers?: Record<string, McpServerConfig>
  isAvailable?: () => boolean
  defaultEnabled?: boolean  // 默认 true
}
```

### 与 bundled skills 的区别

| 特性 | 内置插件 | bundled skills |
|------|---------|---------------|
| 用户可开关 | ✅（`/plugin` UI） | ❌（自动启用） |
| 多组件 | ✅（skills+hooks+mcp） | 单一技能 |
| 标识 | `name@builtin` | 无独立 ID |

复杂设置或需要自动启用逻辑的功能用 `src/skills/bundled/`；用户应能显式开关的功能用内置插件。

## 加载流程

`loadPluginManifest` + `loadPluginFromDirectory`（`utils/plugins/pluginLoader.ts`）：

1. **manifest 校验**：读 `plugin.json`，用 `PluginManifestSchema` 校验；无 manifest 则构造默认
2. **扫描组件目录**：
   - `commands/` → `commandsPath`
   - `agents/` → `agentsPath`
   - `skills/` → 技能目录
   - `hooks/hooks.json` → `HooksSchema` 校验
3. **hooks 配置加载**：变量解析（`$ARGUMENTS` 等）、与 manifest 内联 hooks 合并
4. **重复名检测**：同名插件报错
5. **enable/disable 状态**：从设置读取
6. **错误收集**：缺失组件报错但不阻止其他组件加载

```typescript
// utils/plugins/pluginLoader.ts
// 重复 hooks 文件检测：
// "Duplicate hooks file detected: ${hookSpec} resolves to already-loaded file ${normalizedPath}.
//  The standard hooks/hooks.json is loaded automatically, so manifest.hooks should only reference additional hook files."
```

## 配置

`utils/settings/types.ts` 的设置字段：

### enabledPlugins

```jsonc
{
  "enabledPlugins": {
    "code-formatter@anthropic-tools": true,
    "db_assistant@company-internal": false
  }
}
```

按插件 ID 布尔值控制启用。

### extraKnownMarketplaces

预注册允许的 marketplace（不在官方列表内）。

### strictKnownMarketplaces

主机/路径白名单，控制允许的 marketplace 来源：

- `hostPattern`：限制网络来源主机名
- `pathPattern`：允许特定文件系统路径（如 `^/opt/approved/`，或 `.*` 放行全部）

## 插件 ID 格式

`PluginIdSchema`：`plugin-name@marketplace-name`

```
code-formatter@anthropic-tools
db_assistant@company-internal
my.plugin@personal-marketplace
```

两部分允许字母数字、连字符、点、下划线。内置插件以 `@builtin` 结尾。

## 相关文档

- [技能系统](../modules/skills.md) - 技能定义与 frontmatter
- [命令系统](../modules/commands.md) - slash 命令注册
- [钩子系统](./hooks.md) - 钩子配置格式
- [MCP 协议](./mcp.md) - MCP 服务器集成
