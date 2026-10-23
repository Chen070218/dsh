# 开发记录

## 0. 环境核查（第一阶段前置）

| 项目 | 结论 | 证据 |
| --- | --- | --- |
| DSH 版本 | 桌面运行时 `@deepseek-ai/dsh-desktop-runtime` **0.2.1-rc.2**；桌面壳 `@deepseek-ai/dsh-desktop` 0.2.1-rc.2 | `resources/app.asar/dsh/package.json`、`resources/app.asar/package.json` |
| 插件框架 | cordis（`@deepseek-ai/cordis` 4.0.5）+ `cordis-plugin-loader` | 同上 dependencies；profile 的 `cordis.yml` |
| 插件形态 | npm 包 + ESM 入口，导出 `name` / `inject` / `Config`（schemastery）/ `apply(ctx, config)` | `dsh-browser`、`dsh-at-file` 的 `lib/index.js`、`package.json`、`dsh.plugin.json` |
| 工具注册 | `ctx.tools.register(defineTool({ name, description, parameters, output, execute }))`，`defineTool` 来自 `@deepseek-ai/dsh-tools` | `dsh-tools/lib/index.js`（`function defineTool`）与 `dsh-tools/README.md` |
| 参数 DSL | `string/number/integer/boolean/null/array/object/json/oneOf`；object 必须显式 `additionalProperties`；标量支持 `enum/const` | `dsh-tools` 的 `runSchemaCompiler` |
| 输出 schema | 受支持的 JSON Schema 子集（`type/oneOf/properties/required/additionalProperties/items/enum/const` + 注解） | `assertSupportedJsonSchema` |
| 安装方式 | profile（`~/.dsh/profiles/<name>`）的 `package.json` 依赖 + `dsh.profile.bundles` + `cordis.patch.yml` | `dsh-plugin-manager` README、profile 现有内容 |
| 运行时依赖解析 | 插件里写 bare specifier `@deepseek-ai/...`，宿主用拦截式解析把它指向运行时包（profile 里并没有 dsh-tools 的拷贝） | `dsh-app-boot` 的 `internalModules()` / interception 路由；实测：`dsh-browser` 的 bare import 在纯 node 下解析失败，但在宿主里正常工作 |
| 本机工具链 | 无独立 node/npm/tsc/esbuild/vitest；Node 24.21.0 通过 `DeepSeek Harness.exe` + `ELECTRON_RUN_AS_NODE=1` 提供；`node:module` 有 `stripTypeScriptTypes` 与 `registerHooks` | 实测命令输出 |

关键决策：**不引入 tsc/esbuild**，用 Node 自带类型擦除构建；**测试用 node:test**，并用 `registerHooks` 把 `@deepseek-ai/*` 指向本机 DSH 运行时，这样集成测试跑的是宿主真正的 cordis/dsh-tools。

## 1. 第一阶段：插件骨架 + scan_project

### 创建的文件

- 清单与配置：`package.json`、`dsh.plugin.json`、`cordis.patch.yml`、`tsconfig.json`、`.gitignore`
- 源码（11 个模块）：`src/index.ts`、`src/types.ts`、`src/tools/scan-project.ts`、`src/services/{project-scanner,language-detect}.ts`、`src/adapters/fs-adapter.ts`、`src/security/{workspace-guard,excludes}.ts`、`src/util/{errors,logger,text}.ts`
- 测试：`tests/{security.workspace-guard,security.excludes,services.language-detect,services.project-scanner,tools.scan-project,util.logger,integration.host-composition}.test.ts` + `tests/support/*`
- 脚本：`scripts/{build.mjs,demo-scan.mjs,install-into-profile.mjs}`
- 文档：`README.md`、`docs/architecture.md`、本文件

### 执行过的命令与结果

```text
# 构建（Node 类型擦除，src/*.ts -> lib/*.js）
"DeepSeek Harness.exe" scripts/build.mjs            -> build: 11 个模块 -> lib/

# 测试（node:test，含宿主组合集成测试）
"DeepSeek Harness.exe" --test --import ./tests/support/runtime-hooks.mjs "tests/**/*.test.ts"
  -> tests 29 / pass 29 / fail 0 / skipped 0（~0.72s）

# 冒烟（扫描本仓库）
"DeepSeek Harness.exe" scripts/demo-scan.mjs
  -> TypeScript 主导，40 files / 15 dirs / 114.9 KB，9 ms

# 安装 dry-run（只打印计划，未写入任何文件）
"DeepSeek Harness.exe" scripts/install-into-profile.mjs
  -> 计划：登记依赖、加入 bundles、追加 cordis patch、建 node_modules 联接
```

