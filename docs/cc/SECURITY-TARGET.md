# 安全目标（Security Target）— dsh-workplan v1.8.0

**文件性质：按 ISO/IEC 15408-3:2026 ASE 类结构编写的 ST 草案 / ST draft structured per ISO/IEC 15408-3:2026 class ASE.**

> ## ⚠ 符合性主张：无 / Conformance claim: NONE
>
> 本文件**不主张**符合 ISO/IEC 15408（CC）。它是一个**自评估草案**，用于：
> 1. 把"这个插件到底保护什么"写成可被检查的文字；
> 2. 为将来可能的正式评估提供可直接修改的底稿。
>
> 本插件**没有**经过任何认可实验室（ISO/IEC 18045 / CEM）评测，**没有**任何认证体系签发的证书。
> 文中"满足"一律指"本实现符合本文自述的要求"，**不是**"经第三方验证"。
>
> This document makes **no** CC conformance claim. It is a self-assessment draft. The TOE has **not** been evaluated by an accredited laboratory under ISO/IEC 18045 and holds **no** certificate. "Meets" below means "the implementation matches what this document states", not "independently verified".

| 字段 | 值 |
|---|---|
| ST 标识 | `dsh-workplan-ST-1.8.0`（草案 rev 1） |
| TOE 标识 | `dsh-workplan` 插件 1.8.0，npm 包 `dsh-workplan@1.8.0` |
| 依据 | ISO/IEC 15408-1/-2/-3:2026 |
| 目标保证等级 | 无（若将来评估，拟选 **EAL1**） |
| 日期 | 2026-10-30 |

---

## 1. ASE_INT — ST 引言

### 1.1 ST 引用
见上表。本 ST 随插件版本发布，版本号与 `package.json` 由测试强制同步。

### 1.2 TOE 引用
`dsh-workplan@1.8.0`。分发渠道：npm 公共注册表；源码：<https://github.com/abbaababa/dsh-workplan>。

### 1.3 TOE 概述
`dsh-workplan` 是 DeepSeek Harness（DSH）的一个插件。它让 AI 在**动手之前**先把任务拆成阶段和子任务，把计划显示给用户，再按计划派发子代理，并把每个子任务的结果、验证状态与证据写回会话。

用大白话说：**它是给 AI 装的一个"先写施工图、再动工、干完对账"的流程锁。**

### 1.4 TOE 描述

**物理/逻辑构成**（TOE 边界内）：

| 部件 | 文件 | 职责 |
|---|---|---|
| 宿主运行时 | `src/runtime.ts`（2384 行） | 计划生成与派发、子代理看门狗、HTTP 路由与鉴权、状态写入 |
| 插件入口 | `src/host.ts` | 注册 2 条 HTTP 路由、4 个模型工具、配置 schema、版本元数据 |
| 浏览器面板 | `src/client.ts`（2881 行）→ `client.js` | 同源拉取计划数据并渲染面板（含图表） |
| 计划模型 | `src/plan.ts`（2158 行） | 计划结构、校验、统计派生 |
| 看门狗 | `src/watchdog.ts`（207 行） | 子代理超时与预算控制 |
| 随包第三方 | `vendor/chart.umd.js` | Chart.js 4.6.1（MIT），本地分发 |

**外部接口（TSF 接口，完全枚举）**：

| 接口 | 类型 | 方向 | 说明 |
|---|---|---|---|
| `/dsh-workplan/plans` | HTTP GET/HEAD | 入 | 返回当前会话计划 JSON；非 GET/HEAD 返回 405 |
| `/dsh-workplan/vendor/chart.umd.js` | HTTP GET/HEAD | 入 | 返回随包固定的图表库静态文件；路径为常量，非 GET/HEAD 返回 405；**不经 `connection.requestRejection`**（公开静态资源，无用户数据，风险已声明于本文件 §9） |
| `dsh_workplan_dispatch` | 模型工具 | 双向 | 派发计划；plan 模式下被 guard 拒绝 |
| `dsh_workplan_status` | 模型工具 | 双向 | 只读查询进度 |
| `dsh_workplan_update` | 模型工具 | 双向 | 更新子任务状态，需 `expectedRevision` |
| `dsh_workplan_cancel` | 模型工具 | 双向 | 取消未派发/等待中的计划 |

**不在 TOE 内**：DSH 本体（身份认证、会话存储、模型推理）、Node.js 运行时、操作系统、浏览器。

**TOE 运行所需但自身不提供的能力**：身份认证与访问控制（由 DSH 的 `connection.requestRejection` 提供）。

