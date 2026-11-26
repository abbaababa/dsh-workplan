/**
 * [2.0.0] 自我学习与自我迭代（用户 2026-11-05 强制要求）。
 *
 * 用户要求：每个部门人员完成自身工作后，必须全面、深入复盘本次全过程发生的
 * 所有问题、走过的弯路、以及最终自己是如何解决的；把这些经验**永久记住**，
 * 以后做任何事不再犯类似问题和错误、不再走类似弯路。允许用文件的方式长期
 * 记忆并预防再犯。
 *
 * 实现分三块，缺一块就只是口号：
 *   1. 证据契约：第四步（验证阶段）的 `phases.verification.retrospective` 是
 *      必填项；缺少问题/弯路/解决/预防就无法记成 done（见 five-step.ts）。
 *   2. 永久记忆：复盘通过后立刻落盘到 JSONL（默认 `~/.dsh/workplan/lessons.jsonl`，
 *      可用 `DSH_WORKPLAN_LESSONS_FILE` 覆盖），追加写、跨会话跨项目长期保留。
 *   3. 防再犯：每次派发子任务前，按部门/关键词/时间/重复次数排序，把最相关的
 *      历史教训注入子 Agent 提示词；同一类错误再次出现时 `occurrences` 累加，
 *      重复次数越多排得越靠前，形成「越犯越显眼」的自我迭代闭环。
 *
 * 本模块不依赖 harness 服务，只做纯函数 + 同步文件读写，便于离线回放与测试。
 */
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
export const LESSON_VERSION = 1;
export const MAX_LESSON_ITEMS = 12;
export const MAX_LESSON_ITEM_CHARS = 600;
export const MAX_LESSON_RECORDS = 500;
export const MIN_RETRO_PROBLEM_CHARS = 20;
export const MIN_RETRO_RESOLUTION_CHARS = 20;
export const MIN_RETRO_PREVENTION_CHARS = 16;
/** 提示词里最多注入多少条历史教训（太多会淹没当前任务）。 */
/* [3.2.0][省钱] 8→6 条、3200→2200 字：只保留最高相关教训；同主题去重，避免同一规则反复付费。 */
export const MAX_LESSONS_IN_PROMPT = 6;
export const MAX_LESSON_BRIEF_CHARS = 2200;
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function cleanText(value) {
    if (typeof value !== 'string')
        return '';
    return value
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .replace(/dsh-session:[^\s"'<>]+/g, 'dsh-session:<已移除>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_LESSON_ITEM_CHARS);
}
function readList(value) {
    if (!Array.isArray(value))
        return null;
    return value
        .map((item) => cleanText(item))
        .filter(Boolean)
        .slice(0, MAX_LESSON_ITEMS);
}
function totalChars(items) {
    return items.reduce((sum, item) => sum + item.length, 0);
}
/**
 * 复盘证据的**唯一**校验入口：five-step.ts 与运行时都调它，保证
 * 「提示词要求什么」和「完成判定检查什么」是同一份契约。
 */
export function validateRetrospective(value) {
    const errors = [];
    const empty = { problems: [], detours: [], resolutions: [], prevention: [] };
    if (!isRecord(value)) {
        return {
            ok: false,
            retrospective: empty,
            errors: ['phases.verification.retrospective 缺失：第四步收尾必须复盘「问题 / 弯路 / 解决 / 预防」四项'],
        };
    }
    const problems = readList(value.problems);
    const detours = readList(value.detours);
    const resolutions = readList(value.resolutions);
    const prevention = readList(value.prevention);
    for (const [field, parsed] of [
        ['problems', problems],
        ['detours', detours],
        ['resolutions', resolutions],
        ['prevention', prevention],
    ]) {
        if (parsed === null)
            errors.push(`phases.verification.retrospective.${field} 必须是数组`);
    }
    const retro = {
        problems: problems ?? [],
        detours: detours ?? [],
        resolutions: resolutions ?? [],
        prevention: prevention ?? [],
    };
    if (problems !== null && problems.length === 0) {
        errors.push('phases.verification.retrospective.problems 至少写 1 条：本次遇到的问题（含现象与根因）');
    }
    if (resolutions !== null && resolutions.length === 0) {
        errors.push('phases.verification.retrospective.resolutions 至少写 1 条：最终是如何解决的');
    }
    if (prevention !== null && prevention.length === 0) {
        errors.push('phases.verification.retrospective.prevention 至少写 1 条：以后如何预防再犯（写成可执行规则）');
    }
    if (problems !== null && problems.length > 0 && totalChars(problems) < MIN_RETRO_PROBLEM_CHARS) {
        errors.push(`phases.verification.retrospective.problems 太薄（合计 ${totalChars(problems)} 字，至少 ${MIN_RETRO_PROBLEM_CHARS} 字）：要写清现象与根因`);
    }
    if (resolutions !== null && resolutions.length > 0 && totalChars(resolutions) < MIN_RETRO_RESOLUTION_CHARS) {
        errors.push(`phases.verification.retrospective.resolutions 太薄（合计 ${totalChars(resolutions)} 字，至少 ${MIN_RETRO_RESOLUTION_CHARS} 字）：要写清怎么解决的`);
    }
    if (prevention !== null && prevention.length > 0 && totalChars(prevention) < MIN_RETRO_PREVENTION_CHARS) {
        errors.push(`phases.verification.retrospective.prevention 太薄（合计 ${totalChars(prevention)} 字，至少 ${MIN_RETRO_PREVENTION_CHARS} 字）：要写成「遇到…先…」的可执行规则`);
    }
    return { ok: errors.length === 0, retrospective: retro, errors };
}
/** 复盘是否为空（全空数组视为「没有可记的教训」，不落盘）。 */
export function isEmptyRetrospective(retro) {
    return (retro.problems.length === 0
        && retro.detours.length === 0
        && retro.resolutions.length === 0
        && retro.prevention.length === 0);
}
function normaliseForFingerprint(text) {
    return text.toLowerCase().replace(/[\s，。；、,.;:：!！?？"'“”‘’()（）\[\]【】《》<>]/g, '');
}
/**
 * 同一类错误的指纹：部门 + 问题 + 预防规则。
 *
 * 不用整段复盘做指纹——同一个错误换个说法就会变成两条，重复次数永远累加
 * 不起来，「越犯越显眼」的自我迭代也就失效了。
 */
export function fingerprintLesson(input) {
    const material = [
        String(input.department ?? ''),
        input.problems.map(normaliseForFingerprint).join('|'),
        input.prevention.map(normaliseForFingerprint).join('|'),
    ].join('\n');
    return createHash('sha256').update(material).digest('hex').slice(0, 32);
}
/** 永久记忆文件位置：默认在用户主目录，跨项目保留；测试/多部署可用环境变量覆盖。 */
export function resolveLessonsFile(env = process.env) {
    const override = typeof env?.DSH_WORKPLAN_LESSONS_FILE === 'string'
        ? env.DSH_WORKPLAN_LESSONS_FILE.trim()
        : '';
    if (override)
        return override;
    return join(homedir(), '.dsh', 'workplan', 'lessons.jsonl');
}
function readJsonLinesSnapshot(file) {
    if (!existsSync(file))
        return { rows: [], corrupt: [], readError: null };
    let text = '';
    try {
        text = readFileSync(file, 'utf8');
    }
    catch (readError) {
        return { rows: [], corrupt: [], readError };
    }
    const rows = [];
    const corrupt = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (isRecord(parsed))
                rows.push(parsed);
            else
                corrupt.push(trimmed);
        }
        catch {
            // 单行损坏不能拖垮整份记忆：读端跳过该行，写端原样保留。
            corrupt.push(trimmed);
        }
    }
    return { rows, corrupt, readError: null };
}
function readJsonLines(file) {
    return readJsonLinesSnapshot(file).rows;
}
function coerceRecord(raw) {
    if (!isRecord(raw))
        return null;
    const problems = readList(raw.problems) ?? [];
    const prevention = readList(raw.prevention) ?? [];
    if (problems.length === 0 && prevention.length === 0)
        return null;
    return {
        version: Number(raw.version) || LESSON_VERSION,
        id: typeof raw.id === 'string' ? raw.id : '',
        at: Number(raw.at) || 0,
        planId: typeof raw.planId === 'string' ? raw.planId : '',
        subtaskId: typeof raw.subtaskId === 'string' ? raw.subtaskId : '',
        department: typeof raw.department === 'string' ? raw.department : '',
        title: cleanText(raw.title),
        cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
        problems,
        detours: readList(raw.detours) ?? [],
        resolutions: readList(raw.resolutions) ?? [],
        prevention,
        occurrences: Math.max(1, Number(raw.occurrences) || 1),
        fingerprint: typeof raw.fingerprint === 'string' ? raw.fingerprint : '',
    };
}
export function readLessons(file = resolveLessonsFile()) {
    return readJsonLines(file)
        .map(coerceRecord)
        .filter((item) => item !== null);
}
/**
 * [3.0.3] 防符号链接投毒：写入前确认目标不是符号链接，否则抛错拒绝
 * （风格同 LESSONS_READ_FAILED）。攻击者把教训文件或临时文件路径换成
 * 符号链接后，一次「原子重写」就会被重定向去覆盖无关文件。
 */
function assertLessonsWriteTarget(file, what) {
    let stat;
    try {
        stat = lstatSync(file);
    }
    catch {
        return; // 不存在：正常新写。
    }
    if (stat.isSymbolicLink()) {
        throw new Error(`LESSONS_WRITE_REFUSED: 拒绝向符号链接${what}写入 ${file}，以免被重定向覆盖无关文件`);
    }
}
function writeLessonsAtomic(file, records, corrupt = []) {
    assertLessonsWriteTarget(file, '');
    assertLessonsWriteTarget(`${file}.bak`, '备份');
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const lines = [
        ...records.map((item) => JSON.stringify(item)),
        // 坏行原样留在文件末尾：下次读端仍会跳过，但绝不会因为一次重写就消失。
        ...corrupt,
    ];
    const body = lines.length > 0 ? `${lines.join('\n')}\n` : '';
    // 覆盖前留一代备份；备份失败不阻断主写入（主写入仍走临时文件 + 原子改名）。
    if (existsSync(file)) {
        try {
            copyFileSync(file, `${file}.bak`);
        }
        catch {
            // 备份是尽力而为：权限不足等情况下，主写入的失败会由调用方显式上报。
        }
    }
    const tmp = `${file}.tmp-${process.pid}`;
    assertLessonsWriteTarget(tmp, '临时文件');
    writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
    // 已存在文件收紧到 0o600（rename 覆盖了同名符号链接之外的目标时，
    // 权限可能带着旧文件的宽松位）：best-effort，文件系统不支持时不断写。
    try {
        chmodSync(file, 0o600);
    }
    catch {
        // best-effort。
    }
}
/**
 * 把一次复盘写入永久记忆。
 *
 * - 同一子任务重复结算（重试/回放）→ 原地更新，不虚增重复次数；
 * - 不同子任务出现同一类错误 → occurrences 累加（自我迭代：越重复越靠前）；
 * - 文件保留最近 MAX_LESSON_RECORDS 条，先写临时文件再改名，避免半截文件。
 */
export function recordLesson(input) {
    const retro = input.retrospective;
    if (!retro || isEmptyRetrospective(retro))
        return null;
    const file = input.file ?? resolveLessonsFile();
    const now = Number(input.now) || Date.now();
    const fingerprint = fingerprintLesson({
        department: input.department,
        problems: retro.problems,
        prevention: retro.prevention,
    });
    const snapshot = readJsonLinesSnapshot(file);
    /*
     * 数据安全红线：读失败 ≠ 没有历史。
     * 以前这里把 EACCES/EMFILE/EIO 当成空数组，随后「读-改-写」会把整份永久记忆
     * 覆盖成刚写入的这一条。现在读失败直接抛错，由 runtime 的 catch 记录到状态里；
     * 坏行则原样带回写端，重写时不会丢。
     */
    if (snapshot.readError) {
        const message = snapshot.readError instanceof Error
            ? snapshot.readError.message
            : String(snapshot.readError);
        throw new Error(`LESSONS_READ_FAILED: 无法读取 ${file}，已拒绝写入以免覆盖历史教训（${message}）`);
    }
    const records = snapshot.rows
        .map(coerceRecord)
        .filter((item) => item !== null);
    const sameRow = records.findIndex((item) => item.planId === input.planId && item.subtaskId === input.subtaskId);
    const sameIssue = records.findIndex((item) => item.fingerprint === fingerprint && item.department === input.department);
    const base = {
        version: LESSON_VERSION,
        id: `L-${now.toString(36)}-${fingerprint.slice(0, 6)}`,
        at: now,
        planId: String(input.planId ?? ''),
        subtaskId: String(input.subtaskId ?? ''),
        department: String(input.department ?? ''),
        title: cleanText(input.title),
        cwd: typeof input.cwd === 'string' ? input.cwd : '',
        problems: retro.problems,
        detours: retro.detours,
        resolutions: retro.resolutions,
        prevention: retro.prevention,
        occurrences: 1,
        fingerprint,
    };
    let mode = 'created';
    if (sameRow >= 0) {
        base.id = records[sameRow].id || base.id;
        base.occurrences = records[sameRow].occurrences;
        records[sameRow] = base;
        mode = 'updated';
    }
    else if (sameIssue >= 0) {
        base.id = records[sameIssue].id || base.id;
        base.occurrences = records[sameIssue].occurrences + 1;
        base.detours = Array.from(new Set([...records[sameIssue].detours, ...retro.detours])).slice(0, MAX_LESSON_ITEMS);
        base.resolutions = Array.from(new Set([...records[sameIssue].resolutions, ...retro.resolutions])).slice(0, MAX_LESSON_ITEMS);
        base.prevention = Array.from(new Set([...records[sameIssue].prevention, ...retro.prevention])).slice(0, MAX_LESSON_ITEMS);
        records[sameIssue] = base;
        mode = 'repeated';
    }
    else {
        records.push(base);
    }
    // 时间正序保留最近 N 条；id 冲突（同一毫秒重复）时无需特殊处理，读端按行。
    const kept = records.slice(Math.max(0, records.length - MAX_LESSON_RECORDS));
    try {
        writeLessonsAtomic(file, kept, snapshot.corrupt);
    }
    catch (error) {
        // 符号链接投毒是拒绝不是故障：不上 append 兜底，直接向上抛。
        if (error instanceof Error && error.message.startsWith('LESSONS_WRITE_REFUSED'))
            throw error;
        try {
            mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
            assertLessonsWriteTarget(file, '');
            appendFileSync(file, `${JSON.stringify(base)}\n`, 'utf8');
        }
        catch {
            return null;
        }
    }
    return { record: base, mode };
}
function keywordsOf(query) {
    const text = `${query.title ?? ''} ${query.objective ?? ''}`;
    const latin = text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [];
    const cjk = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
    const pieces = new Set();
    for (const word of latin)
        pieces.add(word);
    for (const run of cjk) {
        // 中文没有空格：用 2 字滑窗做轻量关键词，足以把「超时/回放/写保护」这类主题捞出来。
        for (let i = 0; i + 2 <= run.length; i += 1)
            pieces.add(run.slice(i, i + 2));
    }
    return Array.from(pieces).filter((item) => item.length >= 2).slice(0, 60);
}
/** 相关度排序：同部门 > 同项目 > 关键词命中 > 重复次数 > 新近程度。 */
export function rankLessons(lessons, query = {}) {
    const now = Number(query.now) || Date.now();
    const words = keywordsOf(query);
    const hasFilter = Boolean(query.department || query.cwd || words.length > 0);
    const scored = lessons.map((lesson) => {
        let score = 0;
        let matched = false;
        if (query.department && lesson.department === query.department) {
            score += 40;
            matched = true;
        }
        if (query.cwd && lesson.cwd && lesson.cwd === query.cwd) {
            score += 12;
            matched = true;
        }
        const haystack = `${lesson.title} ${lesson.problems.join(' ')} ${lesson.detours.join(' ')} ${lesson.prevention.join(' ')}`.toLowerCase();
        let hits = 0;
        for (const word of words) {
            if (haystack.includes(word))
                hits += 1;
        }
        if (hits > 0)
            matched = true;
        score += Math.min(hits, 8) * 3;
        score += Math.min(lesson.occurrences, 6) * 4;
        const ageDays = Math.max(0, (now - lesson.at) / 86_400_000);
        if (ageDays <= 7)
            score += 6;
        else if (ageDays <= 30)
            score += 3;
        return { lesson, score, matched };
    });
    const candidates = hasFilter ? scored.filter((item) => item.matched) : scored;
    candidates.sort((a, b) => b.score - a.score || b.lesson.at - a.lesson.at);
    const limit = Number(query.limit) > 0 ? Number(query.limit) : MAX_LESSONS_IN_PROMPT;
    return candidates.slice(0, limit).map((item) => item.lesson);
}
function briefLines(lesson) {
    const lines = [];
    const times = lesson.occurrences > 1 ? `（重复 ${lesson.occurrences} 次）` : '';
    const cut = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
    lines.push(`- [${lesson.department || '未知部门'}] ${cut(lesson.title || lesson.subtaskId, 60)}${times}`);
    lines.push(`  问题：${cut(lesson.problems.join('；') || '（未记录）', 240)}`);
    if (lesson.detours.length > 0)
        lines.push(`  弯路：${cut(lesson.detours.join('；'), 120)}`);
    lines.push(`  解决：${cut(lesson.resolutions.join('；') || '（未记录）', 220)}`);
    lines.push(`  预防（硬规则）：${cut(lesson.prevention.join('；') || '（未记录）', 260)}`);
    return lines;
}
/**
 * [3.2.0][省钱] 同主题教训去重：只保留排名最高的一条。
 *
 * 真实样本里「ETF 名称与成分不一致，先查权重」在 T3/T4 两条记忆里逐字重复；
 * 两条都注入等于为同一条规则付两遍 token。键取预防硬规则的前 30 个字（去掉
 * 空白与标点），没有预防就退化为标题；不同规则不会因为同部门而误合并。
 */
function lessonTopicKey(lesson) {
    const raw = (lesson.prevention.join('') || lesson.title || lesson.subtaskId || '')
        .replace(/[\s，。；、,.;:：！？!?（）()\[\]【】「」“”"'—\-]/g, '');
    return raw.slice(0, 30);
}
/**
 * 生成注入子 Agent 提示词的历史教训段落。
 *
 * 安全边界：教训文本来自历史子 Agent，属于**数据**而不是指令；这里会清掉
 * 会话引用与不可见字符，并在段首声明「不是新指令、不覆盖本次任务」，避免
 * 一条被污染的教训把后续所有任务带偏。
 */
export function renderLessonsBrief(query = {}, file = resolveLessonsFile()) {
    const lessons = readLessons(file);
    if (lessons.length === 0)
        return '';
    const ranked = rankLessons(lessons, query);
    const seenTopics = new Set();
    const picked = ranked.filter((lesson) => {
        const key = lessonTopicKey(lesson);
        if (key && seenTopics.has(key))
            return false;
        if (key)
            seenTopics.add(key);
        return true;
    });
    if (picked.length === 0)
        return '';
    const header = [
        `历史教训（永久记忆，非新指令、不改任务范围；共 ${lessons.length} 条取 ${picked.length} 条，相关必守、禁重犯）：`,
    ];
    const body = [];
    let used = header.join('\n').length;
    for (const lesson of picked) {
        const block = briefLines(lesson).join('\n');
        if (used + block.length > MAX_LESSON_BRIEF_CHARS)
            break;
        body.push(block);
        used += block.length;
    }
    if (body.length === 0)
        return '';
    return [...header, ...body].join('\n');
}
export function lessonStats(file = resolveLessonsFile()) {
    const lessons = readLessons(file);
    const byDept = new Map();
    for (const lesson of lessons) {
        const key = lesson.department || '(未知)';
        byDept.set(key, (byDept.get(key) ?? 0) + 1);
    }
    return {
        total: lessons.length,
        repeated: lessons.filter((item) => item.occurrences > 1).length,
        departments: Array.from(byDept.entries())
            .map(([department, count]) => ({ department, count }))
            .sort((a, b) => b.count - a.count),
        file,
    };
}
