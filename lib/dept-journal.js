/**
 * [2.5.4][T5] 部门消息留痕（journal）——用户决策 D5/D6 的持久化底座。
 *
 * 唯一权威契约：_t5_channel_20261112/00-contract-v1.md（FROZEN，T5 负责人冻结）。
 * 本文件严格实现契约 §1 消息结构与 §2 冻结导出；其他人只 import 不改。
 * 任何字段/语义变更必须经 T5 负责人重新冻结，不得私改。
 *
 * 设计纪律（契约 §2/§6）：
 *   - 纯函数 + 同步 fs，不依赖 harness 服务，不 import runtime/plan（避免环）；
 *     落盘模式参照 src/lessons.ts（JSONL 追加写、容错读取、坏行不静默吞）。
 *   - fail-closed：未知 kind/role、缺字段、超限一律拒（validateDeptMessage）。
 *   - 一切失败显式返回（JOURNAL_WRITE_FAILED / JOURNAL_READ_FAILED），绝不静默；
 *     planId 只允许 [A-Za-z0-9_-]{1,120}，非法抛 INVALID_PLAN_ID（防路径穿越）。
 *   - 目录 env DSH_WORKPLAN_JOURNAL_DIR || ~/.dsh/workplan/journal；文件 <planId>.jsonl。
 *   - 本模块只负责留痕的写/读/校验，不做任何投递与状态判定（路由归 runtime.ts，
 *     由 channel-expert 按契约 §3 实现）。
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/** 接口版本（契约 §1：字面量 1）。 */
export const DEPT_MESSAGE_VERSION = 1;
/** 7 种关键沟通（frozen 数组，契约 §1/§2；日常闲聊不属于任何 kind，不入库）。 */
export const DEPT_MESSAGE_KINDS = Object.freeze([
    'dispatch',
    'instruction',
    'escalation',
    'estimate',
    'completion',
    'need',
    'receipt',
]);
/**
 * 角色枚举（frozen 数组，契约 §1/§2）。
 *
 * [3.0.0][用户要求 9] 部门组员角色已取消：新写入只使用 root/head/expert。
 * `member` 保留在枚举里仅用于**读取历史 journal**（append-only 历史记录不可
 * 追溯改写，拒绝读取会让旧会话的回放直接失败）；现有代码不再产生该值。
 */
export const DEPT_ROLES = Object.freeze([
    'root',
    'head',
    'expert',
    'member',
]);
/* —— 契约 §1 的边界常量（私有；数值全部来自冻结契约，不得私改） —— */
const MAX_ID_CHARS = 80;
const MAX_TS = 8.64e15;
const MAX_PLAN_ID_CHARS = 120;
/** subtaskId 契约未给上限；取与 planId 同宽的防御边界（行 ID 形如 T5/R1-2，远小于此）。 */
const MAX_SUBTASK_ID_CHARS = 120;
const MAX_SESSION_ID_CHARS = 200;
const MAX_MEMBER_CHARS = 80;
const MAX_BODY_CHARS = 4000;
const MAX_DATA_JSON_CHARS = 4000;
const MAX_DELIVERY_MESSAGE_ID_CHARS = 200;
const MAX_DELIVERY_CODE_CHARS = 80;
const MAX_DELIVERY_ERROR_CHARS = 4000;
const DEFAULT_READ_LIMIT = 500;
const MAX_READ_LIMIT = 5000;
const PLAN_ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
/** 与 lessons.ts 同口径：去掉不可见控制字符，保留 \t \n \r。 */
function cleanBody(value) {
    return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}
function errorText(error) {
    const text = error instanceof Error ? error.message : String(error);
    return text.slice(0, 500);
}
function isNonEmptyString(value, maxChars) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= maxChars;
}
/**
 * 生成消息 id：msg-<ts36>-<rand6>（契约 §1）。
 * now 非法（缺省/非有限/越界）时回退 Date.now()；总长恒 ≤80。
 */