> 说明：本机 PATH 里没有 `node`，所以上面的命令都用 `DeepSeek Harness.exe` 加 `ELECTRON_RUN_AS_NODE=1` 执行；在有 Node ≥ 22.18 的机器上等价于 `npm run build && npm test`。

### 过程中发现并修复的真实问题

1. **构建脚本被自己的注释打断**：注释里写了 `src/**/*.ts`，其中 `**/` 提前结束了块注释，Node 报 `SyntaxError: Unexpected token '*'`。改为文字描述，并加了一个扫描所有源码块注释的小检查。
2. **测试里 `./support/temp-project.js` 找不到模块**：Node 的类型擦除不做 `.js → .ts` 重写，测试之间的导入必须写 `.ts` 后缀（`lib` 产物仍是 `.js`，两者不冲突）。
3. **越界误报成 `NOT_FOUND`**：原实现先判断存在性再判断边界，`src/../../outside.txt` 之类会退化成“不存在”。改成**先词法越界、再 realpath 越界、最后存在性/类型**，安全错误码优先。
4. **未映射的原始 Error 泄漏到告警**：注入“读目录直接抛 EACCES”的替身时，扫描器只看到 `Error: denied`。现在扫描器在 catch 里也走 `mapFsError`，告警稳定出现 `PERMISSION_DENIED`。
5. **输出 schema 细节**：`dsh-tools` 的受支持子集要求 object 显式 `additionalProperties`、`required` 只能写在属性节点上，第一版按此重写并在测试里用 `assertSupportedJsonSchema` 兜住。

### 已验证 vs 待授权验证

- 已验证：真实 `@deepseek-ai/cordis` + 真实 `@deepseek-ai/dsh-tools` 的组合——插件 `apply` 注册了工具、工具出现在 `ctx.tools.schemas()`、通过 `ToolRuntime.execute` 的完整管线（参数校验 → 执行 → 输出校验 → 渲染）返回正确结果，越界路径与非法参数都变成明确的错误结果。
- 待授权验证：`install-into-profile.mjs --apply` 写入 `~/.dsh/profiles/desktop` 并**重启 DSH**，确认新会话里出现 `scan_project`。这一步改的是工作区之外的用户配置，按安全约定必须由用户确认后再执行。

## 已知限制

- 识别是文件名/扩展名启发式，不做语义分析。
- 递归扫描单线程；超大仓库依赖 `maxDepth`/`maxEntries`。
- 没有类型检查（无 tsc）；源码必须保持“可擦除语法”（禁止 enum/namespace/构造函数参数属性）。
- 日志默认静默（插件运行在宿主进程里）；需要排查时把 `logToConsole` 打开。

## 下一阶段计划（第二阶段）

1. 增强 `project-scanner`：更细的排除规则（可配置）、`includeHidden`、`maxFileBytes` 保护、按目录聚合大小。
2. 扫描结果缓存与增量：同一会话内重复扫描不再重复遍历（内存缓存 + mtime 失效）。
3. 补测试：真实大目录下的性能基线、Windows 保留名/超长路径、并发扫描幂等。
4. 收尾第一阶段的安装验证：用户授权后执行 `--apply` + 重启，确认工具在真实会话中可用。

## 2. 第二阶段：扫描器加固 + 扫描缓存

### 新增/修改

- `src/services/scan-cache.ts`（新）：按 `root + limits + filters` 指纹缓存；根目录 mtime 变化或超过 TTL 即失效；`cached` 标记回传给工具输出。
- `src/services/project-scanner.ts`：新增 `includeHidden`、`extraExcludes`、`skippedHidden` 统计与 `directorySummary`（顶层目录聚合）。
- `src/tools/scan-project.ts`：新增 `includeHidden` 参数与 `cached` 输出；渲染里展示目录分布、隐藏项与缓存命中。
- `src/index.ts`：配置增加 `includeHidden / extraExcludes / cacheTtlMs`，`apply` 里创建缓存并在卸载时清理。

