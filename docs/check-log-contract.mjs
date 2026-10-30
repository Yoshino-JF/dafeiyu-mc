// Contract checker + freedom metrics for logs/agent.ndjson (spec: docs/log-spec.md).
// Usage: node docs/check-log-contract.mjs [file] [--json] [--hours N]
// Exit 0 when the contract holds, 1 when it is violated. Metrics are printed even when the contract fails.
import fs from 'node:fs';
import path from 'node:path';

const ACT_REASONS = ['no_path', 'out_of_reach', 'need_tool', 'protected', 'blocked', 'not_found', 'timeout', 'refused', 'op_denied'];
const GATES = ['autonomy', 'chat', 'danger'];
const KINDS = ['goto', 'mine', 'place', 'attack', 'use', 'craft', 'chest', 'sleep', 'eat', 'chat', 'op-fill'];

export function parseLines(text) {
    const rows = [], violations = [];
    const lines = String(text || '').split('\n');
    lines.forEach((line, i) => {
        if (!line.trim()) return;
        const m = line.match(/^\[(decision|act|lifecycle)\]\s*(\{.*\})\s*$/) || line.match(/^(decision|act|lifecycle)\s+(\{.*\})\s*$/);
        let tag, obj;
        if (m) { tag = m[1]; try { obj = JSON.parse(m[2]); } catch { violations.push({ line: i + 1, why: 'json' }); return; } }
        else { try { obj = JSON.parse(line); tag = obj.type === 'act' ? 'act' : 'decision'; } catch { violations.push({ line: i + 1, why: 'format' }); return; } }
        if (tag === 'lifecycle') {
            if (!Number.isFinite(obj.at)) violations.push({ line: i + 1, why: 'lifecycle.at' });
            if (!obj.event) violations.push({ line: i + 1, why: 'lifecycle.event' });
            rows.push({ tag, ...obj });
        } else if (tag === 'decision') {
            if (!Number.isFinite(obj.at)) violations.push({ line: i + 1, why: 'decision.at' });
            if (!Array.isArray(obj.options) || obj.options.length === 0) violations.push({ line: i + 1, why: 'decision.options' });
            if (typeof obj.chosen !== 'string' || !obj.chosen) violations.push({ line: i + 1, why: 'decision.chosen' });
            else if (Array.isArray(obj.options) && !obj.options.includes(obj.chosen) && obj.offmenu !== true) violations.push({ line: i + 1, why: 'chosen-not-in-options' });
            if (obj.gate && !GATES.includes(obj.gate)) violations.push({ line: i + 1, why: 'decision.gate' });
            rows.push({ tag, ...obj });
        } else {
            if (!Number.isFinite(obj.at)) violations.push({ line: i + 1, why: 'act.at' });
            if (!obj.kind) violations.push({ line: i + 1, why: 'act.kind' });
            if (typeof obj.ok !== 'boolean') violations.push({ line: i + 1, why: 'act.ok' });
            if (obj.ok === false) {
                if (!obj.reason) violations.push({ line: i + 1, why: 'act.reason-missing' });
                else if (!ACT_REASONS.includes(obj.reason)) violations.push({ line: i + 1, why: `act.reason-not-enum:${obj.reason}` });
            }
            rows.push({ tag, ...obj });
        }
    });
    return { rows, violations };
}

