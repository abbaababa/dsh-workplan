# 安全策略 / Security Policy

> 本文件是 `dsh-workplan` 的安全入口：**能做什么、边界在哪、出了问题怎么报、哪些话我们不说**。
> This file is the security entry point for `dsh-workplan`: what it can do, where the boundary is, how to report a problem, and **what we do not claim**.

---

## 1. 一句话说清底线 / The honest bottom line

**中文**：本插件按 ISO/IEC 15408（通用准则，Common Criteria，简称 CC）**2026 年版**的文档结构与证据要求做了公开自评估，并把能补的差距补齐了。但 **CC 符合性不是软件自己说了算的**：它必须由具备资质的实验室按 ISO/IEC 18045（CEM）评测、再由一个国家/地区认证体系签发证书。**本插件没有 CC 证书，因此我们不宣称"已通过/完全满足 ISO/IEC 15408"。** 我们宣称的是可被任何人复核的事实：文档结构、证据、测试与修复记录全部公开。

**English**: This plugin carries a public self-assessment aligned to the **2026 edition** of ISO/IEC 15408 (Common Criteria, CC) — its documentation structure and evidence expectations — and closes the gaps it could close. But **CC conformance is not something software declares about itself**: it requires evaluation by an accredited laboratory under ISO/IEC 18045 (CEM) and a certificate issued by a national scheme. **This plugin has no CC certificate, so we do not claim it "passes" or "fully satisfies ISO/IEC 15408".** What we claim is checkable: the structure, the evidence, the tests and the fix record are all public.

完整评估见 [docs/cc/CC-2026-ASSESSMENT.md](docs/cc/CC-2026-ASSESSMENT.md)，安全目标（ST 草案）见 [docs/cc/SECURITY-TARGET.md](docs/cc/SECURITY-TARGET.md)。

---

## 2. 支持范围 / Supported versions

| 版本 | 安全修复 | 说明 |
|---|---|---|
| 1.8.x | ✅ 接收 | 当前发布线 |
| ≤ 1.7.x | ❌ 不再单独修复 | 建议升级到 1.8.x |

只维护 npm `latest` 指向的版本线；升级命令见 [README.md](README.md)。

---

## 3. 报告漏洞 / Reporting a vulnerability

**请不要开公开 issue。** 公开 issue 等于把攻击方法贴在门口。

- 首选：GitHub 私密漏洞报告 <https://github.com/abbaababa/dsh-workplan/security/advisories/new>
- 备选：发邮件到仓库维护者邮箱（见 `git log -1 --format=%ae`）

请在报告里给出：版本号、复现步骤、影响、以及你认为的严重程度。

**我们对时间的承诺（尽力而为，非法律承诺）**：

| 阶段 | 目标 |
|---|---|
| 确认收到 | 7 天内 |
| 初步判断（是否成立、严重度） | 14 天内 |
| 修复或缓解方案 | 30 天内（高危优先） |
| 公开致谢 | 修复发布后，除非你要求匿名 |

---

## 4. 攻击面：这个插件到底能被怎么碰 / Attack surface

插件只在 DSH Web 进程中跑，暴露面只有两条路由和四个模型工具：

| 入口 | 方法 | 谁能到 | 鉴权 |
|---|---|---|---|
| `/dsh-workplan/plans` | GET / HEAD | 浏览器 | 走 DSH 的 `connection.requestRejection`，未通过返回 401/403 |
| `/dsh-workplan/vendor/chart.umd.js` | GET / HEAD | 浏览器 | **不鉴权**：随包固定的公开静态资源（MIT 图表库），不含任何用户数据；非 GET/HEAD 返回 405 |
| `dsh_workplan_dispatch` 等 4 个工具 | 模型调用 | 仅主 Agent | plan 模式下 `dispatch` 被 guard 拒绝；写入带 `expectedRevision` 乐观锁 |

**没有的东西（可自行 grep 复核）**：

```bash
grep -RInE "child_process|execSync|eval\(|new Function|writeFileSync|appendFileSync|mkdirSync|https?\.request" src   # 应无命中
```

