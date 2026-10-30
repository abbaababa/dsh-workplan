# dsh-workplan 对 ISO/IEC 15408:2026 的符合性自评估报告

**Self-Assessment Report against ISO/IEC 15408:2026**

| 项目 | 内容 |
|---|---|
| 评估对象（TOE） | dsh-workplan 插件 v1.8.0 |
| 评估性质 | **公开自评估（self-assessment），不是 CC 认证** |
| 依据标准 | ISO/IEC 15408-1/-2/-3/-4/-5:2026；ISO/IEC 18045:2026（CEM） |
| 报告日期 | 2026-10-30 |
| 报告者 | 项目维护者（abbaababa） |
| 结论摘要 | **不宣称通过 CC；按 15408-3 结构完成逐类自评，识别 8 项差距，本轮修复 4 项，剩余 4 项已列明原因** |

---

## 0. 一页读懂（给非技术读者）

**CC（Common Criteria，通用准则）是什么？**
它是一份国际标准（编号 ISO/IEC 15408），用来回答一个问题：*"一个软件在安全上到底能做到什么，凭什么让人相信？"* 它不测功能多不多，只查一件事——**你说的安全承诺，有没有证据撑得住**。

**最重要的一句话：软件不能自己宣布"我通过 CC 了"。**
CC 的规矩是三方分工：写代码的人交材料（Security Target，安全目标）→ 独立实验室按 ISO/IEC 18045 去测 → 国家认证机构发证书。**没有证书就没有"通过"**，谁说"完全满足"，谁就在说假话。本插件没有证书，所以本文从头到尾不会写"通过"或"完全满足"。

**那我们做了什么？**
把 CC 要求的那套材料**按标准结构做出来、公开出来、能被任何人复核**：

| 我们做的 | 对应 CC 里的东西 | 文件 |
|---|---|---|
| 写清楚这个插件保护什么、防谁、边界在哪 | 安全目标 ST | [SECURITY-TARGET.md](SECURITY-TARGET.md) |
| 把攻击面、威胁、已有对策列成表 | 脆弱性评定 AVA | [AVA-VULNERABILITY-ANALYSIS.md](AVA-VULNERABILITY-ANALYSIS.md) |
| 列出所有第三方组件及许可证 | 生命周期 ALC | [../SBOM.md](../SBOM.md) |
| 补上缺失的安全响应头 | 实现修复 | `src/runtime.ts` |
| 公开漏洞报告渠道与时限 | 生命周期 / 响应 | [../../SECURITY.md](../../SECURITY.md) |
| 187 项自动化测试，可一键复跑 | 测试 ATE | `npm run verify` |

**结论（三句话）**：
1. 插件的**工程实践**已经接近 CC 最低等级 EAL1 的材料要求；
2. 但**认证这件事本身**需要外部实验室和费用，不是改代码能解决的；
3. 所以我们把"能自证的"全部公开自证，把"不能自证的"逐条写清楚——**这才是对"国际标准"最诚实的用法**。

---

## 1. 审查依据与版本核验

### 1.1 版本核验结果

| 标准 | 版本 | 说明 |
|---|---|---|
| ISO/IEC 15408-1 | **2026** | 简介与一般模型（术语、评估对象、保证等级） |
| ISO/IEC 15408-2 | **2026** | 安全功能组件（SFR） |
| ISO/IEC 15408-3 | **2026** | 安全保证组件（SAR） |
| ISO/IEC 15408-4 | **2026** | 评估方法与活动框架 |
| ISO/IEC 15408-5 | **2026** | 预定义保护轮廓（PP） |
| ISO/IEC 18045 | **2026** | 评估方法（CEM），实验室照此执行 |

**为什么不是 2022 版？** 2026 年 5–6 月，ISO/IEC 已发布 15408 全系列 2026 版，替代 2022 版（CC:2022 Release 1）。多个国家成员体目录页明确标注 "Replaced standards ISO/IEC 15408-2:2022"。

