# Release record — dsh-workplan 2.1.3 (2026-11-06)

本文件是可复现的发布记录，供后续排查与追溯使用。每一项都可用文中给出的命令重新验证。

---

## 一、这一版要解决什么

| 版本 | 改了什么 | 够不够 |
|---|---|---|
| 2.1.1 | 把规划器超时从 120s 提到 300s | ❌ 只是推迟了超时 |
| 2.1.2 | 明确区分「真超时」与「偶发中断」，不再误报 | ⚠️ 报错变清楚了，但超时照样复发 |
| **2.1.3** | **把单次规划器调用的墙钟上限改成可配置项** | ✅ 治本 |

**根因（2.1.3 之前一直没解决的）**：规划器是**单次 LLM 调用**，用写死的常量做墙钟超时。
任务越复杂（长上下文 + 多子任务结构化 JSON），单次调用耗时越长，到点必被杀。
2.1.1 只把 120s 改成 300s，等于把「必然发生」推迟到 5 分钟后，仍然必然发生。

**2.1.3 的解法**：`plannerTimeoutMs` 变成可配置项，链路打通
`host.ts`（配置 / 环境变量）→ `runtime.ts`（`WorkplanRuntimeOptions`）→ `runPlanner`（`setTimeout`）。

---

## 二、改动清单

| 文件 | 改动 |
|---|---|
| `src/host.ts` | `WorkplanConfig` 新增 `plannerTimeoutMs?: number`；`apply()` 里 `plannerTimeoutMs: numericSetting(config.plannerTimeoutMs, 'DSH_WORKPLAN_PLANNER_TIMEOUT_MS')` |
| `src/runtime.ts` | `WorkplanRuntimeOptions` 新增 `plannerTimeoutMs?: number`；`runPlanner` 改为 `const plannerTimeoutMs = Number(options.plannerTimeoutMs ?? PLANNER_TIMEOUT_MS)`，`setTimeout` 用它；调用点传入 `options?.limits?.plannerTimeoutMs` |
| `lib/runtime.js` / `lib/host.js` | 由 `npm run build` 生成（与 src 同步） |
| `package.json` / `package-lock.json` / `src/host.ts`(meta.version) / `README.md` / `README.en.md` / `README.zh.md` / `tests/fixtures/tool-surface.json` | 版本号 7 处同步至 `2.1.3` |
| `CHANGELOG.md` | 新增 `## 2.1.3 — 2026-11-06` 条目 |

---

## 三、怎么用（新增能力）

```bash
# 复杂任务（长上下文 / 多子任务）放宽规划器时限，毫秒
export DSH_WORKPLAN_PLANNER_TIMEOUT_MS=900000   # 15 分钟
```

未设置时回落到默认 `300000`（5 分钟）。也可用配置文件 `plannerTimeoutMs`。

---

## 四、发布与回验证据

| 渠道 | 结果 | 复验命令 |
|---|---|---|
| npm | 已发布 `2.1.3`，`dist-tags.latest = 2.1.3` | `npm view dsh-workplan dist-tags.latest` |
| npm tarball 内容 | 含修复 | `curl -sL $(npm view dsh-workplan@2.1.3 dist.tarball) \| tar -xzO package/lib/runtime.js \| grep plannerTimeoutMs` |
| GitHub Release | 已建，含安装包 `dsh-workplan-2.1.3.tgz` | `gh release view v2.1.3 --repo abbaababa/dsh-workplan` |
| git tag | `v2.1.3` 已推送（指向 `cc3562e`） | `git ls-remote --tags origin \| grep v2.1.3` |
| GitHub Actions | `verify` 全绿 | https://github.com/abbaababa/dsh-workplan/actions/runs/42192179962 |
| 本地测试 | 580/580 通过 | `npm run verify` |
| build 幂等 | 通过（CI 第 6 步 `git diff --exit-code -- lib client.js` 必为 0） | `npm run build && git diff --exit-code -- lib client.js` |

---

## 五、2.1.2 的 CI 红叉（已修复，供参考）

2.1.2 首次推送时 CI `verify` 红叉（run `42172640105`），580 项中 2 项失败：

- `#399 package.json, package-lock.json and meta.version stay in sync` → `'2.1.2' !== '2.1.1'`
- `#400 CHANGELOG and README mention the version being shipped` → `README.md must install dsh-workplan@2.1.2`

**根因**：2.1.2 发布时只 bump 了 `package.json`，漏改 `package-lock.json`（两处）、
`src/host.ts` 的 meta.version、三语 README 的徽章与安装命令、`tests/fixtures/tool-surface.json`。
仓库自带的 `tests/version-sync.test.ts` 当场抓到（这正是该测试存在的意义）。

**修复**：commit `c2ec7b2` 补齐 7 处，红叉转绿（run `42188255718`）。

**注意**：npm 上已发布的 `2.1.2` 包内文档仍是旧版本号（npm 不允许覆盖已发布版本），
不影响插件功能；2.1.3 起包内外一致。

---

## 六、回滚方式

- 代码：`git revert cc3562e && git push origin main`；撤销 tag：`git tag -d v2.1.3 && git push origin :refs/tags/v2.1.3`
- npm：发布 72 小时内可 `npm unpublish dsh-workplan@2.1.3`；超时则 `npm deprecate dsh-workplan@2.1.3 "请升级到修复版本"` 并另发修复版。
