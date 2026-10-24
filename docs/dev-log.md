# 开发记录（对外版）

面向使用者的工程记录：每个阶段做了什么、关键决策、踩到并修掉的真问题、以及当前的已知边界。
机器相关的路径、账号与环境细节已移除。

## 阶段一：环境与插件骨架

先核实宿主接口，再动手：

| 事实 | 确认方式 |
| --- | --- |
| DSH 桌面运行时版本、插件框架（cordis）版本 | 读运行时 `package.json` 与已安装插件源码 |
| 插件契约：导出 `name` / `inject` / `Config`(schemastery) / `apply(ctx, config)` | 对照两个第三方插件的编译产物 |
| 工具注册：`ctx.tools.register(defineTool({...}))` | 读 `@deepseek-ai/dsh-tools` 的导出与 README |
| 参数 / 输出 schema 的受支持子集 | 读 `dsh-tools` 的 schema 编译器实现 |
| 安装形态：profile 依赖 + `dsh.profile.bundles` + 包内 `dsh.bundle.patch` | 读 profile 清单与插件 package.json |

结论：**不需要改 profile 的 `cordis.patch.yml`** —— 宿主会按 bundle 读取包内 patch。这条后来省掉了大量排错。

## 阶段二：扫描器与缓存

- 分层：工具层只管 schema/渲染，服务层放逻辑，适配层抽象文件系统（便于注入故障测试）。
- 安全集中在 `WorkspaceGuard`：先词法越界检查，再 `realpath` 检查（挡符号链接逃逸），最后类型/存在性。
- 扫描器不跟随符号链接、单目录失败只降级为告警、`maxDepth`/`maxEntries` 硬限制。
- 缓存键 = root + limits + filters；根目录 mtime 变化或超 TTL 失效。

真问题：越界曾被误报为 `NOT_FOUND`（先查存在性再查边界）。改为「先边界、后存在性」，安全错误码优先。

## 阶段三：依赖分析

- Python 用词法级 import 解析（不执行代码、不构建 AST），支持相对导入层级、括号跨行、注释/三引号排除。
- 循环依赖 = import 图的强连通分量（迭代版 Tarjan），属**静态可确认**结论；外部依赖/不可解析导入单独标注为启发式。
- 后扩展到 TypeScript / JavaScript：静态 import、`import type`、副作用导入、`export … from`、动态 `import()`、`require()`。

真问题：
1. TS ESM 的 `import './util.js'` 实际指向 `util.ts`，首版没剥后缀 → 自分析出现 109 条 unresolved、0 条边；修完 88 条边、0 unresolved。
2. 目录导入 `import './components'` 未解析到 `components/index.ts`。
3. Mermaid 注释写死 "Python"，多语言下误导。

## 阶段四：任务管理

- `node:sqlite`（Node 内置，零原生依赖），两张表：`tasks` + `task_executions`。
- 依赖调度：前置未完成时拒绝推进到 `in_progress`/`completed`（`TASK_DEPENDENCY_UNMET`）。
- 事务：状态变更与执行记录同事务提交，失败整体回滚；`PRAGMA busy_timeout` 处理并发写；`PRAGMA user_version` 作为迁移入口。
- 重试上限：`taskMaxAttempts`（默认 3），达到上限后返回 `TASK_RETRY_EXHAUSTED` 并在 `lastError` 打标记。
- 失败原因写入前脱敏（`key=value` 形式的敏感片段替换为 `[redacted]`）。

## 阶段五：文档生成

- 8 节 Markdown 架构报告：概览 / 结构 / 模块与职责事实 / 依赖+Mermaid / **已确认的问题** / **启发式观察** / 建议 / 附录。
- 「职责」一列改为**事实**（文件数、体积、被内部依赖次数），删掉了按目录名猜职责的硬编码表。
- 建议改为**事实驱动**：只有命中对应事实（循环依赖、缺清单、缺测试目录、嵌套导入）才给出建议。
- 默认 `dryRun=true`、目标已存在默认拒绝覆盖、写入用「临时文件 + rename」。

真问题：`createTasksForFindings` 在 dry-run 下也会写任务库，已改为仅在真正写入时生效。

## 工程化

| 关注点 | 做法 |
| --- | --- |
| 构建 | Node 自带类型擦除（`module.stripTypeScriptTypes`），无需 tsc/esbuild；源码必须保持可擦除语法 |
| 类型检查 | 环境无 npm 时，用脚本下载并解包 typescript 到 `node_modules`；宿主包缺 `.d.ts`，由 `types/dsh-ambient.d.ts` 按源码核实过的签名声明 |
| 测试 | `node:test`；单元 + 宿主组合 + 真实 Loader 挂载路径；无宿主环境的工具层测试用 mock `dsh-tools` 契约替身 |
| 门禁 | `verify` 一键跑 build → typecheck → 全量测试 → CI 子集 → 打包内容 → 三个 demo；另有 lint（可擦除语法/console/any/空白）与覆盖率门槛 |
| 依赖锁定 | 提交 `package-lock.json`（含 integrity），CI 用 `npm ci` |
| 发布 | `files` 白名单 + 发布前检查（本机绝对路径、疑似密钥、占位符、误跟踪产物） |

## 两条事故教训（都已变成防护）

1. 对「指向仓库的目录联接」执行递归删除，会顺着链接删进目标仓库。已新增 `scripts/safe-remove.mjs`：递归删除前扫描整棵树，发现重解析点即拒绝，并配了回归测试。
2. 宿主在 profile 判为不可用时静默 sanitize（备份 patch、重写 bundles），工具会凭空消失且无报错。已新增**加载信标** `<repo>/.projectops/last-load.json`（版本/时间/工具数/pid），用于区分「没加载」与「加载了但工具不可见」。

## 当前验证状态

- 116 个测试全绿；其中 103 个不依赖宿主环境（CI 跑这一批）。
- `tsc --noEmit` 0 error；lint 通过；语句覆盖率 82.48%。
- 自分析本仓库 `src/`：36 模块 / 105 边 / 0 循环 / 0 unresolved。

## 已知边界

- 依赖分析是词法级：动态导入、拼接出来的模块名识别不到；混合仓库一次只分析一种语言（返回 `mixedProject` 标记）。
- Python 的函数内/条件导入标为 `nested`（图上虚线），但不追踪运行时是否真的执行。
- 客户端 UI 卡片只有数据协议层，渲染需要宿主客户端运行时。
- 报告正文为中文模板，i18n 只覆盖模型可见的工具面（zh/en）。
