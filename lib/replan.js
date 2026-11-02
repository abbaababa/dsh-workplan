/**
 * [1.11.0] 子任务级重规划：把「需求变更」落成一条可回放、可追溯的状态迁移。
 *
 * 为什么单独一个文件：重规划同时改两样东西——计划定义（新增/替换子任务）与
 * 状态条目（旧行标 `closure:'replanned'`）。如果实时路径改内存、回放路径靠
 * 重新解析 plan 消息，两条路径必然分叉（旧行复活、分母漂移）。因此：
 *
 *   1. `planReplan()` 是纯函数：输入旧计划 + 旧状态 + 变更表，输出「修订后
 *      的完整计划 + 旧行标记 + 新行清单」，不读时钟、不碰会话；
 *   2. 实时路径与回放路径都调用同一个 `applyReplanStatuses()`；
 *   3. durable 记录 `workplan-replan` 里带**完整修订计划**，回放直接采用，
 *      不需要重新推导，因此刷新/重启后看到的是同一份定义。
 *
 * 旧行不删除：它在计划里保留 `supersededAt/replacedBy`，在状态里保留
 * `closure:'replanned'`。展示层据此渲染「已重规划 → 修订 rN」并灰化，计数与
 * 调度器则把它排除（见 plan.ts 的 `isReplannedStatus`、`definedSubtaskCount`）。
 */
import { DEPARTMENTS, MAX_STAGES, MAX_SUBTASKS, PLAN_VERSION, applyStatus, flattenSubtasks, isRecord, makeUserMessage, messageText, truncate, } from './plan.js';
export const REPLAN_MARKER_BEGIN = '<!-- DSH-WORKPLAN-REPLAN:BEGIN -->';
export const REPLAN_MARKER_END = '<!-- DSH-WORKPLAN-REPLAN:END -->';
export const REPLAN_ACTIONS = Object.freeze(['cancel', 'replace', 'add']);
export const MAX_REPLAN_CHANGES = 12;
/**
 * [1.11.0] 重规划是第二个写计划定义的入口，部门合法性必须与首次规划同强度。
 * 修复前 replace/add 接受任意值（数字、对象、注入文本），会绕过
 * `validatePlan` 直接进提示词。
 */
function replanDepartment(value) {
    if (typeof value !== 'string')
        return null;
    return Object.prototype.hasOwnProperty.call(DEPARTMENTS, value) ? value : null;
}
/** 单个变更理由上限，避免模型把整段对话塞进 durable 消息。 */
export const MAX_REPLAN_REASON_CHARS = 2000;
export const REPLAN_CODES = {
    NO_PLAN: 'REPLAN_NO_PLAN',
    REASON_REQUIRED: 'REPLAN_REASON_REQUIRED',
    NO_CHANGES: 'REPLAN_NO_CHANGES',
    TOO_MANY_CHANGES: 'REPLAN_TOO_MANY_CHANGES',
    UNKNOWN_SUBTASK: 'REPLAN_UNKNOWN_SUBTASK',
    ALREADY_SUPERSEDED: 'REPLAN_ALREADY_SUPERSEDED',
    INVALID_ACTION: 'REPLAN_INVALID_ACTION',
    DUPLICATE_CHANGE: 'REPLAN_DUPLICATE_CHANGE',
    INVALID_REPLACEMENT: 'REPLAN_INVALID_REPLACEMENT',
    INVALID_SUBTASK: 'REPLAN_INVALID_SUBTASK',
    GRAPH_INVALID: 'REPLAN_GRAPH_INVALID',
    WRITE_FAILED: 'REPLAN_WRITE_FAILED',
};
function fail(code, error) {
    return { ok: false, code, error };
}
function clone(value) {
    return JSON.parse(JSON.stringify(value));
}
/** 子任务在修订计划中的线性位置，用于依赖顺序校验。 */
function orderMap(plan) {
    const order = new Map();
    let next = 0;
    for (const entry of flattenSubtasks(plan)) {
        order.set(String(entry.subtask?.id ?? ''), next);
        next += 1;
    }
    return order;
}
function hasSubtasks(plan) {
    try {
        return flattenSubtasks(plan).length > 0;
    }
    catch {
        return false;
    }
}
function subtaskOf(plan, id) {
    for (const entry of flattenSubtasks(plan)) {
        if (String(entry.subtask?.id ?? '') === id)
            return entry;
    }
    return null;
}
/**
 * 图的最后一道闸：ID 唯一、依赖存在且在前、总数与阶段数不超限。
 *
 * 不复用 `validatePlan()`：它按固定 schema 重建子任务，会把 `supersededAt` /
 * `replacedBy` 这类审计字段丢掉，重规划标记就失效了。这里只校验结构，
 * 不改写对象。
 */
