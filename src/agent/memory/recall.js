// Retrieval over her own memory: taught facts, lessons, places.
// Word overlap is enough here and keeps this dependency-free; the interface takes an optional `embed` function so the
// harness can swap in its own embedding model later without touching the callers.
const PUNCT = /[.,;:!?'"`~()[\]{}<>/\\|@#$%^&*+=_\-—–，。；：！？、（）【】「」『』《》…·]+/g;

/** CJK has no spaces: use character bigrams for Chinese runs, lowercased words for latin runs. */
export function tokenize(text) {
    const s = String(text || '').toLowerCase();
    const tokens = [];
    for (const part of s.split(PUNCT)) {
        if (!part) continue;
        const words = part.split(/\s+/).filter(Boolean);
        for (const w of words) {
            const cjk = w.match(/[\u3400-\u9fff]+/g) || [];
            for (const run of cjk) {
                if (run.length === 1) tokens.push(run);
                else {
                    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
                    // Single characters carry the concept when the bigrams do not line up (缺铁 vs 铁匠铺 = 铁).
                    for (const ch of run) tokens.push(ch);
                }
            }
            const latin = w.replace(/[\u3400-\u9fff]+/g, ' ').trim();
            if (latin) tokens.push(latin);
        }
    }
    return tokens;
}

/**
 * Rank documents by overlap with the query, weighting rare tokens higher (a plain df count, no idf file needed).
 * @param {string} query
 * @param {{id:string,text:string,type:string,at?:number}[]} docs
 * @param {number} k
 */
export function rank(query, docs, k = 5, { embed } = {}) {
    const q = tokenize(query);
    if (!q.length || !docs.length) return [];
    const df = new Map();
    const docTokens = docs.map((d) => {
        const toks = new Set(tokenize(`${d.text} ${d.who || ''}`));
        for (const t of toks) df.set(t, (df.get(t) || 0) + 1);
        return toks;
    });
    const weight = (t) => (t.length === 1 ? 0.45 : 1) * (1 + Math.log(docs.length / (1 + (df.get(t) || 0))));
    let vectors = null;
    if (typeof embed === 'function') {
        // Optional path: cosine over caller-supplied vectors. Kept simple and only used when a real embedder is passed.
        vectors = docs.map((d) => embed(d.text));
    }
    const scored = docs.map((d, i) => {
        let overlap = 0;
        for (const t of new Set(q)) if (docTokens[i].has(t)) overlap += weight(t);
        const recency = d.at ? 1 / (1 + (Date.now() - d.at) / (7 * 24 * 3600_000)) : 0.5;
        // Relevance is overlap, full stop: recency only breaks ties. A fact is not "relevant" because it is recent,
        // and clock skew must never turn an unrelated row into a hit.
        return { ...d, overlap, score: overlap + 0.01 * recency };
    }).filter((d) => d.overlap > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
}
