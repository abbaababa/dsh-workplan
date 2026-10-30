# 软件物料清单（SBOM）— dsh-workplan v1.8.0

**用途**：回答"这个插件里到底有哪些别人的代码"。供应链安全的起点，也是 ISO/IEC 15408 生命周期（ALC）类的基础材料。

生成方式：`package.json` + `package-lock.json`（lockfileVersion 3）+ 仓库文件扫描。
复核：`npm ls --all`、`shasum -a 256 vendor/chart.umd.js`。

---

## 1. 结论先行

| 项目 | 数量 |
|---|---|
| 运行时第三方依赖 | **0** |
| 随包分发的第三方文件 | **1**（Chart.js，MIT） |
| 构建期开发依赖（含传递） | **6** |
| 本仓自有代码 | 5 个 TS 模块 + 1 个类型声明 / 8044 行 |
| 许可证 | 本项目 MIT；第三方全部为 MIT 或 Apache-2.0，均允许再分发 |

**零运行时依赖**是本项目最重要的安全属性之一：安装插件不会引入任何可被投毒的运行时依赖树。

---

## 2. 运行时依赖

```
（空）
```

`package.json` 的 `dependencies` 字段不存在或为空对象。插件运行所需的全部能力来自 Node.js 标准库与 DSH 提供的宿主 API。

---

## 3. 随包分发的第三方文件

| 文件 | 组件 | 版本 | 许可证 | 大小 | SHA-256 |
|---|---|---|---|---|---|
| `vendor/chart.umd.js` | Chart.js | 4.6.1 | MIT | 210,078 字节 | `338399fb5bafe598d21cfc471b0590b61ceb321a985fade4f68499b151f67fbf` |

**为什么它随包而不是走 CDN**：走 CDN 意味着每次打开面板都要向第三方发起请求，泄露使用行为，且受对方可用性影响。随包固定 + 哈希可核对，是把这条风险关掉的最简单做法。

**复核**：
```bash
shasum -a 256 vendor/chart.umd.js
# 期望：338399fb5bafe598d21cfc471b0590b61ceb321a985fade4f68499b151f67fbf
```

---

## 4. 构建期开发依赖（不随包发布）

| 包 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| `typescript` | 5.9.3 | Apache-2.0 | 编译 TS → JS、类型检查 |
| `@types/node` | 22.20.5 | MIT | Node.js API 类型定义 |
| `@types/react` | 18.3.31 | MIT | 面板代码的 React 类型定义 |
| `@types/prop-types` | 15.7.15 | MIT | 上者的传递依赖 |
| `csstype` | 3.2.3 | MIT | 上者的传递依赖 |
| `undici-types` | 6.21.0 | MIT | `@types/node` 的传递依赖 |

声明范围（`package.json` `devDependencies`）：`@types/node ^22.20.5`、`@types/react ^18.3.31`、`typescript ^5.9.3`。
实际锁定版本以上表与 `package-lock.json` 为准。

**为什么开发依赖的风险可接受**：它们只在开发者机器与 CI 上执行，不进入 npm 包的运行路径。即便被投毒，影响面是"构建产物被污染"，而 CI 的 `git diff --exit-code -- lib client.js` 会立即发现构建产物与源码不一致。

---

## 5. 本项目自有代码清单

| 文件 | 行数 | 作用 |
|---|---|---|
| `src/client.ts` | 2881 | 浏览器面板渲染 |
| `src/runtime.ts` | 2384 | 计划生成/派发/看门狗/HTTP 路由/鉴权 |
| `src/plan.ts` | 2158 | 计划结构、校验、统计派生 |
| `src/host.ts` | 400 | 插件入口：注册路由、工具、配置 |
| `src/watchdog.ts` | 207 | 子代理超时与预算监控 |
| `src/globals.d.ts` | 14 | 宿主 API 类型声明 |
| **合计** | **8044** | |
| `tests/*.test.ts` | **31 个文件 / 188 项测试** | 自动化验证 |

（行数取自 `wc -l src/*.ts`，v1.8.0 实测。）

---

## 6. 许可证合规

| 许可证 | 组件 | 是否允许商用/再分发 | 义务 |
|---|---|---|---|
| MIT | 本项目、Chart.js、@types/*、csstype、undici-types | ✅ | 保留版权与许可声明 |
| Apache-2.0 | typescript（**仅构建期**） | ✅ | 保留声明与 NOTICE（未再分发则不适用） |

**没有再分发的 Apache-2.0 代码**：TypeScript 只在构建时使用，产物是编译后的 JS，不包含 TypeScript 源码或声明文件。因此 npm 包内只含 MIT 代码。

---

## 7. 已知未覆盖项（诚实说明）

| 项 | 状态 |
|---|---|
| 未生成 SPDX/CycloneDX 标准格式文件 | 本文件为人工维护的 Markdown 版 SBOM；对零运行时依赖的项目足够，但不如机器可读格式便于自动化审计 |
| 未做依赖漏洞库比对（CVE 扫描） | 运行时零依赖使此项收益极低；开发依赖可用 `npm audit` 自行检查 |
| 未固定开发依赖的精确版本（用 `^` 范围） | `package-lock.json` 已锁定实际版本；`npm ci` 会严格按 lock 安装 |

---

## 8. 复核命令

```bash
npm ls --all                 # 看完整依赖树
npm ls --omit=dev            # 期望：空（零运行时依赖）
shasum -a 256 vendor/chart.umd.js
npm ci && npm run verify     # 按 lock 安装并跑全量测试
```