function checkReplanGraph(plan) {
    const errors = [];
    const stages = Array.isArray(plan?.stages) ? plan.stages : [];
    if (stages.length < 1)
        errors.push('修订后的计划至少需要 1 个阶段');
    if (stages.length > MAX_STAGES)
        errors.push(`阶段数 ${stages.length} 超过上限 ${MAX_STAGES}`);
    const order = orderMap(plan);
    /*
     * [1.11.0] 容量只数「仍在计划里的行」（T4 D-T4-04）。
     *
     * superseded 旧行是为审计保留的历史，不是待办；把它们计入 15 项，会让
     * 满编计划第一次 replace 就撞墙，用户被迫删历史才能改计划。
     */
    const active = flattenSubtasks(plan).filter((entry) => !entry.subtask?.supersededAt).length;
    if (active > MAX_SUBTASKS)
        errors.push(`子任务总数 ${active} 超过上限 ${MAX_SUBTASKS}`);
    for (const entry of flattenSubtasks(plan)) {
        const subtask = entry.subtask ?? {};
        const id = String(subtask.id ?? '');
        if (!id) {
            errors.push('存在 id 为空的子任务');
            continue;
        }
        const dependencies = Array.isArray(subtask.dependsOn) ? subtask.dependsOn : [];
        for (const dependency of dependencies) {
            if (!order.has(String(dependency))) {
                errors.push(`${id} 依赖了不存在的子任务 ${String(dependency)}`);
                continue;
            }
            if (Number(order.get(String(dependency))) >= Number(order.get(id))) {
                errors.push(`${id} 的依赖 ${String(dependency)} 不在它之前`);
            }
        }
    }
    return errors;
}
function nextId(plan, base) {
    const taken = new Set(orderMap(plan).keys());
    if (!taken.has(base))
        return base;
    for (const suffix of 'bcdefghijklmnopqrstuvwxyz') {
        const candidate = `${base}${suffix}`;
        if (!taken.has(candidate))
            return candidate;
    }
    let index = 2;
    while (taken.has(`${base}${index}`))
        index += 1;
    return `${base}${index}`;
}
const REPLACEMENT_FIELDS = [
    'title',
    'department',
    'role',
    'objective',
    'method',
    'inputs',
    'outputs',
    'acceptance',
    'risk',
];
/** 用调用方给的替换内容覆盖旧子任务的同名字段；未给字段原样继承。 */
function mergeReplacement(old, replacement, id, reason) {
    const next = clone(old);
    for (const key of REPLACEMENT_FIELDS) {
        if (replacement?.[key] !== undefined)
            next[key] = clone(replacement[key]);
    }
    next.id = id;
    delete next.supersededAt;
    delete next.supersededRevision;
    delete next.replacedBy;
    next.replaces = old.id;
    next.insertedBy = 'replan';
    next.replannedReason = reason;
    return next;
}
/**
 * 纯重规划：改计划定义 + 产出旧行标记。
 *
 * @param plan - 当前计划定义。
 * @param changes - 模型给出的变更表（每项一个 subtaskId）。
 * @param options - `reason` 必填；`revision` 为新修订号；`at` 由调用方给，
 *   保证回放与实时不使用两次时钟。
 */
