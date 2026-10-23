/**
 * Python import 语句解析（面向依赖分析的第一版）。
 *
 * 这是**词法级**解析：不构建 AST，也不执行任何代码，因此：
 * - 能稳定拿到静态 import / from-import 的字面模块名；
 * - 动态导入（importlib、__import__）、条件导入、类型检查分支都会被当成普通导入；
 * - 字符串/注释里的假 import 会被排除，但极端写法（如多行隐式拼接）仍可能漏判。
 * 这些限制会在工具描述和报告里明确标注为"启发式"。
 */
export type ImportKind = 'import' | 'from'

export type ImportScope = 'module' | 'nested'

export interface RawImport {
  kind: ImportKind
  /** module：顶层导入；nested：函数/类/条件/异常处理体里的导入（运行时不一定执行）。 */
  scope: ImportScope
  /** 相对导入的前导点数；0 表示绝对导入。 */
  level: number
  /** 点号分隔的模块名；from . import x 时为空字符串。 */
  module: string
  /** from-import 的具体名字；普通 import 为空数组。 */
  names: string[]
  line: number
}

const IMPORT_LINE = /^\s*(?:import|from)\s+/

/** 去掉行内注释：只在引号之外识别 #。 */
function stripComment(line: string): string {
  let quote: string | null = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote !== null) {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#') return line.slice(0, index)
  }
  return line
}

function countTripleQuotes(line: string): number {
  let count = 0
  let index = 0
  for (;;) {
    const next = line.indexOf('"""', index)
    const other = line.indexOf("'''", index)
    if (next === -1 && other === -1) return count
    count += 1
    index = (next === -1 ? other : other === -1 ? next : Math.min(next, other)) + 3
  }
}

function parseNames(text: string): string[] {
  const cleaned = text.replace(/[()]/g, ' ')
  return cleaned
    .split(',')
    .map((part) => part.trim().split(/\s+as\s+/)[0]?.trim() ?? '')
    .filter((name) => name.length > 0)
}

function parseStatement(statement: string, line: number, scope: ImportScope): RawImport[] {
  const importMatch = /^\s*import\s+(.+)$/.exec(statement)
  if (importMatch !== null) {
    return parseNames(importMatch[1] ?? '')
      .map((name) => name.split(/\s+as\s+/)[0]?.trim() ?? '')
      .filter((name) => name.length > 0)
      .map((name) => ({ kind: 'import' as const, scope, level: 0, module: name, names: [], line }))
  }

  const fromMatch = /^\s*from\s+(\.*)([A-Za-z_][\w.]*)?\s+import\s+([\s\S]+)$/.exec(statement)
  if (fromMatch !== null) {
    const dots = fromMatch[1] ?? ''
    return [
      {
        kind: 'from' as const,
        scope,
        level: dots.length,
        module: fromMatch[2] ?? '',
        names: parseNames(fromMatch[3] ?? ''),
        line,
      },
    ]
  }
  return []
}

/**
 * 解析一段 Python 源码中的 import 语句。
 * @param source - 文件内容。
 * @returns 按出现顺序排列的导入记录。
 */
export function parseImports(source: string): RawImport[] {
  const imports: RawImport[] = []
  const lines = source.split(/\r?\n/)
  let inTriple = false
  let buffer: string[] = []
  let bufferLine = 0
  let bufferScope: ImportScope = 'module'

  const flush = (): void => {
    if (buffer.length === 0) return
    const statement = buffer.join(' ')
    buffer = []
    imports.push(...parseStatement(statement, bufferLine, bufferScope))
  }

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const raw = lines[index] ?? ''
    const triples = countTripleQuotes(raw)
    if (inTriple) {
      if (triples % 2 === 1) inTriple = false
      continue
    }
    if (triples % 2 === 1) {
      inTriple = true
      continue
    }

    const line = stripComment(raw)
    if (line.trim() === '') continue

    if (buffer.length === 0) {
      if (!IMPORT_LINE.test(line)) continue
      bufferLine = lineNumber
      // 有缩进即视为嵌套作用域（函数/类/if/try/with 体）
      bufferScope = /^\s/.test(line) ? 'nested' : 'module'
    }
    buffer.push(line.trim())

    const open = (buffer.join(' ').match(/\(/g) ?? []).length
    const close = (buffer.join(' ').match(/\)/g) ?? []).length
    if (open > close && index < lines.length - 1) continue
    flush()
  }
  flush()
  return imports
}
