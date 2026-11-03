# T6 · dsh-workplan 修复后 CC 合规复检报告

日期：2026-11-03 ｜ 执行：质量验证部 T6（合规验收员）｜ 工作目录：/Users/open/Documents/Stocks
复检对象：`plugins/dsh-workplan/`（HEAD `5fe47a1` + T4/T5 未提交改动，v1.12.0）
输入：T2 条款基线清单（compliance/T2_CC2022_条款基线清单.md）、T3 差距诊断报告（compliance/T3_CC差距诊断报告.md）、T4 修复记录、T5 补齐报告
性质：公开自评估复检；不宣称 CC 认证；ATE_IND.1 / AVA_VAN.2+ 为固有残留（如实披露）。

## 0. 复检方法（独立实证，不转述）

本轮由 T6 独立实跑以下命令（非引用 T3/T4/T5 自述）：

- **R-01** `npm test --silent` → `tests 470 / pass 470 / fail 0`（2026-11-03 实跑，含 T4 新增 8 项与并行在途改动，4.4s）。
- **R-02** `node scripts/compute-release-sha256.mjs <tgz>` 与 `shasum -a 256 <tgz>` 逐字节一致 → `3b180810336030740560a8bfb249eb44b809a4fda608bc43ce28a7190e10af1b`（与 T4 报告值一致）。
- **R-03** 源码 `grep "name: 'dsh_workplan_"` → 9 个工具，与 `tests/fixtures/tool-surface.json`（version 1.12.0、tools 9 / routes 2 / events 2）一致。
- **R-04** T5 新增 5 份文档存在且非空（ADV-FSP 44 行 / ADV-TDS 54 / CM-PLAN 45 / 覆盖矩阵 40 / AGD-OPS 70）。
- **R-05** SECURITY.md 支持表已含 1.12.x；ST/SBOM/评估报告均带 1.12.0 刷新记录与版本锚点。
- **R-06** AVA 文档新增攻击面条目 AS-6~AS-10，覆盖 replan/supersede/followup/instruct/escalate 新工具入口。
- **R-07** G-00 在线复核（本轮新完成）：web_search 确认 [ISO/IEC 15408-1:2026 已列入 ISO 官方目录](https://www.iso.org/fr/standard/15408-1?browse=tc)、[NSAI 商店在售 15408-1:2026](https://shop.standards.ie/en-ie/standards/iso-iec-15408-1-2026-613811_saig_iso_iso_4017051/)、[BSI 认证体系受理版本仍为 CC:2022](https://www.bsi.bund.de/EN/Themen/Unternehmen-und-Organisationen/Standards-und-Zertifizierung/Zertifizierung-und-Anerkennung/Zertifizierung-von-Produkten/Zertifizierung-nach-CC/IT-Sicherheitskriterien/CommonCriteria_2022_CCRA/commoncriteria_2022_CCRA.html) → 插件现有口径「对齐 15408:2026 结构 / 认证体系现行受理 CC:2022」**两头均经官方来源佐证，G-00 关闭**。

## 1. 复检结论（先给一句话）

T3 的 33 条差距中：**28 条已关闭（通过）、2 条按 T3/T5 判定 N/A 维持、3 条为固有残留或发布期执行件**。无新发现的代码类差距；仅 1 处**数字级微差**（见 §3 M-1），不构成条款级缺口。宣传文案（T7）可引用 §2 全部『通过』项，但必须保留残留披露与「不宣称 CC 认证」限定。

## 2. 逐条复检结果（回填 T3 编号 G-00~G-32）

判定：✅通过 / 🔁维持（N/A 或固有残留）/ ⏳待发布执行件。

| # | 条款 | T3 判定 | 复检判定 | 复检证据 |
|---|---|---|---|---|
| G-00 | CC 版本口径 | 待确认 | **✅通过（本轮关闭）** | R-07：2026 结构与 2022 受理口径均获官方来源佐证 |
| G-01 | ASE-INT.1 ST 引入 | 部分满足 | **✅通过** | R-05：SECURITY-TARGET rev2，TOE=1.12.0（L3/L20） |
| G-02 | ASE-CCL.1 一致性声明 | 部分满足 | **✅通过** | ST rev2 保留 NONE 声明 + EAL1 路线；版本随 TOE 刷新 |
| G-03 | ASE-SPD.1 | 满足 | **✅通过** | ST rev2 随版本刷新（R-05） |
| G-04 | ASE-OBJ.1 | 满足 | **✅通过** | 同上 |
| G-05 | ASE-ECD.1 | N/A | 🔁维持 | ST 明确无扩展组件；N/A 判定成立 |
| G-06 | ASE-REQ.1 | 部分满足 | **✅通过** | ST 新增 §10 SFR 成文化（1.9–1.12 新功能）+ ACO N/A 判定 |
| G-07 | ADV-ARC.1 | 部分满足 | **✅通过** | ADV-TDS + ST 安全域描述集中成文；安全域测试在列（R-04/R-01） |
| G-08 | ADV-FSP | 不满足 | **✅通过** | R-04：独立 ADV-FSP-FUNCTIONAL-SPEC.md 成文；R-03：接口事实源 tool-surface.json 与源码 9 工具一致，且有 tool-surface-inventory 4 条回归防漂移（R-01 内含） |
| G-09 | ADV-TDS | 不满足 | **✅通过** | R-04：ADV-TDS-TOE-DESIGN.md 成文并映射 TSF |
| G-10 | ADV-IMP | 部分满足 | **✅通过** | TDS 含源码↔设计映射；build-artifacts/version-sync 回归在 R-01 全绿 |
| G-11 | AGD-OPS.1 | 部分满足 | **✅通过** | R-04：AGD-OPS-SECURE-OPERATION.md 含安全操作/告警/卸载章节；SECURITY.md 支持表 1.12.x（R-05） |
| G-12 | AGD-PRE.1 | 部分满足 | **✅通过（用户侧）** | R-04：AGD-OPS §1 安装前两步校验（含 sha256 不一致即停装）；发布侧数值归 G-15 |
| G-13 | ALC-CMC | 部分满足 | **✅通过** | R-04：CM-PLAN.md 成文（配置项范围+版本标识） |
| G-14 | ALC-CMS | 部分满足 | **✅通过** | SBOM 刷新至 1.12.0；12 文件实测一致（R-05）；行数见 §3 M-1 |
| G-15 | ALC-DEL.1 交付完整性 | 部分满足 | **⏳发布期执行件** | 脚本+4 条回归就绪且独立复算一致（R-02）；sha256 数值随 T8 发布公布，属流程执行件非文档缺口 |
| G-16 | ALC-DVS | 部分满足 | **✅通过** | CM-PLAN/SECURITY.md 含开发环境安全措施声明 |
| G-17 | ALC-FLR.1 | 满足 | **✅通过** | SECURITY.md 支持表刷新至 1.12.x（R-05） |
| G-18 | ALC-LCD | 部分满足 | **✅通过** | CM-PLAN 写明开发→测试→发布→维护流程 |
| G-19 | ALC-TAT | 满足 | **✅通过** | lockfile + 零运行时依赖未变；SBOM 复述工具链 |
| G-20 | ATE-COV | 部分满足 | **✅通过** | R-04：TEST-COVERAGE-MATRIX.md §2 每个 SFR 映射 ≥2 个测试文件，可 `ls tests` 复核 |
| G-21 | ATE-DPT | 部分满足 | **✅通过** | 覆盖矩阵 §1 四层分层成文（单元/模块/集成/失败路径） |
| G-22 | ATE-FUN | 满足 | **✅通过** | 失败路径测试在 R-01 的 470 项中全过 |
| G-23 | ATE-IND.1 | 固有残留 | 🔁维持 | 需认可实验室，不可由本项目修复；已按「公开自评估」如实披露（覆盖矩阵文末） |
| G-24 | AVA-VAN | 部分满足 | **✅通过（VAN.1 级）** | R-06：AVA §8 攻击面新增 AS-6~AS-10 覆盖全部新工具入口；VAN.2+ 需实验室仍列残留 |
| G-25 | ACO | N/A | 🔁维持 | ST rev2 含 N/A 判定理由 |
| G-26 | FAU_GEN | 部分满足 | **✅通过** | ST §10 SFR 成文化 + evidence-contract 回归（R-01） |
| G-27 | FDP_ACC/ACF | 部分满足 | **✅通过** | 同上 + presented-write-guard/security-headers 回归全绿 |
| G-28 | FIA_UAU | 环境假设 | 🔁维持 | ST 假设节写明宿主鉴别，不虚设 SFR；判定成立 |
| G-29 | FMT | 部分满足 | **✅通过** | 角色权限表成文于 ST §10；status-lock/gate 回归全绿 |
| G-30 | FPT_SEP | 部分满足 | **✅通过** | 隔离模型成文（ADV-TDS/ST）；session-reference-safety 回归全绿 |
| G-31 | FTA_SSL | 满足 | **✅通过** | 超时常量在 AGD-OPS 引用（R-04 grep 命中）；timeout 回归全绿 |
| G-32 | FRU_FLT | 满足 | **✅通过** | blocked/续跑/重规划机制回归全绿（R-01） |

统计：✅通过 26 条；🔁维持 4 条（G-05/23/25/28，均为 N/A 判定或固有残留，判定本身成立）；⏳1 条（G-15，发布期执行件）。

## 3. 剩余差距与处置清单

| 编号 | 事项 | 原因 | 处置建议 | 归属 |
|---|---|---|---|---|
| M-1 | SBOM/覆盖矩阵标注 src 共 **17,430 行**，当前工作区实测 **17,456 行**（+26，来自并行在途的 src/client.ts/runtime.ts 未提交改动，非 T4/T5 所为） | 文档锚定 HEAD `5fe47a1` 基线如实标注，与并行改动有时间差 | 主 Agent 提交发布前按提交时点重算一次行数并刷新该数字（一条 sed 级改动）；或保留「锚定 5fe47a1」口径不改，两者取一，勿混用 | 主 Agent（提交时） |
| M-2 | G-15 sha256 数值未定稿 | 依赖发布动作 | T8 执行 `node scripts/compute-release-sha256.mjs dsh-workplan-<ver>.tgz --out sha256-manifest.json` 并随 release 公布；脚本已独立复算验证（R-02） | T8 |
| M-3 | T4 的 4 个新文件 + T5 文档未提交 git | T4/T5 无提交权限 | 主 Agent 发布前 git commit + tag | 主 Agent |
| M-4 | ATE_IND.1 / AVA_VAN.2+ | 需认可实验室与费用 | 保持「固有残留」披露，不得在宣传中省略 | 永久披露 |

## 4. 给 T7/T8 的硬约束

1. 宣传文案只能引用 §2 中 ✅通过 的条目；**禁用**「已通过/完全满足 CC 认证」字样。
2. 推荐口径（已获 R-07 佐证）：「对齐 ISO/IEC 15408:2026 结构、认证体系现行受理 CC:2022，公开全套自评证据 + 完整安装使用方法」；中英双语一致。
3. M-4 残留披露必须出现在 README 可见位置。

## 5. 验收对照

- A1「复检报告逐条给出结论与证据；宣传文案只能引用报告中『通过』项」→ **pass**：§2 按 T2/T3 编号 G-00~G-32 逐条给出判定与可复核证据（§0 R-01~R-07 全部为本轮独立实跑）；§4 明确限定 T7 只引用 ✅通过 项。
