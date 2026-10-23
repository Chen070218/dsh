#!/usr/bin/env node
/**
 * 构建脚本：把 src 目录下的 .ts 源文件编译成 lib 目录下的同名 .js 文件。
 *
 * 选择 Node 内建的 `module.stripTypeScriptTypes` 而不是 tsc/esbuild：
 * DSH 桌面运行时里没有安装 typescript，而 Node 22.18+/24 自带类型擦除。
 * 因此源码只能使用「可擦除语法」：不能用 enum / namespace / 构造函数参数属性。
 */
import { stripTypeScriptTypes } from 'node:module'
import { readdir, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(projectRoot, 'src')
const outDir = join(projectRoot, 'lib')

async function collect(dir) {
  const result = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) result.push(...(await collect(full)))
    else if (entry.name.endsWith('.ts')) result.push(full)
  }
  return result
}

await rm(outDir, { recursive: true, force: true })
let compiled = 0
const failures = []
for (const file of await collect(srcDir)) {
  const relativePath = relative(srcDir, file)
  const target = join(outDir, relativePath.replace(/\.ts$/, '.js'))
  const source = await readFile(file, 'utf8')
  try {
    const output = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: file })
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, output.endsWith('\n') ? output : output + '\n', 'utf8')
    compiled += 1
  } catch (error) {
    failures.push(relativePath + ': ' + (error instanceof Error ? error.message : String(error)))
  }
}
for (const failure of failures) console.error('build: ' + failure)
if (failures.length > 0) process.exitCode = 1
console.log('build: ' + compiled + ' 个模块 -> lib/')
