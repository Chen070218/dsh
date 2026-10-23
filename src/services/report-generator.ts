/**
 * Markdown 架构报告生成（第五阶段）。
 *
 * 输出结构固定，方便人读也方便测：
 *   项目概览 / 目录结构 / 模块与职责 / 依赖关系（含 Mermaid）/ 已确认的问题 / 启发式观察 / 改进建议 / 附录
 *
 * 诚实原则：把"静态可确认"（import 边、循环依赖、未解析导入）和"启发式"（缺测试目录、目录过深、
 * 外部依赖集中）分成两节，绝不混在一起当结论。
 */
import type { DependencyReport } from './dependency-analyzer.js'
import { renderDependencyGraph } from './mermaid-renderer.js'
import type { ScanResult } from '../types.js'
import { formatBytes } from '../util/text.js'

const FENCE = String.fromCharCode(96, 96, 96)

export interface TaskSummary {
  pending: number
  in_progress: number
  completed: number
  failed: number
}

export interface ReportInput {
  scan: ScanResult
  dependencies?: DependencyReport
  tasks?: TaskSummary
  generatedAt?: string
  projectName?: string
}

export interface ReportFinding {
  kind: 'confirmed' | 'heuristic'
  message: string
}

export interface ArchitectureReport {
  markdown: string
  sections: string[]
  findings: ReportFinding[]
}

function topLevelDirectories(scan: ScanResult): Array<{ path: string; files: number; bytes: number }> {
  return scan.directorySummary.slice(0, 12)
}

/** 每个顶层目录被项目内部依赖的次数（事实，不做推断）。 */
function inboundByTopDirectory(dependencies: DependencyReport | undefined): Map<string, number> {
  const counts = new Map<string, number>()
  if (dependencies === undefined) return counts
  for (const edge of dependencies.edges) {
    const slash = edge.to.indexOf('/')
    if (slash <= 0) continue
    const top = edge.to.slice(0, slash)
    counts.set(top, (counts.get(top) ?? 0) + 1)
  }
  return counts
}

/** 每个模块被多少个项目内模块依赖（事实）。 */
function inboundByModule(dependencies: DependencyReport | undefined): Map<string, number> {
  const counts = new Map<string, number>()
  if (dependencies === undefined) return counts
  for (const edge of dependencies.edges) counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1)
  return counts
}

function describeLanguages(scan: ScanResult): string {
  if (scan.detection.languages.length === 0) return '未识别（可能是空目录或非常规文件类型）'
  const primary = scan.detection.primaryLanguage === '' ? '未识别' : scan.detection.primaryLanguage
  return primary + '（分布：' + scan.detection.languages.join('、') + '）'
}

function externalConcentration(dependencies: DependencyReport | undefined): string[] {
  if (dependencies === undefined) return []
  const total = dependencies.external.reduce((sum, item) => sum + item.files, 0)
  if (total === 0) return []
  // 只有被足够多文件引用时才算「集中」，否则 2 个外部依赖各被 1 个文件引用都会误报。
  return dependencies.external
    .slice(0, 3)
    .filter((item) => item.files >= 3 && item.files / total >= 0.3)
    .map((item) => '外部依赖 ' + item.name + ' 被 ' + item.files + ' 个文件引用，集中度较高，升级时注意兼容性')
}

