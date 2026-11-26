import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Host half of dsh-workplan.
 *
 * Registers:
 *  - the agent/pre-step listener that commits a plan before step 1; dispatch is a model tool;
 *  - a short system-prompt section for the main agent's integration duties;
 *  - dsh_workplan_update and dsh_workplan_dispatch model tools;
 *  - the read-only dashboard route.
 */
import { applyHardeningHeaders, cancelToolOutputSchema, createWorkplanRuntime, dispatchToolOutputSchema, plannerOutputSchema, replanToolOutputSchema, statusToolOutputSchema, updateToolOutputSchema, } from './runtime.js';
import { DEPARTMENT_IDS, isRecord } from './plan.js';
// [3.1.0] 人数上限单一真源（caps.ts）：工具说明书与门禁/消毒/提示词同源。
import { MAX_COMPLEX_DELEGATE_MEMBERS, MIN_COMPLEX_DELEGATE_MEMBERS } from './caps.js';
import { autoResumeEnabledFrom } from './auto-resume.js';
import { pruneJournal } from './dept-journal.js';
// [3.2.9] 供应商 KV 前缀缓存只读计量：只观察 usage，不修改模型请求。
import { cacheMeterEnabled, observeLlmStream, renderCacheSummary } from './cache-meter.js';
/*
 * [1.8.14] Identity of the modules this process actually loaded (N1).
 *
 * `version` alone cannot answer "is the running process the build I just
 * shipped": the same version can be rebuilt, and a profile recomposition can
 * leave stale modules in memory while the files on disk are new. Hashing the
 * compiled entry files that make up the plugin at activation time gives a
 * value that changes whenever the loaded bytes change. It is computed once, so
 * it cannot drift during the process's life.
 *
 * [1.8.15] `watchdog.js` was missing from the list even though runtime.ts
 * imports it and the build copies it next to the other entries. Appending a
 * line to it left the fingerprint unchanged (T5c §6.1) — a build identity that
 * ignores a loaded module is a false negative, exactly what it exists to catch.
 *
 * [3.2.4][治本] 手写清单的宿命就是「新增模块必漏」：1.8.15 补了 watchdog.js，
 * 3.2.4 新增 step-budget.js 之后同一个洞又开了一次——模块真的被加载、被改，
 * 指纹却纹丝不动，于是 status 报出的 build 值无法证明「跑的是哪几份字节」。
 * 现在改为**按目录枚举**所有 .js 模块（排序后逐个入哈希）：磁盘上多一个、
 * 少一个、改一个，指纹必然变化，不再依赖有人记得维护清单。
 *
 * 为什么排除 client.js：它是浏览器端 bundle，宿主进程从不加载它，而且生产
 * 布局里它位于包根目录（不随 lib/ 落盘），把它算进来会让 dist/ 与 lib/ 两个
 * 目录枚举出不同集合——指纹就会取决于「从哪里加载」，反而制造假差异。
 */
const LOADED_BUILD = (() => {
    try {
        const entryPath = fileURLToPath(import.meta.url);
        const dir = dirname(entryPath);
        const hash = createHash('sha256');
        /*
         * 枚举失败（沙箱限制、非常规打包布局）才回退到关键入口清单：回退仍然
         * fail-open，绝不因为算指纹而阻断插件激活。
         */
        const modules = (() => {
            try {
                return readdirSync(dir)
                    .filter((name) => name.endsWith('.js') && name !== 'client.js')
                    .sort();
            }
            catch {
                return ['host.js', 'plan.js', 'runtime.js', 'watchdog.js'];
            }
        })();
        for (const file of modules)
            hash.update(readFileSync(join(dir, file)));
        return { entryPath, buildHash: hash.digest('hex').slice(0, 16) };
    }
    catch {
        /*
         * Never fail activation for a diagnostic. An unknown fingerprint is still a
         * truthful answer ("I cannot prove which bytes I am"), and `status` will
         * show `unknown` instead of a fabricated hash.
         */
        return { entryPath: '', buildHash: 'unknown' };
    }
})();
/*
 * Process start time derived from `process.uptime()`, so it is the actual OS
 * process start, not the moment the plugin was constructed. Used to tell
 * "restarted after the fix" from "same process, rebuilt files on disk".
 */
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);
/*
 * [3.0.6][第 2 批] 静态图表资产只读一次。
 * 旧实现每次请求都 readFileSync 210KB（看板每次加载都拉一次），在请求路径上
 * 做磁盘 I/O 没有必要：vendor 文件随插件发布、运行期不会变。缓存 Buffer 后
 * 后续请求直接复用；读取失败不缓存，下次仍会重试。
 */
let chartVendorBytes = null;
/*
 * [3.1.6][省钱三件套 ①] 工具按角色裁剪（只改「声明」，不改判定）。
 *
 * 现状：14 个 workplan 工具对根 / 部门负责人 / 第三层专家一视同仁全量注入，
 * 而其中 10 个只有根会话能用（runtime 里 isRootSession 硬拒），专家每步都在为
 * 用不到的工具说明书付 token（T8 量化：工具未裁剪占可避免浪费 61.6%）。
 *
 * 这里先用「结构性事实」收窄声明面：parentSession 与 delegationDepth 由宿主
 * 在建会话时写入，不依赖计划台账，因此不会因台账缺失/重建而误判。
 *   - 根会话（无 parentSession、非 origin=subagent、depth=0）→ 根专用工具 +
 *     instruct 全量；但 delegate/escalate/verify 三件根会话必然调不通的工具
 *     不注入（见下方 ROOT_UNUSABLE_TOOLS，3.1.9）；
 *   - 其余会话 → 先隐藏 10 个根专用工具（含 lessons：runtime 只允许根会话读）；
 *   - depth>=2（第三层专家）→ 再隐藏 instruct（只给根/负责人用）。
 *
 * [3.1.6 回归修正] delegate 绝不能对叶子隐藏：叶子唯一的开工登记入口就是
 * `dsh_workplan_delegate(action="self_effort")`，全仓并没有名为
 * `dsh_workplan_self_effort` 的独立工具。首版裁剪把它当成「负责人专用」工具
 * 对 depth>=2 隐藏，直接把叶子的 phase-0 门禁堵死（现场表现：叶子只剩
 * escalate/lessons/verify 三个工具，无法登记 self_effort）。
 *
 * 判定一律 fail-open：拿不准就保留，宁可多付 token 也不能让工具凭空消失。
 * 权威权限校验仍在 execute 内部，这里只是少给说明书，不改变任何拒绝语义。
 */
const ROOT_ONLY_TOOLS = new Set([
    'dsh_workplan_update',
    'dsh_workplan_replan',
    'dsh_workplan_cancel',
    'dsh_workplan_followup',
    'dsh_workplan_hold',
    'dsh_workplan_release',
    'dsh_workplan_handoff',
    'dsh_workplan_status',
    'dsh_workplan_dispatch',
    'dsh_workplan_lessons',
]);
/** 只给根与部门负责人：负责人用 instruct 答复自己派出的叶子。 */
const HEAD_ONLY_SUPPLEMENT_TOOLS = new Set(['dsh_workplan_instruct']);
/*
 * [3.1.9][省钱] 根会话永远用不到的三件工具说明书。
 *
 * 机制事实（不是猜测）：
 *  - `dsh_workplan_delegate` 在 execute 入口先看 `session.header.parentSession`；
 *    根会话没有父会话，命中 NOT_LEADER_SESSION，永远不可能成功。
 *  - `dsh_workplan_escalate` 只服务「已在计划行登记 childId 的子会话」或
 *    「第三层叶子」；根会话既不是子会话，也没有可请示的父行，调用只会得到
 *    NO_PLAN/NO_SUBTASK。
 *  - `dsh_workplan_verify` 的入口要求 `session.header.parentSession`（第四步
 *    核验只对已派发的部门子任务开放），根会话调用只会得到 NOT_CHILD_SESSION。
 *
 * 旧实现把这三份说明书也注入根会话（按运行时 request/header 实测，
 * 三项合计 11,585 字符），每步付费、且会诱导模型调用一个必然被拒的工具。
 * 3.1.9 只在「声明面」
 * 隐藏它们，execute 内的权限硬校验一字不动；子会话（负责人/叶子）照旧
 * 可见，能力零损失。仍按 fail-open：没有 header 的未知会话继续全量。
 */
const ROOT_UNUSABLE_TOOLS = new Set([
    'dsh_workplan_delegate',
    'dsh_workplan_escalate',
    'dsh_workplan_verify',
]);
function sessionDelegationDepth(session) {
    const header = session?.header;
    if (!header)
        return 0;
    if (typeof header.delegationDepth === 'number' && Number.isFinite(header.delegationDepth))
        return header.delegationDepth;
    return header.parentSession ? 1 : 0;
}
function firstSessionPromptText(session) {
    if (!session || typeof session.eventAt !== 'function')
        return '';
    const limit = Math.min(4, typeof session.seq === 'number' ? session.seq : 4);
    for (let i = 0; i < limit; i += 1) {
        const ev = session.eventAt(i);
        if (!ev || ev.type !== 'user/message')
            continue;
        const content = ev.data?.message?.content ?? ev.data?.content;
        if (typeof content === 'string' && content.trim())
            return content;
        if (Array.isArray(content)) {
            const text = content
                .filter((part) => part && typeof part.text === 'string')
                .map((part) => part.text)
                .join('\n');
            if (text.trim())
                return text;
        }
    }
    return '';
}
/**
 * [3.3.0][极致省 token·阶段裁剪] 基于子会话首条不可变提示词判定阶段（KV 缓存零抖动）：
 *  - leader-phase-0：仅需 delegate(review/direct) + escalate，隐藏 verify(1.2KB) + instruct；
 *  - leaf-phase-0：仅需 delegate(self_effort) + escalate，隐藏 verify(1.2KB)；
 *  - leaf-phase-1：已完成自配档且禁派第四层，隐藏 delegate(2.6KB，每步省 63% 工具说明书！)；
 *  - 无首条事件/无法识别：返回 null（fail-open 沿用既有角色白名单）。
 */
export function detectChildToolPhase(session, depth) {
    const prompt = firstSessionPromptText(session);
    if (!prompt)
        return null;
    if (depth >= 2) {
        if (prompt.includes('，phase-0（先配置后开工'))
            return 'leaf-phase-0';
        if (prompt.includes('只负责末尾【你的分工】里那一项工作'))
            return 'leaf-phase-1';
        return null;
    }
    if (depth === 1 && prompt.includes('执行负责人，phase-0（先配置后开工')) {
        return 'leader-phase-0';
    }
    return null;
}
/** 这一步是否把某工具的说明书交给该 Agent；fail-open（异常一律可见）。 */
export function workplanToolAdmitted(toolName, session) {
    try {
        const header = session?.header;
        if (!header)
            return true;
        const depth = sessionDelegationDepth(session);
        const rootLike = !header.parentSession && header.origin !== 'subagent' && depth === 0;
        if (rootLike)
            return !ROOT_UNUSABLE_TOOLS.has(toolName);
        if (ROOT_ONLY_TOOLS.has(toolName))
            return false;
        if (HEAD_ONLY_SUPPLEMENT_TOOLS.has(toolName)) {
            if (depth > 1)
                return false;
            const phase = detectChildToolPhase(session, depth);
            if (phase === 'leader-phase-0')
                return false;
            return true;
        }
        const phase = detectChildToolPhase(session, depth);
        if (phase === 'leader-phase-0' || phase === 'leaf-phase-0') {
            if (toolName === 'dsh_workplan_verify')
                return false;
        }
        if (phase === 'leaf-phase-1') {
            if (toolName === 'dsh_workplan_delegate')
                return false;
        }
        // delegate 在未知/phase-0 子会话一律保留：叶子 phase-0 要用 action="self_effort" 开工登记。
        return true;
    }
    catch {
        return true;
    }
}
/*
 * [3.1.6][省钱三件套 ②] 系统提示分段：主 Agent 专属段不再注入子 Agent。
 *
 * PROMPT_SECTION（3.2.3 实测 3,579 字符）通篇面向「主 Agent」写（生成计划、审计划、
 * 派发、收尾交付），部门负责人/第三层专家有自己的任务书（buildChildPrompt /
 * buildDelegateePrompt），再读这段既无用又按步计费。
 * 做法：在子 Agent 的 agent.ctx 里注册同名 section —— 官方语义是
 * 「scoped section shadows a global section with the same name」，于是全局段
 * 对该 Agent 被替换成一句子会话提示。根会话（无 parentSession、非子 Agent、
 * depth=0）不动，保持原文。注册失败一律 fail-open：子会话继续看到全局段，
 * 只多花 token，不影响任何功能。
 */
