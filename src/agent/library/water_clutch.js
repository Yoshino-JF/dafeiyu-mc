// 落地水 (owner 10-27 14:0x "有没有可能实现落地水的操作……算是为从高处掉落添加一种可能性"; 14:3x "if u want to use this skill u need to
// craft a bucket and collect water first"). A body reflex like creeper_dodge - a fall is over in 1-2 s and a decision of hers takes 3-6 s.
// What is hers: making a water bucket, carrying it, and keeping the reflex on (mode water_clutch). It runs on every physics tick, because
// the 300 ms mode loop would miss the moment: falling fast she drops 2-4 blocks a tick.
// A water bucket is used along her view (use_item, not use_item_on), from her eyes, within about 4.5 blocks: she looks straight down and
// uses it once her feet are within ~2.9 blocks of the ground and the next tick would reach it. Landed in it, the water goes back into the
// bucket 5 ticks later (AutoMLG+ does the same). Water evaporates in the Nether; a slab or lava under her is left alone.
import Vec3 from 'vec3';
import { logAct } from '../dafeiyu_log.js';

const HURTS = 3.5;          // fall damage starts above 3 blocks
const REACH = 4.5 - 1.62;   // block reach from her eyes, measured from her feet
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What she would land on: the first block below her feet that is not empty. */
export function groundBelow(bot, feet, max = 64) {
    for (let d = 1; d <= max; d++) {
        const b = bot.blockAt(new Vec3(Math.floor(feet.x), Math.floor(feet.y) - d, Math.floor(feet.z)));
        if (!b) return null;                                   // not loaded
        if (b.name === 'water' || b.name === 'lava') return { block: b, kind: b.name, top: b.position.y + 1 };
        // GPT #3752: on leaves the bucket waterlogged the leaf block itself instead of filling the cell above, and she hit the leaves (-7 HP).
        // Any block that can hold water (leaves, slabs, stairs, fences, ...) takes it in; there is nothing to land in, so none is placed.
        const waterloggable = typeof b.getProperties === 'function' && 'waterlogged' in (b.getProperties() || {});
        if (b.boundingBox === 'block') return { block: b, kind: waterloggable || /_slab$/.test(b.name) ? 'holds_water' : 'solid', top: b.position.y + 1 };
    }
    return null;
}

/** Decide on one tick. Pure: returns what to do, so it can be tested without a server. */
export function clutchStep(state, { y, vy, onGround, inWater, ground, hasBucket, holding, nether }) {
    if (onGround || inWater) return { ...state, airborne: false, top: null, act: state.placed ? 'landed' : null };
    const top = Math.max(state.top ?? y, y);
    const next = { ...state, airborne: true, top };
    if (nether || !ground || ground.kind !== 'solid' || state.placed) return next;
    const drop = top - ground.top, above = y - ground.top, fall = -vy;
    if (drop <= HURTS || fall <= 0.2 || !hasBucket) return next;
    if (!holding) return { ...next, act: 'equip' };
    // within reach, and the next tick would reach the ground (or the one after, when slow)
    if (above <= REACH && above - fall * 1.5 <= 0.6) return { ...next, act: 'place', drop: Math.round(drop) };
    // LiquidBounce turns to the target ticks before the click; looking down early means the look is already on the server
    return { ...next, act: 'aim' };
}

export function attachWaterClutch(agent) {
    const bot = agent.bot;
    if (!bot || bot._waterClutch) return;
    bot._waterClutch = true;
    let state = { airborne: false, top: null, placed: null }, equipping = false, busy = false;
    bot.on('physicsTick', () => {
        if (busy || !bot.entity || bot.vehicle || !bot.modes?.isOn?.('water_clutch')) return;
        const e = bot.entity, feet = e.position;
        const inWater = ['water'].includes(bot.blockAt(feet)?.name);
        const bucket = bot.inventory.items().find((i) => i.name === 'water_bucket');
        const ground = state.placed ? null : groundBelow(bot, feet);
        const step = clutchStep(state, { y: feet.y, vy: e.velocity?.y ?? 0, onGround: e.onGround, inWater, ground,
            hasBucket: !!bucket, holding: bot.heldItem?.name === 'water_bucket', nether: /nether/.test(bot.game?.dimension || '') });
        const act = step.act; delete step.act;
        const drop = step.drop; delete step.drop;
        state = step;
        if (act === 'aim') {
            if (e.pitch > -Math.PI / 2 + 0.01) bot.look(e.yaw, -Math.PI / 2, true).catch(() => {});
        } else if (act === 'equip' && !equipping) {
            equipping = true;
            bot.equip(bucket, 'hand').catch(() => {}).finally(() => { equipping = false; });
        } else if (act === 'place') {
            // look straight down and use it in the same tick: use_item carries the rotation it was sent with
            bot.look(e.yaw, -Math.PI / 2, true).catch(() => {});
            if (bot.flushPositionForItemUse?.() === false) return;
            bot.activateItem();
            state = { ...state, placed: { at: ground.block.position.offset(0, 1, 0), drop, hp: bot.health } };
        } else if (act === 'landed') {
            const placed = state.placed;
            state = { airborne: false, top: null, placed: null };
            busy = true;
            takeBack(agent, placed).finally(() => { busy = false; });
        }
    });
}

async function takeBack(agent, placed) {
    const bot = agent.bot;
    await sleep(250);
    const water = bot.blockAt(placed.at)?.name === 'water';
    let back = false;
    // LiquidBounce keeps trying from 200 to 1000 ms after the placement, and counts it only when the water is really gone
    for (let tries = 0; water && !back && tries < 4 && bot.heldItem?.name === 'bucket'; tries++) {
        await bot.lookAt(placed.at.offset(0.5, 0.5, 0.5), true).catch(() => {});
        if (bot.flushPositionForItemUse?.() === false) break;
        bot.activateItem();
        await sleep(250);
        back = bot.inventory.items().some((i) => i.name === 'water_bucket') && bot.blockAt(placed.at)?.name !== 'water';
    }
    const hurt = Math.max(0, Math.round((placed.hp ?? bot.health) - bot.health));
    logAct({ kind: 'water_clutch', args: { drop: placed.drop }, ok: hurt === 0, placed: water, back, hurt });
    const at = `(${placed.at.x}, ${placed.at.y}, ${placed.at.z})`;
    agent.history?.add?.('system', `（落地水：你从大约 ${placed.drop} 格高掉下来，落地前身体自己往脚下放了一桶水接住${hurt ? `，还是掉了 ${hurt} 血` : '，没有摔伤'}。`
        + (back ? '水已经收回桶里了。）' : water ? `水没收回来，还在 ${at}。）` : '那格水没有放出来。）'))?.catch?.(() => {});
}
