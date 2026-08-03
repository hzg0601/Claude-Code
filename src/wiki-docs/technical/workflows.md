# 工作流系统

工作流系统提供多代理编排、并行执行和任务自动化的框架。

## 工作流架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Workflow System                           │
├─────────────────────────────────────────────────────────────┤
│  Workflow Engine     │  Agent Pool      │  Execution       │
│  - Definitions       │  - Built-in      │  - Sequential    │
│  - Custom Scripts    │  - Custom        │  - Parallel      │
│  - Phases            │  - Specialized   │  - Conditional   │
├─────────────────────────────────────────────────────────────┤
│  Communication      │  State Mgmt     │  Budget          │
│  - Messages         │  - Shared       │  - Token Tracking │
│  - Events           │  - Context      │  - Cost Control   │
└─────────────────────────────────────────────────────────────┘
```

## 内置工作流模式

### 1. Understand (理解)

并行读取相关子系统，生成结构化映射。

```typescript
// 理解代码库
const result = await agent('Explore', {
  prompt: 'Map the authentication system architecture',
  schema: ARCHITECTURE_SCHEMA
})

// ARCHITECTURE_SCHEMA 定义
const ARCHITECTURE_SCHEMA = {
  type: 'object',
  properties: {
    layers: {
      type: 'array',
      items: {
        name: { type: 'string' },
        responsibility: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } }
      }
    },
    dependencies: {
      type: 'array',
      items: {
        from: { type: 'string' },
        to: { type: 'string' },
        type: { enum: ['imports', 'calls', 'extends'] }
      }
    }
  }
}
```

### 2. Design (设计)

独立视角生成多个方案，综合评分。

```typescript
// 生成多个设计方案
const [mvpApproach, scalableApproach, pragmaticApproach] = await parallel([
  () => agent('Design MVP solution', { schema: DESIGN_SCHEMA }),
  () => agent('Design scalable solution', { schema: DESIGN_SCHEMA }),
  () => agent('Design pragmatic solution', { schema: DESIGN_SCHEMA })
])

// 评分
const scores = await parallel([
  () => judge(mvpApproach, 'complexity'),
  () => judge(mvpApproach, 'maintainability'),
  () => judge(mvpApproach, 'time-to-market')
])

// 选择最佳方案
const best = selectBest(scores)
```

### 3. Review (审查)

多维度审查，独立验证每个发现。

```typescript
const DIMENSIONS = [
  { key: 'bugs', prompt: 'Find potential bugs' },
  { key: 'security', prompt: 'Find security issues' },
  { key: 'performance', prompt: 'Find performance problems' }
]

// 并行审查
const reviews = await parallel(
  DIMENSIONS.map(d => () => 
    agent(d.prompt, { schema: FINDINGS_SCHEMA })
  )
)

// 验证每个发现
const verified = await parallel(
  reviews.flatMap(r => r.findings.map(f => () =>
    agent(`Verify: ${f.description}`, { schema: VERDICT_SCHEMA })
  ))
)

// 过滤确认的问题
const confirmed = verified.filter(v => v.confirmed)
```

### 4. Research (研究)

多模态搜索，深度阅读，综合总结。

```typescript
// 多模态研究
const [docs, code, examples] = await parallel([
  () => agent('Search documentation', { schema: DOCS_SCHEMA }),
  () => agent('Search codebase', { schema: CODE_SCHEMA }),
  () => agent('Find examples', { schema: EXAMPLES_SCHEMA })
])

// 综合
const synthesis = await agent('Synthesize findings', {
  prompt: `
    Documentation: ${JSON.stringify(docs)}
    Code: ${JSON.stringify(code)}
    Examples: ${JSON.stringify(examples)}
    
    Provide a comprehensive summary.
  `,
  schema: SYNTHESIS_SCHEMA
})
```

## 工作流编排

### Pipeline 模式

默认模式，各阶段独立流动，无屏障。

```typescript
// Pipeline: 每个 item 流经所有阶段
const results = await pipeline(
  items,
  // Stage 1: Find
  async (item) => {
    return await agent('Find issues in ' + item.path, {
      schema: ISSUES_SCHEMA
    })
  },
  // Stage 2: Verify (immediately, no barrier)
  async (finding, originalItem) => {
    return await agent(`Verify: ${finding.description}`, {
      schema: VERDICT_SCHEMA
    })
  },
  // Stage 3: Fix
  async (verdict, _, originalItem) => {
    if (verdict.isReal) {
      return await agent('Fix this issue', {
        schema: FIX_SCHEMA
      })
    }
    return null
  }
)
```

### Parallel 模式

屏障模式，等待所有结果后继续。

```typescript
// Parallel: 等待所有 agent 完成
const allFindings = await parallel(
  agents.map(agentFn => () => agentFn())
)

