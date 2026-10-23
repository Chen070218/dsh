#!/usr/bin/env node
/**
 * 安全递归删除：这是被真实事故逼出来的工具（两次）。
 *
 * 事故：对 `node_modules/dsh-projectops`（指向本仓库的目录联接）执行 `rmSync(recursive)` 时，
 * Windows 会顺着联接删进目标仓库，把 .git 的顶层文件删掉，代码侥幸保住。
 *
 * 规则：递归删除前先走一遍目录树，只要发现重解析点（junction / symlink），一律拒绝并打印处理方式。
 * 用法：node scripts/safe-remove.mjs <目录> [--force]
 */
import { lstatSync, readdirSync, rmSync, rmdirSync } from 'node:fs'
import { resolve } from 'node:path'

const target = resolve(process.argv[2] ?? '')
const force = process.argv.includes('--force')

function scan(dir, found = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    let stat
    try {
      stat = lstatSync(full)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) found.push(full)
    else if (stat.isDirectory()) scan(full, found)
  }
  return found
}

const links = scan(target)
if (links.length > 0 && !force) {
  console.error('safe-remove: 目标树里存在 ' + links.length + ' 个目录联接/符号链接，拒绝递归删除：')
  for (const link of links.slice(0, 10)) console.error('  - ' + link)
  console.error('  处理方式：先用 rmdir 删除链接本身（不会跟进目标），再删除目录；确认无风险可加 --force。')
  process.exit(1)
}
rmSync(target, { recursive: true, force: true })
console.log('safe-remove: 已删除 ' + target)
