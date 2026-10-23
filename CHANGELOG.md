# 更新日志

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Planned
- 任务依赖调度（`dependsOn` 未完成时拒绝推进）与失败重试策略
- 报告模板自定义

## [0.6.0]

### Added
- **版本对账**：`plugin_info` 增加 `loadedFrom`（加载的模块 URL）与 `staleBuild`（磁盘构建是否比本次挂载更新），并在渲染中给出"宿主可能仍在跑旧代码"的显式警告。
- **工具调用埋点**：`src/tools/instrument.ts` 给 10 个工具统一包一层计时日志（工具名 / 耗时 / 成功失败 / 错误码 / 计数类字段），严格不记录参数值、文件内容与输出正文；`plugin_logs` 因此不再为空。
- **Python 导入作用域**：`RawImport.scope` 与 `DependencyEdge.scope`（`module` / `nested`）——函数/类/条件/异常处理体内的导入标为 `nested`，Mermaid 用虚线表示，报告里单独作为启发式观察提示"运行时不一定执行"；JS 侧 `require`/`import()` 同样记为 `nested`。

### Fixed
- **`locale: auto` 在宿主里退化成英文**：桌面进程没有 LANG/LC_ALL，只看环境变量会把中文系统的工具说明变成英文。现在按「配置 → 环境变量 → Intl 系统区域 → 英文」判定。

### Changed
- 默认 `logLevel` 从 `warn` 调到 `info`：环形缓冲默认就能看到 apply 与每次工具调用（stderr 仍由 `logToConsole` 单独控制）；`plugin_logs` 空缓冲时给出可解释提示。

## [0.5.0]

### Added
- **package-lock.json（真锁）**：把 npm 自身的 tarball 下载解包并用 DSH 的 Electron Node 运行（`npm 10.9.2`），
  生成 lockfileVersion 3、带 `resolved` 与 `sha512` integrity 的 lockfile，并用 `npm ci` 反向验证（重装 3 包，tsc 0 error / 105 测试通过）。
  CI 从 `npm install` 切换到 **`npm ci` + npm 缓存**，可复现性闭环。
- 客户端模块补齐与真实客户端插件一致的导出形状（`apply` + `inject = ['slots', 'locale']` + `platform = 'web'`）。

### Known gaps（附已核实的环境事实）
- **GUI React 卡片仍未实现**：desktop profile 的 node_modules 中没有 `@deepseek-ai/dsh-client-runtime`，
  也没有任何客户端类型声明；已安装的客户端插件（dsh-at-file 等）是宿主注入 runtime 的 CJS bundle，
  通过 `ctx.slots.register` / `ctx.locale.register` 扩展 UI。缺少 runtime 包时写出来的卡片既无法类型检查也无法渲染验证，
  因此本仓库只交付**卡片描述协议**（10 个工具全覆盖、字段来源与 attention 标记均已测试）。
  补齐路径：拿到 dsh-client-runtime 的类型 → 用 `ctx.slots.register` 注册 tool-card 槽位 → 在装机环境截图验证。

## [0.4.0]

### Added
- **本地类型门禁**：`scripts/bootstrap-tooling.mjs` 在没有 npm/npx 的机器上直接下载并解包 typescript / @types/node / undici-types（fetch + gunzip + 手写 ustar 解析），随后 `npm run typecheck` 可本地运行，当前 **0 error**；`verify` 升级为 7 个环节。
- **宿主环境声明**：`types/dsh-ambient.d.ts` 按宿主源码核实过的签名，为 `@deepseek-ai/dsh-tools` / `cordis` / `schemastery` 提供最小模块声明（DSH 发布产物不含 .d.ts）。宿主边界保持 `any`，业务层保持 strict。
- **i18n（zh / en）**：`locale/zh.json` + `locale/en.json` 覆盖 10 个工具的描述与全部参数说明；`locale: auto|zh|en` 配置；测试强制两套目录键集合一致 + 工具/参数无漏译。
- **客户端卡片视图层**：`src/client/index.ts`（`platform: 'web'`，`createToolViews()` 返回 10 个工具的卡片描述协议），`package.json` 增加 `dsh.client` 与 `exports["./client"]`；`tests/client.views.test.ts` 校验覆盖与字段来源。
- `verify` 输出增加 typecheck 环节。

### Fixed
- **参数文案未真正生效**：`localizeTool` 之前遍历的是 `defineTool` 编译后的 `parameters`（键为 `type`/`properties`），只改了 schema 的两个键、参数说明根本没翻译。改为按 `parameters.properties` 的属性名覆盖 `description`，并由文案完整性测试兜住。

- 客户端卡片只到"描述协议"层，React 组件与视觉验证需要在装好 DSH 客户端的机器上完成。
- 报告正文仍是中文模板（i18n 只覆盖模型可见的工具面）。

## [0.3.0]