- 零第三方**运行时**依赖（`dependencies` 为空）。
- 不写用户磁盘：结果只进 DSH 会话记录。
- 不外发数据：唯一的 `fetch` 是浏览器请求**同源**的 `/dsh-workplan/plans`。
- 图表库 Chart.js 4.6.1（MIT）随包分发，不加载 CDN。

> **两条路由的鉴权是不一样的，这里明说**：`/dsh-workplan/plans`（带数据的那个）在每个请求上先问 DSH 的 `connection.requestRejection`，未通过就 401/403；`/dsh-workplan/vendor/chart.umd.js`（一个固定文件）**没有**这一步，它公开可读、内容固定、路径写死、只答 GET/HEAD。这是设计选择，不是漏配：图表库挂了面板只是少一张图，而数据接口必须挡。
>
> 复核命令（两条都会给出可观察输出）：
>
> ```bash
> # 1) 数据接口：方法限制 + 鉴权调用都在
> grep -n "requestRejection\|allow: 'GET, HEAD'" src/runtime.ts
> # 2) 静态资源：只有方法限制，没有 requestRejection
> awk '/vendor\/chart.umd.js/,/^        },/' src/host.ts | grep -n "405\|requestRejection"
> ```

---

## 5. 威胁模型（简版）/ Threat model

| 威胁 | 场景 | 现有对策 | 证据 |
|---|---|---|---|
| 未授权读取 | 别人直接访问面板接口 | 依赖 DSH 会话鉴权，未通过即拒绝 | `src/runtime.ts` `route()` 的 `requestRejection` |
| 数据外泄 | 插件把计划内容发给第三方 | 源码无对外请求；同源 only | `grep` 证据见上 |
| 注入 / 路径穿越 | 构造请求读出别的文件 | 路由是 `exact` 精确匹配，静态文件路径写死 | `src/host.ts` `webServer.register({kind:'exact'})` |
| 状态被篡改 | 子 Agent 或别处改计划状态 | 写入需 `expectedRevision`，不匹配返回 `STALE_WRITE` | `dsh_workplan_update` 契约 |
| 资源耗尽 | 超长计划 / 永不返回的子 Agent | 子 Agent 与总预算双超时；响应超过 2.5 MB 截断 | `watchdog.ts`；`route()` 截断分支 |
| 供应链 | 依赖被投毒 | 零运行时依赖；唯一的第三方文件是 vendored Chart.js | `package.json`、`vendor/` |
| **虚假完成** | 报告说"做完了"其实没做 | `verification`/`acceptance` 分级，`structured` 才可直接采信 | 系统提示词契约 + `workplan-evidence-contract.test.ts` |

第 7 条是这个插件最特别的一条：它防备的不是外部攻击者，而是**AI 自己编造进度**。

---

## 6. 部署建议 / Deployment guidance

| 场景 | 建议 |
|---|---|
| 本机单人用（默认） | 保持默认，DSH 默认只监听本机 |
| 局域网 / 多人共用 | 必须在 DSH 侧开启身份认证与访问控制；本插件**不自带**多租户隔离 |
| 反向代理暴露到公网 | 必须加 TLS + 认证；面板接口会返回计划正文，等同会话内容 |
| 生产环境 | 固定版本号安装，不要用浮动版本 |

---

## 7. 我们不做的声明 / Claims we do NOT make

为避免误读，逐条写死：

1. ❌ 本插件**没有** CC 证书，也**没有**通过任何实验室评测。
2. ❌ 本插件**不是**"完全满足 ISO/IEC 15408"的产品。
3. ❌ 本插件**不提供**多用户隔离、加密存储、独立审计日志服务。
4. ❌ 本插件**不替代** DSH 自身的身份认证与权限体系。
5. ✅ 本插件**提供**按 ISO/IEC 15408:2026 结构组织的公开自评估、ST 草案、攻击面分析与可复现测试。

> 一句话：**我们把"能做到的"做到了并公开证据；把"做不到的"写清楚，而不是把它包装成卖点。**
