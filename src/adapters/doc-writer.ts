/**
 * 文档落盘适配层（第五阶段）。
 *
 * 安全设计（对应需求里的"生成文件前检查目标路径，避免覆盖用户原有文件"）：
 * 1. 目标路径必须经 WorkspaceGuard 校验（含 realpath 边界检查）；
 * 2. 默认 dry-run：只返回计划、预览与字节数，不写磁盘；
 * 3. 目标已存在且未显式 overwrite 时拒绝覆盖，并说明原因；
 * 4. 真正写入用"临时文件 + rename"，避免写一半留下半个文件。
 */
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createWorkspaceGuard } from '../security/workspace-guard.js'
import { mapFsError } from '../util/errors.js'

export interface WriteDocumentOptions {
  roots: readonly string[]
  root: string
  relativePath: string
  content: string
  dryRun: boolean
  overwrite: boolean
  previewLines?: number
}

export interface WriteDocumentResult {
  target: string
  written: boolean
  skippedReason: string
  bytes: number
  preview: string
  plan: string[]
}

function previewOf(content: string, lines: number): string {
  return content.split('\n').slice(0, lines).join('\n')
}

export async function writeDocument(options: WriteDocumentOptions): Promise<WriteDocumentResult> {
  const guard = createWorkspaceGuard({ roots: options.roots })
  const target = guard.resolve(options.relativePath, { baseDir: options.root, mustExist: false })
  const bytes = Buffer.byteLength(options.content, 'utf8')
  const preview = previewOf(options.content, options.previewLines ?? 20)
  const plan = [
    '目标文件：' + target.absolutePath,
    '写入内容：' + bytes + ' 字节（约 ' + options.content.split('\n').length + ' 行）',
    '覆盖策略：' + (options.overwrite ? '允许覆盖已存在文件' : '遇到已存在文件则跳过'),
    hasContent(target.absolutePath) ? '目标状态：已存在' : '目标状态：不存在（将新建）',
    '执行模式：' + (options.dryRun ? 'dry-run（只预览，不写盘）' : '写入'),
  ]

  if (existsSync(target.absolutePath) && !options.overwrite) {
    return {
      target: target.absolutePath,
      written: false,
      skippedReason: '目标文件已存在且未授权覆盖（传 overwrite=true 才会替换）',
      bytes,
      preview,
      plan,
    }
  }
  if (options.dryRun) {
    return { target: target.absolutePath, written: false, skippedReason: 'dry-run 模式，未写入', bytes, preview, plan }
  }

  const temporary = join(dirname(target.absolutePath), '.' + Date.now().toString(36) + '.tmp')
  try {
    await mkdir(dirname(target.absolutePath), { recursive: true })
    await writeFile(temporary, options.content, 'utf8')
    await rename(temporary, target.absolutePath)
  } catch (error) {
    // 失败时不能留下半个文件或 .tmp 残渣
    await rm(temporary, { force: true }).catch(() => undefined)
    throw mapFsError(error, target.absolutePath)
  }

  return { target: target.absolutePath, written: true, skippedReason: '', bytes, preview, plan }
}

function hasContent(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}