export function makeDeptMessageId(now) {
    const ts = typeof now === 'number' && Number.isFinite(now) && now > 0 && now <= MAX_TS
        ? Math.floor(now)
        : Date.now();
    return `msg-${ts.toString(36)}-${randomBytes(3).toString('hex')}`;
}
function validateEndpoint(value, label) {
    if (!isRecord(value))
        return `${label} 必须是对象`;
    const sessionId = value.sessionId;
    if (!isNonEmptyString(sessionId, MAX_SESSION_ID_CHARS)) {
        return `${label}.sessionId 必填且 ≤${MAX_SESSION_ID_CHARS} 字符`;
    }
    const role = value.role;
    if (typeof role !== 'string' || !DEPT_ROLES.includes(role)) {
        return `${label}.role 非法（期望 ${DEPT_ROLES.join('/')}）`;
    }
    const member = value.member;
    const needsMember = role === 'expert' || role === 'member';
    if (needsMember && !isNonEmptyString(member, MAX_MEMBER_CHARS)) {
        return `${label}.member 必填（expert/member 角色）且 ≤${MAX_MEMBER_CHARS} 字符`;
    }
    if (member !== undefined && !isNonEmptyString(member, MAX_MEMBER_CHARS)) {
        return `${label}.member 若提供必须非空且 ≤${MAX_MEMBER_CHARS} 字符`;
    }
    const endpoint = { sessionId, role: role };
    if (member !== undefined)
        endpoint.member = member;
    return endpoint;
}
function validateDelivery(value) {
    if (!isRecord(value))
        return 'delivery 必须是对象';
    const status = value.status;
    if (status !== 'sent' && status !== 'failed') {
        return 'delivery.status 非法（期望 sent/failed）';
    }
    const delivery = { status };
    if (value.messageId !== undefined) {
        if (!isNonEmptyString(value.messageId, MAX_DELIVERY_MESSAGE_ID_CHARS)) {
            return `delivery.messageId 若提供必须非空且 ≤${MAX_DELIVERY_MESSAGE_ID_CHARS} 字符`;
        }
        delivery.messageId = value.messageId;
    }
    if (value.code !== undefined) {
        if (!isNonEmptyString(value.code, MAX_DELIVERY_CODE_CHARS)) {
            return `delivery.code 若提供必须非空且 ≤${MAX_DELIVERY_CODE_CHARS} 字符`;
        }
        delivery.code = value.code;
    }
    if (value.error !== undefined) {
        if (typeof value.error !== 'string' || value.error.length > MAX_DELIVERY_ERROR_CHARS) {
            return `delivery.error 若提供必须是字符串且 ≤${MAX_DELIVERY_ERROR_CHARS} 字符`;
        }
        delivery.error = value.error;
    }
    if (value.latencyMs !== undefined) {
        if (typeof value.latencyMs !== 'number' || !Number.isFinite(value.latencyMs) || value.latencyMs < 0) {
            return 'delivery.latencyMs 若提供必须是 ≥0 的有限数字';
        }
        delivery.latencyMs = value.latencyMs;
    }
    return delivery;
}
/**
 * 契约 §2 的唯一校验入口（fail-closed）：未知 kind/role、缺字段、超限一律拒。
 * 通过时返回白名单归一化后的 DeptMessage（body 已清洗控制字符）。
 */