/**
 * [1.11.0] replan 是第二个写计划定义的入口，字段强度必须对齐 validatePlan
 * （T4 D-T4-03）。修复前 add 接受 14 条依赖、200 条 inputs 与 16 万字符
 * 载荷，这些计划再也回灌不了 validatePlan，却能被真实派发。
 */
function replanFieldError(raw) {
    const list = (key, max, itemMax, required = false) => {
        const value = raw?.[key];
        if (value === undefined)
            return required ? `${key} 不能为空` : null;
        if (!Array.isArray(value))
            return `${key} 必须是数组`;
        if (value.length > max)
            return `${key} 最多 ${max} 条`;
        if (required && value.length === 0)
            return `${key} 至少需要 1 条`;
        for (const item of value) {
            if (typeof item !== 'string')
                return `${key} 的每一项必须是字符串`;
            if (item.length > itemMax)
                return `${key} 的单项最长 ${itemMax} 字符`;
        }
        return null;
    };
    const one = (key, max, required = false) => {
        const value = raw?.[key];
        if (value === undefined)
            return required ? `${key} 不能为空` : null;
        if (typeof value !== 'string')
            return `${key} 必须是字符串`;
        if (required && value.trim() === '')
            return `${key} 不能为空`;
        if (value.length > max)
            return `${key} 最长 ${max} 字符`;
        return null;
    };
    return list('dependsOn', 12, 16)
        ?? list('method', 12, 800)
        ?? list('inputs', 12, 800)
        ?? list('outputs', 12, 800)
        ?? list('acceptance', 8, 800)
        ?? one('role', 200)
        ?? one('title', 200)
        ?? one('objective', 2000)
        ?? one('risk', 1000);
}
export function planReplan(plan, changes, options = {}) {
    const planId = String(options.planId ?? plan?.planId ?? '');
    const reason = truncate(String(options.reason ?? '').trim(), MAX_REPLAN_REASON_CHARS);
    const revision = Number(options.revision);
    const at = Number(options.at);
    if (!planId)
        return fail(REPLAN_CODES.NO_PLAN, '当前会话还没有已生成的计划');
    if (!hasSubtasks(plan))
        return fail(REPLAN_CODES.NO_PLAN, '当前计划没有可重规划的子任务');
    if (!reason)
        return fail(REPLAN_CODES.REASON_REQUIRED, '重规划必须说明 reason（为什么原安排失效）');
    if (!Number.isInteger(revision) || revision < 1) {
        return fail(REPLAN_CODES.GRAPH_INVALID, 'revision 必须是正整数');
    }
    if (!Number.isFinite(at) || at <= 0)
        return fail(REPLAN_CODES.GRAPH_INVALID, 'at 必须是毫秒时间戳');
    if (!Array.isArray(changes) || changes.length === 0) {
        return fail(REPLAN_CODES.NO_CHANGES, 'changes 至少需要 1 项');
    }
    if (changes.length > MAX_REPLAN_CHANGES) {
        return fail(REPLAN_CODES.TOO_MANY_CHANGES, `changes 最多 ${MAX_REPLAN_CHANGES} 项`);
    }
    const next = clone(plan);
    next.planId = plan.planId;
    next.sessionId = plan.sessionId;
    next.createdTurn = plan.createdTurn;
    next.createdAt = plan.createdAt;
    next.sourceMessageIds = Array.isArray(plan.sourceMessageIds) ? [...plan.sourceMessageIds] : [];
    next.planRevision = revision;
    next.replannedAt = at;
    const marks = [];
    const added = [];
    const additions = [];
    const seen = new Set();
    for (const raw of changes) {
        if (!isRecord(raw))
            return fail(REPLAN_CODES.INVALID_ACTION, 'changes 的每一项必须是对象');
        const subtaskId = String(raw.subtaskId ?? '').trim();
        const action = String(raw.action ?? '').trim();
        if (!subtaskId)
            return fail(REPLAN_CODES.UNKNOWN_SUBTASK, 'changes 的每一项必须带 subtaskId');
        if (seen.has(subtaskId))
            return fail(REPLAN_CODES.DUPLICATE_CHANGE, `子任务 ${subtaskId} 在 changes 里出现了两次`);
        seen.add(subtaskId);
        if (!REPLAN_ACTIONS.includes(action)) {
            return fail(REPLAN_CODES.INVALID_ACTION, `子任务 ${subtaskId} 的 action 必须是 cancel / replace / add`);
        }
        if (action === 'add') {
            if (!isRecord(raw.newSubtask)) {
                return fail(REPLAN_CODES.INVALID_SUBTASK, `add(${subtaskId}) 需要 newSubtask（title/objective 必填）`);
            }
            additions.push(raw.newSubtask);
            continue;
        }
        const entry = subtaskOf(next, subtaskId);
        if (!entry)
            return fail(REPLAN_CODES.UNKNOWN_SUBTASK, `计划里没有子任务 ${subtaskId}`);
        if (entry.subtask.supersededAt) {
            return fail(REPLAN_CODES.ALREADY_SUPERSEDED, `子任务 ${subtaskId} 已经被重规划过（修订 r${String(entry.subtask.supersededRevision ?? '?')}）`);
        }
        const changeReason = truncate(String(raw.reason ?? reason).trim(), MAX_REPLAN_REASON_CHARS);
        const stage = entry.stage;
        const index = stage.subtasks.indexOf(entry.subtask);
        const old = clone(entry.subtask);
        old.supersededAt = at;
        old.supersededRevision = revision;
        old.replannedReason = changeReason;
        stage.subtasks[index] = old;
        if (action === 'cancel') {
            old.replacedBy = [];
            marks.push({ subtaskId, action: 'cancel', replacedBy: [], reason: changeReason });
            continue;
        }
        const replacement = isRecord(raw.replacement) ? raw.replacement : null;
        if (!replacement) {
            return fail(REPLAN_CODES.INVALID_REPLACEMENT, `replace(${subtaskId}) 需要 replacement：至少给出改后的 objective 或 title`);
        }
        if (replacement.department !== undefined && replanDepartment(replacement.department) === null) {
            return fail(REPLAN_CODES.INVALID_REPLACEMENT, `replacement.department 不是合法部门：${String(replacement.department)}`);
        }
        const replacementError = replanFieldError(replacement);
        if (replacementError)
            return fail(REPLAN_CODES.INVALID_REPLACEMENT, `replacement 字段不合规：${replacementError}`);
        const requestedId = typeof replacement.id === 'string' ? replacement.id.trim() : '';
        if (requestedId && (requestedId === subtaskId || orderMap(next).has(requestedId))) {
            return fail(REPLAN_CODES.INVALID_SUBTASK, `替换行的 id ${requestedId} 已被占用`);
        }
        const newId = requestedId || nextId(next, `${subtaskId}b`);
        if (newId.length > 16)
            return fail(REPLAN_CODES.INVALID_SUBTASK, `子任务 id 最长 16 个字符：${newId}`);
        const successor = mergeReplacement(old, replacement, newId, changeReason);
        successor.dependsOn = Array.isArray(old.dependsOn) ? [...old.dependsOn] : [];
        old.replacedBy = [newId];
        stage.subtasks.splice(index + 1, 0, successor);
        /*
         * 下游的 dependsOn 必须一起改指向，否则它们会永远等一个不再调度的旧行
         * （契约 §7.2 硬规则 3）。只改指到 subtaskId 的那一条，其它依赖不动。
         */
        for (const other of flattenSubtasks(next)) {
            const list = Array.isArray(other.subtask.dependsOn) ? other.subtask.dependsOn : [];
            if (!list.includes(subtaskId))
                continue;
            other.subtask.dependsOn = list.map((dependency) => (dependency === subtaskId ? newId : dependency));
        }
        marks.push({ subtaskId, action: 'replace', replacedBy: [newId], reason: changeReason });
        added.push({
            subtaskId: newId,
            stageId: String(stage.id ?? ''),
            title: String(successor.title ?? ''),
            department: String(successor.department ?? ''),
            role: String(successor.role ?? ''),
            replaces: subtaskId,
        });
    }
    /*
     * add 走独立数组：它不替代任何旧行，只是把新工作追加进新一轮。
     * 放进独立阶段，避免打乱原阶段的位置/依赖顺序。
     */
    for (const [index, raw] of additions.entries()) {
        if (!isRecord(raw))
            return fail(REPLAN_CODES.INVALID_SUBTASK, 'newSubtask 必须是对象');
        /*
         * 阶段 ID 与用户已有阶段撞名时，不能把新任务插进计划中部（T4 反例 V）：
         * 位置会决定依赖顺序。撞名就换一个后缀，保证新阶段始终追加在末尾。
         */
        let stageId = `replan-r${revision}`;
        for (let suffix = 0; next.stages.some((item) => item?.id === stageId); suffix += 1) {
            stageId = `replan-r${revision}${suffix === 0 ? 'x' : `x${suffix}`}`;
        }
        const requestedId = typeof raw.id === 'string' ? raw.id.trim() : '';
        const newId = requestedId || nextId(next, `R${revision}-${index + 1}`);
        if (newId.length > 16)
            return fail(REPLAN_CODES.INVALID_SUBTASK, `子任务 id 最长 16 个字符：${newId}`);
        if (orderMap(next).has(newId))
            return fail(REPLAN_CODES.INVALID_SUBTASK, `子任务 id 重复：${newId}`);
        const department = raw.department === undefined ? 'engineering' : replanDepartment(raw.department);
        if (department === null) {
            return fail(REPLAN_CODES.INVALID_SUBTASK, `newSubtask.department 不是合法部门：${String(raw.department)}`);
        }
        const fieldError = replanFieldError(raw);
        if (fieldError)
            return fail(REPLAN_CODES.INVALID_SUBTASK, `newSubtask 字段不合规：${fieldError}`);
        const goal = typeof raw.objective === 'string' ? raw.objective.trim() : '';
        const title = typeof raw.title === 'string' ? raw.title.trim() : '';
        if (!goal || !title) {
            return fail(REPLAN_CODES.INVALID_SUBTASK, 'newSubtask 至少需要 title 与 objective');
        }
        let stage = next.stages.find((item) => item?.id === stageId);
        if (!stage) {
            if (next.stages.length >= MAX_STAGES) {
                return fail(REPLAN_CODES.GRAPH_INVALID, `新增阶段会超过上限 ${MAX_STAGES}`);
            }
            stage = {
                id: stageId,
                name: `重规划修订 r${revision}`,
                goal: truncate(reason, 400),
                checkpoint: '只执行本轮新增/替换的项；旧行保留为已重规划，不再调度。',
                subtasks: [],
            };
            next.stages.push(stage);
        }
        const subtask = {
            id: newId,
            title: truncate(title, 200),
            department,
            role: truncate(String(raw.role ?? '执行工程师'), 200),
            objective: truncate(goal, 2000),
            method: Array.isArray(raw.method) && raw.method.length > 0 ? raw.method.map((item) => truncate(String(item), 800)) : ['按目标直接执行'],
            inputs: Array.isArray(raw.inputs) ? raw.inputs.map((item) => truncate(String(item), 800)) : [],
            outputs: Array.isArray(raw.outputs) && raw.outputs.length > 0 ? raw.outputs.map((item) => truncate(String(item), 800)) : ['结果说明'],
            dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map((item) => String(item)) : [],
            acceptance: Array.isArray(raw.acceptance) && raw.acceptance.length > 0
                ? raw.acceptance.map((item) => truncate(String(item), 800))
                : ['复述完成的工作并给出可核对证据'],
            risk: truncate(String(raw.risk ?? '需求变更后新增，原计划未覆盖'), 1000),
            insertedBy: 'replan',
            replannedReason: truncate(String(raw.reason ?? reason), MAX_REPLAN_REASON_CHARS),
        };
        stage.subtasks.push(subtask);
        added.push({
            subtaskId: newId,
            stageId,
            title: subtask.title,
            department: subtask.department,
            role: subtask.role,
            replaces: null,
        });
    }
    if (marks.length === 0 && added.length === 0) {
        return fail(REPLAN_CODES.NO_CHANGES, '没有产生任何重规划变更；如果原计划仍然有效，请直接 dispatch');
    }
    const graphErrors = checkReplanGraph(next);
    if (graphErrors.length > 0) {
        return fail(REPLAN_CODES.GRAPH_INVALID, `修订后的计划不合法：${graphErrors.slice(0, 5).join('；')}`);
    }
    return {
        ok: true,
        payload: {
            kind: 'workplan-replan',
            version: PLAN_VERSION,
            planId,
            revision,
            reason,
            at,
            plan: next,
            marks,
            added,
        },
    };
}
/**
 * 把重规划标记落到状态数组。实时与回放共用，且幂等。
 *
 * 旧行：`closure:'replanned'` + `status:'pending'`（用于展示「待重规划」，不参与
 * 调度/计数）；`replannedFrom` 保留改判前状态，便于审计。新行：pending。
 */
