/**
 * TypeScript / JavaScript import 解析（词法级，与 Python 版本同构）。
 *
 * 覆盖：静态 import（含 type-only）、副作用 import、export ... from、
 * 动态 import()、CommonJS require()。不构建 AST，因此：
 * - 注释与字符串里的假 import 会被排除（按行状态机处理）；
 * - 模板拼接出来的模块名无法静态解析，不做猜测。
 */
export type JsImportKind = 'static' | 'dynamic' | 'require'

export interface RawJsImport {
  /** 原样的模块说明符：'./util'、'@scope/pkg'、'node:fs'。 */
  specifier: string
  kind: JsImportKind
  line: number
}

const BACKTICK = String.fromCharCode(96)

function stripLineComment(line: string): string {
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
    if (char === '"' || char === "'" || char === BACKTICK) {
      quote = char
      continue
    }
    if (char === '/' && line[index + 1] === '/') return line.slice(0, index)
    if (char === '/' && line[index + 1] === '*') return line.slice(0, index)
  }
  return line
}

const STATIC_FROM = /(?:^|\s)(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g
const STATIC_SIDE_EFFECT = /(?:^|\s)import\s*['"]([^'"]+)['"]/g
const DYNAMIC_IMPORT = /(?:^|[^\w.])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const REQUIRE_CALL = /(?:^|[^\w.])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function collect(line: string, pattern: RegExp, kind: JsImportKind, lineNumber: number, into: RawJsImport[]): void {
  pattern.lastIndex = 0
  for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
    const specifier = match[1]
    if (specifier === undefined || specifier === '') continue
    into.push({ specifier, kind, line: lineNumber })
  }
}

export function parseJsImports(source: string): RawJsImport[] {
  const imports: RawJsImport[] = []
  let inBlockComment = false

  const lines = source.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    let line = lines[index] ?? ''

    if (inBlockComment) {
      const end = line.indexOf('*/')
      if (end === -1) continue
      line = line.slice(end + 2)
      inBlockComment = false
    }
    const start = line.indexOf('/*')
    if (start !== -1 && line.indexOf('*/', start + 2) === -1) {
      inBlockComment = true
      line = line.slice(0, start)
    }
    line = stripLineComment(line)
    if (line.trim() === '') continue

    collect(line, STATIC_FROM, 'static', lineNumber, imports)
    collect(line, STATIC_SIDE_EFFECT, 'static', lineNumber, imports)
    collect(line, DYNAMIC_IMPORT, 'dynamic', lineNumber, imports)
    collect(line, REQUIRE_CALL, 'require', lineNumber, imports)
  }

  const seen = new Set<string>()
  return imports.filter((item) => {
    const key = item.line + '|' + item.kind + '|' + item.specifier
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