export function validateDeptMessage(value) {
    const fail = (error) => ({ ok: false, error: `INVALID_MESSAGE: ${error}` });
    if (!isRecord(value))
        return fail('消息必须是对象');
    if (value.v !== DEPT_MESSAGE_VERSION)
        return fail(`v 必须为 ${DEPT_MESSAGE_VERSION}`);
    if (!isNonEmptyString(value.id, MAX_ID_CHARS))
        return fail(`id 必填且 ≤${MAX_ID_CHARS} 字符`);
    const ts = value.ts;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0 || ts > MAX_TS) {
        return fail('ts 必须是 >0 且 ≤8.64e15 的有限 epoch ms');
    }
    if (!isNonEmptyString(value.planId, MAX_PLAN_ID_CHARS)) {
        return fail(`planId 必填且 ≤${MAX_PLAN_ID_CHARS} 字符`);
    }
    if (!isNonEmptyString(value.subtaskId, MAX_SUBTASK_ID_CHARS)) {
        return fail(`subtaskId 必填且 ≤${MAX_SUBTASK_ID_CHARS} 字符`);
    }
    const kind = value.kind;
    if (typeof kind !== 'string' || !DEPT_MESSAGE_KINDS.includes(kind)) {
        return fail(`kind 非法（期望 ${DEPT_MESSAGE_KINDS.join('/')}）`);
    }
    const from = validateEndpoint(value.from, 'from');
    if (typeof from === 'string')
        return fail(from);
    const to = validateEndpoint(value.to, 'to');
    if (typeof to === 'string')
        return fail(to);
    if (typeof value.body !== 'string')
        return fail('body 必须是字符串');
    if (value.body.length > MAX_BODY_CHARS)
        return fail(`body 超限（≤${MAX_BODY_CHARS} 字符）`);
    const body = cleanBody(value.body);
    let data;
    if (value.data !== undefined) {
        if (!isRecord(value.data))
            return fail('data 若提供必须是对象');
        let json;
        try {
            json = JSON.stringify(value.data);
        }
        catch {
            return fail('data 必须可 JSON 序列化');
        }
        if (typeof json !== 'string' || json.length > MAX_DATA_JSON_CHARS) {
            return fail(`data JSON 超限（≤${MAX_DATA_JSON_CHARS} 字符）`);
        }
        data = value.data;
    }
    const delivery = validateDelivery(value.delivery);
    if (typeof delivery === 'string')
        return fail(delivery);
    const message = {
        v: DEPT_MESSAGE_VERSION,
        id: value.id,
        ts,
        planId: value.planId,
        subtaskId: value.subtaskId,
        kind: kind,
        from,
        to,
        body,
        delivery,
    };
    if (data !== undefined)
        message.data = data;
    return { ok: true, value: message };
}
/** 留痕目录：env DSH_WORKPLAN_JOURNAL_DIR || ~/.dsh/workplan/journal（契约 §2）。 */
function resolveJournalDir() {
    const override = typeof process.env.DSH_WORKPLAN_JOURNAL_DIR === 'string'
        ? process.env.DSH_WORKPLAN_JOURNAL_DIR.trim()
        : '';
    if (override)
        return override;
    return join(homedir(), '.dsh', 'workplan', 'journal');
}
/**
 * 留痕文件路径：<目录>/<planId>.jsonl。
 * planId 只允许 [A-Za-z0-9_-]{1,120}；非法抛显式错误 INVALID_PLAN_ID（防路径穿越）。
 */
export function deptJournalPath(planId) {
    if (typeof planId !== 'string' || !PLAN_ID_PATTERN.test(planId)) {
        throw new Error(`INVALID_PLAN_ID: planId 只允许 [A-Za-z0-9_-]{1,120}，收到 ${JSON.stringify(String(planId)).slice(0, 100)}`);
    }
    return join(resolveJournalDir(), `${planId}.jsonl`);
}
/**
 * 追加一条留痕（契约 §2）：先 validate，再 mkdirSync(recursive)+appendFileSync。
 * 任何失败（校验不过 / planId 非法 / 写盘失败 / 回读不一致）显式返回
 * JOURNAL_WRITE_FAILED / JOURNAL_READBACK_FAILED，绝不静默。
 */