const PROMPT_SHADOW_REGISTERED = new WeakSet();
const CHILD_PROMPT_SHADOW = [
    '本会话是 dsh-workplan 的子会话：按任务书执行，不要生成或改写主计划；',
    '主计划的创建、派发、审阅与最终交付由主 Agent 负责。',
].join('');
function shadowWorkplanPromptForChild(agent) {
    try {
        const session = agent?.session;
        const header = session?.header;
        if (!header)
            return;
        if (!header.parentSession && header.origin !== 'subagent' && sessionDelegationDepth(session) === 0)
            return;
        if (PROMPT_SHADOW_REGISTERED.has(agent))
            return;
        const scoped = agent?.ctx;
        if (!scoped?.systemPrompt || typeof scoped.systemPrompt.section !== 'function')
            return;
        scoped.systemPrompt.section({ name, order: PROMPT_ORDER, text: CHILD_PROMPT_SHADOW });
        PROMPT_SHADOW_REGISTERED.add(agent);
    }
    catch {
        /* fail-open：注册不上就保留全局段（多付 token，不少能力）。 */
    }
}
const toolWhen = (name) => (activation) => workplanToolAdmitted(name, activation?.agent?.session);
function phaseLabel(phase) {
    if (phase === 'paused')
        return '本轮预算用尽，可续跑';
    if (phase === 'blocked')
        return '卡住了';
    if (phase === 'done')
        return '已完成';
    if (phase === 'executing')
        return '正在做';
    if (phase === 'planning')
        return '正在安排';
    if (phase === 'integrating')
        return '正在收尾';
    if (phase === 'cancelled')
        return '已取消';
    return String(phase ?? '');
}
export const name = 'dsh-workplan';
export const inject = ['tools', 'systemPrompt', 'llm', 'subagents', 'sessions'];
export const PROMPT_ORDER = 40;
/*
 * [3.1.5] 版本号唯一来源：提示词里对外声明的版本与 meta.version 必须同源。
 *
 * 事故（2026-11-20 排查 wp-cff638b6）：PROMPT_SECTION 里硬编码的是「3.1.0 版本…
 * 本插件当前版本为 3.1.0」，而 meta.version 早已是 3.1.2。主 Agent 读提示词
 * 自报版本时被误导，用户也拿不到真实版本（用户要求 13/G 要如实报告版本）。
 * 硬编码字符串与 meta 双写是根因，改为同一常量派生。
 */
export const PLUGIN_VERSION = '3.3.1';
const PROMPT_SECTION = [
    '本会话已启用自动任务分解。新任务首步前生成【任务分解】；分配任务前必须先告知预估耗时（由平台自动发【规划预告】/【派发预告】与固定文案「任务正在分配中，请稍等一下......」「任务已经完成分配，正在执行中......」，勿重复、勿改任务原文）；需派发/续跑调 dsh_workplan_dispatch（默认 wait，长任务 mode: "async" 后用 dsh_workplan_status 查进度；后台生成中先等待）。',
    `质量与原子门禁：子任务须含 qualityRequirements（缺拒 DISPATCH_QUALITY_REQUIREMENTS_MISSING / DELEGATE_QUALITY_REQUIREMENTS_MISSING，replan 补齐）；单句 ≤300 字单目标单产物无并列词（DELEGATE_TASK_NOT_ATOMIC）；role 仅 expert；专家交 F10 report，负责人交 F11 departmentSummary。${PLUGIN_VERSION} 版本（用户要求 13）：对外一律写 ${PLUGIN_VERSION}。`,
    '主 Agent 五步开工证据协议（3.0.8）：首次 dispatch 须附 startPhases——第一步全面、全盘、深入梳理、研究、思考自己的任务；第二步基于刚才第一步完成好的所有结果，再全面、全盘、深入地开展梳理、研究和思考（资源、工具与少走弯路的方法、流程和步骤及 approachBasis）；第三步备齐资源工具并给就绪证据（缺/不达标硬拒 START_EVIDENCE_MISSING / START_EVIDENCE_INCOMPLETE，重规划须重交）。',
    'plan 模式禁 dispatch；寒暄/确认/“继续”/问进度不分解；降级先报原因等确认。交付判据：全 done 且 deliveryReady=true（verification="structured" 且 acceptance 全 pass），取消≠完成；未就绪禁 present，开头写「未完成：剩余 N 项与原因」并继续 dispatch。最终答复 ≤800 字（紧扣用户原意，不复述证据 JSON）。',
    '无执行时限：不设总时长、单次时长、空闲无进展或回执硬截止，不得仅因执行较久、暂时无新事件或未立即回执而中止；estimateMinutes、timeNotice、timeSpentMinutes 只用于协调与告知，extendMs 已停用（TIME_LIMITS_DISABLED）；用户显式取消、真实执行错误、证据/质量门禁仍然有效。',
    '闭环：①待指示（escalated）用 dsh_workplan_instruct 答复或 update 置 blocked；②ackOverdue 先 status 必要时 followup；③需求变更用 replan 后 dispatch，补说明用 update.note；④「跨部门待转达」（needs）用 dsh_workplan_handoff 处置完，否则拦 present；⑤第四步复盘自动落永久记忆（dsh_workplan_lessons 只读查询，occurrences≥2 写入后续约束）。',
].join('\n');
/**
 * Seconds a dispatch has been running, from the payload only.
 *
 * `elapsedMs` is authoritative; `startedAt` is the fallback for a payload that
 * carries no elapsed value. Computing this inside the template mixed `??` with
 * a conditional and could silently print the wrong number.
 */
function elapsedSeconds(result) {
    const elapsed = Number(result?.elapsedMs);
    if (Number.isFinite(elapsed) && elapsed >= 0)
        return elapsed;
    const startedAt = Number(result?.startedAt);
    return Number.isFinite(startedAt) && startedAt > 0 ? Date.now() - startedAt : 0;
}
function textContent(text) {
    return [{ type: 'text', text }];
}
function asObject(value) {
    if (isRecord(value))
        return value;
    if (typeof value === 'string' && value.trim() !== '') {
        try {
            const parsed = JSON.parse(value);
            return isRecord(parsed) ? parsed : null;
        }
        catch {
            return null;
        }
    }
    return null;
}
function createUpdateTool(runtime) {
    return {
        name: 'dsh_workplan_update',
        description: '更新子任务状态/证据（done 需 structured + acceptance 全 pass）或登记 timeNotice。',
        parameters: {
            type: 'object',
            properties: {
                planId: { type: 'string' },
                subtaskId: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'] },
                progress: { type: 'integer' },
                evidence: { type: 'array', items: { type: 'string' } },
                verification: { type: 'string', enum: ['structured', 'legacy', 'unverified', 'failed'] },
                acceptance: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            criterion: { type: 'string' },
                            result: { type: 'string', enum: ['pass', 'fail', 'unverified'] },
                            evidence: { type: 'string' },
                        },
                        required: ['criterion', 'result'],
                        additionalProperties: false,
                    },
                },
                artifacts: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            kind: { type: 'string', enum: ['file', 'url', 'note'] },
                            ref: { type: 'string' },
                            exists: { type: 'boolean' },
                        },
                        required: ['kind', 'ref'],
                        additionalProperties: false,
                    },
                },
                missingArtifacts: { type: 'array', items: { type: 'string' } },
                expectedRevision: { type: 'integer' },
                force: { type: 'boolean' },
                note: { type: 'string' },
                instruction: { type: 'string' },
                timeNotice: {
                    type: 'object',
                    properties: {
                        declaredMinutes: { type: 'number' },
                        reason: { type: 'string' },
                    },
                    required: ['declaredMinutes'],
                    additionalProperties: false,
                },
            },
            /*
             * [3.2.4] status 不再是无条件必填：纯开工预告（只带 timeNotice）是合法
             * 调用，runtime 按「只记录、不改判定」处理；普通改判缺 status 仍由
             * runtime 以 INVALID_STATUS 拒绝。
             */
            required: ['subtaskId'],
            additionalProperties: false,
        },
        output: {
            schema: updateToolOutputSchema(),
            render(_args, value) {
                const result = isRecord(value) ? value : {};
                const stats = isRecord(result.stats) ? result.stats : {};
                const text = result.ok
                    ? `已更新子任务 ${String(result.subtaskId ?? '')}：${String(result.status ?? '')}`
                        + `（完成 ${Number(stats.done ?? 0)}/${Number(stats.total ?? 0)}，受阻 ${Number(stats.blocked ?? 0)}）`
                    : `更新失败${result.code ? `（${String(result.code)}）` : ''}：${String(result.error ?? result.hint ?? '未知错误')}`;
                return textContent(text);
            },
        },
        async execute(args, exec) {
            const parsed = asObject(args);
            if (!parsed)
                throw new Error('参数必须是 JSON 对象');
            const result = await runtime.updateStatus(exec.agent, parsed);
            return result;
        },
    };
}
/**
 * [1.11.0] 需求变更 → 重规划的唯一入口（T4 C-11 / T7）。
 *
 * 触发条件写在工具描述里，因为「什么时候该重规划」是语义判断，代码不猜：
 *  - 执行中用户提出新要求、原安排不再成立；
 *  - 验收标准/交付物变化，旧子任务的完成不再等于用户要的结果；
 *  - 上游结论推翻了后续步骤的前提。
 * 只补说明、不改范围时不要用本工具（那会白白留下一批“已重规划”旧行），
 * 改用 `dsh_workplan_update` 的 note。
 *
 * 旧状态不删除：`planReplan()` 在计划定义上写 `supersededAt/replacedBy`，
 * `applyReplanStatuses()` 在状态条上写 `closure:'replanned'` + `replannedFrom`，
 * 两者是同一次写入的两个镜像；旧行保留可追溯、不计入剩余项、不再调度。
 * 重规划本身不执行新行——必须再调用 `dsh_workplan_dispatch`。
 */
