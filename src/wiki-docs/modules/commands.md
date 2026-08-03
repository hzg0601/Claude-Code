# 命令系统

Claude Code 的命令系统提供了与用户交互的主要接口，包括 Slash 命令和本地命令两种类型。

## 命令类型

### 1. Slash 命令

以 `/` 开头的交互式命令，用户可以在会话中直接输入：

```
/plan 实现用户认证功能
/help
/compact
```

### 2. 本地命令

直接执行的 CLI 命令，通常通过命令行参数调用：

```bash
claude-code --help
claude-code --version
```

## 命令注册

### 命令定义结构

```typescript
interface Command {
  type: 'prompt' | 'function'
  name: string
  description: string
  contentLength?: number
  progressMessage?: string
  source: 'builtin' | 'plugin' | 'skill'
  getPromptForCommand?: (args: string[], context: Context) => Promise<string>
  execute?: (args: string[], context: Context) => Promise<void>
}
```

### 注册流程

1. **导入命令模块**: 在 `commands.ts` 中导入所有命令实现
2. **创建命令数组**: 将所有命令添加到 `allCommands` 数组
3. **条件注册**: 根据功能标志决定是否包含某些命令
4. **导出过滤器**: 提供 `filterCommandsForRemoteMode()` 用于远程会话

## 核心命令

### 基础命令

| 命令 | 描述 | 类型 |
|------|------|------|
| `/help` | 显示帮助信息 | Slash |
| `/compact` | 压缩会话历史 | Slash |
| `/plan` | 进入计划模式 | Slash |
| `/clear` | 清除会话缓存 | Slash |
| `/config` | 管理配置设置 | Slash |
| `/skills` | 列出可用技能 | Slash |
| `/agents` | 管理代理系统 | Slash |
| `/memory` | 查看和管理记忆 | Slash |
| `/tasks` | 任务列表管理 | Slash |
| `/permissions` | 查看权限设置 | Slash |

### 功能命令

| 命令 | 描述 | 功能标志 |
|------|------|----------|
| `/proactive` | 主动建议模式 | PROACTIVE, KAIROS |
| `/brief` | 生成任务摘要 | KAIROS, KAIROS_BRIEF |
| `/assistant` | 助手模式 | KAIROS |
| `/bridge` | 桥接通信 | BRIDGE_MODE |
| `/voice` | 语音模式 | VOICE_MODE |
| `/workflows` | 工作流脚本 | WORKFLOW_SCRIPTS |
| `/ultraplan` | 高级计划模式 | ULTRAPLAN |
| `/buddy` | 伙伴系统 | BUDDY |

### 开发命令

| 命令 | 描述 |
|------|------|
| `/doctor` | 诊断环境问题 |
| `/init` | 初始化项目配置 |
| `/mcp` | 管理 MCP 服务器 |
| `/plugin` | 插件管理 |
| `/reload-plugins` | 重新加载插件 |
| `/hooks` | 查看钩子配置 |
| `/stats` | 显示使用统计 |

### 会话管理

| 命令 | 描述 |
|------|------|
| `/session` | 会话管理 |
| `/resume` | 恢复之前的会话 |
| `/rename` | 重命名会话 |
| `/share` | 分享会话记录 |
| `/export` | 导出会话数据 |
| `/rewind` | 回滚会话状态 |

### 系统命令

| 命令 | 描述 |
|------|------|
| `/version` | 显示版本信息 |
| `/upgrade` | 升级到最新版本 |
| `/model` | 切换 AI 模型 |
| `/effort` | 设置推理努力程度 |
| `/statusline` | 配置状态行显示 |
| `/privacy-settings` | 隐私设置管理 |

### Ant 专属命令

仅限内部使用（`USER_TYPE=ant`）：

| 命令 | 描述 |
|------|------|
| `/agents-platform` | 代理平台管理 |
| `/backfill-sessions` | 回填会话数据 |
| `/tungsten` | Tungsten 调试工具 |
| `/config` | 高级配置管理 |
| `/insights` | 使用分析报告 |
| `/ant-trace` | 追踪调试信息 |
| `/perf-issue` | 性能问题分析 |

