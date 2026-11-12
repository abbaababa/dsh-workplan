# T6b 回归用例设计规格 + 现有全量套件只读复核

## 一、用例规格（供 6059 实现；单一断言、可重复、桩隔离不依赖重启）
| 用例 | 断言 | 对应边界/修复 |
|---|---|---|
| R-01 | 规划请求 effort=default-medium（qwen）且 env 覆盖生效 | B6/F1 |
| R-02 | 子会话 effort 不继承主档，越界钳制留痕 | B6 |
| R-03 | 骨架消息先于细化完成可见；deliveryReady 不因骨架变 true | B10/F2 |
| R-04 | surface 上无先于系统头的 user/message；重启回放校验通过 | B5/F2(C1) |
| R-05 | attempt2 降档后仍属模型合法档集合 | B6/F3 |
| R-06 | 相似任务跨 turn 复用旧计划；真实新需求仍走 changeRequest；澄清闸不被绕过 | B1/F4 |
| R-07 | 续跑不重跑 done；resume≤maxResumes；comm-format 先抄后重置 | B3 |
| R-08 | 结果块缺失永不 done；陈旧/异属备份不采纳 | B4 |
| R-09 | 收束计时器 ref、finally stop；裸 node:test 不红叉 | B7 |
| R-10 | phase-0 缺 self_effort 硬拒；登记后 durable 接续 | B8 |
| R-11 | 第四层 spawn 硬拒 | B9 |
| R-12 | parent 缺失/过期 ⇒ PlanError PARENT_MISSING/STALE（非 TypeError），三入口同断言 | C3/F5 |
| R-13 | 预告含「非承诺」+实测分位口径 | B11/F6 |

## 二、现有全量套件只读复核（6059 产出，路径+时间戳+计数）
- /tmp/wp5.txt（2026-11-12 16:14）：pass=860 fail=0 cancelled=0 ⇒ **当前盘上状态全量绿**。
- /tmp/wp2.txt（16:04）：822 ok / 38 fail ⇒ 过程态红，归因：6059 修复中途（B5 surface-head 等正在改），非本会话引入（本会话零改码）。
- /tmp/wp-test-out.txt（16:03）：117 fail ⇒ 子集/早期过程态，同上归因。
结论：以最新 wp5 为准，盘上无退化证据成立；运行态（15:11 旧 lib）无退化验证待用户手工重载后复跑（见 T8/T9 待办）。