export function applyReplanStatuses(statuses, payload) {
    let next = Array.isArray(statuses) ? statuses : [];
    const revision = Number(payload.revision) || 1;
    for (const mark of payload.marks ?? []) {
        const current = next.find((item) => item?.subtaskId === mark.subtaskId);
        if (!current)
            continue;
        try {
            next = applyStatus(next, mark.subtaskId, {
                status: 'pending',
                progress: 0,
                summary: truncate(`已重规划：${mark.reason}`, 3000),
                error: null,
                closure: 'replanned',
                replannedReason: mark.reason,
                replannedAt: payload.at,
                replacedBy: mark.replacedBy,
                replannedFrom: String(current.status ?? 'pending'),
                replannedFromClosure: typeof current.closure === 'string' ? current.closure : null,
                revision,
                updatedBy: 'agent',
            });
        }
        catch {
            // 单个畸形历史行不应中断整次重规划回放；其余行照常应用。
        }
    }
    for (const added of payload.added ?? []) {
        if (next.some((item) => item?.subtaskId === added.subtaskId))
            continue;
        next = [
            ...next,
            {
                subtaskId: added.subtaskId,
                stageId: added.stageId,
                title: added.title,
                department: added.department,
                role: added.role,
                status: 'pending',
                progress: 0,
                childId: null,
                startedAt: null,
                finishedAt: null,
                summary: '',
                error: null,
                closure: 'pending',
                insertedBy: 'replan',
                replaces: added.replaces,
                planRevision: revision,
            },
        ];
    }
    return next;
}
/** durable `workplan-replan` 消息：正文 + 一行 JSON 载荷。 */
export function buildReplanMessage(payload) {
    const changed = payload.marks.map((mark) => `${mark.subtaskId}→${mark.replacedBy.length ? mark.replacedBy.join('、') : '撤销'}`);
    const summary = truncate(`【重规划 r${payload.revision}】${changed.join('，') || '新增子任务'}`, 300);
    const lines = [
        summary,
        '',
        `原因：${payload.reason}`,
        '旧行保留为已重规划（不计入剩余项、不再调度）；新行按 pending 进入下一轮。',
        '',
        REPLAN_MARKER_BEGIN,
        JSON.stringify(payload),
        REPLAN_MARKER_END,
    ];
    return makeUserMessage(lines.join('\n'), { kind: 'workplan-replan', form: 'notice', summary });
}
export function parseReplanMessage(message) {
    const text = messageText(message);
    const begin = text.indexOf(REPLAN_MARKER_BEGIN);
    const end = text.indexOf(REPLAN_MARKER_END);
    if (begin < 0 || end <= begin)
        return null;
    const body = text.slice(begin + REPLAN_MARKER_BEGIN.length, end).trim();
    try {
        const payload = JSON.parse(body);
        if (!isRecord(payload) || payload.kind !== 'workplan-replan')
            return null;
        if (!payload.plan || !Array.isArray(payload.marks) || !Array.isArray(payload.added))
            return null;
        return payload;
    }
    catch {
        return null;
    }
}
/** 计划定义里被重规划替换/撤销的行数；用于分母（definedSubtaskCount）。 */
export function supersededSubtaskCount(plan) {
    try {
        return flattenSubtasks(plan).filter((entry) => Boolean(entry.subtask?.supersededAt)).length;
    }
    catch {
        return 0;
    }
}
/* ------------------------------------------------------------------------- *
 * 执行中收到需求变更（C-12）：先记录、再通知，绝不静默丢弃。
 * ------------------------------------------------------------------------- */
