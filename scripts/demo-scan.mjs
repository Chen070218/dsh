#!/usr/bin/env node
/**
 * 手工冒烟脚本：直接调用扫描服务扫本仓库并打印报告。
 * 用途是让人肉眼确认输出质量，不替代自动化测试。
 */
import { scanProject } from '../lib/services/project-scanner.js'
import { formatBytes } from '../lib/util/text.js'

const target = process.argv[2] ?? process.cwd()
const result = await scanProject({ root: target, limits: { maxDepth: 3, maxEntries: 800 } })

console.log('root        :', result.root)
console.log('language    :', result.detection.primaryLanguage || '(未识别)')
console.log('languages   :', result.detection.languages.join(', ') || '(无)')
console.log('entryPoints :', result.detection.entryPoints.join(', ') || '(无)')
console.log('configFiles :', result.detection.configFiles.join(', ') || '(无)')
console.log('managers    :', result.detection.packageManagers.join(', ') || '(无)')
console.log(
  'size        :',
  result.stats.files + ' files / ' + result.stats.directories + ' dirs / ' + formatBytes(result.stats.bytes),
)
console.log('sensitive   :', result.stats.skippedSensitive + ' skipped')
console.log('truncated   :', result.truncated)
console.log('duration    :', result.durationMs + ' ms')
console.log('--- tree (first 30 lines) ---')
for (const line of result.tree.slice(0, 30)) console.log(line)
if (result.tree.length > 30) console.log('... 共 ' + result.tree.length + ' 行')
for (const warning of result.warnings) console.log('warning:', warning)
