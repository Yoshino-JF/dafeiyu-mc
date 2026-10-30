// World-scoped memory (D1, #3265/#3268/#3269).
//
// The owner's rule, in his words: when she enters a new world she decides what to keep; the system only suggests and
// records where each item came from; nothing is ever deleted; old-world items are marked as such.
//
// Layout:
//   memory/                     global  (self, lessons, heard, raw, story, state, modes)
//   memory/worlds/<key>/        one folder per world (taught rows, places, goals, promises)
//
// The hard rule this file exists for: rows reference each other (a merge marker names the row it folded). Moving one
// without the other resurrects a deleted fact or loses a live one, silently. So rows move in connected components.
import fs from 'fs';
import path from 'path';

export const WORLD_FILES = ['taught.jsonl', 'places.md', 'goals.md', 'promises.jsonl'];

/** A key must be safe as a folder name and still be readable. */
export function sanitizeKey(key) {
    // Windows forbids < > : " / \ | ? * in names, and the fallback for an empty key must still be usable
    const s = String(key || '').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/^[\. ]+|[\. ]+$/g, '').slice(0, 80);
    return s || 'unknown-world';
}

const COORDS = /\(?\s*-?\d{1,5}\s*[,，]\s*-?\d{1,3}\s*[,，]\s*-?\d{1,5}\s*\)?/;
const PLACE_WORDS = /(出生点|洞屋|小屋|新家|家[^人]|屋里|门口|箱子|熔炉|村|白桦林|矿洞|山上|岸边|水边|坐标)/;

/**
 * Is this taught row tied to a particular world? Coordinates, a place as the speaker, or chest/house wording all bind
 * it. Owner facts without coordinates stay global, which is exactly the owner's split.
 */
export function classifyTaughtRow(row) {
    if (!row) return 'global';
    if (row._mergeMarker || row._paraphraseMarker) return 'marker';
    const who = String(row.who || '');
    const what = String(row.what || '');
    if (who !== 'JFors' && PLACE_WORDS.test(who)) return 'world';
    if (COORDS.test(what)) return 'world';
    if (PLACE_WORDS.test(what) && !/^(系统|system)$/i.test(who)) return 'world';
    return 'global';
}

/** Rows are grouped when one references another: a marker must travel with the row it folded. */
export function rowGroups(rows) {
    const keyOf = (w, t) => `${String(w || '').toLowerCase()}\u0000${String(t || '').toLowerCase()}`;
    const index = new Map();
    rows.forEach((r, i) => { if (r && !r._mergeMarker && !r._paraphraseMarker) index.set(keyOf(r.who, r.what), i); });
    const parent = rows.map((_, i) => i);
    const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

    rows.forEach((r, i) => {
        if (!r) return;
        // a merge marker folds another row into a survivor: all three belong together
        if (r._mergeMarker && r.mergedOut) {
            const t = index.get(keyOf(r.mergedOut.who, r.mergedOut.what));
            if (t !== undefined) union(i, t);
            if (r.into) { const s = index.get(keyOf(r.into.who, r.into.what)); if (s !== undefined) union(i, s); }
        }
        if (Array.isArray(r.mergedFrom)) {
            for (const m of r.mergedFrom) {
                const t = index.get(keyOf(m.who, m.what));
                if (t !== undefined) union(i, t);
            }
        }
    });
    const groups = new Map();
    rows.forEach((_, i) => { const g = find(i); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(i); });
    return [...groups.values()];
}

const readJsonl = (p) => {
    try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
};
const writeJsonl = (p, rows) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')); };

export class WorldStore {
    constructor(dir, { now = () => Date.now() } = {}) {
        this.dir = dir;                       // memory/
        this.now = now;
        // NOT memory/state.json: MemoryS owns that file and rewrites it wholesale from RAM (#3289)
        this.statePath = path.join(dir, 'worlds', 'state.json');
        this.sharedStatePath = path.join(dir, 'state.json');
    }