**版本与结构核对来源**（公开可查）：
- ISO/IEC 15408-3:2026 目录（DIN 发布，含章节结构）：<https://www.din.de/de/mitwirken/normenausschuesse/nia/veroeffentlichungen/wdc-beuth:din21:402972060/toc-3703455/download>
- 该目录确认了 2026 版 ASE 类的族结构：`ASE_INT`(9.2)、`ASE_CCL`(9.3)、`ASE_SPD`(9.4)、`ASE_OBJ`(9.5)、`ASE_ECD`(9.6)、`ASE_REQ`(9.7)、`ASE_COMP`(9.9.4)；`ADV_FSP` 位于 10.3，组合类 `ACO_REL` 位于 15.4。
- CC:2022 Part 5（EAL 与组件表，IPA 镜像）：<https://www.ipa.go.jp/security/jisec/about/cdk3vs000000240h-att/CC2022PART5R1.pdf>

### 1.2 审查的已知限制（必须写明）

1. `www.commoncriteriaportal.org` 在本机返回 **HTTP 403**，无法直接读取门户正文；本文的族/组件编号以官方发布目录（上列）为准，若 2026 正式文本有微调，以正式文本为准。
2. 本文**不是**评估者报告（ETR），不含实验室结论、不含渗透测试、不含证书编号。
3. 审查范围为**公开可见的全部材料**：源码、测试、CI、文档、发布记录。

---

## 2. 评估对象（TOE）界定

**TOE = dsh-workplan 插件在 DSH Web 进程内运行的那部分**，具体包含：

| 组成 | 文件 | 作用 |
|---|---|---|
| 宿主运行时 | `src/runtime.ts`（2384 行） | 计划生成、派发、watchdog、HTTP 路由、鉴权 |
| Host 插件入口 | `src/host.ts` | 注册 2 条 HTTP 路由、4 个模型工具、配置 schema |
| 浏览器面板 | `src/client.ts`（2881 行）→ `client.js` | 渲染计划面板（同源拉取 `/dsh-workplan/plans`） |
| 计划模型 | `src/plan.ts`（2158 行） | 计划结构、校验、派生统计 |
| 看门狗 | `src/watchdog.ts`（207 行） | 子代理超时与预算监控 |
| 类型声明 | `src/globals.d.ts` | 宿主 API 的类型补充 |
| 随包第三方文件 | `vendor/chart.umd.js` | Chart.js 4.6.1（MIT），本地分发，不走 CDN |

**不在 TOE 内**（属于运行环境，即 CC 语境里的 "environment"）：
- DSH 本体与模型服务（身份认证、会话存储、模型推理）；
- Node.js 运行时与操作系统；
- 用户的浏览器。

**TOE 安全边界**：进程内的插件代码 + 它对外暴露的 2 条 HTTP 路由和 4 个模型工具。
- `GET/HEAD /dsh-workplan/plans`
- `GET/HEAD /dsh-workplan/vendor/chart.umd.js`
- `dsh_workplan_dispatch` / `dsh_workplan_status` / `dsh_workplan_update` / `dsh_workplan_cancel`

---

## 3. 核心结论：为什么"完全满足"不可宣称

CC 符合性有三个**缺一不可**的硬前提：

| # | 前提 | 本插件状态 | 能否靠改代码解决 |
|---|---|---|---|
| 1 | 一份符合 ASE 结构的 **Security Target**，且声明了符合性 | **有草案**（本仓 `docs/cc/SECURITY-TARGET.md`），但明确声明 "no conformance claim" | 部分可以（文档），但声明本身需要评估者背书 |
| 2 | 由**认可实验室**按 ISO/IEC 18045 完成评估并出具 ETR | **无** | ❌ 不能 |
| 3 | 由**国家/地区认证体系**签发证书（如 CCRA 成员体系） | **无** | ❌ 不能 |

因此，任何"本插件完全满足 ISO/IEC 15408"的表述都属于**不实陈述**。本项目拒绝这样写。
本报告能承担的是第 1 项的材料准备，以及把第 2、3 项的差距**量化、公开、可复核**。

> 一句话：**合规不是形容词，是证据链。我们把链子的每一节都摆出来，缺哪节就说缺哪节。**