export const CHANGE_MARKER_BEGIN = '<!-- DSH-WORKPLAN-CHANGE:BEGIN -->';
export const CHANGE_MARKER_END = '<!-- DSH-WORKPLAN-CHANGE:END -->';
/**
 * durable「执行中收到变更」记录。
 *
 * 这不是一条普通的用户消息：它把变更原文与序号写进会话，回放时据此恢复
 * `record.changeRequest`。模型看到的正文只做三件事——确认没丢、说明本轮不会
 * 打断正在跑的子任务、给出落实方式（replan / update）。
 */
export function buildChangeRequestMessage(payload, context = {}) {
    const active = Array.isArray(context?.activeSubtasks) ? context.activeSubtasks : [];
    const afterRound = context?.afterRound === true;
    const lines = [
        afterRound
            ? `【需求变更待落实 #${payload.seq}】上一轮执行中记录的要求还没有落进计划，不能静默收尾。`
            : `【需求变更已记录 #${payload.seq}】本轮计划正在执行，这条变更没有被丢弃。`,
        '',
        `变更内容：${truncate(payload.text, 1200)}`,
        active.length > 0
            ? `正在执行：${active.slice(0, 6).join('、')}（不会被中途改写；它们的产物仍然有效）`
            : '没有正在跑的子任务。',
        '',
        afterRound ? '落实方式（现在就处理，不要启动新一轮计划把它盖掉）：' : '落实方式（本轮派发结束后执行，不要静默收尾）：',
        '1. 变更影响范围：调用 dsh_workplan_replan，用 cancel/replace/add 逐项说明受影响的子任务；旧行会保留为「已重规划」并可追溯。',
        '2. 只是补充说明、不改范围：调用 dsh_workplan_update 把说明写进对应子任务的 note。',
        '3. 变更尚未明确：先向用户确认，再重规划；不要用旧计划直接交付。',
        '',
        CHANGE_MARKER_BEGIN,
        JSON.stringify(payload),
        CHANGE_MARKER_END,
    ];
    return makeUserMessage(lines.join('\n'), {
        kind: 'workplan-change',
        form: 'notice',
        summary: truncate(`需求变更已记录 #${payload.seq}`, 200),
    });
}
export function parseChangeRequestMessage(message) {
    const text = messageText(message);
    const begin = text.indexOf(CHANGE_MARKER_BEGIN);
    const end = text.indexOf(CHANGE_MARKER_END);
    if (begin < 0 || end <= begin)
        return null;
    try {
        const payload = JSON.parse(text.slice(begin + CHANGE_MARKER_BEGIN.length, end).trim());
        if (!isRecord(payload) || payload.kind !== 'workplan-change')
            return null;
        if (typeof payload.text !== 'string' || !payload.text.trim())
            return null;
        return {
            kind: 'workplan-change',
            planId: String(payload.planId ?? ''),
            seq: Number.isInteger(Number(payload.seq)) ? Number(payload.seq) : 1,
            at: Number(payload.at) || Date.now(),
            turn: Number.isInteger(Number(payload.turn)) ? Number(payload.turn) : null,
            text: truncate(payload.text, 4000),
        };
    }
    catch {
        return null;
    }
}
/** 从计划定义里读重规划修订号（写入时放在 plan.revision）。 */
export function planRevisionOf(plan) {
    const revision = Number(plan?.revision ?? 0);
    return Number.isFinite(revision) && revision > 0 ? revision : 0;
}
