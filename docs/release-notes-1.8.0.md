## 1.8.0 — 把"安全"从形容词变成证据链

> **一句话**：这一版给了你一份**按国际安全标准结构写出来、能被任何人 5 条命令复核**的材料，并且**明确告诉你它没有证书**。
>
> **One line**: this release ships security material **structured by an international security standard, verifiable by anyone in 5 commands**, and it **tells you plainly that there is no certificate**.

---

## 🌍 为什么"通过 ISO/IEC 15408"这句话不能随便说

ISO/IEC 15408（简称 **CC**，通用准则）是国际安全标准，最新版是 **2026 年版**。它的规矩是三方分工：

**写代码的人交材料 → 独立实验室按 ISO/IEC 18045 去测 → 国家认证机构发证书。**

证书由第三方签发，**软件不能给自己发**。所以任何"本插件完全满足/已通过 ISO/IEC 15408"却没有**证书编号**的说法，都是不实陈述。

**本插件没有证书，所以我们不这么写。** 我们做的是把 CC 要的材料按标准结构真做出来、公开出来。

CC splits the work three ways: **developer supplies evidence → accredited lab evaluates → national scheme issues the certificate**. Software cannot certify itself. This plugin has no certificate, so it makes no such claim — instead it publishes the evidence, in the standard's own structure.

---

## ✅ 这一版新增了什么

| 材料 | 对应标准 | 内容 |
|---|---|---|
| [docs/cc/CC-2026-ASSESSMENT.md](https://github.com/abbaababa/dsh-workplan/blob/main/docs/cc/CC-2026-ASSESSMENT.md) | 自评估 | 按保证类逐类判定（ASE/ADV/AGD/ALC/ATE/AVA），**EAL1 就绪度矩阵**（14 项组件：11 就绪 / 2 部分 / 1 必须靠外部实验室），未修复差距逐条写明原因 |
| [docs/cc/SECURITY-TARGET.md](https://github.com/abbaababa/dsh-workplan/blob/main/docs/cc/SECURITY-TARGET.md) | 安全目标 ST | 首行即写 **"Conformance claim: NONE"**；7 条威胁、3 条假设、3 条组织策略、8 个功能要求组件，逐条映射到实现与验证命令 |
| [docs/cc/AVA-VULNERABILITY-ANALYSIS.md](https://github.com/abbaababa/dsh-workplan/blob/main/docs/cc/AVA-VULNERABILITY-ANALYSIS.md) | 脆弱性评定 | 攻击面穷举（2 条只读路由 + 4 个工具 + 1 个随包文件）、威胁→对策→残留风险、8 项缺陷（5 项本次修掉，3 项写明接受理由） |
| [docs/SBOM.md](https://github.com/abbaababa/dsh-workplan/blob/main/docs/SBOM.md) | 生命周期 ALC | 运行时 **0** 依赖；6 个开发依赖；1 个随包第三方文件（Chart.js 4.6.1 MIT，附 SHA-256） |
| [SECURITY.md](https://github.com/abbaababa/dsh-workplan/blob/main/SECURITY.md) | 安全策略 | 漏洞私密报告渠道与时限、攻击面、部署建议、**5 条"我们不做/不宣称"** |
| 187 项自动化测试 | 测试 ATE | `npm run verify` 一条命令复跑（1.7.1 为 183 项） |

## 🔧 实现层修复

- `src/runtime.ts`：新增冻结常量 `HARDENING_HEADERS`（`x-content-type-options: nosniff`、`referrer-policy: no-referrer`）与 `applyHardeningHeaders()`，在 `route()` 入口统一应用。
- `src/host.ts`：chart 静态文件路由同样应用，避免两条路由策略不一致。
- 新增 `tests/security-headers.test.ts`（4 项），锁死上述行为并断言两条路由都调用了加固助手。
- `package.json` 的 `files` 增加 `SECURITY.md` 与 `docs`，npm 包内即可查阅全部合规材料。

## 📦 安装（30 秒，小白版）

```bash
dsh plugin --profile web add dsh-workplan@1.8.0
```

装完**重启一次 DSH Web**，刷新 <http://127.0.0.1:3080> 即可。

> Node.js 需要 **22 或更高**（`node -v` 自查）。

## 🔍 自己验证（不用相信我们）

```bash
git clone https://github.com/abbaababa/dsh-workplan.git && cd dsh-workplan
npm ci
npm run verify     # 期望：tests 187 / pass 187 / fail 0

# 复核"无危险 API"这一条
grep -RInE "child_process|execSync|eval\(|new Function|writeFileSync|appendFileSync|mkdirSync|https?\.request" src || echo "0 命中（预期）"

# 复核硬化响应头确实生效
grep -n "HARDENING_HEADERS" src/runtime.ts
```

## ⚠️ 我们不宣称的事

1. 没有 CC 证书，没有通过任何实验室评测。
2. 不是"完全满足 ISO/IEC 15408"的产品。
3. 不提供多租户隔离、加密存储、独立审计日志服务。
4. 不替代 DSH 自身的身份认证与权限体系。
5. 认证需要外部实验室与费用，**不是改代码能解决的**——所以这份材料的目标是"可复核"，不是"冒充已认证"。

## 升级须知

- 无破坏性变更，无新增运行时依赖。
- 反向代理后部署请仍按 `SECURITY.md` §6 自行加 TLS 与认证。

---

**English summary**: Added a public self-assessment structured on ISO/IEC 15408:2026 (CC) — class-by-class mapping, EAL1 readiness matrix, a Security Target draft whose first line says `Conformance claim: NONE`, a vulnerability analysis with an enumerated attack surface, an SBOM (zero runtime dependencies), and a security policy with a private reporting channel. Hardened HTTP responses with `nosniff` and `no-referrer`, added 4 tests (183 → 187). No certificate is claimed, and none should be implied.
