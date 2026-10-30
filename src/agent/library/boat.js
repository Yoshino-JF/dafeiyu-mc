// !boatTo (owner 2026-10-27 11:3x "有了钓鱼之后可以新增划船功能，然后写在她的手册里，这样她以后就可以决定要不要开船过湖").
// mineflayer 4.39 cannot do this on 26.1.2 by itself: placeEntity waits for an entity named "boat" (since 1.21.2 every wood is its own
// entity, oak_boat ...), moveVehicle only sends key presses (the rider's own client moves a boat and reports it with vehicle_move), and
// dismount presses jump (leaving a vehicle is sneak). So the boat is put down with use_item, rowed by reporting its moves, left with sneak.
import Vec3 from 'vec3';
import * as skills from './skills.js';
import { attackSpeed } from './fight.js';
import { bestWeapon, meleeDamage } from '../encounter.js';

export const BOAT = /_(boat|raft)$/;
const OPEN = ['air', 'cave_air'];
const SPEED = 4;          // blocks per second over water - under a boat's own top speed, so the server never sees a jump
const TICK = 50;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitFor(check, ms) {
    return new Promise((resolve) => {
        const began = Date.now();
        const poll = () => { const v = check(); if (v) return resolve(v); if (Date.now() - began >= ms) return resolve(null); setTimeout(poll, TICK); };
        poll();
    });
}

/** Rows to (x, z) over water as far as the water goes, steps out and takes the boat back. Everything she should know is logged. */
export async function boatTo(bot, x, z) {
    const log = (m) => skills.log(bot, m);
    const item = bot.inventory.items().find((i) => BOAT.test(i.name));
    if (!item) { log('No boat in your bag. A boat is 5 planks of one wood in a U shape at a crafting table, e.g. !craftRecipe("oak_boat", 1).'); return false; }
    // Try observed water with space above; the server confirms actual placement.
    // A narrow water strip is not rejected just because its neighbours are dry.
    const water = bot.findBlock({ matching: (b) => b?.name === 'water', maxDistance: 8,
        useExtraInfo: (b) => OPEN.includes(bot.blockAt(b.position.offset(0, 1, 0))?.name) });
    if (!water) { log('No observed water with open space above within 8 blocks.'); return false; }
    if (bot.entity.position.distanceTo(water.position) > 2.5) await skills.goToPosition(bot, water.position.x, water.position.y + 1, water.position.z, 2);
    await bot.equip(item, 'hand');
    await bot.lookAt(water.position.offset(0.5, 0.9, 0.5), true);

    const spawned = [];
    const onSpawn = (e) => { if (BOAT.test(e?.name || '')) spawned.push(e); };
    bot.on('entitySpawn', onSpawn);
    let boat;
    try {
        bot.activateItem();
        boat = await waitFor(() => spawned.find((e) => e.position.distanceTo(water.position) < 4), 3000);
    } finally { bot.removeListener('entitySpawn', onSpawn); }
    if (!boat) { log(`The boat did not appear on the water at (${water.position.x}, ${water.position.y}, ${water.position.z}) - nothing was placed.`); return false; }

    bot.mount(boat);
    if (!await waitFor(() => bot.vehicle === boat || bot.vehicle?.id === boat.id, 3000)) {
        log(`The boat is on the water at (${Math.floor(boat.position.x)}, ${Math.floor(boat.position.y)}, ${Math.floor(boat.position.z)}) but getting in did not work.`);
        await takeBack(bot, boat, log);
        return false;
    }

    // Row: the boat's own moves are reported; the server checks each one against the water and sends it back if it disagrees.
    const from = boat.position.clone();
    let pos = from.clone(), why = null, shoreAt = null, corrections = 0;
    const onCorrect = (p) => { pos = new Vec3(p.x, p.y, p.z); corrections++; };
    bot._client.on('vehicle_move', onCorrect);
    const began = Date.now();
    try {
        while (!why) {
            if (bot.interrupt_code) { why = 'interrupted'; break; }
            if (!bot.vehicle) { why = 'thrown_off'; break; }
            if (corrections > 8) { why = 'server_refused'; break; }
            const dx = x - pos.x, dz = z - pos.z, d = Math.hypot(dx, dz);
            if (d < 0.5) { why = 'reached'; break; }
            if (Date.now() - began > 120000) { why = 'time'; break; }
            const ux = dx / d, uz = dz / d, step = Math.min(d, SPEED * TICK / 1000);
            const next = new Vec3(pos.x + ux * step, pos.y, pos.z + uz * step);
            // a boat is 1.375 wide: where its bow will be after this step (plus a margin) must still be water with room above it
            const bow = new Vec3(next.x + ux * 0.9, next.y - 0.2, next.z + uz * 0.9).floored();
            if (bot.blockAt(bow)?.name !== 'water' || !OPEN.includes(bot.blockAt(bow.offset(0, 1, 0))?.name)) { why = 'shore'; shoreAt = bow; break; }
            pos = next;
            const yaw = Math.atan2(-ux, uz) * 180 / Math.PI;
            bot._client.write('steer_boat', { leftPaddle: true, rightPaddle: true });
            bot._client.write('vehicle_move', { x: pos.x, y: pos.y, z: pos.z, yaw, pitch: 0, onGround: false });
            await sleep(TICK);
        }
    } finally {
        bot._client.removeListener('vehicle_move', onCorrect);
        try { bot._client.write('steer_boat', { leftPaddle: false, rightPaddle: false }); } catch { /* gone */ }
    }
    const rowed = Math.round(Math.hypot(pos.x - from.x, pos.z - from.z));
    const at = pos.floored();
    const reason = {
        reached: 'reached the point you gave',
        shore: shoreAt && `the water ends just ahead at (${shoreAt.x}, ${shoreAt.y}, ${shoreAt.z}) (${bot.blockAt(shoreAt)?.name || 'unknown'})`,
        interrupted: 'something stopped the rowing',
        thrown_off: 'you were no longer in the boat',
        server_refused: `the server kept putting the boat back (${corrections} times) - rowing does not work from here`,
        time: 'two minutes of rowing ran out',
    }[why];
    log(`Rowed ${rowed} blocks over water, from (${Math.floor(from.x)}, ${Math.floor(from.z)}) to (${at.x}, ${at.z}): ${reason}.`);

    // Step out (sneak), then the boat goes back into the bag
    if (bot.vehicle) {
        bot.setControlState('sneak', true); await sleep(250); bot.setControlState('sneak', false);
        if (!await waitFor(() => !bot.vehicle, 1500)) { try { bot.dismount(); } catch { /* not mounted */ } await waitFor(() => !bot.vehicle, 1500); }
    }
    if (bot.vehicle) { log('Could not step out of the boat - you are still sitting in it.'); return false; }
    const landed = bot.entity.position.clone(), feet = bot.blockAt(landed.floored());
    const dry = feet?.name !== 'water';
    if (!dry) log('You stepped out into the water - the shore was not right next to the boat.');
    const back = await takeBack(bot, boat, log);
    // GPT #3694: she stepped out onto the far bank, then walked back into the water to pick the boat up and stayed there
    if (dry && !bot.interrupt_code && bot.entity.position.distanceTo(landed) > 1.5) await skills.goToPosition(bot, landed.x, landed.y, landed.z, 1);
    // GPT #3687: "reached" with the boat left on the water returned true - it is a success only with the boat back in the bag
    return (why === 'reached' || why === 'shore') && back;
}

