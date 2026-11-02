# Release record — dsh-workplan 1.11.1 (2026-11-02)

Patch release on top of 1.11.0. It fixes a defect that 1.11.0 claimed but did not
actually enforce at the data layer.

## Source

| Item | Value |
| --- | --- |
| Commit | `f7c92dc` |
| Tag | `v1.11.1` (annotated object `06b2b1881809d3cc770292be767447a4505b296c`) |
| Version declarations | `package.json`, `package-lock.json` (2), `src/host.ts` meta, `CHANGELOG.md`, `README.md`, `README.en.md` — all `1.11.1` |
| Base | `v1.11.0` @ `71f0b65` |

## What changed

`applyReplanStatuses` now cascades a cancelled upstream through the dependency
graph instead of only marking the cancelled row:

- direct dependents become `blocked` with `blockedBy` pointing at the cancelled row;
- transitive dependents become `blocked` with an error that names the root
  cancelled row and the cancellation reason;
- live path and replay path use the same function, so a refresh cannot revert
  the cascade.

Before this, `probe_d13.mjs` reported `FAIL(before)` against the released 1.11.0
`lib/`; after the fix it reports `PASS` against the `v1.11.1` tag build.

## Verification

| Check | Result |
| --- | --- |
| `npm run check` | exit 0 |
| `npm test` | **364 / 364 passed, 0 failed** |
| `probe_d13.mjs lib` on the tag clone | `PASS: D-13 cancel cascades A -> B -> C` |
| Clean-clone build + pack | succeeded |

## GitHub Release

- URL: https://github.com/abbaababa/dsh-workplan/releases/tag/v1.11.1
- Asset: `dsh-workplan-1.11.1.tgz`
- Size: 918,951 bytes
- SHA-256: `6cb91fe77f540068186bb9a47198742c2ee5ce58705bd0fa4a56e2260026e0a1`

## npm

- `dsh-workplan@1.11.1` published; registry propagation can take a few minutes
  before `npm view dsh-workplan@latest version` reports it.

## Catalog index

- PR https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11316 updated
  to `v1.11.1/dsh-workplan-1.11.1.tgz` (OPEN, MERGEABLE, single file).
- The upstream catalog npm package is still rebuilt by the upstream CI; this
  repository cannot publish it.

## Known limits (unchanged from 1.11.0)

SSE push (4 s polling), department duties as data, contract v2, checkpoint
runtime semantics, child-session shell guard, per-artifact locking, and the
remaining medium/low items in `_t10_defect_triage_20261102/defects.json`.