function createReplanTool(runtime) {
    return {
        name: 'dsh_workplan_replan',
        description: '需求变更重规划（cancel/replace/add）；执行中返回 REPLAN_PLAN_RUNNING；成功后须再 dispatch。',
        parameters: {
            type: 'object',
            properties: {
                planId: { type: 'string' },
                reason: { type: 'string' },
                changeText: { type: 'string' },
                changes: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 12,
                    items: {
                        type: 'object',
                        properties: {
                            subtaskId: { type: 'string' },
                            action: { type: 'string', enum: ['cancel', 'replace', 'add'] },
                            reason: { type: 'string' },
                            replacement: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string' },
                                    title: { type: 'string' },
                                    department: { type: 'string', enum: [...DEPARTMENT_IDS] },
                                    role: { type: 'string' },
                                    objective: { type: 'string' },
                                    method: { type: 'array', items: { type: 'string' } },
                                    inputs: { type: 'array', items: { type: 'string' } },
                                    outputs: { type: 'array', items: { type: 'string' } },
                                    acceptance: { type: 'array', items: { type: 'string' } },
                                    qualityRequirements: { type: 'array', items: { type: 'string' } },
                                    reasoningEffort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
                                    risk: { type: 'string' },
                                },
                                additionalProperties: false,
                            },
                            newSubtask: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string' },
                                    title: { type: 'string' },
                                    objective: { type: 'string' },
                                    department: { type: 'string', enum: [...DEPARTMENT_IDS] },
                                    role: { type: 'string' },
                                    method: { type: 'array', items: { type: 'string' } },
                                    inputs: { type: 'array', items: { type: 'string' } },
                                    outputs: { type: 'array', items: { type: 'string' } },
                                    acceptance: { type: 'array', items: { type: 'string' } },
                                    dependsOn: { type: 'array', items: { type: 'string' } },
                                    qualityRequirements: { type: 'array', items: { type: 'string' } },
                                    reasoningEffort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
                                    risk: { type: 'string' },
                                    reason: { type: 'string' },
                                },
                                required: ['title', 'objective'],
                                additionalProperties: false,
                            },
                        },
                        required: ['subtaskId', 'action'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['reason', 'changes'],
            additionalProperties: false,
        },
        output: {
            schema: replanToolOutputSchema(),
            render(_args, value) {
                const result = isRecord(value) ? value : {};
                if (!result.ok) {
                    return textContent(`重规划失败${result.code ? `（${String(result.code)}）` : ''}：${String(result.error ?? result.hint ?? '未知错误')}`
                        + (result.code === 'REPLAN_PLAN_RUNNING'
                            ? '｜变更已记录，等本轮结束（dispatch 返回后）再用同一组 changes 重试。'
                            : ''));
                }
                const marks = Array.isArray(result.marks) ? result.marks : [];
                const added = Array.isArray(result.added) ? result.added : [];
                const changed = marks
                    .map((mark) => `${String(mark?.subtaskId ?? '')}→${Array.isArray(mark?.replacedBy) && mark.replacedBy.length > 0 ? mark.replacedBy.join('、') : '撤销'}`)
                    .join('，');
                const fresh = added.map((item) => String(item?.subtaskId ?? '')).filter(Boolean).join('、');
                return textContent(`计划 ${String(result.planId ?? '')} 已重规划为修订 r${Number(result.planRevision ?? 0)}`
                    + (changed ? `｜受影响：${changed}` : '')
                    + (fresh ? `｜新增：${fresh}` : '')
                    + '｜旧行保留为「已重规划」（可追溯、不计入剩余项、不再调度）'
                    + '｜下一步：调用 dsh_workplan_dispatch 执行新行。');
            },
        },
        async execute(args, exec) {
            const parsed = asObject(args) ?? {};
            return runtime.replanPlan(exec.agent, parsed);
        },
    };
}
function createCancelTool(runtime) {
    return {
        name: 'dsh_workplan_cancel',
        description: '取消（cancelled）或取代（superseded，须满足 V1-V8 映射覆盖与用户确认）计划；取消≠完成。',
        parameters: {
            type: 'object',
            properties: {
                planId: { type: 'string' },
                reason: { type: 'string' },
                disposition: { type: 'string', enum: ['cancelled', 'superseded'] },
                supersededBy: {
                    type: 'object',
                    properties: {
                        planId: { type: 'string' },
                        mapping: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    from: { type: 'string' },
                                    to: { type: 'string' },
                                    basis: { type: 'string' },
                                },
                                required: ['from', 'to', 'basis'],
                                additionalProperties: false,
                            },
                        },
                    },
                    required: ['planId', 'mapping'],
                    additionalProperties: false,
                },
            },
            additionalProperties: false,
        },
        output: {
            schema: cancelToolOutputSchema(),
            render(_args, value) {
                const result = isRecord(value) ? value : {};
                if (!result.ok) {
                    return textContent(`处置失败${result.code ? `（${String(result.code)}）` : ''}：`
                        + `${String(result.error ?? '未知错误')}`);
                }
                const stats = isRecord(result.stats) ? result.stats : {};
                if (result.phase === 'superseded') {
                    const by = isRecord(result.supersededBy) ? result.supersededBy : {};
                    return textContent(`计划 ${String(result.planId ?? '')} 已被取代：承接计划 ${String(by.planId ?? '')}`
                        + `（映射 ${Number(by.coveredCount ?? 0)}/${Number(by.requiredCount ?? 0)}，digest 已复算）`
                        + `｜源计划仍是 ${Number(stats.done ?? 0)}/${Number(stats.total ?? 0)}：被取代不等于完成，`
                        + '不得 present 源计划，只能使用承接计划通过交付就绪检查的产物。');
                }
                const cancelledIncomplete = result.phase !== 'done';
                return textContent(`已取消计划 ${String(result.planId ?? '')}：${String(result.reason ?? '用户取消')}`
                    + `（完成 ${Number(stats.done ?? 0)}/${Number(stats.total ?? 0)}）`
                    + (cancelledIncomplete
                        ? '｜计划仍未完成：不要 present，不要写“已完成”；答复按「未完成：剩余 N 项与原因」开头。'
                        : '｜计划此前已全部 done。'));
            },
        },
        async execute(args, exec) {
            const parsed = asObject(args);
            if (!parsed)
                throw new Error('参数必须是 JSON 对象');
            return runtime.cancelPlan(exec.agent, parsed);
        },
    };
}
function createFollowupTool(runtime) {
    return {
        name: 'dsh_workplan_followup',
        description: '向直接子会话投递 follow-up 说明（不改状态、不等于完成）。',
        parameters: {
            type: 'object',
            properties: {
                sessionId: {
                    type: 'string',
                },
                message: {
                    type: 'string',
                },
            },
            required: ['sessionId', 'message'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    sessionId: { type: 'string' },
                    messageId: { type: 'string' },
                    code: { type: 'string' },
                    error: { type: 'string' },
                },
                required: ['ok'],
                additionalProperties: true,
            },
            render(_args, value) {
                const result = isRecord(value) ? value : {};
                if (!result.ok) {
                    return textContent(`follow-up 未投递：${String(result.error ?? result.code ?? '未知错误')}`);
                }
                return textContent(`已向子会话 ${String(result.sessionId ?? '')} 投递 follow-up`
                    + (result.messageId ? `（messageId ${String(result.messageId)}）` : '')
                    + '。投递只代表消息被接收；界面状态要等该子会话自己的回合正常结束才会变化。');
            },
        },
        async execute(args, exec) {
            const parsed = asObject(args) ?? {};
            return runtime.followupTool(exec.agent, parsed, exec.signal);
        },
    };
}
/**
 * [1.11.0] 子 → 父的唯一反向通道（T4 C-09 / T6 M5）。
 *
 * 为什么要有独立工具而不是让子 Agent 在结果块里写 `question`：结果块只在
 * 子会话结束时才被父会话看到，那时子会话已经停了，请示与「已结束」无法区分，
 * 主 Agent 只会在下一次 dispatch 之后才发现有人在等回答。这个工具把请示
 * 提前到「还在跑」的时刻，并在状态条上留下 `closure:'escalated'`。
 */
function createEscalateTool(runtime) {
    return {
        name: 'dsh_workplan_escalate',
        description: '子 Agent/专家遇阻上报置「待指示」，随后停写待父会话 instruct 答复（答复前禁止改派）。',
        parameters: {
            type: 'object',
            properties: {
                subtaskId: {
                    type: 'string',
                },
                question: {
                    type: 'string',
                },
                options: {
                    type: 'array',
                    items: { type: 'string' },
                },
                needs: {
                    type: 'array',
                    items: { type: 'string' },
                },
            },
            required: ['question'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    planId: { type: 'string' },
                    subtaskId: { type: 'string' },
                    status: { type: 'string' },
                    closure: { type: 'string' },
                    question: { type: 'string' },
                    code: { type: 'string' },
                    error: { type: 'string' },
                    message: { type: 'string' },
                },
                required: ['ok'],
                additionalProperties: true,
            },
            render(_args, value) {
                const result = isRecord(value) ? value : {};
                if (!result.ok) {
                    return textContent(`上报未登记：${String(result.error ?? result.code ?? '未知错误')}`
                        + '｜改为在结果块里写 "status":"blocked" 并附 "question"，仍然算作请示。');
                }
                return textContent(`${String(result.subtaskId ?? '')} 已登记为「待指示」`
                    + (result.alreadyEscalated ? '（此前已登记，未重复提交）' : '')
                    + `：${String(result.question ?? '')}`
                    + '｜现在停止推进，只做只读核对；等待主 Agent/部门负责人指示后再继续。第三层请示在答复前禁止改派给其他专家。');
            },
        },
        async execute(args, exec) {
            const parsed = asObject(args) ?? {};
            return runtime.escalateTool(exec.agent, parsed);
        },
    };
}
/**
 * [2.3.9][T4b] 第三层派发工具（用户强制要求 4/5）：部门负责人专用。
 *
 * 用户要求 4 原文：「分到相关任务的相关部门的负责人，必须再将你分配的任务，
 * 通过自己全面、全盘、深入开展梳理、研究、思考后，再合理分配相关任务给本部门
 * 相关领域全球顶尖专家（部门组员角色已取消）。」
 *
 * 落地为两步硬流程（服务端校验，提示词绕不过）：
 *  - `review`：提交「开工证据 + 分工表」（startPhases 五步第 1/2/3 步 +
 *    每位下级的 member/role/task/reasoningEffort）；分工表必须同时含
 *    ≥1 名 expert（顶尖专家）；部门组员角色已取消（3.0.0）。
 *  - `dispatch`：未登记 review 产物 ⇒ 硬门禁拒绝；登记后为每位下级派生
 *    第三层子会话（叶子层，第四层被宿主绝对深度上限硬拒），推理等级按
 *    当前模型家族合法集合（qwen→low/medium/xhigh；非qwen→low/high/max）
 *    钳制并留痕，随 agentOptions 全程生效（要求 5）。
 *  - `direct`：[2.5.5][T3] low（含未配置视同 low）任务负责人亲自执行登记：
 *    仅收 startPhases 开工证据（problemAnalysis/approach ≥40 字、approachBasis/
 *    resources/prepared/evidence ≥20 字、tools ≥10）＋可选 reasoningEffort='low'，
 *    拒 consolidation/分工表。[3.2.3] 顺序推理链任务例外：负责人亲自执行必须
 *    自评复杂档 reasoningEffort（qwen: medium/xhigh；非 qwen: high/max），不得
 *    low——缺失/low/非本家族合法档硬拒；登记后平台按该档接续（另起执行会话）
 *    亲自执行（文档同步，门禁在 runtime/llm-rules）。
 *
 * 权限模型与 escalate 同款：注册在插件根、对所有会话可见，`execute` 内部由
 * runtime.delegateTool 按「调用者必须是计划内某行的部门负责人子会话」硬校验。
 */