export function metrics(rows) {
    const decisions = rows.filter((r) => r.tag === 'decision');
    const acts = rows.filter((r) => r.tag === 'act');
    const span = rows.length ? (Math.max(...rows.map((r) => r.at)) - Math.min(...rows.map((r) => r.at))) / 3600_000 : 0;
    const hours = Math.max(span, 1 / 60);
    const okRate = acts.length ? acts.filter((a) => a.ok).length / acts.length : null;
    const reasons = {};
    for (const a of acts.filter((a) => a.ok === false)) reasons[a.reason || '(none)'] = (reasons[a.reason || '(none)'] || 0) + 1;
    const kinds = {};
    for (const a of acts) kinds[a.kind] = (kinds[a.kind] || 0) + 1;
    const optionSizes = decisions.map((d) => (d.options || []).length).filter((n) => n > 0);
    const med = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
    // A silent gap is > 60 s with no event at all: the log cannot explain what she was doing in that window.
    const ats = rows.map((r) => r.at).sort((a, b) => a - b);
    let silentGaps = 0, longestGapS = 0;
    for (let i = 1; i < ats.length; i++) {
        const gap = (ats[i] - ats[i - 1]) / 1000;
        if (gap > 60) silentGaps++;
        longestGapS = Math.max(longestGapS, gap);
    }
    const retried = acts.filter((a) => Number(a.tries) > 1).length;
    const chats = decisions.filter((d) => d.gate === 'chat').length;
    const asks = decisions.filter((d) => /[?？]/.test(String(d.chosen || '') + ' ' + String(d.why || '')) || /问|吗|要不要|在哪/.test(String(d.why || ''))).length;
    const life = rows.filter((r) => r.tag === 'lifecycle');
    const exits = life.filter((l) => l.event === 'exit' || l.event === 'death');
    // time between an exit/death and the next spawn: she was not running, so a silence there is not a stall
    const downMs = [];
    for (let i = 0; i < life.length; i++) {
        if (!['exit', 'death'].includes(life[i].event)) continue;
        const next = life.slice(i + 1).find((l) => l.event === 'spawn');
        if (next && next.at > life[i].at) downMs.push(next.at - life[i].at);
    }
    return {
        events: rows.length,
        restarts: exits.length,
        downSeconds: +(downMs.reduce((a, b) => a + b, 0) / 1000).toFixed(1), decisions: decisions.length, acts: acts.length,
        hours: +hours.toFixed(2),
        decisionsPerHour: +(decisions.length / hours).toFixed(1),
        actsPerHour: +(acts.length / hours).toFixed(1),
        okRate: okRate === null ? null : +(okRate * 100).toFixed(1),
        reasons, kinds,
        distinctKinds: Object.keys(kinds).length,
        optionsMedian: med(optionSizes),
        optionsMin: optionSizes.length ? Math.min(...optionSizes) : null,
        offmenu: decisions.filter((d) => d.offmenu).length,
        chatGate: chats,
        questionsToPlayer: asks,
        retried,
        silentGaps, longestGapS: +longestGapS.toFixed(1)
    };
}

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('check-log-contract.mjs')) {
    const file = process.argv[2] && !process.argv[2].startsWith('--')
        ? process.argv[2]
        : path.join(process.cwd(), 'logs', 'agent.ndjson');
    if (!fs.existsSync(file)) { console.error(`no log at ${file}`); process.exit(2); }
    const { rows, violations } = parseLines(fs.readFileSync(file, 'utf8'));
    const m = metrics(rows);
    if (process.argv.includes('--json')) console.log(JSON.stringify({ file, metrics: m, violations }, null, 2));
    else {
        console.log(`file: ${file}`);
        console.log(`events ${m.events} · decisions ${m.decisions} · acts ${m.acts} · span ${m.hours} h`);
        console.log(`decisions/h ${m.decisionsPerHour} · acts/h ${m.actsPerHour} · act ok ${m.okRate}%`);
        console.log(`kinds ${m.distinctKinds} ${JSON.stringify(m.kinds)}`);
        console.log(`options median ${m.optionsMedian} min ${m.optionsMin} (this is the ACTION SPACE, not a menu of goals)`);
        console.log(`offmenu ${m.offmenu} · chat-gate ${m.chatGate} · questions ${m.questionsToPlayer} · retried ${m.retried}`);
        console.log(`failure reasons ${JSON.stringify(m.reasons)}`);
        console.log(`restarts ${m.restarts} · time not running ${m.downSeconds}s`);
        console.log(`silent gaps >60s ${m.silentGaps} · longest ${m.longestGapS}s`);
        console.log(violations.length ? `CONTRACT VIOLATIONS ${violations.length}: ${JSON.stringify(violations.slice(0, 6))}` : 'contract ok');
    }
    process.exit(violations.length ? 1 : 0);
}
