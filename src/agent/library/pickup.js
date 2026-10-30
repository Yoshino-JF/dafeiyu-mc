// The item_collecting reflex's pickup: skills.pickupNearbyItems, minus the items she has just thrown away herself (bot.ignoredItems,
// kept by agent.js). 2026-10-26 companionship run: the reflex swept her discards straight back up and she concluded
// "背包反复自动塞满…疑有人塞东西". A separate file so the reflex does not depend on skills.js internals.
import pf from 'mineflayer-pathfinder';
import { goToGoal } from './skills.js';

const DISTANCE = 8;
const nearestKept = (bot) => bot.nearestEntity((e) => e.name === 'item' && !bot.ignoredItems?.has(e.id)
    && bot.entity.position.distanceTo(e.position) < DISTANCE);

export async function pickupKeptItems(bot) {
    let item = nearestKept(bot), pickedUp = 0;
    while (item) {
        const movements = new pf.Movements(bot);
        movements.canDig = false;
        bot.pathfinder.setMovements(movements);
        if (!await goToGoal(bot, new pf.goals.GoalFollow(item, 1))) return false;
        await new Promise((resolve) => setTimeout(resolve, 200));
        const prev = item;
        item = nearestKept(bot);
        if (prev === item) break;
        pickedUp++;
    }
    bot.output = (bot.output || '') + `Picked up ${pickedUp} items.\n`;
    return true;
}
