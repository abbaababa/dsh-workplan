# T5 外部渠道回验结果（2026-11-06）

## A1 外部渠道可检索到目标版本号
- `GET https://registry.npmjs.org/dsh-workplan/2.1.2` → HTTP 200
- 返回 version=2.1.2, name=dsh-workplan
- `GET https://registry.npmjs.org/dsh-workplan` → dist-tags = {"latest":"2.1.2"}

## A2 远端内容与本地修正后代码关键点一致
- 远端 tarball 本地计算 shasum = ac65faefcd1065386bf66f7533e9295cffaecd5b
  （与 registry dist.shasum 完全一致）
- 远端 package/package.json version = 2.1.2（本地 package.json 同为 2.1.2）
- 远端 package/lib/runtime.js:97 = `export const PLANNER_TIMEOUT_MS = 300000;`
  本地 lib/runtime.js:97 = `export const PLANNER_TIMEOUT_MS = 300000;` → 一致
- 远端 package/src/runtime.ts:175 = `export const PLANNER_TIMEOUT_MS = 300000`
  本地 src/runtime.ts:175 = `export const PLANNER_TIMEOUT_MS = 300000` → 一致

## A3 超时迹象
- 无。全程命令均在数秒内返回，未触发任何 step 超时。
