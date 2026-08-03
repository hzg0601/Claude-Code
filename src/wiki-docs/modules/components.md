# UI 组件系统

Claude Code 的用户界面基于 React 和 Ink（终端 UI 渲染库）构建，提供了丰富的交互式组件。

## 组件架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Presentation Layer                        │
├─────────────────────────────────────────────────────────────┤
│  Screen Components   │  Message Components  │  Dialogs      │
│  - REPL              │  - Message             │  - Settings  │
│  - Doctor            │  - MessageResponse     │  - MCP       │
│  - Resume            │  - MessageRow          │  - Help      │
│                      │                        │              │
│  Layout Components   │  Input Components    │  Helpers      │
│  - FullscreenLayout  │  - TextInput           │  - Markdown  │
│  - LogSelector       │  - Select              │  - FilePath  │
│                      │                        │              │
│  Status Components   │  Feedback            │  Onboarding   │
│  - MemoryUsage       │  - FeedbackSurvey      │  - IDE      │
│  - DevBar            │  - SurveyPrompt        │  - Desktop  │
└─────────────────────────────────────────────────────────────┘
```

## 组件分类

### 1. 屏幕组件 (Screen Components)

位置：`screens/`

| 组件 | 描述 |
|------|------|
| `REPL` | 主交互式界面 |
| `Doctor` | 诊断工具界面 |
| `ResumeConversation` | 恢复会话界面 |

### 2. 消息组件 (Message Components)

位置：`components/`

| 组件 | 描述 |
|------|------|
| `Message` | 消息容器 |
| `MessageResponse` | AI 响应显示 |
| `MessageRow` | 消息行布局 |
| `MessageModel` | 消息数据模型 |

### 3. 对话框组件 (Dialog Components)

| 组件 | 描述 |
|------|------|
| `HelpV2` | 帮助对话框 |
| `MCPServerDialog` | MCP 服务器配置 |
| `SettingsDialog` | 设置对话框 |
| `ExportDialog` | 导出对话框 |

### 4. 布局组件 (Layout Components)

| 组件 | 描述 |
|------|------|
| `FullscreenLayout` | 全屏布局 |
| `LogSelector` | 日志选择器 |
| `BaseTextInput` | 基础文本输入 |

### 5. 状态指示器 (Status Indicators)

| 组件 | 描述 |
|------|------|
| `MemoryUsageIndicator` | 内存使用指示 |
| `DevBar` | 开发者工具栏 |
| `IdeStatusIndicator` | IDE 连接状态 |

### 6. 反馈组件 (Feedback Components)

| 组件 | 描述 |
|------|------|
| `FeedbackSurvey` | 反馈调查 |
| `FeedbackSurveyView` | 调查视图 |
| `TranscriptSharePrompt` | 分享提示 |

## 核心组件详解

### REPL 组件

主交互式界面，处理用户输入和显示响应。

```typescript
// REPL.tsx 结构
interface REPLProps {
  messages: Message[]
  isProcessing: boolean
  onSubmit: (query: string) => void
}

export function REPL({ messages, isProcessing, onSubmit }: REPLProps) {
  return (
    <Box flexDirection="column">
      <Messages messages={messages} />
      <InputArea onSubmit={onSubmit} disabled={isProcessing} />
    </Box>
  )
}
```

### 消息组件

```typescript
// Message.tsx
interface MessageProps {
  message: Message
  isLast: boolean
  showModel: boolean
}

export function Message({ message, isLast, showModel }: MessageProps) {
  return (
    <Box flexDirection="column" marginY={1}>
      <MessageHeader message={message} />
      <MessageContent message={message} />
      {showModel && <MessageModelIndicator model={message.model} />}
    </Box>
  )
}
```

### Markdown 渲染

```typescript
// Markdown.tsx
import { transformMarkdown } from './utils/markdown'

interface MarkdownProps {
  content: string
  highlightCode?: boolean
}

export function Markdown({ content, highlightCode }: MarkdownProps) {
  const nodes = transformMarkdown(content)
  
  return (
    <Box flexDirection="column">
      {nodes.map((node, i) => (
        <MarkdownNode key={i} node={node} />
      ))}
    </Box>
  )
}
```

## Ink 渲染基础

### 基本布局

```typescript
import { Box, Text, useApp } from 'ink'

