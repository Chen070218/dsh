# 贡献指南

感谢你愿意改进 dsh-projectops。这个项目刻意保持**小依赖、可测试、说清边界**，请一起守住这三点。

## 本地开发

```bash
git clone <你的仓库地址>
cd dsh-projectops
npm run build     # Node 内建类型擦除：src/*.ts -> lib/*.js
npm test          # 完整测试需要本机安装 DSH（用到真实 cordis / dsh-tools）
npm run test:ci   # 不需要 DSH 的子集，CI 跑这个
```

- 构建不用 tsc/esbuild，因此**源码只能写可擦除语法**：不要 `enum`、`namespace`、构造函数参数属性。
- 类型检查在本地可选：`npx -p typescript tsc --noEmit`（仓库不强制依赖 typescript）。
- 测试用 `node:test`；需要 DSH 运行时的测试通过 `tests/support/runtime-hooks.mjs` 解析 `@deepseek-ai/*`。

## 目录约定

| 层 | 目录 | 规则 |
| --- | --- | --- |
| 工具 | `src/tools/` | 只做参数/输出 schema、调用服务、渲染；不写业务逻辑 |
| 服务 | `src/services/` | 纯逻辑，可直接单测，禁止 import 宿主包 |
| 适配 | `src/adapters/` | 文件系统/源码读取，必须可注入替身 |
| 安全 | `src/security/` | 所有路径校验只在这里实现 |
| 存储 | `src/storage/` | 接口 + SQLite 实现，SQL 必须参数绑定 |

## 提交规范

- 提交信息用 Conventional Commits：`feat(scope): ...` / `fix(scope): ...` / `docs: ...` / `test: ...` / `chore: ...`；
- 一个提交只做一件事；带 `feat`/`fix` 时同步更新 `CHANGELOG.md`；
- 提交前确保 `npm run build && npm run test:ci` 通过。

## 新增一个工具的最小步骤

1. 在 `src/services/` 写纯逻辑（含单测）；
2. 在 `src/tools/` 用 `defineTool` 声明参数与**输出 schema**（受支持子集：显式 `additionalProperties`、属性节点 `required`）；
3. 在 `src/index.ts` 的 `apply` 里注册，并把新配置项加进 `Config`；
4. 如果是写操作：默认 `dryRun=true`、默认不覆盖、路径必须过 `WorkspaceGuard`；
5. 补测试：服务单测 + 工具级测试 + 在 `tests/integration.loader-mount.test.ts` 里断言工具已注册。

## 安全红线

- 不要新增"读取任意路径"的入口；所有路径都必须经 `WorkspaceGuard`。
- 不要把文件内容、密钥、`.env` 写进日志或数据库。
- 不要为通过测试而放松边界检查；宁可让测试慢一点。

## 发布流程（维护者）

1. 更新 `CHANGELOG.md` 与 `package.json` 版本（SemVer）；
2. `npm run build && npm test`；
3. `git tag vX.Y.Z && npm publish`（`files` 已限定只发布 `lib/`、清单与文档）。
