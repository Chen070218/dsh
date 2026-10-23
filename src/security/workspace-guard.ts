/**
 * 工作区守卫：所有文件访问的唯一入口。
 *
 * 两条硬规则：
 * 1. 目标路径（经 realpath 解析后）必须落在某个已授权根目录内，否则拒绝；
 * 2. 只做白名单判断，不做“尽力而为”的越权尝试。
 * 通过 realpath 解析可以挡住符号链接逃逸；对尚不存在的路径则解析“最近的已存在祖先”，
 * 这样即使目标还没创建，`../` 穿越也无法绕过边界检查。
 */
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { ErrorCode, ProjectOpsError, mapFsError } from '../util/errors.js'

export interface ResolveOptions {
  /** 相对路径的解析基准，默认第一个授权根目录。 */
  baseDir?: string
  /** 要求目标必须已经存在（默认 true）。 */
  mustExist?: boolean
  /** 期望的类型；不匹配时抛出明确错误。 */
  expect?: 'directory' | 'file' | 'any'
}

export interface ResolvedTarget {
  absolutePath: string
  root: string
}

export interface WorkspaceGuard {
  readonly roots: readonly string[]
  contains(candidate: string): boolean
  resolve(requested: string, options?: ResolveOptions): ResolvedTarget
}

function comparable(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isInside(candidate: string, root: string): boolean {
  const left = comparable(candidate)
  const right = comparable(root)
  if (left === right) return true
  const prefix = right.endsWith(sep) ? right : right + sep
  return left.startsWith(prefix)
}

function realpathIfExists(path: string): string | undefined {
  try {
    return realpathSync.native(path)
  } catch {
    return undefined
  }
}

/** 对不存在的路径：解析最近的已存在祖先，再把剩余片段拼回去。 */
function realpathOfNearestExisting(path: string): string {
  const pending: string[] = []
  let current = resolve(path)
  for (;;) {
    const real = realpathIfExists(current)
    if (real !== undefined) return pending.length === 0 ? real : join(real, ...pending.slice().reverse())
    const parent = resolve(current, '..')
    if (parent === current) throw new ProjectOpsError(ErrorCode.INVALID_PATH, '无法解析路径: ' + path)
    pending.push(current.slice(parent.length).replace(/^[\\/]+/, ''))
    current = parent
  }
}

export function createWorkspaceGuard(options: { roots: readonly string[] }): WorkspaceGuard {
  if (!Array.isArray(options.roots) || options.roots.length === 0) {
    throw new ProjectOpsError(ErrorCode.INVALID_PATH, '至少需要一个授权工作区根目录')
  }

  const roots: string[] = []
  for (const candidate of options.roots) {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) continue
    const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(process.cwd(), candidate)
    const real = realpathIfExists(absolute)
    if (real === undefined) {
      throw new ProjectOpsError(ErrorCode.NOT_FOUND, '授权工作区不存在: ' + absolute)
    }
    let isDirectory = false
    try {
      isDirectory = statSync(real).isDirectory()
    } catch (error) {
      throw mapFsError(error, real)
    }
    if (!isDirectory) {
      throw new ProjectOpsError(ErrorCode.NOT_A_DIRECTORY, '授权工作区必须是目录: ' + real)
    }
    if (!roots.some((existing) => comparable(existing) === comparable(real))) roots.push(real)
  }
  if (roots.length === 0) {
    throw new ProjectOpsError(ErrorCode.INVALID_PATH, '没有可用的授权工作区根目录')
  }

  return {
    roots,
    contains(candidate) {
      if (typeof candidate !== 'string' || candidate.length === 0) return false
      const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(roots[0] as string, candidate)
      const real = realpathIfExists(absolute) ?? realpathOfNearestExisting(absolute)
      return roots.some((root) => isInside(real, root))
    },
    resolve(requested, options = {}) {
      if (typeof requested !== 'string' || requested.length === 0) {
        throw new ProjectOpsError(ErrorCode.INVALID_PATH, '路径必须是非空字符串')
      }
      if (requested.includes('\0')) {
        throw new ProjectOpsError(ErrorCode.INVALID_PATH, '路径包含非法字符（NUL）')
      }
      const baseDir = options.baseDir ?? (roots[0] as string)
      const absolute = isAbsolute(requested) ? resolve(requested) : resolve(baseDir, requested)
      // 第一道检查（词法级）：先判断路径本身是否越界。
      // 这样 "../" 穿越总是得到“越界”，而不会因为目标不存在退化成 NOT_FOUND。
      if (!roots.some((candidateRoot) => isInside(absolute, candidateRoot))) {
        throw new ProjectOpsError(
          ErrorCode.PATH_OUTSIDE_WORKSPACE,
          '拒绝访问授权工作区之外的路径: ' + absolute,
          '当前授权根目录: ' + roots.join('; '),
        )
      }
      const mustExist = options.mustExist !== false
      const resolved = mustExist ? realpathIfExists(absolute) : realpathOfNearestExisting(absolute)
      if (resolved === undefined) {
        throw new ProjectOpsError(ErrorCode.NOT_FOUND, '路径不存在: ' + absolute)
      }
      const root = roots.find((candidateRoot) => isInside(resolved, candidateRoot))
      if (root === undefined) {
        throw new ProjectOpsError(
          ErrorCode.PATH_OUTSIDE_WORKSPACE,
          '拒绝访问授权工作区之外的路径: ' + absolute,
          '当前授权根目录: ' + roots.join('; '),
        )
      }
      const expect = options.expect ?? 'any'
      if (expect !== 'any' || mustExist) {
        let stats
        try {
          stats = statSync(resolved)
        } catch (error) {
          throw mapFsError(error, resolved)
        }
        if (expect === 'directory' && !stats.isDirectory()) {
          throw new ProjectOpsError(ErrorCode.NOT_A_DIRECTORY, '不是目录: ' + resolved)
        }
        if (expect === 'file' && !stats.isFile()) {
          throw new ProjectOpsError(ErrorCode.NOT_A_FILE, '不是文件: ' + resolved)
        }
      }
      return { absolutePath: resolved, root }
    },
  }
}