    _state() {
        try { return JSON.parse(fs.readFileSync(this.statePath, 'utf8')); } catch { /* fall through to migration */ }
        // one-time migration: an older build kept the world record inside MemoryS's state file
        try {
            const shared = JSON.parse(fs.readFileSync(this.sharedStatePath, 'utf8'));
            if (shared.world) return { world: shared.world };
        } catch { /* nothing to migrate */ }
        return {};
    }

    _writeState(st) {
        fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
        const tmp = `${this.statePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
        fs.renameSync(tmp, this.statePath);
    }

    worldDir(key) { return path.join(this.dir, 'worlds', sanitizeKey(key)); }

    /** Record the raw key and its parts next to the archive, so a sanitized folder name stays identifiable. */
    _stampWorld(key, parts) {
        const dir = this.worldDir(key);
        fs.mkdirSync(dir, { recursive: true });
        const p = path.join(dir, 'world.json');
        if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify({ key, parts: parts || {}, at: this.now() }, null, 2));
    }

    current() {
        const w = this._state().world;
        return w ? { key: w.key, parts: w.parts || {}, since: w.since, worldCount: w.worldCount || 1, pendingTriage: !!w.pendingTriage } : null;
    }

    /**
     * Register the world. Idempotent for the same key. A different key is a confirmed switch: archive the previous
     * world's bound rows, load the target world back, bump the counter. Everything is written to a temp folder first and
     * only renamed into place when complete, so a failure leaves the previous state intact rather than half of both.
     */
    setWorld(key, parts = {}) {
        const k = String(key || '').trim();
        if (!k) return { key: null, changed: false, reason: 'empty key' };
        const st = this._state();
        const prev = st.world || null;
        const now = this.now();

        if (prev && prev.key === k) {
            // same world: only refresh the parts we may have learned later (seed after the login packet, for instance)
            prev.parts = { ...(prev.parts || {}), ...parts };
            this._writeState(st);
            return { key: k, changed: false, previous: k, archived: 0, restored: 0, pendingTriage: !!prev.pendingTriage, worldCount: prev.worldCount || 1 };
        }

        let archived = 0, restored = 0, error = null;
        try {
            this._stampWorld(k, parts);
            // nothing is moved here: she decides. A switch loads her archive for this world and marks what came from the
            // one she left, so triage can offer it and any archive routes it back to the right folder.
            if (prev) {
                this._stampWorld(prev.key, prev.parts || {});
                this._stampLegacyRows(prev.key);
                this.stampLegacyPlaces(prev.key);
            }
            restored = this._loadFromArchive(k);
            st.world = {
                key: k,
                parts: { ...parts },
                since: now,
                worldCount: (prev?.worldCount || 0) + 1,
                pendingTriage: false,
                history: [...(prev?.history || []), { at: now, from: prev?.key || null, to: k, parts }]
            };
            // anything still visible that belongs to another world is what she may want to archive
            st.world.pendingTriage = this._foreignRows(k).length > 0;
            this._writeState(st);
        } catch (e) {
            error = e.message || String(e);
            if (prev) st.world = prev;           // roll back to the previous world record
            this._writeState(st);
        }
        return { key: k, changed: !error, previous: prev?.key || null, archived, restored, pendingTriage: !!st.world?.pendingTriage, worldCount: st.world?.worldCount || 1, error };
    }

    /** Not used by setWorld: kept for an explicit bulk archive the owner might ask for later. Moves components whole. */
    _archiveWorldBound(fromKey) {
        const p = path.join(this.dir, 'taught.jsonl');
        const rows = readJsonl(p);
        const groups = rowGroups(rows);
        const toMove = [];
        for (const g of groups) {
            const bound = g.some((i) => classifyTaughtRow(rows[i]) === 'world');
            if (!bound) continue;
            // never move a component that carries global content: keep it where it is and let her triage handle it
            toMove.push(...g);
        }
        if (!toMove.length) return 0;
        const set = new Set(toMove);
        const moved = rows.filter((_, i) => set.has(i)).map((r) => ({ ...r, world: r.world || fromKey, legacy: r.world ? r.legacy : true }));
        const kept = rows.filter((_, i) => !set.has(i));
        const target = path.join(this.worldDir(fromKey), 'taught.jsonl');
        writeJsonl(target, [...readJsonl(target), ...moved]);
        writeJsonl(p, kept);
        return moved.length;
    }

    /** Bring the target world's archived rows back into the live files. */
    _loadFromArchive(key) {
        const src = this.worldDir(key);
        if (!fs.existsSync(src)) return 0;
        let n = 0;
        // the place stamp sidecar is not a WORLD_FILE, but a loaded place needs its world back
        {
            const from = path.join(src, 'places.jsonl');
            if (fs.existsSync(from)) {
                const incoming = readJsonl(from).filter((r) => r.archivedInWorld === undefined || r.archivedInWorld !== key);
                if (incoming.length) {
                    const existing = this._placeRows();
                    const names = new Set(existing.map((r) => r.name));
                    const add = incoming.filter((r) => !names.has(r.name)).map((r) => this._asRestored(r, key));
                    if (add.length) this._writePlaceRows([...existing, ...add]);
                    n += add.length;
                }
                fs.unlinkSync(from);
            }
        }
        for (const file of WORLD_FILES) {
            const from = path.join(src, file);
            if (!fs.existsSync(from)) continue;
            const live = path.join(this.dir, file);
            if (file.endsWith('.jsonl')) {
                // only rows she put away while standing in ANOTHER world come back by themselves; rows she hid while
                // inside this very world stay hidden until she asks for them
                const incoming = readJsonl(from)
                    .filter((r) => r.archivedInWorld === undefined || r.archivedInWorld !== key)
                    .map((r) => ({ ...this._asRestored(r, key), world: r.world || key }));
                if (!incoming.length) continue;
                const existing = readJsonl(live);
                const keyOf = (r) => `${String(r.who || '').toLowerCase()}\u0000${String(r.what || r.text || '').toLowerCase()}`;
                const have = new Set(existing.map(keyOf));
                const add = incoming.filter((r) => !have.has(keyOf(r)));
                writeJsonl(live, [...existing, ...add]);
                n += add.length;
                fs.unlinkSync(from);
            } else {
                // merge line by line: a blind append onto a file without a trailing newline glued two places together
                const text = fs.readFileSync(from, 'utf8');
                const added = this._appendLines(live, text.split('\n').filter(Boolean));
                n += added;
                fs.unlinkSync(from);
                continue;
                fs.unlinkSync(from);
                n += text.split('\n').filter(Boolean).length;
            }
        }
        return n;
    }

    // ── places (D1 gap #3293) ─────────────────────────────────────────────────────────────────────────────
    _placeFile() { return path.join(this.dir, 'places.jsonl'); }

    _placeRows() {
        try { return fs.readFileSync(this._placeFile(), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
    }

    /** Mark a row as restored and demote its archive bookkeeping to archivedThen. */
    _asRestored(r, fromWorld) {
        const { archivedBy, archivedAt, archiveReason, archivedInWorld, ...rest } = r;
        const out = { ...rest, restoredFrom: r.world || fromWorld || null, restoredAt: this.now() };
        if (archivedBy || archivedAt || archiveReason || archivedInWorld) {
            out.archivedThen = { by: archivedBy || null, at: archivedAt || null, reason: archiveReason || null, inWorld: archivedInWorld || null };
        }
        return out;
    }

    /** Append lines to a markdown file without ever gluing them onto a last line that lacked a newline. */
    _appendLines(file, lines) {
        const want = lines.filter(Boolean);
        if (!want.length) return 0;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        let text = '';
        try { text = fs.readFileSync(file, 'utf8'); } catch { text = ''; }
        const have = new Set(text.split('\n').map((l) => l.trim()).filter(Boolean));
        const add = want.filter((l) => !have.has(l.trim()));
        if (!add.length) return 0;
        const head = text && !text.endsWith('\n') ? text + '\n' : text;
        fs.writeFileSync(file, head + add.join('\n') + '\n');
        return add.length;
    }

    _writePlaceRowsAt(file, rows) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    }

    _writePlaceRows(rows) {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(this._placeFile(), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    }

    /** Places saved before this feature have no stamp: give them the world she is leaving. */
    stampLegacyPlaces(prevKey) {
        const names = fs.existsSync(path.join(this.dir, 'places.md'))
            ? fs.readFileSync(path.join(this.dir, 'places.md'), 'utf8').split('\n').filter((l) => l.startsWith('- ')).map((l) => (l.match(/^- (.+?) ：/) || [])[1]).filter(Boolean)
            : [];
        const rows = this._placeRows();
        let n = 0;
        for (const name of names) {
            if (rows.some((r) => r.name === name)) continue;
            rows.push({ name, world: prevKey, at: this.now(), legacy: true });
            n++;
        }
        if (n) this._writePlaceRows(rows);
        return n;
    }

    /** Goals set in another world, as batch items. */
    _goalsRows() {
        try { return fs.readFileSync(path.join(this.dir, 'goals.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
    }

    _writeGoalsRows(rows) {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(path.join(this.dir, 'goals.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    }

    _foreignGoals(currentKey) {
        let rows = [];
        try { rows = fs.readFileSync(path.join(this.dir, 'goals.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { rows = []; }
        return rows.filter((r) => r.world && r.world !== currentKey);
    }

    /** Foreign places, as batch items. */
    _foreignPlaces(currentKey) {
        return this._placeRows().filter((r) => r.world && r.world !== currentKey);
    }

    /** Give unstamped, world-bound rows the key of the world they were written in (called once per switch). */
    _stampLegacyRows(prevKey) {
        const p = path.join(this.dir, 'taught.jsonl');
        const rows = readJsonl(p);
        let n = 0;
        for (const r of rows) {
            if (r._mergeMarker || r._paraphraseMarker) continue;
            if (r.world) continue;
            if (classifyTaughtRow(r) !== 'world') continue;      // owner preferences stay global on purpose
            r.world = prevKey;
            r.legacy = true;
            n++;
        }
        if (n) writeJsonl(p, rows);
        return n;
    }

    /** Rows currently visible that are stamped with a different world. */
    _foreignRows(currentKey) {
        return readJsonl(path.join(this.dir, 'taught.jsonl')).filter((r) => r.world && r.world !== currentKey && !r._mergeMarker);
    }

    /**
     * May the triage block be shown right now? At most `max` times per world-day, and only when it is safe. Her explicit
     * !showMemories query is not an offer and is not counted.
     */
    triageOffer(dayKey, { safe = true, max = 3, minGapMs = 10 * 60 * 1000 } = {}) {
        const st = this._state();
        const used = st.world?.triage?.[dayKey] || 0;
        const lastAt = st.world?.triageLastAt || 0;
        const foreign = this._foreignRows(st.world?.key).length;
        if (!foreign) return { allowed: false, reason: 'nothing-foreign', used, day: dayKey };
        if (!safe) return { allowed: false, reason: 'unsafe', used, day: dayKey };
        if (used >= max) return { allowed: false, reason: 'daily-cap', used, day: dayKey };
        // a burst of offers in one turn was the reported bug: one per ten minutes at most
        if (minGapMs > 0 && lastAt && this.now() - lastAt < minGapMs) {
            return { allowed: false, reason: 'too-soon', used, day: dayKey, waitMs: minGapMs - (this.now() - lastAt) };
        }
        return { allowed: true, used, day: dayKey, max, minGapMs };
    }

    /** Count one offer (one appearance in one prompt). */
    noteTriageOffered(dayKey) {
        const st = this._state();
        if (!st.world) return { used: 0 };
        st.world.triage = st.world.triage || {};
        st.world.triage[dayKey] = (st.world.triage[dayKey] || 0) + 1;
        st.world.triageLastAt = this.now();
        // keep the map small: one world-day key per day, and only the last 30
        const keys = Object.keys(st.world.triage);
        if (keys.length > 30) for (const k of keys.slice(0, keys.length - 30)) delete st.world.triage[k];
        this._writeState(st);
        return { used: st.world.triage[dayKey] };
    }

    /** Up to n batches of rows she may want to archive; ≤8 items each; the caller enforces the daily cap. */
    showBatch(n = 1, { perBatch = 8 } = {}) {
        const cur = this.current();
        const foreign = [
            ...this._foreignPlaces(cur?.key).map((p) => ({ kind: 'place', who: p.name, text: p.name, world: p.world, worldBound: true })),
            ...this._foreignGoals(cur?.key).map((g) => ({ kind: 'goal', who: '目标', text: g.goal, world: g.world, worldBound: true })),
            ...this._foreignRows(cur?.key).map((r) => ({ kind: 'taught', who: r.who, text: r.what, world: r.world, worldBound: classifyTaughtRow(r) === 'world' }))
        ];
        const start = Math.max(0, (n - 1)) * perBatch;
        const items = foreign.slice(start, start + perBatch).map((r) => ({ id: null, ...r }));
        return {
            index: n, total: Math.max(1, Math.ceil(foreign.length / perBatch)),
            items, hasMore: start + perBatch < foreign.length, remaining: foreign.length
        };
    }

    /** She decides: move matching rows into their own world's archive. Preview first when many match. */
    archive(match, { confirm = false, reason = '', by = 'her' } = {}) {
        const m = String(match || '').trim();
        if (!m) return { ok: false, matched: 0, reason: 'empty match' };
        const p = path.join(this.dir, 'taught.jsonl');
        const rows = readJsonl(p);
        const hits = rows.map((r, i) => ({ r, i })).filter(({ r }) => !r._mergeMarker && String(r.what || '').includes(m));
        // places are archivable too: she may put a stale place away just like a fact
        const placeHits = this._placeRows().filter((pl) => String(pl.name || '').includes(m));
        const goalHits = this._foreignGoals(this.current()?.key).filter((g) => String(g.goal || '').includes(m));
        if (!hits.length && !placeHits.length && goalHits.length) {
            if (goalHits.length > 3 && !confirm) return { ok: false, matched: goalHits.length, needConfirm: true, preview: goalHits.slice(0, 3).map((g) => ({ who: '目标', text: g.goal })) };
            const cur = this.current()?.key || 'unknown-world';
            const md = path.join(this.dir, 'goals.md');
            const text = fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '';
            const lines = text.split('\n');
            const archived = [];
            for (const g of goalHits) {
                const idx = lines.findIndex((l) => l.includes(g.goal));
                if (idx >= 0) { archived.push(lines[idx]); lines.splice(idx, 1); }
            }
            fs.writeFileSync(md, lines.filter(Boolean).join('\n') + (lines.filter(Boolean).length ? '\n' : ''));
            const targetDir = this.worldDir(goalHits[0].world || cur);
            this._appendLines(path.join(targetDir, 'goals.md'), archived);
            const rows = this._goalsRows().filter((g) => !goalHits.some((h) => h.goal === g.goal));
            this._writeGoalsRows([...rows, ...goalHits.map((g) => ({ ...g, archivedInWorld: cur, archivedBy: by, archivedAt: this.now() }))]);
            return { ok: true, matched: goalHits.length, moved: archived.length, archiveDir: targetDir };
        }
        if (!hits.length && placeHits.length) {
            if (placeHits.length > 3 && !confirm) return { ok: false, matched: placeHits.length, needConfirm: true, preview: placeHits.slice(0, 3).map((pl) => ({ who: '地点', text: pl.name })) };
            const cur = this.current()?.key || 'unknown-world';
            const mdPath = path.join(this.dir, 'places.md');
            const mdText = (() => { try { return fs.readFileSync(mdPath, 'utf8'); } catch { return ''; } })();
            const coordsOf = (name) => {
                const line = mdText.split('\n').find((l) => l.includes(`- ${name} ：`));
                const m = line && line.match(/\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/);
                return m ? { x: +m[1], y: +m[2], z: +m[3] } : {};
            };
            const moved = [];
            for (const pl of placeHits) {
                const world = pl.world || cur;
                const targetDir = this.worldDir(world);
                fs.mkdirSync(targetDir, { recursive: true });
                const targetPlaces = path.join(targetDir, 'places.jsonl');
                const existing = (() => { try { return fs.readFileSync(targetPlaces, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
                existing.push({ ...coordsOf(pl.name), ...pl, world, archivedInWorld: cur, archivedBy: by, archivedAt: this.now(), archiveReason: String(reason).slice(0, 120) });
                fs.writeFileSync(targetPlaces, existing.map((x) => JSON.stringify(x)).join('\n') + '\n');
                // keep the readable line in the archive: without it a later return has nothing to put back
                const md = path.join(this.dir, 'places.md');
                const liveText = fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '';
                const archivedLine = liveText.split('\n').find((l) => l.includes(`- ${pl.name} ：`));
                if (archivedLine) this._appendLines(path.join(this.worldDir(world), 'places.md'), [archivedLine]);
                if (fs.existsSync(md)) fs.writeFileSync(md, liveText.split('\n').filter((l) => !l.includes(`- ${pl.name} ：`)).join('\n'));
                moved.push(pl.name);
            }
            this._writePlaceRows(this._placeRows().filter((pl) => !placeHits.some((h) => h.name === pl.name)));
            return { ok: true, matched: placeHits.length, moved: moved.length, archiveDir: this.worldDir(placeHits[0].world || cur) };
        }
        if (!hits.length) return { ok: false, matched: 0, preview: [] };
        if (hits.length > 3 && !confirm) {
            return { ok: false, matched: hits.length, needConfirm: true, preview: hits.slice(0, 3).map(({ r }) => ({ who: r.who, text: r.what })) };
        }
        // move whole components so markers never separate from their target
        const groups = rowGroups(rows);
        const hitSet = new Set(hits.map((h) => h.i));
        const movedIdx = new Set();
        for (const g of groups) if (g.some((i) => hitSet.has(i))) g.forEach((i) => movedIdx.add(i));
        const moved = rows.filter((_, i) => movedIdx.has(i)).map((r) => {
            const world = r.world || this.current()?.key || 'unknown-world';
            return { ...r, world, archivedInWorld: this.current()?.key || world, archivedBy: by, archivedAt: this.now(), archiveReason: String(reason).slice(0, 120) };
        });
        const byWorld = new Map();
        for (const r of moved) { if (!byWorld.has(r.world)) byWorld.set(r.world, []); byWorld.get(r.world).push(r); }
        for (const [world, list] of byWorld) {
            const target = path.join(this.worldDir(world), 'taught.jsonl');
            writeJsonl(target, [...readJsonl(target), ...list]);
        }
        writeJsonl(p, rows.filter((_, i) => !movedIdx.has(i)));
        const st = this._state();
        if (st.world) { st.world.pendingTriage = this._foreignRows(st.world.key).length > 0; this._writeState(st); }
        return { ok: true, matched: hits.length, moved: moved.length, archiveDir: this.worldDir(moved[0].world) };
    }

    /** Bring rows back out of an archive (still never deleting anything). */
    restore(match, { confirm = false } = {}) {
        const m = String(match || '').trim();
        if (!m) return { ok: false, matched: 0, reason: 'empty match' };
        const root = path.join(this.dir, 'worlds');
        if (!fs.existsSync(root)) return { ok: false, matched: 0, restored: 0, from: [] };
        const worlds = fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory());

        const hits = [];
        for (const w of worlds) {
            for (const r of readJsonl(path.join(root, w, 'taught.jsonl'))) {
                if (String(r.what || '').includes(m)) hits.push({ world: w, row: r });
            }
            for (const r of readJsonl(path.join(root, w, 'places.jsonl'))) {
                if (String(r.name || '').includes(m)) hits.push({ world: w, row: r, place: true });
            }
        }
        if (!hits.length) return { ok: false, matched: 0, restored: 0, from: [] };
        if (hits.length > 3 && !confirm) {
            return { ok: false, matched: hits.length, needConfirm: true, preview: hits.slice(0, 3).map((h) => ({ world: h.world, who: h.place ? '地点' : h.row.who, text: h.place ? h.row.name : h.row.what })) };
        }

        const facts = hits.filter((h) => !h.place);
        const places = hits.filter((h) => h.place);
        let restoredFacts = 0;
        let restoredPlaces = 0;

        // facts: back into taught.jsonl, removed from the archive by exactly the identity that was written
        if (facts.length) {
            const liveFacts = path.join(this.dir, 'taught.jsonl');
            const rows = readJsonl(liveFacts);
            const keyOf = (r) => `${String(r.who || '').toLowerCase()}\u0000${String(r.what || '').toLowerCase()}`;
            const have = new Set(rows.map(keyOf));
            const add = facts.filter((h) => !have.has(keyOf(h.row))).map((h) => this._asRestored(h.row, h.world));
            writeJsonl(liveFacts, [...rows, ...add]);
            restoredFacts = add.length;
            const restoredKeys = new Set(facts.map((h) => `${h.world}\u0000${keyOf(h.row)}`));
            for (const w of new Set(facts.map((h) => h.world))) {
                const p = path.join(root, w, 'taught.jsonl');
                writeJsonl(p, readJsonl(p).filter((r) => !restoredKeys.has(`${w}\u0000${keyOf(r)}`)));
            }
        }

        // places: back into places.md (the readable list she actually reads) and into the sidecar, out of the archive
        if (places.length) {
            const md = path.join(this.dir, 'places.md');
            let text = (() => { try { return fs.readFileSync(md, 'utf8'); } catch { return ''; } })();
            const sidecar = this._placeRows();
            for (const h of places) {
                const r = h.row;
                const line = `- ${r.name} ： (${Math.round(r.x)}, ${Math.round(r.y)}, ${Math.round(r.z)})`;
                if (!text.includes(`- ${r.name} ：`)) text = [line, ...text.split('\n').filter(Boolean)].join('\n') + '\n';
                if (!sidecar.some((s) => s.name === r.name)) {
                    sidecar.push({ ...this._asRestored(r, h.world), name: r.name, world: r.world || h.world, at: r.at || this.now() });
                    restoredPlaces++;
                }
            }
            fs.mkdirSync(path.dirname(md), { recursive: true });
            fs.writeFileSync(md, text);
            this._writePlaceRows(sidecar);
            for (const w of new Set(places.map((h) => h.world))) {
                const p = path.join(root, w, 'places.jsonl');
                const names = new Set(places.filter((h) => h.world === w).map((h) => h.row.name));
                this._writePlaceRowsAt(p, readJsonl(p).filter((r) => !names.has(r.name)));
            }
        }

        return { ok: true, matched: hits.length, restored: restoredFacts + restoredPlaces, restoredFacts, restoredPlaces, from: [...new Set(hits.map((h) => h.world))] };
    }
}