### 测试

```text
tests/services.scan-cache.test.ts     4 例（命中、TTL 过期、mtime 失效、参数不同不共用）
tests/services.project-scanner.test.ts + 3 例（隐藏项、extraExcludes、directorySummary）
tests/tools.scan-project.test.ts      + 2 例（缓存命中、includeHidden/extraExcludes）
```

## 3. 第三阶段：Python 依赖分析 + Mermaid

### 新增

- `src/services/python-imports.ts`：词法级 import 解析（`import a.b`、`from x import (a, b as c)`、相对导入层级、括号跨行、注释/三引号块内假 import 排除）。
- `src/services/dependency-analyzer.ts`：收集 `*.py` → 模块名映射 → 相对/绝对解析 → 依赖边 → Tarjan 强连通分量（迭代实现，避免深递归）→ 外部/不可解析分类。
- `src/services/mermaid-renderer.ts`：`graph TD` + 循环节点高亮（`classDef cycle`）+ 边数上限。
- `src/adapters/source-reader.ts`：读源码端口（`maxBytes` 截断，测试可注入替身）。
- `src/tools/analyze-dependencies.ts`：`analyze_dependencies` 工具（参数/输出 schema/渲染）。
- `examples/sample-python-app/`：带真实循环依赖的示例项目；`scripts/demo-analyze.mjs` 冒烟。

### 实测输出（`scripts/demo-analyze.mjs`）

```text
modules  : 5 | edges: 5 | cycles: 1
cycles   : ! app.models <-> app.repository <-> app.service
external : json(1), os(1)
graph TD
  m0["app.models"] --> m2["app.service"]
  m2["app.service"] --> m1["app.repository"]
  classDef cycle fill:#ffe2e2,stroke:#d64545,stroke-width:2px;
  class m0,m1,m2 cycle
```

### 测试

```text
tests/services.python-imports.test.ts        5 例
tests/services.dependency-analyzer.test.ts   5 例（含读文件失败降级、文件数上限）
tests/tools.analyze-dependencies.test.ts     4 例（含越界拒绝）
```

## 4. 事故与修复记录（重要）

1. **`.git` 被部分删除**：加载路径测试第一次清理临时目录时，对"包含指向本仓库的目录联接"的目录做了 `rmSync(recursive)`，Windows 顺着联接删到了仓库里，撞到 EPERM 才中断（`src/tests` 未受损，`.git` 顶层文件丢失）。修复：
   - 测试清理改为**只对链接本身做非递归 rmdir**，且 `lstat` 确认是链接、路径在 `tmpdir()` 下，否则**放弃清理**（宁可留临时目录）；
   - 重建仓库历史（当时只有一次初始提交，无内容损失）；
   - 新增 `.gitattributes` 统一行尾。
   教训：任何 `recursive` 删除前，必须先确认树里没有指向工作区的重解析点。
2. **cordis 对象插件的 `apply` 必须用方法简写**：`{ name, apply: (ctx) => ... }` 形式的箭头函数不会被识别，插件静默不挂载；测试里已统一改为 `apply(ctx) { ... }`。
3. **测试导入必须写 `.ts` 后缀**：Node 类型擦除不做 `.js -> .ts` 重写；`lib` 产物仍是 `.js`。
4. **注释里别写 glob**：块注释中出现 `**/` 会提前闭合注释（构建脚本踩过）。

## 5. 验证状态

| 验证 | 结果 |
| --- | --- |
| 单元测试（扫描/缓存/守卫/日志/语言识别/import 解析/依赖图） | ✅ |
| 宿主组合（真实 cordis + dsh-tools 的注册、执行、schema、错误路径、卸载） | ✅ |
| 加载路径（真实 `cordis-plugin-loader` 按包名从 profile 形态目录挂载，两个工具都注册） | ✅ |
| 全量测试 | ✅ 55/55 |
| 写入真实 profile 并重启 DSH 验证 | ⏳ 未执行（需要用户授权改 `~/.dsh/profiles/desktop` 并重启；脚本已就绪，默认 dry-run） |

## 6. 下一步

