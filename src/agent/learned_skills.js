// Skills she learned herself (PLAN H / R③, Voyager/Odyssey style). Upstream Mindcraft writes !newAction code to a file and forgets it;
// here a run that a second model call judges a real success (her goal, the code's own output and the inventory change) is kept as
// a named skill she can run again with !useSkill. Failed code is never kept. Uses, successes and failures are counted per skill so
// the audit can show whether what she learns is reused and gets better (R③).
import fs from 'fs';
import path from 'path';
import { analyzeCoordinates } from './skill_coordinates.js';

const dirOf = (name) => path.join('./bots', name, 'learned_skills');
export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

export function listLearned(name) {
    try {
        return fs.readdirSync(dirOf(name)).filter((f) => f.endsWith('.json'))
            .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dirOf(name), f), 'utf8')); } catch { return null; } })
            .filter((s) => s?.name && typeof s.code === 'string');
    } catch { return []; }
}
export function getLearned(name, skill) { return listLearned(name).find((s) => s.name === slug(skill)) || null; }

function write(name, skill) {
    fs.mkdirSync(dirOf(name), { recursive: true });
    fs.writeFileSync(path.join(dirOf(name), skill.name + '.json'), JSON.stringify(skill, null, 2));
}
/** Keep a judged-successful run. A name that exists keeps its counts and gets the newer code. */
// Skills are world-bound when their code holds coordinates (DeepSeek #3436, 15:32: she ran a skill that walked to old-world
// coordinates twice in 40 s - "这扫描的是旧世界那片的坐标…白跑了"). The skill keeps the world it was learned in; one learned before
// worlds were recorded is dated against the switch history. Execution now uses a per-run coordinate frame or explains why it cannot.
const COORDS = /-?\d{1,5}\s*,\s*-?\d{1,3}\s*,\s*-?\d{1,5}/;
// absolute ranges too: "for (let x = 9; x <= 15; x++)" - scan_region_for_air_gaps scanned the old world's roof that way (16:1x).
// Only a bare x / y / z: relative offsets (dx, dz, i) are not positions in a world.
const ABS_AXIS = /(?<![\w$.])[xyz]\s*(?:<=|>=|<|>|=)\s*-?\d+(?![\w.])/;
export const hasCoordinates = (skill) => {
    const code = skill?.code || '', analysis = analyzeCoordinates(code);
    return analysis.error ? COORDS.test(code) || ABS_AXIS.test(code) : analysis.hasCoordinates;
};

function switches(name) {
    try { return JSON.parse(fs.readFileSync(path.join('./bots', name, 'memory', 'worlds', 'state.json'), 'utf8'))?.world?.history || []; }
    catch { return []; }
}

/** The world a skill was learned in: recorded, or the world she was in at the time it was created (null when unknown). */
export function skillWorld(name, skill) {
    if (skill?.world) return skill.world;
    const born = Date.parse(skill?.created || '');
    const h = switches(name).filter((s) => Number.isFinite(s.at) && s.at <= born).pop();
    return h?.to || (Number.isFinite(born) && switches(name)[0] && born < switches(name)[0].at ? 'before-worlds' : null);
}

/** A note for a skill learned in another world whose code holds coordinates; '' otherwise. */
export function otherWorldNote(name, skill, here) {
    if (!here || !hasCoordinates(skill)) return '';
    const w = skillWorld(name, skill);
    return w && w !== here ? '（在别的世界学的；!useSkill 会尝试平移坐标，但这里的地形可能不同）' : '';
}

/** Same world but another place (DeepSeek #3638, 07:25-07:51: 54 of 85 skills hold fixed coordinates; 8 times in 27 min she ran a scan that
 * read where she had stood when it was learned - "197 格全是 air"). '' when the code has no coordinates or she is within 16 blocks of
 * where it was learned. Original code is retained; useSkill reports its execution frame or why translation is unavailable. */
export function placeNote(skill, pos) {
    if (!hasCoordinates(skill)) return '';
    const at = skill?.at, d = at && pos ? Math.round(Math.hypot(pos.x - at.x, pos.y - at.y, pos.z - at.z)) : null;
    if (d !== null && d <= 16) return '';
    return `（代码里写了坐标${d !== null ? `，是在 (${at.x}, ${at.y}, ${at.z}) 学的，你现在离那里 ${d} 格` : '，学它的时候人在哪没有记下'}：!useSkill 会尝试按你当前脚下格平移；锚点或接口无法适配时会说明并不运行）`;
}

/** The note for a skill: another world first, then another place. */
export const skillNote = (name, skill, here, pos) => otherWorldNote(name, skill, here) || placeNote(skill, pos);

export function saveLearned(name, { skill, description, goal, code, evidence, world = null, at = null }) {
    const id = slug(skill);
    if (!id || !code) return null;
    const was = getLearned(name, id);
    const entry = { name: id, world: world || was?.world || null, at: at || was?.at || null, description: String(description || goal || '').slice(0, 200), goal: String(goal || '').slice(0, 300), code,
        evidence: String(evidence || '').slice(0, 300), created: was?.created || new Date().toISOString(), updated: new Date().toISOString(),
        uses: was?.uses || 0, successes: (was?.successes || 0) + 1, failures: was?.failures || 0 };
    write(name, entry);
    return entry;
}
export function recordUse(name, skill, ok) {
    const s = getLearned(name, skill);
    if (!s) return;
    s.uses += 1; if (ok) s.successes += 1; else s.failures += 1; s.updated = new Date().toISOString();
    write(name, s);
}
/** The skills worth showing her: most successful first, at most n. */
export function topLearned(name, n = 10) {
    return listLearned(name).sort((a, b) => (b.successes - b.failures) - (a.successes - a.failures) || b.uses - a.uses).slice(0, n);
}
const items = (bot) => Object.fromEntries((bot?.inventory?.items?.() || []).reduce((m, i) => m.set(i.name, (m.get(i.name) || 0) + i.count), new Map()));
export const inventorySnapshot = items;
export function inventoryDelta(before, after) {
    const out = {};
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) { const d = (after[k] || 0) - (before[k] || 0); if (d) out[k] = d; }
    return out;
}
/** The critic: did the run do what she meant to do? Returns {success, reason, skill, description} or null when it cannot tell. */
export async function judgeRun(prompter, { goal, output, delta }) {
    const system = 'You check whether a Minecraft bot\'s self-written code achieved its goal. Judge only from the evidence. '
        + 'Answer with one JSON object and nothing else: {"success": true|false, "reason": "<short>", "skill": "<snake_case name for this reusable behaviour>", "description": "<one sentence, what it does>"}';
    // 10:5x scan_region_for_air_gaps was judged a failure because "Output is truncated ... the full ROOF_GAPS list was not printed": the
    // shortening was the log summary's, not her code's. The judge gets the full output, or its head and tail with that said plainly.
    const text = String(output || '');
    const shown = text.length <= 3000 ? text
        : `${text.slice(0, 1500)}\n...(${text.length - 3000} characters in the middle left out here only to keep this check short - not a fault of the code)...\n${text.slice(-1500)}`;
    const user = `Goal: ${goal || '(not stated)'}\nCode output:\n${shown}\nInventory change: ${JSON.stringify(delta)}`;
    try {
        const res = await prompter.chat_model.sendRequest([{ role: 'user', content: user }], system);
        const j = JSON.parse(String(res).slice(String(res).indexOf('{'), String(res).lastIndexOf('}') + 1));
        return typeof j.success === 'boolean' ? j : null;
    } catch { return null; }
}