export function appendDeptMessage(msg) {
    const verdict = validateDeptMessage(msg);
    if (!verdict.ok)
        return { ok: false, code: 'JOURNAL_WRITE_FAILED', error: verdict.error };
    let path;
    try {
        path = deptJournalPath(verdict.value.planId);
    }
    catch (error) {
        return { ok: false, code: 'JOURNAL_WRITE_FAILED', error: errorText(error) };
    }
    try {
        /*
         * [安全加固] 防符号链接投毒：journal 文件若是符号链接则跳过写入并告警——
         * 绝不跟随链接把审计内容写到链接指向的任意路径；失败显式返回（绝不静默）。
         * lstatSync 抛错（文件不存在等）属正常首写场景，交给 appendFileSync 处理。
         */
        try {
            if (lstatSync(path).isSymbolicLink()) {
                console.warn(`dsh-workplan: journal 文件是符号链接，跳过写入 path=${path}`);
                return {
                    ok: false,
                    code: 'JOURNAL_WRITE_FAILED',
                    error: `JOURNAL_WRITE_FAILED: journal 文件是符号链接，已跳过写入 path=${path}（防链接投毒）。`,
                };
            }
        }
        catch {
            /* 文件不存在（首写）或 lstat 失败：继续走正常写入，错误由 appendFileSync 显式上报。 */
        }
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        appendFileSync(path, `${JSON.stringify(verdict.value)}\n`, { encoding: 'utf8', mode: 0o600 });
        try {
            // 既有文件权限收紧为 0o600（best-effort；新建文件已由 mode 覆盖）。
            chmodSync(path, 0o600);
        }
        catch {
            /* best-effort：权限收紧失败不阻断追加。 */
        }
    }
    catch (error) {
        return { ok: false, code: 'JOURNAL_WRITE_FAILED', error: errorText(error) };
    }
    /* [T3][回读校验] 写后读回比对关键字段（见下方 helper 注释），不一致绝不静默。 */
    const readback = verifyJournalAppendReadback(path, verdict.value);
    if (!readback.ok)
        return { ok: false, code: 'JOURNAL_READBACK_FAILED', error: readback.error };
    return { ok: true, path };
}
/*
 * [T3][回读校验] journal 追加写后读回。依据：reports/wp-member-expert-persist-call-T1.json
 * 写盘点⑦（dept-journal.ts:290-308；2026-11-17 复核 mkdirSync:302、appendFileSync:303
 * 无漂移）与 reports/wp-member-expert-storage-T1-storage.json（落盘路径
 * <journalDir>/<planId>.jsonl，事件流追加、非整文件快照）。
 * appendFileSync 成功后读回文件末尾窗口，JSON 解析后比对关键字段（v/id/planId/
 * subtaskId/kind/ts/body 头 120 字摘要）。找不到匹配行 → 返回显式错误码
 * JOURNAL_READBACK_FAILED（本模块「绝不静默」契约=显式错误码+处置指引，与
 * JOURNAL_WRITE_FAILED 同口径；负责人硬性要求③的「抛显式错误」在本模块以
 * 显式错误码实现，错误信息含文件路径与期望/实际摘要及指引：重试或让主 Agent
 * 手动制定计划）。纯读校验、不写盘 → 幂等（硬性要求④）。
 *
 * [复审修复][O(n²)→O(窗口)] journal 默认永久保留，文件会涨到 MB 级；旧实现每次
 * 追加后 readFileSync 整个文件逐行 parse，热路径每次请示/指示/完成/预估都全文件
 * 重读。改为只读末尾一个窗口（JOURNAL_READBACK_WINDOW_BYTES）：
 *   - O_APPEND 保证刚写入的行必在文件末尾；窗口 ≥ 单行最大体积（body ≤4000 字符 +
 *     data JSON ≤4000 字符，单 line 远小于 64KB）即可命中；
 *   - 窗口起点可能落在行中间 → 首行 parse 失败直接跳过该坏行继续；
 *   - 并发追加交错不会把新行挤出窗口（需同一瞬时有 64KB 更新行写入才会，
 *     概率可忽略；且失败显式可重试）。
 */
