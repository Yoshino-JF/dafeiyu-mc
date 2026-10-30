// Smoke test for the memory pipeline against a REAL model call (DeepSeek), used once now that the PC is free.
// It does not touch the game: it feeds a real night's events and checks that what comes back is usable and in budget.
// Run: node docs/smoke-memory-real.mjs   (needs keys.json with DEEPSEEK_API_KEY; exits 2 when absent)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryS } from '../src/agent/memory/index.js';

const keys = (() => { try { return JSON.parse(fs.readFileSync('keys.json', 'utf8')); } catch { return {}; } })();
const KEY = keys.DEEPSEEK_API_KEY || keys.deepseek || process.env.DEEPSEEK_API_KEY;
if (!KEY) { console.log('SKIP: no DEEPSEEK_API_KEY in keys.json'); process.exit(2); }

const ask = async (prompt) => {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
            max_tokens: 500
        })
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const j = await res.json();
    return j.choices?.[0]?.message?.content ?? '';
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsmem-real-'));
const memory = new MemoryS({ dir });
// A real night, taken from what actually happened in run 14: she got stuck twice, collected dirt short of the goal,
// wrote a new skill, then went to bed short of materials.
const t0 = Date.UTC(2026, 9, 24, 17, 30);
memory.noteFailure({ kind: 'mine', reason: 'no_path', args: { x: -121, y: 62, z: 144 }, at: t0 });
memory.noteFailure({ kind: 'mine', reason: 'no_path', args: { x: -119, y: 61, z: 141 }, at: t0 + 4 * 60_000 });
memory.noteFailure({ kind: 'mine', reason: 'blocked', args: { goal: '3 dirt' }, at: t0 + 9 * 60_000 });
memory.appendPlace('白桦林', { x: -120, y: 62, z: 140 });
memory.noteSaid('又卡在同一个地方，真是的……换个方向走。');
memory.noteSaid('出来了，站地上了。');

const started = Date.now();
const res = await memory.nightlyConsolidate(ask, { now: t0 + 60 * 60_000 });
const ms = Date.now() - started;
const self = fs.readFileSync(path.join(dir, 'self.md'), 'utf8');
const story = memory.readStory(1);

console.log(JSON.stringify({
    ok: res.ok,
    day: memory.day(),
    ms,
    selfBytes: Buffer.byteLength(self),
    storyBytes: Buffer.byteLength(story),
    selfHead: self.slice(0, 120),
    storyHead: story.slice(0, 120),
    promptBlockBytes: Buffer.byteLength(memory.promptBlock()),
    insights: memory.insights(3),
    goals: memory.readGoals().split('\n').filter(Boolean),
    stats: memory.stats()
}, null, 2));

if (!res.ok) { console.error('FAIL: the model returned nothing usable'); process.exit(1); }
if (!self.trim() || !story.trim()) { console.error('FAIL: self or story empty'); process.exit(1); }
if (Buffer.byteLength(self) > 2000) { console.error('FAIL: self.md over its 2 KB cap'); process.exit(1); }
console.log('REAL MEMORY OK');
