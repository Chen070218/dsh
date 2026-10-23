import test from 'node:test'
import assert from 'node:assert/strict'
import { isExcludedDir, isSensitiveFile } from '../lib/security/excludes.js'

test('目录排除：依赖缓存与构建产物不进入扫描', () => {
  for (const name of ['node_modules', '.git', '__pycache__', '.venv', 'dist', 'build', '.pytest_cache']) {
    assert.equal(isExcludedDir(name), true, name + ' 应被排除')
  }
  assert.equal(isExcludedDir('.GIT'), true, '排除规则应忽略大小写')
  assert.equal(isExcludedDir('src'), false)
  assert.equal(isExcludedDir('application'), false)
})

test('敏感文件识别：密钥 / 环境变量 / 凭据一律排除', () => {
  for (const name of ['.env', '.env.local', 'server.pem', 'private.key', 'id_rsa', 'id_ed25519.pub', 'credentials.json', 'secrets.yaml', '.npmrc', '.netrc', 'store.p12']) {
    assert.equal(isSensitiveFile(name), true, name + ' 应被视为敏感文件')
  }
  for (const name of ['main.py', 'README.md', 'environment.py', 'keys.py', 'settings.json']) {
    assert.equal(isSensitiveFile(name), false, name + ' 不应被误判')
  }
})
