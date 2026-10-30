// Taught facts: what a player tells her, kept forever.
// The owner's rule is "主人教的知识永不自动删除", so this store never evicts: no cap, no oldest-dropped, no time decay.
// Only an explicit forget (the owner saying it no longer applies) removes a line, and even then we keep the record of the
// removal so the audit can tell "never knew" from "was told to forget".
import fs from 'fs';
import path from 'path';
import { semanticSame, EmbedCache } from './semantic.js';

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const key = (who, what) => `${norm(who).toLowerCase()}\u0000${norm(what).toLowerCase()}`;


const MODALITY = /(希望|建议|觉得|认为|让我|要我|告诉我|说|可以|应该|别|不要|不用|吧|呢|啊|呀|的|了|着|过|就|都|也|还是|或者|而不是|不是)/g;
/** Strip modality/politeness words so two wordings of one rule collapse to the same skeleton. */
export const canon = (s) => String(s || '')
    .replace(/[\s\p{P}]/gu, '')
    .replace(MODALITY, '');

/** Character-bigram containment: how much of the SHORTER text is present in the longer one (0..1). */
export function containment(a, b) {
    const A = canon(a), B = canon(b);
    if (!A || !B) return 0;
    const big = (x) => { const out = new Set(); for (let i = 0; i < x.length - 1; i++) out.add(x.slice(i, i + 2)); return out; };
    const sa = big(A), sb = big(B);
    let hit = 0;
    for (const g of sa) if (sb.has(g)) hit++;
    return hit / Math.max(Math.min(sa.size, sb.size), 1);
}

/** Do these two statements name different places? If so they are two facts no matter how similar they look. */
export function placeGuardBlocks(a, b) {
    const pa = placesOf(a), pb = placesOf(b);
    return pa.size > 0 && pb.size > 0 && [...pa].every((x) => !pb.has(x));
}

/** Topic signatures for the owner facts that keep being restated. Phrases, not bare characters: "地下" alone appears in mining. */
/** Where a fact is about: two statements about different places are different facts, whatever their topics. */
const PLACES = /(熔炉边|熔炉旁|炉子边|旁边|洞屋|屋里|家里|小屋|村庄|出生点|白桦|箱子边)/g;
const placesOf = (s) => new Set(String(s || '').match(PLACES) || []);

const TOPICS = [
    ['live_up', /(住|盖|建|房子|床|睡)[^。]{0,8}(上面|地面|地上)|(上面|地面|地上)[^。]{0,8}(住|盖|建|睡)/],
    ['jump_place', /跳起来|往脚下放|脚下放方块|垫方块|放方块往[上下]/],
    ['sleep', /睡觉|去睡|歇一歇|睡一觉/],
    ['chest', /箱子/],
    ['food_chest', /面包|铁锭/]
];
export function topicKey(text) {
    const s = String(text || '');
    return new Set(TOPICS.filter(([, re]) => re.test(s)).map(([id]) => id));
}

/** Same speaker + close enough wording = the same fact told again. */
export function sameFact(whoA, whatA, whoB, whatB, threshold = 0.5) {
    if (norm(whoA).toLowerCase() !== norm(whoB).toLowerCase()) return false;
    if (containment(whatA, whatB) >= threshold) return true;
    // same topic is the same fact when every topic in one side is covered by the other
    const A = topicKey(whatA), B = topicKey(whatB);
    if (!A.size || !B.size) return false;
    const covered = (small, big) => [...small].every((x) => big.has(x));
    if (!(covered(A, B) || covered(B, A))) return false;
    // ...unless they talk about different places: same topic, different place, different fact
    if (placeGuardBlocks(whatA, whatB)) return false;
    return true;
}

/**
 * The production merge rule for the semantic path, as a pure function so it can be tested with recorded cosines:
 * a high enough cosine merges, unless the two statements name different places.
 */
export function mergeByCosine(cosine, a, b, threshold = 0.64) {
    if (!(cosine >= threshold)) return false;
    return !placeGuardBlocks(a, b);
}

