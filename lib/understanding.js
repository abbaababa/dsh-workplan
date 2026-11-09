/**
 * Structured task understanding, department matching and anchor deviation check
 * (T10 / M1 + M2, 1.12.0).
 *
 * Why this module exists
 * ----------------------
 * Before 1.12.0 the planner was a single model call:
 *
 *     user task -> model -> JSON plan -> twelve-value enum check -> dispatch
 *
 * `validatePlan` only asked "is `department` one of the twelve keys?". It had no
 * access to the user's original words, no notion of what a department can do,
 * and no way to notice that a subtask had drifted away from the request. The T4
 * diagnosis proved the consequence with a counter-example: a picture-book task
 * carrying a penetration-testing subtask still validated `ok:true`.
 *
 * This module adds the three deterministic stages the acceptance criterion asks
 * for, *after* the model produces its plan and *before* anything is dispatched:
 *
 *   1. extract  — pull hard requirements out of the user's own text
 *                 (versions, counts, dates, paths, ids, numeric bounds,
 *                 explicit negations, pronoun references, contradictions);
 *   2. match    — score every subtask against the department capability
 *                 catalog and explain the score with the exact keywords hit;
 *   3. check    — compare the plan (and the model's own restatement) against the
 *                 read-only anchor, and report every dropped hard element.
 *
 * Everything here is pure: no model call, no network, no clock, no filesystem.
 * The same inputs always produce the same audit, which makes the result
 * reproducible and unit-testable. A model-based reviewer would be *another*
 * opinion, not evidence — so it is deliberately not part of this path.
 *
 * Failure policy (why not everything blocks)
 * ------------------------------------------
 * A false rejection is worse than a warning: it turns a valid task into a
 * degraded plan. Only contradictions strong enough to be wrong in any reading
 * are blocking:
 *
 *   - a hard anchor (version / date / count / path / id / numeric bound) that
 *     exists in the user text but appears nowhere in the plan;
 *   - a subtask assigned to a guarded department (security/legal/finance/
 *     operations) whose domain vocabulary appears only in the subtask and never
 *     in the user's request, with no shared content token at all.
 *
 * Pronouns without context and contradictory requirements are reported as
 * warnings, never as silent passes: the plan message tells the main Agent to
 * clarify before dispatch. All thresholds are named constants so a test can pin
 * them instead of relying on prose.
 */
import { createHash } from 'node:crypto';
import { DEPARTMENT_CAPABILITIES, DEPARTMENT_INTRUSION_GUARDED, departmentCapability, keywordHit, matchDepartmentKeywords, scoreDepartments, } from './departments.js';
export const UNDERSTANDING_AUDIT_VERSION = 1;
/** Same cap the planner prompt uses for the task text. */
export const MAX_TASK_ANCHOR_CHARS = 16000;
/** Enough to cover a dense six-part request without turning the audit into a dump. */
export const MAX_TASK_ELEMENTS = 40;
/** A plan with more subtasks than this cannot exist (`MAX_SUBTASKS`), kept local to avoid a cycle. */
export const MAX_AUDITED_SUBTASKS = 15;
/**
 * A mismatch is blocking when the chosen department has zero supporting
 * keywords and another department has at least this many. Three is high enough
 * that a single incidental word cannot trigger it.
 */
export const MISMATCH_BLOCKING_SCORE = 3;
/**
 * [P0-1] Domain coverage threshold.
 *
 * The MS2 run (2026-11-03) measured 11/29 required departments present: plans
 * silently dropped whole domains (design/legal/security/devops) the user's own
 * request names. A single incidental keyword is not evidence of a domain, so a
 * department counts as *implied by the request* only when at least two of its
 * catalogue keywords occur in the user text. Named so tests pin it.
 */
export const REQUIRED_DEPARTMENT_MIN_HITS = 2;
/**
 * Wording that turns a missing department into a deliberate exclusion. The plan
 * must say 「不安排<部门>：理由」 in taskUnderstanding.assumptions; silence is
 * what the gate rejects.
 */
export const DEPARTMENT_EXCLUSION_CUES = /(?:不安排|不需要|未涉及|不涉及|排除|不含|无需|不启用)/;
const NEGATION_PATTERN = /(?:不要|禁止|不得|严禁|不能|不可|切勿|避免)\s*([^\s，。；、,.;:!?！？\n]{1,28})/g;
const QUANTITY_PATTERN = /(?:最多|至少|不超过|不能超过|上限|下限|必须|只能|只允许|仅)\s*([^，。；;!?！？\n]{1,40})/g;
const HARD_QUANTITY_PREFIX = /^(?:最多|至少|不超过|不能超过|上限|下限)/;
/**
 * Normalise for "does the plan still mention this literal" checks. It strips
 * whitespace and punctuation only — never Chinese characters, digits or latin
 * letters — so a match cannot be manufactured by dropping content.
 */
