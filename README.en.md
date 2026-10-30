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

## How departments collaborate (what 1.7.1 actually does)

Every work item carries a department label (Engineering, Research, Design, Product, Data, QA, Security, DevOps, Writing, Operations, Legal, Finance). **The label drives the prompt and the stats, not an org chart**:

- Departments **cannot talk to each other directly**. Cross-department information goes through the main agent, or through files both sides can read.
- A downstream task sees only the **summary** of its `dependsOn` upstreams — not sibling tasks, not the upstream's full conversation. Upstreams must put the artifact's absolute path and acceptance steps in the summary.
- A stage is a display grouping, **not an execution gate**; `dependsOn` decides order.
- Each child receives a **read-only brief of its sibling tasks** (who, what, expected outputs, summaries of finished work). It cannot contact them directly: cooperation requests go into `needs`, and the result message collects them under "cross-department hand-offs" for the main agent.
- A child returns a structured evidence block (`status` / `acceptance` / `artifacts` / `needs`). **Non-empty output no longer means done**: `partial`, any failed acceptance item, or an unparsable block is blocked; only all-`pass` is trusted directly, everything else is flagged "unverified" for the main agent.
- Declared `file` artifacts are checked; a missing artifact keeps downstream tasks locked and names the upstream plus the missing file.

The full contract — roles, data shapes, state machine, recovery, and the three places to update together — is in **[Collaboration contract](https://github.com/abbaababa/dsh-workplan/blob/main/docs/collaboration.md)**; per-department duties and handoff checklists are in **[Departments and handoffs](https://github.com/abbaababa/dsh-workplan/blob/main/docs/departments.md)**.

## Requirements

| Item | Detail |
|---|---|
| DeepSeek Harness | the official Web app (`dsh web` / `--profile web`) |
| Node.js | **22 or newer** |
| Network | npm registry access during install |

## Install

```bash
dsh plugin --profile web add dsh-workplan@1.7.1
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
   - plan cards grouped into **In progress**, **Ended** and **Completed**, each with a completion rate. **Ended** means the turn has stopped (nothing is running) while the plan is still unfinished; the card also says where it stopped (budget spent / stuck / not started) and resuming is one sentence away;
   - expand any plan to see per-stage progress and who owns each work item.

Every number is derived from the same task state — the panel can no longer claim "0 in progress" while the list below shows work running. That inconsistency is exactly what 1.4.3 fixed.

## Model tools (you don't call these yourself)

| Tool | Purpose |
|---|---|
| `dsh_workplan_dispatch` | Dispatch the current plan and write results back. `mode:"wait"` (default) waits for the round; `mode:"async"` returns immediately and keeps running in the background. Idempotent. |
| `dsh_workplan_status` | Read-only: ask how far along the plan is. Rebuilt from the session log, so it survives a restart or reload. |
| `dsh_workplan_update` | Main agent only: correct a subtask's status and evidence. Takes `expectedRevision` to prevent lost updates; in-flight subtasks are refused unless `force:true`. |
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
npm view dsh-workplan@latest dependencies
grep -RInE "writeFileSync|child_process|eval\(" src
npm audit --omit=dev
```

## What 1.5.0 changes (progress you can see)

1.5.0 is presentation-only: the collapsed plan card swaps its single grey line ("本计划 0/8 做好了" plus a 54×5px bar) for an actual chart.

| Where | Before | After |
|---|---|---|
| collapsed plan card | 12px grey text + mini bar + "0 卡住了"; the percentage existed only in the hover `title` | 44px ring + 24px percentage + `本计划 X/Y 做好了` + one "what is happening now" line (blocked first, with the task name) + 8px four-segment composition bar + status legend + stage stepper |
| expanded panel | one plan-level progress bar | "Step progress": one row per stage (name, `done/total`, thin bar, state) plus a weighted overall figure |
| a 0% plan | the bar fill was 0px wide and its track used the same token as the card background — effectively no chart | four signals: a thickened ring track, a 24px "0%", a full grey "not started" bar, and dashed stage slots with the current stage outlined |
| a group with 0 work items | `未完成 0 / 已完成 0（完成率暂无数据）` | that sentence is gone; only the `—` in the ring remains (the in-group empty state still renders when expanded) |

None of the counts disappeared — the legend always carries all four buckets with their numbers.

**How to see it**: the front end ships in `client.js`, which DSH Web loads at start-up, so restart DSH Web and then reload <http://127.0.0.1:3080>. For an offline comparison open [docs/preview/progress-visual-1.5.0.html](docs/preview/progress-visual-1.5.0.html) (`npm run preview` regenerates it with the same CSS for both versions).

No new dependencies, `plan.ts` / `runtime.ts` untouched; rollback is documented in [CHANGELOG.md](CHANGELOG.md).

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
npm test          # all tests (the count changes between versions; trust the output and CI), including count invariants and the progress chart
npm run build     # src/*.ts → lib/*.js, client.js
npm run preview   # regenerate the 1.4.3 / 1.5.0 card comparison under docs/preview
```

`lib/` and `client.js` are committed build output; CI rebuilds them and fails if they drift.

## License

MIT — see [LICENSE](LICENSE). Chart.js is MIT as well.