export class TaughtStore {
    constructor(file) {
        this.file = file;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        this.rows = this._load();
        // replay in order: an explicit forget removes a key, a merge removes the row it folded, everything else sets/overwrites
        this.byKey = new Map();
        for (const r of this.rows) {
            if (r._mergeMarker && r.mergedOut) { this.byKey.delete(key(r.mergedOut.who, r.mergedOut.what)); continue; }
            if (r._mergeMarker) continue;                                  // legacy marker without a target: ignore, do not delete
            if (r.forgotten) { this.byKey.delete(key(r.who, r.what)); continue; }
            this.byKey.set(key(r.who, r.what), r);
        }
    }

    _load() {
        try {
            return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => {
                try { return JSON.parse(l); } catch { return null; }
            }).filter(Boolean);
        } catch { return []; }
    }

    /**
     * Collapse repeated identical rows on disk. The append-only design writes the whole survivor whenever it is merged,
     * so the same fact accumulates one line per restatement. This keeps the NEWEST line (it carries seen/paraphrases) and
     * replaces the older copies with a single aggregate marker: nothing is deleted silently, the file stops growing.
     * Returns { before, after, folded }.
     */
    compact() {
        const rows = this._load();
        const liveIdx = new Map();
        rows.forEach((r, i) => {
            if (!r || r._mergeMarker || r._duplicateMarker || r.forgotten) return;
            const k = key(r.who, r.what);
            if (!liveIdx.has(k)) liveIdx.set(k, []);
            liveIdx.get(k).push(i);
        });

        const drop = new Set();
        const rewrite = new Map();
        let folded = 0;
        for (const [, idxs] of liveIdx) {
            if (idxs.length < 2) continue;
            const keepAt = idxs[idxs.length - 1];
            const first = rows[idxs[0]];
            const last = rows[keepAt];
            for (const i of idxs) if (i !== keepAt) drop.add(i);
            rewrite.set(keepAt, {
                ...last,
                foldedCopies: (last.foldedCopies || 0) + (idxs.length - 1),
                foldedFrom: last.foldedFrom || first.at || null,
                foldedAt: Date.now()
            });
            folded += idxs.length - 1;
        }
        if (!folded) return { before: rows.length, after: rows.length, folded: 0, wrote: false };

        const next = [];
        rows.forEach((r, i) => {
            if (drop.has(i)) return;
            next.push(rewrite.get(i) || r);
        });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, next.map((r) => JSON.stringify(r)).join('\n') + '\n');
        fs.renameSync(tmp, this.file);
        this.rows = this._load();
        return { before: rows.length, after: next.length, folded, wrote: true };
    }

    /** How many disk lines are superseded copies of a live fact (0 means the file is already compact). */
    duplication() {
        const rows = this._load();
        const per = new Map();
        for (const r of rows) {
            if (!r || r._mergeMarker || r._paraphraseMarker || r._duplicateMarker || r.forgotten) continue;
            const k = key(r.who, r.what);
            per.set(k, (per.get(k) || 0) + 1);
        }
        let extra = 0;
        for (const n of per.values()) extra += Math.max(0, n - 1);
        return { lines: rows.length, extraCopies: extra, facts: per.size };
    }

    _append(row) {
        fs.appendFileSync(this.file, `${JSON.stringify(row)}\n`);
        this.rows.push(row);
    }

    /**
     * Idempotent, in two steps: an exact who+what keeps the first line; a PARAPHRASE of an existing fact from the same
     * speaker updates that row instead of appending a twin. Owner facts are never deleted and the new wording is kept.
     */
    remember({ who, what, at = Date.now(), source = 'player', threshold = 0.62 } = {}) {
        const w = norm(who), f = norm(what);
        if (!f) return null;
        const existing = this.byKey.get(key(w, f));
        if (existing) return { ...existing, duplicate: true };

        const near = [...this.byKey.values()].find((r) => sameFact(r.who, r.what, w, f, threshold));
        if (near) {
            near.seen = (near.seen || 1) + 1;
            near.lastSeenAt = at;
            if (!near.paraphrases) near.paraphrases = [];
            if (!near.paraphrases.includes(f) && f !== near.what) near.paraphrases.push(f);
            this._append({ ...near, _paraphraseMarker: true });   // append the updated row so the file stays append-only
            return { ...near, duplicate: true, merged: true };
        }

        const row = { who: w || 'someone', what: f, at, source, seen: 1 };
        this._append(row);
        this.byKey.set(key(w, f), row);
        return row;
    }

    /**
     * Async variant for the dawn: try the embedder first, then fall back to the offline rules. Same guarantees as
     * remember(): never delete, keep the first timestamp, record the new wording in paraphrases.
     */
    async rememberSemantic({ who, what, at = Date.now(), source = 'player', embed = null, threshold = null, cache = null } = {}) {
        const w = norm(who), f = norm(what);
        if (!f) return null;
        const exact = this.byKey.get(key(w, f));
        if (exact) return { ...exact, duplicate: true };

        const candidates = [...this.byKey.values()].filter((r) => norm(r.who).toLowerCase() === w.toLowerCase());
        let near = null;
        if (typeof embed === 'function') {
            for (const c of candidates) {
                const res = await semanticSame({ embed, a: c.what, b: f, ...(threshold ? { threshold: Math.min(threshold, 0.999) } : {}), cache });
                if (!res) continue;
                if (!mergeByCosine(res.cosine, c.what, f, threshold || undefined)) continue;
                near = c;
                break;
            }
        }
        if (!near) near = candidates.find((r) => sameFact(r.who, r.what, w, f)) || null;
        if (near) {
            near.seen = (near.seen || 1) + 1;
            near.lastSeenAt = at;
            if (!near.paraphrases) near.paraphrases = [];
            if (!near.paraphrases.includes(f) && f !== near.what) near.paraphrases.push(f);
            this._append({ ...near, _paraphraseMarker: true });
            return { ...near, duplicate: true, merged: true };
        }

        const row = { who: w || 'someone', what: f, at, source, seen: 1 };
        this._append(row);
        this.byKey.set(key(w, f), row);
        return row;
    }

    /** One-off pass over the existing rows: merge twins already on disk. Returns how many were folded. */
    dedupeExisting(threshold = 0.62) {
        let folded = 0;
        const keep = [];
        for (const row of [...this.byKey.values()].sort((a, b) => a.at - b.at)) {
            const twin = keep.find((k) => sameFact(k.who, k.what, row.who, row.what, threshold));
            if (!twin) { keep.push(row); continue; }
            twin.seen = (twin.seen || 1) + 1;
            twin.lastSeenAt = row.at;
            if (!twin.paraphrases) twin.paraphrases = [];
            if (!twin.paraphrases.includes(row.what)) twin.paraphrases.push(row.what);
            row.forgotten = true;
            row.forgottenAt = Date.now();
            row.mergedInto = { who: twin.who, what: twin.what, at: twin.at };
            this.byKey.delete(key(row.who, row.what));
            this._append({ _mergeMarker: true, mergedOut: { who: row.who, what: row.what }, into: { who: twin.who, what: twin.what, at: twin.at }, at: Date.now() });
            this._append({ ...twin });   // re-append the updated twin so seen/paraphrases survive a reload (later line wins)
            folded++;
        }
        return folded;
    }

    /** Explicit only. Returns the number forgotten; the row stays in the file with forgotten:true. */
    forget(match) {
        const m = norm(match).toLowerCase();
        if (!m) return 0;
        let n = 0;
        for (const row of this.rows) {
            if (row.forgotten) continue;
            if (`${row.who} ${row.what}`.toLowerCase().includes(m)) {
                row.forgotten = true;
                row.forgottenAt = Date.now();
                this._append({ ...row, _forgetMarker: true });
                this.byKey.delete(key(row.who, row.what));
                n++;
            }
        }
        return n;
    }

    /** Live facts, newest first. */
    all() {
        return [...this.byKey.values()].sort((a, b) => b.at - a.at);
    }

    get size() { return this.byKey.size; }
    get everRecorded() { return this.rows.filter((r) => !r._forgetMarker).length; }
}
