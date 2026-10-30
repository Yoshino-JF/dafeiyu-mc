// Open promises: things she told the owner she would do (#3132).
//
// The gap this closes (PLAN C, GPT #3131): she accepted the owner's chest request, got interrupted (full bag, low
// health, eating), then went back to her own task - neither resuming nor saying anything. An accepted request was
// stored nowhere, so one interruption chain erased it.
//
// Design rules, all conservative on purpose:
//   * only the REAL owner arms a promise (test bots are ignored; a missed record beats a fake one)
//   * only an explicit acceptance in HER reply records it (行/好/马上/这就/我去/没问题...) - we never guess completion
//   * she closes it herself with !promiseDone / !promiseDrop
//   * 30 minutes with no closing closes it as expired, with a note, so the list cannot fill with stale wishes
//   * append-only JSONL: history is never rewritten, the live list is a replay
import fs from 'fs';
import path from 'path';

export const PROMISE_TTL_MS = 30 * 60_000;

/** Does her reply accept the request? Conservative: a clear yes at the start, in her own voice. */
export const ACCEPT_RE = /^\s*(行|好|好的|好嘞|好啊|可以|没问题|马上|这就|我去|我这就|收到|知道了|马上就去|这就去|我去看看|这就去办|当然)/;

/** Bots that exist to exercise the harness: their messages never arm a promise. */
const TEST_BOT = /^(HouseTest|FactsTest|JumpTest|Scanner|SkinCheck|PillarTest|CaveTest|SkinCheckBot|FakeOwner|ArenaHost)$/i;

export const isTestBot = (who) => TEST_BOT.test(String(who || '').trim());

// A one-off request is ADDRESSED to her AND concrete (a count, a coordinate, or a place), and carries no long-term
// marker. Requiring the addressing part is what keeps a plain fact ("钻石藏在…") and a preference ("我觉得应该住在上面")
// out of this rule; requiring concreteness keeps a technique ("跳起来往脚下放方块") out of it too.
const ADDRESSED = /(帮我|请帮我|请你|给我|要我去|让我去|替我|麻烦你|去帮我|给我拿|给我带)/;
const CONCRETE = /([0-9]+|[一二三四五六七八九十两几])\s*(块|个|根|张|组|桶|把|件|只|份)|-?\d+\s*[，,]\s*-?\d+\s*[，,]\s*-?\d+|出生点|屋里|家里|门口|他那儿|我这儿|坐标|村口/;
const LONG_TERM = /(以后|每天|每次|总是|一直|记住|别忘了|下次|常常|长期|永久|每次都要)/;
const WANTS_COUNT = /(要|需要|想要|给我)\s*([0-9]+|[一二三四五六七八九十两几])\s*(块|个|根|张|组|桶|把|件|只|份)/;

/** Ways the owner is addressed in her own words. Any of these means the same person, or the counts and scrubs split. */
export const OWNER_ALIAS = /^(老大|主人|老板|老爷|主人大人|主上|boss)$/i;

/** Normalize a speaker to the configured owner name, so one person cannot appear as two. */
export function normalizeOwner(who, ownerName = 'JFors') {
    const s = String(who || '').trim();
    if (!s) return s;
    return OWNER_ALIAS.test(s) ? ownerName : s;
}

/** True for a concrete one-off request the owner (or a stand-in) wants done now: it belongs in promises, not in facts. */
export function isOneOffRequest(text) {
    const s = String(text || '');
    if (!s.trim()) return false;
    if (LONG_TERM.test(s)) return false;          // "以后每天…" is a standing rule, keep it
    // either she is being addressed with something concrete, or the owner states a concrete want ("要四块白桦木板")
    if (ADDRESSED.test(s) && CONCRETE.test(s)) return true;
    return WANTS_COUNT.test(s);
}

// ── nudge: does the promise look done? ──────────────────────────────────────────────────────────────────
const CN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const toNum = (s) => (/^\d+$/.test(s) ? Number(s) : (/^[一二三四五六七八九十两]+$/.test(s) ? [...s].reduce((a, c) => a + (CN[c] || 0), 0) : 0));

/** What did the owner ask for: a count and a noun ("4块白桦木板" -> {count:4, noun:"白桦木板"}). */
export function promiseWanted(text) {
    const m = String(text || '').match(/([0-9]+|[一二三四五六七八九十两几])\s*(块|个|根|张|组|桶|把|件|只|份)\s*([\u4e00-\u9fa5]{1,6})?/);
    if (!m) return null;
    return { count: toNum(m[1]), noun: String(m[3] || '').replace(/(的|了|要|在|给我|送到|拿到).*$/, '') };
}

/**
 * Does her recent activity look like the promise is complete? Conservative on purpose: an explicit "made / enough /
 * kept" word next to the noun, or a count at or above what was asked. Returns the evidence kind, or null.
 */
export function promiseLooksDone(promiseText, evidenceText) {
    const want = promiseWanted(promiseText);
    const ev = String(evidenceText || '');
    if (!ev) return null;
    const noun = want?.noun || '';
    const short = noun.slice(0, 2);
    if (noun && /(做好|够了|齐了|备好|留着|做完了|拿到了|交付)/.test(ev) && (ev.includes(noun) || (short && ev.includes(short)))) return 'word';
    if (want?.count > 0 && short) {
        const counts = [...ev.matchAll(/([0-9]+|[一二三四五六七八九十两]+)\s*(块|个|根|张|组|把|件|只|份)?\s*([\u4e00-\u9fa5]{0,6})/g)]
            .filter((m) => (m[3] || '').includes(short) || short.includes((m[3] || '').slice(0, 2)));
        if (counts.some((m) => toNum(m[1]) >= want.count)) return 'count';
    }
    return null;
}

