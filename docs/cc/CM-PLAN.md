# 配置管理计划（ALC_CMC/CMS/DVS/LCD 对齐）／ Configuration Management Plan

> 对象：dsh-workplan v1.12.0 ｜ 日期：2026-11-03 ｜ 撰写：T5 ｜ 性质：公开自评估文档，不宣称 CC 认证。

## 0. 覆盖的差距编号

G-13（无正式 CM 计划）、G-16（开发环境安全措施未成文）、G-18（生命周期模型未按 CC 术语成文）、G-19（工具与技术，随文复述）。

## 1. 配置项范围 / Configuration items

| 类别 | 配置项 | 版本标识 |
|---|---|---|
| 源码 | `src/*.ts`（12 文件 17,430 行） | git 提交哈希 |
| 构建产物 | `lib/`、`dist/`、`dist-tests/` | 随提交；`build-artifacts.test.ts` 校验一致性 |
| 测试 | `tests/*.test.ts`（65 个测试文件） | 随提交 |
| 文档 | `README*.md`、`SECURITY.md`、`docs/`（含 `docs/cc/` 全套） | 随提交 |
| 发布物 | npm 包 `dsh-workplan`、GitHub tag `vX.Y.Z` | semver，与 package.json 同步（`version-sync.test.ts` 五处校验） |
| 依赖锁 | `package-lock.json`（lockfileVersion 3） | 随提交 |

## 2. 版本标识与一致性规则 / Versioning rules

1. 语义化版本；`package.json` 为唯一版本源，发布前 `npm test` 必须含 version-sync 通过。
2. 每个发布版本对应：git tag `vX.Y.Z` + `docs/release-record-X.Y.Z-日期.md` + CHANGELOG 条目（参见 1.12.0 实例）。
3. tag 与 commit 一一对应，可由 `git rev-parse vX.Y.Z` 复核；当前 HEAD `5fe47a1` = Release 1.12.0 verification evidence。

## 3. 生命周期模型（ALC_LCD 成文化）／ Lifecycle

```
开发（src + tests 同步改动）
  → 回归（npm test，当前 462 项基线；npm run verify 一键复跑）
  → 文档刷新（CC 文档链、SBOM、CHANGELOG 随版本更新）
  → 发布（RELEASING.md 流程：build → test → npm publish → git tag → release-record 落档）
  → 维护（SECURITY.md 支持版本表；漏洞按 §3 渠道报告，见 release-notes 逐版本缺陷纠正记录）
```

## 4. 开发环境安全措施（ALC_DVS 成文化）／ Development security

- CI（`.github/workflows/verify.yml`）固定 Node 版本，每次提交跑全量测试。
- 工具与技术（ALC_TAT）：零运行时依赖；lockfile 锁定全部开发依赖版本；TypeScript 严格编译。
- 凭据不落库：不提交 `.env`/API key（仓库规则）；发布凭据仅维护者本地持有。
- 提交历史全量保留于 git，公开可审计。

## 5. 配置管理自动化程度

单人维护 + 公开 git 历史（对照 ALC_CMC.1–.2：版本引用 + 自动化 CM 能力由 git 提供）；追踪（CMC.3+）与审计（CMC.4+）属认证级要求，作为残留项如实披露，不在本文宣称。