---

## 2. ASE_CCL — 符合性主张

| 项目 | 内容 |
|---|---|
| CC 符合性 | **不主张 / no claim** |
| 保护轮廓（PP）符合性 | **不主张**符合任何 PP（含 ISO/IEC 15408-5:2026 预定义 PP） |
| 包（Package）符合性 | **不主张**符合任何 EAL 包；EAL1 仅为将来评估的拟选目标 |
| 方法符合性 | 本文结构与术语参照 ISO/IEC 15408-3:2026，但未经 CEM 评估 |

**为什么这么写**：CC 的符合性主张必须由评估者验证后才成立。开发者先行"主张"而不经评估，等同于虚假陈述。因此本 ST 保留结构、放弃主张。

---

## 3. ASE_SPD — 安全问题的定义

### 3.1 威胁（Threats）

| 编号 | 威胁 | 攻击者能力假设 |
|---|---|---|
| **T-01 未授权读取** | 未通过 DSH 鉴权的请求读到会话计划内容 | 能向本机端口发 HTTP 请求 |
| **T-02 数据外泄** | 插件把计划内容/会话信息发往第三方 | 能诱导插件发起出站请求 |
| **T-03 注入与路径穿越** | 构造请求使插件执行代码或返回边界外文件 | 能构造任意请求路径与方法 |
| **T-04 状态篡改** | 非主代理方修改子任务状态，使"已完成"失真 | 能调用模型工具或并发写入 |
| **T-05 资源耗尽** | 超长计划或永不返回的子代理拖死会话 | 能构造超大计划或让子代理挂起 |
| **T-06 供应链投毒** | 第三方依赖被植入恶意代码 | 能控制某个上游包或其发布渠道 |
| **T-07 虚假完成报告** | 子任务未完成却报告完成，误导运维者决策 | AI 自身产生幻觉或过度乐观的自述 |

> T-07 是本 TOE 区别于一般工具的关键威胁：这里的"攻击者"是**模型自己**。

### 3.2 假设（Assumptions）

| 编号 | 假设 | 若不成立 |
|---|---|---|
| **A-01** | 运行环境（DSH）对每次 HTTP 请求执行身份认证与访问控制，并通过 `connection.requestRejection` 返回拒绝决定 | T-01 无法缓解，必须由部署方补齐反向代理鉴权 |
| **A-02** | TOE 部署在受信主机、面向受信运维者；不假设多租户隔离 | 多人共用场景需 DSH 侧额外隔离 |
| **A-03** | 运行于受支持的 Node.js（≥22）与受支持的浏览器 | 行为可能异常 |

### 3.3 组织安全策略（OSPs）

| 编号 | 策略 | 理由 |
|---|---|---|
| **P-01** | TOE **不得**主动向外部网络发送任何数据 | 计划内容含任务与代码上下文，属敏感信息 |
| **P-02** | TOE **应**保持零运行时第三方依赖 | 减小 T-06 攻击面，便于审计 |
| **P-03** | TOE 的每次状态变更**应**可在会话记录中追溯 | 支撑 T-04、T-07 的发现与追责 |

---

## 4. ASE_OBJ — 安全目标

### 4.1 TOE 的安全目标

| 编号 | 目标 | 对应威胁/策略 |
|---|---|---|
| **O-01 访问受控** | 只有通过环境鉴权的请求才能获得计划数据 | T-01, A-01 |
| **O-02 无出站数据流** | TOE 代码不发起任何对外网络请求；浏览器仅同源请求 | T-02, P-01 |
| **O-03 输入与方法受约束** | 路由为精确匹配；非 GET/HEAD 一律 405；静态文件路径写死 | T-03 |
| **O-04 写入受控** | 状态写入需携带匹配的 `expectedRevision`，不匹配即失败 | T-04, P-03 |
| **O-05 资源有界** | 子代理超时、总预算上限、响应体超过 2.5 MB 截断 | T-05 |
| **O-06 供应链最小化** | 运行时零依赖；唯一第三方文件随包固定并记录哈希 | T-06, P-02 |
| **O-07 进度可验证** | 完成声明必须附证据与验收分级；`structured` 之外不得直接采信 | T-07, P-03 |

### 4.2 环境的安全目标

| 编号 | 目标 | 责任方 |
|---|---|---|
| **OE-01 认证与授权** | 对每个 HTTP 请求做身份判定并拒绝未授权请求 | DSH |
| **OE-02 会话完整存储** | 保证会话记录不被外部静默改写 | DSH |
| **OE-03 传输保护** | 若跨主机访问，由部署方提供 TLS | 部署方 |