// 所有结果一起处理
const deduped = deduplicate(allFindings.filter(Boolean))
const verified = await parallel(
  deduped.map(f => () => 
    agent(`Verify: ${f.description}`, { schema: VERDICT_SCHEMA })
  ))
)
```

### Loop-until-dry 模式

循环直到没有新发现。

```typescript
const seen = new Set()
const confirmed = []
let dryCount = 0

while (dryCount < 2) {  // 连续 2 轮无新发现
  // 并行查找
  const found = (await parallel(FINDERS.map(f => () =>
    agent(f.prompt, { schema: BUGS_SCHEMA })
  ))).filter(Boolean).flatMap(r => r.bugs)
  
  // 去重
  const fresh = found.filter(b => !seen.has(hash(b)))
  if (!fresh.length) {
    dryCount++
    continue
  }
  
  dryCount = 0
  fresh.forEach(b => seen.add(hash(b)))
  
  // 验证
  const verified = await parallel(fresh.map(b => () =>
    agent(`Verify: ${b.description}`, { schema: VERDICT_SCHEMA })
  ))
  
  confirmed.push(...verified.filter(v => v.real).map(v => v.bug))
}

return confirmed
```

### Loop-until-budget 模式

基于 token 预算缩放深度。

```typescript
const bugs = []
while (budget.total && budget.remaining() > 50000) {
  const result = await agent('Find issues', {
    schema: ISSUES_SCHEMA
  })
  bugs.push(...result.issues)
  log(`${bugs.length} found, ${Math.round(budget.remaining()/1000)}k remaining`)
}
return bugs
```

## 质量模式

### Adversarial Verify (对抗验证)

生成 N 个独立反驳者，多数反驳则丢弃。

```typescript
const votes = await parallel(Array.from({ length: 3 }, () => () =>
  agent(`Try to refute: ${claim}. Default to refuted=true if uncertain.`, {
    schema: VERDICT_SCHEMA
  })
))

// 多数存活
const survives = votes.filter(Boolean).filter(v => !v.refuted).length >= 2
```

### Perspective-diverse Verify (多视角验证)

每个验证者不同视角。

```typescript
const lenses = ['correctness', 'security', 'performance', 'reproducibility']

const judges = await parallel(lenses.map(lens => () =>
  agent(`Judge via ${lens} lens: ${finding}`, {
    schema: VERDICT_SCHEMA
  })
))

// 任一视角认为真实则为真实
const isReal = judges.some(j => j.real)
```

### Judge Panel (评审团)

生成 N 个独立尝试，评分，合成最佳。

```typescript
// 生成多个方案
const attempts = await parallel([
  () => agent('MVP-first approach', { schema: DESIGN_SCHEMA }),
  () => agent('Risk-first approach', { schema: DESIGN_SCHEMA }),
  () => agent('User-first approach', { schema: DESIGN_SCHEMA })
])

// 评分
const scores = await parallel(attempts.map(a => () =>
  agent(`Score: ${a.summary}`, { schema: SCORE_SCHEMA })
))

// 合成最佳，融合次优的优点
const best = scores.reduce((a, b) => a.total > b.total ? a : b)
const synthesis = await synthesize(best, attempts)
```

### Completeness Critic (完整性审查)

最终 agent 询问"缺少什么"。

```typescript
const critic = await agent(`
  What's missing from this analysis?
  - Modality not run?
  - Claim unverified?
  - Source unread?
`, { schema: GAPS_SCHEMA })

// 补充缺失
if (critic.gaps.length > 0) {
  const additional = await agent('Address gaps', {
    prompt: critic.gaps.join('\n'),
    schema: ADDITIONAL_SCHEMA
  })
  results.push(...additional)
}
```

## 自定义工作流

### 脚本定义

```typescript
// 工作流脚本
export const meta = {
  name: 'comprehensive-review',
  description: '全面代码审查工作流',
  phases: [
    { title: 'Discover', detail: 'Find all changed files' },
    { title: 'Review', detail: 'Review each dimension' },
    { title: 'Verify', detail: 'Verify findings' },
    { title: 'Synthesize', detail: 'Generate report' }
  ]
}

// 执行体
phase('Discover')
const changedFiles = await agent('Find changed files', {
  schema: FILES_SCHEMA
})

phase('Review')
const reviews = await parallel(
  changedFiles.map(f => () => 
    agent(`Review ${f.path}`, { schema: REVIEW_SCHEMA })
  )
)