function deptMessageKeyDigest(record) {
    return JSON.stringify({
        v: record?.v,
        id: record?.id,
        planId: record?.planId,
        subtaskId: record?.subtaskId,
        kind: record?.kind,
        ts: record?.ts,
        bodyHead: String(record?.body ?? '').slice(0, 120),
    });
}
/** 回读窗口字节数：64KB。单行最大体积（body 4000 + data JSON 4000 + 结构开销）远小于此。 */
const JOURNAL_READBACK_WINDOW_BYTES = 64 * 1024;
/** 只读文件末尾一个窗口（按字节）；文件小于窗口则全读。读失败由调用方捕获。 */
function readJournalTailWindow(path, windowBytes) {
    const { size } = statSync(path);
    const start = Math.max(0, size - windowBytes);
    const length = size - start;
    if (length <= 0)
        return '';
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, 'r');
    try {
        let offset = 0;
        while (offset < length) {
            const read = readSync(fd, buffer, offset, length - offset, start + offset);
            if (read <= 0)
                break;
            offset += read;
        }
    }
    finally {
        closeSync(fd);
    }
    return buffer.toString('utf8');
}
function verifyJournalAppendReadback(path, expected) {
    let text;
    try {
        text = readJournalTailWindow(path, JOURNAL_READBACK_WINDOW_BYTES);
    }
    catch (error) {
        return {
            ok: false,
            error: `dsh-workplan: journal 回读校验读不到文件 path=${path}（${errorText(error)}）。`
                + '请重试；若多次失败请让主 Agent 手动制定计划。',
        };
    }
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    const want = deptMessageKeyDigest(expected);
    /*
     * 只扫末尾窗口：窗口首行可能被截断（窗口从行中间字节开始），parse 失败跳过该
     * 坏行继续；新追加的行（digest 匹配）由 O_APPEND 保证在文件末尾、必在窗口内。
     */
    for (const line of lines) {
        let parsed = null;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (deptMessageKeyDigest(parsed) === want)
            return { ok: true };
    }
    const tail = lines.slice(-5);
    const actual = tail
        .map((line) => {
        try {
            return deptMessageKeyDigest(JSON.parse(line));
        }
        catch {
            return '<不可解析行>';
        }
    })
        .join(' | ');
    return {
        ok: false,
        error: `dsh-workplan: journal 落盘回读校验失败 path=${path}：写入内容与读回内容关键字段不一致。`
            + `期望=${want.slice(0, 300)} 实际(末${tail.length}行)=${actual.slice(0, 300)}。`
            + '请重试；若多次失败请让主 Agent 手动制定计划。',
    };
}
/**
 * 按追加序回放留痕（契约 §2）：
 *   - 文件不存在 → 空列表（ok:true）；
 *   - 坏行（JSON 损坏或校验不过）计入 skipped，不静默吞；
 *   - kind/since 过滤后按 limit 截取：默认 500、上限 5000；newest=true 取最近，否则取最早；
 *   - planId 非法或读盘失败 → 显式 JOURNAL_READ_FAILED。
 */