---

## 4. 按 ISO/IEC 15408-3:2026 保证类的逐类判定

判定口径：✅ 材料齐备可复核 ｜ 🟡 部分具备、有明确缺口 ｜ ❌ 缺失 ｜ ➖ 不适用

| 保证类 | 该类要证明什么 | 本插件现状 | 判定 | 证据 / 缺口 |
|---|---|---|---|---|
| **ASE** 安全目标评估 | ST 是否自洽、可测、无矛盾 | 已按 INT/CCL/SPD/OBJ/ECD/REQ/TSS 结构写出 ST 草案，并显式声明"不作符合性主张" | 🟡 | `docs/cc/SECURITY-TARGET.md`；缺口：未经独立评估者评审，未覆盖 ASE_COMP（非组合产品） |
| **ADV** 开发 | 设计是否被完整、正确地描述到实现 | 全部源码公开（5 个 TS 模块 + 1 个类型声明，共 8044 行）；TSF 接口仅 2 路由 + 4 工具，可枚举 | 🟡 | 缺口：无独立的"功能规范（ADV_FSP）"文档与"实现表示（ADV_TDS）"文档；本报告第 2、5 节为最小替代 |
| **AGD** 指导性文档 | 用户/管理员能否正确安全地部署使用 | README（中英）、SECURITY.md 部署建议、FAQ | ✅ | `README.md`、`README.en.md`、`SECURITY.md`；含"我们不做/不宣称"清单 |
| **ALC** 生命周期支持 | 开发与交付过程是否受控、可追溯 | git 全历史（13 次提交）、CI（`npm ci` → `npm run verify` → 构建产物一致性检查）、版本五处同步测试 | 🟡 | 缺口：无正式《配置管理计划》文档、无可重现构建（reproducible build）证明 |
| **ATE** 测试 | 功能是否被独立验证过 | 30 个测试文件 / **187 项测试**全部通过，`npm run verify` 一键复跑，CI 每次提交执行 | 🟡 | 已有自动化测试与失败路径覆盖；缺口：无实验室独立测试（ATE_IND.1），无正式测试覆盖矩阵 |
| **AVA** 脆弱性评定 | 是否存在可被利用的脆弱性 | 威胁模型 7 条、攻击面枚举、源码特征扫描（危险 API 0 命中）、零运行时依赖 | 🟡 | `docs/cc/AVA-VULNERABILITY-ANALYSIS.md`；缺口：无第三方渗透测试 |
| **ACO** 组合 | 组合产品间的依赖与信任传递 | 插件不是组合产品（无底层 TOE 依赖） | ➖ | 不适用 |
| **AMA** 保证维护 | 发布后如何维持保证 | 有 CHANGELOG、语义化版本、npm `latest`、漏洞响应时限 | 🟡 | 缺口：无正式 AMA 计划文档（CC 的 AMA 类通常仅在保证维护场景要求） |

**逐类小结**：✅ 1 类 ｜ 🟡 6 类 ｜ ➖ 1 类 ｜ ❌ 0 类。
没有任何一类处于"完全缺失"状态，也没有任何一类可以被称为"已通过"。

---

## 5. EAL1 就绪度矩阵（最低保证等级）

EAL1 = "功能测试"级，是 CC 中最低、也是唯一对小工具现实可达的等级。
下表按 EAL1 通常包含的 14 个保证组件逐项自评。