phase('Verify')
const verified = await parallel(
  reviews.flatMap(r => r.issues.map(i => () =>
    agent(`Verify: ${i.description}`, { schema: VERDICT_SCHEMA })
  ))
)

phase('Synthesize')
const report = await agent('Generate report', {
  prompt: `Verified issues: ${JSON.stringify(verified.filter(v => v.real))}`,
  schema: REPORT_SCHEMA
})

return report
```

### 组合模式

```typescript
// 组合多个模式
async function exhaustiveReview(): Promise<ConfirmedBug[]> {
  const seen = new Set()
  const confirmed = []
  let dry = 0
  
  while (dry < 2) {
    // 多模态搜索
    const found = (await parallel(FINDERS.map(f => () =>
      agent(f.prompt, { schema: BUGS_SCHEMA })
    ))).filter(Boolean).flatMap(r => r.bugs)
    
    // 去重 vs 所有已见
    const fresh = found.filter(b => !seen.has(key(b)))
    if (!fresh.length) { dry++; continue }
    
    dry = 0
    fresh.forEach(b => seen.add(key(b)))
    
    // 多视角验证
    const judged = await parallel(fresh.map(b => () =>
      parallel(['correctness', 'security', 'repro'].map(lens => () =>
        agent(`Judge "${b.desc}" via ${lens} lens`, { schema: VERDICT_SCHEMA })
      )).then(vs => ({ 
        b, 
        real: vs.filter(Boolean).filter(v => v.real).length >= 2 
      }))
    ))
    
    confirmed.push(...judged.filter(v => v.real).map(v => v.b))
  }
  
  return confirmed
}
```

## 预算控制

### Token 预算管理

```typescript
// 预算对象
interface Budget {
  total: number | null  // 用户设定的目标
  spent(): number       // 已花费 token
  remaining(): number   // 剩余 token
}

// 循环直到预算耗尽
while (budget.total && budget.remaining() > 100000) {
  const result = await agent('Find issues', { schema: ISSUES_SCHEMA })
  issues.push(...result.issues)
  log(`${issues.length} found, ${budget.remaining()} tokens remaining`)
}
```

### 努力程度

```typescript
// 不同阶段使用不同努力程度
const result = await agent('Complex analysis', {
  effort: 'high'  // low | medium | high | xhigh | max
})

const verify = await agent('Verify findings', {
  effort: 'xhigh'  // 验证阶段使用更高努力
})
```

## 并发控制

### 并发限制

- 单个 workflow 同时最多 `min(16, CPU 核心数 - 2)` 个 agent 运行
- 超额调用排队，有空位时运行
- 单个 `parallel()`/`pipeline()` 最多接受 4096 个 item
- workflow 生命周期内最多 1000 个 agent

### 模型覆盖

```typescript
// 为特定 agent 调用覆盖模型
const result = await agent('Long task', {
  model: 'claude-opus-4-8'  // 覆盖默认模型
})
```

## 错误处理

### 超时处理

```typescript
// Agent 超时
const result = await agent('Long task', {
  timeout: 300000  // 5 分钟超时
}).catch(error => {
  if (error.code === 'TIMEOUT') {
    log('Agent timed out')
    return null
  }
  throw error
})
```

### 取消处理

```typescript
// 用户取消
const result = await agent('Task', { schema: SCHEMA })
  .catch(error => {
    if (error.code === 'USER_CANCELLED') {
      return null  // 用户取消返回 null
    }
    throw error
  })

// 过滤 null 结果
const results = [r1, r2, result].filter(Boolean)
```

## 最佳实践

### 规模匹配

- "find any bugs" → 几个查找器，单次验证
- "thoroughly audit" → 大型查找池，3-5 票对抗验证，综合阶段
- 研究/审查/审计请求 → 偏向彻底
- 快速检查 → 简洁

### 屏障使用准则

屏障 (parallel 屏障) 仅在真正需要所有结果时正确：

- 去重/合并跨 item 结果
- 早期退出 (0 个发现 → 跳过验证)
- 阶段 N 引用"其他发现"比较

屏障**不**适用于：
- "需要先 flatten/map/filter" → 在 pipeline 阶段内完成
- "概念上分开" → pipeline() 建模
- "代码更清晰" → 屏障延迟是真实的

### 日志记录

```typescript
// 记录进度
log(`${findings.length} findings so far`)

// 记录丢弃的内容 (不要静默截断)
if (dropped.length > 0) {
  log(`Dropped ${dropped.length} low-priority findings to stay within budget`)
}
```

## 相关文档

- [代理系统](../modules/agents.md) - 代理接口
- [技能系统](../modules/skills.md) - 技能编排
- [工具系统](../modules/tools.md) - 工具集成