## 命令实现模式

### Prompt 类型命令

生成提示词并发送给 AI 模型：

```typescript
const help: Command = {
  type: 'prompt',
  name: 'help',
  description: '显示帮助信息',
  async getPromptForCommand(args, context) {
    return `用户请求帮助。请提供：
    1. 可用命令列表
    2. 常用命令示例
    3. 相关文档链接`
  }
}
```

### Function 类型命令

直接执行函数逻辑：

```typescript
const compact: Command = {
  type: 'function',
  name: 'compact',
  description: '压缩会话历史',
  async execute(args, context) {
    await compactHistory(context)
    console.log('会话已压缩')
  }
}
```

## 功能标志控制

命令可以通过功能标志进行条件注册：

```typescript
// 条件命令示例
const proactive =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('./commands/proactive.js').default
    : null

const voiceCommand = feature('VOICE_MODE')
  ? require('./commands/voice/index.js').default
  : null
```

## 远程会话支持

部分命令在远程会话模式下需要被过滤：

```typescript
export function filterCommandsForRemoteMode(
  commands: Command[]
): Command[] {
  return commands.filter(cmd => {
    // 保留核心功能命令
    return !REMOTE_EXCLUDED_COMMANDS.has(cmd.name)
  })
}
```

## 命令发现

### 内置命令

在 `commands.ts` 中静态注册的所有命令。

### 插件命令

通过插件系统动态加载的命令：

```typescript
import { getPluginCommands } from './utils/plugins/loadPluginCommands'

const pluginCommands = await getPluginCommands()
```

### 技能命令

通过技能目录动态发现的命令：

```typescript
import { getSkillDirCommands } from './skills/loadSkillsDir'

const skillCommands = await getSkillDirCommands()
```

## 命令执行流程

```
用户输入
    ↓
命令解析 (QueryEngine)
    ↓
    ├─→ Slash 命令识别
    │       ↓
    │   查找命令定义
    │       ↓
    │   ├─→ Prompt 类型 → 生成提示 → 发送给模型
    │   └─→ Function 类型 → 执行函数 → 返回结果
    │
    └─→ 自然语言 → 代理系统处理
```

## 最佳实践

### 命名规范

- 使用小写字母和连字符：`/my-command`
- 保持名称简短且具有描述性
- 避免与现有命令冲突

### 文档编写

每个命令应包含：
- 清晰的 `description`
- 参数说明（如适用）
- 使用示例

### 错误处理

```typescript
try {
  await executeCommand(args, context)
} catch (error) {
  console.error(`命令执行失败：${error.message}`)
  // 提供恢复建议
}
```

### 测试

```typescript
// 命令测试示例
describe('/compact command', () => {
  it('should compress session history', async () => {
    // 测试逻辑
  })
})
```

## 扩展命令系统

### 添加新命令

1. 在 `commands/` 目录创建新模块
2. 实现 `Command` 接口
3. 在 `commands.ts` 中导入并注册
4. 根据需要添加功能标志
5. 编写测试用例

### 示例：创建 Slash 命令

```typescript
// commands/hello/index.ts
import type { Command, CommandContext } from '../../Task'

export const hello: Command = {
  type: 'prompt',
  name: 'hello',
  description: '向用户问好',
  async getPromptForCommand(args, context) {
    const userName = context.user?.name || '用户'
    return `向 ${userName} 问好，并询问今天需要什么帮助。`
  }
}

// commands.ts 中注册
import hello from './commands/hello/index.js'

export const allCommands: Command[] = [
  // ... 其他命令
  hello,
]
```

## 相关文档

- [项目概述](../overview.md) - 项目简介
- [架构设计](../architecture.md) - 系统架构
- [技能系统](./skills.md) - 技能命令系统
- [API 参考](../api/commands.md) - 命令 API 接口文档
