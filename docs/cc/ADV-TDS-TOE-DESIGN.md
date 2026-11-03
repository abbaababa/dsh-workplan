# TOE 设计（ADV_TDS.1 对齐）／ TOE Design

> 对象：dsh-workplan v1.12.0 ｜ 基线：git HEAD `5fe47a1` ｜ 日期：2026-11-03 ｜ 撰写：T5
> 性质：公开自评估文档，非认证证据；不宣称 CC 证书。

## 0. 覆盖的差距编号

G-09（无独立 TOE 设计文档）、G-10（源码↔设计映射）。核对方法：`wc -l src/*.ts`（合计 17,430 行，2026-11-03 实测）。

## 1. 模块结构 / Module structure

TS 源码共 **12 个文件（11 个模块 + globals.d.ts）**，合计 17,430 行：

| 模块 | 行数 | 职责 | 是否含 TSF（安全功能） |
|---|---|---|---|
| `src/plan.ts` | 3820 | 计划数据模型与状态机 | 是（状态与完成判据） |
| `src/runtime.ts` | 6071 | 执行编排：调度、子会话生命周期、状态回写、HTTP 服务与加固头 | 是 |
| `src/host.ts` | 1278 | 9 个工具的宿主侧定义与提示词规则（15 分钟/步、20 分钟预算条款） | 是 |
| `src/client.ts` | 3367 | 面板前端渲染 | 否 |
| `src/replan.ts` | 708 | 需求变更重规划（cancel/replace/add） | 是 |
| `src/understanding.ts` | 901 | 结果理解与核对辅助 | 否 |
| `src/supersede.ts` | 429 | 跨计划取代（V1–V8 复算） | 是 |
| `src/supersede-digest.ts` | 116 | 取代摘要 | 否 |
| `src/auto-resume.ts` | 275 | 自动续跑策略 | 是（容错） |
| `src/watchdog.ts` | 207 | 看门狗/卡死检测 | 是（容错） |
| `src/departments.ts` | 244 | 部门枚举 | 否 |
| `src/globals.d.ts` | 14 | 类型声明 | 否 |

## 2. 安全域隔离（FPT_SEP 成文化，兼答 G-07/G-30）／ Security domains

```
┌─ 宿主环境（已鉴别，TOE 假设 A-1）
│  ┌─ TOE：主 Agent 会话 ── 9 个工具 + 提示词规则 + 交付门禁
│  │    └─ 子 Agent 会话 × N（独立上下文、独立工作目录，凭 dsh_workplan_escalate 上报）
│  └─ 面板：GET /dsh-workplan/plans（只读，加固响应头）
└─ 文件沙箱：DSH file policy 限定可写范围（workspace-write 等）
```

边界规则：子 Agent 不能派发、不能安装服务、权限在启动时固化；`tests/session-reference-safety.test.ts` 与 `tests/workplan-presented-write-guard.test.ts` 回归守护该边界。host 工具超时 > 计划预算（`src/host.ts` L1019–1023），保证不会出现“工具还在跑、预算已判死”的竞态。

## 3. TSF 与模块映射（兼答 G-26/27/29/30/31/32 成文化）

| TSF（SFR） | 实现位置 | 回归测试 |
|---|---|---|
| FAU_GEN 审计留痕 | runtime 状态回写 + 证据契约（WORKPLAN_EVIDENCE 块） | workplan-evidence-contract |
| FDP_ACC/ACF 访问控制 | DSH file policy + presented-write-guard | workplan-presented-write-guard、session-reference-safety |
| FMT_MOF/MSA 安全管理 | deliveryReady 门禁 + status-lock + 仅根会话可 handoff | workplan-status-lock、delivery-gate、present-gate-evidence |
| FPT_SEP 域隔离 | 子会话隔离模型（§2） | session-reference-safety、security-headers |
| FTA_SSL 会话超时 | host.ts 硬上限/预算常量，env 可覆盖 | timeout-artifact-evidence |
| FRU_FLT 容错 | auto-resume、watchdog、blocked/重规划留档 | auto-resume-policy、workplan-stuck-recovery、workplan-auto-retry |

## 4. 构建与实现表示（ADV_IMP 补充）

源码即发布物：`npm run build` 产出 `lib/`、`dist/`；`tests/build-artifacts.test.ts` 校验构建产物一致性，`tests/version-sync.test.ts` 校验版本号五处同步（package.json / CHANGELOG / 文档等）。无打包混淆、无外部代码注入点。
