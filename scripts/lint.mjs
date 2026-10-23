#!/usr/bin/env node
/**
 * 仓库原生 lint：不引入 eslint（离线也能跑），只检查对本项目真正重要的约束。
 * 1) 源码必须是可擦除语法（禁 enum / namespace / 构造函数参数属性）
 * 2) 禁止 tab 缩进与行尾空格
 * 3) src/ 里禁止 console.log（日志必须走 logger，便于脱敏）
 * 4) 禁止在 src 里使用 `any`（宿主边界由 types/dsh-ambient.d.ts 统一声明）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('../', import.meta.url)))
const problems = []

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(ts|mjs|js)$/.test(entry.name)) out.push(full)
  }
  return out
}

for (const file of walk(join(root, 'src'))) {
  const text = readFileSync(file, 'utf8')
  const rel = relative(root, file)
  text.split('\n').forEach((line, index) => {
    const lineNo = index + 1
    if (line.includes('\t')) problems.push(rel + ':' + lineNo + ' 使用了 tab 缩进')
    if (/\s+$/.test(line)) problems.push(rel + ':' + lineNo + ' 行尾有空白')
    if (/\benum\s+[A-Za-z_$]/.test(line)) problems.push(rel + ':' + lineNo + ' 使用了 enum（不可擦除语法）')
    if (/\bnamespace\s+[A-Za-z_$]/.test(line)) problems.push(rel + ':' + lineNo + ' 使用了 namespace（不可擦除语法）')
    if (/(constructor|function)\s*\([^)]*\b(private|public|protected|readonly)\s+[A-Za-z_$]/.test(line)) {
      problems.push(rel + ':' + lineNo + ' 使用了参数属性（不可擦除语法）')
    }
    if (/console\.(log|info|warn|error)\(/.test(line)) problems.push(rel + ':' + lineNo + ' 直接使用 console，请走 logger')
    if (/:\s*any\b|<any>/.test(line)) problems.push(rel + ':' + lineNo + ' 使用了 any，请在 types/dsh-ambient.d.ts 里声明边界')
  })
}

if (problems.length === 0) {
  console.log('lint: OK（src/ 无违规）')
  process.exitCode = 0
} else {
  for (const problem of problems) console.error('lint: ' + problem)
  console.error('lint: ' + problems.length + ' 处问题')
  process.exitCode = 1
}
