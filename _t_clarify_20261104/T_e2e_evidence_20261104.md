# 澄清闸门端到端证据（2026-11-04）

## 命令

```bash
cd /Users/open/Documents/Stocks
export DEEPSEEK_API_KEY=<已设置>
export DSH_WORKPLAN_AUTO_DISPATCH=1
node /Users/open/.npm/_npx/f952829a1b7f9589/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile headless --patch _t5_model_validation_20261103/ms2_run/patch_model_deepseek.yml \
  --permission-mode danger-full-access headless --json "$(cat _t5_model_validation_20261103/inputs/T05-13.txt)"
```

## 结果（T05-13 原文：显示内容希望可折叠，可点击展开）

| 观测项 | 实测 |
|---|---|
| 事件总数 | 141,405 字节 NDJSON；tool_call 32 次 |
| `dsh_workplan_*` 工具调用 | **0 次**（grep `"name":"dsh_workplan_` 无结果） |
| 计划信封 `DSH-WORKPLAN:BEGIN` | **0 次** |
| 澄清提示「先澄清」 | 3 次（多步重复注入） |
| 回合结束 | `turn_end reason.kind = completed`，`final.text` 以向用户提问开头 |
| 进程退出码 | 0 |

结论：信息不足时插件不再生成计划、不再派发；模型改为向用户确认（这次它问的是
「headless 没有界面，你说的折叠是哪个界面」，正是缺的信息）。

原始事件流：`/tmp/clarify_e2e/T05-13.jsonl`（临时目录，重启后可能被清理；
本文件保留了结论与命令，可原样复跑）。