export function normalizeForMatch(value) {
    return String(value ?? '')
        .replace(/[\s\u3000]+/g, '')
        .replace(/[％]/g, '%')
        .replace(/[，。；、！？"'“”‘’（）()【】\[\]<>《》]/g, '')
        .toLowerCase();
}
function clauseOf(text, index, length) {
    const start = Math.max(0, index - 36);
    const end = Math.min(text.length, index + length + 36);
    return text.slice(start, end).replace(/\s+/g, ' ').trim();
}
function pushElement(target, seen, element) {
    const key = `${element.kind}|${normalizeForMatch(element.value)}`;
    if (!element.value || seen.has(key))
        return;
    seen.add(key);
    target.push(element);
}
function collectMatches(text, pattern, make) {
    const found = [];
    const seen = new Set();
    // A local clone keeps the shared literal's lastIndex from leaking between calls.
    const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    let match;
    while ((match = regex.exec(text)) !== null) {
        const element = make(match);
        if (element)
            pushElement(found, seen, element);
        if (match.index === regex.lastIndex)
            regex.lastIndex += 1;
    }
    return found;
}
function splitClauses(text) {
    return text
        .split(/[。；;\n！!？?]+/)
        .map((clause) => clause.trim())
        .filter((clause) => clause.length > 0);
}
function cjkBigrams(text) {
    const clean = String(text ?? '').replace(/[^\u4e00-\u9fff]+/g, ' ');
    const bigrams = new Set();
    for (const run of clean.split(/\s+/)) {
        for (let i = 0; i + 2 <= run.length; i += 1) {
            bigrams.add(run.slice(i, i + 2));
        }
    }
    return bigrams;
}
const STOP_BIGRAMS = new Set([
    '的是', '我们', '你们', '他们', '这个', '那个', '这些', '那些', '一个', '已经',
    '可以', '需要', '必须', '应该', '进行', '以及', '或者', '但是', '因为', '所以',
    '如果', '没有', '不是', '就是', '通过', '对于', '时候', '现在', '问题', '要求',
    '这里', '那里', '同时', '并且', '而且', '还有', '全部', '所有', '任何', '其他',
]);
function contentBigrams(text) {
    const result = new Set();
    for (const bigram of cjkBigrams(text)) {
        if (!STOP_BIGRAMS.has(bigram))
            result.add(bigram);
    }
    return result;
}
function intersectionSize(a, b) {
    let count = 0;
    for (const value of a)
        if (b.has(value))
            count += 1;
    return count;
}
const SELF_CONTAINED_REFERENCE = /^(?:这个|那个|该|上述|前述|这些|那些|上一项|前一项|前者|后者)/;
/**
 * Extract hard requirements and ambiguity signals from the user's own words.
 *
 * Deliberately literal: no stemming, no synonyms, no model. The cost is that a
 * heavily paraphrased plan may look lossy; the benefit is that every finding can
 * be checked by searching the two strings involved.
 */
export function extractTaskElements(taskText) {
    const text = typeof taskText === 'string' ? taskText.trim() : '';
    const elements = [];
    const seen = new Set();
    // Order matters: `MAX_TASK_ELEMENTS` keeps the highest-signal kinds first.
    for (const element of collectMatches(text, /\bv?(\d+\.\d+(?:\.\d+)?)\b/g, (match) => ({
        kind: 'version',
        value: match[0].replace(/^v/i, ''),
        evidence: clauseOf(text, match.index, match[0].length),
        hard: true,
    })))
        pushElement(elements, seen, element);
    for (const element of collectMatches(text, /\b(?:20\d{2})[-/年.]\d{1,2}(?:[-/月.]\d{1,2}日?)?/g, (match) => ({
        kind: 'date',
        value: match[0],
        evidence: clauseOf(text, match.index, match[0].length),
        hard: true,
    })))
        pushElement(elements, seen, element);
    for (const element of collectMatches(text, /\b\d{1,2}月\d{1,2}日/g, (match) => ({
        kind: 'date',
        value: match[0],
        evidence: clauseOf(text, match.index, match[0].length),
        hard: true,
    })))
        pushElement(elements, seen, element);
    for (const element of collectMatches(text, /\b(?:T|D|U|S|Q|P|E|R|C|M|H|W|XB)-?\d{1,3}\b/g, (match) => ({
        kind: 'id',
        value: match[0],
        evidence: clauseOf(text, match.index, match[0].length),
        hard: true,
    })))
        pushElement(elements, seen, element);
    for (const element of collectMatches(text, /[A-Za-z0-9_./-]+\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|patch|log|csv|py|html|css|svg|tgz)\b/g, (match) => ({
        kind: 'path',
        value: match[0],
        evidence: clauseOf(text, match.index, match[0].length),
        hard: true,
    })))
        pushElement(elements, seen, element);
    for (const element of collectMatches(text, /\b\d+(?:\.\d+)?\s*(?:个|页|条|项|次|份|张|台|人日|人|天|小时|分钟|秒|字|%|万|亿|KB|MB|GB)/gi, (match) => ({
        kind: 'count',
        value: match[0].replace(/\s+/g, ''),
        evidence: clauseOf(text, match.index, match[0].length),
        hard: true,
    })))
        pushElement(elements, seen, element);
    for (const element of collectMatches(text, QUANTITY_PATTERN, (match) => {
        const head = match[0];
        return {
            kind: 'quantity',
            value: head.replace(/\s+/g, ''),
            evidence: clauseOf(text, match.index, match[0].length),
            hard: HARD_QUANTITY_PREFIX.test(head),
        };
    }))
        pushElement(elements, seen, element);
    /*
     * Negations are recorded for readability but are not blocking by themselves.
     * A negation's object often includes the verb ("不要修改业务代码"), so a
     * legitimate synonym ("不得改动业务代码") would be a false deviation. When the
     * object is a path, id or number it is already covered by the hard kinds
     * above, so nothing checkable is lost.
     */
    for (const element of collectMatches(text, NEGATION_PATTERN, (match) => ({
        kind: 'negation',
        value: `禁止:${match[1]}`,
        evidence: clauseOf(text, match.index, match[0].length),
        hard: false,
    })))
        pushElement(elements, seen, element);
    const deliverableClauses = splitClauses(text)
        .filter((clause) => /(?:交付|产出|输出|发布|提供|生成|给出)/.test(clause))
        .slice(0, 10);
    return {
        textLength: text.length,
        elements: elements.slice(0, MAX_TASK_ELEMENTS),
        hardCount: elements.filter((element) => element.hard).length,
        references: extractReferences(text),
        conflicts: extractConflicts(text),
        deliverableClauses,
    };
}
function extractReferences(text) {
    if (!text)
        return [];
    const references = [];
    const seen = new Set();
    const inlineTokens = ['这个', '那个', '该', '上述', '前述', '这些', '那些', '上一项', '前一项', '前者', '后者'];
    for (const token of inlineTokens) {
        let index = text.indexOf(token);
        while (index >= 0) {
            const before = text[index - 1] ?? '';
            if (before === '其') {
                index = text.indexOf(token, index + token.length);
                continue;
            }
            if (!seen.has(token)) {
                const after = text.slice(index + token.length, index + token.length + 6);
                /*
                 * 「该」 is also a modal ("该怎么做"), which is not a reference at all.
                 * Skipping it keeps a real task from being blocked by a false pronoun
                 * while 「该模块」 still resolves inline.
                 */
                if (token === '该' && /^(?:怎么|如何|怎样|是否|做|不|应)/.test(after)) {
                    index = text.indexOf(token, index + token.length);
                    continue;
                }
                seen.add(token);
                const selfContained = SELF_CONTAINED_REFERENCE.test(token) && /^[\u4e00-\u9fff]{2}/.test(after);
                references.push({
                    token,
                    resolvedBy: selfContained ? 'inline-noun' : 'none',
                    resolved: selfContained,
                    evidence: clauseOf(text, index, token.length),
                });
            }
            index = text.indexOf(token, index + token.length);
        }
    }
    // Bare 「它」 is the real ambiguity: it can only be resolved by context.
    for (let index = text.indexOf('它'); index >= 0; index = text.indexOf('它', index + 1)) {
        const before = text[index - 1] ?? '';
        if (before === '其')
            continue;
        if (!seen.has('它')) {
            seen.add('它');
            references.push({
                token: '它',
                resolvedBy: 'none',
                resolved: false,
                evidence: clauseOf(text, index, 1),
            });
        }
    }
    /*
     * [P0-2] Option letters are references only when a choice cue selects one.
     *
     * The old rule fired on any A-D letter as soon as the text said 建议/方案
     * anywhere: MS2 case T05-04 ("A/B 探针…建议移入") was blocked as an unresolved
     * pronoun it never contained, and Markdown list markers "A." would do the
     * same. A letter now counts only when it directly follows a selection verb,
     * which is the only structure that can actually mean "choose this option".
     */
    const option = /(?:选|选项|方案|可选|建议|采用|按)\s*(?:用\s*)?([A-D])(?![A-Za-z\/])/.exec(text);
    if (option && !seen.has(option[1])) {
        seen.add(option[1]);
        references.push({
            token: option[1],
            resolvedBy: 'none',
            resolved: false,
            evidence: clauseOf(text, option.index, option[0].length),
        });
    }
    return references;
}
/**
 * [P0-2] Pronoun antecedent extraction.
 *
 * Before this, any non-empty conversation turned every pronoun into
 * `resolvedBy: 'context'` — the audit claimed "它 was resolved" even when the
 * context was "进展到哪一步了" or talked about something else entirely, so a
 * plan could be dispatched on a guess. Resolution now requires an actual noun
 * phrase in the recent conversation:
 *
 *   - a cue (`用户…：` / `使用` / `针对` / `把`…) followed by the phrase, or
 *   - a topic sentence (`我们在聊…`, `讨论了…`);
 *
 * and phrases made only of function words (`把` / `问题` / `这个`…) are refused,
 * so an empty promise cannot be manufactured. When nothing qualifies the
 * reference stays unresolved and the plan is blocked as `needs-context`
 * (strict mode) or recorded as a warning (rollback switch).
 */
const ANTECEDENT_CUES = [
    /(?:^|[：:。；;\n])\s*(?:用户|需求|任务|要求|目标|对象)?\s*(?:上一轮|上一条|刚才|之前|前面)?\s*[说讲提]:?\s*/g,
    /(?:使用|针对|关于|围绕|涉及|改造|修改|调整|优化|修复|处理|把|将|对)\s*/g,
    /(?:和|与|同|跟)\s*[\u4e00-\u9fffA-Za-z0-9_\-\.]{2,12}?(?:相关|有关|有关联)/g,
    // Options: "给出 A 方案（…）与 B 方案（只跑增量）", "我们在聊 X"/"讨论了 X".
    /(?:在聊|聊到|讨论了|商量了|谈到了|提到|列出|提供|给出|可选)\s*/g,
];
const FUNCTION_WORD_ONLY = /^(?:那|这|些|个|位|次|样|里|边|面|中|上|下|我们|你们|他们|它|他|她|是|的|了|在|有|做|干|弄|搞|看|说|问|聊|讨论|事情|东西|问题|内容|功能|东西|部分|那块|这块)+$/;
const ANTECEDENT_MAX_LENGTH = 12;
/** Refuse function-word-only fragments: they carry no referent. */
function isMeaningfulAntecedent(candidate) {
    const value = candidate.trim();
    if (value.length < 2 || value.length > ANTECEDENT_MAX_LENGTH)
        return false;
    // An option label ("A 方案") is a referent: it points at a lettered choice.
    if (/^[A-D](?:方案|选项)$/.test(value))
        return true;
    /*
     * A pronoun is not its own antecedent: "把它改一下" leaves "它" behind at the
     * start of the clause, and accepting that would resolve 它 to itself.
     */
    if (/^(?:它|他|她|这|那|其)(?:们)?$/.test(value) || /^(?:它|他|她|这|那|其)/.test(value))
        return false;
    if (!/[\u4e00-\u9fffA-Za-z]/.test(value))
        return false;
    return !FUNCTION_WORD_ONLY.test(value);
}
/**
 * Find the phrase a pronoun points at in the recent conversation.
 *
 * Returns `null` — never a fabricated phrase — when the conversation names no
 * candidate. Callers must treat `null` as "still ambiguous".
 */
export function resolvePronounAntecedent(token, conversationContext) {
    const text = String(conversationContext ?? '').trim();
    if (!text || text.length > 20000)
        return null;
    for (const pattern of ANTECEDENT_CUES) {
        pattern.lastIndex = 0;
        for (const match of text.matchAll(pattern)) {
            const start = (match.index ?? 0) + match[0].length;
            const found = antecedentAfterCue(text, start);
            if (found)
                return found;
        }
    }
    return null;
}
/**
 * [T3] Resolve a pronoun from the task text itself, in the sentence that holds
 * it or the sentence immediately before it.
 *
 * MS2 T05-08 read 「…159667工业母机ETF国泰，下月全月…？准确预判后…告诉我，它每天…」
 * — the name sits in the PREVIOUS sentence while the pronoun's own sentence is
 * pure prose, so conversation-only resolution rejected the task as "no
 * antecedent". A name the user wrote in the task is the strongest possible
 * antecedent, so the task text is searched too:
 *
 *   1. the current sentence, before the pronoun;
 *   2. only if that has no referent, the sentence right before it.
 *
 * Only explicit referents qualify: a quoted name, or an identifier-like span
 * (「159667工业母机ETF国泰」/「159667」/「dsh-workplan」) — the boundaries a reader
 * would use. Ordinary prose never qualifies, so a pronoun with no real referent
 * still blocks (`needs-context`) instead of being resolved to filler.
 *
 * The scope is deliberately narrow: reaching further produced wrong antecedents
 * in replay ("…昨天涨了" taken as a name). A blocked plan is recoverable; a plan
 * dispatched on a guessed referent is not.
 */
const INLINE_SENTENCE_BOUNDARY = /[。！？!?\n]/;
const INLINE_NAME_CHAR = /[\u4e00-\u9fffA-Za-z0-9._-]/;
const INLINE_ENTITY_STOP = new Set('的是了在有我你他她它们这那吗呢吧啊呀就都也还又很太更最把被让给从到与和及或而但却则其该此每各么怎如何走涨跌买卖加减看好'.split(''));
const LEADING_REQUEST = /^(?:看一下|看下|看看|帮我|帮忙|麻烦|给我|我们|必须|需要|想要|关注|推荐|分析|预判|预测|研究|介绍|说说|告诉|查一下|查查|对比|比较|关于|针对|请|我|你|想|要|把|将|对)\s*/;
function isInlineSentenceBoundary(char) {
    return !!char && INLINE_SENTENCE_BOUNDARY.test(char);
}
function isInlineNameChar(char) {
    return !!char && INLINE_NAME_CHAR.test(char);
}
/** Drop request lead-ins so "我关注159667…" reads as the name, not the sentence. */
function stripRequestPrefixes(fragment) {
    let value = fragment;
    for (let round = 0; round < 3; round += 1) {
        const next = value.replace(LEADING_REQUEST, '');
        if (next === value)
            break;
        value = next;
    }
    return value.trim();
}
/**
 * Is this span an explicit referent rather than a piece of prose?
 *
 * An explicit referent carries an identifier signal (a 4+ digit code such as
 * 159667, or a Latin run such as ETF / dsh-workplan) and contains no function
 * word. That keeps 「159667工业母机ETF国泰」 and drops 「是我重点关注的基金」.
 * Dates (「11月」/「2026年」) and bare numbers are not referents.
 */
function isExplicitEntityToken(value) {
    const token = value.trim();
    if (token.length < 2 || token.length > 24)
        return false;
    if (/^(?:它|他|她|其)(?:们)?$/.test(token))
        return false;
    if (/^\d{1,4}(?:年|月|日|号)/.test(token))
        return false;
    if (/^\d{1,2}$/.test(token))
        return false;
    // A bare instrument category names a class, not one instrument.
    if (/^(?:ETF|LOF|QDII|A股|港股|美股)$/.test(token))
        return false;
    const hasCode = /\d{4,}/.test(token);
    const hasLatin = /[A-Za-z]{2,}/.test(token);
    const mixedSignal = /[A-Za-z]\d|\d[A-Za-z]/.test(token);
    if (!hasCode && !hasLatin && !mixedSignal)
        return false;
    for (const char of token) {
        if (INLINE_ENTITY_STOP.has(char))
            return false;
    }
    return !FUNCTION_WORD_ONLY.test(token);
}
/**
 * Take the explicit referent out of one punctuation/space-delimited fragment.
 *
 * A clean fragment is kept whole; otherwise the identifier and the name
 * characters attached to it are cut out, stopping at the first function word
 * or verb ("159667工业母机ETF国泰是我重点…" -> "159667工业母机ETF国泰").
 */
function inlineEntityCore(fragment) {
    const raw = stripRequestPrefixes(fragment).replace(/[。！？!?…]+$/, '').trim();
    if (!raw)
        return null;
    if (isExplicitEntityToken(raw))
        return raw;
    const anchor = /\d{2,}|[A-Za-z]{2,}/.exec(raw);
    if (!anchor)
        return null;
    let start = anchor.index;
    while (start > 0 && isInlineNameChar(raw[start - 1]) && !INLINE_ENTITY_STOP.has(raw[start - 1]))
        start -= 1;
    let end = anchor.index + anchor[0].length;
    while (end < raw.length && isInlineNameChar(raw[end]) && !INLINE_ENTITY_STOP.has(raw[end]))
        end += 1;
    const value = raw.slice(start, end).replace(/[.\-_]+$/, '').trim();
    return isExplicitEntityToken(value) ? value : null;
}
/** Find the last explicit referent inside one sentence span. */
function findExplicitEntity(span) {
    const text = span.trim();
    if (!text)
        return null;
    const quoted = [...text.matchAll(/[「『“"《]([^」』”"》\n]{2,24})[」』”"》]/g)];
    for (let i = quoted.length - 1; i >= 0; i -= 1) {
        const value = quoted[i][1].trim();
        if (isExplicitEntityToken(value))
            return { antecedent: value, source: text.slice(-80) };
    }
    const fragments = text.split(/[，,、；;：:\s]+/);
    for (let i = fragments.length - 1; i >= 0; i -= 1) {
        const value = inlineEntityCore(fragments[i]);
        if (value)
            return { antecedent: value, source: text.slice(-80) };
    }
    return null;
}
/** Bounds of the sentence around `index`, plus the sentence immediately before. */
function inlineSentenceBounds(text, index) {
    let start = 0;
    for (let i = index - 1; i >= 0; i -= 1) {
        if (isInlineSentenceBoundary(text[i])) {
            start = i + 1;
            break;
        }
    }
    let prevEnd = start;
    while (prevEnd > 0 && isInlineSentenceBoundary(text[prevEnd - 1]))
        prevEnd -= 1;
    let prevStart = 0;
    for (let i = prevEnd - 1; i >= 0; i -= 1) {
        if (isInlineSentenceBoundary(text[i])) {
            prevStart = i + 1;
            break;
        }
    }
    return { start, prevStart, prevEnd };
}
/** 「其它」 is a word, not a pronoun: skip it and use the real occurrence. */
function lastInlineReferenceIndex(text, token) {
    let index = text.lastIndexOf(token);
    while (index > 0 && token === '它' && text[index - 1] === '其') {
        index = text.lastIndexOf(token, index - 1);
    }
    return index;
}
export function resolvePronounAntecedentInline(token, taskText) {
    const text = String(taskText ?? '');
    if (!text || text.length > MAX_TASK_ANCHOR_CHARS)
        return null;
    const index = lastInlineReferenceIndex(text, token);
    if (index <= 0)
        return null;
    const bounds = inlineSentenceBounds(text, index);
    const current = findExplicitEntity(text.slice(bounds.start, index));
    if (current)
        return current;
    if (bounds.prevEnd > bounds.prevStart) {
        const previous = findExplicitEntity(text.slice(bounds.prevStart, bounds.prevEnd));
        if (previous)
            return previous;
    }
    return null;
}
/**
 * [P0-2c] Decide whether a task is missing information the user must supply.
 *
 * MS2's four clarify cases (T05-04/09/13/20) were planned and dispatched anyway.
 * Each failed for a *checkable* reason, so each gets a deterministic rule instead
 * of a vibe:
 *
 *  C1 bare agreement — the text is an answer to a question the model never saw
 *     (「同意移入」) and carries an identifier it never defines (R-W5-01).
 *  C2 dangling artifact — an internal reference (T4 草稿, W5) that is not defined
 *     in the task and not present in the conversation.
 *  C3 missing target — a forecast/trend request with no identifiable subject
 *     (「准确预测11月全月详细、具体走势」: which instrument? which year?).
 *  C4 missing UI object — a display change (折叠/展开/按钮…) that names no surface
 *     (左侧栏/截图/插件…), so any implementation would be a guess.
 */
export function auditClarifyNeed(taskText, conversationContext = '') {
    const text = String(taskText ?? '').trim();
    const conversation = String(conversationContext ?? '');
    if (!text)
        return { needed: false, rule: '', reason: '', question: '' };
    const both = text + '\n' + conversation;
    const AGREEMENT = /(?:^|[。；;！!\n])\s*(?:同意|赞成|可以|好的|没问题|就按|按你说的|确认)/;
    // No trailing \b: a CJK char is a non-word char, so 「T4 草稿」 has no word
    // boundary after 稿 and the id would silently never match.
    const DANGLING_ID = /(?:R-[A-Z]{1,4}-\d{1,4}|W\d{1,3}\b|T\d{1,3}\s*草稿)/;
    if (AGREEMENT.test(text) && (DANGLING_ID.test(text) || text.length <= 24) && !DANGLING_ID.test(conversation)) {
        return {
            needed: true,
            rule: 'C1',
            reason: '任务只是对上文问题的表态，且引用了任务里没有定义的编号，缺上文',
            question: '你这句话是在回答哪个问题？请把上文的问题、或你要「同意/移入」的具体对象说清楚。',
        };
    }
    const dangling = text.match(DANGLING_ID);
    if (dangling && !conversation.includes(dangling[0])) {
        return {
            needed: true,
            rule: 'C2',
            reason: '任务引用了「' + dangling[0] + '」这一内部编号/草稿，但任务原文没有定义它，也找不到上文',
            question: '「' + dangling[0] + '」指的是什么？请给出文件路径、链接或把内容贴进来。',
        };
    }
    const FORECAST = /(预测|预判|走势|涨跌|行情)/;
    const SUBJECT = /(?:\d{6}|[A-Z]{2,}\d+|[「『“"《][^」』”"》]{2,20}[」』”"》])/;
    // The missing subject may already be named in the conversation (「它走势如何」 after
    // the user quoted a ticker). Only the task's own words make it a forecast request.
    if (FORECAST.test(text) && !SUBJECT.test(both)) {
        return {
            needed: true,
            rule: 'C3',
            reason: '要求预测走势，但任务里没有可识别标的（股票代码/名称），也没有年份，缺关键输入',
            question: '要预测哪只标的（股票代码或名称）？看哪个时间段？',
        };
    }
    const UI_VERB = /(折叠|展开|按钮|显示|布局|样式|颜色|排序|置顶|收起)/;
    // 红圈/红框/圈出 name a surface the same way 截图 does: the user has pointed at
    // something concrete. Without them 「把红圈处改为默认收起」 was C4-blocked even
    // though the sentence is unambiguous (caught by department-fit.test.ts).
    const UI_OBJECT = /(左侧栏|右侧栏|侧边栏|侧栏|面板|对话框|弹窗|菜单|工具栏|页面|截图|画圈|红圈|红框|圈出|插件|顶栏|底栏|任务进度)/;
    // Same rule as C3: 「把它改成默认收起」 is not missing a surface when the previous
    // turn said 「截图红圈处的分步进度」. The verb must be in the task, the object may
    // come from either side (plan-anchor.test.ts 'strict mode blocks…' covers this).
    if (UI_VERB.test(text) && !UI_OBJECT.test(both)) {
        return {
            needed: true,
            rule: 'C4',
            reason: '要求改动界面显示，但没有说明改哪个界面/哪个板块，缺指代对象',
            question: '要改的是哪个界面/哪个板块？（例如左侧栏、任务进度面板、某个按钮；有截图更好）',
        };
    }
    return { needed: false, rule: '', reason: '', question: '' };
}
/**
 * Split one clause into candidate noun phrases.
 *
 * Whitespace, 、 and the connectors 与/和/及 separate phrases — but an option
 * letter is a prefix, not a phrase of its own: "A 方案" must stay one candidate,
 * otherwise the letter is lost and the option cannot be matched.
 */
export function splitAntecedentCandidates(clause) {
    const parts = [];
    let current = '';
    const isWordChar = (char) => !!char && /[\u4e00-\u9fffA-Za-z0-9_]/.test(char);
    for (let index = 0; index < clause.length; index += 1) {
        const char = clause[index];
        if ('，,、'.includes(char)) {
            parts.push(current);
            current = '';
            continue;
        }
        if ('与和及'.includes(char)) {
            // "A 方案与 B 方案": a connector right after an option label is a separator.
            const soFar = current.trim();
            if (/[A-D](?:方案|选项)$/.test(soFar)) {
                parts.push(current);
                current = '';
                continue;
            }
        }
        if (/s/.test(char) || char === '　') {
            const soFar = current.trim();
            const next = clause.slice(index).trimStart();
            // Glue an option letter to the word that follows it.
            if (/^[A-D]$/.test(soFar) && /^(?:方案|选项)/.test(next)) {
                current += char;
                continue;
            }
            if (isWordChar(clause[index - 1]) || isWordChar(next[0])) {
                parts.push(current);
                current = '';
                continue;
            }
            continue;
        }
        if ('（）()'.includes(char)) {
            // Parentheses are skipped entirely; their content is not the referent.
            const close = clause.indexOf(char === '（' ? '）' : char === '(' ? ')' : char, index + 1);
            if (close >= 0) {
                index = close;
                parts.push(current);
                current = '';
                continue;
            }
        }
        current += char;
    }
    parts.push(current);
    return parts
        .map((part) => part.replace(/[（(）)]/g, '').trim())
        .filter((part) => part.length > 0);
}
function cleanAntecedentCandidate(part) {
    return part
        .replace(/\u0000/g, '')
        .replace(/^(?:把|将|对|使用|针对|关于|围绕|涉及|改造|修改|调整|优化|修复|处理)\s*/, '')
        .replace(/(?:改成|改为|修正成|调整成|设成|变为|换成|变成|默认为|默认|保持|不用|不要|可以|需要|看看|检查一下|是什么|怎么样|如何).*$/, '')
        // Parentheticals are not part of the referent: "B 方案（只跑增量）" -> "B 方案".
        .replace(/[（(][^）)]*[）)]/g, '')
        .replace(/[，,。！？!?；;：:、\s]+$/, '')
        .trim();
}
/**
 * Read the clause that starts at `start` and return the first meaningful noun
 * phrase in it. A verb left at the start (`把…`) is dropped by
 * `cleanAntecedentCandidate`; the clause never crosses a sentence boundary.
 */
function antecedentAfterCue(text, start) {
    const tail = text.slice(start);
    const stop = tail.search(/[。！？!?\n；;]/);
    const clause = (stop >= 0 ? tail.slice(0, stop) : tail).trim();
    if (!clause)
        return null;
    /*
     * The clause may chain several noun phrases ("A 方案…与 B 方案…"). Split at
     * the connector and at whitespace so each candidate is one noun phrase; the
     * caller compares them to the pronoun token and picks the matching one.
     */
    const parts = splitAntecedentCandidates(clause);
    for (const part of parts) {
        const cleaned = cleanAntecedentCandidate(part).replace(/^[（(]|[）)]$/g, '');
        if (isMeaningfulAntecedent(cleaned))
            return { antecedent: cleaned, source: clause.slice(0, 80) };
    }
    return null;
}
function extractConflicts(text) {
    const conflicts = [];
    const seen = new Set();
    const add = (conflict) => {
        const key = `${conflict.kind}|${normalizeForMatch(conflict.a)}|${normalizeForMatch(conflict.b)}`;
        if (seen.has(key))
            return;
        seen.add(key);
        conflicts.push(conflict);
    };
    const open = /默认(?:展开|打开|显示)/.exec(text);
    const closed = /默认(?:不展开|不打开|收起|折叠|关闭|隐藏)/.exec(text);
    if (open && closed) {
        add({
            kind: 'default-state',
            a: open[0],
            b: closed[0],
            reason: '同一默认状态被同时要求展开与收起，二选一必须由用户决定',
        });
    }
    const only = /只(?:改|修改|动|做)\s*([^\s，。；、,;!?！？]{1,24})/.exec(text);
    const also = /(?:同时|还要|也要|并且|另外)(?:改|修改|动|做)\s*([^\s，。；、,;!?！？]{1,24})/.exec(text);
    if (only && also && normalizeForMatch(only[1]) !== normalizeForMatch(also[1])) {
        add({
            kind: 'scope',
            a: only[0],
            b: also[0],
            reason: `范围冲突：既要求只处理「${only[1]}」，又要求处理「${also[1]}」`,
        });
    }
    const clauses = splitClauses(text);
    for (const forbidClause of clauses) {
        const forbid = /(?:不要|禁止|不得|严禁)\s*(?:修改|改动|改|动|删除|移除)\s*([^\s，。；、,;!?！？]{1,24})/.exec(forbidClause);
        if (!forbid)
            continue;
        for (const requireClause of clauses) {
            if (requireClause === forbidClause)
                continue;
            const require = /(?:必须|需要|务必|要)\s*(?:修改|改动|改|动|删除|移除)\s*([^\s，。；、,;!?！？]{1,24})/.exec(requireClause);
            if (!require)
                continue;
            const a = normalizeForMatch(forbid[1]);
            const b = normalizeForMatch(require[1]);
            const overlap = a === b || a.includes(b) || b.includes(a)
                || intersectionSize(contentBigrams(forbid[1]), contentBigrams(require[1])) > 0;
            if (overlap) {
                add({
                    kind: 'polarity',
                    a: forbid[0],
                    b: require[0],
                    reason: `同一对象「${forbid[1]}」既被禁止修改又被要求修改`,
                });
            }
        }
    }
    for (const clause of clauses) {
        const change = /(?:改成|改为|设为|调整为|更新为)\s*([^\s，。；、,;!?！？]{1,24})/.exec(clause);
        if (!change)
            continue;
        for (const otherClause of clauses) {
            if (otherClause === clause)
                continue;
            const keep = /(?:保持|保持不变|仍为|保留)\s*([^\s，。；、,;!?！？]{1,24})/.exec(otherClause);
            if (!keep)
                continue;
            if (normalizeForMatch(change[1]) === normalizeForMatch(keep[1]))
                continue;
            const shared = intersectionSize(contentBigrams(clause), contentBigrams(otherClause));
            if (shared === 0)
                continue;
            add({
                kind: 'value',
                a: change[0],
                b: keep[0],
                reason: `同一对象被要求改成「${change[1]}」又要求保持「${keep[1]}」`,
            });
        }
    }
    return conflicts.slice(0, 8);
}
function subtaskText(subtask) {
    const parts = [
        subtask?.title,
        subtask?.role,
        subtask?.objective,
        ...(Array.isArray(subtask?.method) ? subtask.method : []),
        ...(Array.isArray(subtask?.inputs) ? subtask.inputs : []),
        ...(Array.isArray(subtask?.outputs) ? subtask.outputs : []),
        ...(Array.isArray(subtask?.acceptance) ? subtask.acceptance : []),
    ];
    return parts
        .filter((part) => typeof part === 'string' && part.trim() !== '')
        .join(' ');
}
function flattenPlanSubtasks(plan) {
    const stages = Array.isArray(plan?.stages) ? plan.stages : [];
    const subtasks = [];
    for (const stage of stages) {
        for (const subtask of Array.isArray(stage?.subtasks) ? stage.subtasks : []) {
            subtasks.push(subtask);
            if (subtasks.length >= MAX_AUDITED_SUBTASKS)
                return subtasks;
        }
    }
    return subtasks;
}
/**
 * [P0-1] Which department domains the user's request itself implies, and which
 * of them the plan never addresses.
 *
 * Root cause this closes: before 1.12.1 the audit only asked "does the chosen
 * department fit?" — a plan could omit an entire domain the request names and
 * still pass, because nothing asked "is a domain missing?". MS2 measured the
 * consequence: 11/29 required departments covered.
 *
 * A missing department is forgiven only when the plan states the exclusion in
 * `taskUnderstanding.assumptions` / `unknowns` with one of
 * DEPARTMENT_EXCLUSION_CUES, so omission must be a written decision instead of
 * silence. Pure and deterministic: no model, no I/O.
 */
export function auditDepartmentCoverage(taskText, plan) {
    const text = typeof taskText === 'string' ? taskText.trim() : '';
    if (text === '')
        return { required: [], missing: [], excluded: [] };
    const used = new Set(flattenPlanSubtasks(plan)
        .map((subtask) => (typeof subtask?.department === 'string' ? subtask.department : ''))
        .filter((department) => department !== ''));
    const statements = [];
    for (const key of ['assumptions', 'unknowns']) {
        const list = plan?.taskUnderstanding?.[key];
        if (!Array.isArray(list))
            continue;
        for (const item of list)
            if (typeof item === 'string' && item.trim() !== '')
                statements.push(item.trim());
    }
    const required = [];
    const missing = [];
    const excluded = [];
    for (const capability of DEPARTMENT_CAPABILITIES) {
        const hits = matchDepartmentKeywords(text, capability.id);
        if (hits.length < REQUIRED_DEPARTMENT_MIN_HITS)
            continue;
        const entry = { department: capability.id, departmentLabel: capability.zh, hits };
        required.push(entry);
        if (used.has(capability.id))
            continue;
        const reason = statements.find((statement) => ((statement.includes(capability.zh) || statement.includes(capability.id))
            && DEPARTMENT_EXCLUSION_CUES.test(statement)));
        if (reason)
            excluded.push({ ...entry, reason: reason.slice(0, 300) });
        else
            missing.push(entry);
    }
    return { required, missing, excluded };
}
/**
 * Explain one department choice with the catalog keywords that support it.
 *
 * `verdict` is intentionally coarse:
 *   - `fit`     — the chosen department has at least one matching keyword;
 *   - `weak`    — no keyword anywhere; insufficient evidence, not an error;
 *   - `mismatch`— the chosen department has zero evidence while another has a
 *                 strong one (>= MISMATCH_BLOCKING_SCORE).
 */
export function departmentFit(subtask, anchorText = '') {
    const department = typeof subtask?.department === 'string' ? subtask.department : '';
    const capability = departmentCapability(department);
    const text = subtaskText(subtask);
    const matched = capability ? capability.keywords.filter((keyword) => keywordHit(text, keyword)) : [];
    const anchorMatched = capability && anchorText.trim() !== ''
        ? capability.keywords.filter((keyword) => keywordHit(anchorText, keyword))
        : [];
    const scores = scoreDepartments(text).filter((entry) => entry.id !== department);
    const best = scores.length > 0 && scores[0].score > 0 ? scores[0] : null;
    const chosenScore = matched.length;
    let intrusion = false;
    if (capability && DEPARTMENT_INTRUSION_GUARDED.includes(department) && chosenScore > 0 && anchorText.trim() !== '') {
        const anchorHits = matchDepartmentKeywords(anchorText, department);
        if (anchorHits.length === 0) {
            const overlap = intersectionSize(contentBigrams(text), contentBigrams(anchorText));
            // No shared content bigram at all = the request never talks about this
            // domain. One shared topic word is enough to make it a warning instead.
            intrusion = overlap === 0;
        }
    }
    let verdict = 'fit';
    let reason = '';
    if (!capability) {
        verdict = 'mismatch';
        reason = `未知部门「${department}」，不在 12 个部门目录内`;
    }
    else if (chosenScore === 0 && anchorMatched.length === 0 && best && best.score >= MISMATCH_BLOCKING_SCORE) {
        verdict = 'mismatch';
        reason = `「${capability.zh}」无任何目录关键词命中，而「${best.zh}」命中 ${best.score} 个（${best.matched.slice(0, 4).join('、')}）`;
    }
    else if (intrusion) {
        verdict = 'mismatch';
        reason = `「${capability.zh}」领域词（${matched.slice(0, 3).join('、')}）只出现在子任务中，用户原要求从未涉及该领域`;
    }
    else if (chosenScore === 0 && anchorMatched.length === 0) {
        verdict = 'weak';
        reason = `「${capability.zh}」在子任务与用户原要求中都没有目录关键词命中，属证据不足（不阻断）`;
    }
    else if (chosenScore === 0) {
        reason = `子任务未命中「${capability.zh}」职责词，但用户原要求命中：${anchorMatched.slice(0, 5).join('、')}`;
    }
    else {
        reason = `命中「${capability.zh}」职责关键词 ${chosenScore} 个：${matched.slice(0, 5).join('、')}`;
        if (anchorMatched.length > 0)
            reason += `；用户原要求也命中：${anchorMatched.slice(0, 5).join('、')}`;
    }
    const declared = typeof subtask?.departmentRationale === 'string'
        ? subtask.departmentRationale.trim().slice(0, 600)
        : '';
    return {
        subtaskId: typeof subtask?.id === 'string' ? subtask.id : '',
        department,
        departmentLabel: capability?.zh ?? department,
        score: chosenScore,
        matched,
        anchorMatched,
        bestAlternative: best
            ? { id: best.id, zh: best.zh, score: best.score, matched: best.matched.slice(0, 5) }
            : null,
        intrusion,
        verdict,
        reason,
        declaredRationale: declared,
    };
}
export function buildTaskAnchor(taskText, sourceMessageIds = []) {
    const text = typeof taskText === 'string' ? taskText.trim() : '';
    if (!text)
        return null;
    const ids = Array.isArray(sourceMessageIds)
        ? sourceMessageIds.filter((id) => typeof id === 'string').slice(0, 30)
        : [];
    return {
        text: text.slice(0, MAX_TASK_ANCHOR_CHARS),
        sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
        length: text.length,
        sourceMessageIds: ids,
    };
}
function collectPlanText(plan) {
    const understanding = plan?.taskUnderstanding ?? {};
    const parts = [plan?.title];
    for (const key of ['originalRequest', 'deliverable']) {
        if (typeof understanding?.[key] === 'string')
            parts.push(understanding[key]);
    }
    for (const key of ['successCriteria', 'constraints', 'knownFacts', 'unknowns', 'assumptions']) {
        if (Array.isArray(understanding?.[key]))
            parts.push(...understanding[key]);
    }
    for (const stage of Array.isArray(plan?.stages) ? plan.stages : []) {
        for (const key of ['name', 'goal', 'rationale', 'checkpoint']) {
            if (typeof stage?.[key] === 'string')
                parts.push(stage[key]);
        }
        for (const subtask of Array.isArray(stage?.subtasks) ? stage.subtasks : []) {
            parts.push(subtaskText(subtask));
        }
    }
    for (const entry of Array.isArray(plan?.verification) ? plan.verification : []) {
        for (const key of ['item', 'method', 'evidence']) {
            if (typeof entry?.[key] === 'string')
                parts.push(entry[key]);
        }
    }
    return parts.filter((part) => typeof part === 'string').join('\n');
}
function elementPresent(planText, element) {
    const haystack = normalizeForMatch(planText);
    if (!haystack)
        return false;
    if (element.kind === 'id') {
        const value = normalizeForMatch(element.value);
        return haystack.includes(value) || haystack.includes(value.replace(/-/g, ''));
    }
    if (element.kind === 'negation') {
        return haystack.includes(normalizeForMatch(element.value.replace(/^禁止:/, '')));
    }
    return haystack.includes(normalizeForMatch(element.value));
}
function emptyAudit(anchor, reason) {
    return {
        version: UNDERSTANDING_AUDIT_VERSION,
        anchor,
        stage1: { elements: [], hardCount: 0, references: [], conflicts: [], deliverableClauses: [] },
        stage2: { assignments: [], departmentsUsed: [], mismatches: [], requiredDepartments: [], missingDepartments: [], excludedDepartments: [] },
        stage3: {
            verdict: 'degraded',
            rewritten: false,
            summaryCoverage: 0,
            droppedFromSummary: [],
            missingHardAnchors: [],
            missingDeliverables: [],
            reasons: [reason],
        },
    };
}
/**
 * Run the three stages against one plan.
 *
 * A legacy/replayed plan without the original task text returns a `degraded`
 * audit instead of throwing: replay must keep working, and "cannot check" is
 * not the same as "checked and passed" (which is why the verdict says so).
 */
export function auditTaskUnderstanding(plan, context = {}) {
    const taskText = typeof context.taskText === 'string' ? context.taskText.trim() : '';
    const anchor = buildTaskAnchor(taskText, context.sourceMessageIds);
    if (!anchor) {
        return emptyAudit(null, '没有用户原文（旧计划/回放），锚点偏离校验降级为不阻断');
    }
    const extracted = extractTaskElements(taskText);
    const planText = collectPlanText(plan);
    const assignments = flattenPlanSubtasks(plan).map((subtask) => departmentFit(subtask, taskText));
    const departmentsUsed = [...new Set(assignments.map((entry) => entry.department))];
    const coverage = auditDepartmentCoverage(taskText, plan);
    const mismatches = assignments
        .filter((entry) => entry.verdict === 'mismatch')
        .map((entry) => `${entry.subtaskId || '（无 ID）'} → ${entry.departmentLabel}：${entry.reason}`);
    const missingElements = extracted.elements
        .filter((element) => element.hard && !elementPresent(planText, element));
    const missingHardAnchors = missingElements.map((element) => `${element.kind}:${element.value}`);
    const missingDeliverables = extracted.deliverableClauses.filter((clause) => {
        const haystack = normalizeForMatch(planText);
        const bigrams = [...contentBigrams(clause)];
        if (bigrams.length === 0)
            return false;
        const hits = bigrams.filter((bigram) => haystack.includes(bigram)).length;
        return hits < Math.max(1, Math.ceil(bigrams.length * 0.5));
    });
    const originalRequest = typeof plan?.taskUnderstanding?.originalRequest === 'string'
        ? plan.taskUnderstanding.originalRequest
        : '';
    const summaryNorm = normalizeForMatch(originalRequest);
    const anchorNorm = normalizeForMatch(taskText);
    const verbatim = summaryNorm.length > 0 && anchorNorm.includes(summaryNorm);
    const droppedFromSummary = extracted.elements
        .filter((element) => element.hard && !normalizeForMatch(originalRequest).includes(normalizeForMatch(element.value)))
        .map((element) => `${element.kind}:${element.value}`);
    const hardTotal = extracted.elements.filter((element) => element.hard).length;
    const summaryCoverage = hardTotal === 0 ? 1 : (hardTotal - droppedFromSummary.length) / hardTotal;
    /*
     * [P0-2] Resolution requires an antecedent, not merely a non-empty context.
     * The old rule marked every pronoun resolved as soon as any conversation
     * existed, so "把它改成默认收起" passed with a context that talked about
     * something else. Now the phrase is extracted and quoted; otherwise the
     * reference stays unresolved and blocks (or warns in rollback mode).
     */
    const conversation = typeof context.conversationContext === 'string' ? context.conversationContext : '';
    const resolvedByContext = extracted.references.map((reference) => {
        if (reference.resolved)
            return reference;
        const fromConversation = resolvePronounAntecedent(reference.token, conversation);
        const found = fromConversation ?? resolvePronounAntecedentInline(reference.token, taskText);
        if (!found)
            return reference;
        // Option letters are resolved only when the conversation lists that option
        // as a listed choice, not a bare letter in a word. Listed-choice markers:
        // "C 方案" / "C 选项" and the enumeration forms "C=…" / "C＝…" / "C：…" /
        // "C、…" / "C)…" / "C）…" / "C.…" / "C．…" (marker must be followed by
        // content). Q10-style reports enumerate options as "A=… / B=… / C=…";
        // [2.2.6] the old regex only accepted 方案/选项, so a plain "选C" was
        // falsely judged unresolvable, burned two full planner attempts (~12 min
        // of silent planning in session-a404d49d) and degraded a legitimate task.
        // Task-text entities never satisfy this rule on their own: the option must
        // be defined where the user chose it, i.e. in the conversation.
        const listedOption = new RegExp('(?:^|[^A-Za-z])' + reference.token + '\\s*(?:方案|选项|=|＝|：|:|、|\\)|）|\\.|．)\\s*\\S');
        if (/^[A-D]$/.test(reference.token) && !listedOption.test(conversation))
            return reference;
        /*
         * [T3] Record where the referent came from. Reusing 'context' for an
         * antecedent found inside the task text would misreport an empty
         * conversation as the source, so the audit keeps the two apart.
         */
        const resolvedBy = fromConversation ? 'context' : 'task-text';
        return { ...reference, resolved: true, resolvedBy, antecedent: found.antecedent };
    });
    const unresolved = resolvedByContext.filter((reference) => !reference.resolved);
    const reasons = [];
    let verdict = 'aligned';
    if (missingHardAnchors.length > 0) {
        verdict = 'deviation';
        reasons.push(`用户原要求中的 ${missingHardAnchors.length} 个硬要素在计划中完全缺失：${missingHardAnchors.slice(0, 6).join('、')}`);
    }
    if (coverage.missing.length > 0) {
        verdict = 'deviation';
        reasons.push(`用户原要求涉及 ${coverage.missing.length} 个部门领域，计划既未安排也未写明排除理由：${coverage.missing.map((entry) => entry.departmentLabel).join('、')}`);
    }
    if (mismatches.length > 0) {
        if (verdict === 'aligned')
            verdict = 'deviation';
        reasons.push(`${mismatches.length} 个子任务的部门与用户原要求矛盾：${mismatches.slice(0, 4).join('；')}`);
    }
    if (extracted.conflicts.length > 0) {
        if (verdict === 'aligned')
            verdict = 'needs-clarification';
        reasons.push(`用户要求自相矛盾 ${extracted.conflicts.length} 处：${extracted.conflicts.map((conflict) => conflict.reason).slice(0, 3).join('；')}`);
    }
    if (unresolved.length > 0) {
        if (verdict === 'aligned')
            verdict = 'needs-context';
        reasons.push(`含指代的任务在最近对话里找不到先行词：${unresolved.map((reference) => reference.token).join('、')}，不应在未澄清前派发`);
    }
    if (verdict === 'aligned') {
        reasons.push(`硬要素 ${hardTotal - missingHardAnchors.length}/${hardTotal} 全部保留；${assignments.length} 个子任务的部门有目录关键词支撑`);
    }
    return {
        version: UNDERSTANDING_AUDIT_VERSION,
        anchor,
        stage1: {
            elements: extracted.elements,
            hardCount: extracted.hardCount,
            references: resolvedByContext,
            conflicts: extracted.conflicts,
            deliverableClauses: extracted.deliverableClauses,
        },
        stage2: {
            assignments,
            departmentsUsed,
            mismatches,
            requiredDepartments: coverage.required,
            missingDepartments: coverage.missing,
            excludedDepartments: coverage.excluded,
        },
        stage3: {
            verdict,
            rewritten: !verbatim,
            summaryCoverage: Number(summaryCoverage.toFixed(3)),
            droppedFromSummary,
            missingHardAnchors,
            missingDeliverables,
            reasons,
        },
    };
}
/**
 * Convert an audit into retry errors.
 *
 * `strict:false` is the rollback switch: every finding becomes a warning and the
 * plan proceeds exactly like 1.11.1. This is what an operator flips if a
 * release starts rejecting legitimate tasks, without reverting code.
 */
export function validatePlanContext(plan, context = {}) {
    const audit = auditTaskUnderstanding(plan, context);
    const warnings = [];
    const errors = [];
    const strict = context.strict !== false;
    for (const reason of audit.stage3.reasons) {
        if (audit.stage3.verdict === 'aligned')
            continue;
        warnings.push(reason);
    }
    for (const missing of audit.stage3.missingDeliverables) {
        warnings.push(`交付物子句可能未被计划覆盖：${missing}`);
    }
    for (const assignment of audit.stage2.assignments) {
        if (assignment.verdict === 'weak')
            warnings.push(`${assignment.subtaskId} 部门「${assignment.departmentLabel}」证据不足：${assignment.reason}`);
    }
    if (strict) {
        /*
         * A plan must not resolve a contradiction by silently picking a side, and
         * must not guess what 「它」 means. Both need the user, so both block the
         * dispatch under strict mode and degrade to a recorded warning only when
         * the rollback switch is on.
         */
        if (audit.stage3.verdict === 'needs-clarification') {
            errors.push(`CLARIFY: ${audit.stage3.reasons.find((reason) => reason.includes('自相矛盾')) ?? '用户要求存在矛盾，必须先向用户确认'}`);
        }
        /*
         * [P0-2c] Missing inputs must stop the plan before any department agent runs:
         * MS2 T05-04/09/13/20 were all planned and dispatched with the key input absent.
         */
        const clarify = auditClarifyNeed(context.taskText ?? audit.anchor?.text ?? '', context.conversationContext ?? '');
        if (clarify.needed) {
            errors.push('CLARIFY: ' + clarify.reason + '（规则 ' + clarify.rule + '）');
        }
        if (audit.stage3.verdict === 'needs-context') {
            errors.push(`CONTEXT: ${audit.stage3.reasons.find((reason) => reason.includes('指代')) ?? '任务含指代但在最近对话中找不到先行词，必须先向用户确认'}`);
        }
        for (const missing of audit.stage3.missingHardAnchors.slice(0, 6)) {
            errors.push(`DEVIATION: 用户原要求中的硬要素「${missing}」在计划中完全缺失，请补回或说明为什么可以省略`);
        }
        /*
         * [P0-1] Missing domain coverage is blocking, not a warning: MS2 showed a
         * plan can look internally consistent while silently dropping design/legal/
         * security/devops, which is exactly what "必须高" cannot tolerate.
         */
        for (const entry of audit.stage2.missingDepartments.slice(0, 6)) {
            errors.push(`COVERAGE: 用户原要求涉及「${entry.departmentLabel}」领域（命中 ${entry.hits.slice(0, 4).join('、')}），计划既没有该部门的子任务，也没有在 taskUnderstanding.assumptions 写明「不安排${entry.departmentLabel}：理由」`);
        }
        for (const assignment of audit.stage2.assignments) {
            if (assignment.verdict !== 'mismatch')
                continue;
            errors.push(`DEVIATION: 子任务 ${assignment.subtaskId || '（无 ID）'} 分配给「${assignment.departmentLabel}」缺乏依据：${assignment.reason}`);
            if (errors.length >= 12)
                break;
        }
    }
    return { ok: errors.length === 0, errors: errors.slice(0, 12), warnings: warnings.slice(0, 20), audit };
}
/**
 * Compact audit kept on the plan message. The full audit (with evidence clauses)
 * stays available from `auditTaskUnderstanding`; the stored copy is trimmed so a
 * 15-subtask plan does not double its own JSON size.
 */
export function compactUnderstandingAudit(audit) {
    return {
        version: audit.version,
        anchor: audit.anchor
            ? { sha256: audit.anchor.sha256, length: audit.anchor.length, sourceMessageIds: audit.anchor.sourceMessageIds }
            : null,
        stage1: {
            elements: audit.stage1.elements.map((element) => ({ kind: element.kind, value: element.value, hard: element.hard })),
            hardCount: audit.stage1.hardCount,
            references: audit.stage1.references.map((reference) => ({
                token: reference.token,
                resolved: reference.resolved,
                resolvedBy: reference.resolvedBy,
            })),
            conflicts: audit.stage1.conflicts,
        },
        stage2: {
            assignments: audit.stage2.assignments.map((assignment) => ({
                subtaskId: assignment.subtaskId,
                department: assignment.department,
                verdict: assignment.verdict,
                score: assignment.score,
                matched: assignment.matched.slice(0, 5),
                reason: assignment.reason,
                declaredRationale: assignment.declaredRationale,
            })),
            departmentsUsed: audit.stage2.departmentsUsed,
            mismatches: audit.stage2.mismatches,
            requiredDepartments: audit.stage2.requiredDepartments.map((entry) => ({
                department: entry.department,
                departmentLabel: entry.departmentLabel,
                hits: entry.hits.slice(0, 4),
            })),
            missingDepartments: audit.stage2.missingDepartments.map((entry) => ({
                department: entry.department,
                departmentLabel: entry.departmentLabel,
                hits: entry.hits.slice(0, 4),
            })),
            excludedDepartments: audit.stage2.excludedDepartments.map((entry) => ({
                department: entry.department,
                departmentLabel: entry.departmentLabel,
                hits: entry.hits.slice(0, 4),
                reason: entry.reason,
            })),
        },
        stage3: {
            verdict: audit.stage3.verdict,
            rewritten: audit.stage3.rewritten,
            summaryCoverage: audit.stage3.summaryCoverage,
            droppedFromSummary: audit.stage3.droppedFromSummary,
            missingHardAnchors: audit.stage3.missingHardAnchors,
            missingDeliverables: audit.stage3.missingDeliverables,
            reasons: audit.stage3.reasons,
        },
    };
}
/**
 * The department catalogue is the contract behind every match above; keep the
 * 12 ids in sync with `DEPARTMENTS` in plan.ts.
 */
export const UNDERSTANDING_DEPARTMENT_IDS = Object.freeze(DEPARTMENT_CAPABILITIES.map((entry) => entry.id));
