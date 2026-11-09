# dsh-workplan release.sh 干跑测试报告（T3 · 质量验证）

- 日期：2026-11-06
- 测试对象：`plugins/dsh-workplan/release.sh`（408 行）
- 环境：macOS arm64，GNU bash 3.2.57(1)-release
- 仓库基线（测试前记录）：HEAD `7c054e9702376a19950978e2967810ad0d36261f`，分支 `main`，工作区仅未跟踪 `?? release.sh`，tag `v2.1.4` 不存在
- 输入：T2 产物 `release.sh` + T1 清单 `RELEASE_STEPS_T1.md`

## A1 · 语法检查

```
$ bash -n release.sh
(exit 0)
```

结论：**通过**。macOS 系统 bash 3.2（最严苛的常见 bash 版本）下语法解析零错误。

## A2 · 命令顺序比对（干跑输出 vs T1 清单）

干跑命令：`bash release.sh --version 2.1.4 --summary "T3 干跑验证" --dry-run` → **exit 0**，30 条「将执行」按序打印。

| T1 步骤（RELEASE_STEPS_T1.md） | 干跑输出（实际顺序） | 一致 |
|---|---|---|
| 步骤0 版本四处声明点 | ② npm version（package.json+lock）→ sed src/host.ts → CHANGELOG 顶部插入 | ✓ |
| 步骤1 git status --short | ① 工作区检查（porcelain + --short） | ✓ |
| 步骤1 npm run check | ③ 第 1 条 `npm run check` | ✓ |
| 步骤1 npm test | ③ 第 2 条 `npm test` | ✓ |
| 步骤1 npm run build && git diff --exit-code | ③ 第 3、4 条 `npm run build` → `git diff --exit-code -- lib client.js` | ✓ |
| 步骤2 git add -A / commit / tag -a | ④ add → commit → tag（三条按序） | ✓ |
| 步骤2 git push origin main / vX | ④ push main → push v2.1.4 | ✓ |
| 步骤3 clone --depth 1 --branch vX | ⑤ git clone（mktemp 临时目录，比 T1 的 /tmp 固定路径更安全） | ✓ |
| 步骤3 npm ci && build && npm pack | ⑤ 按序打印 | ✓ |
| 步骤3 sha256sum | ⑤ 记录制品 sha256 | ✓ |
| 步骤3 gh release create（带 tgz） | ⑥ 带 tgz + --notes-file | ✓ |
| 步骤3 curl -sIL 验证制品 | ⑥ 末尾 curl 校验 HTTP 200（在 npm 发布之前，与 T1 步骤3→4 顺序一致） | ✓ |
| 步骤4 npm whoami / npm publish | ⑦ 按序打印 | ✓ |
| 步骤4 npm view X / npm view latest | ⑦ 两条 view 验证 | ✓ |
| 步骤5/6 索引源 PR / 发布记录 | 不代做，结尾 warn 列为人工收尾（T1 明确标注「非本仓库权限」） | ✓ |
| 步骤7 回滚 | --rollback 分支：gh release delete（tag 保留）、npm unpublish 仅打印、索引源仅提示 | ✓ |

**顺序结论**：检查 → 版本四处同步 → check/test/build/diff → add/commit/tag/push → clone/ci/build/pack/sha256 → gh release create → curl 验证 → npm whoami/publish → npm view ×2——与 T1「顺序铁律」逐环节一致。

合理差异说明（均不改变顺序判定）：
1. 脚本新增前置检查（工具存在、分支、tag 不存在、版本确为新）——落实 T1 前置条件，不是重排。
2. 版本同步扩展到三语 README + tests/fixtures/tool-surface.json——依据 `tests/version-sync.test.ts:45`（断言 README.md/README.en.md 必须含 `dsh-workplan@<新版本>`），防止重蹈 2.1.2 CI #399/#400 红叉。
3. T1 清单 #4 `npm run verify` 是 CI 聚合命令；脚本按 RELEASING.md §1 细分为 check→test→build→diff，顺序等价。

## 安全检查（无越权操作）

- `sudo|launchctl|systemctl|kill|pkill|reboot|shutdown|chmod|chown|curl -X`：**0 命中**。
- `npm unpublish` 4 处命中全部是注释/警告文本（release.sh:25,51,93,368），**无一处执行**。
- `rm -rf` 仅 1 处（release.sh:328），目标是 `mktemp -d` 生成的临时目录。
- 不重启任何服务、不写 `~/.dsh`、不安装依赖（与脚本头部声明边界一致）。
- 干跑全程**零网络请求、零文件改动**：干跑后 `git status --short` 仍为 `?? release.sh`、HEAD 仍 `7c054e9`。

## 边界测试

| 用例 | 结果 |
|---|---|
| `--help` | exit 0 ✓ |
| 缺 `--version` | 报错 exit 1，无副作用 ✓ |
| `--rollback --dry-run` | exit 0，`gh release delete` 仅打印、tag 保留 ✓ |
| 文件可执行位 | `-rwx--x--x`，用法文档的 `./release.sh` 可直接运行 ✓ |

## 缺陷清单

- **D-01（非阻塞，文档性瑕疵）**：头部注释 `release.sh:45-46` 把「⑧ curl 验证」列在「⑦ npm 发布」之后；实际代码在 `do_gh_release` 内先 curl 验证（release.sh:341-343）再 npm 发布，且该顺序与 T1 一致。仅注释编号与代码不符，不影响执行顺序与 A2 判定。建议后续顺手修正注释。

## 结论

- **A1 语法检查：通过**（bash -n exit 0）。
- **A2 模拟输出命令顺序与 T1 清单一致：通过**（17 行映射表逐条一致，合理差异 3 项均已注明依据）。
- **安全检查：通过**（无越权操作、零副作用）。
- 遗留：D-01 注释瑕疵（不阻塞交付）。