### Added
- **plugin_info / plugin_logs**：插件自证版本（源码常量 + 构建产物 mtime + 生效配置 + 已注册工具），以及最近 200 条脱敏日志的查询接口。版本常量与 package.json 的一致性由测试强制。
- **任务依赖调度**：`dependsOn` 里任一前置未完成时，拒绝推进到 `in_progress`/`completed`（`TASK_DEPENDENCY_UNMET`）；创建时校验依赖 id 存在；`task_get` 返回依赖状态。
- **事务与并发**：状态变更 + 执行记录在同一 SQLite 事务内提交（失败整体回滚）；`PRAGMA busy_timeout=5000`；`PRAGMA user_version` 作为迁移入口。
- **tsconfig 别名解析**：读取 `compilerOptions.paths`/`baseUrl`（容错 JSONC），别名命中但文件缺失记为 `unresolved`，不再误判为外部依赖。
- **报告只给事实**：删除按目录名猜职责的硬编码表，改为「文件数 / 体积 / 被内部依赖次数」；模块表增加被依赖次数。
- **报告接入任务数据**：`generate_architecture_report` 可把任务队列写进报告，并可用 `createTasksForFindings` 把「已确认的问题」自动落成任务（按标题去重）。
- **CI 工具层契约测试**：新增 `tests/support/mock-dsh-tools.mjs`（与真实包同形的 `defineTool` + 受支持 schema 子集校验），无 DSH 环境也能测工具层；`test:ci` 覆盖 92 个用例。
- **CI 类型门禁**：新增 `typecheck` job（`tsc --noEmit -p tsconfig.json`，只检查 `src/`）。
- **工程脚本**：`scripts/verify.mjs`（一键自检）、`scripts/check-metadata.mjs`（发布元数据自检）、`scripts/showcase.mjs`（用真实调用生成效果图页面）。
- 覆盖率基线：语句 82.48% / 函数 75.00%（`npm run test:coverage`，无 DSH 子集）。

### Fixed
- `doc-writer` 写入失败可能残留 `.tmp`：失败路径现在会清理临时文件。
- 任务创建的依赖校验缺失（可写入不存在的依赖 id）。

### Known gaps（下一轮）
- Python 的「函数内 / 条件导入」尚未区分，仍按模块级依赖计入。
- 未提供 locale 目录（en/zh）与 i18n；错误信息为中文硬编码。
- 未提供 GUI 卡片（需要编写 DSH client bundle，工作量最大）。
- 无 lockfile（本机无 npm 可运行环境，未生成）。

## [0.2.0]

### Added
- **依赖分析支持 TypeScript / JavaScript**：静态 import、`import type`、副作用 import、`export ... from`、
  动态 `import()`、CommonJS `require()`；相对导入按扩展名候选表解析，支持目录 `index.*` 与 TS ESM 的 `.js` 后缀写法。
- `analyze_dependencies` 新增 `language` 参数（`auto`/`python`/`javascript`），输出新增
  `language`、`detected{python,javascript}`、`mixedProject` —— 混合仓库明确告知"只分析了一种语言"。
- `src/services/source-files.ts`：两种语言共用的源码收集器（排除规则、不跟随符号链接、文件数上限）。
- `scripts/verify.mjs`：一键自检（构建 → 全量测试 → CI 子集 → 三个 demo），本地预提交与 CI 都能用。
- `docs/usage.md`（八个工具的真实调用样例）与 `docs/troubleshooting.md`（安装/运行时/语法/Windows 联接等排错）。

### Fixed
- TS ESM 写法 `import './util.js'` 无法解析到 `util.ts`（曾导致本仓库自分析出现 109 条 unresolved、0 条边）。
- 目录导入 `import './components'` 未解析到 `components/index.ts`。
- Mermaid 图注释写死 "Python"，多语言下会误导；改为按 `report.language` 输出。
- 依赖解析器里一处 if/else 两支完全相同的冗余分支。

## 此前版本


## [0.1.0]

### Added
- **插件骨架**：cordis 插件契约（`name` / `inject` / `Config` / `apply`），通过 `ctx.tools.register` 注册工具。
- **scan_project**：项目结构扫描（目录树、文件类型统计、语言/入口/配置/包管理器启发式识别）、
  授权工作区校验、敏感文件排除、隐藏项与自定义排除、目录汇总、带 mtime+TTL 失效的扫描缓存。
- **analyze_dependencies**：Python import 静态解析（绝对/相对/括号跨行/注释与三引号块排除）、
  模块名映射、依赖边、Tarjan 强连通分量找循环依赖、外部依赖与不可解析导入分类、Mermaid 架构图。
- **任务管理**：`task_create` / `task_list` / `task_get` / `task_update`，
  基于 `node:sqlite`（零原生依赖），任务表 + 执行记录表，状态机与失败原因脱敏。
- **文档生成**：`generate_architecture_report`（概览/结构/模块职责/依赖/Mermaid/确认问题/启发式观察/建议）、
  `generate_readme_draft`；默认 dry-run、默认不覆盖已有文件、临时文件 + rename 原子写入。
- **工程设施**：结构化日志（密钥脱敏）、统一 `ProjectOpsError` 错误码、`WorkspaceGuard` 边界检查、
  Node 内建类型擦除构建、75 个测试（单元 + 宿主组合 + 真实 Loader 加载路径）、示例 Python 项目、安装/回滚脚本。
- **开源配套**：MIT License、CONTRIBUTING、CODE_OF_CONDUCT、SECURITY、CHANGELOG、CI 工作流、issue/PR 模板。
