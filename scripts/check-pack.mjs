#!/usr/bin/env node
/**
 * 按 package.json 的 files 白名单核对将要发布的内容。
 * 为什么不用 npm pack：在本机直接跑 npm-cli.js 时 pack 会报 ERR_INVALID_ARG_TYPE（环境问题），
 * 而发布内容完全由 files 白名单决定，这里做确定性检查即可。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const allow = pkg.files ?? []
const missing = []
const counts = {}

for (const entry of allow) {
  const full = join(root, entry)
  if (!existsSync(full)) {
    missing.push(entry)
    continue
  }
  const isDir = statSync(full).isDirectory()
  counts[entry] = isDir
    ? readdirSync(full, { recursive: true }).filter((name) => /\.[cm]?js$/.test(String(name))).length
    : 1
}

const required = ['lib/index.js', 'lib/client/index.js', 'cordis.patch.yml', 'dsh.plugin.json', 'README.md', 'LICENSE', 'locale/zh.json', 'locale/en.json']
const absent = required.filter((file) => !existsSync(join(root, file)))
const mustNotPublish = ['node_modules', 'src', 'tests', '.projectops', 'docs/images/preview.html']
const leaked = mustNotPublish.filter((file) => allow.some((entry) => entry === file || entry.startsWith(file + '/')))

for (const file of missing) console.error('pack: BLOCK files 白名单里的路径不存在: ' + file)
for (const file of absent) console.error('pack: BLOCK 必需文件缺失: ' + file)
for (const file of leaked) console.error('pack: BLOCK 不应发布: ' + file)
console.log('pack: ' + allow.length + ' 条白名单，js 文件数 ' + JSON.stringify(counts))
if (missing.length + absent.length + leaked.length === 0) console.log('pack: OK（发布内容符合预期）')
process.exitCode = missing.length + absent.length + leaked.length === 0 ? 0 : 1
