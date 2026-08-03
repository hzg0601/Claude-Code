# 技能系统

Claude Code 的技能系统提供了可重用的任务模板，允许用户通过简单的命令触发复杂的操作流程。

## 什么是技能

技能是预定义的任务模板，包含：
- **提示词模板**: 指导 AI 如何执行任务
- **工具限制**: 可选的工具白名单
- **参数定义**: 用户输入的处理方式
- **钩子配置**: 执行前后的自动化操作

## 技能类型

### 1. 内置技能 (Bundled Skills)

编译时内置的技能，对所有用户可用：

| 技能 | 描述 |
|------|------|
| `batch` | 批量处理任务 |
| `claudeApi` | Claude API 调用 |
| `debug` | 调试辅助 |
| `dream` | 创意生成 |
| `hunter` | 代码搜索 |
| `keybindings` | 快捷键管理 |
| `loop` | 循环执行 |
| `remember` | 记忆管理 |
| `simplify` | 代码简化 |
| `skillify` | 技能创建 |
| `stuck` | 困境帮助 |
| `verify` | 验证检查 |

### 2. 目录技能 (Directory Skills)

从 `skills/` 目录动态加载的技能：

```typescript
import { getSkillDirCommands } from './skills/loadSkillsDir'

const skillCommands = await getSkillDirCommands()
```

### 3. MCP 技能

通过 MCP 协议注册的技能：

```typescript
import { getMcpSkills } from './services/mcp/client'

const mcpSkills = await getMcpSkills()
```

### 4. 插件技能

通过插件系统加载的技能：

```typescript
import { getPluginSkills } from './utils/plugins/loadPluginCommands'

const pluginSkills = await getPluginSkills()
```

## 技能定义结构

```typescript
interface SkillDefinition {
  // 基本信息
  name: string
  description: string
  aliases?: string[]  // 别名
  
  // 使用条件
  whenToUse?: string
  argumentHint?: string
  
  // 限制配置
  allowedTools?: string[]  // 工具白名单
  model?: string  // 指定使用的模型
  disableModelInvocation?: boolean
  
  // 可见性
  userInvocable?: boolean  // 用户是否可直接调用
  isEnabled?: () => boolean  // 启用条件
  
  // 钩子配置
  hooks?: HooksSettings
  
  // 代理配置
  context?: 'inline' | 'fork'
  agent?: string
  
  // 附加文件（首次执行时解压到磁盘）
  files?: Record<string, string>
  
  // 提示词生成器
  getPromptForCommand: (
    args: string,
    context: ToolUseContext
  ) => Promise<ContentBlockParam[]>
}
```

## 技能注册

### 内置技能注册

```typescript
import { registerBundledSkill } from './skills/bundledSkills'

registerBundledSkill({
  name: 'example',
  description: '示例技能',
  whenToUse: '当需要示例代码时',
  argumentHint: '<主题>',
  allowedTools: ['Read', 'Write', 'Glob'],
  userInvocable: true,
  async getPromptForCommand(args, context) {
    return [{
      type: 'text',
      text: `请为 ${args || '通用主题'} 提供示例代码。`
    }]
  }
})
```

### 目录技能加载

目录技能自动从 `skills/` 目录加载：

```
skills/
├── my-skill/
│   ├── prompt.md      # 提示词模板
│   ├── config.yaml    # 技能配置
│   └── README.md      # 使用说明
```

## 技能执行流程

```
用户调用技能
    ↓
技能查找
    │
    ├─→ 内置技能 → 使用内置定义
    ├─→ 目录技能 → 读取技能文件
    ├─→ MCP 技能 → 通过 MCP 协议
    └─→ 插件技能 → 从插件加载
    ↓
参数处理
    ↓
提示词生成
    ↓
    ├─→ 禁用模型调用 → 直接返回
    └─→ 启用模型调用 → 发送给 AI
            ↓
        执行工具
            ↓
        返回结果
```

