// Semantic dedupe for owner facts (#3168).
//
// The character and topic rules in taught.js are offline fallbacks. Real paraphrases ("房子应该建在上面" vs "住在上面")
// share too few bigrams, and a hand-written topic list only covers tonight's three facts, so an embedding check is the
// Chosen on the labelled set in dev/labelled-dedupe-pairs.json (24 real pairs, 14 same / 10 different, qwen
// text-embedding-v3): with the place guard applied, 0.636 gives precision 1.000 and recall 1.000, while the old 0.78
// missed 4 genuine twins (lowest 0.675). Cosine alone cannot separate two different chests (0.803) from a real twin
// (0.792), which is why the place guard is part of the rule, not a polish.
export const SEMANTIC_THRESHOLD = 0.64;

export function cosine(a, b) {
    if (!a?.length || !b?.length || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    if (!na || !nb) return 0;
    return dot / Math.sqrt(na * nb);
}

/** Small cache so one dawn does not re-embed the same strings. */
export class EmbedCache {
    constructor(limit = 200) { this.limit = limit; this.map = new Map(); }
    async get(embed, text) {
        const key = String(text || '');
        if (this.map.has(key)) return this.map.get(key);
        const v = await embed(key);
        if (this.map.size >= this.limit) this.map.delete(this.map.keys().next().value);
        this.map.set(key, v);
        return v;
    }
}

/**
 * Are these two statements the same fact, semantically? Returns {same, cosine} or null when no embedder is usable.
 * The caller keeps the place guard: two chests at different places are two facts even at cosine 0.80.
 */
export async function semanticSame({ embed, a, b, threshold = SEMANTIC_THRESHOLD, cache = null } = {}) {
    if (typeof embed !== 'function') return null;
    if (!a || !b) return null;
    try {
        const get = cache ? (t) => cache.get(embed, t) : embed;
        const [ea, eb] = await Promise.all([get(a), get(b)]);
        const c = cosine(ea, eb);
        return { same: c >= threshold, cosine: +c.toFixed(3) };
    } catch {
        return null;   // any embedding failure falls back to the offline rules; never breaks a dawn
    }
}
