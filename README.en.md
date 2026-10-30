# DSH ProjectOps

> A project-engineering copilot plugin for [DeepSeek Harness](https://harness.deepseek.com) (DSH):
> scan a project, analyze Python imports, detect dependency cycles, manage tasks in SQLite, and generate architecture docs — all read-only by default, all inside an authorized workspace.

[![CI](https://github.com/chen070218/DSH/actions/workflows/ci.yml/badge.svg)](https://github.com/chen070218/DSH/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

中文文档见 [README.md](README.md)。

## Tools

| Tool | What it does | Safety |
| --- | --- | --- |
| `scan_project` | Directory tree, file-type stats, per-directory summary, heuristic language/entry/config detection, cached scans | read-only, workspace-bounded |
| `analyze_dependencies` | Static Python import graph, Tarjan SCC cycle detection, external/unresolved imports, Mermaid diagram | read-only, workspace-bounded |
| `task_create` / `task_list` / `task_get` / `task_update` | SQLite task store with execution history | writes only `<workspace>/.projectops/tasks.db` |
| `generate_architecture_report` | Markdown architecture doc (overview, structure, modules, deps + Mermaid, confirmed issues, heuristics, suggestions) | `dryRun=true` by default, never overwrites by default |
| `generate_readme_draft` | README skeleton from the scan result | writes `README.generated.md`, leaves your README alone |

## Install (DSH plugin)

```bash
node scripts/install-into-profile.mjs            # dry-run: prints the plan
node scripts/install-into-profile.mjs --apply    # writes profile wiring (backup included)
# fully quit and restart DSH afterwards
```

Rollback: `node scripts/install-into-profile.mjs --rollback`.

## Development

```bash
npm run build      # src/*.ts -> lib/*.js via Node built-in type stripping (no tsc/esbuild)
npm test           # full suite (75 tests); needs a local DSH install for the host-level tests
npm run test:ci    # 48 tests that run without DSH (what CI runs)
npm run demo:analyze
npm run demo:report
```

Design rules we hold ourselves to:

- **Every path goes through `WorkspaceGuard`** (lexical check, then `realpath` check — symlink escapes are rejected).
- **Sensitive files are never listed, read, or logged** (`.env*`, `*.pem`, keys, credentials).
- **Write operations default to `dryRun`** and never overwrite existing files unless explicitly allowed.
- **Confirmed vs heuristic** findings are always reported separately.

## Layout

```text
src/  index.ts (plugin entry) · tools/ · services/ · adapters/ · security/ · storage/ · util/
tests/ unit · host-composition · real PluginLoader mount path
docs/ architecture.md · dev-log.md
```

## License

MIT — see [LICENSE](LICENSE). Contributions welcome, see [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
