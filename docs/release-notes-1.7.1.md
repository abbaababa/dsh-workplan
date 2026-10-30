# dsh-workplan 1.7.1

**修复 1.7.0 无法激活的问题**（如果你升级到 1.7.0 后重启 DSH Web，终端出现
`JsonSchemaError: ... elapsedMs.type must be a single type string`，任务面板和四个工具都消失，就是这个 bug）。

## 你升级后要做的

```bash
dsh plugin --profile web add dsh-workplan@1.7.1
# 然后重启 DSH Web
```

如果 1.7.0 已经装坏、插件加载不起来，上面的命令会直接覆盖成 1.7.1；不需要先卸载。

## 修了什么

| 问题 | 修复 |
| --- | --- |
| `elapsedMs` 用 `type: ['number','null']` 表达可空，宿主只接受单一类型字符串，激活即抛错 | 改为 `oneOf: [{type:'number'},{type:'null'}]` |
| `dsh_workplan_update` 的 `progress` 用了宿主不支持的 `minimum`/`maximum` | 去掉这两个关键字，范围写进参数说明 |
| `cancel` 的输出 schema 内联在 host 里，容易漏检 | 提取为 `cancelToolOutputSchema()`，与其余 schema 共用一套校验 |

## 为什么之前没测出来

宿主的 schema 校验是**运行期**才跑的，本地 `npm test` 只校验我们自己的逻辑。
现在新增了 `tests/workplan-host-schema.test.ts`：按宿主允许的关键字子集递归校验四个工具的
`parameters` 与 `output.schema`，并锁死「可空标量只能用 `oneOf`，不能写 type 数组」。
另外发布前用宿主真实的 `assertSupportedJsonSchema` 对四个工具各跑一遍。

## 升级清单

- 183 个测试通过（1.7.0 是 179，新增 3 个 schema 用例 + 版本同步断言）。
- 1.7.0 的全部协作能力不变：结构化证据契约、异步派发、写保护、产物门禁、跨部门 brief/needs、重试回灌。
- 无破坏性改动，无依赖变化（0 runtime dependencies）。

完整变更见 [CHANGELOG.md](https://github.com/abbaababa/dsh-workplan/blob/main/CHANGELOG.md)。
