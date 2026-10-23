/** 语言 / 入口文件 / 配置文件的启发式识别。 */
import type { ProjectDetection } from '../types.js'

/** 扩展名 -> 语言名。只做识别，不做解析。 */
export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.py': 'Python',
  '.pyi': 'Python',
  '.ipynb': 'Jupyter Notebook',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.go': 'Go',
  '.rs': 'Rust',
  '.c': 'C',
  '.h': 'C',
  '.cc': 'C++',
  '.cpp': 'C++',
  '.hpp': 'C++',
  '.cs': 'C#',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.swift': 'Swift',
  '.scala': 'Scala',
  '.sh': 'Shell',
  '.ps1': 'PowerShell',
  '.sql': 'SQL',
  '.html': 'HTML',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.md': 'Markdown',
  '.json': 'JSON',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.toml': 'TOML',
}

const ENTRY_FILE_NAMES = new Set([
  'main.py',
  'app.py',
  'manage.py',
  '__main__.py',
  'run.py',
  'index.js',
  'index.ts',
  'index.mjs',
  'main.js',
  'main.ts',
  'main.mjs',
  'server.js',
  'server.ts',
  'app.js',
  'app.ts',
  'main.go',
  'main.rs',
  'Main.java',
  'Program.cs',
  'index.html',
])

const CONFIG_FILE_NAMES = new Set([
  'package.json',
  'tsconfig.json',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'requirements.txt',
  'Pipfile',
  'poetry.lock',
  'uv.lock',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'CMakeLists.txt',
  'Makefile',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yaml',
  '.gitlab-ci.yml',
  'Gemfile',
  'composer.json',
  'tsconfig.base.json',
  'vite.config.ts',
  'vitest.config.ts',
])

const PACKAGE_MANAGER_MARKERS: ReadonlyArray<{ file: string; manager: string }> = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'poetry.lock', manager: 'poetry' },
  { file: 'uv.lock', manager: 'uv' },
  { file: 'Pipfile.lock', manager: 'pipenv' },
  { file: 'Cargo.lock', manager: 'cargo' },
  { file: 'go.sum', manager: 'go modules' },
  { file: 'Gemfile.lock', manager: 'bundler' },
]

export function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index === -1 ? normalized : normalized.slice(index + 1)
}

export function extensionOf(name: string): string {
  const base = basename(name)
  const index = base.lastIndexOf('.')
  if (index <= 0) return ''
  return base.slice(index).toLowerCase()
}

export function depthOf(relativePath: string): number {
  return relativePath.split('/').length
}

export interface DetectInput {
  /** 扫描到的文件相对路径，统一使用 '/' 分隔。 */
  files: readonly string[]
}

export function detectProject(input: DetectInput): ProjectDetection {
  const languageCounter = new Map<string, number>()
  const extensionCounter = new Map<string, number>()
  const entryPoints: string[] = []
  const configFiles: string[] = []
  const presentNames = new Set<string>()

  for (const relativePath of input.files) {
    const name = basename(relativePath)
    const extension = extensionOf(name)
    presentNames.add(name)
    if (extension !== '') {
      extensionCounter.set(extension, (extensionCounter.get(extension) ?? 0) + 1)
      const language = LANGUAGE_BY_EXTENSION[extension]
      if (language !== undefined) languageCounter.set(language, (languageCounter.get(language) ?? 0) + 1)
    }
    if (ENTRY_FILE_NAMES.has(name)) entryPoints.push(relativePath)
    if (CONFIG_FILE_NAMES.has(name)) configFiles.push(relativePath)
  }

  const languages = [...languageCounter.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([language]) => language)

  const packageManagers: string[] = []
  for (const marker of PACKAGE_MANAGER_MARKERS) {
    if (presentNames.has(marker.file)) packageManagers.push(marker.manager)
  }
  if (packageManagers.length === 0 && presentNames.has('package.json')) packageManagers.push('npm')
  if (packageManagers.length === 0 && (presentNames.has('pyproject.toml') || presentNames.has('requirements.txt'))) {
    packageManagers.push('pip')
  }

  const byDepth = (left: string, right: string): number => depthOf(left) - depthOf(right) || left.localeCompare(right)

  return {
    languages,
    primaryLanguage: languages[0] ?? '',
    entryPoints: [...new Set(entryPoints)].sort(byDepth).slice(0, 10),
    configFiles: [...new Set(configFiles)].sort(byDepth).slice(0, 12),
    packageManagers,
  }
}