---

## 5. ASE_ECD — 扩展组件定义

**本 ST 不使用任何扩展组件（extended components）。**

全部安全功能要求均取自 ISO/IEC 15408-2:2026 已定义组件；仅使用标准允许的操作（赋值 assignment、精化 refinement、选择 selection）做适配，并在 §6 中逐条标注。

---

## 6. ASE_REQ — 安全功能要求

共 **5 个功能要求族 / 8 个组件**。每条给出：标准组件 → 本 TOE 的赋值/精化 → 理由。

### 6.1 信息流控制（FDP_IFC / FDP_IFF）

**FDP_IFC.1 子集信息流控制**
TOE 应强制执行以下信息流控制策略：*受保护的计划数据只能流向同源的、经环境鉴权的 HTTP 响应与浏览器面板。*
- 赋值：受控主体 = {宿主运行时, 浏览器面板}；受控信息 = {计划数据、子任务结果、证据}；受控操作 = {HTTP 响应, 模型工具返回}。
- 理由：直接支撑 O-02，对抗 T-02。

**FDP_IFF.1 简单安全属性**
TOE 应基于以下属性允许信息流：请求同源、方法 ∈ {GET, HEAD}、环境鉴权通过。
- 适用范围：携带受保护计划数据的 `/dsh-workplan/plans`。`/dsh-workplan/vendor/chart.umd.js` 返回的是不含任何会话数据的固定第三方库文件，其信息流属性为「同源 + 方法 ∈ {GET, HEAD}」，不含鉴权属性（见 §9 残余风险）。
- 理由：把"谁能看"变成可判定的布尔条件，而非策略口号。

### 6.2 识别（FIA_UID）

**FIA_UID.1 识别时机**
TOE 应在执行任何数据返回操作**之前**，依赖环境完成识别并取得允许/拒绝决定。
- 精化：TOE 不自行实现用户库，而是调用 `connectionCtx.connection.requestRejection(req)`，并在其返回拒绝时终止处理。
- 理由：O-01 + A-01；避免重复造认证轮子。

### 6.3 功能管理（FMT_MOF / FMT_SMF / FMT_SMR）

**FMT_MOF.1 安全功能行为的管理**
TOE 应仅允许主代理（Lead）通过 `dsh_workplan_dispatch / update / cancel` 改变计划状态；只读查询不得改变状态。
**FMT_SMF.1 安全管理功能规范**
TOE 应提供：查看计划、派发计划、更新子任务状态与证据、取消计划，共 4 项管理功能。
**FMT_SMR.1 安全角色**
TOE 应区分两个角色：主代理（可写）与浏览器观察者（只读，仅能 GET/HEAD）。
- 理由：O-04 + P-03，对抗 T-04。

### 6.4 审计（FAU_GEN）

**FAU_GEN.1 审计数据生成**
TOE 应在以下事件发生时生成可追溯记录：计划创建、派发开始、子任务完成（含 verification 与 acceptance）、派发取消、状态写入被 `STALE_WRITE` 拒绝。
- 赋值：记录载体 = DSH 会话事件与工具返回值（TOE 不另建日志文件）。
- 理由：P-03，支撑 T-04/T-07 的事后追责。

### 6.5 TSF 自测试（FPT_TST）

**FPT_TST.1 TSF 自测试**
TOE 应提供可重复执行的自测试，覆盖：计划模型校验、派发与取消语义、看门狗超时、预算与恢复、版本一致性、安全响应头、路由方法约束的源码级断言。

- 赋值：测试套件 = `npm run verify`（31 个文件 / 188 项测试，CI 每次提交执行）。
- **已知缺口（如实记录，不掩饰）**：`route()` 内部的鉴权分支（401/403）、405 分支与 2.5 MB 截断分支目前**没有**逐分支自动化用例，只有源码级断言（`tests/security-headers.test.ts` 断言加固头被注册、图表路由的 405 与方法限制存在）。补这些用例需要构造 DSH `connection` 桩件，属于待办而非已完成项，故本节不把「鉴权分支、方法限制、响应截断」列为已覆盖。
- 理由：O-05、O-07 的可复现证据来源；对应 ATE 类的自测部分。

---

## 7. ASE_TSS — TOE 安全功能规格（实现如何做到）

