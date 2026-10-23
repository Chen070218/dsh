# 工具用法手册

八个工具都在 `ctx.tools` 里，模型可以直接调用。所有路径参数都必须是**当前会话工作区**（或插件配置 `allowedRoots`）之内的路径。

## 1. scan_project — 项目结构扫描

```json
{ "path": ".", "maxDepth": 3, "includeHidden": false, "includeTree": true }
```

返回：`root / authorizedRoots / detection{语言,入口,配置,包管理器} / stats / directorySummary / tree / truncated / cached / warnings`。

实测（本仓库，`maxDepth=2`）：

```text
files: 40  dirs: 20  primaryLanguage: TypeScript
byExtension: .ts 19, .md 8, .mjs 5, .json 3
directorySummary: tests 17 文件 / docs 2 / scripts 5 / lib 2
```

要点：
- 相同参数第二次调用会命中缓存（`cached: true`），根目录 mtime 或 TTL 变化即失效；
- 敏感文件（`.env*`、`*.pem`、`*.key`、`credentials*`）不列出、不读取，只统计「跳过 N 个」。

## 2. analyze_dependencies — 依赖分析（Python / TypeScript-JavaScript）

```json
{ "path": "./src", "language": "auto", "maxFiles": 2000, "includeMermaid": true }
```

返回：`language / detected{python,javascript} / mixedProject / stats / modules / edges / cycles / external / unresolved / mermaid`。

实测（本仓库 `src/`，TypeScript）：

```text
language: javascript  detected: {python: 0, javascript: 28}  mixed: false
modules: 28  edges: 88  cycles: 0  unresolved: 0
external: node:fs(10), node:path(8), @deepseek-ai/dsh-tools(4), node:sqlite(1)
```

实测（`examples/sample-python-app`）：

```text
language: python  modules: 5  edges: 5  cycles: 1
cycles: app.models <-> app.repository <-> app.service
```

要点：
- `language: auto` 按文件数选择；混合仓库会返回 `mixedProject: true`（只分析一种语言，避免跨语言伪循环）；
- 「循环依赖」= import 图的强连通分量，是**静态可确认**的结构；`external`/`unresolved` 是启发式分类；
- 动态导入（`importlib`、`import()` 拼接、`__import__`）识别不到。

## 3. 任务管理四件套

```json
{ "title": "接入依赖分析", "description": "把 Mermaid 图接进报告", "priority": 3, "dependsOn": [] }
```

- `task_create` → 返回任务（状态 `pending`）
- `task_update({ "id": "...", "state": "in_progress", "message": "开始" })` → `attempts` +1，并写一条执行记录
- `task_update({ "id": "...", "state": "failed", "message": "token=... 无效" })` → `lastError` 自动脱敏
- `task_list({ "state": "failed" })` / `task_get({ "id": "..." })` → 列表与执行记录

任务库固定在工作区 `.projectops/tasks.db`（SQLite，`node:sqlite`，零原生依赖）。

## 4. 文档生成两件套

```json
{ "path": ".", "outputPath": "docs/architecture.md", "dryRun": true }
```

- 默认 **dry-run**：只返回 `plan`（目标/字节/覆盖策略/执行模式）+ `preview`（前 20 行）；
- 目标已存在且未传 `overwrite: true` → `written: false` + `skippedReason`，绝不静默覆盖；
- `generate_readme_draft` 默认写 `README.generated.md`，不会碰你已有的 `README.md`。

推荐流程：先 `dryRun: true` 看计划 → 用户确认 → `dryRun: false` 写入。

## 5. 典型组合

```text
scan_project            -> 项目画像（语言、入口、规模、目录分布）
analyze_dependencies    -> 依赖图 + 循环依赖 + Mermaid
generate_architecture_report -> 把上面两份结论落成文档
task_create/task_update -> 把发现的问题变成可追踪的任务，记录每次尝试与失败原因
```