function createDelegateTool(runtime) {
    return {
        name: 'dsh_workplan_delegate',
        description: `负责人/专家派发工具：review(startPhases+consolidation)、dispatch(派 expert，${MIN_COMPLEX_DELEGATE_MEMBERS}-${MAX_COMPLEX_DELEGATE_MEMBERS}人)、direct(亲自执行：普通 low/顺序链复杂档)、status(查状态)、self_effort(专家自配档+依据+startPhases+timeNotice)。`,
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['review', 'dispatch', 'direct', 'status', 'self_effort'], description: 'review/dispatch/direct/status/self_effort（self_effort 须附 timeNotice 开工前预估）' },
                reasoningEffort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
                complexityRationale: { type: 'string' },
                complexityReason: { type: 'string', enum: ['facts', 'dependencies', 'verification-difficulty'] },
                member: { type: 'string' },
                startPhases: {
                    type: 'object',
                    properties: {
                        planning: {
                            type: 'object',
                            properties: {
                                problemAnalysis: { type: 'array', items: { type: 'string' } },
                                resources: { type: 'array', items: { type: 'string' } },
                                tools: { type: 'array', items: { type: 'string' } },
                                approach: { type: 'array', items: { type: 'string' } },
                                approachBasis: { type: 'array', items: { type: 'string' } },
                            },
                            required: ['problemAnalysis', 'approach', 'approachBasis', 'resources', 'tools'],
                            additionalProperties: false,
                        },
                        preparation: {
                            type: 'object',
                            properties: {
                                prepared: { type: 'array', items: { type: 'string' } },
                                evidence: { type: 'array', items: { type: 'string' } },
                            },
                            required: ['prepared', 'evidence'],
                            additionalProperties: false,
                        },
                    },
                    required: ['planning', 'preparation'],
                    additionalProperties: false,
                },
                timeNotice: {
                    type: 'object',
                    description: 'self_effort 必填：开工前预估耗时（整数分钟；缺/非法硬拒 ESTIMATE_MISSING / ESTIMATE_INVALID）',
                    properties: {
                        declaredMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
                        reason: { type: 'string' },
                    },
                    required: ['declaredMinutes'],
                    additionalProperties: false,
                },
                consolidation: {
                    type: 'object',
                    properties: {
                        taskReasoningEffort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
                        assignments: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    member: { type: 'string' },
                                    role: { type: 'string', enum: ['expert'] },
                                    task: { type: 'string' },
                                    qualityRequirements: { type: 'array', items: { type: 'string' } },
                                    reasoningEffort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
                                    startPhases: { type: 'object' },
                                    timeNotice: { type: 'object' },
                                },
                                required: ['member', 'role', 'task', 'qualityRequirements'],
                                additionalProperties: false,
                            },
                        },
                    },
                    required: ['assignments'],
                    additionalProperties: false,
                },
            },
            required: ['action'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    planId: { type: 'string' },
                    subtaskId: { type: 'string' },
                    action: { type: 'string' },
                    code: { type: 'string' },
                    error: { type: 'string' },
                    hint: { type: 'string' },
                    consolidation: { type: 'object' },
                    members: { type: 'array', items: { type: 'object' } },
                    delegates: { type: 'array', items: { type: 'object' } },
                    clamped: { type: 'array', items: { type: 'object' } },
                },
                required: ['ok'],
                additionalProperties: true,
            },
            render(_args, value) {
                const result = isRecord(value) ? value : {};
                if (!result.ok) {
                    return textContent(`第三层派发未执行：${String(result.error ?? result.code ?? '未知原因')}`);
                }
                if (result.action === 'review') {
                    const members = Array.isArray(result.members) ? result.members : [];
                    const clamped = Array.isArray(result.clamped) ? result.clamped : [];
                    return textContent(`梳理产物已登记（${String(result.subtaskId ?? '')}）：分工 ${members.length} 名专家`
                        + `（全部为 expert；部门组员角色已取消）`
                        + (clamped.length ? `；越界等级已钳制 ${clamped.length} 条（${clamped.map((c) => `${c.member}:${c.requested}→${c.corrected}`).join('、')}）` : '')
                        + '｜下一步：action="dispatch" 正式派发。');
                }
                if (result.action === 'dispatch') {
                    const delegates = Array.isArray(result.delegates) ? result.delegates : [];
                    return textContent(`第三层已派发 ${delegates.length} 人：`
                        + delegates.map((d) => `${d?.member ?? '?'}(专家/${d?.effort ?? '?'}/${d?.status ?? '?'})`).join('、')
                        + '｜下级结论会送回本会话；收齐汇总核验后再写最终结果块。action="status" 可查看进度。');
                }
                if (result.action === 'direct') {
                    const effort = String(result.effectiveEffort ?? result.reasoningEffort ?? 'low');
                    return textContent(`${String(result.subtaskId ?? '')} 亲自执行开工证据已登记（档位 ${effort}）`
                        + (result.continued ? '｜平台已按该档接续 phase-1，请勿重做前三步。' : `｜${String(result.hint ?? '可直接开始第四步执行。')}`));
                }
                if (result.action === 'self_effort') {
                    const effort = String(result.selfEffort ?? result.effectiveEffort ?? result.reasoningEffort ?? '?');
                    return textContent(`${String(result.subtaskId ?? '')} 专家自配档已登记（${String(result.member ?? '')}｜档位 ${effort}）`
                        + `｜${String(result.hint ?? '平台将按自配档接续 phase-1，请等待接续或结束本步。')}`);
                }
                const delegates = Array.isArray(result.delegates) ? result.delegates : [];
                return textContent(`${String(result.subtaskId ?? '')} 第三层状态：梳理${result.consolidation ? '已登记' : '未登记'}；下级 ${delegates.length} 人`
                    + (delegates.length ? `（${delegates.map((d) => `${d?.member ?? '?'}:${d?.status ?? '?'}`).join('、')}）` : '')
                    + `｜${String(result.hint ?? '')}`);
            },
        },
        async execute(args, exec) {
            const parsed = asObject(args) ?? {};
            return runtime.delegateTool(exec.agent, parsed, exec?.signal);
        },
    };
}
/**
 * [1.13.0→3.0.8] 第四步（验证阶段）的插件核验工具（用户 2026-11-05；五步口径）。
 *
 * 五步工作法要求部门 Agent 先梳理问题（第一步）、再研究资源/工具/方案（第二步）、
 * 再备齐就绪（第三步）、执行并逐项验证（第四步）、最后收尾与复盘（第五步）。
 * 这个工具只做一件事：接收五步证据并给出核验结论。缺少 planning/preparation
 * /execution 证据时会被 `runtime.verifySubtask` 以 `PHASE_GATE` 拒绝并列出待补项，
 * 避免跳过前三步直接宣称验证通过。
 *
 * 注意（2.0.2 更正）：2026-11-05 的「第一、二阶段禁用 dsh-workplan 插件」是
 * 该次优化会话的过程约束，不是对所有后续会话的产品规则；插件不全局禁用。
 */
export function createVerifyTool(runtime) {
    return {
        name: 'dsh_workplan_verify',
        description: '部门子 Agent 第四步核验：交 execution/verification（有登记时 planning/preparation 自动并入）。',
        parameters: {
            type: 'object',
            properties: {
                subtaskId: { type: 'string' },
                phases: {
                    type: 'object',
                    properties: {
                        planning: { type: 'object' },
                        preparation: { type: 'object' },
                        execution: {
                            type: 'object',
                            properties: {
                                steps: { type: 'array', items: { type: 'string' } },
                                deviations: { type: 'array', items: { type: 'string' } },
                            },
                            required: ['steps'],
                        },
                        verification: {
                            type: 'object',
                            properties: {
                                allPassed: { type: 'boolean' },
                                checks: { type: 'array', items: { type: 'object' } },
                                requirementCheck: { type: 'string' },
                                retrospective: {
                                    type: 'object',
                                    properties: {
                                        problems: { type: 'array', items: { type: 'string' } },
                                        detours: { type: 'array', items: { type: 'string' } },
                                        resolutions: { type: 'array', items: { type: 'string' } },
                                        prevention: { type: 'array', items: { type: 'string' } },
                                    },
                                    required: ['problems', 'detours', 'resolutions', 'prevention'],
                                },
                            },
                            required: ['retrospective'],
                        },
                    },
                    required: ['execution', 'verification'],
                },
            },
            required: ['phases'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    passed: { type: 'boolean' },
                    phase: { type: 'string' },
                    planId: { type: 'string' },
                    subtaskId: { type: 'string' },
                    summary: { type: 'string' },
                    gaps: { type: 'array', items: { type: 'string' } },
                    code: { type: 'string' },
                    error: { type: 'string' },
                    message: { type: 'string' },
                },
                required: ['ok'],
                additionalProperties: true,
            },
            render(_args, value) {
                const result = isRecord(value) ? value : {};
                if (!result.ok) {
                    const gaps = Array.isArray(result.gaps) ? result.gaps.slice(0, 5).join('；') : '';
                    return textContent(`插件核验未通过（${String(result.code ?? 'FAILED')}）：${String(result.error ?? '未知原因')}`
                        + (gaps ? `｜需补齐：${gaps}` : '')
                        + '｜先修复再回报，不要用 done 收尾。');
                }
                return textContent(`${String(result.subtaskId ?? '')} 第四步核验通过：${String(result.summary ?? '')}`
                    + '｜把同一份 phases 写进结果块后提交。');
            },
        },
        async execute(args, exec) {
            const parsed = asObject(args) ?? {};
            return runtime.verifyTool(exec.agent, parsed);
        },
    };
}
/**
 * [2.0.0] 永久教训记忆的只读入口（用户 2026-11-05 自我学习要求）。
 *
 * 不提供写动作：记忆只能由「第四步复盘通过 → 完成判定」这条链写入，
 * 防止主 Agent 事后手写一条“教训”绕过真实复盘证据。
 */
function createLessonsTool(runtime) {
    return {
        name: 'dsh_workplan_lessons',
        description: '只读查询永久教训记忆（list/search/stats）。',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['list', 'search', 'stats'] },
                department: { type: 'string' },
                query: { type: 'string' },
                limit: { type: 'number' },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    file: { type: 'string' },
                    total: { type: 'number' },
                    repeated: { type: 'number' },
                    lessons: { type: 'array', items: { type: 'object' } },
                    departments: { type: 'array', items: { type: 'object' } },
                    error: { type: 'string' },
                },
                required: ['ok'],
                additionalProperties: true,
            },
            render(_args, value) {
                const result = isRecord(value) ? value : {};
                if (!result.ok)
                    return textContent(`教训记忆读取失败：${String(result.error ?? '未知原因')}`);
                const file = String(result.file ?? '');
                if (Array.isArray(result.departments)) {
                    const rows = result.departments.map((item) => `${item.department}:${item.count}`).join('、') || '（空）';
                    return textContent(`永久教训记忆：共 ${String(result.total ?? 0)} 条，其中重复发生 ${String(result.repeated ?? 0)} 类；分布 ${rows}；文件 ${file}`);
                }
                const lessons = Array.isArray(result.lessons) ? result.lessons : [];
                if (lessons.length === 0)
                    return textContent(`永久教训记忆为空（${file}）`);
                const lines = lessons.slice(0, 8).map((item) => `- [${String(item.department ?? '')}] ${String(item.title ?? '')}（${String(item.occurrences ?? 1)} 次）`
                    + `｜问题：${String((item.problems ?? []).join('；'))}`
                    + `｜预防：${String((item.prevention ?? []).join('；'))}`);
                return textContent(`永久教训记忆（${lessons.length}/${String(result.total ?? lessons.length)} 条，文件 ${file}）：\n${lines.join('\n')}`);
            },
        },
        async execute(args, exec) {
            return runtime.lessonsTool(exec.agent, asObject(args) ?? {});
        },
    };
}
/**
 * [1.11.0] 主 → 子的指示通道（T4 C-10 / T6 M6）。
 *
 * 服务端硬校验：调用者是目标子会话的直接父会话（根会话答复第一层部门行，
 * 部门负责人答复自己派出的第三层叶子；严格 lineage，非直系一律拒绝）、
 * 目标 `closure:'escalated'`、`childId` 是调用者直接子会话、instruction
 * 非空且 ≤4000 字符。投递失败时不改状态 —— 「我发了」与「它收到了」必须
 * 是两件事，否则界面会显示一个没人执行的指示。
 */
function createInstructTool(runtime) {
    return {
        name: 'dsh_workplan_instruct',
        description: '向「待指示」直接子会话/原专家下发决定并恢复执行（待指示期间禁止改派）。',
        parameters: {
            type: 'object',
            properties: {
                planId: {
                    type: 'string',
                },
                subtaskId: {
                    type: 'string',
                },
                member: {
                    type: 'string',
                },
                sessionId: {
                    type: 'string',
                },
                instruction: {
                    type: 'string',
                },
            },
            // subtaskId 在 runtime.instructTool 里是可选省略项（省略=对整份当前计划说话），
            // schema 强制必填会让模型在不知道 subtaskId 时无法提问，直接换成一句瞎编的 id。
            required: ['instruction'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    planId: { type: 'string' },
                    subtaskId: { type: 'string' },
                    status: { type: 'string' },
                    closure: { type: 'string' },
                    revision: { type: 'number' },
                    messageId: { type: 'string' },
                    deliveryReady: { type: 'boolean' },
                    code: { type: 'string' },
                    error: { type: 'string' },
                    hint: { type: 'string' },
                },
                required: ['ok'],
                additionalProperties: true,
            },
            render(_args, value) {
                const result = isRecord(value) ? value : {};
                if (!result.ok) {
                    return textContent(`指示未下发：${String(result.error ?? result.code ?? '未知错误')}`
                        + (result.hint ? `｜下一步：${String(result.hint)}` : ''));
                }
                return textContent(`${String(result.subtaskId ?? '')} 已收到指示并恢复执行（revision ${String(result.revision ?? '')}）`
                    + (result.messageId ? `，messageId ${String(result.messageId)}` : '')
                    + '｜该行现在显示「已收到指示」；完成前仍不得交付，需等它回报结果。');
            },
        },
        async execute(args, exec) {
            const parsed = asObject(args) ?? {};
            return runtime.instructTool(exec.agent, parsed, exec.signal);
        },
    };
}
/**
 * [3.0.1] 认可闸门·显式按住（双保险中不依赖关键词识别的那一半）。
 * 与 dispatch 同款权限模型：注册在插件根，execute 内部 isRootSession 硬校验。
 */
