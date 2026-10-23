/** 测试夹具：在系统临时目录里造一个受控的小项目，用完即删。 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface TempProject {
  readonly root: string
  write(relativePath: string, content?: string): string
  mkdir(relativePath: string): string
  path(relativePath: string): string
  cleanup(): void
}

export function createTempProject(files: Record<string, string> = {}): TempProject {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-projectops-')))
  const project: TempProject = {
    root,
    path(relativePath) {
      return join(root, relativePath)
    },
    mkdir(relativePath) {
      const target = join(root, relativePath)
      mkdirSync(target, { recursive: true })
      return target
    },
    write(relativePath, content = '') {
      const target = join(root, relativePath)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content, 'utf8')
      return target
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
  for (const [relativePath, content] of Object.entries(files)) project.write(relativePath, content)
  return project
}
