#!/usr/bin/env node
/**
 * 生成 docs/images/preview.html：所有数字来自真实调用，避免手写快照与代码漂移。
 * 用法：node scripts/showcase.mjs [--screenshot]
 * 截图需要浏览器：node scripts/showcase.mjs --screenshot 会提示用浏览器工具打开该文件。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { scanProject } from '../lib/services/project-scanner.js'
import { analyzeProjectDependencies } from '../lib/services/dependency-service.js'
import { PLUGIN_VERSION } from '../lib/version.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'docs', 'images')
mkdirSync(outDir, { recursive: true })

const scan = await scanProject({ root, limits: { maxDepth: 3, maxEntries: 5000 } })
const selfDeps = await analyzeProjectDependencies({ root: join(root, 'src'), limits: { maxFiles: 500, maxFileBytes: 262144 } })
const sampleDeps = await analyzeProjectDependencies({ root: join(root, 'examples', 'sample-python-app'), limits: { maxFiles: 200, maxFileBytes: 262144 } })

const report = selfDeps.report
const sample = sampleDeps.report
const kb = (bytes) => (bytes / 1024).toFixed(1) + ' KB'
const tools = ['scan_project', 'analyze_dependencies', 'task_create', 'task_list', 'task_get', 'task_update', 'generate_architecture_report', 'generate_readme_draft', 'plugin_info', 'plugin_logs']

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-projectops 效果图</title>
<style>
:root{color-scheme:dark}body{margin:0;padding:32px;width:1280px;background:#0b0f16;color:#e8eefc;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
h1{font-size:26px;margin:0 0 4px}.sub{color:#8fa1bd;font-size:13px;margin-bottom:20px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card{background:#111826;border:1px solid #1f2b3d;border-radius:14px;padding:18px 20px}
.card h2{font-size:15px;margin:0 0 12px;color:#9fb4d4}.row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed #1c2739;font-size:13px}
.row:last-child{border-bottom:none}.row span:first-child{color:#8fa1bd}.mono{font-family:ui-monospace,Consolas,monospace}
.stat{display:flex;gap:14px;margin-bottom:10px}.stat div{flex:1;background:#0d1420;border:1px solid #1c2739;border-radius:10px;padding:10px 12px}
.stat b{display:block;font-size:22px}.stat small{color:#8296b3;font-size:11px}
.tool{font-family:ui-monospace,Consolas,monospace;font-size:12px;padding:5px 10px;border-radius:999px;background:#142033;border:1px solid #24354d;color:#cfe0fb;display:inline-block;margin:0 6px 6px 0}
.tag{font-size:11px;padding:2px 8px;border-radius:6px;margin-left:6px}.ok{background:#123023;color:#7ee2a8}.bad{background:#33191b;color:#ff9d94}
.foot{margin-top:20px;color:#6f83a1;font-size:12px}
</style></head><body>
<h1>DSH ProjectOps <span style="font-size:13px;color:#7ee2a8">v${PLUGIN_VERSION}</span></h1>
<div class="sub">DeepSeek Harness 项目工程管家插件 · 10 个工具 · 只读默认 · 工作区边界校验</div>
<div class="card" style="margin-bottom:18px"><h2>已注册工具</h2>${tools.map((tool) => '<span class="tool">' + tool + '</span>').join('')}</div>
<div class="grid">
  <div class="card"><h2>scan_project · 本仓库</h2>
    <div class="stat"><div><b>${scan.stats.files}</b><small>文件</small></div><div><b>${scan.stats.directories}</b><small>目录</small></div><div><b>${kb(scan.stats.bytes)}</b><small>体积</small></div></div>
    <div class="row"><span>主导语言</span><span>${scan.detection.primaryLanguage || '未识别'}</span></div>
    <div class="row"><span>语言分布</span><span>${scan.detection.languages.join('、')}</span></div>
    <div class="row"><span>包管理器</span><span>${scan.detection.packageManagers.join('、') || '未识别'}</span></div>
    <div class="row"><span>跳过敏感文件</span><span>${scan.stats.skippedSensitive} 个</span></div>
  </div>
  <div class="card"><h2>analyze_dependencies · 自分析 src/</h2>
    <div class="stat"><div><b>${report.stats.modules}</b><small>模块</small></div><div><b>${report.stats.edges}</b><small>依赖边</small></div><div><b>${report.stats.cycles}</b><small>循环依赖</small></div></div>
    <div class="row"><span>语言判定</span><span>${report.language}</span></div>
    <div class="row"><span>不可解析导入</span><span>${report.unresolved.length}</span></div>
    <div class="row"><span>外部依赖</span><span class="mono" style="font-size:12px">${report.external.slice(0, 4).map((item) => item.name + '(' + item.files + ')').join('、')}</span></div>
  </div>
  <div class="card"><h2>示例 Python 项目 · 循环依赖 <span class="tag bad">已确认</span></h2>
    <div class="stat"><div><b>${sample.stats.modules}</b><small>模块</small></div><div><b>${sample.stats.edges}</b><small>边</small></div><div><b>${sample.stats.cycles}</b><small>循环</small></div></div>
    <div class="row"><span>强连通分量</span><span class="mono" style="font-size:12px">${sample.cycles.map((cycle) => cycle.modules.join(' ↔ ')).join('; ') || '无'}</span></div>
    <div class="row"><span>外部依赖</span><span>${sample.external.map((item) => item.name).join('、') || '无'}</span></div>
  </div>
  <div class="card"><h2>自证与可观测</h2>
    <div class="row"><span>plugin_info</span><span>版本 / 构建时间 / 生效配置 / 工具清单</span></div>
    <div class="row"><span>plugin_logs</span><span>最近 200 条（脱敏、环形缓冲）</span></div>
    <div class="row"><span>文档生成</span><span>默认 dry-run、默认不覆盖</span></div>
    <div class="row"><span>任务库</span><span>SQLite + 依赖调度 + 事务</span></div>
  </div>
</div>
<div class="foot">数据生成于 ${new Date().toISOString()}；由 scripts/showcase.mjs 调用真实服务生成，请勿手改。</div>
</body></html>`

const target = join(outDir, 'preview.html')
writeFileSync(target, html, 'utf8')
console.log('written:', target)
console.log('scan:', scan.stats.files, 'files |', 'self deps:', report.stats.modules, 'modules /', report.stats.edges, 'edges /', report.stats.cycles, 'cycles | sample cycles:', sample.stats.cycles)
if (process.argv.includes('--screenshot')) console.log('用浏览器打开该文件后截图（或用 browser_navigate + browser_screenshot）')
