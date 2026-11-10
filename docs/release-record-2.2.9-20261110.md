# 发布记录 v2.2.9（2026-11-10）

按 RELEASING.md §6 留档：所有证据可复跑。

## 1. 版本与提交

| 项 | 值 |
|---|---|
| 版本 | 2.2.9（四处一致：package.json / package-lock×2 / src/host.ts / CHANGELOG 首段；version-sync 测试随全量绿） |
| 发布提交 | `b341db9`（main 已推送） |
| 标签 | `v2.2.9`（已推送） |
| 内容 | 红字复发族治本：收束类计时器分类去 unref（存活恰 3 处卫生类白名单）+ EVIDENCE_MISSING 有界回喂与盘上结算备份 + 防回归四件套（handle-policy 守卫/全局测试锚/run-tests cancelled===0 硬断言/CI node22+26 双矩阵） |

## 2. 发布前检查（RELEASING §1）

- `npm run check` exit 0；`npm test` 全量 exit 0（失败面仅 version-sync 两处版本声明，同步后绿）。
- W5 跨版本 A/B 探针（打 tag 前）：`RESULT: PASS`。
- 构建可复现：提交后 `npm run build && git diff --exit-code -- lib client.js` = **REPRO_CLEAN**。

## 3. 渠道与制品

| 渠道 | 结果 | 证据（16:38 实测） |
|---|---|---|
| GitHub | `b341db9` + tag `v2.2.9` | CI verify（node 22+26 双矩阵）= **completed success**（双矩阵首次生产实证） |
| GitHub Release | https://github.com/abbaababa/dsh-workplan/releases/tag/v2.2.9 | 资产 `dsh-workplan-2.2.9.tgz`，sha256 `f46f6f5601ee889f5f53c5b248933443bc7bad3d12a1c54aefe6f86cb596840b`（本地打包即该值，打包源=干净克隆 v2.2.9） |
| npm | `+ dsh-workplan@2.2.9` | registry `dist-tags.latest = 2.2.9` 实测 |
| 索引源 | PR [awesome-dsh-plugin#13893](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/13893) OPEN，tarball 指 v2.2.9 | 前序 #13802 **已被上游合并**（mergedAt 2026-11-10T07:00:21Z，条目当时升至 v2.2.8）；#13893 合并+上游 CI 发版后索引升至 2.2.9 |

## 4. 运行态指纹（§6.1）

- 运行态实测（16:39，`dsh_workplan_status`）：**v2.2.8｜build 54a0e5295d0aa712｜pid 822｜启动 16:19:41**。
- 磁盘复刻（完整字节算法）：`cat lib/host.js lib/runtime.js lib/plan.js lib/watchdog.js | shasum -a 256 | cut -c1-16` = **`88cae5ee10476b8b`**（v2.2.9 lib，16:38 实测）。
- 判定：**运行态≠磁盘属预期时序**——用户进程 16:19:41 启动，当时磁盘版本声明仍是 2.2.8（bump 发生在 16:3x），加载的就是当时的正确字节；2.2.9 lib 于其启动之后重建。不存在"重启未生效"故障。
- **待用户再手工重启一次后**，比对运行态 build=`88cae5ee10476b8b`、v=`2.2.9` 即判「2.2.9 已加载」；相同前不得宣称修复在运行态生效。

## 5. 版本显示问答（用户 16:26 问题留档）

「已重启但插件版本还是显示 2.2.8，正常吗？」——正常：①上一轮修复提交未 bump 版本（发版待用户决定），磁盘=2.2.8，重启后运行态=磁盘=2.2.8，三者一致说明加载链路健康；②本轮 2.2.9 发布后，需再次重启才见新版本（进程不会热载磁盘新字节）。

## 6. 复验命令

```bash
npm view dsh-workplan@latest version                      # = 2.2.9（已实测）
gh run list --repo abbaababa/dsh-workplan --commit b341db9 # completed success（双矩阵）
gh pr view 13893 --repo awesome-dsh-plugin/awesome-dsh-plugin --json state
curl -s https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json | grep -o '"id":"dsh-workplan"'  # #13893 合并+上游发版后
cat lib/host.js lib/runtime.js lib/plan.js lib/watchdog.js | shasum -a 256 | cut -c1-16  # = 运行态回显即 2.2.9 已加载
```