function createHoldTool(runtime) {
    return {
        name: 'dsh_workplan_hold',
        description: '将未开跑的计划置「认可闸门」按住，用户认可前禁止派发；用 release 解除。',
        parameters: {
            type: 'object',
            properties: {
                planId: {
                    type: 'string',
                },
                reason: {
                    type: 'string',
                },
            },
        },
        /*
         * [3.0.1-激活热修] DSH tools.register() 的强制契约：每个工具必须声明
         * output { schema, render, presentationMeta? }（dsh-tools/src/index.ts
         * register() 校验，缺 output 或 render 非函数即抛 TypeError）。此前本工具
         * 把 render 直接挂在工具根上、整体缺 output 包裹，宿主注册即抛
         * 「tool "dsh_workplan_hold" must declare output { schema, render, presentationMeta? }」，
         * 整个插件条目启用失败（web/headless 两 profile 经符号链接同源皆挂）。
         * 此处与文件内其它 12 个工具同款写法对齐：schema 覆盖 runtime.holdTool 的
         * 全部返回形（ok/planId/alreadyHeld/hold/code/error），render 按宿主契约
         * 接收 (args, value) 并返回 ContentBlock[]（textContent）。
         */
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    planId: { type: 'string' },
                    alreadyHeld: { type: 'boolean' },
                    hold: { type: 'object', additionalProperties: true },
                    code: { type: 'string' },
                    error: { type: 'string' },
                },
                required: ['ok'],
                additionalProperties: true,
            },
            render(_args, value) {
                const result = isRecord(value) ? value : {};
                if (!result.ok) {
                    return textContent(`未能按住计划：${String(result.error ?? '未知错误')}（${String(result.code ?? '')}）`);
                }
                if (result.alreadyHeld)
                    return textContent('计划已在认可闸门之下，无需重复按住。');
                return textContent(`计划 ${String(result.planId ?? '')} 已设为认可闸门按住：用户明确认可前不得派发。`);
            },
        },
        async execute(args, exec) {
            const parsed = asObject(args) ?? {};
            return runtime.holdTool(exec.agent, parsed);
        },
    };
}
/**
 * [3.0.1] 认可闸门·解除并开跑：「用户已明确认可」的唯一合法出口。
 */
function createReleaseTool(runtime) {
    return {
        name: 'dsh_workplan_release',
        description: '解除「认可闸门」留痕并立即派发（同 dispatch 门禁；仅根会话）。',
        parameters: {
            type: 'object',
            properties: {
                planId: { type: 'string' },
                note: { type: 'string' },
                startPhases: { type: 'object' },
                mode: { type: 'string', enum: ['wait', 'async'] },
            },
        },
        /*
         * [3.0.1-激活热修] 与 dsh_workplan_hold 同款契约修复：output { schema, render }
         * 为 tools.register() 强制项。schema 覆盖 runtime.releaseTool 的全部返回形
         * （ok/gateReleased/planId/note/hold/dispatch/code/error；dispatch 为 dispatchTool
         * 的完整结果对象，保持开放对象不裁剪）。render 语义修正：判定「未能解除」
         * 以 gateReleased 为准——原实现只看 ok===false，会把「闸门已解除但 startPhases
         * 门禁拒派发」误报成未解除（该分支 ok 恰为 false 但闸门已松）。
         */
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    gateReleased: { type: 'boolean' },
                    planId: { type: 'string' },
                    note: { type: 'string' },
                    hold: { type: 'object', additionalProperties: true },
                    dispatch: { type: 'object', additionalProperties: true },
                    code: { type: 'string' },
                    error: { type: 'string' },
                },
                required: ['ok'],
                additionalProperties: true,
            },
            render(_args, value) {
                const result = isRecord(value) ? value : {};
                if (result.gateReleased !== true) {
                    return textContent(`未能解除闸门：${String(result.error ?? '未知错误')}（${String(result.code ?? '')}）`);
                }
                if (result.dispatch && result.dispatch.ok === false) {
                    return textContent(`认可闸门已解除，但派发未通过：${String(result.dispatch.error ?? '')}（${String(result.dispatch.code ?? '')}）`);
                }
                return textContent(`认可闸门已解除（${String(result.hold?.reason ?? '')}），计划已开始执行。`);
            },
        },
        async execute(args, exec) {
            const parsed = asObject(args) ?? {};
            return runtime.releaseTool(exec.agent, parsed, exec.signal);
        },
    };
}
/**
 * [1.11.0] 跨部门需求的处置入口（用户 m00687）。
 *
 * 子 Agent 提出的 `needs` 会自动变成一条 open handoff，并进入交付门禁；
 * 只有根会话能用本工具把需求指派给部门、写入答复或判定无需动作。这是
 * 「跨部门协作必须有始有终」的唯一人工出口，避免需求只停留在提示词文本里。
 */
function createHandoffTool(runtime) {
    return {
        name: 'dsh_workplan_handoff',
        description: '处置跨部门需求 needs（list/assign/resolve/close，仅根会话）；未处置拦交付。',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['list', 'assign', 'resolve', 'close'],
                },
                planId: {
                    type: 'string',
                },
                subtaskId: {
                    type: 'string',
                },
                handoffId: {
                    type: 'string',
                },
                department: {
                    type: 'string',
                    // runtime 只认 DEPARTMENTS 闭集，schema 写自由字符串会让模型先猜一个
                    // 不存在的部门名，再被 INVALID_DEPARTMENT 拒一次（多烧一轮）。
                    enum: [...DEPARTMENT_IDS],
                },
                response: {
                    type: 'string',
                },
            },
            required: ['action'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    planId: { type: 'string' },
                    subtaskId: { type: 'string' },
                    handoff: { type: 'object' },
                    count: { type: 'number' },
                    handoffs: { type: 'array' },
                    deliveryReady: { type: 'boolean' },
                    code: { type: 'string' },
                    error: { type: 'string' },
                    hint: { type: 'string' },
                },
                required: ['ok'],
                additionalProperties: true,
            },
            render(_args, value) {
                const result = isRecord(value) ? value : {};
                if (!result.ok) {
                    return textContent(`处置未生效：${String(result.error ?? result.code ?? '未知错误')}`);
                }
                if (Array.isArray(result.handoffs)) {
                    if (result.handoffs.length === 0)
                        return textContent('没有待处理的跨部门需求。');
                    return textContent(`待处理跨部门需求 ${result.handoffs.length} 条：\n`
                        + result.handoffs.slice(0, 10).map((item) => `- ${String(item.subtaskId)} ${String(item.id)}｜${String(item.status)}`
                            + `${item.department ? ` → ${String(item.department)}` : ''}｜${String(item.request)}`).join('\n'));
                }
                return textContent(`${String(result.subtaskId ?? '')} ${String(result.handoff?.id ?? '')} 已更新为 ${String(result.handoff?.status ?? '')}`
                    + `｜${result.deliveryReady === true ? '交付门禁已通过' : '交付门禁仍未通过'}`
                    + `｜${String(result.hint ?? '')}`);
            },
        },
        async execute(args, exec) {
            const parsed = asObject(args) ?? {};
            return runtime.handoffTool(exec.agent, parsed, exec.signal);
        },
    };
}
function createStatusTool(runtime) {
    return {
        name: 'dsh_workplan_status',
        description: '只读查看计划状态与进度（不派发、不改状态）。',
        parameters: {
            type: 'object',
            properties: {
                planId: {
                    type: 'string',
                },
            },
            additionalProperties: false,
        },
        output: {
            schema: statusToolOutputSchema(),
            render(_args, value) {
                const result = isRecord(value) ? value : {};
                const stats = isRecord(result.stats) ? result.stats : {};
                const runtimeInfo = isRecord(result.runtime) ? result.runtime : {};
                /*
                 * [1.8.14] Every answer names the loaded build, including the failure
                 * path. The restart verification in the incident report (§14.6 step 2)
                 * called `status` before any plan existed and got bare `NO_PLAN`, so it
                 * could not confirm which build was answering.
                 */
                const startedAt = Number(runtimeInfo.startedAt) || 0;
                const identity = [
                    typeof result.version === 'string' ? `v${result.version}` : '',
                    typeof runtimeInfo.buildHash === 'string' ? `build ${runtimeInfo.buildHash}` : '',
                    Number(runtimeInfo.pid) > 0 ? `pid ${Number(runtimeInfo.pid)}` : '',
                    startedAt > 0
                        ? `启动 ${new Date(startedAt).toLocaleString('zh-CN', { hour12: false })}`
                        : '',
                ].filter(Boolean).join('｜');
                if (!result.ok) {
                    return textContent(`查询失败：${String(result.error ?? '未知错误')}`
                        + (identity ? `（${identity}）` : ''));
                }
                const running = result.running === true;
                const planner = isRecord(result.planner) ? result.planner : null;
                const statuses = Array.isArray(result.statuses) ? result.statuses : [];
                /*
                 * [2.2.3][N1] 模型可见面补齐：planner 与 noticeChannel 之前只进结构化
                 * value，DSH 只把 render 文本写进对话，导致 D5/D1-b 结构性不可读。
                 * 这里只做只读展示，不改变状态机；缺失字段不编造。
                 */
                const plannerLine = planner
                    ? `规划器：推理等级 ${String(planner.reasoningEffort ?? '未记录')}`
                        + `｜来源 ${String(planner.reasoningEffortSource ?? '未记录')}`
                        + `｜判定 ${String(planner.outcome ?? '未记录')}`
                        + (typeof planner.model === 'string' && planner.model ? `｜模型 ${planner.model}` : '')
                    : '';
                /*
                 * [3.2.9] KV 前缀缓存只读展示：有真实 usage 才显示；没有数据不刷 0 行，
                 * 也不暗示「已共享 KV」——插件拿不到模型内部张量，只报告供应商计量。
                 */
                const cache = isRecord(result.cache) ? result.cache : null;
                const cacheLine = cache && Number(cache.calls ?? 0) > 0
                    ? renderCacheSummary(cache)
                    : '';
                const channelLines = statuses
                    .filter((item) => isRecord(item?.noticeChannel))
                    .slice(0, 12)
                    .map((item) => {
                    const channel = item.noticeChannel;
                    const at = Number(channel.at) > 0
                        ? new Date(Number(channel.at)).toLocaleString('zh-CN', { hour12: false })
                        : '—';
                    const observedAt = Number(channel.observedAt) > 0
                        ? new Date(Number(channel.observedAt)).toLocaleString('zh-CN', { hour12: false })
                        : '—';
                    return `${String(item.subtaskId ?? '')} 通道：${String(channel.state ?? '')}`
                        + `｜target ${String(channel.target ?? '—')}`
                        + `｜caller ${String(channel.caller ?? '—')}`
                        + `｜at ${at}`
                        + `｜observedAt ${observedAt}`
                        + `｜reason ${String(channel.reason ?? '—')}`;
                });
                return textContent([
                    `计划 ${String(result.planId ?? '')}｜${running ? '执行中' : '未在执行'}`
                        + `｜阶段：${phaseLabel(result.phase)}`
                        + `｜完成 ${Number(stats.done ?? 0)}/${Number(stats.total ?? 0)}，受阻 ${Number(stats.blocked ?? 0)}`
                        + `｜${result.deliveryReady === true ? '可交付' : '未就绪'}`
                        + (running && Number(result.elapsedMs ?? 0) > 0
                            ? `｜已 ${Math.round(Number(result.elapsedMs) / 1000)}s`
                            : '')
                        + (identity ? `｜${identity}` : ''),
                    plannerLine,
                    cacheLine,
                    ...channelLines,
                ].filter(Boolean).join('\n'));
            },
        },
        async execute(args, exec) {
            const parsed = asObject(args) ?? {};
            return runtime.statusTool(exec.agent, parsed);
        },
    };
}
function createDispatchTool(runtime) {
    return {
        name: 'dsh_workplan_dispatch',
        description: '派发或续跑计划（wait/async；幂等）。遵守五步开工证据协议：首次须附 startPhases，缺失硬拒 START_EVIDENCE_MISSING；未就绪须继续派发。',
        parameters: {
            type: 'object',
            properties: {
                planId: { type: 'string' },
                mode: { type: 'string', enum: ['wait', 'async'] },
                startPhases: {
                    type: 'object',
                    properties: {
                        planning: {
                            type: 'object',
                            properties: {
                                problemAnalysis: { type: 'array', items: { type: 'string' } },
                                resources: { type: 'array', items: { type: 'string' } },
                                tools: { type: 'array', items: { type: 'string' } },
                                approach: { type: 'array', items: { type: 'string' } },
                                approachBasis: { type: 'array', items: { type: 'string' } },
                            },
                            required: ['problemAnalysis', 'approach', 'approachBasis', 'resources', 'tools'],
                            additionalProperties: false,
                        },
                        preparation: {
                            type: 'object',
                            properties: {
                                prepared: { type: 'array', items: { type: 'string' } },
                                evidence: { type: 'array', items: { type: 'string' } },
                            },
                            required: ['prepared', 'evidence'],
                            additionalProperties: false,
                        },
                    },
                    required: ['planning', 'preparation'],
                    additionalProperties: false,
                },
            },
            additionalProperties: false,
        },
        output: {
            schema: dispatchToolOutputSchema(),
            render(_args, value) {
                const result = isRecord(value) ? value : {};
                const stats = isRecord(result.stats) ? result.stats : {};
                const done = Number(stats.done ?? 0);
                const total = Number(stats.total ?? 0);
                const blocked = Number(stats.blocked ?? 0);
                const remaining = Math.max(0, total - done);
                const name = `计划 ${String(result.planId ?? '')}`;
                if (!result.ok) {
                    // The hint carries the recovery instruction (resume, or take the work
                    // over directly); showing it in the rendered line keeps it visible
                    // even when only the summary is read.
                    return textContent(`派发失败：${String(result.error ?? '未知错误')}${result.hint ? `｜下一步：${String(result.hint)}` : ''}`);
                }
                /*
                 * [1.8.7] The first word decides how the model reads the round.
                 *
                 * Incident: `ok:true` + "已加入进行中的派发并等到结果（完成 10/13）"
                 * read as "done", so the model presented a half-finished report. Now an
                 * unfinished round starts with 未完成 and states the only legal next
                 * move; a finished one is the only place the word 已完成 appears.
                 */
                if (result.mode === 'async' || (result.running === true && result.joined !== true)) {
                    return textContent(`${name} 已开跑，尚未完成：当前完成 ${done}/${total}，剩余 ${remaining} 项由本轮执行`
                        + `（${Math.round(elapsedSeconds(result) / 1000)}s）`
                        + '｜不要重复派发；结果消息会在本轮结束时自动写入。在结果消息到达并确认 complete=true 之前，不要给最终答复。');
                }
                /*
                 * [1.8.13] All rows done is not the finish line.
                 *
                 * T5-B/D: every row said done, no structured evidence, and this branch
                 * printed 已完成 — the model then presented. Only deliveryReady=true
                 * reaches the completion sentence; every other state names the gaps and
                 * the legal next move (dispatch, fix evidence, or report unfinished).
                 */
                if (result.deliveryReady === true) {
                    return textContent(`${name} 已完成且可交付：完成 ${done}/${total}，证据通过`
                        + (result.joined ? '｜已加入进行中的派发并等到结果' : ''));
                }
                const blockers = Array.isArray(result.deliveryBlockers) ? result.deliveryBlockers.slice(0, 6).join('；') : '';
                const cancelled = result.phase === 'cancelled';
                const next = cancelled
                    ? '计划已取消且未完成：不要再次 dispatch，不要 present；答复按「未完成：剩余 N 项与原因」开头。'
                    : remaining > 0
                        ? '下一步：再次调用 dsh_workplan_dispatch 续跑剩余项；全部 done 之前不要 present。'
                        : "全部子任务虽已 done，但证据未通过：用 dsh_workplan_update 补 verification='structured' 与 acceptance（每项 result='pass'），或把对应项改回 blocked；不要 present。";
                return textContent(`${name} 未就绪：完成 ${done}/${total}，剩余 ${remaining} 项，受阻 ${blocked}（${phaseLabel(result.phase)}）`
                    + (blockers ? `｜证据缺口：${blockers}` : '')
                    + (result.joined ? '｜本轮已返回，但计划没有达到可交付状态' : '')
                    + `｜${next}｜不要写“已完成/最终版/已交付”，不要给收尾性最终答复。`);
            },
        },
        // 不声明 timeoutMs：部门与专家执行没有工具层 24 小时或预算派生截止。
        async execute(args, exec) {
            const parsed = asObject(args) ?? {};
            return runtime.dispatchTool(exec.agent, parsed, exec.signal);
        },
    };
}
/*
 * [3.0.1] Legacy limit readers.
 *
 * childTimeoutMs / idleTimeoutMs / totalTimeoutMs and their environment
 * variables are still accepted so old profile configs do not fail validation,
 * but the runtime no longer arms any deadline from them. They must not be
 * documented or used as a way to limit department-lead or expert execution.
 */
