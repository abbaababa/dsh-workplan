# dsh-workplan 1.7.1 发布记录（2026-10-30）

补丁版本，只修 1.7.0 的激活失败，不改协作契约。

## 做了什么

| 项 | 值 |
| --- | --- |
| 提交 | `205fa5e` Release 1.7.1: fix plugin activation by keeping tool schemas inside the host subset |
| 标签 | `v1.7.1`（annotated，已 push） |
| 制品 | `dsh-workplan-1.7.1.tgz`，312421 B，sha256 `690773d0402a8a6716760657dc10392f6feb70e0617b652ec1207460271e59ec`，22 files |
| GitHub Release | https://github.com/abbaababa/dsh-workplan/releases/tag/v1.7.1 |
| npm | `dsh-workplan@1.7.1`，dist-tag `latest` |
| 索引源 PR | https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/10528 （head 分支 `bump-dsh-workplan-1.7.0`，提交 `b1595d2`，tarball 指向 v1.7.1） |

## 根因

`statusToolOutputSchema()` 用 `type: ['number', 'null']` 表达可空耗时，`dsh_workplan_update` 的
`progress` 用了 `minimum` / `maximum`。宿主的 `assertSupportedJsonSchema` 只接受单一类型字符串、
且关键字子集不含 `minimum`/`maximum`，于是在**激活阶段**抛 `JsonSchemaError`，整个插件条目被跳过：
面板没有数据，四个工具全部消失，终端只有一行 `dsh: warning: 1 entry did not activate`。

## 修复

1. `elapsedMs` → `oneOf: [{ type: 'number' }, { type: 'null' }]`；
2. `progress` 去掉 `minimum`/`maximum`，范围写进 description；
3. `cancel` 输出 schema 提为 `cancelToolOutputSchema()`，与其余 schema 共用导出与校验；
4. 新增 `tests/workplan-host-schema.test.ts`（3 用例，按宿主子集递归校验 parameters / output.schema）；
5. 发布前用宿主真实 `assertSupportedJsonSchema` 校验四个工具（临时脚本，不入依赖）。

## 复验命令（可照抄）

```bash
# 1) 已发布的版本与制品
npm view dsh-workplan@latest version dist.tarball
gh release view v1.7.1 --json assets --jq '.assets[] | "\(.name) \(.size)"'

# 2) 真正的安装结果
cd /tmp && rm -rf wp171 && mkdir wp171 && cd wp171 && npm init -y >/dev/null && npm i dsh-workplan@1.7.1
node -e "console.log(require('./node_modules/dsh-workplan/package.json').version)"
grep -n "oneOf: \[{ type: 'number' }, { type: 'null' }\]" node_modules/dsh-workplan/lib/runtime.js

# 3) 本机 profile 已指向仓库构建（重启 DSH Web 后生效）
grep -c "oneOf" /Users/open/.dsh/profiles/web/node_modules/dsh-workplan/lib/runtime.js
```

## 结果

- `npm test` 183 通过，`npm run check` 通过，`npm run build` 成功。
- `/tmp/wp171` 安装 1.7.1 后版本号正确、0 dependencies、`oneOf` 修复在制品中。
- `npm view dsh-workplan dist-tags` → `latest: 1.7.1`。

## 回滚

`dsh plugin --profile web add dsh-workplan@1.7.0` 会装回无法激活的版本，不建议；
如确需回滚，用 `@1.6.0`（1.7 的所有能力随之消失）。
