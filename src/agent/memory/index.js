// Memory S: the file layout in docs/memory-schema.md, one directory, no vector store, no dependencies.
// Machine-written files (lessons/places/raw/state) and her own writing (self/goals/people/story) are kept apart on purpose:
// the audit reconciles "what she says" (story) against "what happened" (raw), so they must never share a file.
import fs from 'fs';
import path from 'path';
import { TaughtStore } from './taught.js';
import { PromiseStore, ACCEPT_RE, isTestBot, isOneOffRequest, normalizeOwner } from './promises.js';
import { WorldStore } from './worlds.js';
import { HeardStore } from './heard.js';
import { rank } from './recall.js';

/** Bots that exist to exercise the harness. Their words are test data, not her life: never learned, never recalled. */
/** A speaker is a short name: no sentence punctuation, no verbs of narration, not a whole clause. */
export function looksLikeSpeaker(name) {
    const s = String(name || '').trim();
    if (!s) return false;
    if (/[。，,、；;！？!?：:"“”（）()0-9]/.test(s)) return false;         // punctuation or coordinates: not a name
    if (/(说|讲|告诉|认为|觉得|建议|让我|要我|教过|可以|应该|据说|好像|可能)/.test(s)) return false;   // narration
    if (s.length <= 5) return true;                                        // 家 / 白桦 / 洞屋
    return /(老大|主人|玩家|自己|我|他|她|system|AI|bot|JFors)/i.test(s);   // a long token that is clearly a person
}

export const TEST_BOT_NAMES = /^(HouseTest|FactsTest|JumpTest|Scanner|SkinCheck|PillarTest|CaveTest|SkinCheckBot|FakeOwner|ArenaHost)$/i;   // ArenaHost: the combat-arena host (owner 10-26), its words are not facts she was taught

export const CAPS = {
    self: 2 * 1024,
    goals: 1 * 1024,
    lessons: 4 * 1024,
    people: 2 * 1024,
    storyPerDay: 2 * 1024,
    prompt: 12 * 1024
};

const DAY = (ms) => new Date(ms).toISOString().slice(0, 10);

/** DeepSeek #3977 (final-104/106): five deaths in 21 minutes inside one ~13-block patch by her house, five causes, and she kept going back.
 * How many of the deaths within `radius` blocks of `pos` in the last `withinMs` (this one included), each with local time and cause - a
 * fact for her death message, or '' when this is the only one. Where to be is hers. */
export function nearbyDeathLine(deaths, pos, now, { radius = 16, withinMs = 3600e3, tzOffsetMinutes = null } = {}) {
    if (!pos) return '';
    const near = (deaths || []).filter((d) => d?.pos && now - d.at <= withinMs && d.at <= now
        && Math.hypot(d.pos.x - pos.x, d.pos.z - pos.z) <= radius).sort((a, b) => a.at - b.at);   // across, not up/down: a mine under the house is the same place
    if (near.length < 2) return '';
    const when = (at) => {
        const offset = tzOffsetMinutes == null ? -new Date(at).getTimezoneOffset() : tzOffsetMinutes;
        return new Date(at + offset * 60_000).toISOString().slice(11, 16);
    };
    return `这是你最近 1 小时里在这附近（${radius} 格内）第 ${near.length} 次死：`
        + near.map((d) => `${when(d.at)} ${d.cause || 'unknown'}`).join('；') + '。';   // noteDeath already dropped her name
}
const stamp = (ms) => new Date(ms).toISOString().slice(11, 16);   // HH:MM, UTC; the report converts
const trimTo = (text, cap) => (text.length <= cap ? text : text.slice(0, cap));

/** Append-only line list kept inside a size cap: newest kept, oldest dropped, with one marker line when it happens. */
function cappedAppend(current, line, cap) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= cap) return next;
    const lines = next.split('\n');
    while (lines.length > 1 && lines.join('\n').length > cap) lines.shift();
    return `…(older entries dropped to stay under ${cap} bytes)\n${lines.join('\n')}`;
}

export class MemoryS {
    /**
     * @param {object} opts
     * @param {string} opts.dir            memory root, e.g. `memory/`
     * @param {number} [opts.now]          fixed clock for tests
     */
    constructor({ dir, now = () => Date.now(), ownerName = 'JFors' }) {
        this.ownerName = ownerName;
        this.dir = dir;
        this.now = now;
        this.taught = new TaughtStore(path.join(dir, 'taught.jsonl'));
        this.heard = new HeardStore(path.join(dir, 'heard.jsonl'));
        // promises: what she told the owner she would do, right next to what she heard him say
        this.promises = new PromiseStore(path.join(this.dir, 'promises.jsonl'));
        // D1: world-scoped memory. Without a setWorld call everything stays global, exactly as before this change.
        this.worlds = new WorldStore(this.dir, { now: now });
        this.cache = {};
        this.state = {};
        this._ensure();
    }

    _p(...parts) { return path.join(this.dir, ...parts); }

    _ensure() {
        fs.mkdirSync(this._p('story'), { recursive: true });
        fs.mkdirSync(this._p('raw'), { recursive: true });
        for (const f of ['self.md', 'goals.md', 'lessons.md', 'places.md', 'people.md']) {
            if (!fs.existsSync(this._p(f))) this._write(f, '');
        }
        if (fs.existsSync(this._p('state.json'))) {
            try { this.state = JSON.parse(fs.readFileSync(this._p('state.json'), 'utf8')); } catch { this.state = {}; }
        }
        this.state.day ??= 1;
    }

    _read(file) {
        if (this.cache[file] !== undefined) return this.cache[file];
        try { this.cache[file] = fs.readFileSync(this._p(file), 'utf8'); } catch { this.cache[file] = ''; }
        return this.cache[file];
    }

    /**
     * Files the world store rewrites behind our back. Deleting the cache entry is the only safe move: a stale copy is
     * worse than a re-read, because the next write would push the stale copy back to disk.
     */
    _invalidateWorldFiles() {
        for (const file of ['taught.jsonl', 'places.md', 'places.jsonl', 'goals.md', 'promises.jsonl']) {
            delete this.cache[file];
        }
    }