export function BasicLayout() {
  const { exit } = useApp()
  
  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>Claude Code</Text>
      </Box>
      
      <Box>
        <Text>Content here</Text>
      </Box>
    </Box>
  )
}
```

### 交互式输入

```typescript
import { TextInput } from 'ink-text-input'
import { useState } from 'ink'

export function InputExample() {
  const [value, setValue] = useState('')
  
  return (
    <Box>
      <Text>{'> '}</Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
      />
    </Box>
  )
}
```

## 自定义组件

### 文件路径链接

```typescript
// FilePathLink.tsx
interface FilePathLinkProps {
  path: string
  line?: number
  onClick?: (path: string) => void
}

export function FilePathLink({ path, line, onClick }: FilePathLinkProps) {
  const displayPath = line ? `${path}:${line}` : path
  
  return (
    <Text 
      color="blue"
      underline
      onClick={() => onClick?.(path)}
    >
      {displayPath}
    </Text>
  )
}
```

### 高亮代码

```typescript
// HighlightedCode.tsx
interface HighlightedCodeProps {
  code: string
  language: string
  showLineNumbers?: boolean
}

export function HighlightedCode({ 
  code, 
  language,
  showLineNumbers 
}: HighlightedCodeProps) {
  const highlighted = highlight(code, language)
  
  return (
    <Box flexDirection="column" backgroundColor="black" padding={1}>
      {showLineNumbers && (
        <Box marginRight={2}>
          {code.split('\n').map((_, i) => (
            <Text key={i} color="gray">{i + 1}</Text>
          ))}
        </Box>
      )}
      <Text>{highlighted}</Text>
    </Box>
  )
}
```

### 自定义选择器

```typescript
// CustomSelect/select.tsx
interface SelectProps<T> {
  options: T[]
  value: T | null
  onChange: (value: T) => void
  renderOption: (option: T) => string
}

