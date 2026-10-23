import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const guard = join(projectRoot, 'scripts', 'safe-remove.mjs')

function runGuard(target: string): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [guard, target],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 60000 },
      (error, stdout, stderr) => resolvePromise({ code: error ? 1 : 0, output: String(stdout) + String(stderr) }),
    )
  })
}

test('safe-remove：目标树里有目录联接时拒绝递归删除（真实事故回归）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-projectops-safe-'))
  const payload = join(root, 'payload')
  const tree = join(root, 'tree')
  const link = join(tree, 'nested')
  mkdirSync(payload, { recursive: true })
  mkdirSync(tree, { recursive: true })
  writeFileSync(join(payload, 'keep.txt'), 'must survive')
  symlinkSync(payload, link, process.platform === 'win32' ? 'junction' : 'dir')

  try {
    const result = await runGuard(tree)
    assert.equal(result.code, 1, '发现联接时必须拒绝并退出 1')
    assert.ok(result.output.includes('拒绝递归删除'), '输出要说明拒绝原因')
    assert.equal(existsSync(join(payload, 'keep.txt')), true, '链接目标绝不能被删除')
    assert.equal(existsSync(tree), true, '目标目录必须原样保留')
  } finally {
    // 只删链接本身，再删临时目录（绝不递归穿过联接）
    try {
      rmdirSync(link)
    } catch {
      // 忽略
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('safe-remove：没有联接时可以正常删除', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-projectops-safe-plain-'))
  const tree = join(root, 'tree')
  mkdirSync(tree, { recursive: true })
  writeFileSync(join(tree, 'a.txt'), 'x')
  try {
    const result = await runGuard(tree)
    assert.equal(result.code, 0)
    assert.equal(existsSync(tree), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