- 阶段 4：SQLite 任务管理（`node:sqlite`），任务表 + 执行记录表，工具 `task_create / task_list / task_update / task_get`，预留依赖与重试字段。
- 阶段 5：报告生成（先 dry-run 展示计划再落盘）、README/架构文档初稿生成、端到端测试。
- 收尾：用户授权后完成真实 profile 安装验证。

## 7. 第四阶段：SQLite 任务管理

### 新增

- `src/storage/task-store.ts`：任务/执行记录的领域模型与 `TaskStore` 接口（预留 `dependsOn`、`attempts`、`lastError`）。
- `src/storage/sqlite-task-store.ts`：`node:sqlite` 实现（`tasks` + `task_executions` 两张表，参数绑定，写入前脱敏）。
- `src/services/task-service.ts`：按工作区懒加载并缓存 TaskStore，卸载时统一关闭。
- `src/tools/task-tools.ts`：`task_create / task_list / task_get / task_update` 四个工具。
- `src/index.ts`：装配任务服务与四个工具，配置增加 `tasksDirectory`（默认 `.projectops`）。

### 关键决策

- 用 `node:sqlite`（Node 22.5+ 内置）而不是 better-sqlite3：**零原生依赖**，在 DSH 桌面运行时里可直接跑（实测 `DatabaseSync` 可用）。
- 数据库路径固定在工作区内（`<root>/.projectops/tasks.db`），已在 `.gitignore` 中忽略；工具不提供任意路径参数，避免多开一个越权写入面。
- 状态变更即写一条执行记录；失败原因落库前脱敏（`token=xxx` 之类）。

### 测试

```text
tests/storage.sqlite-task-store.test.ts  4 例（CRUD/计数/执行记录/非法输入/脱敏）
tests/tools.task-tools.test.ts           5 例（四工具 schema、完整状态流转、落盘位置、NOT_FOUND、工作区跟随）
tests/integration.loader-mount.test.ts   追加断言：六个工具在真实 Loader 挂载后都可见
全量：64/64 通过
```

## 8. 第五阶段：架构文档生成 + 开源化

### 新增

- `src/services/report-generator.ts`：8 节 Markdown 架构报告（概览/结构/模块职责/依赖+Mermaid/已确认问题/启发式观察/建议/附录）+ README 初稿生成器。
- `src/adapters/doc-writer.ts`：文档落盘策略 —— 路径过 `WorkspaceGuard`、默认 dry-run、已存在文件默认拒写、临时文件 + rename 原子写入。
- `src/tools/doc-tools.ts`：`generate_architecture_report` / `generate_readme_draft`（默认 `dryRun=true`、`overwrite=false`）。
- `scripts/demo-report.mjs`：对示例项目生成 `examples/sample-python-app/docs/architecture.md`（真实产物已提交）。

### 真实调用中发现并修掉的质量问题

宿主内第一次跑 `generate_architecture_report` 时，示例项目只有两个外部依赖（各被 1 个文件引用），却被判成「集中度较高」——
原因是只用了 30% 比例阈值。已改为 `files >= 3 且比例 >= 30%`，并补了回归测试（76/76 通过）。

### 实测（`npm run demo:report`）

```text
written: examples/sample-python-app/docs/architecture.md (3190 bytes)
sections: 项目概览 / 目录结构 / 模块与职责 / 依赖关系 / 已确认的问题 / 启发式观察 / 改进建议 / 附录
confirmed findings: 1（循环依赖 app.models <-> app.repository <-> app.service）
heuristic findings: 4
```

### 开源化配套

