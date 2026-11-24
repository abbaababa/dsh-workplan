# dsh-workplan 3.2.7 发布说明（2026-11-25）

## 一、这版修什么

3.2.6 修的是「钱为什么烧得那么快」的三个结构性原因（人数下限、假死误杀、专家开工评估回合）。3.2.7 修的是**贯穿全插件的内部矛盾**：6 个只读子代理逐行通读 24 个源文件（38,362 行），用 file:line 取证出 53 条矛盾/冲突/重叠/不合理，本版逐条处理。

完整清单见 `CHANGELOG.md` 的 3.2.7 条目，分四类：
1. 会直接多花钱的（专家预算、单阶段豁免、自动续跑关不掉、停滞通知误导）
2. 会卡死或白干一轮的（专家结算不校验五步、交接标记永久挂起、escalate 回退并发结算、并发派发孤儿会话、`{ok:false}` 显示成功）
3. 口径不一致（版本单一来源、枚举、并列词、中文标的名、`/\s/` 笔误）
4. 如实说明的三条不修项（降档规则、时钟抖动契约、修复底稿阈值）

## 二、验证

- 本地：`npm test` → **1513 例通过 / 0 失败 / 0 取消**，exit=0（Node v26.9.0）。
- CI：tag `v3.2.7` 触发 Build(22/26) → Test(22/26) → Release 全绿。
- GitHub Release：`https://github.com/abbaababa/dsh-workplan/releases/tag/v3.2.7`
  - 资产 `dsh-workplan-3.2.7.tgz`，2,090,002 字节，sha256 `c7dda81de9731aa10165074e188b912cb2993867c4ce854cce8c2287a762a3a8`
- npm：`dsh-workplan@3.2.7`（latest），tarball sha1 `24b98b3e458d38d6f860ffca9fe2880be64929eb`，163 文件，带 provenance。
- 索引源：`https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/18582`

## 三、升级

profile 里是本地链接（`link:/Users/open/Documents/Stocks/plugins/dsh-workplan`），**重启 DSH 即生效**：

```bash
# 重启后在面板或工具结果里确认版本
# 预期：3.2.7
```

回退开关：
- `DSH_WORKPLAN_MIN_COMPLEX_DELEGATE_MEMBERS=8` 恢复旧人数下限
- `DSH_WORKPLAN_DELEGATE_STALL_SECONDS=120` 恢复旧判死阈值
- `DSH_WORKPLAN_LEADER_PRE_REGISTER=0` 关闭负责人预登记（专家回到 phase-0 评估回合）
