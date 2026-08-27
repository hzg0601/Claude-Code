import type { Node } from './parser.js'
import { PARSE_ABORTED, parseCommandRaw } from './parser.js'

export type SerializedBashAstNode = {
  type: string
  text: string
  startIndex: number
  endIndex: number
  children: SerializedBashAstNode[]
}

export type BashAstResult = {
  command: string
  status: 'parsed' | 'parse-unavailable' | 'parse-aborted'
  ast: SerializedBashAstNode | null
  nodeCount: number
  maxDepth: number
}

function serializeNode(
  node: Node,
  stats: { nodeCount: number; maxDepth: number },
  depth: number,
): SerializedBashAstNode {
  stats.nodeCount++
  stats.maxDepth = Math.max(stats.maxDepth, depth)

  return {
    type: node.type,
    text: node.text,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    children: node.children.map(child =>
      serializeNode(child, stats, depth + 1),
    ),
  }
}

/**
 * Generate a complete, JSON-safe representation of a Bash command AST.
 *
 * Unlike parseForSecurity(), this intentionally preserves every parser node,
 * including syntax that the security walker does not understand.
 */
export async function generateBashAst(command: string): Promise<BashAstResult> {
  const parsed = await parseCommandRaw(command)

  if (parsed === PARSE_ABORTED) {
    return {
      command,
      status: 'parse-aborted',
      ast: null,
      nodeCount: 0,
      maxDepth: 0,
    }
  }

  if (parsed === null) {
    return {
      command,
      status: 'parse-unavailable',
      ast: null,
      nodeCount: 0,
      maxDepth: 0,
    }
  }

  const stats = { nodeCount: 0, maxDepth: 0 }
  const ast = serializeNode(parsed, stats, 0)
  return {
    command,
    status: 'parsed',
    ast,
    ...stats,
  }
}

function escapeMermaidLabel(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
}

function nodeLabel(node: SerializedBashAstNode, maxTextLength: number): string {
  const text =
    node.text.length > maxTextLength
      ? `${node.text.slice(0, maxTextLength)}…`
      : node.text
  return `${node.type}\\n${text}`
}

/**
 * Render a complete AST as a Mermaid flowchart.
 *
 * Labels are shortened for readability, while every node and edge remains in
 * the output. Use the JSON format when the unabridged node text is required.
 */
export function bashAstToMermaid(
  ast: SerializedBashAstNode,
  options: { maxTextLength?: number } = {},
): string {
  const maxTextLength = options.maxTextLength ?? 80
  const lines = ['flowchart TD']
  let nextId = 0

  function visit(node: SerializedBashAstNode, parentId?: string): void {
    const id = `n${nextId++}`
    lines.push(`    ${id}["${escapeMermaidLabel(nodeLabel(node, maxTextLength))}"]`)
    if (parentId) lines.push(`    ${parentId} --> ${id}`)
    for (const child of node.children) visit(child, id)
  }

  visit(ast)
  return `${lines.join('\n')}\n`
}

/**
 * Render an AST as an indented terminal tree.
 */
export function bashAstToTree(
  ast: SerializedBashAstNode,
  options: { maxTextLength?: number } = {},
): string {
  const maxTextLength = options.maxTextLength ?? 120
  const lines: string[] = []

  function visit(
    node: SerializedBashAstNode,
    prefix: string,
    isLast: boolean,
    isRoot = false,
  ): void {
    const text =
      node.text.length > maxTextLength
        ? `${node.text.slice(0, maxTextLength)}…`
        : node.text
    const branch = isRoot ? '' : isLast ? '└─ ' : '├─ '
    lines.push(`${prefix}${branch}${node.type}: ${JSON.stringify(text)}`)

    const childPrefix = isRoot
      ? ''
      : `${prefix}${isLast ? '   ' : '│  '}`
    node.children.forEach((child, index) => {
      visit(child, childPrefix, index === node.children.length - 1)
    })
  }

  visit(ast, '', true, true)
  return `${lines.join('\n')}\n`
}
