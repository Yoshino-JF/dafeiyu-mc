// Heard lines: everything a player says to her, kept append-only and uncapped.
// A real companion does not take notes on purpose, so this is not an instruction to memorise - it is the transcript of
// what reached her ears. Retrieval reads it (type 'heard'), and the nightly pass promotes the few facts worth keeping
// into the taught store, which is the part that is never dropped.
import fs from 'fs';
import path from 'path';

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

export class HeardStore {
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

    /**
     * One line per heard message. The same speaker repeating themselves inside `dedupeMs` is one row (chat spam and
     * double-delivery must not fill the transcript), but nothing is ever removed.
     */
    add({ who, text, at = Date.now(), dedupeMs = 60_000 } = {}) {
        const t = norm(text);
        if (!t) return null;
        const w = norm(who) || 'someone';
        const last = this.rows[this.rows.length - 1];
        if (last && last.who === w && last.text === t && at - last.at >= 0 && at - last.at < dedupeMs) return null;
        const row = { who: w, text: t, at };
        fs.appendFileSync(this.file, `${JSON.stringify(row)}\n`);
        this.rows.push(row);
        return row;
    }

    /** Newest first. */
    recent(n = 50) {
        return this.rows.slice(-n).reverse();
    }

    /** Lines heard in [from, to), oldest first - what the nightly pass reads. */
    between(from, to) {
        return this.rows.filter((r) => r.at >= from && r.at < to);
    }

    get size() { return this.rows.length; }
}
