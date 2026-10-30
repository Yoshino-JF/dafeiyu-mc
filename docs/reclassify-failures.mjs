// Offline re-classification of the real log: how many failures can the classifier explain now, and with which reasons.
// This is the honest way to check the classifier: it runs over the same 193 failures Claude grouped, not over invented strings.
import fs from 'node:fs';
import { classifyFailure, isUnexplained } from '../src/agent/failure-reasons.js';

const file = process.argv[2] || 'logs/agent.ndjson';
const acts = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((l) => { const m = l.match(/^\[act\]\s*(\{.*\})$/); if (!m) return null; try { return JSON.parse(m[1]); } catch { return null; } })
    .filter(Boolean);
const fails = acts.filter((a) => a.ok === false);
const before = {}, after = {};
for (const a of fails) before[a.reason] = (before[a.reason] || 0) + 1;
let unexplained = 0, noMsg = 0;
for (const a of fails) {
    const r = classifyFailure(a.msg || '');
    after[r] = (after[r] || 0) + 1;
    if (!a.msg) noMsg++;
    else if (isUnexplained(a.msg)) unexplained++;
}
const row = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ');
console.log(`failures ${fails.length}`);
console.log(`as logged now : ${row(before)}`);
console.log(`re-classified : ${row(after)}`);
console.log(`no msg field  : ${noMsg}`);
console.log(`still unexplained (has msg, matched nothing): ${unexplained}`);