const boats = (bot) => bot.inventory.items().filter((i) => BOAT.test(i.name)).reduce((n, i) => n + i.count, 0);

/** Hits the boat until it breaks and picks up what it drops. Returns whether the bag holds one more boat than before. */
async function takeBack(bot, boat, log) {
    const had = boats(bot);
    // GPT #3687: 8 bare-hand hits 300 ms apart left it whole. A hit adds 10 x its damage, a boat breaks above 40 and loses 1 every tick:
    // bare hands net +4 a hit. The hardest-hitting tool in the bag (a sword: one hit), swung at its full charge.
    const weapon = bestWeapon(bot);
    if (weapon && meleeDamage(weapon.name) > meleeDamage(bot.heldItem?.name)) await bot.equip(weapon, 'hand').catch(() => {});
    const every = Math.max(250, Math.ceil(1000 / attackSpeed(bot)) + 50);
    // GPT #3702: read after the pickup it said "with oak_boat" for nine bare-hand hits - what she hits with is taken before the first hit
    const with_ = bot.heldItem?.name || 'bare hands';
    const drops = [];
    const onSpawn = (e) => { if (e?.name === 'item') drops.push(e); };
    bot.on('entitySpawn', onSpawn);
    let hits = 0;
    try {
        const began = Date.now();
        while (hits < 20 && Date.now() - began < 12000 && bot.entities[boat.id] === boat && !bot.interrupt_code) {
            if (boat.position.distanceTo(bot.entity.position) > 3.5) await skills.goToPosition(bot, boat.position.x, boat.position.y, boat.position.z, 2, true);
            await bot.lookAt(boat.position.offset(0, 0.3, 0), true);
            bot.attack(boat); hits++;
            await sleep(every);
        }
        await sleep(400);
    } finally { bot.removeListener('entitySpawn', onSpawn); }
    if (bot.entities[boat.id] === boat) {
        log(`The boat is still on the water at (${Math.floor(boat.position.x)}, ${Math.floor(boat.position.y)}, ${Math.floor(boat.position.z)}) - ${hits} hits with ${with_} did not break it.`);
        return false;
    }
    for (const e of drops) {
        if (boats(bot) > had || bot.entities[e.id] !== e) continue;
        await skills.goToPosition(bot, e.position.x, e.position.y, e.position.z, 1, true);
        await sleep(400);
    }
    const back = boats(bot) > had;
    log(back ? `The boat broke after ${hits} hit${hits === 1 ? '' : 's'} with ${with_} and is back in your bag.`
        : 'The boat broke but it did not come into your bag - it lies near where the boat was.');
    return back;
}
