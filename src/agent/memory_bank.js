import fs from 'fs';
import path from 'path';

export class MemoryBank {
	constructor() {
		this.memory = {};
	}

	rememberPlace(name, x, y, z) {
		this.memory[name] = [x, y, z];
	}

	recallPlace(name) {
		return this.memory[name];
	}

	getJson() {
		return this.memory
	}

	loadJson(json) {
		this.memory = json;
	}

	getKeys() {
		return Object.keys(this.memory).join(', ')
	}
}

// dafeiyu (A/B/A run 10-26): this bank lives in RAM only, so every restart emptied it while her long-term place book
// (memory/places.md, written by !rememberHere too) still listed every place in her prompt - "地点簿又空了", and in the 3-day run
// she wrote herself the lesson "地点簿失灵别硬试". The commands read both: this bank first, then the book.
export function bookPlaceNames(agent) {
    const dir = agent.memoryS?.dir;
    if (!dir) return [];
    try {
        return fs.readFileSync(path.join(dir, 'places.md'), 'utf8').split('\n')
            .map((l) => l.match(/^- (.+?) ：/)?.[1]?.trim()).filter(Boolean);
    } catch { return []; }
}

export function allPlaceNames(agent) {
    const names = Object.keys(agent.memory_bank?.getJson?.() || {});
    for (const n of bookPlaceNames(agent)) if (!names.includes(n)) names.push(n);
    return names;
}

export function findPlace(agent, name) {
    const pos = agent.memory_bank?.recallPlace?.(name);
    if (pos) return pos;
    const p = agent.memoryS?.place?.(name);
    return p ? [p.x, p.y, p.z] : null;
}