## 技能配置文件

### config.yaml 示例

```yaml
name: code-review
description: 代码审查技能
aliases: [review, cr]
whenToUse: 当需要审查代码变更时

# 工具限制
allowedTools:
  - Read
  - Grep
  - Glob
  - Bash

# 模型配置
model: claude-sonnet-4-6
disableModelInvocation: false

# 可见性
userInvocable: true

# 钩子配置
hooks:
  pre-execute:
    - type: log
      message: '开始代码审查...'
  post-execute:
    - type: notify
      message: '审查完成'

# 代理配置
context: fork
agent: code-reviewer
```

### prompt.md 示例

```markdown
# 代码审查

请审查以下代码变更：

{{args}}

## 审查要点

1. **正确性**: 代码是否按预期工作
2. **安全性**: 是否存在安全漏洞
3. **性能**: 是否有性能问题
4. **可维护性**: 代码是否清晰易读
5. **测试**: 是否包含足够的测试

请提供具体的改进建议。
```

## 技能发现

### 技能搜索

```typescript
// 技能搜索
const skills = await searchSkills({
  query: 'review',
  limit: 10
})
```

### 技能列表

```typescript
// 获取所有可用技能
const allSkills = [
  ...getBundledSkills(),
  ...await getSkillDirCommands(),
  ...await getMcpSkills(),
  ...await getPluginSkills()
]
```

## 技能组合

### 技能链

可以将多个技能组合成执行链：

```typescript
// 技能链示例
const reviewChain = [
  'code-review',      // 先审查代码
  'run-tests',        // 然后运行测试
  'update-docs'       // 最后更新文档
]
```

### 条件技能

根据条件动态选择技能：

```typescript
if (hasTypeScriptErrors) {
  return 'typescript-fix'
} else if (hasTestFailures) {
  return 'test-debug'
} else {
  return 'code-review'
}
```

## 技能开发最佳实践

### 命名规范

- 使用小写字母和连字符：`my-skill`
- 名称应清晰描述技能用途
- 避免与现有技能名称冲突

### 提示词设计

```markdown
# 好的提示词
- 明确任务目标
- 提供必要的上下文
- 包含输出格式要求
- 列出约束条件

# 避免
- 模糊的指令
- 缺少上下文
- 无输出要求
```

### 工具限制

只包含技能必需的工具：

```yaml
# 好的做法
allowedTools:
  - Read
  - Write
  - Glob

# 避免（过于宽松）
allowedTools:
  - '*'  # 不推荐
```

### 错误处理

```typescript
async getPromptForCommand(args, context) {
  try {
    // 技能逻辑
    return [{ type: 'text', text: result }]
  } catch (error) {
    return [{ 
      type: 'text', 
      text: `技能执行失败：${error.message}` 
    }]
  }
}
```

## 技能测试

```typescript
describe('code-review skill', () => {
  it('should generate review prompt', async () => {
    const skill = getBundledSkill('code-review')
    const prompt = await skill.getPromptForCommand(
      'src/index.ts',
      mockContext
    )
    expect(prompt).toBeDefined()
    expect(prompt[0].text).toContain('审查')
  })
})
```

## 技能发布

### 发布到插件

```bash
# 打包技能
npm run build:skill

# 发布到插件市场
npm publish
```

### 技能版本管理

```yaml
# config.yaml
name: my-skill
version: 1.0.0
minClaudeCodeVersion: 1.0.0
```

## 技能调试

### 启用调试日志

```typescript
process.env.DEBUG_SKILLS = 'true'
```

### 查看技能执行

```bash
# 查看技能执行日志
claude-code --verbose /my-skill args
```

## 相关文档

- [命令系统](./commands.md) - 命令系统文档
- [工具系统](./tools.md) - 工具系统文档
- [代理系统](./agents.md) - 代理系统文档
- [插件系统](../technical/plugins.md) - 插件开发指南
