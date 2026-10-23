## 做了什么

<!-- 一句话说明这个 PR 的目标 -->

## 关联 issue

<!-- Closes #123 -->

## 自检清单

- [ ] `npm run build` 通过（源码保持可擦除语法）
- [ ] `npm run test:ci` 通过；如改动工具层，本地 `npm test` 也通过
- [ ] 新增/修改写操作时：默认 dry-run、默认不覆盖、路径经 `WorkspaceGuard`
- [ ] 没有把文件内容、密钥写进日志或数据库
- [ ] 更新了 `CHANGELOG.md`（feat / fix）
