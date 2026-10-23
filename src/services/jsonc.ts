/** JSONC（带注释/尾逗号）解析与相对路径归一化：中立模块，避免分析器之间互相 import。 */

export function normalizeRelativePath(path: string): string {
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.join('/')
}

/** 容错解析 tsconfig / package.json 这类 JSONC 文本，失败返回 undefined。 */
export function parseJsonc(text: string): unknown {
  const withoutBlock = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const withoutLine = withoutBlock
    .split('\n')
    .map((line) => {
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
        if (char === '"') {
          quote = char
          continue
        }
        if (char === '/' && line[index + 1] === '/') return line.slice(0, index)
      }
      return line
    })
    .join('\n')
  try {
    return JSON.parse(withoutLine.replace(/,(\s*[}\]])/g, '$1'))
  } catch {
    return undefined
  }
}
