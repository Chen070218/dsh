#!/usr/bin/env node
/**
 * 在没有 npm 的机器上引导类型检查工具链：直接从 registry 下载 tarball 并解包到 node_modules。
 *
 * 本机（DSH 桌面版）只有 Electron 自带的 Node，没有 npm/npx，因此这一步纯手写：
 * fetch + zlib.gunzip + ustar 解析。产物落在 node_modules/（已 gitignore）。
 * 用法：node scripts/bootstrap-tooling.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = [
  ['typescript', '5.6.3'],
  ['@types/node', '22.10.2'],
  ['undici-types', '6.19.8'],
]

function extractTarGz(buffer, targetDir) {
  const tar = gunzipSync(buffer)
  let offset = 0
  let files = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const sizeText = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    const typeflag = String.fromCharCode(header[156] ?? 48)
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const size = sizeText === '' ? 0 : parseInt(sizeText, 8)
    const full = prefix === '' ? rawName : prefix + '/' + rawName
    offset += 512
    const data = tar.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512
    if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '') continue
    // npm tarball 的根目录可能是 package/ 或包名本身（如 @types/node -> node/），统一剥掉第一段
    const slash = full.indexOf('/')
    if (slash < 0) continue
    const relative = full.slice(slash + 1)
    if (relative === '' || relative.endsWith('/')) continue
    const target = join(targetDir, relative)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
    files += 1
  }
  return files
}

for (const [name, version] of PACKAGES) {
  const file = name.replace(/^@[^/]+\//, '')
  const url = 'https://registry.npmjs.org/' + name + '/-/' + file + '-' + version + '.tgz'
  const response = await fetch(url)
  if (!response.ok) {
    console.error('bootstrap: 下载失败 ' + url + ' -> HTTP ' + response.status)
    process.exitCode = 1
    continue
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  const count = extractTarGz(buffer, join(root, 'node_modules', name))
  console.log('bootstrap: ' + name + '@' + version + ' -> ' + count + ' files')
}
console.log('bootstrap: 现在可以运行 node scripts/verify.mjs（含 typecheck）')
