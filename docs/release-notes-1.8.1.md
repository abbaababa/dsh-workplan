# dsh-workplan 1.8.1 — 自我更正版 / Self-correction release

**2026-10-30 ｜ 补丁版 ｜ 无新功能，无新主张，只修"说错的话"**

---

## 一句话

1.8.0 发布后我们做了独立复核，发现**文档有三处说得比代码多**。讲安全的文档说错话，比不写文档更糟，所以单独发一个补丁版把话改对，并把改的过程也公开。

> 本版**没有**新增任何安全主张。仍然没有 CC 证书，仍然不宣称"通过"或"完全满足"。

---

## 改了什么（三条，都是文档）

| # | 之前怎么写 | 实际上 | 现在怎么写 |
|---|---|---|---|
| 1 | 图表库路由（`/dsh-workplan/vendor/chart.umd.js`）"同上鉴权" | 该路由从来没调用 `connection.requestRejection`；一条 `curl` 就能证伪 | 明说：这是**公开静态资源**（随包固定的 Chart.js 4.6.1，MIT，不含任何会话数据），只答 GET/HEAD，**不鉴权**；带数据的 `/dsh-workplan/plans` 才鉴权 |
| 2 | 自测覆盖"鉴权分支、方法限制、响应截断" | `tests/` 里 401/403、405、2.5 MB 截断**没有**逐分支用例 | 如实列出已覆盖项，并把缺口登记为安全目标草案 §9 的已声明缺口 |
| 3 | EAL1 矩阵里 `ASE_CCL.1` = ✅ | 同一份文档开头写着 "Conformance claim: NONE"，自相矛盾 | 改为 🟡；就绪度合计 **11 项 → 10 项**（10 就绪 / 3 部分 / 1 必须外部实验室） |

## 改了什么（一处代码）

- `src/host.ts`：图表库路由补上方法限制 —— 非 GET/HEAD 返回 `405` 并带 `allow: GET, HEAD`；HEAD 只回头不回体。路径仍是常量（不由请求 URL 拼接），依旧没有写盘、子进程、出站请求。

## 补了什么（一处测试）

- `tests/security-headers.test.ts` 新增 1 项：断言图表路由的 405 与 GET/HEAD 限制确实存在，防止文档与实现再次各说各话。**187 → 188 项。**

## 补了一句必须说的话

**ISO/IEC 15408:2026 是现行国际标准，但认证体系还在用 2022 版。** 截至 2026 年，JISEC、波兰 NASK 与欧盟 CC 证书报告都仍要求 **CC/CEM:2022 Release 1**（含 2025-10-15 勘误 v1.2）。也就是说：我们参照的是最新版标准的结构，而**真实评估会先按 2022 版受理**。这是标准版本与认证实践之间的时差，不是插件的缺陷——但不说清楚就是误导，所以写进了自评估报告（差距 N-07）。

---

## 自己验证（复制即用）

```bash
git clone https://github.com/abbaababa/dsh-workplan.git && cd dsh-workplan
git checkout v1.8.1
npm ci && npm run verify        # 期望：tests 188 / pass 188 / fail 0

# 1) 带数据的路由：有鉴权、有 405
grep -n "requestRejection\|allow: 'GET, HEAD'" src/runtime.ts

# 2) 静态资源路由：有 405，没有 requestRejection
awk '/vendor\/chart.umd.js/,/^        },/' src/host.ts | grep -n "405\|requestRejection"
```

第二条命令的输出里，`405` 命中、`requestRejection` 不命中 —— 这正是文档现在说的样子。

---

## English summary

**1.8.1 is a self-correction release with no new features and no new claims.**

After publishing 1.8.0 we ran an independent review and found three places where the documentation promised more than the code delivered:

1. `SECURITY.md` / `docs/cc/SECURITY-TARGET.md` claimed the vendored Chart.js route ran the same auth check as `/dsh-workplan/plans`. It never did. The docs now state the asymmetry plainly: the asset route is public, fixed, session-data-free, GET/HEAD only and **not** auth-checked; the data route is.
2. `SECURITY-TARGET.md` claimed the test suite covered the auth, method-restriction and truncation branches. It does not. The docs now list what is covered and register the gap in §9 of the Security Target draft.
3. The EAL1 matrix marked `ASE_CCL.1` as ready while the same document opens with `Conformance claim: NONE`. Corrected to partial; readiness is now **10 ready / 3 partial / 1 external-lab-only**.

One code change (the asset route now returns `405` for non-GET/HEAD with `allow: GET, HEAD`, and answers HEAD without a body) and one new test that pins it. The suite went from 187 to 188 tests.

One correction of substance: **ISO/IEC 15408:2026 is the current standard, but certification schemes still accept CC:2022 Release 1** (JISEC, NASK, and EU CC certificate reports as of 2026, including erratum v1.2 of 2025-10-15). Our material follows the 2026 structure; a real evaluation would be accepted under the 2022 edition first. That is a timing gap between standard and practice, not a plugin defect — but leaving it unsaid would mislead, so it is now recorded as gap N-07.

**Still true, unchanged:** no certificate, no lab evaluation, no EAL rating, no claim of "full compliance". What we publish is evidence anyone can re-run.