/**
 * [1.10.4] 布尔开关：配置项优先，其次环境变量。
 *
 * 与 `numericSetting` 不同，显式 `false` 必须能被表达，所以先判 boolean；
 * 环境变量只接受 1/true/yes/on，大小写不敏感。未配置时返回 `false`。
 *
 * [1.10.6] 注意：`autoResume` 已改用 `autoResumeEnabledFrom`（默认开启，
 * 且 `0/false/no/off` 可以显式关闭）。本函数保留给「默认关闭」语义的开关。
 */
/**
 * [1.11.0] `strictCompletion` 的三态解析：显式配置 > 显式环境变量 > 默认 true。
 *
 * 不能复用 `booleanSetting`：那个函数「未配置即 false」，会把默认开启的
 * 完成门禁反过来关掉（1.10.6 的 autoResume 就栽在这上面）。
 */
function strictCompletionEnabledFrom(configValue, envValue) {
    if (typeof configValue === 'boolean')
        return configValue;
    const raw = envValue === undefined || envValue === null ? '' : String(envValue).trim();
    if (raw !== '') {
        if (/^(1|true|yes|on)$/i.test(raw))
            return true;
        if (/^(0|false|no|off)$/i.test(raw))
            return false;
    }
    return true;
}
/**
 * [1.12.3] `failClosedOnIncomplete` 的三态解析：显式配置 > 显式环境变量 > 'auto'。
 *
 * 与 `strictCompletionEnabledFrom` 的区别只在默认值：这里未配置时返回 `'auto'`，
 * 语义是「headless 才硬失败」，不能退化成 `false`（那等于默认关闭，事故会复发），
 * 也不能退化成 `true`（那会让交互式会话在收尾时抛错）。
 */
function failClosedOnIncompleteFrom(configValue, envValue) {
    if (typeof configValue === 'boolean')
        return configValue;
    const raw = envValue === undefined || envValue === null ? '' : String(envValue).trim();
    if (raw !== '') {
        if (/^(1|true|yes|on)$/i.test(raw))
            return true;
        if (/^(0|false|no|off)$/i.test(raw))
            return false;
    }
    return 'auto';
}
function booleanSetting(configValue, envName) {
    if (typeof configValue === 'boolean')
        return configValue;
    const raw = typeof process !== 'undefined' ? process.env?.[envName] : undefined;
    if (raw === undefined || raw === '')
        return false;
    return /^(1|true|yes|on)$/i.test(String(raw).trim());
}
/** [1.10.6] 原样读取环境变量，供三态解析使用（未设置返回 undefined）。 */
function settingEnv(envName) {
    return typeof process !== 'undefined' ? process.env?.[envName] : undefined;
}
function numericSetting(configValue, envName, allowZero = false) {
    const positive = (value) => Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
    if (configValue !== undefined && configValue !== null && configValue !== '') {
        const numeric = Number(configValue);
        if (positive(numeric))
            return numeric;
    }
    const raw = typeof process !== 'undefined' ? process.env?.[envName] : undefined;
    if (raw === undefined || raw === '')
        return undefined;
    const numeric = Number(raw);
    return positive(numeric) ? numeric : undefined;
}
/**
 * Hard, tool-level guards. Kept as a pure function so the contracts can be
 * pinned without mounting the whole plugin:
 *  - plan mode：只拦住 dispatch，其他工具保持可用（避免死锁）；
 *  - `present`：计划未完成时由 runtime 拒绝（事故中模型在收尾闸门之前
 *    present，卡片一旦出现就无法撤回）。
 */
