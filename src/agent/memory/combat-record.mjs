// [combat] record schema (owner: DeepSeek, per #3351). Pure module: no I/O, no bot, no logging side effects.
//
// Why a module and not just a documented shape: the metrics are only worth anything if every record carries the same
// fields, and the two fields most likely to be forgotten are exactly the ones that make comparisons honest - the style
// snapshot (what she was tuning) and the confounders (what else could explain the outcome).

export const REQUIRED = [
    'at', 'caller', 'target', 'tactic', 'result',
    'hits', 'swings', 'startHp', 'endHp', 'damageTaken', 'seconds',
    'armed', 'weapon', 'hadFood', 'hostileCount', 'dimension', 'startY', 'isNight',
    'styleVersion', 'style'
];

export const RESULTS = ['killed', 'disengaged', 'lost', 'refused', 'interrupted', 'timeout'];
export const CALLERS = ['her', 'self_defense'];
export const TACTICS = ['melee', 'kite', 'ranged', 'avoid'];

/** Extra fields this contract adds on top of #3351, each with the reason it exists. */
export const EXTRAS = {
    interruptedBy: 'stop|command|interrupt_code|died - tells a cancel apart from a defeat',
    engineMs: 'wall clock of the engine loop, so mineflayer physics can be compared with a real client',
    targetHpBefore: 'hp of the target when the encounter started (kills != lethality when it started hurt)',
    hostileCountAtStart: 'alias kept for older readers; prefer hostileCount',
    arrowsSpent: 'bow only: the cost she is trading against damage taken'
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const inSet = (v, set) => set.includes(v);

/**
 * Normalises a raw record. Returns { ok, record, problems }. Never throws for data reasons: a bad record must be visible
 * (problems) rather than crashing her loop, because losing a record loses the very evidence we are collecting.
 */
export function normalizeCombatRecord(raw = {}, { now = Date.now() } = {}) {
    const problems = [];
    const r = { ...raw };

    r.at = isNum(r.at) ? r.at : now;
    r.caller = inSet(r.caller, CALLERS) ? r.caller : (problems.push(`caller: ${r.caller}`), 'her');
    r.result = inSet(r.result, RESULTS) ? r.result : (problems.push(`result: ${r.result}`), 'lost');
    r.tactic = inSet(r.tactic, TACTICS) ? r.tactic : (problems.push(`tactic: ${r.tactic}`), 'melee');

    for (const k of ['hits', 'swings', 'startHp', 'endHp', 'damageTaken', 'seconds', 'hostileCount']) {
        if (!isNum(r[k])) { problems.push(`${k} not a number`); r[k] = 0; }
    }
    if (!isNum(r.startY)) { problems.push('startY not a number'); r.startY = null; }
    if (typeof r.dimension !== 'string' || !r.dimension) { problems.push('dimension missing'); r.dimension = 'overworld'; }
    for (const k of ['armed', 'hadFood']) {
        if (typeof r[k] !== 'boolean') { problems.push(`${k} not a boolean`); r[k] = false; }
    }
    // the game clock can be unknown: that is information, not an error
    if (r.isNight !== null && typeof r.isNight !== 'boolean') { problems.push('isNight not boolean or null'); r.isNight = null; }
    if (!r.target || typeof r.target !== 'object') { problems.push('target missing'); r.target = { name: null, id: null }; }
    if (!r.weapon) { problems.push('weapon missing'); r.weapon = null; }
    if (!r.styleVersion) { problems.push('styleVersion missing - the snapshot cannot be attributed'); r.styleVersion = 'unknown'; }
    if (!r.style || typeof r.style !== 'object') { problems.push('style snapshot missing'); r.style = {}; }

    // derived, but written into the record so a later reader does not have to guess
    r.hitRate = r.swings > 0 ? +(r.hits / r.swings).toFixed(3) : null;
    r.hpDelta = r.startHp - r.endHp;

    return { ok: problems.length === 0, record: r, problems };
}

/** Convenience for tests and for a log writer that wants to refuse bad data outright. */
export function isValidCombatRecord(raw) {
    const missing = REQUIRED.filter((k) => !(k in (raw || {})));
    const { problems } = normalizeCombatRecord(raw);
    return { ok: missing.length === 0 && problems.length === 0, missing, problems };
}

/**
 * The one-paragraph fact sentence shown to her after an encounter. Facts only: no "you did well", no advice.
 * Kept here so the wording cannot drift between the command and the metrics.
 */
export function combatSummaryLine(rec) {
    const r = normalizeCombatRecord(rec).record;
    const name = r.target?.name || '目标';
    const outcome = { killed: '打死了', disengaged: '拉开了距离', lost: '没打死就结束了', refused: '没打', interrupted: '被打断', timeout: '超时结束' }[r.result];
    const parts = [
        `${name}：${outcome}`,
        `出手 ${r.swings} 次，命中 ${r.hits} 次`,
        `血 ${r.startHp}→${r.endHp}（掉 ${r.damageTaken}）`,
        `${r.seconds}s`,
        r.armed ? `武器 ${r.weapon}` : '空手'
    ];
    if (r.result === 'refused') parts.push(`原因 ${r.reason || '未知'}`);
    return parts.join('，') + '。';
}