export class PromiseStore {
    constructor(file) {
        this.file = file;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        this.rows = this._load();
    }

    _load() {
        try {
            return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => {
                try { return JSON.parse(l); } catch { return null; }
            }).filter(Boolean);
        } catch { return []; }
    }

    _append(row) {
        fs.appendFileSync(this.file, `${JSON.stringify(row)}\n`);
        this.rows.push(row);
    }

    /**
     * The live list. `ownerOnline=false` freezes the clock: the errand cannot be delivered while he is away, so being
     * late is not her fault and the promise must not expire.
     */
    _live(now, { ownerOnline = true } = {}) {
        const map = new Map();
        for (const r of this.rows) {
            if (r.id) map.set(r.id, { ...r });
        }
        for (const p of map.values()) {
            if (p.status !== 'open') continue;
            if (!ownerOnline) {
                p.clockPaused = true;
                p.offlineSince = p.offlineSince || now;
                continue;
            }
            // back online: fold the offline span into pausedMs before judging the age, or the pause is silently ignored
            if (p.offlineSince) {
                p.pausedMs = (p.pausedMs || 0) + Math.max(0, now - p.offlineSince);
                p.offlineSince = null;
            }
            const age = now - p.at - (p.pausedMs || 0);
            if (age >= PROMISE_TTL_MS) {
                p.status = 'expired';
                p.closedAt = now;
                p.note = '这件事过了30分钟没做，已从清单移除';
            }
        }
        return [...map.values()];
    }

    /** Persist a pause/resume transition, so a restart keeps the clock honest. */
    syncClock(now = Date.now(), { ownerOnline = true } = {}) {
        for (const p of this._live(now, { ownerOnline })) {
            if (p.status !== 'open') continue;
            const prev = this.rows.filter((r) => r.id === p.id).pop();
            const wasPaused = !!prev?.offlineSince;
            if (!ownerOnline && !wasPaused) this._append({ id: p.id, status: 'open', at: p.at, text: p.text, offlineSince: now, pausedMs: p.pausedMs || 0 });
            if (ownerOnline && wasPaused) this._append({ id: p.id, status: 'open', at: p.at, text: p.text, pausedMs: p.pausedMs || 0, offlineSince: null });
        }
    }

    /** Record an accepted owner request. Returns the row, or null when it is not worth recording. */
    add({ text, who, at = Date.now(), from = 'owner-accept' } = {}) {
        const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!t) return null;
        if (isTestBot(who)) return null;
        const live = this._live(at).filter((p) => p.status === 'open');
        // the same request twice in a row is one promise, not two
        if (live.some((p) => p.text === t || p.text.includes(t) || t.includes(p.text))) return null;
        const row = { id: `p${at}-${Math.floor(Math.random() * 1000)}`, text: t, at, who: String(who || 'JFors'), status: 'open', from };
        this._append(row);
        return row;
    }

    open(now = Date.now(), opts = {}) {
        return this._live(now, opts).filter((p) => p.status === 'open');
    }

    /** Write the expiry marks once, so the file reflects what she was told. Returns how many expired now. */
    expire(now = Date.now(), { ownerOnline = true } = {}) {
        if (!ownerOnline) return 0;              // nothing expires while he is away
        // read the state from the FILE, not from open() - open() already applies the deadline in its own replay
        const map = new Map();
        for (const r of this.rows) if (r.id) map.set(r.id, { ...r });
        let n = 0;
        for (const p of map.values()) {
            if (p.status !== 'open') continue;
            if (now - p.at - (p.pausedMs || 0) < PROMISE_TTL_MS) continue;
            this._append({ id: p.id, status: 'expired', at: p.at, text: p.text, closedAt: now, note: '这件事过了30分钟没做，已从清单移除' });
            n++;
        }
        return n;
    }

    /** She closed it herself. `match` is a substring of the text; the closest match wins. */
    close({ match, status = 'done', reason = '', at = Date.now() } = {}) {
        const m = String(match || '').trim();
        const open = this.open(at);
        const hit = m ? open.find((p) => p.text.includes(m)) || open.find((p) => m.includes(p.text)) : open[0];
        if (!hit) return null;
        const row = { id: hit.id, status, at: hit.at, text: hit.text, closedAt: at };
        if (reason) row.reason = String(reason).slice(0, 120);
        this._append(row);
        return row;
    }

    /** Prompt lines: what she sees every turn while a promise is open (#3195 adds the nudge and the offline hold). */
    lines(now = Date.now(), { max = 3, ownerOnline = true, evidence = '' } = {}) {
        const open = this.open(now, { ownerOnline }).slice(-max);
        if (!open.length) return [];
        return [this._block(open, { ownerOnline, evidence })];
    }

    _block(open, { ownerOnline = true, evidence = '' } = {}) {
        const body = open.map((p) => {
            // local time of the machine she runs on (Claude review: a fixed +8 h is wrong for anyone outside UTC+8)
            const clock = new Date(p.at - new Date(p.at).getTimezoneOffset() * 60_000).toISOString().slice(11, 16);
            if (!ownerOnline) return `- ${p.text}（答应于 ${clock}）· 老大不在线，等他上线再交`;
            if (promiseLooksDone(p.text, evidence)) {
                return `- ${p.text}（答应于 ${clock}）· 你答应老大的「${p.text}」看起来已经做好了，交付了就 !promiseDone，交不了就说一声`;
            }
            return `- ${p.text}（答应于 ${clock}）`;
        }).join('\n');
        const tail = ownerOnline
            ? '你可以接着做、改期，或者跟老大说一声不做了。'
            : '老大不在线时不用急着交，也别因为等他而丢下这件事。';
        return `【答应老大还没做完的事】\n${body}\n${tail}`;
    }
}