    _write(file, text) {
        const target = this._p(file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const tmp = `${target}.tmp`;
        fs.writeFileSync(tmp, text);          // atomic: a crash mid-write must not truncate her memory
        fs.renameSync(tmp, target);
        this.cache[file] = text;
    }

    // ── machine-written ────────────────────────────────────────────────────────────────────────────

    lessonLines() { return this._read('lessons.md').split('\n').filter((l) => l.startsWith('- ')); }

    /** One line per failed primitive. Same kind+reason+args within `dedupeMs` is written once. */
    noteFailure({ kind, reason, args = {}, at = this.now(), dedupeMs = 5 * 60 * 1000 } = {}) {
        const key = `${kind}|${reason}|${JSON.stringify(args)}`;
        this.state.lastFailure = { kind, reason, at, key };
        const recent = this.state.recentFailures || [];
        if (recent.some((r) => r.key === key && at - r.at < dedupeMs)) return null;
        this.state.recentFailures = [...recent, { key, at }].slice(-20);
        const line = `- [${DAY(at)} ${stamp(at)}] ${kind} → ${reason} ${JSON.stringify(args)}`;
        this._write('lessons.md', cappedAppend(this._read('lessons.md'), line, CAPS.lessons));
        this.raw({ type: 'failure', kind, reason, args, at });
        this._save();
        return line;
    }

    /**
     * One record per death, with the conditions she needs in order to generalise: cause, position, weather, time of day.
     * weather/tod may be missing (the harness knows them, the memory does not) - a missing value is recorded as unknown
     * rather than guessed, because a guessed "sunny" would teach her the wrong lesson.
     */
    noteDeath({ cause = null, pos = null, weather = null, tod = null, at = this.now() } = {}) {
        const rec = {
            type: 'death',
            at,
            cause: cause ? String(cause).replace(/^\w+\s+/, '').trim() : 'unknown',
            pos: pos || null,
            weather: weather == null ? 'unknown' : String(weather),
            tod: Number.isFinite(tod) ? tod : null,
            night: Number.isFinite(tod) ? (tod >= 13000 && tod <= 23000) : null
        };
        this.raw(rec);
        this.state.deathsByDay = { ...(this.state.deathsByDay || {}), [DAY(at)]: ((this.state.deathsByDay || {})[DAY(at)] || 0) + 1 };
        this._save();
        return rec;
    }

    /** Deaths recorded on a given UTC day, oldest first. */
    deaths(day = DAY(this.now())) {
        return this._readRawDay(day).filter((e) => e.type === 'death');
    }

    /** A compact, factual line per death for the lesson prompt: time + cause + weather + day/night. */
    deathLines(day = DAY(this.now()), max = 8, { tzOffsetMinutes = null, rows = null } = {}) {
        const partOfDay = (d) => (d.night === true ? '夜里' : d.night === false ? '白天' : '时间未知');
        // LOCAL time, the same clock as the host logs. toISOString() is UTC: a test death at 17:48 local showed up as
        // 09:48, she read it as a real event of her day, and wrote a lesson about it (#3038).
        const when = (at) => {
            const offset = tzOffsetMinutes == null ? -new Date(at).getTimezoneOffset() : tzOffsetMinutes;
            return new Date(at + offset * 60_000).toISOString().slice(11, 16);
        };
        return (rows || this.deaths(day)).slice(-max).map((d) =>
            `${when(d.at)} ${d.cause}（${d.weather}·${partOfDay(d)}）`);
    }


    // ── goal stamps (D1 gap #3315) ───────────────────────────────────────────────────────────────────────
    _goalFile() { return path.join(this.dir, 'goals.jsonl'); }

    _goals() {
        try {
            return fs.readFileSync(this._goalFile(), 'utf8').split('\n').filter(Boolean).map((l) => {
                try { return JSON.parse(l); } catch { return null; }
            }).filter(Boolean);
        } catch { return []; }
    }

    _writeGoals(rows) {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(this._goalFile(), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    }

    /** Goal texts as she reads them, without the status suffix. */
    _goalTexts() {
        return this._read('goals.md').split('\n').filter((l) => l.startsWith('- '))
            .map((l) => l.replace(/^- /, '').replace(/（(未开始|进行中|做到了)）\s*$/, '').trim()).filter(Boolean);
    }

    /** Which world was this goal set in? null when unknown (written before this feature). */
    goalWorld(text) {
        const needle = String(text || '').trim();
        if (!needle) return null;
        const row = this._goals().find((r) => r.goal === needle || needle.startsWith(r.goal));
        return row?.world || null;
    }

    stampGoal(text, world, { legacy = false, at = this.now() } = {}) {
        const g = String(text || '').trim();
        if (!g || !world) return null;
        const rows = this._goals();
        const existing = rows.find((r) => r.goal === g);
        if (existing) { existing.world = world; if (legacy) existing.legacy = true; }
        else rows.push({ goal: g, world, at, legacy });
        this._writeGoals(rows);
        return { goal: g, world, legacy };
    }

    /** Goals carried over from the world she is leaving get its stamp. */
    stampLegacyGoals(world) {
        const rows = this._goals();
        let n = 0;
        for (const g of this._goalTexts()) {
            if (rows.some((r) => r.goal === g)) continue;
            rows.push({ goal: g, world, at: this.now(), legacy: true });
            n++;
        }
        if (n) this._writeGoals(rows);
        return n;
    }

    // ── place stamps (D1 gap #3293) ───────────────────────────────────────────────────────────────────────
    _placeFile() { return path.join(this.dir, 'places.jsonl'); }

    _places() {
        try {
            return fs.readFileSync(this._placeFile(), 'utf8').split('\n').filter(Boolean).map((l) => {
                try { return JSON.parse(l); } catch { return null; }
            }).filter(Boolean);
        } catch { return []; }
    }

    _writePlaces(rows) {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(this._placeFile(), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    }

    /** Which world was this place saved in? null when unknown (a place written before this feature). */
    placeWorld(name) {
        const row = this._places().find((r) => r.name === String(name || '').trim());
        return row?.world || null;
    }

    /** Record the world a place belongs to. Called on save and on switch (legacy stamping). */
    stampPlace(name, world, { legacy = false, at = this.now() } = {}) {
        const n = String(name || '').trim();
        if (!n || !world) return null;
        const rows = this._places();
        const existing = rows.find((r) => r.name === n);
        if (existing) { existing.world = world; if (legacy) existing.legacy = true; }
        else rows.push({ name: n, world, at, legacy });
        this._writePlaces(rows);
        return { name: n, world, legacy };
    }

    /** Stamp every place that has no world yet with the world she is leaving. */
    stampLegacyPlaces(world) {
        const rows = this._places();
        let n = 0;
        for (const name of this._placeNames()) {
            if (rows.some((r) => r.name === name)) continue;
            rows.push({ name, world, at: this.now(), legacy: true });
            n++;
        }
        if (n) this._writePlaces(rows);
        return n;
    }

    _placeNames() {
        return this._read('places.md').split('\n').filter((l) => l.startsWith('- '))
            .map((l) => (l.match(/^- (.+?) ：/) || [])[1]).filter(Boolean);
    }

    appendPlace(name, pos, at = this.now()) {
        if (!name || !pos) return null;
        const line = `- ${String(name).trim()} ： (${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)})` +
            (pos.dimension ? ` @${pos.dimension}` : '');
        // remember which world this place belongs to, so a later world cannot mistake it for a local place
        if (this.worldKey) this.stampPlace(name, this.worldKey, { at });
        const kept = this._read('places.md').split('\n').filter((l) => l && !l.includes(`- ${name} ：`));
        this._write('places.md', trimTo([line, ...kept].join('\n'), CAPS.people));
        this.raw({ type: 'place', name, pos, at });
        return line;
    }

    place(name) {
        const n = String(name || '').trim();
        if (!n) return null;
        // anchor on this exact place: a glued or malformed line must answer null rather than somebody else's numbers
        const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c);
        const re = new RegExp('(?:^|\\n)- ' + escaped + ' ： \\(\\s*(-?\\d+)\\s*,\\s*(-?\\d+)\\s*,\\s*(-?\\d+)\\s*\\)');
        const m = this._read('places.md').match(re);
        return m ? { x: +m[1], y: +m[2], z: +m[3] } : null;
    }

    raw(entry) {
        const file = `raw/${DAY(entry.at ?? this.now())}.jsonl`;
        fs.appendFileSync(this._p(file), `${JSON.stringify(entry)}\n`);
    }

    noteOpUse(kind, at = this.now()) {
        this.state.opUses = { ...(this.state.opUses || {}), [kind]: ((this.state.opUses?.[kind]) || 0) + 1 };
        this.raw({ type: 'op', kind, at });
        this._save();
    }

    noteSaid(text, { canned = false, at = this.now() } = {}) {
        this._recentSaid = (this._recentSaid || []).concat(String(text || '').slice(0, 200)).slice(-20);
        this.state.said = this.state.said || { total: 0, canned: 0 };
        this.state.said.total += 1;
        if (canned) this.state.said.canned += 1;
        this.raw({ type: 'say', text: String(text).slice(0, 200), canned, at });
        this._save();
    }

    _save() {
        const target = this._p('state.json');
        const tmp = `${target}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
        fs.renameSync(tmp, target);
    }

    // ── hers ───────────────────────────────────────────────────────────────────────────────────────

    setSelf(text) { this._write('self.md', trimTo(String(text || ''), CAPS.self)); }
    setGoals(text) {
        const body = trimTo(String(text || ''), CAPS.goals);
        this._write('goals.md', body);
        if (this.worldKey) for (const g of this._goalTexts()) this.stampGoal(g, this.worldKey);
    }
    setPeople(text) { this._write('people.md', trimTo(String(text || ''), CAPS.people)); }
    day() { return this.state.day || 1; }

    writeStory(text, at = this.now()) {
        const file = `story/day-${String(this.day()).padStart(3, '0')}.md`;
        this._write(file, trimTo(String(text || ''), CAPS.storyPerDay));
        this.raw({ type: 'story', day: this.day(), at });
    }

    readStory(day = this.day()) {
        const file = `story/day-${String(day).padStart(3, '0')}.md`;
        return this._read(file);
    }

    /** Last N lesson lines, newest last in the file but returned newest first for the prompt. */
    lessons(n = 6) {
        const lines = this._read('lessons.md').split('\n').filter((l) => l.startsWith('- '));
        return lines.slice(-n).reverse();
    }

    /**
     * What goes in front of the model every turn. Skill sections are cut before identity: identity is who she is,
     * lessons are technique, and technique can be rediscovered.
     */
    promptBlock({ lessons = 6, query = null, k = 5, excludeRecentMs = 60_000 } = {}) {
        const parts = [];
        const self = this._read('self.md').trim();
        if (self) parts.push(`【关于我自己】\n${trimTo(self, 900)}`);
        // an accepted request outranks a remembered lesson: show it first, every turn, until she closes it
        try {
            const online = this._ownerOnline ? !!this._ownerOnline() : true;
            this.promises?.syncClock?.(this.now(), { ownerOnline: online });
            this.promises?.expire?.(this.now(), { ownerOnline: online });
            const evidence = (this._recentSaid || []).slice(-10).join(' ');
            const pl = this.promises?.lines?.(this.now(), { ownerOnline: online, evidence }) || [];
            if (pl.length) parts.push(pl.join('\n'));
        } catch { /* memory must never break the prompt */ }
        const goals = this._read('goals.md').trim();
        if (goals) {
            const cur = this.worldKey;
            const marked = goals.split('\n').map((line) => {
                if (!cur || !line.startsWith('- ')) return line;
                const text = line.replace(/^- /, '').replace(/（(未开始|进行中|做到了)）\s*$/, '').trim();
                const w = this.goalWorld(text);
                return w && w !== cur ? `${line}（旧世界）` : line;
            }).join('\n');
            parts.push(`【这几天想做的事】\n${trimTo(marked, 500)}`);
        }
        const people = this._read('people.md').trim();
        if (people) parts.push(`【人】\n${trimTo(people, 400)}`);
        const places = this._read('places.md').trim();
        if (places) {
            // places from another world are still listed, but marked, so a stale coordinate cannot pose as valid
            const cur = this.worldKey;
            const marked = places.split('\n').map((line) => {
                if (!cur) return line;
                const name = (line.match(/^- (.+?) ：/) || [])[1];
                const w = name ? this.placeWorld(name) : null;
                return w && w !== cur ? `${line}（旧世界）` : line;
            });
            // 10-28 new save: cut at 400 characters, the last line lost its "（旧世界）" and an old coordinate read as current - whole lines only
            const shown = [];
            let used = 0;
            for (const line of marked) { if (used + line.length + 1 > 400 && shown.length) break; shown.push(line); used += line.length + 1; }
            const more = marked.filter((l) => l.startsWith('- ')).length - shown.filter((l) => l.startsWith('- ')).length;
            parts.push(`【地点簿】\n${shown.join('\n')}${more > 0 ? `\n（还有 ${more} 个地点没列出，!savedPlaces 能看全）` : ''}`);
        }
        if (query) {
            const hits = this.recall(query, k, { excludeRecentMs });
            if (hits.length) parts.push(`【和现在有关的记忆】\n${hits.map((h) => `- ${h.text}`).join('\n')}`);
        }
        // D1: rows that belong to another world are still shown, but marked, so a stale coordinate cannot pose as valid
        const cur = this.worlds?.current?.();
        const promiseLines = [];
        if (cur) {
            try {
                const foreign = this.worlds.showBatch(1);
                // at most three offers per world-day, and only when it is safe; her own !showMemories is not counted
                const offer = this.worlds.triageOffer(this._worldDay(), { safe: this._triageAllowed() });
                if (foreign.items.length && offer.allowed) {
                    this.worlds.noteTriageOffered(this._worldDay());
                    promiseLines.push('【可能是旧世界的东西（你自己决定要不要收起来）】\n'
                        + foreign.items.map((i) => `- ${i.who}：${i.text}`).join('\n')
                        + `\n觉得不该带在这个世界的，就 !archiveMemory("${(foreign.items[0].text || '').slice(0, 12)}")` 
                        + `（命中多条会让你确认）；想留着也行，什么都不做也没关系。`);
                }
            } catch { /* triage is a nicety, never a prompt breaker */ }
        }
        const own = this.insights(3);
        const ls = this.lessons(lessons);
        if (own.length || ls.length) {
            parts.push('【上次的教训】\n'
                + (own.length ? `她自己总结的：\n${own.map((l) => '  ' + l).join('\n')}\n` : '')
                + (ls.length ? `机器记录下来的事实：\n${ls.map((l) => '  ' + l).join('\n')}` : ''));
        }
        if (promiseLines.length) parts.push(promiseLines.join('\n\n'));
        let out = parts.join('\n\n');
        while (out.length > CAPS.prompt && parts.length > 1) { parts.pop(); out = parts.join('\n\n'); }
        return out;
    }

    // ── taught facts ──────────────────────────────────────────────────────────────────────────────
    /** What a player tells her. Never evicted, never capped: the owner's rule is that taught knowledge is kept. */
    /** Dawn path: semantic dedupe when an embedder is available, offline rules otherwise. Never breaks a dawn. */
    async rememberTaughtAsync({ who, what, at = this.now(), source = 'player' } = {}) {
        who = normalizeOwner(who, this.ownerName);          // '老大' is the owner: one person, one name
        if (who && TEST_BOT_NAMES.test(String(who).trim())) return null;
        if (isOneOffRequest(what)) return null;
        if (!this._embed) return this.rememberTaught({ who, what, at, source });
        try {
            const { EmbedCache } = await import('./semantic.js');
            this._embedCache = this._embedCache || new EmbedCache(200);
            const row = await this.taught.rememberSemantic({ who, what, at, source, embed: this._embed, cache: this._embedCache });
            if (row && !row.duplicate) this.raw({ type: 'taught', who: row.who, what: row.what, at });
            return row;
        } catch {
            return this.rememberTaught({ who, what, at, source });
        }
    }

    rememberTaught({ who, what, at = this.now(), source = 'player' } = {}) {
        who = normalizeOwner(who, this.ownerName);          // '老大' is the owner: one person, one name
        if (who && TEST_BOT_NAMES.test(String(who).trim())) return null;   // never promote a test bot's facts
        // #3152: a one-off request ("go fetch four planks from the chest at -2,64,-3") is a task, not a fact. It lives in
        // promises.jsonl and expires; a never-delete fact would keep the errand alive long after it was done.
        if (isOneOffRequest(what)) return null;
        const row = this.taught.remember({ who, what, at, source });
        if (row && !row.duplicate) this.raw({ type: 'taught', who: row.who, what: row.what, at });
        return row;
    }

    /**
     * Every player line she hears. Uncapped and append-only: she is not asked to memorise anything on purpose, the
     * transcript is simply there, and recall plus the nightly pass decide later what mattered.
     */
    /** Her reply accepted the owner's request: that is the promise. The reply is the test, the request is the text. */
    // ── world scope (D1, #3269) ─────────────────────────────────────────────────────────────────────────
    /** Called once per process by the agent's C4 hook. Idempotent; a different key is a confirmed switch. */
    setWorld(key, parts = {}) {
        const res = this.worlds.setWorld(key, parts);
        this.worldKey = res.key;
        // goals she carried into the new world were set in the old one
        if (res.previous) this.stampLegacyGoals(res.previous);
        // the switch may have loaded another world's rows into the live files
        this._invalidateWorldFiles();
        return res;
    }

    worldStatus() {
        return { ...this.worlds.current(), key: this.worlds.current()?.key || this.worldKey || null };
    }

    /** ≤8 rows per batch, so a triage request can never blow the prompt budget. */
    showWorldBatch(n = 1) {
        return this.worlds.showBatch(n);
    }

    /** She decides: archived rows are moved into their own world's folder, never deleted. */
    archiveWorldRows(match, opts = {}) {
        const res = this.worlds.archive(match, opts);
        // archiving removes rows from places.md / taught.jsonl; a warm cache would keep them alive
        if (res && res.ok) this._invalidateWorldFiles();
        return res;
    }

    restoreWorldRows(match, opts = {}) {
        const res = this.worlds.restore(match, opts);
        if (res && res.ok) this._invalidateWorldFiles();
        return res;
    }

    /** The agent says whether the owner is in-game; while he is away a promise clock pauses instead of expiring. */
    setOwnerPresence(fn) {
        this._ownerOnline = typeof fn === 'function' ? fn : () => true;
    }

    /** D6: the agent supplies what is actually true right now (inventory, places, position). No provider, no numbers. */
    setFactsProvider(fn) {
        this._factsFn = typeof fn === 'function' ? fn : null;
    }

    /** Mob names we can recognise, in the order they should be reported. */
    static MOBS = [
        [/zombie|僵尸/i, '僵尸'], [/skeleton|骷髅/i, '骷髅'], [/creeper|苦力怕|爬行者/i, '苦力怕'],
        [/spider|蜘蛛/i, '蜘蛛'], [/drowned|溺尸/i, '溺尸'], [/pillager|掠夺者/i, '掠夺者'],
        [/vindicator|卫道士/i, '卫道士'], [/ravager|劫掠兽/i, '劫掠兽'], [/witch|女巫/i, '女巫'],
        [/enderman|末影人/i, '末影人'], [/slime|史莱姆/i, '史莱姆'], [/phantom|幻翼/i, '幻翼'],
        [/zombified|僵尸猪灵/i, '僵尸猪灵'], [/husk|尸壳/i, '尸壳'], [/stray|流浪者/i, '流浪者'],
        [/wandering_trader|流浪商人/i, '流浪商人'], [/cow|牛/i, '牛'], [/sheep|羊/i, '羊'],
        [/pig|猪/i, '猪'], [/chicken|鸡/i, '鸡'], [/wolf|狼/i, '狼']
    ];

    /** Where the event log lives, relative to the memory dir. Missing file is fine: the caller degrades. */
    _logFile() {
        const candidates = [
            path.resolve(this.dir, '../../../logs/agent.ndjson'),
            path.resolve(this.dir, '../../../../logs/agent.ndjson'),
            'logs/agent.ndjson'
        ];
        return candidates.find((p) => fs.existsSync(p)) || null;
    }

    /** Raw files are keyed by date; her game day is a number. Accept either and resolve to an existing file. */
    _rawKey(dayKey) {
        if (dayKey && fs.existsSync(this._p(`raw/${dayKey}.jsonl`))) return dayKey;
        const today = DAY(this.now());
        if (fs.existsSync(this._p(`raw/${today}.jsonl`))) return today;
        return dayKey || today;
    }

    /**
     * Which mobs she really met today: deaths and failures from the raw events, plus the danger notices and attacks that
     * happened inside the same time window. Names are matched in both languages.
     */
    encounteredMobs(dayKey, since = 0) {
        const key = this._rawKey(dayKey);
        const events = since ? this._rawSince(since, this.now()) : this._readRawDay(key);
        const found = new Set();
        const add = (text) => { for (const [re, zh] of MemoryS.MOBS) if (re.test(String(text || ''))) found.add(zh); };
        for (const e of events) add(`${e.cause || ''} ${e.reason || ''} ${e.text || ''} ${e.mob || ''} ${e.type || ''}`);

        // the same window in the event log: a danger notice names the mob, an attack has it as the target
        const times = events.map((e) => e.at).filter((n) => Number.isFinite(n));
        const log = this._logFile();
        if (log && times.length) {
            const lo = Math.min(...times) - 60_000;
            const hi = Math.max(...times) + 60_000;
            try {
                for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
                    if (!line) continue;
                    const m = line.match(/^\[(\w+)\]\s*(\{.*\})$/);
                    if (!m) continue;
                    let e; try { e = JSON.parse(m[2]); } catch { continue; }
                    if (!(e.at >= lo && e.at <= hi)) continue;
                    if (e.gate === 'danger') add(`${e.why || ''} ${(e.options || []).join(' ')}`);
                    if (m[1] === 'act' && e.kind === 'attack') add(`${e.target || ''} ${e.args?.mob || ''} ${e.args?.target || ''}`);
                }
            } catch { /* the log is a nicety, never a requirement */ }
        }
        return [...found];
    }

    _facts() {
        try {
            const f = this._factsFn ? this._factsFn() : null;
            if (!f) return null;
            return {
                day: Number(f.day) || this.state.day || 1,
                inventory: Array.isArray(f.inventory) ? f.inventory.filter((i) => i && i.item) : [],
                places: Array.isArray(f.places) ? f.places.filter((p) => p && p.name) : [],
                mobs: this.encounteredMobs(Number(f.day) || this.state.day || 1),
                pos: f.pos && Number.isFinite(f.pos.x) ? { x: Math.round(f.pos.x), y: Math.round(f.pos.y), z: Math.round(f.pos.z) } : null
            };
        } catch { return null; }
    }

    /**
     * Compare a generated summary with the facts. Only two things are checked, because those are the two a model invents:
     * item counts and coordinates. Returns human readable complaints (empty when the text is fine).
     */
    _auditSummary(text, facts) {
        if (!facts) return [];
        const s = String(text || '');
        const out = [];
        const CN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
        const toNum = (x) => (/^\d+$/.test(x) ? Number(x) : (CN[x] || 0));
        const ITEMS = [
            [/铁锭/, /iron_ingot/i], [/圆石/, /cobblestone/i], [/面包/, /bread/i], [/木板/, /planks/i],
            [/木头|原木/, /_log/i], [/镐/, /pickaxe/i], [/煤/, /coal/i], [/铜/, /copper/i],
            [/羊毛/, /wool/i], [/骨头/, /bone/i], [/线/, /string/i]
        ];
        for (const [zh, id] of ITEMS) {
            const NUM = '([0-9]+|[一二三四五六七八九十两])';
            const UNIT = '[ 　]*(?:个|块|根|组|把|件)?';
            // number before the item ("5 个铁锭")
            const reBefore = new RegExp(NUM + UNIT + '[ 　]*[^，。；]{0,2}?' + zh.source, 'g');
            // number after the item ("铁锭 5 个")
            const reAfter = new RegExp(zh.source + UNIT + '[ 　]*' + NUM, 'g');
            const counts = [];
            {
                let b;
                while ((b = reBefore.exec(s)) !== null) counts.push(b[1]);
                let a;
                while ((a = reAfter.exec(s)) !== null) counts.push(a[1]);
            }
            if (counts.length) {
                const claimed = toNum(counts[0]);
                const real = facts.inventory.filter((i) => id.test(String(i.item))).reduce((sum, i) => sum + (Number(i.count) || 0), 0);
                if (claimed && claimed !== real) out.push(zh.source + ' 实际 ' + real + ' 个，摘要写了 ' + claimed + ' 个');
            }
        }
        const known = new Set((facts.places || []).map((p) => Math.round(p.x) + ',' + Math.round(p.y) + ',' + Math.round(p.z)));
        if (facts.pos) known.add(facts.pos.x + ',' + facts.pos.y + ',' + facts.pos.z);
        const coordRe = /\(?\s*(-?\d{1,5})\s*[,，]\s*(-?\d{1,3})\s*[,，]\s*(-?\d{1,5})\s*\)?/g;
        let c;
        while ((c = coordRe.exec(s)) !== null) {
            const key = c[1] + ',' + c[2] + ',' + c[3];
            if (!known.has(key)) out.push('坐标 (' + key + ') 不在地点簿里，也不是当前位置');
        }
        return [...new Set(out)].slice(0, 4);
    }

    /**
     * Hostile mobs a text names that today's facts do not contain. Returns notes only: the text is kept as written, the
     * note is appended, because "she believed something wrong" is itself worth remembering.
     */
    _mobNotes(text, facts) {
        if (!facts) return [];
        const s = String(text || '');
        const met = new Set(facts.mobs || []);
        const notes = [];
        for (const [, zh] of MemoryS.MOBS) {
            if (!s.includes(zh)) continue;
            if (met.has(zh)) continue;
            notes.push(`今天没遇到过${zh}，可能是旧世界的经验`);
        }
        return [...new Set(notes)].slice(0, 3);
    }

    _factsBlock(facts) {
        if (!facts) return '';
        const inv = facts.inventory.length
            ? facts.inventory.map((i) => `${i.item}×${i.count}`).join(' · ')
            : '(背包是空的，或没测到)';
        const places = facts.places.length
            ? facts.places.slice(0, 12).map((p) => `${p.name}(${p.x ?? '?'},${p.y ?? '?'},${p.z ?? '?'})`).join(' · ')
            : '(地点簿是空的)';
        return [
            `【截至 第${facts.day}天 的真实情况（以此为准，不要凭记忆写数字或坐标）】`,
            `库存：${inv}`,
            `地点簿：${places}`,
            facts.mobs && facts.mobs.length ? `今天在这个世界真正遇到的生物：${facts.mobs.join('、')}` : '',
            facts.pos ? `她当前位置：(${facts.pos.x}, ${facts.pos.y}, ${facts.pos.z})` : '',
            '摘要里如果提到库存数量或坐标，必须与上表一致；不确定就写「截至第N天」并省略数字。'
        ].filter(Boolean).join('\n');
    }

    /** Fold repeated copies of the same fact on disk (see TaughtStore.compact). Safe to call repeatedly. */
    compactTaught() {
        try { return this.taught.compact(); } catch (e) { return { folded: 0, error: e.message }; }
    }

    /** The agent says whether it is safe to spend a turn on memory triage (never during danger). */
    setTriageAllowed(fn) {
        this._triageFn = typeof fn === 'function' ? fn : null;
    }

    _worldDay() {
        const d = this.worlds?.current?.();
        return `${d?.key || 'world'}:${this.state?.day ?? DAY(this.now())}`;
    }

    _triageAllowed() {
        try { return this._triageFn ? !!this._triageFn() : true; } catch { return false; }
    }

    /** The agent hands in the project's embedding model here; without it everything falls back to the offline rules. */
    setEmbedder(embed) {
        this._embed = typeof embed === 'function' ? embed : null;
    }

    notePromise({ request, reply, who, at = this.now() } = {}) {
        who = normalizeOwner(who, this.ownerName);
        if (!ACCEPT_RE.test(String(reply || ''))) return null;   // only an explicit yes arms anything
        return this.promises.add({ text: request, who, at });
    }

    /** She closes it herself. */
    closePromise({ match, status = 'done', reason = '' } = {}) {
        return this.promises.close({ match, status, reason, at: this.now() });
    }

    openPromises() {
        return this.promises.open(this.now());
    }

    noteHeard({ who, text, at = this.now() } = {}) {
        if (who && TEST_BOT_NAMES.test(String(who).trim())) return null;   // a test bot talking is not her life
        const row = this.heard.add({ who, text, at });
        if (row) this.raw({ type: 'heard', who: row.who, text: row.text.slice(0, 300), at });
        return row;
    }

    heardLines(n = 50) { return this.heard.recent(n); }

    taughtFacts() { return this.taught.all(); }

    /** Explicit forget only (the owner saying it no longer applies). Returns how many were forgotten. */
    forgetTaught(match) {
        const n = this.taught.forget(match);
        if (n) this.raw({ type: 'forget', match, n, at: this.now() });
        return n;
    }

    /**
     * The few memories that matter for what is happening now, instead of a truncated slice of everything.
     * Sources: taught facts, lessons, places. Only the ones with overlap are returned.
     */
    recall(query, k = 5, { embed, heardLimit = 5000, excludeRecentMs = 60_000 } = {}) {
        const docs = [
            ...this.taught.all().map((r, i) => ({ id: `taught:${i}`, type: 'taught', who: r.who, text: `${r.who}说过：${r.what}`, at: r.at })),
            ...this.insightLines().slice(-500).map((l, i) => ({ id: `insight:${i}`, type: 'insight', text: l })),
            ...this.lessonLines().map((l, i) => ({ id: `lesson:${i}`, type: 'lesson', text: l.replace(/^- /, '') })),
            ...this.heard.recent(heardLimit)
                .filter((r) => {
                    const same = String(r.text).replace(/\s+/g, ' ').trim() === String(query || '').replace(/\s+/g, ' ').trim();
                    if (same) return false;                                   // the question itself, at any age
                    return excludeRecentMs <= 0 || this.now() - r.at >= excludeRecentMs;   // still in short-term history
                })
                .map((r, i) => ({ id: `heard:${i}`, type: 'heard', who: r.who, text: `${r.who}说过：${r.text}`, at: r.at })),
            ...this._read('places.md').split('\n').filter((l) => l.startsWith('- ')).map((l, i) => ({ id: `place:${i}`, type: 'place', text: l.replace(/^- /, '') }))
        ];
        return rank(query, docs, k, { embed });
    }

    /**
     * Nightly: she rewrites her own memory from what the machine recorded. `ask(prompt) -> string` is the only LLM contact,
     * so this is testable with a stub and never blocks a decision.
     */
    // ── her own learning ─────────────────────────────────────────────────────────────────────────────
    /** What she concluded herself at dawn. Kept apart from the machine's failure lines: those are evidence, these are lessons. */
    insightLines() { return this._read('insights.md').split('\n').filter((l) => l.startsWith('- ')).map((l) => l.replace(/^- /, '')); }

    insights(n = 3) {
        return this.insightLines().slice(-n).reverse();
    }

    /** Append-only: her lessons are a record, not a cache. Nothing is ever dropped; the prompt trims instead. */
    _writeInsights(day, list) {
        if (!list.length) return;
        const section = '\n## day ' + day + '\n' + list.map((l) => '- ' + l).join('\n') + '\n';
        fs.appendFileSync(this._p('insights.md'), section);
        this.cache['insights.md'] = undefined;
    }


    readGoals() { return this._read('goals.md'); }

    /** Counters for the audit (R② her own lessons per day, R④ long-term goals reached). */
    stats() {
        return {
            insightsByDay: this.state.insightsByDay || {},
            goalsDoneByDay: this.state.goalsDoneByDay || {},
            goalsDoneTotal: this.state.goalsDoneTotal || 0,
            insightsTotal: this.insightLines().length,
            deathsByDay: this.state.deathsByDay || {},
            machineFailures: this._read('lessons.md').split('\n').filter((l) => l.startsWith('- ')).length
        };
    }

    /** Split the model's answer into the four sections it was asked for, tolerating a missing ③/④. */
    static splitSections(text, stripLabel) {
        const clean = String(text || '');
        const factsAt = clean.search(/^\s*FACTS\s*[:：]/m);
        const body = factsAt >= 0 ? clean.slice(0, factsAt) : clean;
        const facts = factsAt >= 0 ? clean.slice(factsAt) : '';
        const marks = [];
        const re = /^\s*([①②③④])\s*/gm;
        let m;
        while ((m = re.exec(body))) marks.push({ mark: m[1], at: m.index, end: m.index + m[0].length });
        const out = { self: '', diary: '', insights: '', goals: '', facts };
        if (marks.length) {
            for (let i = 0; i < marks.length; i++) {
                const chunk = body.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].at : body.length);
                const key = { '①': 'self', '②': 'diary', '③': 'insights', '④': 'goals' }[marks[i].mark];
                out[key] = stripLabel(chunk).trim();
            }
        } else {
            const parts = body.split(/\n{2,}/).filter((p) => p.trim());
            out.self = stripLabel(parts[0] || '').trim();
            out.diary = stripLabel(parts[1] || '').trim();
        }
        return out;
    }

    static bullets(text, max = 5) {
        return String(text || '').split('\n').map((l) => l.replace(/^\s*(?:[-*]|\d+[.、])\s*/, '').trim())
            .filter((l) => l
                && !/[:：]$/.test(l)                                   // a section header, not a bullet
                && !/^(教训|目标|长远想做的事|今天学到的教训|无|没有|none)$/i.test(l))
            .slice(0, max);
    }

    /** "- 挖到铁（进行中）" / "- 挖到铁: 进行中" -> {text, status}; only three statuses are accepted. */
    static parseGoal(line) {
        const m = String(line).replace(/^\s*(?:[-*]|\d+[.、])\s*/, '').match(/^(.*?)[\s（(:：]*?(未开始|进行中|做到了)[)）]?\s*$/);
        if (!m) return { text: String(line).trim(), status: null };
        return { text: m[1].trim().replace(/[\s（(:：]+$/, ''), status: m[2] };
    }

    /**
     * Dawn: she rewrites who she is, her diary, her own lessons and her long-term goals, and promotes the facts she will
     * need again. `ask(prompt) -> string` is the only model contact, so this is testable with a stub.
     */
    async nightlyConsolidate(ask, { now = this.now(), keepRecent = 80 } = {}) {
        const day = this.state.day || 1;
        // final-116 10-28 (owner: "抓一下她的日记"): her game day is 20 real minutes, but "today" here was the whole UTC date, so
        // day-184 said 死了八次 - the last 8 deaths of the date, none of them in that game day. The diary now covers what happened
        // since the previous one; before her first diary it is still the whole date.
        // 10-28 new save: day-188 ran from the last diary (20:13, old world) across the shutdown into the new world, and opened with the
        // old world's coal mine. A diary starts no earlier than her arrival in the world she is in now.
        const arrived = this.worlds?.current?.()?.since;
        const since = Math.max(this._lastStoryAt(now), Number.isFinite(arrived) && arrived < now ? arrived : 0);
        const events = since ? this._rawSince(since, now) : this._readRawDay(DAY(now));
        const brief = events.filter((e) => ['failure', 'place', 'op', 'say', 'story'].includes(e.type))
            .slice(-keepRecent)
            .map((e) => e.type === 'failure' ? `失败: ${e.kind} ${e.reason}` : e.type === 'say' ? `说话: ${String(e.text || '').slice(0, 40)}` : null)
            .filter(Boolean).join('\n');
        const heard = this.heard.between(since || now - 24 * 3600_000, now + 1).slice(-80);
        const heardBlock = heard.length ? heard.map((r) => `${r.who}: ${r.text}`).join('\n') : '(今天没人跟你说话)';
        const deathLines = this.deathLines(DAY(now), 8, since ? { rows: events.filter((e) => e.type === 'death') } : {});
        const deaths = deathLines.length || events.filter((e) => e.type === 'failure' && /death/i.test(String(e.reason || ''))).length;
        const deathBlock = deathLines.length
            ? `今天死了 ${deathLines.length} 次：\n${deathLines.map((l) => '  - ' + l).join('\n')}`
            : '(今天没死)';
        const providerFacts = this._facts();
        const mobsMet = this.encounteredMobs(DAY(now), since);
        // the block still prefers the provider (it carries inventory and position); the mob list is ours either way
        const facts = providerFacts
            // the provider's mob list is the whole UTC date; since a previous diary, only this game day's mobs are hers
            ? { ...providerFacts, mobs: since ? mobsMet : (providerFacts.mobs && providerFacts.mobs.length ? providerFacts.mobs : mobsMet) }
            : (mobsMet.length ? { day, inventory: [], places: [], pos: null, mobs: mobsMet } : null);
        const factsBlock = this._factsBlock(facts);
        const prompt = [
            ...(factsBlock ? [factsBlock] : []),
            '下面是你今天在世界里的记录。用中文写，不要客套，严格按 ①②③④ 四段输出：',
            '① 「关于我自己」：不超过 300 字，只写能让我明天做决定时用得上的事（我喜欢做什么、我怕什么、哪些办法行不通）。',
            '② 「今天的日记」：不超过 300 字，用第一人称，写发生了什么，不要写流水账。',
            `③ 「今天学到的教训」：最多 3 条，每行一条，用你自己的话，从死亡、失败和你听到的话里总结（今天死亡 ${deaths} 次）。**如果同一种天气或同一个时段反复出事，就把天气/昼夜一起写进教训**；**要引用具体某次死亡时，只能用上面「死亡记录」里出现过的时间，不要自己编时间和死因**；不要照抄记录。`,
            '④ 「长远想做的事」：最多 5 条，每行一条，写成 `- 目标（未开始/进行中/做到了）`，只有这三档。',
            '【注意】上面「这几天想做的事」里带（旧世界）的，是上一个世界留下的目标：不要当成现在进行中的事，也不要据此推断现在世界的危险。',
            '最后另起一行写 `FACTS:`，然后每行一条 `- 谁：一句以后用得上的事实`，最多 5 条；没有就写 `FACTS: 无`。',
            `死亡记录（天气与昼夜是事实，不是我编的；「unknown」表示当时没测到）：\n${deathBlock}`,
            `记录：\n${brief || '(今天几乎没有记录)'}\n\n今天听到的话：\n${heardBlock}`
        ].join('\n\n');
        let text = '';
        try { text = String(await ask(prompt) || ''); } catch { text = ''; }
        if (!text.trim()) return { ok: false, reason: 'no_answer' };
        // D6: a number or a coordinate that contradicts the facts is a memory error, not a writing style
        let complaints = this._auditSummary(text, facts);
        if (complaints.length) {
            try {
                const stricter = prompt + `\n\n【必须修正】你上面的摘要里有与事实不符的数字或坐标：${complaints.join('；')}。请重写，只写与事实一致的内容。`;
                const second = String(await ask(stricter) || '');
                if (second.trim()) { text = second; complaints = this._auditSummary(text, facts); }
            } catch { /* keep the first answer and annotate below */ }
        }
        const correctionLine = complaints.length
            ? `（截至 第${facts?.day ?? this.state.day ?? 1}天 修正：${complaints.join('；')}。以上数字以事实为准。）`
            : null;

        const LABEL_RE = /^\s*(①|②|③|④|「[^」]{1,14}」|【[^】]{1,14}】|关于我自己|今天的日记|日记|教训|长远想做的事|自我认知)\s*[:：]?\s*/;
        const stripLabel = (s) => { let out = String(s); for (let i = 0; i < 3; i++) { const next = out.replace(LABEL_RE, ''); if (next === out) break; out = next; } return out; };
        const sec = MemoryS.splitSections(text, stripLabel);

        // the correction belongs to her self summary, so it cannot be missed by a reader of self.md
        if (correctionLine) sec.self = `${sec.self || ''}\n\n${correctionLine}`.trim();
        if (sec.self) this.setSelf(sec.self);
        if (sec.diary) this.writeStory(sec.diary, now);

        // D1 gap 3: a lesson that blames a mob she never met today gets an annotation, the lesson itself is kept
        const mobNotes = this._mobNotes(`${sec.insights || ''}\n${sec.facts || ''}`, facts);
        const insights = MemoryS.bullets(sec.insights, 3).map((line) => {
            const notes = this._mobNotes(line, facts);
            return notes.length ? `${line}（${notes.join('；')}）` : line;
        });
        if (insights.length) this._writeInsights(day, insights);

        const goals = MemoryS.bullets(sec.goals, 5).map((l) => MemoryS.parseGoal(l));
        let goalsDone = 0;
        if (goals.length) {
            this.setGoals(goals.map((g) => `- ${g.text}${g.status ? `（${g.status}）` : '（未开始）'}`).join('\n'));
            goalsDone = goals.filter((g) => g.status === '做到了').length;
        }

        const promoted = [];
        for (const line of sec.facts.split('\n')) {
            if (/^\s*FACTS\s*[:：]\s*(无|没有|none|nothing)?\s*$/i.test(line)) continue;
            const m = line.match(/^\s*-\s*([^:：]{1,24})[:：]\s*(.{2,})$/) || line.match(/^\s*([^:：]{1,24})[:：]\s*(.{2,})$/);
            if (!m) continue;
            const rawWho = m[1].trim(), rawWhat = m[2].trim();
            // a malformed "speaker" is really the beginning of the sentence: keep the whole line as the fact
            const who = looksLikeSpeaker(rawWho) ? rawWho : 'system';
            const what = looksLikeSpeaker(rawWho) ? rawWhat : `${rawWho}：${rawWhat}`;
            if (/^(FACTS|facts)$/.test(who) || /^(无|没有|none|nothing)$/i.test(what)) continue;
            const notes = this._mobNotes(what, facts);
            const what2 = notes.length ? `${what}（${notes.join('；')}）` : what;
            const row = await this.rememberTaughtAsync({ who, what: what2, at: now, source: 'consolidate' });
            if (row && !row.duplicate) promoted.push(row);
            if (promoted.length >= 5) break;
        }

        // fold the copies this promotion just added (repeat consolidations of the same input must not grow the file)
        const compacted = this.compactTaught();
        this.state.insightsByDay = { ...(this.state.insightsByDay || {}), [day]: insights.length };
        this.state.goalsDoneByDay = { ...(this.state.goalsDoneByDay || {}), [day]: goalsDone };
        this.state.goalsDoneTotal = Object.values(this.state.goalsDoneByDay).reduce((a, b) => a + b, 0);
        this.state.day = day + 1;
        this.state.lastConsolidated = now;
        this._save();
        return { ok: true, day: this.state.day, promoted, insights: insights.length, goals: goals.length, goalsDone, compacted };
    }


    /** When her previous diary was written (0 if none in the last two raw files). */
    _lastStoryAt(now) {
        for (const d of [DAY(now), DAY(now - 86400_000)]) {
            const s = this._readRawDay(d).filter((e) => e.type === 'story' && Number.isFinite(e.at) && e.at < now);
            if (s.length) return s[s.length - 1].at;
        }
        return 0;
    }

    /** Raw events after `since`, across the UTC file boundary (raw files are keyed by UTC date). */
    _rawSince(since, now) {
        return [...new Set([DAY(since), DAY(now)])].flatMap((d) => this._readRawDay(d)).filter((e) => Number.isFinite(e.at) && e.at > since && e.at <= now);
    }

    _readRawDay(day) {
        try {
            return fs.readFileSync(this._p(`raw/${day}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => {
                try { return JSON.parse(l); } catch { return null; }
            }).filter(Boolean);
        } catch { return []; }
    }
}