export function toolGuardReason(exec, runtime) {
    if (exec?.name === 'dsh_workplan_dispatch' || exec?.name === 'dsh_workplan_release') {
        const session = exec?.agent?.session;
        if (session && runtime.planModeActive(session)) {
            return exec?.name === 'dsh_workplan_release'
                ? '当前是 plan 模式：计划尚待用户审阅，不能用 dsh_workplan_release 绕过审阅直接开跑；请用户退出 plan 模式后再解除闸门/派发。'
                : '当前是 plan 模式：计划已生成，请先让用户审阅/退出 plan 模式，再调用 dsh_workplan_dispatch。';
        }
        return undefined;
    }
    if (exec?.name === 'present')
        return runtime.presentDenialReason(exec?.agent);
    return undefined;
}
export function apply(ctx, config = {}) {
    const runtime = createWorkplanRuntime(ctx, {
        // [1.8.13] The answering version must be visible in status/dispatch output,
        // not inferred from the PID.
        version: meta.version,
        // [1.8.14] ...and so must the exact loaded build (see LOADED_BUILD above).
        build: {
            pid: process.pid,
            startedAt: PROCESS_STARTED_AT,
            entryPath: LOADED_BUILD.entryPath,
            buildHash: LOADED_BUILD.buildHash,
        },
        cwd: typeof config.cwd === 'string' ? config.cwd : undefined,
        plannerTimeoutMs: numericSetting(config.plannerTimeoutMs, 'DSH_WORKPLAN_PLANNER_TIMEOUT_MS'),
        plannerIdleTimeoutMs: numericSetting(config.plannerIdleTimeoutMs, 'DSH_WORKPLAN_PLANNER_IDLE_TIMEOUT_MS'),
        childTimeoutMs: numericSetting(config.childTimeoutMs, 'DSH_WORKPLAN_CHILD_TIMEOUT_MS'),
        idleTimeoutMs: numericSetting(config.idleTimeoutMs, 'DSH_WORKPLAN_IDLE_TIMEOUT_MS'),
        totalTimeoutMs: numericSetting(config.totalTimeoutMs, 'DSH_WORKPLAN_TOTAL_TIMEOUT_MS', true),
        maxResumes: numericSetting(config.maxResumes, 'DSH_WORKPLAN_MAX_RESUMES'),
        /*
         * [1.10.6] 三态解析：显式配置 > 显式环境变量 > 默认开启。
         * 旧实现用 `booleanSetting(..., false)`，未配置即等于关闭，于是「预算到点
         * 自动续跑」这个能力在用户机器上从来没打开过（1h57m 空窗的直接原因）。
         */
        autoResume: autoResumeEnabledFrom(config.autoResume, settingEnv('DSH_WORKPLAN_AUTO_RESUME')),
        /*
         * auto-resume.ts:64 明写「0 disables」，但 numericSetting 默认拒绝 0，
         * 于是把次数配成 0 的人拿到的是默认值（继续续跑=继续烧钱）。这里显式允许 0。
         */
        autoResumeMaxAttempts: numericSetting(config.autoResumeMaxAttempts, 'DSH_WORKPLAN_AUTO_RESUME_MAX', true),
        // 极简单动作快路径默认开启，跳过整轮规划器 LLM 调用省 token（可配置 false 或 DSH_WORKPLAN_DETERMINISTIC_FAST_PATH=0 关闭）。
        deterministicFastPath: strictCompletionEnabledFrom(config.deterministicFastPath, settingEnv('DSH_WORKPLAN_DETERMINISTIC_FAST_PATH')),
        /*
         * [1.11.0] 三态解析（显式配置 > 显式环境变量 > 默认 true）。
         * 与 autoResume 用同一种写法：未配置时走默认值，而不是悄悄等于 false。
         */
        strictEvidence: strictCompletionEnabledFrom(config.strictCompletion, settingEnv('DSH_WORKPLAN_STRICT_COMPLETION')),
        /*
         * [1.12.0] 自动派发三态：显式配置 > 显式环境变量 > 默认 true。
         * 与 autoResume / strictCompletion 同一写法，避免「没配置就等于关闭」。
         */
        autoDispatch: strictCompletionEnabledFrom(config.autoDispatch, settingEnv('DSH_WORKPLAN_AUTO_DISPATCH')),
        /*
         * [1.12.3] headless「未完成不得成功收尾」。默认 'auto'：只有 headless
         * 运行上下文（提供 `headlessStartup` 服务）才硬失败，交互式会话不受影响。
         */
        failClosedOnIncomplete: failClosedOnIncompleteFrom(config.failClosedOnIncomplete, settingEnv('DSH_WORKPLAN_FAIL_CLOSED_ON_INCOMPLETE')),
        turnStoppingMaxWaitMs: numericSetting(config.turnStoppingMaxWaitMs, 'DSH_WORKPLAN_TURN_STOPPING_MAX_WAIT_MS', true),
    });
    /*
     * [3.2.9] 供应商 KV 前缀缓存计量挂载：llm/stream 是只读瀑布，监听器只读取
     * usage 块并透传全部块，不调用第二次 next()、不改写冻结请求。环境变量
     * DSH_WORKPLAN_CACHE_METER=0 可关闭。失败 fail-open，不影响模型调用。
     */
    if (cacheMeterEnabled()) {
        try {
            ctx.effect(() => observeLlmStream(ctx, runtime.cacheMeter));
        }
        catch {
            // 计量不是功能依赖：挂载失败只少一列观测数据。
        }
    }
    /*
     * [3.0.6][第 2 批] 可选留痕清理：默认关闭（0 = 永久保留证据）。
     * 只有显式配置正数时才启用；启动先跑一次，之后每 24 小时一次。
     */
    const journalRetentionDays = (() => {
        const configured = numericSetting(config.journalRetentionDays, 'DSH_WORKPLAN_JOURNAL_RETENTION_DAYS', true);
        return configured !== undefined && configured > 0 ? Math.min(configured, 3650) : 0;
    })();
    if (journalRetentionDays > 0) {
        const prune = () => {
            const result = pruneJournal({ retentionDays: journalRetentionDays, excludePlanIds: activePlanIdSet(runtime) });
            if (!result.ok)
                ctx.logger?.warn?.(`[dsh-workplan] journal 清理失败：${result.error}`);
            // 删除失败逐条 warn（ok 仍为 true，errors[] 是弱错误通道，不得静默）。
            if (Array.isArray(result.errors) && result.errors.length > 0) {
                for (const line of result.errors)
                    console.warn(`[dsh-workplan] journal 清理异常：${String(line)}`);
            }
            return result;
        };
        ctx.effect(() => {
            /*
             * [复审修复] 首次清理从激活同步路径挪到 10s 后：激活是同步路径，不能
             * 当场扫盘（readdir/stat 大目录会拖住插件注册）。卸载时清除——
             * journalRetentionTimer 同款的 ctx.effect 清理模式。
             */
            const firstPruneTimer = setTimeout(prune, 10_000);
            if (typeof firstPruneTimer?.unref === 'function')
                firstPruneTimer.unref();
            return () => clearTimeout(firstPruneTimer);
        });
        ctx.effect(() => {
            // 卫生类：不触发只少一次清理，不得拖住正在关闭的宿主。
            const journalRetentionTimer = setInterval(prune, 24 * 60 * 60 * 1000);
            if (typeof journalRetentionTimer?.unref === 'function')
                journalRetentionTimer.unref();
            return () => clearInterval(journalRetentionTimer);
        });
    }
    ctx.effect(() => ctx.systemPrompt.section({
        name: 'dsh-workplan',
        order: PROMPT_ORDER,
        text: PROMPT_SECTION,
    }));
    /*
     * [省钱三件套 ②] 子 Agent 一创建就把全局段换成子会话提示；pre-step 兜底
     * （冷恢复/事件顺序变化时同样生效，WeakSet 保证只注册一次）。
     */
    ctx.effect(() => ctx.on('agent/created', (payload) => { shadowWorkplanPromptForChild(payload?.agent); }));
    ctx.effect(() => ctx.tools.register(createUpdateTool(runtime), { when: toolWhen('dsh_workplan_update') }));
    ctx.effect(() => ctx.tools.register(createCancelTool(runtime), { when: toolWhen('dsh_workplan_cancel') }));
    ctx.effect(() => ctx.tools.register(createStatusTool(runtime), { when: toolWhen('dsh_workplan_status') }));
    ctx.effect(() => ctx.tools.register(createFollowupTool(runtime), { when: toolWhen('dsh_workplan_followup') }));
    /*
     * [1.11.0] 闭环的两条工具通道（T4 C-09 / C-10）。
     *
     * `escalate` 必须对子会话可见（子 Agent 是它的唯一调用者），`instruct`
     * 必须只有根会话可用（服务端 `isRootSession` 硬校验，不依赖提示词）。
     * 注册在插件根与其它工具一致：宿主按会话注入哪些工具由平台决定，插件
     * 侧不做过滤；权限判断一律落在 execute 内部。
     */
    ctx.effect(() => ctx.tools.register(createEscalateTool(runtime), { when: toolWhen('dsh_workplan_escalate') }));
    /*
     * [2.3.9][T4b] 第三层派发（用户要求 4/5）：与 escalate 同款权限模型——
     * 注册在插件根、对所有会话可见，runtime.delegateTool 内部按「调用者必须是
     * 计划内某行的部门负责人子会话」硬校验；根会话与第三层叶子会话都会被拒。
     */
    ctx.effect(() => ctx.tools.register(createDelegateTool(runtime), { when: toolWhen('dsh_workplan_delegate') }));
    /* [1.13.0→3.0.8] 第四步核验：子会话唯一可用的插件工作能力，前三步会被 PHASE_GATE 拒绝。 */
    ctx.effect(() => ctx.tools.register(createVerifyTool(runtime), { when: toolWhen('dsh_workplan_verify') }));
    /* [2.0.0] 永久教训记忆的只读复核入口（第四步验证用）。 */
    ctx.effect(() => ctx.tools.register(createLessonsTool(runtime), { when: toolWhen('dsh_workplan_lessons') }));
    ctx.effect(() => ctx.tools.register(createInstructTool(runtime), { when: toolWhen('dsh_workplan_instruct') }));
    /*
     * [1.11.0] 需求变更的重规划入口（T4 C-11 / T7）。
     *
     * 根会话工具：子 Agent 不能改写主计划（execute 内部 `isRootSession` 硬校验）。
     * 它只在“计划定义需要改”时使用；执行中调用会拒绝改计划但保留变更原文。
     */
    ctx.effect(() => ctx.tools.register(createReplanTool(runtime), { when: toolWhen('dsh_workplan_replan') }));
    /*
     * [1.11.0] 跨部门需求处置（用户 m00687）：注册在根插件上，`execute` 内部
     * 用 `isRootSession` 硬校验，子会话即使拿到工具表也无法处置需求。
     */
    ctx.effect(() => ctx.tools.register(createHandoffTool(runtime), { when: toolWhen('dsh_workplan_handoff') }));
    ctx.effect(() => ctx.tools.register(createDispatchTool(runtime), { when: toolWhen('dsh_workplan_dispatch') }));
    /* [3.0.1] 认可闸门：显式按住 / 解除并开跑，与 dispatch 同款根会话硬校验。 */
    ctx.effect(() => ctx.tools.register(createHoldTool(runtime), { when: toolWhen('dsh_workplan_hold') }));
    ctx.effect(() => ctx.tools.register(createReleaseTool(runtime), { when: toolWhen('dsh_workplan_release') }));
    /*
     * Plan mode produces a plan for review, not department execution. Denying
     * only the dispatch tool keeps every other tool available (no deadlock)
     * and gives the model a precise reason instead of a silent no-op.
     *
     * [1.8.8] `present` 也在执行前拦截：事故里模型在回合中途就把未完成
     * 的产物 present 出去，回合收尾闸门再拦已经撤不回卡片。计划未完成时
     * 拒绝交付，模型必须先续跑或显式取消计划。
     */
    ctx.effect(() => ctx.tools.guard((exec) => toolGuardReason(exec, runtime)));
    /*
     * [省钱三件套 ②] agent/pre-step 是 waterfall 事件：只保留一个监听器，
     * 在交给 runtime 之前先给子会话打提示遮蔽补丁（冷恢复/创建事件漏网时兜底），
     * 绝不新增第二个监听器去干扰 next() 链。
     */
    ctx.effect(() => ctx.on('agent/pre-step', (payload, next) => {
        shadowWorkplanPromptForChild(payload?.agent);
        return runtime.onPreStep(payload, next);
    }));
    /*
     * [3.0.1] 后台规划等待期间，followup/queue 可能还没进入下一次 pre-step。
     * 在官方 inbox 插入事件处立即取代旧规划，避免旧结果迟到覆盖新任务。
     */
    ctx.effect(() => ctx.on('agent/inbox/inserted', runtime.onInboxInserted));
    /*
     * [1.8.7] 回合收尾前的闸门。官方 `agent/turn-stopping` 是 serial 事件、
     * 在边界提交前被 await；监听器 `agent.steer()` 后机器会重读 inbox，于是
     * 「计划没做完」时回合不会被关闭。这是「未完成即输出」的唯一强制点：
     * 提示词和工具文案只能说服模型，这个事件能拦住收尾本身。
     */
    ctx.effect(() => ctx.on('agent/turn-stopping', runtime.onTurnStopping));
    ctx.effect(() => ctx.tools.guard((exec) => fileWriteGuardReason(exec, runtime)));
    ctx.inject(['webServer', 'connection'], (scope) => {
        scope.effect(() => scope.webServer.register({
            kind: 'exact',
            path: '/dsh-workplan/plans',
            handler: (req, res) => runtime.route(req, res, scope),
        }));
        /*
         * Chart.js is vendored (vendor/chart.umd.js, MIT) instead of bundled: the
         * client half is a hand-written module-registry factory with no bundler, so
         * the page loads the library as a same-origin script and falls back to the
         * built-in CSS charts when it cannot load.
         */
        scope.effect(() => scope.webServer.register({
            kind: 'exact',
            path: '/dsh-workplan/vendor/chart.umd.js',
            handler: (req, res) => {
                applyHardeningHeaders(res);
                /*
                 * [1.8.1] Read-only, and it stays read-only: the file path is a
                 * constant (never built from the request URL) and only GET/HEAD are
                 * answered. It deliberately does NOT call
                 * `connection.requestRejection`: this is a public, non-sensitive
                 * static asset with no per-user data. `/dsh-workplan/plans` is the
                 * route that carries data, and that one is auth-checked in
                 * `runtime.route()`. SECURITY.md states this asymmetry explicitly.
                 */
                if (req?.method !== 'GET' && req?.method !== 'HEAD') {
                    res.statusCode = 405;
                    res.setHeader('allow', 'GET, HEAD');
                    res.setHeader('content-type', 'text/plain; charset=utf-8');
                    res.end();
                    return;
                }
                try {
                    if (!chartVendorBytes) {
                        chartVendorBytes = readFileSync(new URL('../vendor/chart.umd.js', import.meta.url));
                    }
                    const body = chartVendorBytes;
                    res.statusCode = 200;
                    res.setHeader('content-type', 'text/javascript; charset=utf-8');
                    res.setHeader('cache-control', 'public, max-age=3600');
                    res.end(req?.method === 'HEAD' ? undefined : body);
                }
                catch (error) {
                    res.statusCode = 404;
                    res.setHeader('content-type', 'text/plain; charset=utf-8');
                    res.end('chart.js not found');
                }
            },
        }));
    });
    ctx.effect(() => () => runtime.dispose());
    /*
     * [3.0.6][复审修复] 把 runtime 句柄交还给调用方：宿主契约不消费本返回值
     * （清理一律经上方 effect），测试与宿主编排需要观察 state.records /
     * 替换 startAutoDispatch 时可直接拿到同一实例，不必从工具闭包里挖。
     */
    return runtime;
}
export const meta = {
    name,
    version: PLUGIN_VERSION,
    promptOrder: PROMPT_ORDER,
    routes: ['/dsh-workplan/plans', '/dsh-workplan/vendor/chart.umd.js'],
};
export { PROMPT_SECTION, createCancelTool, createDelegateTool, createDispatchTool, createEscalateTool, createFollowupTool, createHandoffTool, createHoldTool, createInstructTool, createLessonsTool, createReleaseTool, createReplanTool, createStatusTool, createUpdateTool, plannerOutputSchema };
/**
 * [1.8.18] 写工具的路径级闸门（T7-N2），与 `toolGuardReason` 分开注册。
 *
 * present/dispatch 的语义是「计划未就绪不能交付」；这里管的是「已交付的
 * 文件不能在计划未就绪时被原地改写」。两条守卫都返回拒绝原因，harness
 * 取第一个非空原因，互不覆盖。
 */