| 文件 | 作用 |
| --- | --- |
| `LICENSE` | MIT |
| `CONTRIBUTING.md` | 本地开发、目录约定、提交规范、新增工具的最小步骤、安全红线、发布流程 |
| `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1 |
| `SECURITY.md` | 漏洞上报渠道 + 六条安全承诺 + 已知边界 |
| `CHANGELOG.md` | Keep a Changelog + SemVer，0.1.0 全量记录 |
| `.github/workflows/ci.yml` | Ubuntu/Windows × Node 22/24：build + `test:ci` + 两个 demo |
| `.github/ISSUE_TEMPLATE/*`、`pull_request_template.md` | issue/PR 模板 |
| `.editorconfig`、`.gitattributes` | 行尾与缩进统一 |
| `README.en.md` | 英文说明（CI/License 徽章） |

`package.json` 补齐 `repository` / `homepage` / `bugs` / `author` / `publishConfig` / `engines` / `files`，
并移除不存在的 `types` 字段（当前不发 d.ts），发布内容限定为 `lib/` + 清单 + 文档。

### CI 与「不依赖 DSH」的测试子集

完整 75 个测试里有 27 个需要真实 DSH 运行时（`@deepseek-ai/cordis` / `dsh-tools` / 真实 Loader）。
GitHub Actions 上没有 DSH 安装，因此新增 `npm run test:ci`：只跑纯服务/安全/存储/适配层测试（48 个），
实测 `test:ci` 48/48 通过；需要宿主的部分在本地 `npm test` 覆盖，并在 README 中写明。

## 9. 整体验证状态

| 验证 | 结果 |
| --- | --- |
| 构建（Node 类型擦除，24 个模块） | ✅ |
| 全量测试 | ✅ 75/75 |
| CI 子集（无 DSH） | ✅ 48/48 |
| 真实 Loader 挂载（8 个工具全部可见） | ✅ |
| demo：扫描 / 依赖分析 / 报告生成 | ✅ 三个都可运行，产物已提交 |
| 写入用户 profile | ✅ 已执行 `--apply`，profile 备份在 `.projectops-backup-*`，`rollback-profile.cmd` 可一键回滚 |
| **宿主内真实加载与调用** | ✅ 宿主热加载后 8 个工具全部出现在工具清单；实测 scan_project（40 文件/20 目录，命中缓存字段正常）、analyze_dependencies（5 模块/5 边/1 循环 + Mermaid）、generate_architecture_report（dry-run 生效、对已存在文件拒绝覆盖、8 节 + 1 条确认 + 3 条启发式）、task_create/task_update/task_get/task_list（SQLite 落盘、attempts=1、2 条执行记录） |

## 10. 第六轮：多语言依赖分析 + 工程化收尾

### 做了什么

- 新增 `services/js-imports.ts`（静态/副作用/export-from/动态 import/require）、
  `services/js-dependency-analyzer.ts`、`services/source-files.ts`（两语言共用收集器）、
  `services/dependency-service.ts`（语言路由）。
- `analyze_dependencies` 增加 `language` 参数与 `language/detected/mixedProject` 输出。
- 新增 `scripts/verify.mjs`、`docs/usage.md`、`docs/troubleshooting.md`；版本升到 0.2.0。

### 实测（插件分析自身 src/，TypeScript）

```text
language: javascript  detected: {python: 0, javascript: 28}  mixed: false
modules: 28  edges: 88  cycles: 0  unresolved: 0
external: node:fs(10), node:path(8), @deepseek-ai/dsh-tools(4), node:sqlite(1)
```

顺带得到一个对自己架构的健康检查结论：**src/ 内部没有循环依赖**。

### 这轮真实修掉的四个 bug

1. **TS ESM 的 `.js` 后缀**：`import './util.js'` 实际指向 `util.ts`，首版没剥后缀 → 自分析出现 109 条 unresolved、0 条边；修完后 88 条边、0 条 unresolved。
2. **目录入口导入**：`import './components'` 未解析到 `components/index.ts`（解析索引里没注册目录别名）。
3. **Mermaid 注释写死 "Python"**：多语言下会误导。
4. **解析器冗余分支**：Python 解析里 if/else 两支完全相同。

### 验证

```text
node scripts/verify.mjs
PASS build / test(full 88) / test(ci 61) / demo:scan / demo:analyze / demo:report
```

### 未完成 / 已知

- 宿主进程里仍是上一版代码（HMR 未重载新构建），新语言能力需重启 DSH 后才会体现在工具调用里；本地构建产物与 88 个测试已覆盖。
- 任务依赖调度（`dependsOn` 只存字段）与失败重试策略仍未实现，列在 CHANGELOG 的 Unreleased。

## 11. 第七轮：把 P0/P1/P2 清单逐项落地

| 项 | 状态 | 证据 |
| --- | --- | --- |
| P0-1 版本自证 | ✅ | `plugin_info` / `plugin_logs`；`PLUGIN_VERSION` 与 package.json 一致性测试 |
| P0-2 类型门禁 | ⚠️ 部分 | 本机无 node/npx，`tsc` 只能进 CI（已加 `typecheck` job）；本地可跑的门禁是「可擦除语法」构建 |
| P0-3 任务调度 | ✅ | 依赖阻塞 `TASK_DEPENDENCY_UNMET`、事务提交、`busy_timeout`、`user_version` 迁移入口；3 个存储测试 + 1 个工具测试 |
| P1-4 别名解析 | ⚠️ 部分 | `tsconfig` paths/baseUrl 已支持（含 JSONC 容错）；barrel re-export 天然作为边计入；Python 函数内/条件导入未区分 |
| P1-5 报告事实化 | ✅ | 删除 `guessResponsibility`，改为文件数/体积/被依赖次数 |
| P1-6 任务进报告 | ✅ | `includeTasks` 与 `createTasksForFindings`（按标题去重） |
| P2-7 契约测试 | ✅ | `mock-dsh-tools.mjs`；无 DSH 时工具层 26 个用例全绿，`test:ci` 共 92 个 |
| P2-8 覆盖率 | ✅ | 82.48% 语句 / 75% 函数（lockfile 仍缺，本机无 npm） |
| P2-9 展示页脚本 | ✅ | `scripts/showcase.mjs` 用真实调用生成 `docs/images/preview.html` |
| P2-10 发布细节 | ⚠️ 部分 | 元数据自检脚本 + tag v0.3.0；i18n 与 client bundle 未做 |
| P2-11 安全空档 | ⚠️ 部分 | `.tmp` 清理 ✅、`plugin_logs` ✅；OS 级沙箱不实现（边界仍是 WorkspaceGuard） |

**验证**：`npm test` 99/99；`test:ci` 92/92；`verify` 6/6；覆盖率 82.48%。

**为什么有三项留在 ⚠️**：本机没有 node/npm（只能借 DSH 的 Electron Node），tsc 与 lockfile 无法在本地执行验证；i18n 需要把 10 个工具的文案全部抽出并维护 en/zh 两份，属于独立的文案工程；client bundle 需要 DSH 客户端运行时类型，环境里没有，硬写无法验证。这三项都写进了 CHANGELOG 的 Known gaps。

## 12. 第八轮：把三个"环境受限"的项真正做完

| 项 | 结果 | 关键做法 |
| --- | --- | --- |
| 本地 tsc 门禁 | ✅ **0 error** | 没有 npm：用 fetch + gunzip + 手写 ustar 解析把 typescript/@types/node 解包进 node_modules；宿主包没有 .d.ts，补 `types/dsh-ambient.d.ts` 环境声明 |
| lockfile | ⚠️ 仍无（有意） | 无 npm 无法生成可信 lockfile；手工拼的 lockfile 会让 CI 的 npm ci 直接失败，风险高于收益。写进 Known gaps 并给出触发条件 |
| i18n | ✅ zh/en 54 键 | locale JSON 为唯一真源；配置 locale=auto/zh/en；测试强制键集合一致 + 10 工具/全部参数无漏译 |
| GUI 卡片 | ⚠️ 数据层 ✅ / 渲染未验证 | `src/client/index.ts` 输出卡片描述协议（10 工具、字段来源、attention 标记），React 组件需 DSH 客户端运行时 |

### 这一轮抓到的真 bug
**参数文案没生效**：`localizeTool` 遍历的是 `defineTool` 编译后的 `parameters`（键是 `type`/`properties`），
所以只改了 schema 的两个键，参数说明仍是原文。是"文案完整性测试"把它逼出来的——测试比人更靠得住。
修正后按 `parameters.properties` 的属性名覆盖 `description`。

### 命令与结果
```text
node scripts/bootstrap-tooling.mjs   -> typescript 121 files / @types/node 67 files / undici-types 41 files
node scripts/verify.mjs              -> 7/7 PASS（build / typecheck / test-full 105 / test-ci 92 / 3 demos）
tsc --noEmit -p tsconfig.json        -> 0 error
```

## 13. 第九轮：lockfile 真锁 + 客户端卡片的边界确认

### lockfile：不靠环境也能做

没有 npm？**npm 本身就是纯 JS 包**。做法：下载 `npm-10.9.2.tgz` → 用自写 ustar 解析解包 → 用 DSH 的 Electron Node 运行 `npm-cli.js`。
第一版 lockfile 缺 `resolved`/`integrity`（npm 看到本地已有包就不去 registry 取元数据），于是删掉本地包重生成，再 `npm ci` 反向验证。

```text
lockfileVersion: 3 | packages: 4 | typescript 5.6.3 + sha512 integrity
npm ci -> added 3 packages in 744ms
tsc --noEmit -> 0 error | tests -> 105/105
```

CI 同步改为 `npm ci --ignore-scripts` + `cache: npm`。

### 客户端卡片：确认了"为什么现在做不了"

核实到的事实（不是猜测）：
- 已安装客户端插件（dsh-at-file）导出 `apply` + `inject`，是 **宿主注入 runtime 的 CJS bundle**；
- 扩展 UI 的真实入口是 `ctx.slots.register(...)` 与 `ctx.locale.register(...)`；
- desktop profile 的 node_modules 里**没有** `@deepseek-ai/dsh-client-runtime`，也没有任何客户端 .d.ts。

结论：没有 runtime 包与类型，写"能渲染的 React 卡片"只能靠猜 API，既过不了 tsc 也无法截图验证。
所以本轮只补齐了与真实插件一致的导出形状（`apply` / `inject = ['slots','locale']` / `platform='web'`），
卡片描述协议保持已被 10 个工具覆盖测试保护的状态，并在 CHANGELOG 写清补齐路径。

## 14. 第十轮：P1 + P2 收尾

| 项 | 结果 |
| --- | --- |
| P1-4 monorepo 跨包 | ✅ `services/workspace-packages.ts` + 解析器接入；测试抓到"入口带 .ts 导致匹配失败"的真 bug |
| P1-5 重试策略 | ✅ `taskMaxAttempts`（默认 3）+ `TASK_RETRY_EXHAUSTED` + `[已达重试上限]` 标记 |
| P1-5 并发 | ✅ 两个连接交替写 20 次不报 SQLITE_BUSY，计数一致 |
| P1-6 建议模板化 | ✅ 事实驱动规则；测试断言"无循环不出现拆循环建议、有 pyproject 不要求补清单" |
| P2 lint | ✅ 离线原生 lint（可擦除语法 / console / any / tab / 行尾空白），被它抓出 instrument.ts 的 2 处 any |
| P2 覆盖率门槛 | ✅ `check:coverage`，当前 82.48% ≥ 80% |
| P2 跨平台安装 | ✅ junction / symlink 按平台 + profile 自动探测 |
| 仓库占位符 | ⏳ 仍需你的 GitHub 地址（`check-metadata` 持续提醒） |
| 客户端 React 卡片 | ⏳ 阻塞于 `dsh-client-runtime` 包/类型缺失 |

验证：`verify` 7/7 · 112 测试全绿 · tsc 0 error · lint OK · 覆盖率 82.48%

## 15. 事故复现与硬防护（第二次）

**现象**：宿主重启后插件工具消失；profile 里的 `dsh.profile.bundles` 与 `cordis.patch.yml` 中的插件条目被移除，
并出现 `cordis.patch.yml.bak-1792748794105`——说明 DSH 启动了 profile sanitize（把 patch 备份、重写 bundles）。
同时把 `dsh.client`（v0.4.0 加的 web 客户端声明）判为可疑：宿主会按它去加载客户端 bundle，而客户端入口并没有真正实现。

**修复顺序**：
1. 去掉 `package.json` 的 `dsh.client` 声明（客户端协议层仍以 `exports["./client"]` 保留，但不再让宿主去加载）；
2. 尝试用 profile 自带 pnpm 真正安装 → `ERR_PNPM_UNEXPECTED_STORE`（profile 的 node_modules 由另一个 pnpm 大版本装的），放弃混用包管理器；
3. 回到 junction + 三项登记（dependency / bundles / patch），配置只保留 `locale` 与 `logLevel`。

**再次踩同一个坑**：为了重装而执行 `rmSync(profile/node_modules/dsh-projectops, { recursive: true })`——
那是**指向本仓库的目录联接**，Windows 顺着它删进仓库，`.git` 顶层文件再次被删（src/tests/docs/scripts/lib 全部完好）。

**硬防护**：新增 `scripts/safe-remove.mjs`——递归删除前扫描整棵树，只要发现重解析点就拒绝执行并给出处理方式。
以后任何删除动作都走它。
