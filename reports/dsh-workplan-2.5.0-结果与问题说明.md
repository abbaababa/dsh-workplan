# dsh-workplan 2.5.0 优化结果与问题说明（通俗版）

日期：2026-11-11 ｜ 执行方式：主 Agent 直接执行（遵守用户要求 4：全程未调用现有 dsh-workplan 插件的任何派发/执行接口）
源码位置：/Users/open/Documents/Stocks/plugins/dsh-workplan（web 与 headless 两个 profile 均为符号链接直连此目录）

## 一、做了什么（对应您的 6 条要求）

1. **负责人有了再分配权限，并且真的敢用了（要求 1）**
   - 查到的根因：2.3.9 其实已经造好了「负责人再分配工具」（dsh_workplan_delegate），但发给部门负责人的任务书里同时写着「你没有派发权限」「不要派生新的 Agent」——等于一边给钥匙一边说门是锁的，负责人收到两套矛盾指令，普遍不敢再分配。这就是您感觉「之前没给负责人分配权限」的真正原因。
   - 本版把矛盾文案改为精确边界：负责人**拥有本部门内再分配权限**（先 review 梳理、后 dispatch 派发），禁止的只是「派发主计划、重启/安装服务、派生第四层」。任务书新增专门的授权段，规划器提示词同步改写。
2. **负责人能定推理等级，且全程不掉档（要求 2）**
   - 新增 consolidation.taskReasoningEffort：负责人按任务复杂度给整个任务定一个等级。
   - 该等级写入状态行 effortOverride：非法值拒绝、越出模型家族集合自动钳制并留痕、刷新/重启经 durable 回放不丢、重试/续跑不清除。
   - 派发链每次激活（首发/重试/续跑）都经新的单一判据函数 resolveTaskEffort 读档：负责人配置优先于规划器写死的档位。
   - 专家/组员没单独配档时继承整体等级（旧逻辑会无条件烧家族最高档，已修复；整体也没配则回落 low）。
3. **任务分得更简单、可多人承担（要求 3）**
   - 规划器新增硬规则：每个子任务单一目标、单一主产物、可独立验收；细节下沉到部门内分工。
   - 负责人分工时每位下级只承担一项简单工作；expert（顶尖专家）与 member（组员）各至少 1 名、最多 6 人共同承担（既有硬门禁保留）。
4. **全程未使用现有插件（要求 4）**：本轮所有改动由主 Agent 直接读写源码 + 离线构建测试完成，未调用任何 dsh_workplan_* 工具。系统自动生成的那份插件计划未通过插件执行（面板中显示受阻属预期，它不是本次工作的执行路径）。
5. **版本号统一 2.5.0（要求 5）**：package.json、package-lock.json（2 处）、src/host.ts meta、lib 编译产物、tool-surface fixture、README 三语徽章与安装行（三语徽章此前滞留 2.3.9 一并修正）、CHANGELOG 新条目、docs/cc 安全文档同步。
6. **时间（要求 6）**：执行段约 16:35–17:05，约 30 分钟，压线完成；执行前的自动规划阶段另计。

## 二、质量证据

- `npm run check`（TypeScript 类型检查）：通过。
- `npm test`（构建 + 全量回归）：**777/777 通过，0 失败，0 取消**（含新增 tests/workplan-250-head-delegation.test.ts 8 例：权限文案根因锁、整体等级钳制/继承/非法拒绝、effortOverride 消毒与回放、端到端 review→dispatch 继承、版本声明）。
- 过程中首轮回归曾出现 3 例失败，均已治本修复：
  1. 状态消毒器把「未配档」物化成 low，截断继承链 → 改为缺失保持缺失；
  2. 两例旧测试锁定的是与授权矛盾的旧文案 → 按新契约更新断言（并加授权断言）。

## 三、遇到的问题与限制（如实）

1. 矛盾指令是历史遗留根因（见上），已修复并加回归锁，防止复发。
2. 系统自动派发的插件调查子任务（T1）两次超时后由主 Agent 接手；其只读调查报告（reports/wp-T1-investigation.md）与本次直接调查结论一致，未影响改动。
3. **生效需要您手工重启 dsh web**（宿主无热加载；按您的规则我不自行重启）。重启后 2.5.0 即生效。
4. 本轮未在线运行插件验证新机制（要求 4 禁止），以离线单测 + 全量回归 + 静态核对替代；建议你重启后随便派一个小任务，观察负责人是否走 review→dispatch 再分配。
5. sha256-manifest.json 是旧发布包（1.12.0 tgz）的历史清单，非当前版本声明，未改动；发布到 GitHub/索引源不在本次范围（如需发布请另行指示）。

## 四、变更文件清单

- src/llm-rules.ts：taskReasoningEffort 校验/钳制、resolveTaskEffort、下级继承默认档、部门告知块强化
- src/runtime.ts：派发链每次激活读 effortOverride、delegate review/status/dispatch 携带整体等级、durable 回放
- src/plan.ts：applyStatus effortOverride 消毒、consolidation 留档（未配档不物化）、回放透传、重置不清除、规划器「更简单」规则、负责人任务书授权段（根因修复）
- src/host.ts：delegate 工具 schema 新增 taskReasoningEffort、描述更新、meta.version=2.5.0
- tests/workplan-250-head-delegation.test.ts（新增）、tests/workplan-budget-pause.test.ts（契约更新）、tests/fixtures/tool-surface.json
- package.json、package-lock.json、README.md / README.en.md / README.zh.md、CHANGELOG.md、docs/cc/ADV-FSP-FUNCTIONAL-SPEC.md、docs/cc/AVA-VULNERABILITY-ANALYSIS.md
- lib/、client.js：npm run build 重新编译（profile 符号链接直连，重启即生效）