export function fileWriteGuardReason(exec, runtime) {
    /*
     * [复审修复] bash 写保护绕过：shell 类工具的 command 字符串（重定向/heredoc/
     * tee/sed -i/cp/mv）此前因参数形状不认（无 file_path/path）而整类绕过闸门。
     * 先解析出 shell 写目标（非 shell 调用为 null），形状闸门与 shell 闸门至少
     * 命中其一才继续。
     */
    const shellTargets = shellWriteTargets(exec);
    if (!isWriteShapedCall(exec) && shellTargets === null)
        return undefined;
    // The three historical write tools pass their arguments through untouched, so
    // their behaviour stays exactly as before (argument-shape matching is only an
    // EXTENSION: a tool that used to be denied is still denied the same way).
    const direct = exec?.name === 'write' || exec?.name === 'edit' || exec?.name === 'str_replace_editor';
    const reason = direct ? runtime.presentedWriteDenialReason(exec?.agent, exec?.arguments) : undefined;
    if (typeof reason === 'string')
        return reason;
    // [1.12.2] G2: a single call can touch several files (apply_patch hunks).
    // Deny the call as a whole if any of its targets is a protected deliverable.
    for (const target of runtime.writeTargets(exec?.agent, exec?.arguments) ?? []) {
        const extra = runtime.presentedWriteDenialReason(exec?.agent, { file_path: target });
        if (typeof extra === 'string')
            return extra;
    }
    /*
     * [复审修复] shell 写目标：与上面同一判定出口——只拦「写入已交付文件」，
     * 纯读命令（cat/grep/less 该路径）解析不出写目标，天然放行。
     * 启发式局限（保守模式）：只认 > / >> 重定向、tee、sed -i、mv/cp/install/dd
     * 的目标；命令拼接变量（cmd=path; $cmd）、eval、find -delete 等动态写法
     * 不在解析范围内——见 shellWriteTargets 注释。
     */
    if (shellTargets) {
        for (const target of shellTargets) {
            const extra = runtime.presentedWriteDenialReason(exec?.agent, { file_path: target });
            if (typeof extra === 'string')
                return extra;
        }
    }
    return undefined;
}
/*
 * [复审修复] 活跃 planId 集合：pruneJournal 只看 mtime，「活跃但安静」的计划
 * （久无新留痕、mtime 变旧）会被误删；把当前活跃 planId 传给 excludePlanIds
 * 即可保住。planning 在途时尚未铸出 planId（planId 在规划完成后才生成，占位
 * 记录 planId=null），因此 runtime.state.records 就是全部活跃 planId 的事实源。
 * 导出以便直接单测；读取失败返回空集——宁可少排除，也不让清理路径抛错。
 */
export function activePlanIdSet(runtime) {
    const ids = new Set();
    try {
        const records = runtime?.state?.records;
        if (records instanceof Map) {
            for (const record of records.values()) {
                const direct = typeof record?.planId === 'string' ? record.planId.trim() : '';
                const nested = typeof record?.plan?.planId === 'string' ? record.plan.planId.trim() : '';
                const id = direct !== '' ? direct : (nested !== '' ? nested : null);
                if (id)
                    ids.add(id);
            }
        }
    }
    catch {
        // 同上：名单读取失败不阻断清理。
    }
    return ids;
}
/**
 * [1.12.2] G2: recognise write calls by their argument shape, not by a tool-name
 * allow-list. The 1.8.18 version named write/edit/str_replace_editor only, so a
 * fourth write tool such as apply_patch never reached the guard at all.
 *
 * Shape rule: a path/first positional argument PLUS a content-bearing argument
 * (content, file_text, new_str, old_string, patch, input). read/read_image/
 * present/glob/grep carry no such pair, so they stay untouched.
 */
const READ_ONLY_TOOLS = new Set([
    'read', 'read_image', 'glob', 'grep', 'ls', 'list', 'list_dir',
    'present', 'todo_write', 'ask_user_question',
]);
const KNOWN_WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'apply_patch']);
const WRITE_CONTENT_KEYS = [
    'content', 'file_text', 'new_str', 'new_string', 'old_string', 'old_str',
    'patch', 'edits', 'text', 'data', 'body', 'value', 'append', 'overwrite',
];
function isWriteShapedCall(exec) {
    const name = exec?.name;
    if (typeof name !== 'string' || !name)
        return false;
    const args = exec?.arguments;
    if (!args || typeof args !== 'object')
        return false;
    // Read-only tools also carry file_path/path; the guard must never touch them.
    if (READ_ONLY_TOOLS.has(name))
        return false;
    // A patch tool names its target(s) inside the patch text, not in an argument.
    if (typeof args.input === 'string' && /\*\*\* (Update|Add|Delete|Move) File/.test(args.input))
        return true;
    const hasTargetPath = typeof args.file_path === 'string' || typeof args.path === 'string';
    if (!hasTargetPath)
        return false;
    // Historical write tools always pass through; unknown tools must also carry a content-bearing arg so read-like tools (stat/cat/read_file) aren't falsely blocked.
    if (KNOWN_WRITE_TOOLS.has(name))
        return true;
    return WRITE_CONTENT_KEYS.some((key) => args[key] !== undefined);
}
/*
 * [复审修复] shell 类工具的识别：exec.name 为 bash/shell/exec，或以它们为
 * 前缀且前缀后是 [-_] 分隔符或结尾（bash_exec、shell-tool 等宿主工具名变体）。
 * 要求分隔符是为了避免 'executor' 这类普通名字被误判进 shell 闸门。
 */
function isShellLikeToolName(name) {
    if (typeof name !== 'string' || name === '')
        return false;
    if (name === 'bash' || name === 'shell' || name === 'exec')
        return true;
    return /^(?:bash|shell|exec)(?:[-_]|$)/.test(name);
}
/*
 * [复审修复] 从 shell 调用的 command 字符串解析「写目标路径」。
 *
 * 返回 null = 这不是 shell 类调用（或没有 command 参数），调用方据此跳过
 * shell 闸门；返回数组则可能为空（shell 调用但不含写形态，如纯读的
 * cat/grep/less）——空数组同样放行。多提取无害：每个候选最终仍走
 * presentedWriteDenialReason 的「已交付且计划未就绪」判定，普通路径直接
 * 放行；要防的是漏提取，所以解析宁可宽进。
 *
 * 保守模式只认这些强写信号：
 *  - `>` / `>>` 重定向（含 heredoc：`cat <<EOF > path` 的重定向部分）；
 *  - `tee [-a] files...`（tee 是纯写管道，必须整组检查）；
 *  - `sed -i[.bak] ... files`（段内 -i 之后的全部非选项 token）；
 *  - `mv/cp/install 源... 目标`（只取最后一个非选项 token——源是读，只有
 *    目标是写，全取会把「复制自受保护文件」误拦成写）；
 *  - `dd of=path`。
 *
 * 启发式局限（有意保守，备查）：
 *  - 变量间接（cmd="> $f"; eval、sh -c 嵌套命令）不做展开；
 *  - find -delete、perl -i、crontab 等少见写法不覆盖；
 *  - 引号内带空格的路径按空白截断，不做完整 shell 词法分析；
 *  - 超长命令只解析前 20k 字符。
 */
const SHELL_COMMAND_PARSE_LIMIT = 20_000;
function shellWriteTargets(exec) {
    if (!isShellLikeToolName(exec?.name))
        return null;
    const command = exec?.arguments?.command;
    if (typeof command !== 'string' || command.trim() === '')
        return null;
    const text = command.length > SHELL_COMMAND_PARSE_LIMIT ? command.slice(0, SHELL_COMMAND_PARSE_LIMIT) : command;
    const targets = new Set();
    const stripQuotes = (token) => token.replace(/^['"]+|['"]+$/g, '');
    const isOption = (token) => token === '-' || token.startsWith('-') || token === '--';
    const add = (token) => {
        const cleaned = stripQuotes(String(token ?? '')).trim();
        if (cleaned !== '')
            targets.add(cleaned);
    };
    // > / >> 重定向（兼容 fd 前缀 2>file、1> file；&> 合并重定向跳过——歧义大）。
    for (const match of text.matchAll(/(?<![&\d])\d*>>?\s*([^\s;|&<>]+)/g))
        add(match[1]);
    // 按命令段分隔：; | &&。单 &（2>&1 的合并目标）不拆，避免把 fd 描述切碎。
    for (const segment of text.split(/&&|[;|]/)) {
        const trimmed = segment.trim();
        if (trimmed === '')
            continue;
        // tee [-a] files...：tee 之后到段尾的全部 token 都是写目标。
        const tee = /(?:^|\s)tee(?:\s+-[a-zA-Z]+)*\s+(\S(?:[\s\S]*?))?$/.exec(trimmed);
        if (tee && /\btee\b/.test(trimmed)) {
            for (const token of (tee[1] ?? '').split(/\s+/))
                if (!isOption(token))
                    add(token);
        }
        // sed -i[.bak] ...：段内含 sed 且带 -i 选项时，取其后的全部非选项 token。
        const sed = /(?:^|\s)sed(?:\s+-[a-zA-Z]+)*\s+(-i\S*)(?:\s+([\s\S]*))?$/.exec(trimmed);
        if (sed) {
            for (const token of (sed[2] ?? '').split(/\s+/))
                if (!isOption(token))
                    add(token);
        }
        // mv/cp/install 源... 目标：只取最后一个非选项 token（目标是写、源是读）。
        const mover = /(?:^|\s)(?:mv|cp|install)(?:\s+-[a-zA-Z]+)*\s+([\s\S]+)$/.exec(trimmed);
        if (mover) {
            const tokens = (mover[1] ?? '').split(/\s+/).filter((token) => !isOption(token));
            add(tokens[tokens.length - 1]);
        }
        // dd of=path（of= 后到空白为止）。
        for (const match of trimmed.matchAll(/(?:^|\s)of=([^\s;|&]+)/g))
            add(match[1]);
    }
    return [...targets];
}
