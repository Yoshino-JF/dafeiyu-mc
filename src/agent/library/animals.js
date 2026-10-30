// Owner 10-28: "她只是不知道羊毛可以做什么东西，牛奶能做什么，还是得做这两种功能". She had said six times that the bed for her respawn point
// was waiting on wool (DeepSeek #4084) and the only wool she got was the one a killed sheep drops. Abilities she calls, never run on
// their own; whether a call worked is read from her bag, not from the click having been sent.
import { actLogged } from '../dafeiyu_log.js';
import * as skills from './skills.js';
import * as world from './world.js';

const log = (bot, text) => { bot.output = (bot.output || '') + text + '\n'; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// final-115 15:4x (first real !shear): a sheep 4 blocks away and the walk to it stood still for 65 s. Close enough to reach, no walk;
// otherwise at most 15 s of walking, then she is told it could not be reached and where it is.
async function approach(bot, e) {
    if (bot.entity.position.distanceTo(e.position) <= 3) return true;
    let timer;
    const reached = await Promise.race([skills.goToPosition(bot, e.position.x, e.position.y, e.position.z, 2, true).then((ok) => ok !== false, () => false),
        new Promise((r) => { timer = setTimeout(() => r(null), 15000); })]);
    clearTimeout(timer);
    if (reached === null) { try { bot.pathfinder?.stop?.(); bot.pathfinder?.setGoal?.(null); } catch { /* best effort */ } }
    return bot.entity.position.distanceTo(e.position) <= 3.5;
}
const where = (e) => `(${Math.round(e.position.x)}, ${Math.round(e.position.y)}, ${Math.round(e.position.z)})`;
const count = (bot, test) => bot.inventory.items().filter((i) => test(i.name)).reduce((n, i) => n + i.count, 0);
// GPT #4088: on 26.1.2 a sheep's wool state is metadata index 18, bit 0x10 = sheared
const isSheared = (e) => { const v = e?.metadata?.[18]; return typeof v === 'number' && (v & 0x10) !== 0; };
const woolCounts = (bot) => Object.fromEntries(bot.inventory.items().filter((i) => i.name.endsWith('_wool')).map((i) => [i.name, i.count]));

/** Shear up to num sheep nearby, one after another; each that gives nothing (sheared already, or a lamb) is skipped and said. */
async function _shear(bot, num = 1) {
    if (!count(bot, (n) => n === 'shears')) {
        log(bot, 'You have no shears. Shears are 2 iron_ingot: !craftRecipe("shears", 1). (A killed sheep drops 1 wool; a sheared one gives 1-3 and grows its wool back.)');
        return false;
    }
    const tried = new Set();
    let sheared = 0, gained = 0;
    for (let i = 0; i < num && !bot.interrupt_code; i++) {
        const sheep = world.getNearestEntityWhere(bot, (e) => e.name === 'sheep' && !tried.has(e.id) && !isSheared(e) && world.isAlive?.(bot, e) !== false, 32);
        if (!sheep) { const bare = world.getNearestEntityWhere(bot, (e) => e.name === 'sheep' && isSheared(e), 32); log(bot, (tried.size ? 'No other unsheared sheep within 32 blocks.' : 'No unsheared sheep within 32 blocks.') + (bare ? ' The sheep near you are sheared already; their wool grows back after they eat grass.' : '')); break; }
        tried.add(sheep.id);
        if (!(await approach(bot, sheep))) { if (bot.interrupt_code) break; log(bot, `Could not get to the sheep at ${where(sheep)} (no way through within 15 s) - trying another.`); i--; if (tried.size >= num + 4) break; continue; }
        if (bot.interrupt_code) break;
        const shears = bot.inventory.items().find((it) => it.name === 'shears');
        if (!shears) { log(bot, 'Your shears are gone (they wear out).'); break; }
        await bot.equip(shears, 'hand');
        const before = count(bot, (n) => n.endsWith('_wool')), was = woolCounts(bot);
        try { await bot.useOn(sheep); } catch (e) { log(bot, `Could not use the shears on that sheep: ${e.message}.`); continue; }
        // the wool drops on the ground beside the sheep and is picked up when she is close
        for (let t = 0; t < 12 && count(bot, (n) => n.endsWith('_wool')) <= before; t++) await wait(250);
        const got = count(bot, (n) => n.endsWith('_wool')) - before;
        if (got > 0) {
            sheared++; gained += got;
            const now = woolCounts(bot), kinds = Object.keys(now).filter((k) => now[k] > (was[k] || 0)).map((k) => `${k} +${now[k] - (was[k] || 0)}`);
            log(bot, `Sheared a sheep: ${kinds.join(', ')}.`);
        } else {
            log(bot, isSheared(sheep)
                ? `That sheep is sheared now, but the wool did not reach your bag - it is on the ground near (${Math.round(sheep.position.x)}, ${Math.round(sheep.position.y)}, ${Math.round(sheep.position.z)}); walk over it to pick it up.`
                : 'That sheep gave no wool - most likely a lamb (lambs cannot be sheared).');
            i--;   // try the next sheep for the same count
            if (tried.size >= num + 4) break;
        }
    }
    log(bot, `Sheared ${sheared} sheep, +${gained} wool in your bag. A bed is 3 wool of one colour + 3 planks: !craftRecipe("white_bed", 1) for white wool; sleeping in it sets your respawn point there. Wool also makes carpets and banners.`);
    return gained > 0;
}

/** Fill an empty bucket from the nearest cow (or mooshroom); read from the bag whether a milk_bucket came out. */
async function _milk(bot) {
    if (!count(bot, (n) => n === 'bucket')) {
        log(bot, 'You have no empty bucket. A bucket is 3 iron_ingot: !craftRecipe("bucket", 1).');
        return false;
    }
    const cow = world.getNearestEntityWhere(bot, (e) => (e.name === 'cow' || e.name === 'mooshroom') && world.isAlive?.(bot, e) !== false, 32);
    if (!cow) { log(bot, 'No cow within 32 blocks.'); return false; }
    if (!(await approach(bot, cow))) { if (!bot.interrupt_code) log(bot, `Could not get to the cow at ${where(cow)} (no way through within 15 s).`); return false; }
    if (bot.interrupt_code) return false;
    const bucket = bot.inventory.items().find((it) => it.name === 'bucket');
    if (!bucket) { log(bot, 'The empty bucket is gone from your bag.'); return false; }
    await bot.equip(bucket, 'hand');
    const before = count(bot, (n) => n === 'milk_bucket');
    try { await bot.useOn(cow); } catch (e) { log(bot, `Could not use the bucket on the cow: ${e.message}.`); return false; }
    for (let t = 0; t < 8 && count(bot, (n) => n === 'milk_bucket') <= before; t++) await wait(250);
    if (count(bot, (n) => n === 'milk_bucket') <= before) {
        log(bot, 'No milk came out (no milk_bucket in your bag) - a calf gives none; try a grown cow.');
        return false;
    }
    log(bot, 'Milked the cow: +1 milk_bucket. Drinking it (!consume("milk_bucket")) clears every effect on you at once - poison (pufferfish), hunger (rotten flesh) and the rest - and gives the bucket back. Milk also makes a cake (3 milk_bucket, 2 sugar, 1 egg, 3 wheat).');
    return true;
}

export const shear = actLogged('shear', _shear, ['num']);
export const milk = actLogged('milk', _milk, []);
