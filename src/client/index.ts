/**
 * 客户端卡片视图层（数据驱动）。
 *
 * 为什么是"数据驱动"而不是 JSX：DSH 客户端运行时（@deepseek-ai/dsh-client-*）不在本仓库依赖里，
 * 也没有可用的类型声明；硬写 React 组件既无法类型检查也无法验证渲染。这里定义**卡片描述协议**：
 * 客户端拿到这个描述后自己渲染，我们负责提供稳定的字段、徽章与状态色。
 *
 * 已可验证的部分：描述结构、10 个工具全覆盖、渲染所需的字段都在（见 tests/client.views.test.ts）。
 *
 * 已核实的环境事实（2026-10，desktop profile）：
 * - 已安装的客户端插件（如 dsh-at-file）导出 `apply` + `inject`，是宿主注入 runtime 的 CJS bundle，
 *   通过 `ctx.slots.register(...)` / `ctx.locale.register(...)` 扩展 UI；
 * - profile 的 node_modules 里**没有** @deepseek-ai/dsh-client-runtime 包，也没有任何 .d.ts，
 *   因此"注册一个真正渲染的 React 卡片"无法在本机类型检查或视觉验证。
 * 本模块因此只保证协议层；渲染层等拿到 dsh-client-runtime 后再补（见 CHANGELOG Known gaps）。
 */
export interface ToolViewField {
  label: string
  /** 值从哪里取：'result' 取输出字段，'args' 取入参字段，'literal' 直接展示。 */
  from: 'result' | 'args' | 'literal'
  path: string
  /** 可选格式提示，客户端可据此渲染进度条/徽章/代码块。 */
  format?: 'text' | 'number' | 'bytes' | 'code' | 'list'
}

export interface ToolViewSpec {
  tool: string
  title: string
  /** 折叠状态下显示的一行摘要。 */
  summary: string
  fields: ToolViewField[]
  /** 是否需要对确认类结果（如 dry-run / 拒绝覆盖）加醒目提示。 */
  attention?: 'dry-run' | 'write' | 'destructive'
}

export interface ClientToolViewRegistry {
  register(specs: readonly ToolViewSpec[]): void
}

export interface ClientContextPort {
  toolViews?: ClientToolViewRegistry
}

export function createToolViews(): ToolViewSpec[] {
  return [
    {
      tool: 'scan_project',
      title: '项目扫描',
      summary: '文件数 · 目录数 · 主导语言',
      fields: [
        { label: '根目录', from: 'result', path: 'root', format: 'code' },
        { label: '主导语言', from: 'result', path: 'detection.primaryLanguage' },
        { label: '文件 / 目录', from: 'literal', path: 'stats', format: 'text' },
        { label: '体积', from: 'result', path: 'stats.bytes', format: 'bytes' },
        { label: '缓存', from: 'result', path: 'cached' },
      ],
    },
    {
      tool: 'analyze_dependencies',
      title: '依赖分析',
      summary: '模块数 · 依赖边 · 循环依赖',
      fields: [
        { label: '语言', from: 'result', path: 'language' },
        { label: '模块数', from: 'result', path: 'stats.modules', format: 'number' },
        { label: '依赖边', from: 'result', path: 'stats.edges', format: 'number' },
        { label: '循环依赖', from: 'result', path: 'stats.cycles', format: 'number' },
        { label: 'Mermaid', from: 'result', path: 'mermaid', format: 'code' },
      ],
    },
    { tool: 'task_create', title: '创建任务', summary: '标题 · 优先级 · 依赖', fields: [{ label: '状态', from: 'result', path: 'task.state' }, { label: 'id', from: 'result', path: 'task.id', format: 'code' }] },
    { tool: 'task_list', title: '任务列表', summary: '各状态计数', fields: [{ label: '待处理', from: 'result', path: 'counts.pending', format: 'number' }, { label: '进行中', from: 'result', path: 'counts.in_progress', format: 'number' }, { label: '失败', from: 'result', path: 'counts.failed', format: 'number' }] },
    { tool: 'task_get', title: '任务详情', summary: '状态 · 依赖 · 执行记录', fields: [{ label: '状态', from: 'result', path: 'task.state' }, { label: '执行记录', from: 'result', path: 'executions', format: 'list' }] },
    { tool: 'task_update', title: '更新任务', summary: '状态流转 · 执行记录', fields: [{ label: '新状态', from: 'result', path: 'task.state' }, { label: '尝试次数', from: 'result', path: 'task.attempts', format: 'number' }] },
    {
      tool: 'generate_architecture_report',
      title: '架构说明',
      summary: 'dry-run 预览 / 写入结果',
      attention: 'dry-run',
      fields: [
        { label: '目标', from: 'result', path: 'target', format: 'code' },
        { label: '已写入', from: 'result', path: 'written' },
        { label: '跳过原因', from: 'result', path: 'skippedReason' },
        { label: '预览', from: 'result', path: 'preview', format: 'code' },
      ],
    },
    {
      tool: 'generate_readme_draft',
      title: 'README 初稿',
      summary: 'dry-run 预览 / 写入结果',
      attention: 'dry-run',
      fields: [
        { label: '目标', from: 'result', path: 'target', format: 'code' },
        { label: '已写入', from: 'result', path: 'written' },
        { label: '预览', from: 'result', path: 'preview', format: 'code' },
      ],
    },
    {
      tool: 'plugin_info',
      title: '插件状态',
      summary: '版本 · 构建时间 · 工具数',
      fields: [
        { label: '版本', from: 'result', path: 'version' },
        { label: '构建时间', from: 'result', path: 'buildTime' },
        { label: '已注册工具', from: 'result', path: 'tools', format: 'list' },
      ],
    },
    { tool: 'plugin_logs', title: '运行日志', summary: '最近若干条（已脱敏）', fields: [{ label: '条数', from: 'result', path: 'size', format: 'number' }, { label: '记录', from: 'result', path: 'records', format: 'list' }] },
  ]
}

/** 客户端入口：注册全部工具卡片。宿主没有 toolViews 服务时静默跳过（保持向前兼容）。 */
export function apply(ctx: ClientContextPort): void {
  ctx.toolViews?.register(createToolViews())
}

export const platform = 'web'

/** 与真实客户端插件一致的注入声明形状（宿主据此决定加载哪些客户端服务）。 */
export const inject = ['slots', 'locale']