| 组件 | 含义（大白话） | 状态 | 证据 | 还缺什么 |
|---|---|---|---|---|
| ASE_INT.1 | 说清这产品是什么 | ✅ | 本报告第 2 节、ST 草案 §1 | — |
| ASE_CCL.1 | 说清"符合什么标准" | ✅ | ST 草案 §2 显式写 "no conformance claim" | 正式评估时需改为实际符合性主张 |
| ASE_SPD.1 | 说清防谁、防什么 | ✅ | ST 草案 §3（7 威胁 / 3 假设 / 3 组织策略） | — |
| ASE_OBJ.1 | 说清安全目标 | ✅ | ST 草案 §4 | — |
| ASE_ECD.1 | 若有自定义要求，定义之 | ✅ | ST 草案 §5（声明不使用扩展组件） | — |
| ASE_REQ.1 | 说清选用了哪些安全要求 | ✅ | ST 草案 §6（5 个功能要求族 / 8 个组件 + 理由） | — |
| ASE_TSS.1 | 说清"实现上怎么做到的" | ✅ | ST 草案 §7（逐条映射到文件与行为） | — |
| ADV_FSP.1 | 有基本的功能规范 | 🟡 | 路由/工具接口已完整枚举（本报告 §2、§5） | 缺一份独立的接口规范文档 |
| AGD_OPE.1 | 有用户操作指南 | ✅ | README 中英双语、面板使用说明 | — |
| AGD_PRE.1 | 有安装/准备指南 | ✅ | README 安装章节、SECURITY.md 部署建议 | — |
| ALC_CMC.1 | 有版本标识与唯一标识 | ✅ | `package.json` 版本五处同步测试、npm 发布记录、git tag | — |
| ALC_CMS.1 | 有配置项清单 | ✅ | `docs/SBOM.md` + `package-lock.json` + 文件清单 | 正式评估建议补 CM 计划 |
| ATE_IND.1 | 独立测试 | ❌ | 本仓有 187 项自动化测试，但**不是独立实验室测试** | 必须外部实验室 |
| AVA_VAN.1 | 基础脆弱性分析 | 🟡 | AVA 文档 + 威胁模型 | 建议第三方渗透测试 |

**就绪度合计**：✅ 11 项 ｜ 🟡 2 项（ADV_FSP.1、AVA_VAN.1 的第三方评定部分）｜ ❌ 1 项（ATE_IND.1 独立测试）。

> 注意：**"就绪"≠"通过"**。上表说明的是"材料齐不齐"，不是"实验室测没测"。

---

## 6. 本轮（v1.8.0）修复的差距

| 编号 | 差距 | 严重度 | 修复 | 验证 |
|---|---|---|---|---|
| D-01 | 响应缺少 `x-content-type-options: nosniff` 与 `referrer-policy: no-referrer`，存在浏览器把响应当别的类型解析的理论风险 | 中 | `src/runtime.ts` 新增冻结常量 `HARDENING_HEADERS` 与 `applyHardeningHeaders()`；`route()` 与 chart 路由均调用 | `tests/security-headers.test.ts`（4 项）+ 全量 187 项通过 |
| D-02 | 没有公开、可核验的漏洞报告渠道与响应时限 | 中 | 新增根目录 `SECURITY.md`：私密报告入口、时限承诺、攻击面、7 条威胁模型、部署建议、"不做/不宣称"清单 | 文件存在 + README 链接 |
| D-03 | 没有符合 ASE 结构的安全目标，无法回答"你到底保护什么" | 高 | 新增 `docs/cc/SECURITY-TARGET.md`（按 2026 版 7 个 ASE 族组织） | 与本报告 §4/§5 交叉引用一致 |
| D-04 | 没有依赖与供应链清单 | 中 | 新增 `docs/SBOM.md`（运行时 0 依赖 + 3 个开发依赖 + 1 个 vendored 文件，含 sha256） | 与 `package.json`、`package-lock.json` 一致 |

修复后回归：`npm run verify` → **187 tests / 187 pass / 0 fail**（2026-10-30，Node 见 CI 配置）。

---

## 7. 未修复的差距及原因（诚实清单）

| 编号 | 差距 | 为什么不修 | 影响 |
|---|---|---|---|
| N-01 | 无 CC 证书 | 需认可实验室评测 + 认证机构发证 + 费用与周期，非代码可解 | 不能对外宣称"通过/完全满足" |
| N-02 | 无独立实验室测试（ATE_IND.1） | 同上 | 测试结论仅为自测 |
| N-03 | 无第三方渗透测试（AVA_VAN.1 深度部分） | 需外部安全团队，本项目无预算 | 脆弱性分析为自评 |
| N-04 | 无形式化/半形式化功能规范（ADV_FSP 完整版） | 对 8 千行插件属过度投入；已用接口枚举 + 源码公开替代 | 材料强度低于正式 EAL1 要求 |
| N-05 | 无多租户隔离、无独立审计日志服务 | **设计边界**：插件运行在 DSH 会话内，认证与审计由 DSH 承担 | 多人共用场景必须依赖 DSH 侧配置 |

