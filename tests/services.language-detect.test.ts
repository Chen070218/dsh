import test from 'node:test'
import assert from 'node:assert/strict'
import { basename, detectProject, extensionOf } from '../lib/services/language-detect.js'

test('扩展名与文件名解析', () => {
  assert.equal(extensionOf('main.PY'), '.py')
  assert.equal(extensionOf('archive.tar.gz'), '.gz')
  assert.equal(extensionOf('.env'), '')
  assert.equal(extensionOf('Makefile'), '')
  assert.equal(basename('a/b/c.py'), 'c.py')
  assert.equal(basename('c.py'), 'c.py')
  assert.equal(basename('a\\b\\c.py'), 'c.py')
})

test('识别语言、入口文件、配置文件与包管理器', () => {
  const detection = detectProject({
    files: [
      'main.py',
      'pkg/core.py',
      'pkg/utils.py',
      'README.md',
      'pyproject.toml',
      'uv.lock',
      'web/index.html',
      'web/app.ts',
    ],
  })
  assert.equal(detection.primaryLanguage, 'Python')
  assert.ok(detection.languages.includes('Python'))
  assert.ok(detection.languages.includes('TypeScript'))
  assert.equal(detection.entryPoints[0], 'main.py', '浅层入口文件优先')
  assert.ok(detection.entryPoints.includes('web/app.ts'))
  assert.ok(detection.configFiles.includes('pyproject.toml'))
  assert.ok(detection.packageManagers.includes('uv'))
})

test('浅层配置文件优先，重复项去重', () => {
  const detection = detectProject({
    files: ['deep/nested/package.json', 'package.json', 'src/package.json', 'pnpm-lock.yaml', 'index.html'],
  })
  assert.equal(detection.configFiles[0], 'package.json')
  assert.equal(detection.configFiles.includes('package.json'), true)
  assert.equal(detection.packageManagers.includes('pnpm'), true)
  assert.equal(detection.entryPoints.includes('index.html'), true)
})

test('空项目不伪造结论', () => {
  const detection = detectProject({ files: [] })
  assert.equal(detection.primaryLanguage, '')
  assert.deepEqual(detection.languages, [])
  assert.deepEqual(detection.entryPoints, [])
  assert.deepEqual(detection.configFiles, [])
  assert.deepEqual(detection.packageManagers, [])
})
