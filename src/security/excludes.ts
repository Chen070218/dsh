/** 目录排除与敏感文件识别：扫描的第一道过滤线。 */

/** 依赖缓存、构建产物、VCS 元数据：扫描时完全不进入。 */
export const DEFAULT_EXCLUDED_DIRS: readonly string[] = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.gradle',
  '.idea',
  '.vscode',
  'site-packages',
  'vendor',
]

/** 文件名命中即视为敏感文件：不列出、不读取、不写日志。 */
export const SENSITIVE_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env(\..*)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pgpass$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /\.jks$/i,
  /\.keystore$/i,
  /^credentials?$/i,
  /^credentials?\..+$/i,
  /^secrets?$/i,
  /^secrets?\..+$/i,
]

export function isExcludedDir(name: string): boolean {
  const lower = name.toLowerCase()
  return DEFAULT_EXCLUDED_DIRS.some((dir) => dir.toLowerCase() === lower)
}

export function isSensitiveFile(name: string): boolean {
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(name))
}