**这五条不会因为版本升级而消失**。它们被写在这里，是为了让每一个读到"国际标准"四个字的人，都能立刻看到边界在哪里。

---

## 8. 如果要真正拿证：EAL1 路线图（供参考）

| 阶段 | 做什么 | 谁做 | 常见周期（业界区间，非报价） |
|---|---|---|---|
| 0 | 完成 ST（把本文草案的 "no conformance claim" 改为实际主张） | 开发者 | 2–4 周 |
| 1 | 补 ADV_FSP/ADV_TDS 文档、CM 计划 | 开发者 | 2–6 周 |
| 2 | 选实验室，签合同，提交 TOE 与证据包 | 开发者 + 实验室 | 2–4 周 |
| 3 | 实验室执行 ATE_IND.1 与 AVA_VAN.1 | 实验室 | 4–12 周 |
| 4 | 认证机构评审发证 | 认证机构 | 4–12 周 |
| 5 | 证书维持（AMA） | 开发者 | 持续 |

周期与费用因国家体系（CCRA / EUCC / JISEC 等）差异很大，本文不给具体数字，避免误导。

---

## 9. 证据索引

| 证据 | 位置 | 复核方式 |
|---|---|---|
| 安全目标（ST 草案） | `docs/cc/SECURITY-TARGET.md` | 阅读，对照 §4 |
| 脆弱性分析 | `docs/cc/AVA-VULNERABILITY-ANALYSIS.md` | 阅读 + 运行 §10 命令 |
| 依赖清单 | `docs/SBOM.md` | 与 `package.json` 对比 |
| 安全策略与披露渠道 | `SECURITY.md` | 阅读 |
| 硬化响应头实现 | `src/runtime.ts`（`HARDENING_HEADERS`） | `grep -n HARDENING_HEADERS src/runtime.ts` |
| 硬化响应头测试 | `tests/security-headers.test.ts` | `npm run verify` |
| 全量测试结果 | 终端输出 | `npm run verify` |
| CI 流水线 | `.github/workflows/verify.yml` | 阅读 + GitHub Actions 运行记录 |
| 版本一致性 | `tests/version-sync.test.ts` | `npm run verify` |
| 发布记录 | npm `dsh-workplan`、GitHub Releases | `npm view dsh-workplan version` |

---

## 10. 复现方法（任何人可跑）

```bash
# 1) 取代码
git clone https://github.com/abbaababa/dsh-workplan.git
cd dsh-workplan

# 2) 装依赖（仅开发依赖）
npm ci

# 3) 一键复跑：类型检查 + 构建 + 全部测试
npm run verify
# 期望最后看到：tests 187 / pass 187 / fail 0

# 4) 复核"无危险 API"这一条
grep -RInE "child_process|execSync|eval\(|new Function|writeFileSync|appendFileSync|mkdirSync|https?\.request" src || echo "0 命中（预期）"

# 5) 复核硬化响应头
grep -n "x-content-type-options" src/runtime.ts
```

---

## 11. 声明与限制

1. 本报告是**开发者的自评估**，不是评估者报告（ETR），不构成任何认证结论。
2. 文中"✅/🟡/❌"仅表示**材料齐备度**，不表示安全性已获第三方验证。
3. 标准版本以 2026 年版为准；若官方文本有修订，以官方为准，本报告将随版本更新。
4. 本报告不构成对任何具体攻击的免疫承诺；漏洞请按 `SECURITY.md` 的渠道报告。
5. **本项目不会、也不应把"通过 ISO/IEC 15408"用作营销词**——除非将来真的拿到证书，届时证书编号会写在这一行。

---

*报告结束。任何一项结论都可在第 10 节用 5 条命令复核。*
