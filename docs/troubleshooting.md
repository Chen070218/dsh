# 排错手册

## 工具没出现在会话里

1. 确认 profile 已写入：`node scripts/install-into-profile.mjs`（dry-run 会列出四项计划）；
2. 写入后**完全退出并重启 DSH**（当前会话的工具面在启动时固定；有时宿主会热加载，但不能假设）；
3. 仍不出现时看 profile 的 `cordis.patch.yml` 是否有 `name: dsh-projectops`，以及 `node_modules/dsh-projectops` 是否是指向仓库的目录联接。

## 想撤掉插件

```bash
node scripts/install-into-profile.mjs --rollback
# 或用 DSH 自带 Node（不依赖系统 node）：
set ELECTRON_RUN_AS_NODE=1 && "<DSH 安装目录>\DeepSeek Harness.exe" scripts\install-into-profile.mjs --rollback
```

最坏情况（DSH 起不来）：双击仓库根的 `rollback-profile.cmd`。

## 测试报 "@deepseek-ai/dsh-tools 找不到"

需要 DSH 运行时。测试用 `tests/support/runtime-hooks.mjs` 把 `@deepseek-ai/*` 指向本机安装：

```bash
# 自动探测失败时手动指定
set DSH_RUNTIME_DIR=<DSH 安装目录>\resources\app.asar\dsh\node_modules
```

没有 DSH 时只能跑不依赖宿主的子集：`npm run test:ci`（48 个用例）。

## 本机没有 node / npm

DSH 桌面版自带 Electron 的 Node，可以这样用：

```bash
set ELECTRON_RUN_AS_NODE=1
"<DSH 安装目录>\DeepSeek Harness.exe" scripts\build.mjs
"<DSH 安装目录>\DeepSeek Harness.exe" --test --import ./tests/support/runtime-hooks.mjs "tests/**/*.test.ts"
```

## 构建报 "SyntaxError: Unexpected token '*'" 或 "enum is not supported"

- 源码必须保持**可擦除语法**：不能用 `enum`、`namespace`、构造函数参数属性；
- 块注释里不要出现 `**/`（会提前闭合注释，构建脚本曾因此炸过一次）。

## Windows 上删临时目录报 EPERM / 仓库文件莫名消失

目录联接（junction）被 `rmSync(recursive)` 递归跟随时会删到目标目录里。测试里的清理逻辑现在只对**联接本身**做非递归 `rmdir`，无法确认是联接就直接放弃清理。若你写类似脚本，请照这个规则来。

## 扫描结果为空 / 全是 0

- 检查 `path` 是否指到了排除目录（`node_modules`、`.git`、`dist` 等）；
- 隐藏项默认不统计，`includeHidden: true` 才会算进来；
- `maxDepth` 太小会只列一层，注意返回值里的 `warnings`。

## 任务库在哪里 / 能不能换位置

默认 `<工作区>/.projectops/tasks.db`（已 gitignore）。换目录用配置项 `tasksDirectory`；不建议指到工作区外——那会绕过「只写授权工作区」的约束。
