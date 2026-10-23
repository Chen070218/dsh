/**
 * 依赖分析路由：按显式语言或自动探测（比较 .py 与 JS/TS 文件数）选择分析器。
 *
 * 有意只跑一种语言：混合仓库里把两种语言的模块名硬凑进一张图会产生误导性的"循环依赖"。
 * 探测结果与实际分析语言一起返回，调用方可以据此判断是否需要带 language 再跑一次。
 */
import type { FsPort } from '../adapters/fs-adapter.js'
import { createNodeFsPort } from '../adapters/fs-adapter.js'
import type { SourceReader } from '../adapters/source-reader.js'
import type { DependencyReport } from './dependency-analyzer.js'
import type { AnalyzerLimits, } from './dependency-analyzer.js'
import { analyzeDependencies } from './dependency-analyzer.js'
import { JS_EXTENSIONS, analyzeJavaScriptDependencies } from './js-dependency-analyzer.js'
import { collectSourceFiles } from './source-files.js'
import type { Logger } from '../util/logger.js'

export type LanguageOption = 'auto' | 'python' | 'javascript'

export interface ProjectAnalyzeRequest {
  root: string
  limits: AnalyzerLimits
  language?: LanguageOption
  port?: FsPort
  reader?: SourceReader
  logger?: Logger
}

export interface LanguageCounts {
  python: number
  javascript: number
}

export interface ProjectAnalyzeResult {
  report: DependencyReport
  detected: LanguageCounts
  /** 探测到两种语言都有文件时为 true（本次只分析了其中一种）。 */
  mixedProject: boolean
}

const PYTHON_EXTENSIONS: readonly string[] = ['.py', '.pyi']

export async function analyzeProjectDependencies(request: ProjectAnalyzeRequest): Promise<ProjectAnalyzeResult> {
  const port = request.port ?? createNodeFsPort()
  const warnings: string[] = []
  const pythonFiles = await collectSourceFiles(request.root, port, {
    extensions: PYTHON_EXTENSIONS,
    maxFiles: 20000,
    warnings,
  })
  const javascriptFiles = await collectSourceFiles(request.root, port, {
    extensions: JS_EXTENSIONS,
    maxFiles: 20000,
    warnings,
  })
  const detected: LanguageCounts = { python: pythonFiles.length, javascript: javascriptFiles.length }
  const mixedProject = detected.python > 0 && detected.javascript > 0

  const requested = request.language ?? 'auto'
  let language: 'python' | 'javascript'
  if (requested === 'auto') {
    language = detected.javascript >= detected.python ? 'javascript' : 'python'
  } else {
    language = requested
  }

  // 显式指定但该语言没有文件时，退回另一种语言并留下告警，而不是返回空报告。
  if (detected[language] === 0) {
    const fallback = language === 'python' ? 'javascript' : 'python'
    if (detected[fallback] > 0) language = fallback
  }

  const report =
    language === 'python'
      ? await analyzeDependencies({
          root: request.root,
          limits: request.limits,
          port: request.port,
          reader: request.reader,
          logger: request.logger,
        })
      : await analyzeJavaScriptDependencies({
          root: request.root,
          limits: request.limits,
          port: request.port,
          reader: request.reader,
          logger: request.logger,
        })

  return { report, detected, mixedProject }
}