export function readDeptMessages(planId, filter) {
    let path;
    try {
        path = deptJournalPath(planId);
    }
    catch (error) {
        return { ok: false, code: 'JOURNAL_READ_FAILED', error: errorText(error) };
    }
    if (!existsSync(path))
        return { ok: true, messages: [], skipped: 0 };
    let text;
    try {
        text = readFileSync(path, 'utf8');
    }
    catch (error) {
        return { ok: false, code: 'JOURNAL_READ_FAILED', error: errorText(error) };
    }
    const kind = filter?.kind;
    const since = typeof filter?.since === 'number' && Number.isFinite(filter.since)
        ? filter.since
        : null;
    const rawLimit = Number(filter?.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), MAX_READ_LIMIT)
        : DEFAULT_READ_LIMIT;
    const matched = [];
    let skipped = 0;
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch {
            skipped += 1;
            continue;
        }
        const verdict = validateDeptMessage(parsed);
        if (!verdict.ok) {
            skipped += 1;
            continue;
        }
        const message = verdict.value;
        if (kind !== undefined && message.kind !== kind)
            continue;
        if (since !== null && message.ts < since)
            continue;
        matched.push(message);
    }
    return { ok: true, messages: filter?.newest ? matched.slice(-limit) : matched.slice(0, limit), skipped };
}
/**
 * [3.0.6][第 2 批] 留痕目录的可选保留策略（默认关闭）。
 *
 * 审计证据不该被默认删除，所以本函数只在显式配置
 * `journalRetentionDays > 0`（或环境变量
 * `DSH_WORKPLAN_JOURNAL_RETENTION_DAYS`）时被调用。它只删除同时满足以下
 * 条件的文件：目录里直接的 `.jsonl` 普通文件、文件名是合法 planId、
 * mtime 早于保留天数。活跃计划会持续追加，mtime 保持新，因此不会被误删。
 *
 * 单次最多删 `maxFiles`（默认 200，上限 1000）个最旧文件，避免一次启动
 * 长时间阻塞；删除失败不再静默跳过——逐个 console.warn 一行并收集进
 * 返回值的 `errors[]`（ok 保持 true，兼容既有调用方）。
 *
 * [复审修复] `excludePlanIds`（可选）：文件名（去 .jsonl）在集合内的一律
 * 跳过删除，防「活跃但安静」（久无新消息、mtime 变旧）的计划被误删。
 */
export function pruneJournal(options) {
    const days = Number(options?.retentionDays);
    if (!Number.isFinite(days) || days <= 0)
        return { ok: true, scanned: 0, deleted: [] };
    const dir = resolveJournalDir();
    let names;
    try {
        names = readdirSync(dir);
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return { ok: true, scanned: 0, deleted: [] };
        return { ok: false, scanned: 0, deleted: [], error: errorText(error) };
    }
    const now = Number.isFinite(options?.now) ? Number(options.now) : Date.now();
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const maxFiles = Math.max(0, Math.min(1000, Math.trunc(options?.maxFiles ?? 200)));
    const exclude = options?.excludePlanIds;
    const candidates = [];
    for (const name of names) {
        if (!name.endsWith('.jsonl'))
            continue;
        const planId = name.slice(0, -'.jsonl'.length);
        if (!PLAN_ID_PATTERN.test(planId))
            continue;
        // 活跃但安静的保护名单：在册计划即使 mtime 超期也不删。
        if (exclude?.has(planId))
            continue;
        const path = join(dir, name);
        try {
            const stat = lstatSync(path);
            // 只删普通文件；符号链接一律跳过（防越界删除）。
            if (!stat.isFile() || stat.isSymbolicLink())
                continue;
            if (stat.mtimeMs >= cutoff)
                continue;
            candidates.push({ name, path, mtimeMs: stat.mtimeMs });
        }
        catch {
            // 单个文件 stat 失败不影响其他文件，最后以 scanned 如实反映总数。
            continue;
        }
    }
    candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const deleted = [];
    const errors = [];
    for (const candidate of candidates.slice(0, maxFiles)) {
        try {
            unlinkSync(candidate.path);
            deleted.push(candidate.name);
        }
        catch (error) {
            // 单个 unlink 失败不再静默：收集原因 + 逐条 warn（ok 保持 true 兼容）。
            const reason = `${candidate.name}: ${errorText(error)}`;
            errors.push(reason);
            console.warn(`dsh-workplan: journal 保留清理删除失败 ${reason} path=${candidate.path}`);
        }
    }
    const result = {
        ok: true,
        scanned: names.length,
        deleted,
    };
    if (errors.length > 0)
        result.errors = errors;
    return result;
}
