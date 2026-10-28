# Task Progress (dsh-workplan)

[![verify](https://github.com/abbaababa/dsh-workplan/actions/workflows/verify.yml/badge.svg)](https://github.com/abbaababa/dsh-workplan/actions/workflows/verify.yml)

**中文（简体）说明：** [README.md](README.md)

> Plan first, dispatch real department subagents, then show the progress in plain language.
>
> **No app to install, no DSH source to patch, no page replacement.** You get three things: a plan in the conversation, real subagents doing the work, and a **Task progress** panel in the sidebar.

---

## What it actually does

For every new task with a real goal, the plugin inserts three beats:

1. **Plan before acting.** Before the model's first step, it writes a plan: stages → concrete work items → which department owns each one → how to do it → what counts as done → what could go wrong.
2. **Show the plan first.** The plan appears in the conversation as a task-decomposition block, so you can see the reasoning and acceptance criteria instead of a one-line promise.
3. **Dispatch real work.** Each work item is handed to a **real DSH subagent** (up to 5 at a time), and results are written back to the session. The main agent must dispatch and wait for the department results before it continues.

Greetings, thanks, and status questions ("how far along are we?") do not trigger a plan.

## Requirements

| Item | Detail |
|---|---|
| DeepSeek Harness | the official Web app (`dsh web` / `--profile web`) |
| Node.js | **22 or newer** |
| Network | npm registry access during install |

## Install

```bash
dsh plugin --profile web add dsh-workplan@1.4.3
```

Restart the DSH Web process (or reload the page) so the bundle is picked up.

### From source (optional)

```bash
git clone https://github.com/abbaababa/dsh-workplan.git
cd dsh-workplan
npm ci && npm run build
dsh plugin --profile web add "$(pwd)"
```

## Use it

1. Send a task with a real goal, e.g. "raise coverage in this directory to 80%".
2. The task-decomposition plan shows up in the conversation.
3. Keep talking normally; the main agent dispatches the plan and asks you whenever a decision is needed.
4. Open **Task progress** in the sidebar:

   - five headline numbers: **tasks / work items / done / in progress / blocked**;
   - plan cards grouped into **In progress** and **Completed**, each with a completion rate;
   - expand any plan to see per-stage progress and who owns each work item.

Every number is derived from the same task state — the panel can no longer claim "0 in progress" while the list below shows work running. That inconsistency is exactly what 1.4.3 fixed.

## Model tools (you don't call these yourself)

| Tool | Purpose |
|---|---|
| `dsh_workplan_dispatch` | Dispatch the current plan, wait for department subagents, write results back. Idempotent. |
| `dsh_workplan_update` | Main agent only: correct a subtask's status and evidence. |
| `dsh_workplan_cancel` | Cancel a plan that has not been dispatched; never fabricates completion. |

In **plan mode** the plan is shown for review and `dispatch` is explicitly refused with a reason.

## Budgets, timeouts, resumes

| Setting | Default | Environment variable |
|---|---|---|
| Dispatch budget per round | 20 min | `DSH_WORKPLAN_TOTAL_TIMEOUT_MS` |
| Single subagent ceiling | 15 min | `DSH_WORKPLAN_CHILD_TIMEOUT_MS` |
| No-progress window | 5 min | `DSH_WORKPLAN_IDLE_TIMEOUT_MS` |
| Automatic resumes | 4 | `DSH_WORKPLAN_MAX_RESUMES` |
| Subagent concurrency | 5 (fixed) | — |

Running out of budget is not a failure: the plan becomes **"budget used, resumable"**, finished work is not redone, and the remainder continues on the next dispatch. A stalled subtask blocks only itself.

Limits can also be set in the plugin config:

```jsonc
{ "totalTimeoutMs": 1800000 }
```

## Security and privacy

- **No third-party runtime dependencies** — `dependencies` is empty.
- **No filesystem writes** — no `writeFileSync` / `appendFileSync` / `mkdirSync` in `src/`; results go into the DSH session record.
- **No outbound traffic** — no `child_process`, no external `fetch`/`http.request`; the one `fetch` is the browser asking its own origin for `/dsh-workplan/plans`.
- **The panel route is authenticated** — unauthenticated requests get 401.
- **Chart.js is vendored** (`vendor/chart.umd.js`, MIT); no CDN script is loaded.

Verify it yourself:

```bash
npm view dsh-workplan@1.4.3 dependencies
grep -RInE "writeFileSync|child_process|eval\(" src
npm audit --omit=dev
```

## What 1.4.3 fixes

1.4.3 is a counting-consistency release. The plugin used to keep two sources of truth — live subtask state and a cached stats snapshot — so the panel could disagree with reality.

| Defect | Symptom | Cause |
|---|---|---|
| D1 | numbers frozen for minutes | stats recomputed only after a whole wave of subagents finished |
| D2 | two numbers in one payload disagree | counts came from the cache, department totals from live state |
| D3 | "not started" item showing 100% with a stale owner | budget reset bypassed the state machine |
| D4 | the same failure reported at 100% or 0% | two code paths disagreed on blocked progress |

The fix removes the cached snapshot: every number is derived at serialisation time by one function, guarded by 7 invariants and mutation tests. Full report: [docs/fix-report-derived-counts-1.4.3.md](docs/fix-report-derived-counts-1.4.3.md).

## FAQ

**Nothing happens after installing.** Restart DSH Web; confirm `dsh-workplan` is in `~/.dsh/profiles/web/package.json`.

**The panel is empty.** It shows plans for the current session only.

**Numbers are lower than before.** That is the fix: 1.4.3 derives them from real state, and the old numbers were frequently inflated.

**A subagent stopped moving.** Five minutes without new events marks it blocked, in isolation. Tell the main agent to resume the plan.

## Uninstall

```bash
dsh plugin --profile web remove dsh-workplan
```

## Development

```bash
npm ci
npm run check     # tsc --noEmit
npm test          # 90 tests, including count invariants and mutation tests
npm run build     # src/*.ts → lib/*.js, client.js
```

`lib/` and `client.js` are committed build output; CI rebuilds them and fails if they drift.

## License

MIT — see [LICENSE](LICENSE). Chart.js is MIT as well.
