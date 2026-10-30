// Bilingual failure classifier for [act] lines.
// Why this exists: the first version (English-only regexes in dafeiyu_log.js) turned 42% of the failures into the
// catch-all `blocked`, because she reports her failures in CHINESE ("又卡在同一个地方", "卡住了", "又卡……往上垫一块")
// while the skills report in English ("the goal was not reached"). Every rule below is ordered: first match wins,
// and the fixtures in the test file are strings taken from a real run (dev/console.log), not invented ones.
import { ACT_REASONS } from './act-reasons.js';

/** Ordered: the more specific meaning wins. Keep `blocked` last, it is the fallback and must stay rare. */
export const RULES = [
    ['protected', /protected|not allowed to break|player.?(built|placed)|保护区|不能拆|主人(的)?(房|建筑)/i],
    ['op_denied', /permission|not op\b|unknown or incomplete command|没有权限|不是管理员/i],
    ['need_tool', /(enough\s+(\w+_)?(pickaxe|axe|shovel|hoe|sword|shears|flint_and_steel))|(need|don'?t have|do not have|missing)\s+(a\s+|the\s+)?(proper\s+|right\s+)?(tool|pickaxe|axe|shovel|hoe)|cannot (be )?(mine|harvest)|没有(镐|工具)|缺(镐|工具)|需要(镐|工具)/i],
    ['out_of_reach', /too far|out of reach|not within reach|够不着|太远|离得太远/i],
    ['no_path', /no path|cannot (find a )?path|path.*(fail|stuck)|could not reach|unable to reach|can'?t reach|stuck|卡住|卡在|卡|过不去|走不过去|上不去|下不去|爬不上去|出不(去|来)|被困/i],
    ['timeout', /time(d)?\s?out|超时/i],
    ['not_found', /(could not|couldn'?t|can'?t|cannot)\s+find|no\s+[\w ]*\s*(found|nearby)|not found|nothing (was )?found|because it is air|skipping block|don'?t have enough|do not have enough|not enough \w+|附近没有|没找到|找不到/i],
    ['refused', /interrupt|cancel|abort|refus|拒绝|取消|停下|path was stopped|pathfinding stopped|stopped before it could be completed|was stopped before/i],
    ['blocked', /not the goal|goal was not (reached|met)|did not reach|only \d+/i]
];

/**
 * @param {string|{output?:string, message?:string, text?:string}} input the skill output, its tail, or an error message
 * @returns {string} one of ACT_REASONS
 */
export function classifyFailure(input) {
    const text = typeof input === 'string'
        ? input
        : String(input?.output ?? input?.message ?? input?.text ?? '');
    for (const [reason, re] of RULES) if (re.test(text)) return reason;
    return 'blocked';
}

/** True when the classifier had to fall back: the audit counts these and they must trend down. */
export function isUnexplained(input) {
    const text = typeof input === 'string' ? input : String(input?.output ?? input?.message ?? '');
    return !RULES.some(([, re]) => re.test(text));
}

for (const [, re] of RULES) {
    if (!(re instanceof RegExp)) throw new TypeError('rule is not a regexp');
}
if (RULES[RULES.length - 1][0] !== 'blocked') throw new Error('blocked must stay last');
for (const [reason] of RULES) {
    if (!ACT_REASONS.includes(reason)) throw new Error(`rule reason ${reason} is not in ACT_REASONS`);
}
