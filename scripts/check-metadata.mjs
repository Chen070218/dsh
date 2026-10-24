#!/usr/bin/env node
/**
 * 发布前元数据自检：版本一致性、必填字段、占位符。
 * 用法：node scripts/check-metadata.mjs（exit 1 表示有阻塞项）
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
// 占位符在运行时拼出来，避免检查器把自身的字面量当成待替换项
const PLACEHOLDER = 'your' + '-' + 'name'
const versionSource = readFileSync(fileURLToPath(new URL('src/version.ts', root)), 'utf8')
const versionInSource = /PLUGIN_VERSION = '([^']+)'/.exec(versionSource)?.[1]

const blocking = []
const warnings = []

if (versionInSource !== pkg.version) blocking.push('src/version.ts 的 PLUGIN_VERSION 与 package.json 不一致：' + versionInSource + ' vs ' + pkg.version)
if (!pkg.license) blocking.push('缺少 license')
if (!pkg.files || !Array.isArray(pkg.files)) blocking.push('缺少 files 白名单')
if (pkg.exports?.['.'] !== './lib/index.js') blocking.push('exports["."] 应指向 ./lib/index.js')
if (!pkg.dsh?.bundle?.patch) blocking.push('缺少 dsh.bundle.patch（DSH 插件清单）')

for (const field of ['repository', 'homepage', 'bugs']) {
  const value = JSON.stringify(pkg[field] ?? '')
  if (value === '""') blocking.push('缺少 ' + field)
  else if (value.includes('' + 'your' + '-name' + '')) warnings.push(field + ' 仍是占位符（发布前替换成真实仓库地址）')
}
if (pkg.private === true) blocking.push('private=true 会阻止发布')

console.log('metadata: ' + pkg.name + '@' + pkg.version)
for (const item of blocking) console.log('  BLOCK ' + item)
for (const item of warnings) console.log('  WARN  ' + item)
console.log(blocking.length === 0 ? '  OK（' + warnings.length + ' 条提醒）' : '  ' + blocking.length + ' 个阻塞项')
process.exitCode = blocking.length === 0 ? 0 : 1
