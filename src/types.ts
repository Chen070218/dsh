/** 领域模型：扫描器与工具之间共享的数据结构。 */

export type FileKind = 'file' | 'directory' | 'symlink' | 'other'

export interface ExtensionCount {
  extension: string
  count: number
}

export interface DirectorySummary {
  /** 相对项目根的目录路径（'/' 分隔）。 */
  path: string
  files: number
  bytes: number
}

export interface ProjectDetection {
  languages: string[]
  /** 主导语言；无法判断时为空字符串。 */
  primaryLanguage: string
  entryPoints: string[]
  configFiles: string[]
  packageManagers: string[]
}

export interface ScanStats {
  files: number
  directories: number
  symlinks: number
  bytes: number
  skippedSensitive: number
  skippedHidden: number
  byExtension: ExtensionCount[]
}

export interface ScanResult {
  root: string
  detection: ProjectDetection
  stats: ScanStats
  /** 项目根的直接子目录汇总，按字节数倒序。 */
  directorySummary: DirectorySummary[]
  /** 渲染好的目录树文本行，可直接输出给用户。 */
  tree: string[]
  truncated: boolean
  warnings: string[]
  durationMs: number
}

export interface ScanLimits {
  maxDepth: number
  maxEntries: number
}

export interface ScanFilterOptions {
  /** 是否把点开头的隐藏文件/目录计入结果（默认 false）。 */
  includeHidden?: boolean
  /** 额外的目录名排除项（大小写不敏感）。 */
  extraExcludes?: readonly string[]
}
