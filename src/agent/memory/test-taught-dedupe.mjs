// PLAN S (#3123): dawn keeps re-promoting paraphrases of the same owner facts. Dedupe must happen AT WRITE TIME.
// These tests use the exact paraphrases Claude quoted from the live run, not invented strings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaughtStore, canon, containment, sameFact } from './taught.js';

const mk = () => new TaughtStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dstaught-')), 'taught.jsonl'));

test('the two real wordings of one rule collapse (live strings from the dawn that re-promoted them)', () => {
    assert.ok(sameFact('JFors', '认为我应该住在上面，不要在地下找房子', 'JFors', '希望我住在地面上，而不是在地下找房子'));
    assert.ok(sameFact('JFors', '建议跳起来往脚下放方块来往上走，不行就直接挖', 'JFors', '建议跳起来往脚下放方块，或者直接挖'));
});

test('different facts with shared words do NOT collapse', () => {
    assert.equal(sameFact('JFors', '旁边箱子里有面包和铁锭', 'JFors', '熔炉边箱子里会放面包，缺吃的可以拿'), false);
    assert.equal(sameFact('JFors', '去睡觉吧', 'JFors', '住在上面'), false);
    assert.equal(sameFact('JFors', '住在上面', 'HouseTest', '住在上面'), false, 'different speaker, different fact');
});

test('a paraphrase updates the existing row instead of appending a twin', () => {
    const s = mk();
    const first = s.remember({ who: 'JFors', what: '认为我应该住在上面，不要在地下找房子', at: 1000 });
    const again = s.remember({ who: 'JFors', what: '希望我住在地面上，而不是在地下找房子', at: 2000 });
    assert.equal(s.size, 1, 'still one fact');
    assert.equal(again.merged, true);
    assert.equal(first.seen, 2, 'the count of times she was taught it went up');
    assert.equal(first.at, 1000, 'the first time is never rewritten');
    assert.equal(first.lastSeenAt, 2000);
    assert.ok(first.paraphrases.some((p) => p.includes('住在地面上')), 'the new wording is kept, nothing lost');
});

test('the file stays append-only: the updated row is appended, the old line is left in place', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dstaught2-'));
    const file = path.join(dir, 'taught.jsonl');
    const s = new TaughtStore(file);
    s.remember({ who: 'JFors', what: '建议跳起来往脚下放方块来往上走', at: 1000 });
    s.remember({ who: 'JFors', what: '建议跳起来往脚下放方块，或者直接挖', at: 2000 });
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 'one original line plus one updated line');
    assert.ok(lines.some((l) => l.includes('_paraphraseMarker')), 'the update is marked so the audit can tell');
});

test('dedupeExisting folds the twins already on disk and keeps both wordings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dstaught3-'));
    const file = path.join(dir, 'taught.jsonl');
    // write the live situation: 3 facts spread over 5 rows
    const rows = [
        { who: 'JFors', what: '认为我应该住在上面，不要在地下找房子', at: 1000, source: 'consolidate' },
        { who: 'JFors', what: '建议跳起来往脚下放方块来往上走，不行就直接挖', at: 1100, source: 'consolidate' },
        { who: 'JFors', what: '说我可以去睡觉，不用硬撑', at: 1200, source: 'consolidate' },
        { who: 'JFors', what: '希望我住在地面上，而不是在地下找房子', at: 2000, source: 'consolidate' },
        { who: 'JFors', what: '建议跳起来往脚下放方块，或者直接挖', at: 2100, source: 'consolidate' }
    ];
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const s = new TaughtStore(file);
    assert.equal(s.size, 5);
    const folded = s.dedupeExisting();
    assert.equal(folded, 2);
    assert.equal(s.size, 3, '5 rows -> 3 facts');
    const live = s.all();
    const ground = live.find((r) => r.what.includes('住在上面'));
    assert.equal(ground.paraphrases.length, 1, 'the second wording survives as a paraphrase');
    assert.ok(ground.paraphrases[0].includes('住在地面'));
    // nothing was deleted: the merged rows are still on disk with a marker
    const disk = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(disk.filter((r) => r._mergeMarker).length, 2);
});

test('canon strips modality but keeps the nouns', () => {
    assert.ok(containment('希望我住在地面上', '住在地面上') >= 0.9, 'a longer paraphrase contains the shorter rule');
    assert.match(canon('箱子有面包和铁锭'), /面包/);
    assert.match(canon('箱子有面包和铁锭'), /铁锭/);
});
