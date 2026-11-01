/**
 * [W1] 覆盖摘要：`supersededBy.mapping` 的规范化摘要（canonical mapping digest）。
 *
 * 规则依据（落盘文档，不在本文件重复全文）：
 * - `_rerun_20261101/GATE_rule_design.md` §6.1：`"digest": "sha256(canonical(mapping))"`；
 *   §6.3：present 时「复验必须从日志重算，不读缓存数值；digest 不一致即 stale」；
 *   §7.2 第 6 条：运行时复算 `coverage==='full'`，写入 `digest`。
 * - `_rerun_20261101/GATE_case_matrix.md:158`（W1）：规范化口径固定为
 *   「sort_keys + 紧凑分隔符 + 仅 mapping 的 JSON」。
 *
 * 本模块把 W1 那一行「补一行规范化定义」落成可执行契约：
 *
 *   1. 输入对象：`supersededBy.mapping` —— 映射数组本身，不含
 *      `supersededBy` 包装层（planId / coverage / verifiedAt 等不参与摘要）。
 *      数组元素按**存储原样**参与摘要：`from`/`to`/`basis`/`evidence` 若存在
 *      则全部计入（与 T9 `gate_rule_check.py::mapping_digest` 同口径，
 *      该脚本的合成用例已用同一算法产出并自校验 `sha256:a686…`）。
 *   2. 规范化：JSON，对象键按 Unicode 码位升序（sort_keys），分隔符为
 *      `,`/`:`（无空白），字符串不转义为非 ASCII（UTF-8），数组顺序保持
 *      存储顺序（不排序）。
 *   3. 摘要：`sha256:<64 位小写十六进制>`，对规范化文本的 UTF-8 字节取
 *      SHA-256。
 *   4. 失败语义：`verifyMappingDigest` 只在「mapping 是数组、digest 形如
 *      `sha256:<64hex>`、且重算值逐字符相等」时返回 true；其余（缺字段、
 *      类型不对、被改动）一律 false —— 调用方据此 fail-closed（stale），
 *      不允许把「无法复核」当成「通过」。
 *
 * 语义边界：摘要只证明「存下来的 mapping 没被改动」，**不**证明「两项工作
 * 在语义上等价」。等价是人的判断，只能靠用户确认（V8）与审计留痕承载，
 * 与 `GATE_rule_design.md` §6.1 末尾的边界声明一致。
 *
 * 约定：写入方（host 工具层）必须先对本模块产出的 digest 落盘，再写 durable
 * 信封；读取方（replay / present 复验）只重算、不信任缓存值。
 */
import { createHash } from 'node:crypto';
export const MAPPING_DIGEST_PREFIX = 'sha256:';
const MAPPING_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
/**
 * 规范化 JSON：对象键按码位排序、紧凑分隔符、无 ASCII 转义。
 *
 * 与 Python `json.dumps(value, ensure_ascii=False, sort_keys=True,
 * separators=(',', ':'))` 对齐（T9 脚本即用该实现固化 W1 口径）。
 * `undefined`/函数/符号与 `JSON.stringify` 一致：对象里省略、数组里变 `null`。
 */
export function canonicalMappingJson(value) {
    if (value === null)
        return 'null';
    const type = typeof value;
    if (type === 'string')
        return JSON.stringify(value);
    if (type === 'number' || type === 'boolean')
        return JSON.stringify(value);
    if (type === 'bigint')
        return JSON.stringify(String(value));
    if (type !== 'object')
        return 'null';
    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalMappingJson(item)).join(',')}]`;
    }
    const record = value;
    const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined && typeof record[key] !== 'function' && typeof record[key] !== 'symbol')
        .sort(compareCodePoints);
    const body = keys.map((key) => `${JSON.stringify(key)}:${canonicalMappingJson(record[key])}`).join(',');
    return `{${body}}`;
}
/** 按 Unicode 码位比较（而非 UTF-16 码元），与 Python `sort_keys` 的键序一致。 */
function compareCodePoints(left, right) {
    const a = Array.from(left, (char) => char.codePointAt(0) ?? 0);
    const b = Array.from(right, (char) => char.codePointAt(0) ?? 0);
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i += 1) {
        if (a[i] !== b[i])
            return a[i] - b[i];
    }
    return a.length - b.length;
}
/**
 * 计算 `digest = sha256(canonical(mapping))`。
 *
 * 非数组输入抛 `TypeError`：写入一个无法摘要的覆盖记录是编程错误，写入前
 * 就应该失败，而不是把 `null` 的摘要当成合法值落盘。读取侧请用
 * `verifyMappingDigest`（它对任何坏输入都返回 false，不抛）。
 */
export function computeMappingDigest(mapping) {
    if (!Array.isArray(mapping)) {
        throw new TypeError('supersededBy.mapping 必须是数组，才能计算 sha256(canonical(mapping))');
    }
    const canonical = canonicalMappingJson(mapping);
    return MAPPING_DIGEST_PREFIX + createHash('sha256').update(canonical, 'utf8').digest('hex');
}
/** digest 是否形如 `sha256:<64 位小写十六进制>`。 */
export function isMappingDigest(value) {
    return typeof value === 'string' && MAPPING_DIGEST_RE.test(value);
}
/**
 * 复验：从 mapping 重算摘要并与记录里的 digest 比对。
 * 任何坏输入（缺 mapping、digest 缺失/格式错、被改动）都返回 false。
 */
export function verifyMappingDigest(mapping, digest) {
    if (!Array.isArray(mapping) || !isMappingDigest(digest))
        return false;
    return computeMappingDigest(mapping) === digest;
}
/**
 * 写入侧辅助：返回带有复算 digest 的 `supersededBy` 副本。
 * 运行时是唯一 write-side 复算者（§7.2 第 6 条），调用方不得自报 digest。
 */
export function withMappingDigest(supersededBy) {
    const mapping = supersededBy?.mapping;
    if (!Array.isArray(mapping)) {
        throw new TypeError('supersededBy.mapping 必须是数组，才能写入 digest');
    }
    return { ...supersededBy, digest: computeMappingDigest(mapping) };
}
