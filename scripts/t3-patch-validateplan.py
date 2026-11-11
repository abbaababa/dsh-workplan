import io, sys

path = 'src/plan.ts'
src = io.open(path, encoding='utf-8').read()

old = """  checkPlanGraph(plan, errors)
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, plan }"""

new = """  const allowedEfforts = options && options.allowedEfforts ? options.allowedEfforts : null
  if (allowedEfforts !== null && Array.isArray(raw.stages)) {
    /*
     * [2.3.9][T3/llm-rules] 模型感知的校验收窄（用户要求 1/2，主 Agent 口径）：
     * 五档仍是存储全集（不得删档），但调用方传入当前模型家族等级集合时，
     * 规划器**显式写出**的集合外档位拒绝并点名字段——错误经重试回路回喂
     * 规划器自纠，属于事前约束而非派发后静默钳制。缺失档位不在此拦（由
     * readSubtasks 回落 high、派发侧静态收窄带 qwen-rule 留痕降级）；未传
     * options 的调用（回放/旧路径）零行为变化。
     */
    for (let stageIndex = 0; stageIndex < raw.stages.length; stageIndex += 1) {
      const stage = raw.stages[stageIndex]
      if (!isRecord(stage) || !Array.isArray(stage.subtasks)) continue
      for (let subtaskIndex = 0; subtaskIndex < stage.subtasks.length; subtaskIndex += 1) {
        const subtask = stage.subtasks[subtaskIndex]
        if (!isRecord(subtask)) continue
        const effort = subtask.reasoningEffort
        if (effort !== undefined && effort !== null
          && !(typeof effort === 'string' && allowedEfforts.includes(effort))) {
          push(errors, `stages[${stageIndex}].subtasks[${subtaskIndex}].reasoningEffort`,
            `"${String(effort)}" 不在当前模型家族的推理等级集合 {${allowedEfforts.join(' / ')}} 内（qwen 系仅 low / medium / xhigh；非 qwen 系仅 low / high / max），必须改用集合内档位或删除该字段`)
        }
      }
    }
  }
  checkPlanGraph(plan, errors)
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, plan }"""

count = src.count(old)
if count != 1:
    print('FAIL match count =', count)
    sys.exit(1)
src = src.replace(old, new, 1)
io.open(path, 'w', encoding='utf-8').write(src)
print('PATCHED plan.ts')
