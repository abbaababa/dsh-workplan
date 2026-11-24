# dsh-workplan 3.2.8 发布说明（2026-11-25）

## 一、为什么有 3.2.8

3.2.7 一次性修掉了审计 53 条里的 49 条（P0 12 / P1 20 / P2 21 中的绝大部分），剩 4 条纯前端显示口径。3.2.8 把它们补完，审计清单至此全部有明确处置。

## 二、本版改了什么

1. **`superseded` 按终态处理**：被取代的计划不再进「进行中」统计、不再拉低完成率。
2. **三处 locale 兜底修好**：`t()` 对缺失键返回 `'—'` 而不是 key，`deptName` / `handoffStatusText` / `levelText` 里 `value === key` 的比较永不成立，未知部门原本显示 `'—'` 而非「未知部门」。
3. **首次打开不再先闪「还没有任务进度」**：加载中显示「正在读取任务进度…」。
4. **完成率未知统一显示 `'—'`**：圆环不再对空计划写 `0%`，与卡片一致。

## 三、验证

- 本地 `npm test`：**1513 例通过 / 0 失败 / 0 取消**，exit=0。
- CI：tag `v3.2.8` → Build(22/26) → Test(22/26) → Release 全绿（run `45444626416`）。
- GitHub Release：`https://github.com/abbaababa/dsh-workplan/releases/tag/v3.2.8`
  - 资产 `dsh-workplan-3.2.8.tgz`，2,093,032 字节，sha256 `1b7fb7e11e975001d396957fd677c41667f44b0e63e4fae2d87410c938e6e30e`
- npm：`dsh-workplan@3.2.8`，tarball sha1 `0882964740d8c7188e00a2718b6f490e4d8115a5`（与 CI 日志一致）。
- 索引源：`https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/18582`（已指向 3.2.8）。

## 四、升级

profile 是本地链接，**重启 DSH 即生效**；重启后面板版本显示 `3.2.8`。

回退开关（同 3.2.7）：
- `DSH_WORKPLAN_MIN_COMPLEX_DELEGATE_MEMBERS=8`
- `DSH_WORKPLAN_DELEGATE_STALL_SECONDS=120`
- `DSH_WORKPLAN_LEADER_PRE_REGISTER=0`
