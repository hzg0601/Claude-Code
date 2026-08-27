import {
  bashAstToMermaid,
  bashAstToTree,
  generateBashAst,
} from '../src/utils/bash/astVisualization.js'

type Format = 'json' | 'tree' | 'mermaid'

function printHelp(): void {
  console.log(`Usage: bun run bash:ast [options] [command]

Generate the complete BashTool command AST.

Options:
  --format <json|tree|mermaid>  Output format (default: mermaid)
  --help                       Show this help

If command is omitted, the command is read from stdin.
`)
}

function parseArgs(args: string[]): { format: Format; command: string | null } {
  let format: Format = 'mermaid'
  const commandParts: string[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
    if (arg === '--format' || arg === '-f') {
      const value = args[++index]
      if (value !== 'json' && value !== 'tree' && value !== 'mermaid') {
        throw new Error('--format must be json, tree, or mermaid')
      }
      format = value
      continue
    }
    if (arg?.startsWith('--format=')) {
      const value = arg.slice('--format='.length)
      if (value !== 'json' && value !== 'tree' && value !== 'mermaid') {
        throw new Error('--format must be json, tree, or mermaid')
      }
      format = value
      continue
    }
    commandParts.push(arg ?? '')
  }

  return {
    format,
    command: commandParts.length > 0 ? commandParts.join(' ') : null,
  }
}

const { format, command: argumentCommand } = parseArgs(Bun.argv.slice(2))
const command = argumentCommand ?? (await Bun.stdin.text()).trimEnd()

if (!command) {
  printHelp()
  process.exit(1)
}

const result = await generateBashAst(command)
if (format === 'json') {
  console.log(JSON.stringify(result, null, 2))
} else if (result.ast === null) {
  console.error(`Unable to generate AST: ${result.status}`)
  process.exit(1)
} else if (format === 'tree') {
  process.stdout.write(bashAstToTree(result.ast))
} else {
  process.stdout.write(bashAstToMermaid(result.ast))
}