export function Select<T>({
  options,
  value,
  onChange,
  renderOption
}: SelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false)
  
  return (
    <Box>
      <Box onClick={() => setIsOpen(true)}>
        {value ? renderOption(value) : 'Select...'}
      </Box>
      
      {isOpen && (
        <Box flexDirection="column" borderStyle="round">
          {options.map((opt) => (
            <Box
              key={JSON.stringify(opt)}
              onClick={() => {
                onChange(opt)
                setIsOpen(false)
              }}
            >
              {renderOption(opt)}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}
```

## 对话框系统

### 基础对话框

```typescript
// Dialog 基础结构
interface DialogProps {
  title: string
  isOpen: boolean
  onClose: () => void
  children: React.ReactNode
}

export function Dialog({ title, isOpen, onClose, children }: DialogProps) {
  if (!isOpen) return null
  
  return (
    <Box 
      flexDirection="column"
      borderStyle="round"
      borderColor="blue"
      padding={1}
    >
      <Box marginBottom={1}>
        <Text bold>{title}</Text>
      </Box>
      
      {children}
      
      <Box marginTop={1}>
        <Text dimColor>Press Esc to close</Text>
      </Box>
    </Box>
  )
}
```

### MCP 服务器对话框

```typescript
// MCPServerDialog.tsx
interface MCPServerDialogProps {
  server: MCPServer
  onSave: (config: MCPConfig) => void
  onClose: () => void
}

export function MCPServerDialog({
  server,
  onSave,
  onClose
}: MCPServerDialogProps) {
  const [config, setConfig] = useState(server.config)
  
  return (
    <Dialog title="Configure MCP Server" onClose={onClose}>
      <Box flexDirection="column">
        <Text>Transport: {server.transport}</Text>
        <Text>URL: {server.url}</Text>
        
        <Box marginTop={1}>
          <Button label="Save" onClick={() => onSave(config)} />
          <Button label="Cancel" onClick={onClose} />
        </Box>
      </Box>
    </Dialog>
  )
}
```

## 状态管理

### 全局状态钩子

```typescript
// hooks/useAppState.ts
import { useState, useEffect } from 'ink'
import { getAppState } from '../bootstrap/state'

export function useAppState() {
  const [state, setState] = useState(getAppState())
  
  useEffect(() => {
    const unsubscribe = subscribeToStateChanges((newState) => {
      setState(newState)
    })
    
    return unsubscribe
  }, [])
  
  return state
}
```

### 本地状态

```typescript
// 组件内部状态
export function Counter() {
  const [count, setCount] = useState(0)
  
  useInput((input) => {
    if (input === '+') setCount(c => c + 1)
    if (input === '-') setCount(c => c - 1)
  })
  
  return <Text>Count: {count}</Text>
}
```

## 键盘快捷键

```typescript
// hooks/useKeyboardShortcuts.ts
import { useInput } from 'ink'

interface Shortcut {
  key: string
  handler: () => void
  description: string
}

export function useKeyboardShortcuts(
  shortcuts: Shortcut[]
) {
  useInput((input) => {
    const shortcut = shortcuts.find(s => s.key === input)
    if (shortcut) {
      shortcut.handler()
    }
  })
}

// 使用示例
useKeyboardShortcuts([
  { key: 'q', handler: quit, description: 'Quit' },
  { key: '?', handler: showHelp, description: 'Help' },
  { key: 'c', handler: clear, description: 'Clear' }
])
```

## 响应式设计

### 终端尺寸检测

```typescript
// hooks/useTerminalSize.ts
import { useState, useEffect } from 'ink'
import { getTerminalSize } from '../utils/terminal'

export function useTerminalSize() {
  const [size, setSize] = useState(getTerminalSize())
  
  useEffect(() => {
    const onResize = () => setSize(getTerminalSize())
    process.stdout.on('resize', onResize)
    
    return () => process.stdout.off('resize', onResize)
  }, [])
  
  return size
}
```

### 自适应布局

```typescript
export function ResponsiveLayout() {
  const { columns } = useTerminalSize()
  const isWide = columns > 100
  
  return (
    <Box flexDirection={isWide ? 'row' : 'column'}>
      <Box width={isWide ? '50%' : '100%'}>
        <LeftPanel />
      </Box>
      <Box width={isWide ? '50%' : '100%'}>
        <RightPanel />
      </Box>
    </Box>
  )
}
```

## 反馈调查系统

```typescript
// FeedbackSurvey.tsx
interface FeedbackSurveyProps {
  triggerEvent: string
  onComplete: (feedback: Feedback) => void
}

export function FeedbackSurvey({
  triggerEvent,
  onComplete
}: FeedbackSurveyProps) {
  const [rating, setRating] = useState<number | null>(null)
  const [comment, setComment] = useState('')
  
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>How was your experience?</Text>
      
      <Box marginY={1}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Text
            key={n}
            color={n <= rating ? 'green' : 'gray'}
            onClick={() => setRating(n)}
          >
            {n}{' '}
          </Text>
        ))}
      </Box>
      
      {rating && (
        <>
          <Text>Comments (optional):</Text>
          <TextInput value={comment} onChange={setComment} />
        </>
      )}
    </Box>
  )
}
```

## 最佳实践

### 组件设计原则

1. **单一职责**: 每个组件只做一件事
2. **可组合性**: 组件应该易于组合
3. **可测试性**: 组件应该易于测试
4. **无障碍性**: 支持键盘导航和屏幕阅读器

### 性能优化

```typescript
// 使用 useMemo 避免不必要的重新渲染
const filteredMessages = useMemo(() => 
  messages.filter(m => m.visible),
  [messages]
)

// 使用 useCallback 稳定回调引用
const handleSubmit = useCallback((text: string) => {
  onSubmit(text)
  setText('')
}, [onSubmit])
```

### 错误边界

```typescript
import { Component, ErrorInfo, ReactNode } from 'react'

interface Props {
  fallback: ReactNode
  children: ReactNode
}

export class ErrorBoundary extends Component<Props> {
  state = { hasError: false }
  
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  
  componentDidCatch(error: Error, info: ErrorInfo) {
    logError(error, info)
  }
  
  render() {
    if (this.state.hasError) {
      return this.props.fallback
    }
    
    return this.props.children
  }
}
```

## 相关文档

- [架构设计](../architecture.md) - 系统架构
- [命令系统](./commands.md) - 命令交互
- [工具系统](./tools.md) - 工具接口
- [Ink 文档](https://github.com/vadimdemedes/ink) - React for terminal