| 要求 | 实现位置 | 具体做法 | 复核命令 |
|---|---|---|---|
| FDP_IFC.1 / FDP_IFF.1 | `src/runtime.ts` `route()`、`src/host.ts` | 仅注册 2 条 `exact` 路由；两条都只答 GET/HEAD（其余 → 405）；`/plans` 响应带 `cache-control: no-store` | `grep -n "no-store" src/runtime.ts; grep -n "405" src/host.ts` |
| FDP_IFC.1（无出站） | 全仓 | 除浏览器同源 `fetch('/dsh-workplan/plans')` 外无任何网络调用 | 见 §8 扫描命令 |
| FIA_UID.1 | `src/runtime.ts` `route()` 开头（仅 `/plans`） | 先 `await connectionCtx.connection.requestRejection(req)`，拒绝则直接返回；图表路由不调用（公开静态资源） | `grep -n requestRejection src/runtime.ts src/host.ts` |
| FMT_MOF.1 / FMT_SMF.1 | `src/host.ts` 工具注册 | 4 个工具；`update` 强制 `expectedRevision`，不匹配返回 `STALE_WRITE`；plan 模式下 `dispatch` 被 guard 拒绝 | `grep -n "expectedRevision" src/*.ts` |
| FMT_SMR.1 | 同上 + 路由 | 浏览器角色只能 GET/HEAD；写操作只能经模型工具 | 同 FMT_MOF.1 |
| FAU_GEN.1 | 会话事件 + 工具返回值 | 每次派发/完成/取消/拒绝均落会话事件，含证据字段 | 阅读 `dsh_workplan_status` 返回结构 |
| FPT_TST.1 | `tests/` + `npm run verify` | 31 文件 188 项；CI 每次提交执行 | `npm run verify` |
| O-05 资源有界 | `src/runtime.ts`、`src/watchdog.ts` | 响应 > 2.5 MB 截断；子代理与总预算双超时且被夹紧 | `grep -n "2_500_000" src/runtime.ts` |
| O-02/O-03 硬化头 | `src/runtime.ts` `HARDENING_HEADERS` | `x-content-type-options: nosniff`、`referrer-policy: no-referrer` | `grep -n HARDENING_HEADERS src/runtime.ts` |
| P-02 零运行时依赖 | `package.json` | `dependencies` 为空对象 | `npm ls --omit=dev` |

**为什么这些证据够"基本"**：EAL1 只要求"功能规范可理解 + 独立测试通过"，不要求形式化证明。上表把每个安全要求落到**一行可执行的 grep/命令**，使读者无需信任本文即可自行核对。

---

## 8. 复核方法（任何人可执行）

```bash
git clone https://github.com/abbaababa/dsh-workplan.git && cd dsh-workplan
npm ci
npm run verify            # 期望：tests 188 / pass 188 / fail 0

# 无危险 API
grep -RInE "child_process|execSync|eval\(|new Function|writeFileSync|appendFileSync|mkdirSync|https?\.request" src || echo "0 命中（预期）"

# 无出站请求（唯一命中应为浏览器同源 fetch）
grep -RIn "fetch(" src

# 鉴权、硬化头、截断、乐观锁
grep -n "requestRejection\|HARDENING_HEADERS\|2_500_000\|expectedRevision" src/runtime.ts src/host.ts
```

---

## 9. 声明的边界

1. 本 ST 是**草案**，未经评估者评审，不构成任何符合性结论。
2. §6 的 SFR 为**自选**，用于把实现约束写成可检查的条款；不是对任何 PP 的符合性声明。
3. §7 的"实现如何做到"仅覆盖本文列出的要求，不覆盖 DSH 本体、Node.js、OS 的安全属性。
4. 发现本文件与实现不一致时，**以实现与测试为准**，并按 `SECURITY.md` 渠道报告——这本身也是 T-07（虚假完成）在本项目上的应用。
5. **已声明的残余风险 R-07**：`/dsh-workplan/vendor/chart.umd.js` 不调用 `connection.requestRejection`，任何人只要能连到 DSH 端口就能读到这个固定文件（Chart.js 4.6.1，MIT，210078 字节，sha256 见 `docs/SBOM.md`）。它不含任何会话数据，读走它不泄露任何用户信息；它的存在本身也不构成秘密。若你的部署要求"任何响应都必须先鉴权"，请在前置反向代理上统一拦截 `/dsh-workplan/*`。
6. **已声明的测试缺口**：`route()` 的鉴权拒绝分支、405 分支、响应截断分支没有逐分支自动化用例（见 §6.5）。这些行为目前由代码阅读与源码级断言支撑，不是由测试支撑；补测需要构造 DSH `connection` 桩件。