export function generateArchitectureReport(input: ReportInput): ArchitectureReport {
  const scan = input.scan
  const dependencies = input.dependencies
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const projectName = input.projectName ?? 'project'
  const findings: ReportFinding[] = []
  const sections: string[] = []
  const lines: string[] = []

  lines.push('# ' + projectName + ' 架构说明')
  lines.push('')
  lines.push('> 由 dsh-projectops 自动生成于 ' + generatedAt + '。')
  lines.push('> 报告中「静态可确认」的部分来自源码解析（import 语句），「启发式观察」来自文件名与规模统计，请区别对待。')
  lines.push('')

  // 1. 项目概览
  sections.push('项目概览')
  lines.push('## 1. 项目概览')
  lines.push('')
  lines.push('| 项目 | 值 |')
  lines.push('| --- | --- |')
  lines.push('| 项目根目录 | ' + scan.root + ' |')
  lines.push('| 主导语言 | ' + describeLanguages(scan) + ' |')
  lines.push('| 文件 / 目录 | ' + scan.stats.files + ' / ' + scan.stats.directories + ' |')
  lines.push('| 代码体积 | ' + formatBytes(scan.stats.bytes) + ' |')
  lines.push('| 入口文件 | ' + (scan.detection.entryPoints.join('、') || '未识别') + ' |')
  lines.push('| 配置文件 | ' + (scan.detection.configFiles.join('、') || '未识别') + ' |')
  lines.push('| 包管理器 | ' + (scan.detection.packageManagers.join('、') || '未识别') + ' |')
  lines.push('| 跳过敏感文件 | ' + scan.stats.skippedSensitive + ' 个 |')
  lines.push('')

  // 2. 目录结构
  sections.push('目录结构')
  lines.push('## 2. 目录结构')
  lines.push('')
  if (scan.tree.length === 0) {
    lines.push('_未采集目录树_')
  } else {
    lines.push(FENCE + 'text')
    for (const line of scan.tree) lines.push(line)
    lines.push(FENCE)
  }
  lines.push('')

  // 3. 模块与职责
  sections.push('模块与职责')
  lines.push('## 3. 模块与职责')
  lines.push('')
  const topDirs = topLevelDirectories(scan)
  const inboundDirs = inboundByTopDirectory(dependencies)
  if (topDirs.length === 0) {
    lines.push('_项目根目录下没有子目录_')
  } else {
    // 只给事实：文件数 / 体积 / 被内部依赖次数。不再用目录名猜职责。
    lines.push('| 目录 | 文件数 | 体积 | 被内部依赖次数 |')
    lines.push('| --- | --- | --- | --- |')
    for (const dir of topDirs) {
      lines.push('| ' + dir.path + '/ | ' + dir.files + ' | ' + formatBytes(dir.bytes) + ' | ' + (inboundDirs.get(dir.path) ?? 0) + ' |')
    }
    lines.push('')
    lines.push('_说明：本表不含"职责推断"。目录职责需要人来定义，工具只提供可核对的事实。_')
  }
  lines.push('')
  if (dependencies !== undefined && dependencies.modules.length > 0) {
    lines.push('### Python 模块清单')
    lines.push('')
    const inbound = inboundByModule(dependencies)
    lines.push('| 模块 | 文件 | import 语句数 | 被依赖次数 |')
    lines.push('| --- | --- | --- | --- |')
    for (const node of dependencies.modules.slice(0, 40)) {
      lines.push('| ' + node.module + ' | ' + node.path + ' | ' + node.imports + ' | ' + (inbound.get(node.module) ?? 0) + ' |')
    }
    if (dependencies.modules.length > 40) lines.push('| … | 共 ' + dependencies.modules.length + ' 个模块 | |')
    lines.push('')
  }

  // 4. 依赖关系
  sections.push('依赖关系')
  lines.push('## 4. 依赖关系')
  lines.push('')
  if (dependencies === undefined) {
    lines.push('_未执行依赖分析（仅做结构扫描）_')
  } else if (dependencies.edges.length === 0) {
    lines.push('_没有解析到项目内模块之间的依赖边_')
  } else {
    lines.push('### 项目内依赖')
    lines.push('')
    lines.push('| 从 | 到 | 类型 | 首次出现行 |')
    lines.push('| --- | --- | --- | --- |')
    for (const edge of dependencies.edges.slice(0, 60)) {
      lines.push('| ' + edge.from + ' | ' + edge.to + ' | ' + edge.kind + ' | ' + edge.line + ' |')
    }
    if (dependencies.edges.length > 60) lines.push('| … | 共 ' + dependencies.edges.length + ' 条 | | |')
    lines.push('')
    lines.push('### 架构图')
    lines.push('')
    lines.push(FENCE + 'mermaid')
    for (const line of renderDependencyGraph(dependencies).mermaid.split('\n')) lines.push(line)
    lines.push(FENCE)
    lines.push('')
    if (dependencies.external.length > 0) {
      lines.push('### 外部依赖')
      lines.push('')
      lines.push('| 名称 | 引用文件数 |')
      lines.push('| --- | --- |')
      for (const item of dependencies.external.slice(0, 20)) lines.push('| ' + item.name + ' | ' + item.files + ' |')
      lines.push('')
    }
  }

  // 5. 已确认的问题
  sections.push('已确认的问题')
  lines.push('## 5. 已确认的问题（静态可确认）')
  lines.push('')
  if (dependencies === undefined) {
    lines.push('_未执行依赖分析，无法给出依赖层面的确认结论_')
  } else {
    if (dependencies.cycles.length === 0) {
      lines.push('- 未发现循环依赖。')
    } else {
      for (const cycle of dependencies.cycles) {
        const message = '循环依赖：' + cycle.modules.join(' <-> ')
        findings.push({ kind: 'confirmed', message })
        lines.push('- **' + message + '**（import 图强连通分量，确定存在）')
      }
    }
    if (dependencies.unresolved.length > 0) {
      const message = dependencies.unresolved.length + ' 处相对导入无法解析（可能缺少包文件或层级越界）'
      findings.push({ kind: 'confirmed', message })
      lines.push('- ' + message + '：')
      for (const item of dependencies.unresolved.slice(0, 10)) {
        lines.push('  - ' + item.from + ' 第 ' + item.line + ' 行：' + item.specifier)
      }
    }
    if (dependencies.truncated) lines.push('- 依赖分析因文件数上限被截断，结论不完整。')
  }
  lines.push('')

  // 6. 启发式观察
  sections.push('启发式观察')
  lines.push('## 6. 启发式观察（基于文件名与规模，仅供参考）')
  lines.push('')
  const heuristics: string[] = []
  if (!scan.detection.configFiles.some((file) => file.endsWith('package.json') || file.endsWith('pyproject.toml'))) {
    heuristics.push('没有发现 package.json / pyproject.toml 这类项目清单，依赖与构建方式可能只写在文档里')
  }
  if (scan.stats.directories > 25) heuristics.push('目录数偏多（' + scan.stats.directories + ' 个），建议检查是否有可以合并的层级')
  if (scan.stats.files > 0 && scan.stats.bytes / scan.stats.files > 200 * 1024) {
    heuristics.push('平均文件体积偏大（' + formatBytes(Math.round(scan.stats.bytes / scan.stats.files)) + '），可能存在应拆分的巨型文件')
  }
  const biggest = topDirs[0]
  if (biggest !== undefined && scan.stats.files > 0 && biggest.files / scan.stats.files >= 0.5) {
    heuristics.push('超过一半文件集中在 ' + biggest.path + '/，模块划分可能不均')
  }
  for (const item of externalConcentration(dependencies)) heuristics.push(item)
  const nestedEdges = (dependencies?.edges ?? []).filter((edge) => edge.scope === 'nested').length
  if (nestedEdges > 0) {
    heuristics.push(
      '有 ' + nestedEdges + ' 条依赖写在函数/条件体内，运行时不一定执行；依赖图上的这些边用虚线表示',
    )
  }
  if (heuristics.length === 0) {
    lines.push('- 没有发现明显的规模异常。')
  } else {
    for (const message of heuristics) {
      findings.push({ kind: 'heuristic', message })
      lines.push('- ' + message)
    }
  }
  lines.push('')

  // 7. 改进建议
  sections.push('改进建议')
  lines.push('## 7. 改进建议')
  lines.push('')
  const suggestions: string[] = []
  const hasCycle = dependencies !== undefined && dependencies.cycles.length > 0
  const hasUnresolved = dependencies !== undefined && dependencies.unresolved.length > 0
  const hasNested = (dependencies?.edges ?? []).some((edge) => edge.scope === 'nested')
  const hasTestsDirectory = topDirs.some((dir) => /^(tests?|spec|__tests__|e2e)$/i.test(dir.path))
  const hasManifest = scan.detection.configFiles.some((file) => /package\.json$|pyproject\.toml$|setup\.py$/.test(file))

  // 建议由"命中的事实"驱动：没有命中的规则不输出，避免一份报告给所有人同一套建议。
  if (hasCycle) {
    suggestions.push('优先拆循环：把被多个模块共用的部分抽成独立模块，让依赖方向单向化（当前 ' + dependencies!.cycles.length + ' 处强连通分量）')
  }
  if (hasUnresolved) {
    suggestions.push('补齐无法解析的导入：检查包 __init__.py、tsconfig paths 或文件是否缺失（当前 ' + dependencies!.unresolved.length + ' 处）')
  }
  if (hasNested) {
    suggestions.push('把函数/条件体内的导入上提到模块顶层，或在文档中说明它们的可选性（依赖图上这些边是虚线）')
  }
  if (!hasManifest) {
    suggestions.push('补一份项目清单（package.json / pyproject.toml），声明依赖、脚本与入口')
  }
  if (scan.detection.entryPoints.length === 0) {
    suggestions.push('补一个明确的入口文件（main.py / index.ts），方便调用方与工具识别')
  }
  if (!hasTestsDirectory && scan.stats.files > 20) {
    suggestions.push('建一个 tests/ 目录并把测试命令写进项目清单的 scripts')
  }
  if (input.tasks !== undefined) {
    if (input.tasks.failed > 0) {
      suggestions.push('有 ' + input.tasks.failed + ' 个失败任务：先看 task_get 的执行记录再决定重试或拆小')
    }
    suggestions.push(
      '当前任务队列：待处理 ' + input.tasks.pending + ' / 进行中 ' + input.tasks.in_progress + ' / 已完成 ' + input.tasks.completed + ' / 失败 ' + input.tasks.failed,
    )
  }
  if (suggestions.length === 0) suggestions.push('项目结构看起来比较规整，暂无结构性建议')
  for (const suggestion of suggestions) lines.push('- ' + suggestion)
  lines.push('')

  // 8. 附录
  sections.push('附录')
  lines.push('## 8. 附录：数据来源与限制')
  lines.push('')
  lines.push('- 结构扫描：maxDepth / maxEntries 限制下的目录遍历，已排除版本库、依赖缓存、构建产物与敏感文件。')
  lines.push('- 依赖分析：Python import 的静态词法解析（不执行代码、不构建 AST），动态导入无法识别。')
  lines.push('- 扫描耗时 ' + scan.durationMs + ' ms' + (dependencies === undefined ? '' : '，依赖分析耗时 ' + dependencies.durationMs + ' ms') + '。')
  if (scan.warnings.length > 0) {
    lines.push('')
    lines.push('### 扫描告警')
    for (const warning of scan.warnings) lines.push('- ' + warning)
  }
  if (dependencies !== undefined && dependencies.warnings.length > 0) {
    lines.push('')
    lines.push('### 依赖分析告警')
    for (const warning of dependencies.warnings) lines.push('- ' + warning)
  }
  lines.push('')

  return { markdown: lines.join('\n'), sections, findings }
}

export function generateReadmeDraft(input: { scan: ScanResult; projectName: string; description?: string }): string {
  const scan = input.scan
  const lines: string[] = []
  lines.push('# ' + input.projectName)
  lines.push('')
  lines.push(input.description ?? '（一句话说明这个项目解决什么问题）')
  lines.push('')
  lines.push('## 特性')
  lines.push('')
  lines.push('- （待补充）')
  lines.push('')
  lines.push('## 快速开始')
  lines.push('')
  const manager = scan.detection.packageManagers[0]
  if (manager === 'pnpm' || manager === 'yarn' || manager === 'npm' || manager === 'bun') {
    lines.push(FENCE + 'bash')
    lines.push(manager === 'npm' ? 'npm install' : manager + ' install')
    lines.push(manager === 'npm' ? 'npm run build' : manager + ' build')
    lines.push(FENCE)
  } else if (manager === 'poetry' || manager === 'uv' || manager === 'pip') {
    lines.push(FENCE + 'bash')
    if (manager === 'poetry') lines.push('poetry install')
    else if (manager === 'uv') lines.push('uv sync')
    else lines.push('python -m venv .venv && pip install -r requirements.txt')
    lines.push(FENCE)
  } else {
    lines.push('（补充安装与运行命令）')
  }
  lines.push('')
  lines.push('## 项目结构')
  lines.push('')
  lines.push(FENCE + 'text')
  for (const line of scan.tree.slice(0, 40)) lines.push(line)
  if (scan.tree.length > 40) lines.push('...')
  lines.push(FENCE)
  lines.push('')
  lines.push('## 入口与配置')
  lines.push('')
  lines.push('- 入口文件：' + (scan.detection.entryPoints.join('、') || '（待补充）'))
  lines.push('- 配置文件：' + (scan.detection.configFiles.join('、') || '（待补充）'))
  lines.push('')
  lines.push('## License')
  lines.push('')
  lines.push('（补充许可证）')
  return lines.join('\n')
}
