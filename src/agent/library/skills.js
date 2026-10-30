import * as mc from "../../utils/mcdata.js";
import { noteBed } from '../respawn.js';
import * as world from "./world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../settings.js";
import { actLogged } from '../dafeiyu_log.js';
import { isCancelledAction, onActionCancel, bodyFact } from '../action_manager.js';
import { collectTargets } from '../action_facts.js';
import { tossWithReceipt, stepAwayFromDrops } from './gift.js';

const blockPlaceDelay = settings.block_place_delay == null ? 0 : settings.block_place_delay;
const useDelay = blockPlaceDelay > 0;

export function log(bot, ...args) {
    const message = args.map(value => {
        if (value !== null && typeof value === 'object') {
            try { return JSON.stringify(value); } catch { return String(value); }
        }
        return String(value);
    }).join(' ');
    bot.output += message + '\n';
}

function craftingOutputRoom(bot, result) {
    const stackSize = bot.registry.items[result.id]?.stackSize;
    if (!stackSize) return 0;
    let room = 0;
    for (const slot of bot.inventory.slots.slice(bot.inventory.inventoryStart, bot.inventory.inventoryEnd)) {
        if (!slot) room += stackSize;
        // Only ordinary matching stacks are guaranteed to merge with a recipe's default output.
        else if (slot.type === result.id && (slot.metadata || 0) === (result.metadata || 0)
            && !slot.nbt && !slot.components?.length) room += Math.max(0, stackSize - slot.count);
    }
    return room;
}

async function autoLight(bot) {
    if (world.shouldPlaceTorch(bot)) {
        try {
            const pos = world.getPosition(bot);
            return await placeBlock(bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
        } catch (err) {return false;}
    }
    return false;
}

async function equipHighestAttack(bot) {
    let weapons = bot.inventory.items().filter(item => item.name.includes('sword') || (item.name.includes('axe') && !item.name.includes('pickaxe')));
    if (weapons.length === 0)
        weapons = bot.inventory.items().filter(item => item.name.includes('pickaxe') || item.name.includes('shovel'));
    if (weapons.length === 0)
        return;
    weapons.sort((a, b) => b.attackDamage - a.attackDamage);
    let weapon = weapons[0];
    if (weapon)
        await bot.equip(weapon, 'hand');
}

async function _craftRecipe(bot, itemName, num=1) {
    /**
     * Attempt to craft the given item name from a recipe. May craft many items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to craft.
     * @returns {Promise<boolean>} true if the recipe was crafted, false otherwise.
     * @example
     * await skills.craftRecipe(bot, "stick");
     **/
    let placedTable = false;

    if (bot.currentWindow) await bot.closeWindow(bot.currentWindow);
    if (bot._settleInventoryCraftingGrid) await bot._settleInventoryCraftingGrid();

    // GPT #3700: a name with no recipe (or no item, e.g. "boat") came back null and threw on .length. Say so, with the names that exist.
    if (!mc.getItemCraftingRecipes(itemName)?.length) {
        const like = mc.getItemId(itemName) == null ? mc.getAllItems().map((i) => i.name).filter((n) => n.endsWith('_' + itemName) || n.startsWith(itemName + '_')).slice(0, 6) : [];
        log(bot, `${itemName} is either not an item, or it does not have a crafting recipe!${like.length ? ` Items with that name: ${like.join(', ')}.` : ''}`);
        return false;
    }

    // get recipes that don't require a crafting table
    let recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, null); 
    let craftingTable = null;
    const craftingTableRange = 16;
    placeTable: if (!recipes || recipes.length === 0) {
        recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, true);
        if(!recipes || recipes.length === 0) break placeTable; //Don't bother going to the table if we don't have the required resources.

        // Look for crafting table
        craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
        if (craftingTable === null){

            // Try to place crafting table
            let hasTable = world.getInventoryCounts(bot)['crafting_table'] > 0;
            if (hasTable) {
                craftingTable = await putDownForUse(bot, 'crafting_table', 6, craftingTableRange, itemName);
                if (!craftingTable) return false;
                recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
                placedTable = true;
            }
            else {
                log(bot, `Crafting ${itemName} requires a crafting table.`)
                return false;
            }
        }
        else {
            recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
        }
    }
    if (!recipes || recipes.length === 0) {
        // 10-29 lab (DeepSeek #4126): the recipe alone did not say which part was short - what she has of each is the missing fact
        const inv = world.getInventoryCounts(bot), parts = Object.entries(mc.getItemCraftingRecipes(itemName)[0][0]);
        // the recipe lists one kind (oak_planks); planks, logs and wool of any kind count the same at the table
        // - but not when the thing made is of that same wood/colour: oak_planks take oak_log only, oak_stairs oak_planks (lab run 4)
        const kind = (key) => { const k = key.match(/^(.+)_(planks|log|wool)$/); return k && !itemName.startsWith(k[1] + '_') ? k[2] : undefined; };
        const has = (key) => kind(key) ? Object.entries(inv).filter(([n]) => n.endsWith('_' + kind(key))).reduce((s, [, c]) => s + c, 0) : (inv[key] || 0);
        const label = (key) => kind(key) ? `${kind(key)} (any kind)` : key;
        const short = parts.filter(([key, need]) => has(key) < need).length;
        log(bot, `Cannot craft ${itemName} yet: ${parts.map(([key, need]) => `${label(key)} ${need} needed, you have ${has(key)} (${has(key) < need ? `${need - has(key)} short` : 'enough'})`).join('; ')} - ${short} item${short === 1 ? '' : 's'} short.`);
        if (placedTable) {
            await takeBackPlaced(bot, craftingTable?.position, 'crafting_table');
        }
        return false;
    }
    
    if (craftingTable && bot.entity.position.distanceTo(craftingTable.position) > 4) {
        await goToNearestBlock(bot, 'crafting_table', 4, craftingTableRange);
    }

    console.log('crafting...');
    //Check that the agent has sufficient items to use the recipe `num` times.
    const inventory = world.getInventoryCounts(bot); //Items in the agents inventory
    // 10-29 lab run 4: the first recipe listed counted as 0 crafts with 4 spruce planks in the bag (its ingredients read as another
    // plank kind), so the table opened and closed with nothing made - "got 0". The first recipe her bag covers is used.
    const limitOf = (r) => mc.calculateLimitingResource(inventory, mc.ingredientsFromPrismarineRecipe(r));
    const recipe = recipes.find((r) => limitOf(r).num > 0) || recipes[0];
    const craftLimit = limitOf(recipe);
    
    const crafts = Math.min(craftLimit.num, num);
    if (craftingOutputRoom(bot, recipe.result) < crafts * recipe.result.count) {
        log(bot, `Inventory is full: no room for ${itemName}. Free a slot first. Ingredients were not consumed.`);
        return false;
    }
    await bot.craft(recipe, crafts, craftingTable);
    // 10-29 lab run 4 / craft test: now and then the first craft at a table makes nothing and uses nothing (the window opened and
    // closed in 3 ms); the same craft a moment later works. Nothing used up -> one more try before telling her it failed.
    const unchanged = () => Object.entries(inventory).every(([n, c]) => (world.getInventoryCounts(bot)[n] || 0) === c);
    if (crafts > 0 && unchanged() && !bot.interrupt_code) { await new Promise((r) => setTimeout(r, 500)); if (unchanged()) await bot.craft(recipe, crafts, craftingTable); }
    const produced = (world.getInventoryCounts(bot)[itemName] || 0) - (inventory[itemName] || 0);
    if (produced < crafts * recipe.result.count) {
        const full = bot.inventory.emptySlotCount() === 0;
        log(bot, `Crafting incomplete: got ${produced} ${itemName}, expected ${crafts * recipe.result.count}. ${full ? 'Inventory is full; the missing result may have dropped nearby. Free a slot and check the ground.' : 'The missing result was not received; whether it dropped is unconfirmed.'}`);
        if (placedTable) await takeBackPlaced(bot, craftingTable?.position, 'crafting_table');   // 10-28: this path left the table standing
        return false;
    }
    if(craftLimit.num<num) log(bot, `Not enough ${craftLimit.limitingResource} to craft ${num}, crafted ${craftLimit.num}. You now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
    else log(bot, `Successfully crafted ${itemName}, you now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
    if (placedTable) {
        await takeBackPlaced(bot, craftingTable?.position, 'crafting_table');
    }

    //Equip any armor the bot may have crafted.
    //There is probablly a more efficient method than checking the entire inventory but this is all mineflayer-armor-manager provides. :P
    bot.armorManager.equipAll(); 

    return true;
}

export async function wait(bot, milliseconds) {
    /**
     * Waits for the given number of milliseconds.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} milliseconds, the number of milliseconds to wait.
     * @returns {Promise<boolean>} true if the wait was successful, false otherwise.
     * @example
     * await skills.wait(bot, 1000);
     **/
    // setTimeout is disabled to prevent unawaited code, so this is a safe alternative that enables interrupts
    let timeLeft = milliseconds;
    let startTime = Date.now();
    
    while (timeLeft > 0) {
        if (bot.interrupt_code) return false;
        
        let waitTime = Math.min(2000, timeLeft);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        let elapsed = Date.now() - startTime;
        timeLeft = milliseconds - elapsed;
    }
    return true;
}

/** Which one kind of fuel to put in: the first (highest burn per item) that covers num smelts, else the one that covers the most. */
export function pickSmeltFuel(items, num, perItem) {
    const kinds = {};
    for (const i of items) if (perItem(i.name) > 0) kinds[i.name] = (kinds[i.name] || 0) + i.count;
    const options = Object.entries(kinds).map(([name, count]) => ({ name, count, smelts: Math.floor(count * perItem(name)) }))
        .sort((a, b) => perItem(b.name) - perItem(a.name));
    const enough = options.find((o) => o.smelts >= num) || null;
    const best = enough || [...options].sort((a, b) => b.smelts - a.smelts)[0] || null;
    return { options, enough, best };
}

async function _smeltItem(bot, itemName, num=1) {
    /**
     * Puts 1 coal in furnace and smelts the given item name, waits until the furnace runs out of fuel or input items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to smelt. Ores must contain "raw" like raw_iron.
     * @param {number} num, the number of items to smelt. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was smelted, false otherwise. Fail
     * @example
     * await skills.smeltItem(bot, "raw_iron");
     * await skills.smeltItem(bot, "beef");
     **/

    if (!mc.isSmeltable(itemName)) {
        log(bot, `Cannot smelt ${itemName}. Hint: make sure you are smelting the 'raw' item.`);
        return false;
    }

    let placedFurnace = false;
    let furnaceBlock = undefined;
    const furnaceRange = 16;
    furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
    if (!furnaceBlock){
        // Try to place furnace
        let hasFurnace = world.getInventoryCounts(bot)['furnace'] > 0;
        if (hasFurnace) {
            furnaceBlock = await putDownForUse(bot, 'furnace', furnaceRange, furnaceRange, itemName);
            if (!furnaceBlock) return false;
            placedFurnace = true;
        }
    }
    if (!furnaceBlock){
        // DeepSeek #3780 (15:58): she wanted to cook salmon, read this line, and ate it raw - how a furnace is made was the missing fact
        log(bot, `There is no furnace nearby and you have no furnace. A furnace is 8 cobblestone (cobbled deepslate or blackstone also work) in a ring at a crafting table: !craftRecipe("furnace", 1), then smelt next to it (it also needs fuel such as coal or planks).`)
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, furnaceRange);
    }
    bot.modes.pause('unstuck');
    await bot.lookAt(furnaceBlock.position);

    console.log('smelting...');
    const furnace = await bot.openFurnace(furnaceBlock);
    // final-109b 10:5x: cancelled while the furnace was opening, the guarded openFurnace gives false - closing it threw
    // "furnace.emit is not a function" and her !smeltItem ended in a TypeError instead of a receipt
    if (!furnace) { log(bot, `The furnace did not open (the action was stopped while opening it).`); return false; }
    let furnaceClosed = false;
    const closeFurnace = () => {
        if (furnaceClosed) return;
        furnaceClosed = true;
        if (bot.currentWindow === furnace) bot.closeWindow(furnace);   // also when cancelled (10-29 lab: left open, every equip broke)
        // A newer window must stay open, but the old furnace still owns its
        // craft_progress_bar listener until its local close event is delivered.
        else furnace.emit('close');
    };
    onActionCancel(bot, closeFurnace);
    try {
    if (isCancelledAction(bot) || bot.interrupt_code) return false;
    // check if the furnace is already smelting something
    let input_item = furnace.inputItem();
    if (input_item && input_item.type !== mc.getItemId(itemName) && input_item.count > 0) {
        // TODO: check if furnace is currently burning fuel. furnace.fuel is always null, I think there is a bug.
        // This only checks if the furnace has an input item, but it may not be smelting it and should be cleared.
        log(bot, `The furnace is currently smelting ${mc.getItemName(input_item.type)}.`);
        if (placedFurnace)
            await takeBackPlaced(bot, furnaceBlock?.position, 'furnace');
        return false;
    }
    // check if the bot has enough items to smelt
    let inv_counts = world.getInventoryCounts(bot);
    if (!inv_counts[itemName] || inv_counts[itemName] < num) {
        // 10-29 lab: asked for 6 with 3 in the bag, twice in a row - the count she has was the missing fact
        log(bot, `You do not have enough ${itemName} to smelt ${num}: you have ${inv_counts[itemName] || 0}. Nothing was smelted.`);
        if (placedFurnace)
            await takeBackPlaced(bot, furnaceBlock?.position, 'furnace');
        return false;
    }

    // fuel the furnace
    if (!furnace.fuelItem()) {
        // DeepSeek #3798 (16:26): told "not enough oak_log" with planks in the bag, she tried planks and they burned ("它自己挑食").
        // Only the first fuel item found was ever looked at. The fuel slot takes one kind: the kind that covers the whole batch is used
        // (coal first), else the one that covers the most, and the batch is cut to what it can smelt - said plainly.
        const { options, enough, best } = pickSmeltFuel(bot.inventory.items(), num, mc.getFuelSmeltOutput);
        if (!best || best.smelts < 1) {
            log(bot, `You have no fuel to smelt ${itemName}${options.length ? ` (${options.map((o) => `${o.count} ${o.name}`).join(', ')} is not enough for even one)` : ''}; coal, charcoal, logs and planks all burn.`);
            if (placedFurnace)
                await takeBackPlaced(bot, furnaceBlock?.position, 'furnace');
            return false;
        }
        if (!enough) {
            log(bot, `Not enough fuel of one kind for ${num} ${itemName}: the most is ${best.count} ${best.name}, which smelts ${best.smelts}. Smelting ${best.smelts} instead (a furnace takes one kind of fuel at a time).`);
            num = best.smelts;
        }
        const fuel = bot.inventory.items().find((i) => i.name === best.name);
        log(bot, `Using ${fuel.name} as fuel.`);

        const put_fuel = Math.min(best.count, Math.ceil(num / mc.getFuelSmeltOutput(fuel.name)));
        await furnace.putFuel(fuel.type, null, put_fuel);
        log(bot, `Added ${put_fuel} ${mc.getItemName(fuel.type)} to furnace fuel.`);
        console.log(`Added ${put_fuel} ${mc.getItemName(fuel.type)} to furnace fuel.`)
    }
    // put the items in the furnace
    await furnace.putInput(mc.getItemId(itemName), null, num);
    // wait for the items to smelt
    let total = 0;
    let smelted_item = null;
    await new Promise(resolve => setTimeout(resolve, 200));
    let last_collected = Date.now();
    while (total < num) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (furnace.outputItem()) {
            smelted_item = await furnace.takeOutput();
            if (smelted_item) {
                total += smelted_item.count;
                last_collected = Date.now();
            }
        }
        if (Date.now() - last_collected > 11000) {
            break; // if nothing has been collected in 11 seconds, stop
        }
        if (bot.interrupt_code) {
            break;
        }
    }
    // take all remaining in input/fuel slots
    if (furnace.inputItem()) {
        await furnace.takeInput();
    }
    if (furnace.fuelItem()) {
        await furnace.takeFuel();
    }

    closeFurnace();

    if (placedFurnace) {
        await takeBackPlaced(bot, furnaceBlock?.position, 'furnace');
    }
    if (total === 0) {
        log(bot, `Failed to smelt ${itemName}.`);
        return false;
    }
    if (total < num) {
        log(bot, `Only smelted ${total} ${mc.getItemName(smelted_item.type)}.`);
        return false;
    }
    log(bot, `Successfully smelted ${itemName}, got ${total} ${mc.getItemName(smelted_item.type)}.`);
    return true;
    } finally {
        closeFurnace();
    }
}

export async function clearNearestFurnace(bot) {
    /**
     * Clears the nearest furnace of all items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the furnace was cleared, false otherwise.
     * @example
     * await skills.clearNearestFurnace(bot);
     **/
    let furnaceBlock = world.getNearestBlock(bot, 'furnace', 32);
    if (!furnaceBlock) {
        log(bot, `No furnace nearby to clear.`);
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, 32);
    }

    console.log('clearing furnace...');
    const furnace = await bot.openFurnace(furnaceBlock);
    if (!furnace) { log(bot, `The furnace did not open (the action was stopped while opening it).`); return false; }
    console.log('opened furnace...')
    // take the items out of the furnace
    let smelted_item, intput_item, fuel_item;
    try {
        if (furnace.outputItem())
            smelted_item = await furnace.takeOutput();
        if (furnace.inputItem())
            intput_item = await furnace.takeInput();
        if (furnace.fuelItem())
            fuel_item = await furnace.takeFuel();
    } finally {
        // 10-29 lab B3: the window was never closed and stayed bot.currentWindow until the next action closed it
        if (bot.currentWindow === furnace) bot.closeWindow(furnace);
    }
    console.log(smelted_item, intput_item, fuel_item)
    let smelted_name = smelted_item ? `${smelted_item.count} ${smelted_item.name}` : `0 smelted items`;
    let input_name = intput_item ? `${intput_item.count} ${intput_item.name}` : `0 input items`;
    let fuel_name = fuel_item ? `${fuel_item.count} ${fuel_item.name}` : `0 fuel items`;
    log(bot, `Cleared furnace, received ${smelted_name}, ${input_name}, and ${fuel_name}.`);
    return true;

}


async function _attackNearest(bot, mobType, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} mobType, the type of mob to attack.
     * @param {boolean} kill, whether or not to continue attacking until the mob is dead. Defaults to true.
     * @returns {Promise<boolean>} true if the mob was attacked, false if the mob type was not found.
     * @example
     * await skills.attackNearest(bot, "zombie", true);
     **/
    bot.modes.pause('cowardice');
    if (mobType === 'drowned' || mobType === 'cod' || mobType === 'salmon' || mobType === 'tropical_fish' || mobType === 'squid')
        bot.modes.pause('self_preservation'); // so it can go underwater. TODO: have an drowning mode so we don't turn off all self_preservation
    const mob = world.getNearbyEntities(bot, 24).find(entity => entity.name === mobType);
    if (mob) {
        return await attackEntity(bot, mob, kill);
    }
    log(bot, 'Could not find any '+mobType+' to attack.');
    return false;
}

async function _attackEntity(bot, entity, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to attack.
     * @returns {Promise<boolean>} true if the entity was attacked, false if interrupted
     * @example
     * await skills.attackEntity(bot, entity);
     **/

    const targetId = entity.id, targetUuid = entity.uuid;
    const sameTarget = value => value === entity || Number.isInteger(targetId) && value?.id === targetId
        && (!targetUuid || value.uuid === targetUuid);
    const interrupted = () => bot.interrupt_code || isCancelledAction(bot);
    const startHealth = bot.health;
    let previousHealth = startHealth, healthKnown = Number.isFinite(startHealth), lostHealth = 0;
    let dead = false, gone = false, pvpStarted = false, pvpStopped = false;
    const onDead = value => { if (sameTarget(value)) dead = true; };
    const onGone = value => { if (sameTarget(value)) gone = true; };
    const onHealth = () => {
        if (Number.isFinite(previousHealth) && Number.isFinite(bot.health)) lostHealth += Math.max(0, previousHealth - bot.health);
        else healthKnown = false;
        previousHealth = bot.health;
    };
    const fmt = value => Number.isFinite(value) ? String(Math.round(value * 100) / 100) : 'unknown';
    const receipt = (result, detail='') => log(bot, `Attack result: ${result}${detail ? ' (' + detail + ')' : ''}. Own health ${fmt(startHealth)} -> ${fmt(bot.health)}; observed health lost ${healthKnown ? fmt(lostHealth) : 'unknown'}.`);
    const stopOwnPvp = async () => {
        if (!pvpStopped && pvpStarted && !isCancelledAction(bot) && sameTarget(bot.pvp.target)) {
            pvpStopped = true;
            await bot.pvp.stop();
        }
    };
    // Listen before equipping/starting: a fast death must not be confused with removal from view.
    bot.on('entityDead', onDead);
    bot.on('entityGone', onGone);
    bot.on('health', onHealth);
    try {
        await equipHighestAttack(bot);
        if (interrupted()) { receipt('interrupted'); return false; }
        if (!kill) {
            const pos = entity.position;
            if (bot.entity.position.distanceTo(pos) > 5 && !await goToPosition(bot, pos.x, pos.y, pos.z, 2, true)) {   // an entity: a point (GPT #3537)
                receipt('lost', 'target not reached; death unconfirmed'); return false;
            }
            if (interrupted()) { receipt('interrupted'); return false; }
            await bot.attack(entity);
            receipt(dead ? 'killed' : 'attack_attempted', dead ? 'target death confirmed' : 'hit/death unconfirmed');
            return !interrupted();
        }
        pvpStarted = true;
        await bot.pvp.attack(entity);
        while (!dead && !gone && !interrupted() && world.getNearbyEntities(bot, 24).some(sameTarget)) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        await stopOwnPvp();
        if (interrupted()) { receipt('interrupted'); return false; }
        if (!dead) {
            const distance = bot.entity.position.distanceTo(entity.position);
            const reason = gone ? 'gone' : distance > 24 ? 'distance' : 'not observed';
            receipt('lost', `${reason}; distance ${fmt(distance)}; death unconfirmed`);
            return false;
        }
        receipt('killed', 'target death confirmed');
        await pickupNearbyItems(bot);
        return !interrupted();
    } catch (error) {
        receipt(interrupted() ? 'interrupted' : 'error', interrupted() ? '' : error.message);
        if (interrupted()) return false;
        throw error;
    } finally {
        try { await stopOwnPvp(); }
        finally {
            bot.removeListener('entityDead', onDead);
            bot.removeListener('entityGone', onGone);
            bot.removeListener('health', onHealth);
        }
    }
}

export async function defendSelf(bot, range=9) {
    /**
     * Defend yourself from all nearby hostile mobs until there are no more.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} range, the range to look for mobs. Defaults to 8.
     * @returns {Promise<boolean>} true if the bot found any enemies and has killed them, false if no entities were found.
     * @example
     * await skills.defendSelf(bot);
     * **/
    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    let attacked = false;
    let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity) && world.isAlive(bot, entity), range);
    while (enemy) {
        await equipHighestAttack(bot);
        if (bot.entity.position.distanceTo(enemy.position) >= 4 && enemy.name !== 'creeper' && enemy.name !== 'phantom') {
            try {
                bot.pathfinder.setMovements(new pf.Movements(bot));
                await bot.pathfinder.goto(new pf.goals.GoalFollow(enemy, 3.5), true);
            } catch (err) {/* might error if entity dies, ignore */}
        }
        if (bot.entity.position.distanceTo(enemy.position) <= 2) {
            try {
                bot.pathfinder.setMovements(new pf.Movements(bot));
                let inverted_goal = new pf.goals.GoalInvert(new pf.goals.GoalFollow(enemy, 2));
                await bot.pathfinder.goto(inverted_goal, true);
            } catch (err) {/* might error if entity dies, ignore */}
        }
        bot.pvp.attack(enemy);
        attacked = true;
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity) && world.isAlive(bot, entity), range);
        if (bot.interrupt_code) {
            bot.pvp.stop();
            return false;
        }
    }
    bot.pvp.stop();
    if (attacked)
        log(bot, `Successfully defended self.`);
    else
        log(bot, `No enemies nearby to defend self from.`);
    return attacked;
}



async function collectStep(bot, stage, block, fn) {
    if (process.env.DAFEIYU_COLLECT_TRACE !== '1') return await fn();
    const started = Date.now();
    const trace = (state, error) => console.log('[collect-await]', JSON.stringify({
        at: Date.now(), stage, state, ms: Date.now() - started,
        block: block.name, target: block.position,
        feet: bot.entity.position, error: error?.name
    }));
    trace('begin');
    try {
        const value = await fn();
        trace('end');
        return value;
    } catch (error) {
        trace('error', error);
        throw error;
    }
}

async function _collectBlock(bot, blockType, num=1, exclude=null) {
    /**
     * Collect one of the given block type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to collect.
     * @param {number} num, the number of blocks to collect. Defaults to 1.
     * @param {list} exclude, a list of positions to exclude from the search. Defaults to null.
     * @returns {Promise<boolean>} true if the block was collected, false if the block type was not found.
     * @example
     * await skills.collectBlock(bot, "oak_log");
     **/
    if (num < 1) {
        log(bot, `Invalid number of blocks to collect: ${num}.`);
        return false;
    }
    let blocktypes = collectTargets(blockType);   // dafeiyu: shared with the measured facts (action_facts.js)
    const isLiquid = blockType === 'lava' || blockType === 'water';

    let collected = 0;

    const movements = new pf.Movements(bot);
    movements.dontMineUnderFallingBlock = false;
    movements.dontCreateFlow = true;

    // Blocks to ignore safety for, usually next to lava/water
    const unsafeBlocks = ['obsidian'];
    // owner 10-28 ("刚刚卡在原地"): up in an oak canopy, the nearest log failed with "Took too long to decide path" and the next round picked
    // the very same log - 84 s without a step. A block that failed is skipped from then on; three failures in a row end the action and say where.
    const unreachable = [];
    let failsInARow = 0;

    for (let i=0; i<num; i++) {
        // findBlocks hands the predicate a block without a position, so positions (exclude, unreachable) are filtered afterwards
        const skip = [...unreachable, ...(exclude || [])];
        let blocks = world.getNearestBlocksWhere(bot, block => {
            if (!blocktypes.includes(block.name)) {
                return false;
            }
            if (isLiquid) {
                // collect only source blocks
                return block.metadata === 0;
            }

            return movements.safeToBreak(block) || unsafeBlocks.includes(block.name);
        // owner 10-29 (screenshot "把自己房子拆了说玩家拆的"): asked for spruce_log beside the taiga house she had just built, this took
        // the logs of its own corner. A block of a house she built and has not given up is not something lying around to collect.
        }, 64, 64 + skip.length).filter((b) => b && !skip.some((p) => b.position.x === p.x && b.position.y === p.y && b.position.z === p.z)
            && !(bot.ownHouseBlock && bot.ownHouseBlock(b.position) !== undefined)).slice(0, 1);

        if (blocks.length === 0) {
            if (collected === 0)
                log(bot, `No ${blockType} nearby to collect.`);
            else
                log(bot, `No more ${blockType} nearby to collect.`);
            break;
        }
        const block = blocks[0];
        await collectStep(bot, 'equip', block, () => bot.tool.equipForBlock(block));
        if (isLiquid) {
            const bucket = bot.inventory.findInventoryItem('bucket');
            if (!bucket) {
                log(bot, `Don't have bucket to harvest ${blockType}.`);
                return false;
            }
            await collectStep(bot, 'equip-bucket', block, () => bot.equip(bucket, 'hand'));
        }
        const itemId = bot.heldItem ? bot.heldItem.type : null
        if (!block.canHarvest(itemId)) {
            log(bot, `Don't have right tools to harvest ${blockType}.`);
            return false;
        }
        try {
            let success = false;
            if (isLiquid) {
                success = await collectStep(bot, 'use-bucket', block, () => useToolOnBlock(bot, 'bucket', block));
            }
            else if (mc.mustCollectManually(blockType)) {
                await collectStep(bot, 'manual-goto', block, () => goToPosition(bot, block.position.x, block.position.y, block.position.z, 2));
                await collectStep(bot, 'manual-dig', block, () => bot.dig(block));
                await collectStep(bot, 'manual-pickup', block, () => pickupNearbyItems(bot));
                success = true;
            }
            else {
                await collectStep(bot, 'plugin', block, () => bot.collectBlock.collect(block));
                success = true;
            }
            if (success) {
                collected++;
                failsInARow = 0;
            }
            await collectStep(bot, 'auto-light', block, () => autoLight(bot));
        }
        catch (err) {
            if (err.name === 'NoChests') {
                log(bot, `Failed to collect ${blockType}: Inventory full, no place to deposit.`);
                break;
            }
            else {
                log(bot, `Failed to collect ${blockType} at ${block.position}: ${err}.`);
                unreachable.push(block.position.clone());
                if (++failsInARow >= 3 || unreachable.length >= num + 5) {
                    const p = bot.entity.position;
                    log(bot, `Stopped: ${failsInARow} ${blockType} in a row could not be reached (${unreachable.slice(-3).join(', ')}). You are at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}). ${bodyFact(bot)}`);
                    break;
                }
                i--;   // the failed one does not count; another block is tried instead
                continue;
            }
        }
        
        if (bot.interrupt_code)
            break;  
    }
    log(bot, `Collected ${collected} ${blockType}.`);
    return collected > 0;
}

// The table or furnace an action puts down for itself: a free cell beside her, or - at the bottom of a 1x1 shaft, where there is
// none - the cell over her head (10-29 lab: it aimed at her own feet, failed, and the craft threw raw recipe JSON at her).
// The cells right beside her come first: the "nearest free space" may be behind a wall (shaft test: put down outside the shaft, dug
// back through the wall, its drop left lying where she could not walk).
async function putDownForUse(bot, name, near, range, forItem) {
    const at = bot.entity.position, feet = at.floored(), over = feet.offset(0, 2, 0);
    // lab run 4: standing at x 14.27 her 0.6-wide body reached 0.03 into the cell beside her, the server refused the table there
    const body = (p) => p.x < at.x + 0.35 && p.x + 1 > at.x - 0.35 && p.z < at.z + 0.35 && p.z + 1 > at.z - 0.35;
    // grass, ferns and snow layers are replaced by a placed block (lab run 6: on a grassy spot no cell beside her counted, the table went
    // 2 blocks away and its drop was picked up only 9 s later)
    const free = (p) => !body(p) && /^(air|short_grass|tall_grass|grass|fern|dead_bush|snow)$/.test(bot.blockAt(p)?.name ?? '') && bot.blockAt(p.offset(0, -1, 0))?.boundingBox === 'block';
    const beside = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]].map(([dx, dz]) => feet.offset(dx, 0, dz)).filter(free);
    // over her head only when something beside or above that cell can hold it (lab run 2: in a 1-deep pit the cell over her head is
    // open on all sides, and the free ground right at the pit's edge was never tried)
    const rests = (p) => [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].some(([dx, dy, dz]) => bot.blockAt(p.offset(dx, dy, dz))?.boundingBox === 'block');
    const overOk = bot.blockAt(over)?.name === 'air' && rests(over);
    const spots = [...beside.slice(0, 3), ...(overOk ? [over] : []), world.getNearestFreeSpace(bot, 1, near)].filter(Boolean);
    let placed = null;
    for (const pos of spots) {   // a refused cell is not the end: the next one is tried
        await placeBlock(bot, name, pos.x, pos.y, pos.z);
        if ((placed = world.getNearestBlock(bot, name, range)) || bot.interrupt_code) break;
    }
    if (!placed) log(bot, `You have a ${name} but it could not be put down here${spots.length ? '' : ' (no free cell around you)'}, so ${forItem} was not made. Nothing was used up.`);
    return placed;
}

// owner 10-28: taking a crafting table back with collectBlock let the pathfinder dig through her bed beside it (white_bed (8, 86, 33)).
// Only the block this action put down comes back: walked to without digging, dug where it stands, its drop picked up the same way.
async function takeBackPlaced(bot, pos, name) {
    if (!pos || bot.blockAt(pos)?.name !== name) return false;
    const noDig = () => { const m = new pf.Movements(bot); m.canDig = false; m.allow1by1towers = false; m.scafoldingBlocks = []; return m; };
    if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4) {
        bot.pathfinder.setMovements(noDig());
        try { await bot.pathfinder.goto(new pf.goals.GoalNear(pos.x, pos.y, pos.z, 3)); } catch { /* reach is checked by dig */ }
    }
    const had = world.getInventoryCounts(bot)[name] || 0;
    // 10-29 shaft test: dug with whatever was in her hand, a furnace drops nothing without a pickaxe - it was simply gone
    const block = bot.blockAt(pos);
    if (bot.game.gameMode !== 'creative') {
        try { await bot.tool.equipForBlock(block); } catch { /* checked next */ }
        if (!block.canHarvest(bot.heldItem ? bot.heldItem.type : null)) {
            log(bot, `The ${name} you put down for this is still standing at ${pos}: breaking it without a pickaxe would destroy it, so it was left there.`);
            return false;
        }
    }
    try { await bot.dig(block); }
    catch (e) { log(bot, `Could not take the ${name} at ${pos} back: ${e.message}. It is still standing there.`); return false; }
    const drop = () => bot.nearestEntity((e) => e.name === 'item' && e.position.distanceTo(pos) < 3);
    const back = () => (world.getInventoryCounts(bot)[name] || 0) > had;
    // 10-29 lab: the drop shows up a tick or two after the dig; looked for at once, it was not there yet and the table was left lying
    for (let t = 0; t < 20 && !drop() && !back(); t++) await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 8 && drop() && !bot.interrupt_code; i++) {
        const d = drop();
        bot.pathfinder.setMovements(noDig());
        try { await bot.pathfinder.goto(new pf.goals.GoalNear(d.position.x, d.position.y, d.position.z, 1)); } catch { /* try again or give up */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    for (let t = 0; t < 10 && !back() && !drop(); t++) await new Promise((r) => setTimeout(r, 100));   // picked up, bag not updated yet
    // 10-28 house test: dug off a wall top, the table fell where she could not walk, and nothing was said
    if (!back()) {
        const d = drop(), at = d ? d.position.floored() : pos;
        log(bot, `The ${name} you put down for this was dug back up but is not in your bag: it is lying on the ground near ${at}.`);
        return false;
    }
    return true;
}

export async function pickupNearbyItems(bot) {
    /**
     * Pick up all nearby items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the items were picked up, false otherwise.
     * @example
     * await skills.pickupNearbyItems(bot);
     **/
    const distance = 8;
    const getNearestItem = bot => bot.nearestEntity(entity => entity.name === 'item' && bot.entity.position.distanceTo(entity.position) < distance);
    let nearestItem = getNearestItem(bot);
    let pickedUp = 0;
    while (nearestItem) {
        let movements = new pf.Movements(bot);
        movements.canDig = false;
        bot.pathfinder.setMovements(movements);
        if (!await goToGoal(bot, new pf.goals.GoalFollow(nearestItem, 1))) return false;
        await new Promise(resolve => setTimeout(resolve, 200));
        let prev = nearestItem;
        nearestItem = getNearestItem(bot);
        if (prev === nearestItem) {
            break;
        }
        pickedUp++;
    }
    log(bot, `Picked up ${pickedUp} items.`);
    return true;
}


async function _breakBlockAt(bot, x, y, z) {
    /**
     * Break the block at the given position. Will use the bot's equipped item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate of the block to break.
     * @param {number} y, the y coordinate of the block to break.
     * @param {number} z, the z coordinate of the block to break.
     * @returns {Promise<boolean>} true if the block was broken, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.breakBlockAt(bot, position.x, position.y - 1, position.x);
     **/
    if (x == null || y == null || z == null) throw new Error('Invalid position to break block at.');
    let block = bot.blockAt(Vec3(x, y, z));
    if (block.name !== 'air' && block.name !== 'water' && block.name !== 'lava') {
        if (bot.modes.isOn('cheat')) {
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            let msg = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' air';
            bot.chat(msg);
            log(bot, `Used /setblock to break block at ${x}, ${y}, ${z}.`);
            return true;
        }

        if (bot.entity.position.distanceTo(block.position) > 4.5) {
            let pos = block.position;
            let movements = new pf.Movements(bot);
            movements.canPlaceOn = false;
            movements.allow1by1towers = false;
            bot.pathfinder.setMovements(movements);
            if (!await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4))) return false;
        }
        if (bot.game.gameMode !== 'creative') {
            await bot.tool.equipForBlock(block);
            const itemId = bot.heldItem ? bot.heldItem.type : null
            if (!block.canHarvest(itemId)) {
                log(bot, `Don't have right tools to break ${block.name}.`);
                return false;
            }
        }
        await bot.dig(block, true);
        log(bot, `Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    else {
        log(bot, `Skipping block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} because it is ${block.name}.`);
        return false;
    }
    return true;
}


// final-112b 13:4x: !placeHere stepped her aside 3 blocks down into deep water; the receipt named only the block, she said "站高了" and
// drowned standing still. Where she ended up, and whether her head is under water, is part of the receipt.
function whereYouAre(bot) {
    const p = bot.entity?.position;
    if (!p) return '';
    const head = bot.blockAt(p.offset(0, 1.62, 0));
    const wet = !!head && (head.name === 'water' || head.name === 'bubble_column' || !!head.getProperties?.().waterlogged);
    return ` You are now at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})${wet ? `, and your head is under water (air ${Math.round(bot.oxygenLevel ?? 20)}/20)` : ''}.`;
}

async function _placeBlock(bot, blockType, x, y, z, placeOn='bottom', dontCheat=false) {
    /**
     * Place the given block type at the given position. It will build off from any adjacent blocks. Will fail if there is a block in the way or nothing to build off of.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to place, which can be a block or item name.
     * @param {number} x, the x coordinate of the block to place.
     * @param {number} y, the y coordinate of the block to place.
     * @param {number} z, the z coordinate of the block to place.
     * @param {string} placeOn, the preferred side of the block to place on. Can be 'top', 'bottom', 'north', 'south', 'east', 'west', or 'side'. Defaults to bottom. Will place on first available side if not possible.
     * @param {boolean} dontCheat, overrides cheat mode to place the block normally. Defaults to false.
     * @returns {Promise<boolean>} true if the block was placed, false otherwise.
     * @example
     * let p = world.getPosition(bot);
     * await skills.placeBlock(bot, "oak_log", p.x + 2, p.y, p.x);
     * await skills.placeBlock(bot, "torch", p.x + 1, p.y, p.x, 'side');
     **/
    const target_dest = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));

    if (blockType === 'air') {
        log(bot, `Placing air (removing block) at ${target_dest}.`);
        return await breakBlockAt(bot, x, y, z);
    }

    if (bot.modes.isOn('cheat') && !dontCheat) {
        if (bot.restrict_to_inventory) {
            let block = bot.inventory.findInventoryItem(blockType);
            if (!block) {
                log(bot, `Cannot place ${blockType}, you are restricted to your current inventory.`);
                return false;
            }
        }

        // invert the facing direction
        let face = placeOn === 'north' ? 'south' : placeOn === 'south' ? 'north' : placeOn === 'east' ? 'west' : 'east';
        if (blockType.includes('torch') && placeOn !== 'bottom') {
            // insert wall_ before torch
            blockType = blockType.replace('torch', 'wall_torch');
            if (placeOn !== 'side' && placeOn !== 'top') {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType.includes('button') || blockType === 'lever') {
            if (placeOn === 'top') {
                blockType += `[face=ceiling]`;
            }
            else if (placeOn === 'bottom') {
                blockType += `[face=floor]`;
            }
            else {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType === 'ladder' || blockType === 'repeater' || blockType === 'comparator') {
            blockType += `[facing=${face}]`;
        }
        if (blockType.includes('stairs')) {
            blockType += `[facing=${face}]`;
        }
        if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
        let msg = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' ' + blockType;
        bot.chat(msg);
        if (blockType.includes('door'))
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y+1) + ' ' + Math.floor(z) + ' ' + blockType + '[half=upper]');
        if (blockType.includes('bed'))
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z-1) + ' ' + blockType + '[part=head]');
        log(bot, `Used /setblock to place ${blockType} at ${target_dest}.`);
        return true;
    }

    let item_name = blockType;
    if (item_name == "redstone_wire")
        item_name = "redstone";
    else if (item_name === 'water') {
        item_name = 'water_bucket';
    }
    else if (item_name === 'lava') {
        item_name = 'lava_bucket';
    }
    let block_item = bot.inventory.findInventoryItem(item_name);
    if (!block_item && bot.game.gameMode === 'creative' && !bot.restrict_to_inventory) {
        await bot.creative.setInventorySlot(36, mc.makeItem(item_name, 1)); // 36 is first hotbar slot
        block_item = bot.inventory.findInventoryItem(item_name);
    }
    if (!block_item) {
        log(bot, `Don't have any ${item_name} to place.`);
        return false;
    }

    const targetBlock = bot.blockAt(target_dest);
    if (targetBlock.name === blockType || (targetBlock.name === 'grass_block' && blockType === 'dirt')) {
        // 21 of her 176 torch placements failed, most with this line - she stayed in one spot and placed again, then concluded "火把插石砖不行"
        log(bot, `${blockType} already at ${targetBlock.position} - that cell already has one. Move to another spot first, then place.`);
        return false;
    }
    const empty_blocks = ['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern'];
    if (!empty_blocks.includes(targetBlock.name)) {
        log(bot, `${targetBlock.name} in the way at ${targetBlock.position}.`);
        const removed = await breakBlockAt(bot, x, y, z);
        if (!removed) {
            log(bot, `Cannot place ${blockType} at ${targetBlock.position}: block in the way.`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 200)); // wait for block to break
    }
    // get the buildoffblock and facevec based on whichever adjacent block is not empty
    let buildOffBlock = null;
    let faceVec = null;
    const dir_map = {
        'top': Vec3(0, 1, 0),
        'bottom': Vec3(0, -1, 0),
        'north': Vec3(0, 0, -1),
        'south': Vec3(0, 0, 1),
        'east': Vec3(1, 0, 0),
        'west': Vec3(-1, 0, 0),
    }
    let dirs = [];
    if (placeOn === 'side') {
        dirs.push(dir_map['north'], dir_map['south'], dir_map['east'], dir_map['west']);
    }
    else if (dir_map[placeOn] !== undefined) {
        dirs.push(dir_map[placeOn]);
    }
    else {
        dirs.push(dir_map['bottom']);
        log(bot, `Unknown placeOn value "${placeOn}". Defaulting to bottom.`);
    }
    dirs.push(...Object.values(dir_map).filter(d => !dirs.includes(d)));

    for (let d of dirs) {
        const block = bot.blockAt(target_dest.plus(d));
        if (!empty_blocks.includes(block.name)) {
            buildOffBlock = block;
            faceVec = new Vec3(-d.x, -d.y, -d.z); // invert
            break;
        }
    }
    if (!buildOffBlock) {
        // DeepSeek #3729 (13:26): nine cells in a row came back "nothing to place on", nine identical lines and no hint of one that works.
        // The nearest free cell within 2 that touches a solid block is named - where to build is still hers.
        const touches = (p) => Object.values(dir_map).some((d) => !empty_blocks.includes(bot.blockAt(p.plus(d))?.name));
        let near = null;
        for (let r = 1; r <= 2 && !near; r++)
            for (let dx = -r; dx <= r && !near; dx++) for (let dy = -r; dy <= r && !near; dy++) for (let dz = -r; dz <= r && !near; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
                const p = target_dest.offset(dx, dy, dz), here = bot.blockAt(p);
                if (here && empty_blocks.includes(here.name) && touches(p)) near = p;
            }
        // DeepSeek #3817 (16:30): in a pit 2 deep her head was level with the ground, so the lid cell above it touched nothing; she died there.
        const me = bot.entity?.position?.floored?.();
        const overHead = me && target_dest.x === me.x && target_dest.z === me.z && target_dest.y === me.y + 2;
        log(bot, `Cannot place ${blockType} at ${targetBlock.position}: nothing to place on (no solid block touches that cell).`
            + (overHead ? ` That cell is right above your head, and your head is level with the ground around you, so a lid there has nothing beside it to rest on. Dig one more block down first: then the cell above your head is level with the ground and a block there rests on its sides.`
                : near ? ` The nearest free cell that touches one is (${near.x}, ${near.y}, ${near.z}).` : ' No free cell within 2 blocks touches a solid block either.'));
        return false;
    }

    const pos = bot.entity.position;
    const pos_above = pos.plus(Vec3(0,1,0));
    const dont_move_for = ['torch', 'redstone_torch', 'redstone', 'lever', 'button', 'rail', 'detector_rail', 
        'powered_rail', 'activator_rail', 'tripwire_hook', 'tripwire', 'water_bucket', 'string'];
    if (!dont_move_for.includes(item_name) && (pos.distanceTo(targetBlock.position) < 1.1 || pos_above.distanceTo(targetBlock.position) < 1.1)) {
        // too close
        let goal = new pf.goals.GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2);
        let inverted_goal = new pf.goals.GoalInvert(goal);
        // Stepping aside only walks. 2026-10-27 final-36: allowed to build, it pillared up on dirt/cobblestone, filling the very
        // cell she wanted (her own feet) - 3 crafting tables failed in a row, y 53 -> 62, 2 blocks spent each time.
        const stepAside = new pf.Movements(bot);
        stepAside.allow1by1towers = false;
        stepAside.scafoldingBlocks = [];
        stepAside.canDig = false;
        // owner 10-28: stepping aside to put cobblestone in a doorway she walked into the 4-deep hole she had dug in her floor
        stepAside.maxDropDown = 1;
        bot.pathfinder.setMovements(stepAside);
        // goto() also resolves without moving when no path exists (an empty "noPath" result), so look where she ended up.
        // 2026-10-27 02:00: at the bottom of her own 1x1 shaft every !placeHere just said "Failed" and she suspected a protected zone.
        try { await bot.pathfinder.goto(inverted_goal); } catch { /* checked below */ }
        // Her body (0.6 wide, 1.8 tall) really in that cell - not the "too close" guess above, which measures to the cell's corner
        // and at 02:2x called the cell beside her head "the cell your head is in". Only a cell her body is in cannot take a block.
        const p = bot.entity.position;
        const inBody = p.x + 0.3 > target_dest.x && p.x - 0.3 < target_dest.x + 1 && p.z + 0.3 > target_dest.z && p.z - 0.3 < target_dest.z + 1
            && p.y + 1.8 > target_dest.y && p.y < target_dest.y + 1;
        if (inBody) {
            // 02:1x she aimed her own code at "头顶那一格" = the cell her head is in, and read "the cell you are standing in" as a mistake
            // 05:4x she said "我踩在33" with her feet in y=32: the block she stands ON is one lower - say both
            const feet = p.floored(), under = feet.offset(0, -1, 0), underName = bot.blockAt(under)?.name || 'unknown';
            const part = (target_dest.y > feet.y ? `your head is in (your feet are at ${feet}; you are 2 blocks tall)` : 'your feet are in')
                + `; the block you stand on is ${under} (${underName})`;
            // 04:2x she kept using !placeHere "封顶" (to cover her head) and blamed the material - the point now comes first
            log(bot, `Cannot place ${blockType} at ${target_dest}: that is the cell ${part}, and a block cannot go where your body is (no room to step 2 blocks away without digging or building). `
                + `!placeHere can never cover your head - it always aims at your own feet, whatever the block. `
                + `The free cell above your head is ${feet.offset(0, 2, 0)}: a block there needs your own code (skills.placeBlock with those coordinates); !pillarUp raises you by placing under your feet.`);
            return false;
        }
        const now = bot.blockAt(target_dest);
        if (!empty_blocks.includes(now?.name)) {
            log(bot, `Cannot place ${blockType} at ${target_dest}: while you stepped aside it became ${now?.name}.`);
            return false;
        }
    }
    if (bot.entity.position.distanceTo(targetBlock.position) > 4.5) {
        // too far
        let pos = targetBlock.position;
        let movements = new pf.Movements(bot);
        bot.pathfinder.setMovements(movements);
        if (!await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4))) return false;
    }

    // will throw error if an entity is in the way, and sometimes even if the block was placed
    try {
        if (item_name.includes('bucket')) {
            await useToolOnBlock(bot, item_name, buildOffBlock);
        }
        else {
            await bot.equip(block_item, 'hand');
            // owner 10-28: she has no way to turn, so a bed pointed wherever she happened to face - four tries before one fitted. A bed
            // points away from where she looks at it from (the server checks that she really looks at the cell, so turning alone fails):
            // if that side has no room, she first walks round to a side that does - walking only, nothing dug.
            if (blockType.endsWith('_bed')) {
                const sides = [['east', 1, 0], ['south', 0, 1], ['west', -1, 0], ['north', 0, -1]];
                const roomFor = (c) => { const n = bot.blockAt(c)?.name; return empty_blocks.includes(n) && n !== 'water' && n !== 'lava'; };
                const standOn = (c) => roomFor(c) && roomFor(c.offset(0, 1, 0)) && bot.blockAt(c.offset(0, -1, 0))?.boundingBox === 'block';
                const me = bot.entity.position, tx = target_dest.x + 0.5 - me.x, tz = target_dest.z + 0.5 - me.z;
                const willFace = Math.abs(tx) > Math.abs(tz) ? (tx > 0 ? 'east' : 'west') : (tz > 0 ? 'south' : 'north');
                const fits = ([, dx, dz]) => roomFor(target_dest.offset(dx, 0, dz));
                if (!fits(sides.find(([s]) => s === willFace))) {
                    const side = sides.find((s) => fits(s) && standOn(target_dest.offset(-s[1], 0, -s[2])));
                    if (side) {
                        const spot = target_dest.offset(-side[1], 0, -side[2]);
                        const walk = new pf.Movements(bot); walk.canDig = false; walk.allow1by1towers = false; walk.scafoldingBlocks = []; walk.maxDropDown = 1;
                        bot.pathfinder.setMovements(walk);
                        try { await bot.pathfinder.goto(new pf.goals.GoalBlock(spot.x, spot.y, spot.z)); } catch { /* placed from where she is */ }
                    }
                }
            }
            await bot.lookAt(buildOffBlock.position.offset(0.5, 0.5, 0.5));
            // 10-29 lab run 4: placed against a crafting table, the click opened the table instead and the smoker never went down;
            // like a player, sneak while placing on something that opens
            const opens = /(crafting_table|furnace|smoker|chest|barrel|shulker_box|_door|_trapdoor|_fence_gate|_bed|anvil|lectern|loom|stonecutter|grindstone|cartography_table|smithing_table|brewing_stand|enchanting_table|beacon|hopper|dispenser|dropper|crafter|note_block|_button|lever|repeater|comparator)$/.test(buildOffBlock.name);
            if (opens) { bot.setControlState('sneak', true); await bot.waitForTicks(2); }
            try { await bot.placeBlock(buildOffBlock, faceVec); }
            finally { if (opens) bot.setControlState('sneak', false); }
            let bedNote = '';
            const placedBed = blockType.endsWith('_bed') && bot.blockAt(target_dest)?.getProperties?.();
            if (placedBed?.facing) {
                const d = { east: [1, 0], south: [0, 1], west: [-1, 0], north: [0, -1] }[placedBed.facing], other = placedBed.part === 'head' ? -1 : 1;
                if (d) bedNote = ` The bed points ${placedBed.facing}: its other half is at ${target_dest.offset(d[0] * other, 0, d[1] * other)}.`;
            }
            log(bot, `Placed ${blockType} at ${target_dest}.${bedNote}` + whereYouAre(bot));
            await new Promise(resolve => setTimeout(resolve, 200));
            return true;
        }
    } catch (err) {
        // 2026-10-27 final-33: the server answered after mineflayer's 500 ms wait, so three "Failed to place cobblestone" cells were
        // cobblestone in the world and the -1 in her bag was real (DeepSeek #3573: "放不下去，扣的却是…"). Look before saying it failed.
        for (let i = 0; i < 6 && bot.blockAt(target_dest)?.name !== blockType; i++)
            await new Promise(resolve => setTimeout(resolve, 250));
        if (bot.blockAt(target_dest)?.name === blockType) {
            log(bot, `Placed ${blockType} at ${target_dest} (the server confirmed it late).` + whereYouAre(bot));
            return true;
        }
        const there = bot.blockAt(target_dest)?.name;
        // 2026-10-27 final-41/42: two birch saplings failed on cobblestone and stone; she guessed "被挡住了？"
        const ground = blockType.endsWith('_sapling') ? bot.blockAt(target_dest.offset(0, -1, 0))?.name : null;
        // 03:4x final-45: a purple bed failed between cobblestone, cobblestone and a chest; she read it as "地不平"
        const bedRoom = blockType.endsWith('_bed') ? [['east', 1, 0], ['west', -1, 0], ['south', 0, 1], ['north', 0, -1]]
            .filter(([, dx, dz]) => empty_blocks.includes(bot.blockAt(target_dest.offset(dx, 0, dz))?.name)).map(([side, dx, dz]) => `${side} ${target_dest.offset(dx, 0, dz)}`) : null;
        // 04:4x final-47: three beds failed with empty cells listed beside each - the one that mattered was the cell in the way she faced
        // (yaw 0 = north/-z, turning left as it grows - the same reading as cave-house.js facingOf)
        let bedFacing = '';
        if (bedRoom && Number.isFinite(bot.entity?.yaw)) {
            const fx = -Math.sin(bot.entity.yaw), fz = -Math.cos(bot.entity.yaw);
            const [side, dx, dz] = Math.abs(fx) > Math.abs(fz) ? (fx > 0 ? ['east', 1, 0] : ['west', -1, 0]) : (fz > 0 ? ['south', 0, 1] : ['north', 0, -1]);
            const head = target_dest.offset(dx, 0, dz), what = bot.blockAt(head)?.name || 'unknown';
            bedFacing = ` You were facing ${side}, so its other half needed ${head}, which ${empty_blocks.includes(what) ? 'is empty' : `holds ${what}`}.`;
        }
        log(bot, `Failed to place ${blockType} at ${target_dest}.` + (there && !empty_blocks.includes(there) ? ` That cell now holds ${there}.` : '')
            + (ground ? ` A sapling only grows on dirt, grass_block, podzol, coarse_dirt, rooted_dirt, moss_block or mud; the block under that cell is ${ground}.` : '')
            + (bedRoom ? ` A bed takes 2 cells side by side: that one and the next one in the direction you face when placing it. Empty cells beside it: ${bedRoom.length ? bedRoom.join(', ') : 'none'}.${bedFacing}` : '')
            // 10-29 lab B3: twice "Failed to place oak_door" in a doorway - she stood on an oak_stairs step, and a door stands only on a full block
            + (blockType.endsWith('_door') ? (() => { const under = bot.blockAt(target_dest.offset(0, -1, 0)), above = bot.blockAt(target_dest.offset(0, 1, 0))?.name;
                return ` A door is 2 blocks tall and stands on a full block: under that cell is ${under?.name ?? 'unknown'}${under && (under.boundingBox !== 'block' || /_(stairs|slab)$|path$|farmland/.test(under.name)) ? ' (not a full block)' : ''}, above it is ${above ?? 'unknown'}.`; })() : '')
            + (blockType.endsWith('torch')
            ? ' A torch goes on the top or side of most solid blocks (stone bricks included), not on glass, leaves, another torch, or in water; try a different spot next to a solid block.'
            : ''));
        return false;
    }
}

export async function equip(bot, itemName) {
    /**
     * Equip the given item to the proper body part, like tools or armor.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to equip.
     * @returns {Promise<boolean>} true if the item was equipped, false otherwise.
     * @example
     * await skills.equip(bot, "iron_pickaxe");
     **/
    if (itemName === 'hand') {
        await bot.unequip('hand');
        log(bot, `Unequipped hand.`);
        return true;
    }
    let item = bot.inventory.slots.find(slot => slot && slot.name === itemName);
    if (!item) {
        if (bot.game.gameMode === "creative") {
            await bot.creative.setInventorySlot(36, mc.makeItem(itemName, 1));
            item = bot.inventory.findInventoryItem(itemName);
        }
        else {
            log(bot, `You do not have any ${itemName} to equip.`);
            return false;
        }
    }
    if (itemName.includes('leggings')) {
        await bot.equip(item, 'legs');
    }
    else if (itemName.includes('boots')) {
        await bot.equip(item, 'feet');
    }
    else if (itemName.includes('helmet')) {
        await bot.equip(item, 'head');
    }
    else if (itemName.includes('chestplate') || itemName.includes('elytra')) {
        await bot.equip(item, 'torso');
    }
    else if (itemName.includes('shield')) {
        await bot.equip(item, 'off-hand');
    }
    else {
        await bot.equip(item, 'hand');
    }
    log(bot, `Equipped ${itemName}.`);
    return true;
}

export async function discard(bot, itemName, num=-1) {
    /**
     * Discard the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to discard.
     * @param {number} num, the number of items to discard. Defaults to -1, which discards all items.
     * @returns {Promise<boolean>} true if the item was discarded, false otherwise.
     * @example
     * await skills.discard(bot, "oak_log");
     **/
    if (bot.currentWindow) await bot.closeWindow(bot.currentWindow);
    if (bot._syncWindow) await bot._syncWindow(bot.inventory);
    const before = bot.inventory.items().filter(i => i.name === itemName).reduce((n,i) => n+i.count,0);
    const target = num === -1 ? before : Math.min(num,before);
    let discarded = 0;
    const existing = new Set(Object.values(bot.entities).map(e=>e.id)), drops = new Map(), origins = [];
    const dropped = entity => {
        if (existing.has(entity.id)) return;
        let item;try {item=entity.getDroppedItem?.();}catch{return;}
        if(item?.name===itemName&&origins.some(p=>entity.position.distanceTo(p)<=3)) {
            drops.set(entity.id,entity);bot.ignoredItems?.add(entity.id);
        }
    };
    bot.on('itemDrop',dropped);
    try { while (discarded < target) {
        let item = bot.inventory.findInventoryItem(itemName);
        if (!item) {
            break;
        }
        let to_discard = Math.min(target - discarded,item.count);
        const origin = bot.entity.position.clone();origins.push(origin);
        await bot.toss(item.type, item.metadata, to_discard);
        discarded += to_discard;
        if (bot._syncWindow) await bot._syncWindow(bot.inventory);
        if (!await stepAwayFromDrops(bot,[...drops.values()],origin)) {
            log(bot, `Tossed ${discarded} ${itemName}. 丢在脚下了，附近没有已确认可安全撤离的位置，可能会被自动吸回来。先换个地方或存箱。`);
            return false;
        }
    } } finally {bot.off('itemDrop',dropped);}
    if (discarded === 0) {
        log(bot, `You do not have any ${itemName} to discard.`);
        return false;
    }
    if (bot._syncWindow) await bot._syncWindow(bot.inventory);
    const after = bot.inventory.items().filter(i=>i.name===itemName).reduce((n,i)=>n+i.count,0);
    if (after > before-discarded) {
        log(bot, `Tossed ${discarded} ${itemName}, but the inventory grew again (${before} to ${after}). Nearby items may have been picked up; leave this area or use a chest.`);
        return false;
    }
    // bow arena 10-26, her words: "「-1 stone_pickaxe」…没说扔在哪、要不要捡回来，我得自己猜" - where it lies and for how long
    const at = origins[origins.length - 1];
    log(bot, `Discarded ${discarded} ${itemName}; inventory now ${after}. It lies on the ground at (${Math.floor(at.x)}, ${Math.floor(at.y)}, ${Math.floor(at.z)}) and disappears after about 5 minutes; walking over it picks it up again if you have room. Moved away from the dropped items.`);
    return true;
}

async function _putInChest(bot, itemName, num=-1) {
    /**
     * Put the given item in the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to put in the chest.
     * @param {number} num, the number of items to put in the chest. Defaults to -1, which puts all items.
     * @returns {Promise<boolean>} true if the item was put in the chest, false otherwise.
     * @example
     * await skills.putInChest(bot, "oak_log");
     **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    let item = bot.inventory.findInventoryItem(itemName);
    if (!item) {
        log(bot, `You do not have any ${itemName} to put in the chest.`);
        return false;
    }
    // final-115b: !putInChest("cobblestone", 20) put 13 - only the first stack was counted, not all of that item in the bag
    const have = bot.inventory.count(item.type, null);
    let to_put = num === -1 ? have : Math.min(num, have);
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer = await bot.openContainer(chest);
    // final-7 and final-31: twice the window that came back had no deposit ("chestContainer.deposit is not a function") - say so instead of a crash
    if (typeof chestContainer?.deposit !== 'function') { try { chestContainer?.close?.(); } catch { /* not open */ } log(bot, `The chest did not open properly (another window came up instead). Try again.`); return false; }
    await chestContainer.deposit(item.type, null, to_put);
    await chestContainer.close();
    log(bot, `Successfully put ${to_put} ${itemName} in the chest.`);
    return true;
}

async function _takeFromChest(bot, itemName, num=-1) {
    /**
     * Take the given item from the nearest chest, potentially from multiple slots.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to take from the chest.
     * @param {number} num, the number of items to take from the chest. Defaults to -1, which takes all items.
     * @returns {Promise<boolean>} true if the item was taken from the chest, false otherwise.
     * @example
     * await skills.takeFromChest(bot, "oak_log");
     * **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer = await bot.openContainer(chest);
    // final-7 and final-31: twice the window that came back had no containerItems ("chestContainer.containerItems is not a function") - say so instead of a crash
    if (typeof chestContainer?.containerItems !== 'function') { try { chestContainer?.close?.(); } catch { /* not open */ } log(bot, `The chest did not open properly (another window came up instead). Try again.`); return false; }
    
    // Find all matching items in the chest
    let matchingItems = chestContainer.containerItems().filter(item => item.name === itemName);
    if (matchingItems.length === 0) {
        log(bot, `Could not find any ${itemName} in the chest.`);
        await chestContainer.close();
        return false;
    }
    
    let totalAvailable = matchingItems.reduce((sum, item) => sum + item.count, 0);
    let remaining = num === -1 ? totalAvailable : Math.min(num, totalAvailable);
    let totalTaken = 0;
    
    // Take items from each slot until we've taken enough or run out
    for (const item of matchingItems) {
        if (remaining <= 0) break;
        
        let toTakeFromSlot = Math.min(remaining, item.count);
        await chestContainer.withdraw(item.type, null, toTakeFromSlot);
        
        totalTaken += toTakeFromSlot;
        remaining -= toTakeFromSlot;
    }
    
    await chestContainer.close();
    log(bot, `Successfully took ${totalTaken} ${itemName} from the chest.`);
    return totalTaken > 0;
}

export async function viewChest(bot) {
    /**
     * View the contents of the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the chest was viewed, false otherwise.
     * @example
     * await skills.viewChest(bot);
     * **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    const gotoResult=await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    // Diagnostic only: still open the same observed chest after the same goto, regardless of its result.
    const chestNow=bot.blockAt(chest.position),distanceNow=bot.entity.position.distanceTo(chest.position);
    log(bot, `[viewChest诊断] 打开前目标=(${chest.position.x},${chest.position.y},${chest.position.z})；缓存块型=${chest.name??'未知'}；当帧块型=${chestNow?.name??'未知'}；距离=${distanceNow}；goto结果=${String(gotoResult)}。`);
    const chestContainer = await bot.openContainer(chest);
    // final-7 and final-31: twice the window that came back had no containerItems ("chestContainer.containerItems is not a function") - say so instead of a crash
    if (typeof chestContainer?.containerItems !== 'function') { try { chestContainer?.close?.(); } catch { /* not open */ } log(bot, `The chest did not open properly (another window came up instead). Try again.`); return false; }
    let items = chestContainer.containerItems();
    if (items.length === 0) {
        log(bot, `The chest is empty.`);
    }
    else {
        log(bot, `The chest contains:`);
        for (let item of items) {
            log(bot, `${item.count} ${item.name}`);
        }
    }
    await chestContainer.close();
    return true;
}

const RAW_TO_COOKED = { porkchop: 'cooked_porkchop', beef: 'cooked_beef', chicken: 'cooked_chicken', mutton: 'cooked_mutton', rabbit: 'cooked_rabbit',
    cod: 'cooked_cod', salmon: 'cooked_salmon', potato: 'baked_potato' };

async function _consume(bot, itemName="") {
    /**
     * Eat/drink the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item to eat/drink.
     * @returns {Promise<boolean>} true if the item was eaten, false otherwise.
     * @example
     * await skills.eat(bot, "apple");
     **/
    let item, name;
    if (itemName) {
        item = bot.inventory.findInventoryItem(itemName);
        name = itemName;
    }
    if (!item) {
        log(bot, `You do not have any ${name} to eat.`);
        return false;
    }
    // 2026-10-27 06:29-06:32 (DeepSeek #3634): three tries of brown_mushroom at 3 HP, each a 2.5 s "Promise timed out", and she was left
    // with "蘑菇跟我有仇". What the game cannot eat is said at once.
    const drinkable = /(^|_)potion$|^milk_bucket$|^honey_bottle$|^ominous_bottle$/.test(item.name);
    if (!drinkable && bot.registry?.foodsByName && !bot.registry.foodsByName[item.name]) {
        // 10:58 / 11:00 she tried wheat twice (DeepSeek #3674): what it becomes is said the same way as for mushrooms
        const stew = /^(brown|red)_mushroom$/.test(item.name) ? ' Mushrooms are eaten as mushroom_stew: a brown and a red mushroom with a bowl, crafted.'
            : item.name === 'wheat' ? ' Wheat is eaten as bread: 3 wheat in a row, crafted (!craftRecipe("bread", 1)).' : '';
        log(bot, `${item.name} cannot be eaten or drunk - it is not food in this game, so nothing happened.${stew}`);
        return false;
    }
    // 07:07:55 a second porkchop right after the first hung 2.5 s and timed out: at hunger 20 the game does not let most food be eaten
    const anyTime = drinkable || /^(golden_apple|enchanted_golden_apple|chorus_fruit|suspicious_stew)$/.test(item.name);
    if (!anyTime && bot.food >= 20) {
        log(bot, `You are full (hunger ${bot.food}/20), and the game does not let you eat ${item.name} when full, so nothing happened. Health regenerates by itself while hunger is 18 or more.`);
        return false;
    }
    const foodBefore = bot.food;
    await bot.equip(item, 'hand');
    // final-100 01:47: eating at 6.6 HP, a creeper lit its fuse 3 blocks off; the dodge waited until she had finished eating (1.8 s, longer than
    // the 1.5 s fuse) and began 0.18 s before the blast. A stop request ends the wait at once and lets go of the food.
    let stopPoll;
    const ended = await Promise.race([bot.consume().then(() => 'ate'),
        new Promise((resolve) => { stopPoll = setInterval(() => { if (bot.interrupt_code) resolve('interrupted'); }, 100); })])
        .finally(() => clearInterval(stopPoll));
    if (ended === 'interrupted') {
        try { bot.deactivateItem?.(); } catch { /* a stale run's packet is dropped anyway */ }
        log(bot, `Stopped eating ${item.name} - something more urgent came first.`);
        return false;
    }
    // the server's hunger update lands a moment after consume() resolves (final-30: "Hunger 17 -> 17" right after eating) - wait for it, briefly
    for (let t = 0; t < 12 && bot.food === foodBefore && foodBefore < 20; t++) await new Promise((resolve) => setTimeout(resolve, 50));
    // final-25..29: she ate raw porkchop at hunger 17 and concluded "猪排填肚子不回血". Two game facts: health only regenerates at hunger 18+,
    // and cooked meat fills far more than raw.
    const foods = bot.registry?.foodsByName || {}, cooked = RAW_TO_COOKED[item.name];
    const more = cooked && foods[cooked] && foods[item.name] ? ` Cooked (${cooked}, in a furnace or smoker) it would have given ${foods[cooked].foodPoints} hunger instead of ${foods[item.name].foodPoints}.` : '';
    // final-30: rotten flesh three times in a row, 17 -> 20 each time - it usually brings the Hunger effect, which drains hunger straight back
    const side = { rotten_flesh: ' Rotten flesh gives the Hunger effect most of the time (about 80%): your hunger drains quickly for 30 seconds afterwards, so it often falls straight back.',
        spider_eye: ' Spider eye poisons you (loses health for a few seconds).', poisonous_potato: ' A poisonous potato can poison you.' }[item.name] || '';
    log(bot, `Consumed ${item.name}. Hunger ${Math.round(foodBefore ?? 0)} -> ${Math.round(bot.food ?? 0)} / 20; health regenerates by itself only while hunger is 18 or more${bot.food >= 18 ? ' (it is now)' : ' (not yet)'}.${more}${side}`);
    return true;
}


async function _giveToPlayer(bot, itemType, username, num=1) {
    /**
     * Give items to a nearby player; success requires collection of the actual tossed item entities.
     * @param {MinecraftBot} bot
     * @param {string} itemType - item name
     * @param {string} username - recipient
     * @param {number} num - count, or -1 for all matching inventory items
     * @returns {Promise<boolean>} true only when the intended player collected the tossed items
     */
    if (bot.username === username) {
        log(bot, 'You cannot give items to yourself.');
        return false;
    }
    if (!bot.players[username]?.entity) {
        log(bot, 'Could not find ' + username + '.');
        return false;
    }
    if (bot.currentWindow) await bot.closeWindow(bot.currentWindow);
    const items = bot.inventory.items().filter(item => item.name === itemType);
    const available = items.reduce((n,item) => n + item.count,0);
    const count = num === -1 ? available : num;
    if (!Number.isInteger(count) || count < 1 || available < count) {
        log(bot, 'Cannot give ' + num + ' ' + itemType + ': inventory contains ' + available + '.');
        return false;
    }
    if (!await goToPlayer(bot,username,2)) {
        log(bot, 'Could not get close enough to hand over ' + itemType + '; nothing was tossed.');
        return false;
    }
    const player = bot.players[username]?.entity;
    if (!player || bot.entity.position.distanceTo(player.position) > 3 || Math.abs(bot.entity.position.y - player.position.y) > 1) {
        log(bot, 'Not close enough on the same level to hand over ' + itemType + '; nothing was tossed.');
        return false;
    }
    await bot.lookAt(player.position);
    const currentRecipient = bot.players[username]?.entity;
    if (!currentRecipient || currentRecipient.id !== player.id || bot.entity.position.distanceTo(currentRecipient.position) > 3 || Math.abs(bot.entity.position.y - currentRecipient.position.y) > 1) {
        log(bot, 'The recipient moved out of reach; nothing was tossed.');
        return false;
    }
    const receipt = await tossWithReceipt(bot,player,items[0],count);
    if (receipt.ok) {
        log(bot, username + ' received ' + count + ' ' + itemType + '.');
        return true;
    }
    const where = receipt.ground.map(p => '(' + p.x.toFixed(1) + ', ' + p.y.toFixed(1) + ', ' + p.z.toFixed(1) + ')').join(', ');
    log(bot, 'Could not confirm full delivery of ' + count + ' ' + itemType + ' to ' + username + '. '
        + (receipt.received > 0 ? receipt.received + ' confirmed collected. ' : 'No exact receipt was confirmed. ')
        + (where ? 'The remaining drop is on the ground near ' + where + '.' : 'Its current ground location is unconfirmed.')
        + (receipt.collectedBy.length ? ' Collected by: ' + receipt.collectedBy.join(', ') + '.' : ''));
    return false;
}

// Cells the body goes through without breaking anything: what opens, and what is climbed
const PASS_THROUGH = /(_door|_fence_gate|_trapdoor|^ladder|vine|^scaffolding)$/;

export async function goToGoal(bot, goal) {
    /**
     * Navigate to the given goal. Use doors and attempt minimally destructive movements.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {pf.goals.Goal} goal, the goal to navigate to.
     **/

    const nonDestructiveMovements = new pf.Movements(bot);
    const dontBreakBlocks = ['glass', 'glass_pane'];
    for (let block of dontBreakBlocks) {
        nonDestructiveMovements.blocksCantBreak.add(mc.getBlockId(block));
    }
    nonDestructiveMovements.placeCost = 2;
    nonDestructiveMovements.digCost = 10;

    const destructiveMovements = new pf.Movements(bot);
    // owner 10-28 ("推荐她走正门回家而不是挖穿"): digging one block of her own wall cost less than the door 4 blocks away.
    // owner 10-29 ("不是人造方块，只是自己的房子，不然总不能自己垫脚的石头也不挖吧"; GPT #4118 / DeepSeek #4116 agreed): only a block of a
    // house she built and has not given up, still the block recorded there (houses.js), costs extra - not her scaffolding, not other
    // people's buildings. Not a ban: about 30 extra steps per wall (10 for each body cell broken through, safeOrBreak, plus 10 for the
    // feet cell entered, getMoveForward), so a door within reach wins and a wall is still dug when there is no other way (the walk's
    // receipt says which wall). Walking inside costs nothing (air), nor do doors, gates, trapdoors and ladders.
    // (exclusionStep is what each cell the body moves into costs; a plain dig never goes through exclusionBreak in this pathfinder.)
    const builtCost = (b) => (b && b.boundingBox === 'block' && !PASS_THROUGH.test(b.name) && bot.ownHouseBlock?.(b.position) === b.name ? 10 : 0);
    for (const m of [nonDestructiveMovements, destructiveMovements]) m.exclusionAreasStep.push(builtCost);
    // 10-30 home-walk round 24: four blocks from her door the plan's first step was a parkour jump onto a dirt path (y 64.94); the jump
    // never landed, "stuck" reset the path 34 times in 2 minutes and she stood still through three walks. Walks step, climb, dig or
    // place - no long jumps (the retreat, gift and fight walks already work this way).
    for (const m of [nonDestructiveMovements, destructiveMovements]) m.allowParkour = false;
    // Low health: no drop that hurts (fall damage starts above 3 blocks). final-22 19:35: at 0.5 HP !goToSurface took a drop on the way
    // and she died of the fall. Above that health the default drop (4) is kept - one heart is a fair price for a shorter way.
    if (Number.isFinite(bot.health) && bot.health <= 6) for (const m of [nonDestructiveMovements, destructiveMovements]) m.maxDropDown = Math.min(m.maxDropDown, 3);

    let final_movements = destructiveMovements;

    const pathfind_timeout = 1000;
    const preferredPath = bot.pathfinder.getPathTo(nonDestructiveMovements, goal, pathfind_timeout);
    if (preferredPath.status === 'success' || preferredPath.status === 'partial') {
        final_movements = nonDestructiveMovements;
        log(bot, preferredPath.status === 'partial'
            ? 'Path search is partial; I prefer going around obstacles, but may dig or place blocks if needed.'
            : 'Found a route that prefers going around obstacles; digging or placing blocks may still be needed.');
    }
    else if (await bot.pathfinder.getPathTo(destructiveMovements, goal, pathfind_timeout).status === 'success') {
        log(bot, `Found destructive path.`);
    }
    else {
        log(bot, `Path not found, but attempting to navigate anyway using destructive movements.`);
    }

    const doorCheckInterval = startDoorInterval(bot);
    const doorsBehind = closeDoorsBehind(bot);

    bot.pathfinder.setMovements(final_movements);
    try {
        await bot.pathfinder.goto(goal);
        goal.hasChanged?.();
        const reached = !bot.interrupt_code && (goal.isReached
            ? goal.isReached(bot.entity.position)
            : goal.isEnd(bot.entity.position.floored()));
        if (!reached) {
            bot.pathfinder.setGoal(null);
            bot.clearControlStates();
            log(bot, 'Path ended before reaching the goal.');
        }
        return reached;
    } catch (err) {
        bot.pathfinder.setGoal(null);
        bot.clearControlStates();
        // DeepSeek #4134: "ran out of time" and "no route" read alike to her, and they are not the same fact
        log(bot, `Pathfinding stopped: ${err.message}.${err.name === 'Timeout' ? ' (The route search ran out of time; that is not the same as there being no way.)' : ''}`);
        return false;
    } finally {
        clearInterval(doorCheckInterval);
        await doorsBehind.stop();
    }
}

/** Like a player: a door she walks through on this walk is shut once she is out of its cell (owner 10-30: 开门，进屋，关门).
 *  Day-night round 8: she opened her door, went straight on to the bed and the house stood open all night. Round 14: a 200 ms look
 *  missed her crossing the door cell, and a door already open was never shut - so every move is looked at, whoever opened the door. */
function closeDoorsBehind(bot) {
    const isDoor = (b) => b && b.name.endsWith('_door') && !b.name.includes('iron');
    const doors = new Map();   // key -> lower-half position of a door she has walked through
    const onMove = () => {
        const feet = bot.entity.position.floored();
        const b = bot.blockAt(feet);
        if (isDoor(b)) { const pos = b.getProperties?.().half === 'upper' ? feet.offset(0, -1, 0) : feet; doors.set(pos.toString(), pos); }
        else if (doors.size) check();
    };
    bot.on('move', onMove);
    let busy = false;
    const check = async (last = false) => {
        if (busy) return; busy = true;
        try {
            for (const [key, pos] of doors) {
                const d = { pos };
                const far = Math.hypot(bot.entity.position.x - (d.pos.x + 0.5), bot.entity.position.z - (d.pos.z + 0.5));
                // while walking: wait until her body is out of the door cell. When the walk is over and her feet are in the next cell
                // (round 26: she stopped at the edge of the cell inside the door, 0.6 from its middle), shut it now - she is not moving on.
                const feet = bot.entity.position.floored();
                if (last ? (feet.x === d.pos.x && feet.z === d.pos.z) : far < 0.9) continue;
                const b = bot.blockAt(d.pos);
                if (!isDoor(b) || b.getProperties?.().open !== true || far > 4) { doors.delete(key); continue; }
                doors.delete(key);
                await bot.activateBlock(b).catch(() => {});
                // GPT #4165: say closed only when the door reads closed
                for (let t = 0; t < 10 && bot.blockAt(d.pos)?.getProperties?.().open === true; t++) await new Promise((r) => setTimeout(r, 50));
                log(bot, bot.blockAt(d.pos)?.getProperties?.().open === false
                    ? `(You closed the door behind you at (${d.pos.x}, ${d.pos.y}, ${d.pos.z}).)`
                    : `(You tried to close the door behind you at (${d.pos.x}, ${d.pos.y}, ${d.pos.z}); it still looks open.)`);
            }
        } finally { busy = false; }
    };
    return { stop: async () => { bot.off('move', onMove); while (busy) await new Promise((r) => setTimeout(r, 50)); await check(true); } };
}

let _doorInterval = null;
function startDoorInterval(bot) {
    /**
     * Start helper interval that opens nearby doors if the bot is stuck.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {number} the interval id.
     **/
    if (_doorInterval) {
        clearInterval(_doorInterval);
    }
    let prev_pos = bot.entity.position.clone();
    let prev_check = Date.now();
    let stuck_time = 0;


    const doorCheckInterval = setInterval(() => {
        const now = Date.now();
        if (bot.entity.position.distanceTo(prev_pos) >= 0.1) {
            stuck_time = 0;
        } else {
            stuck_time += now - prev_check;
        }
        
        if (stuck_time > 1200) {
            // shuffle positions so we're not always opening the same door
            const positions = [
                bot.entity.position.clone(),
                bot.entity.position.offset(0, 0, 1),
                bot.entity.position.offset(0, 0, -1), 
                bot.entity.position.offset(1, 0, 0),
                bot.entity.position.offset(-1, 0, 0),
            ]
            let elevated_positions = positions.map(position => position.offset(0, 1, 0));
            positions.push(...elevated_positions);
            positions.push(bot.entity.position.offset(0, 2, 0)); // above head
            positions.push(bot.entity.position.offset(0, -1, 0)); // below feet
            
            let currentIndex = positions.length;
            while (currentIndex != 0) {
                let randomIndex = Math.floor(Math.random() * currentIndex);
                currentIndex--;
                [positions[currentIndex], positions[randomIndex]] = [
                positions[randomIndex], positions[currentIndex]];
            }
            
            for (let position of positions) {
                let block = bot.blockAt(position);
                if (block && block.name &&
                    !block.name.includes('iron') &&
                    (block.name.includes('door') ||
                     block.name.includes('fence_gate') ||
                     block.name.includes('trapdoor'))) 
                {
                    bot.activateBlock(block);
                    break;
                }
            }
            stuck_time = 0;
        }
        prev_pos = bot.entity.position.clone();
        prev_check = now;
    }, 200);
    _doorInterval = doorCheckInterval;
    return doorCheckInterval;
}

/** A whole-number x/z names a block cell: aim at its centre. Fractional coordinates are a point already. */
export function cellTarget(x, z, point = false) {
    // `point`: an entity's own position, kept exactly even when it happens to be whole (GPT #3532 P2: a mob at (2,64,2) became (2.5,64,2.5))
    if (point) return { cx: x, cz: z };
    return { cx: Number.isInteger(x) ? x + 0.5 : x, cz: Number.isInteger(z) ? z + 0.5 : z };
}

/** Feet at `position` count as arrived: inside that cell for closeness 0, otherwise within closeness of the cell centre plus 0.35 for
 *  where the feet really stop (the pathfinder ends a node, not its exact centre). */
export function arrived(position, x, y, z, min_distance, point = false) {
    if (min_distance === 0) return position.floored().equals(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
    // a cell target with closeness >= 1: arrived when the cell her feet are in is one the path may end in - the same rule as planning, so a
    // zero-step path from the edge of an end cell is not then called "not reached" (GPT #3537: feet (1.84,64,.84), 1.38 from the centre)
    if (!point && min_distance >= 1) return isPlanEnd(position.floored(), x, y, z, min_distance);
    const { cx, cz } = cellTarget(x, z, point);
    return position.distanceTo(new Vec3(cx, y, cz)) <= min_distance + (point ? 0 : 0.35);
}

const planRadius = (min_distance, point) => point ? Math.max(0, min_distance - 0.2) : min_distance + 0.05;
/** Can the path end at this node (feet cell)? Cells: its centre within closeness of the target cell's centre; points: the old 0.2 margin. */
export function isPlanEnd(node, x, y, z, min_distance, point = false) {
    const { cx, cz } = cellTarget(x, z, point);
    return Math.hypot(node.x + .5 - cx, node.y - y, node.z + .5 - cz) <= planRadius(min_distance, point);
}

async function _goToPosition(bot, x, y, z, min_distance=2, point=false) {
    /**
     * Navigate to the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to navigate to. If null, the bot's current x coordinate will be used.
     * @param {number} y, the y coordinate to navigate to. If null, the bot's current y coordinate will be used.
     * @param {number} z, the z coordinate to navigate to. If null, the bot's current z coordinate will be used.
     * @param {number} distance, the distance to keep from the position. Defaults to 2.
     * @returns {Promise<boolean>} true if the position was reached, false otherwise.
     * @example
     * let position = world.getNearestBlock(bot, "oak_log", 64).position;
     * await skills.goToPosition(bot, position.x, position.y, position.z, 2);
     **/
    if (x == null || y == null || z == null) {
        log(bot, `Missing coordinates, given x:${x} y:${y} z:${z}`);
        return false;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
        log(bot, `Teleported to ${x}, ${y}, ${z}.`);
        return true;
    }
    
    const checkDigProgress = () => {
        if (bot.targetDigBlock) {
            const targetBlock = bot.targetDigBlock;
            // 10-30 day-night test: walking up to her new house the path had to clear one snow_block, and "cannot harvest it with your
            // tools" stopped the walk - but a block cleared out of the way does not need to drop anything, and snow breaks by hand.
            // The walk stops only when the block would take very long to break (or cannot be broken at all).
            let ms = Infinity; try { ms = bot.digTime(targetBlock); } catch { /* unbreakable */ }
            if (!(ms <= 8000)) {
                log(bot, `Pathfinding stopped: ${targetBlock.name} would take too long to break with what you hold.`);
                bot.pathfinder.stop();
                bot.stopDigging();
            }
        }
    };
    
    const progressInterval = setInterval(checkDigProgress, 1000);
    
    try {
        // Plan against feet at the cell centre, instead of pretending the cell corner is the player.
        // Keep radius zero's existing meaning: enter that block cell.
        // Whole-number coordinates name a block cell, so distances are measured to its centre. Measured to the cell corner, standing beside
        // the target counted as 0.7 or 1.6 blocks depending on the side, and !goToCoordinates(..., 1) failed 12 times with "you are 1 blocks
        // away" while she was next to it ("差一格，老毛病，自己挪"). An entity's position (`point`) is kept exactly.
        const { cx, cz } = cellTarget(x, z, point), target = new Vec3(cx, y, cz);
        // cells: a node whose centre is within closeness of the cell centre is an end, so the cells beside a solid target count (GPT #3532 P1:
        // with 0.8 every neighbour, at exactly 1.0, was excluded and a chest or wall target had no end at all); points keep the 0.2 margin
        const planningRadius = planRadius(min_distance, point);
        class GoalNearPoint extends pf.goals.GoalNear {
            isEnd(node) { return isPlanEnd(node, x, y, z, min_distance, point); }
            heuristic(node) { return Math.max(0,Math.hypot(node.x+.5-cx,node.y-y,node.z+.5-cz)-planningRadius); }
        }
        const goal = min_distance >= 1 ? new GoalNearPoint(x,y,z,min_distance) : new pf.goals.GoalNear(x,y,z,min_distance);
        // Planning uses block cells; arrival uses actual feet, including slabs and other fractional heights.
        goal.isReached = position => arrived(position, x, y, z, min_distance, point);
        const navigated = await goToGoal(bot, goal);
        clearInterval(progressInterval);
        if (navigated) await bot.waitForTicks(2);
        const distance = bot.entity.position.distanceTo(target);
        if (navigated && arrived(bot.entity.position, x, y, z, min_distance, point)) {
            log(bot, `You have reached at ${x}, ${y}, ${z}.`);
            return true;
        }
        else {
            const p = bot.entity.position;
            log(bot, `Unable to reach ${x}, ${y}, ${z}: you stopped ${distance.toFixed(1)} blocks from it (at ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}; asked to get within ${min_distance}).${columnFact(bot, x, y, z)}`);
            return false;
        }
    } catch (err) {
        log(bot, `Pathfinding stopped: ${err.message}.`);
        clearInterval(progressInterval);
        return false;
    }
}

// Nothing solid above this cell up to the build limit (or the loaded top): open sky over it.
function hasSkyAt(bot, pos) {
    const top = (bot.game?.minY ?? -64) + (bot.game?.height ?? 384);
    for (let y = pos.y + 1; y < top; y++) {
        const b = bot.blockAt(new Vec3(pos.x, y, pos.z));
        if (!b) return true;   // not loaded above: unknown, not called under ground
        if (b.boundingBox === 'block' && !/leaves$/.test(b.name)) return false;
    }
    return true;
}

// DeepSeek #4128/#4134: all four failed walks of the 10-29 lab had the goal nearly straight above or below her (13-30 blocks up or down,
// under 9 across), and she only heard "stopped N blocks from it". How far up or down, and what fills her own column between - facts only.
function columnFact(bot, x, y, z) {
    const p = bot.entity.position, feet = p.floored(), dy = Math.floor(y) - feet.y, across = Math.hypot(x + 0.5 - p.x, z + 0.5 - p.z);
    if (Math.abs(dy) < 4 || Math.abs(dy) < 2 * across) return '';
    const counts = new Map();
    const from = dy > 0 ? feet.y + 2 : feet.y - 1, to = dy > 0 ? Math.floor(y) - 1 : Math.floor(y) + 1;   // above her head / below her feet
    for (let yy = from; dy > 0 ? yy <= to : yy >= to; yy += Math.sign(dy)) {
        const n = bot.blockAt(new Vec3(feet.x, yy, feet.z))?.name ?? 'unknown';   // not loaded: unknown, never "air"
        counts.set(n, (counts.get(n) || 0) + 1);
    }
    const col = [...counts].map(([n, c]) => `${c} ${n}`).join(', ') || 'nothing';
    return ` The goal is ${Math.abs(dy)} blocks straight ${dy > 0 ? 'above' : 'below'} you (you are at y${p.y.toFixed(1)}, it is at y${y}; ${across.toFixed(1)} blocks away horizontally).`
        + ` In your own column ${dy > 0 ? 'above your head' : 'below your feet'} up to it: ${col}. In hand: ${bot.heldItem?.name ?? 'nothing'}.`;
}

async function _goToNearestBlock(bot, blockType,  min_distance=2, range=64) {
    /**
     * Navigate to the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to navigate to.
     * @param {number} min_distance, the distance to keep from the block. Defaults to 2.
     * @param {number} range, the range to look for the block. Defaults to 64.
     * @returns {Promise<boolean>} true if the block was reached, false otherwise.
     * @example
     * await skills.goToNearestBlock(bot, "oak_log", 64, 2);
     * **/
    const MAX_RANGE = 512;
    if (range > MAX_RANGE) {
        log(bot, `Maximum search range capped at ${MAX_RANGE}. `);
        range = MAX_RANGE;
    }
    let block = null;
    if (blockType === 'water' || blockType === 'lava') {
        let blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType && block.metadata === 0, range, 1);
        if (blocks.length === 0) {
            log(bot, `Could not find any source ${blockType} in ${range} blocks, looking for uncollectable flowing instead...`);
            blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType, range, 1);
        }
        block = blocks[0];
    }
    else {
        block = world.getNearestBlock(bot, blockType, range);
    }
    if (!block) {
        log(bot, `Could not find any ${blockType} in ${range} blocks.`);
        return false;
    }
    // 10-29 lab B: the nearest oak_log was 38 blocks down in a cave; the walk took her there with no pickaxe and she said "the tree is
    // right above me". How far up or down it is, said plainly.
    const dy = block.position.y - Math.floor(bot.entity.position.y);
    log(bot, `Found ${blockType} at ${block.position}${Math.abs(dy) >= 6 ? ` (${Math.abs(dy)} blocks ${dy > 0 ? 'above' : 'below'} you${dy < 0 && !hasSkyAt(bot, block.position) ? ', under ground with no open sky over it' : ''})` : ''}. Navigating...`);
    return await goToPosition(bot, block.position.x, block.position.y, block.position.z, min_distance);
}

async function _goToNearestEntity(bot, entityType, min_distance=2, range=64) {
    /**
     * Navigate to the nearest entity of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} entityType, the type of entity to navigate to.
     * @param {number} min_distance, the distance to keep from the entity. Defaults to 2.
     * @param {number} range, the range to look for the entity. Defaults to 64.
     * @returns {Promise<boolean>} true if the entity was reached, false otherwise.
     **/
    let entity = world.getNearestEntityWhere(bot, entity => entity.name === entityType, range);
    if (!entity) {
        log(bot, `Could not find any ${entityType} in ${range} blocks.`);
        return false;
    }
    let distance = bot.entity.position.distanceTo(entity.position);
    log(bot, `Found ${entityType} ${distance} blocks away.`);
    return await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z, min_distance, true);
}

async function _goToPlayer(bot, username, distance=3) {
    /**
     * Navigate to the given player.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to navigate to.
     * @param {number} distance, the goal distance to the player.
     * @returns {Promise<boolean>} true only when physically within the requested distance, false otherwise.
     * @example
     * await skills.goToPlayer(bot, "player");
     **/
    if (bot.username === username) {
        log(bot, `You are already at ${username}.`);
        return true;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + username);
        log(bot, `Teleported to ${username}.`);
        return true;
    }

    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    let player = bot.players[username]?.entity
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }

    distance = Math.max(distance, 0.5);
    if (bot.entity.position.distanceTo(player.position) <= distance) {
        log(bot, 'You have reached ' + username + '.');
        return true;
    }
    // GoalFollow rounds positions to block cells; aim closer, then check actual positions.
    const goal = new pf.goals.GoalFollow(player, Math.max(0.5,distance - 1));

    if (!await goToGoal(bot, goal, true)) return false;

    const currentPlayer = bot.players[username]?.entity;
    const reached = !!currentPlayer && bot.entity.position.distanceTo(currentPlayer.position) <= distance;
    log(bot, reached ? 'You have reached ' + username + '.' : 'Stopped before reaching ' + username + '; still outside the requested distance.');
    return reached;
}


export async function followPlayer(bot, username, distance=4) {
    /**
     * Follow the given player endlessly. Will not return until the code is manually stopped.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to follow.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.followPlayer(bot, "player");
     **/
    let player = bot.players[username].entity
    if (!player)
        return false;

    const move = new pf.Movements(bot);
    move.digCost = 10;
    bot.pathfinder.setMovements(move);
    let doorCheckInterval = startDoorInterval(bot);

    bot.pathfinder.setGoal(new pf.goals.GoalFollow(player, distance), true);
    log(bot, `You are now actively following player ${username}.`);


    while (!bot.interrupt_code) {
        await new Promise(resolve => setTimeout(resolve, 500));
        // in cheat mode, if the distance is too far, teleport to the player
        const distance_from_player = bot.entity.position.distanceTo(player.position);

        const teleport_distance = 100;
        const ignore_modes_distance = 30; 
        const nearby_distance = distance + 2;

        if (distance_from_player > teleport_distance && bot.modes.isOn('cheat')) {
            // teleport with cheat mode
            await goToPlayer(bot, username);
        }
        else if (distance_from_player > ignore_modes_distance) {
            // these modes slow down the bot, and we want to catch up
            bot.modes.pause('item_collecting');
            bot.modes.pause('hunting');
            bot.modes.pause('torch_placing');
        }
        else if (distance_from_player <= ignore_modes_distance) {
            bot.modes.unpause('item_collecting');
            bot.modes.unpause('hunting');
            bot.modes.unpause('torch_placing');
        }

        if (distance_from_player <= nearby_distance) {
            clearInterval(doorCheckInterval);
            doorCheckInterval = null;
            bot.modes.pause('unstuck');
            bot.modes.pause('elbow_room');
        }
        else {
            if (!doorCheckInterval) {
                doorCheckInterval = startDoorInterval(bot);
            }
            bot.modes.unpause('unstuck');
            bot.modes.unpause('elbow_room');
        }
    }
    clearInterval(doorCheckInterval);
    return true;
}


async function _moveAway(bot, distance) {
    /**
     * Move away from current position in any direction.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.moveAway(bot, 8);
     **/
    const pos = bot.entity.position;
    let goal = new pf.goals.GoalNear(pos.x, pos.y, pos.z, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(new pf.Movements(bot));

    if (bot.modes.isOn('cheat')) {
        const move = new pf.Movements(bot);
        const path = await bot.pathfinder.getPathTo(move, inverted_goal, 10000);
        let last_move = path.path[path.path.length-1];
        if (last_move) {
            let x = Math.floor(last_move.x);
            let y = Math.floor(last_move.y);
            let z = Math.floor(last_move.z);
            bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
            return true;
        }
    }

    if (!await goToGoal(bot, inverted_goal)) return false;
    let new_pos = bot.entity.position;
    log(bot, `Moved away from ${pos.floored()} to ${new_pos.floored()}.`);
    return true;
}

export async function moveAwayFromEntity(bot, entity, distance=16) {
    /**
     * Move away from the given entity.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to move away from.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     **/
    let goal = new pf.goals.GoalFollow(entity, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(new pf.Movements(bot));
    await bot.pathfinder.goto(inverted_goal);
    return true;
}

/** The food in her bag worth eating first (most food points; spoiled or poisonous food only if nothing else), or null. */
export function bestFood(bot) {
    const foods = bot.registry?.foodsByName || {}, bad = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew', 'chorus_fruit']);
    return bot.inventory.items().filter((i) => foods[i.name])
        .sort((a, b) => (bad.has(a.name) - bad.has(b.name)) || ((foods[b.name].foodPoints || 0) - (foods[a.name].foodPoints || 0)))[0] || null;
}

export async function fleeFromEnemies(bot, distance = 12, budgetMs = 6000) {
    /**
     * Run from the nearest hostile mobs for a short time, without long drops - a self-preservation step, never a fight.
     * Owner 10-26 20:0x "自保也要智能一些": the old low-health step walked 20 blocks any way at all (into other mobs, down drops:
     * 19:35 she fell to death at 0.5 HP). This runs away from them, at most `budgetMs`, and never drops more than 3 blocks.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, how far from them to get.
     * @param {number} budgetMs, the longest it runs.
     * @returns {Promise<{fled: boolean, nearest: {name: string, d: number}|null}>} whether there was anything to run from, and the nearest one afterwards.
     **/
    // Not from an enderman: left alone it is harmless, angry it teleports after her, and a glance at it while running can anger it
    // (02:5x she ran "from enderman" at 2 HP and an enderman killed her).
    const runFrom = (e) => mc.isHostile(e) && world.isAlive(bot, e) && e.name !== 'enderman';
    const hostile = (r) => world.getNearestEntityWhere(bot, runFrom, r);
    // Away from all of them at once, not just the nearest: 2026-10-27 02:0x she ran from a zombie at 1 HP, stopped with a spider
    // 8 blocks off, ate, and the spider killed her. Archers shoot from about 15 blocks, so from them she runs to 20: at 02:3x she
    // stopped 11 blocks from a skeleton and was shot dead.
    const reach = (e) => (/^(skeleton|stray|bogged|pillager)$/.test(e.name) ? Math.max(distance, 20) : distance);
    const all = () => Object.values(bot.entities || {}).filter((e) => e !== bot.entity && runFrom(e)
        && e.position.distanceTo(bot.entity.position) <= reach(e));
    let enemy = hostile(distance) || all()[0] || null;
    if (!enemy) return { fled: false, nearest: null };
    const moves = new pf.Movements(bot);
    moves.maxDropDown = 3;   // fall damage starts above 3 blocks
    moves.allowParkour = false;
    bot.pathfinder.setMovements(moves);
    const until = Date.now() + budgetMs;
    while (enemy && Date.now() < until && !bot.interrupt_code) {
        const near = all();
        const away = near.length ? near.map((e) => new pf.goals.GoalFollow(e, reach(e) + 1)) : [new pf.goals.GoalFollow(enemy, reach(enemy) + 1)];
        bot.pathfinder.setGoal(new pf.goals.GoalInvert(new pf.goals.GoalCompositeAny(away)), true);
        await new Promise((resolve) => setTimeout(resolve, 400));
        enemy = all()[0] || null;
    }
    // final-99 01:41: stuck in a pit at 0.5 HP, stop() waited for a waypoint she never reached and the GoalInvert kept her jumping after
    // the flee had ended. The goal is dropped and the keys released now.
    bot.pathfinder.setGoal(null);
    bot.clearControlStates?.();
    const near = hostile(24);
    return { fled: true, nearest: near ? { name: near.name, d: Math.round(near.position.distanceTo(bot.entity.position)) } : null };
}

export async function avoidEnemies(bot, distance=16) {
    /**
     * Move a given distance away from all nearby enemy mobs.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.avoidEnemies(bot, 8);
     **/
    bot.modes.pause('self_preservation'); // prevents damage-on-low-health from interrupting the bot
    let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity) && world.isAlive(bot, entity), distance);
    while (enemy) {
        const follow = new pf.goals.GoalFollow(enemy, distance+1); // move a little further away
        const inverted_goal = new pf.goals.GoalInvert(follow);
        bot.pathfinder.setMovements(new pf.Movements(bot));
        bot.pathfinder.setGoal(inverted_goal, true);
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity) && world.isAlive(bot, entity), distance);
        if (bot.interrupt_code) {
            break;
        }
        if (enemy && bot.entity.position.distanceTo(enemy.position) < 3) {
            await attackEntity(bot, enemy, false);
        }
    }
    bot.pathfinder.stop();
    log(bot, `Moved ${distance} away from enemies.`);
    return true;
}

export async function stay(bot, seconds=30) {
    /**
     * Stay in the current position until interrupted. Pauses the modes that walk you around (cowardice, unstuck, hunting,
     * item collecting, torch placing). Self-defence and self-preservation stay as they are: if something hits you, the reflex
     * still fights back, and that ends the wait. Does not change the modes' ON/OFF settings.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} seconds, the number of seconds to stay. Defaults to 30. -1 for indefinite.
     * @returns {Promise<boolean>} true if the bot stayed, false otherwise.
     * @example
     * await skills.stay(bot);
     **/
    return loggedStay(bot, seconds);
}

async function _stay(bot, seconds) {
    // Owner 10-26: "!stay 只管不乱走、被打照常还手". DeepSeek #3473: 9 of her 42 deaths that day were inside a stay, which paused
    // self_defense and self_preservation - she sat out the night while skeletons shot her and nothing answered.
    log(bot, 'While staying, you do not wander; if something hits you, self-defence still fights back (that ends the wait).');
    bot.modes.pause('unstuck');
    bot.modes.pause('cowardice');
    bot.modes.pause('hunting');
    bot.modes.pause('torch_placing');
    bot.modes.pause('item_collecting');
    let start = Date.now();
    while (!bot.interrupt_code && (seconds === -1 || Date.now() - start < seconds*1000)) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `${bot.interrupt_code ? 'Stay interrupted after' : 'Stayed for'} ${(Date.now() - start)/1000} seconds.`);
    return !bot.interrupt_code;
}
const loggedStay = actLogged('stay', _stay, ['seconds']);

async function _useDoor(bot, door_pos=null) {
    /**
     * Walk through the door at the given position: open it if it is closed, step through, close it behind you. Calling it twice
     * walks through twice. To only open or only close a door, right-click it once: !useOn("hand", "oak_door").
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Vec3} door_pos, the position of the door to use. If null, the nearest door will be used.
     * @returns {Promise<boolean>} true if the door was used, false otherwise.
     * @example
     * let door = world.getNearestBlock(bot, "oak_door", 16).position;
     * await skills.useDoor(bot, door);
     **/
    if (!door_pos) {
        for (let door_type of ['oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door',
                               'mangrove_door', 'cherry_door', 'bamboo_door', 'crimson_door', 'warped_door']) {
            door_pos = world.getNearestBlock(bot, door_type, 16).position;
            if (door_pos) break;
        }
    } else {
        door_pos = Vec3(door_pos.x, door_pos.y, door_pos.z);
    }
    if (!door_pos) {
        log(bot, `Could not find a door to use.`);
        return false;
    }

    bot.pathfinder.setGoal(new pf.goals.GoalNear(door_pos.x, door_pos.y, door_pos.z, 1));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    while (bot.pathfinder.isMoving()) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    
    let door_block = bot.blockAt(door_pos);
    await bot.lookAt(door_pos);
    if (!door_block._properties.open)
        await bot.activateBlock(door_block);
    
    bot.setControlState("forward", true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    bot.setControlState("forward", false);
    await bot.activateBlock(door_block);

    // owner 10-28: two calls to "close" a door left it open, and "Used door" never said which way it ended
    await new Promise((resolve) => setTimeout(resolve, 300));
    const open = bot.blockAt(door_pos)?.getProperties?.().open;
    log(bot, `Walked through the door at ${door_pos}; it is now ${open === true ? 'OPEN' : open === false ? 'closed' : 'in an unknown state'}.`);
    return true;
}

/** Why a bed refused her, in game terms (mineflayer's errors are English programmer text). */
export function sleepRefusal(e) {
    const m = String(e?.message || e);
    return /not night|only sleep at night/i.test(m) ? 'it is not night (or a thunderstorm) yet - beds only work after dark'
        : /monsters|unsafe|nearby/i.test(m) ? 'there are monsters nearby - you cannot sleep while they are close'
        : /obstructed/i.test(m) ? 'something is blocking the bed - clear the space above it'
        : /occupied/.test(m) ? 'someone is already in that bed'
        : /too far|far away/i.test(m) ? 'the bed is too far to reach from where you stopped'
        : m;
}

async function _goToBed(bot) {
    /**
     * Sleep in the nearest bed.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the bed was found, false otherwise.
     * @example
     * await skills.goToBed(bot);
     **/
    // 10-31 release test (taiga_medium_house_1): the nearest bed was in the house's bottom layer, open to the outside, and she slept
    // there without ever using the door. A bed in the room of a house of hers (a cell beside it is inside by the house record) comes
    // first; with no house of hers around, the nearest bed as before.
    const found = bot.findBlocks({
        matching: (block) => {
            return block.name.includes('bed');
        },
        maxDistance: 32,
        count: 16
    });
    const home = (p) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => bot.ownHousePlace?.({ x: p.x + dx, y: p.y, z: p.z + dz })?.where === 'inside');
    const beds = [...found.filter(home), ...found.filter((p) => !home(p))];
    if (beds.length === 0) {
        // final-20 19:2x: she went to sleep on her own and only heard this - with a red_bed in her bag. Say what she has.
        const carried = bot.inventory.items().find((i) => i.name.endsWith('_bed'));
        log(bot, `Could not find a bed to sleep in: no placed bed within 32 blocks.` + (carried
            ? ` You are carrying ${carried.name}: place it first (!placeHere("${carried.name}") - a bed needs two free blocks of floor), then !goToBed.`
            : ' You are not carrying a bed either (one is crafted from 3 wool and 3 planks).'));
        return false;
    }
    let loc = beds[0];
    // 10-30 day-night round 7: closeness 2 ended the walk outside the wall next to the bed, and the server let her sleep through the wall
    // without ever using the door. Next to the bed (1) is on the bed's side of any wall.
    await goToPosition(bot, loc.x, loc.y, loc.z, 1);
    const bed = bot.blockAt(loc);
    // DeepSeek #3540: one try ended "blocked" with the reason only in an English error she never saw. Say why, in game terms.
    // 2026-10-27 08:0x: "bot is not sleeping" - the server refused the click (its monster check is wider than mineflayer's) and said
    // why on the action bar; keep what the server says during the try and give her that.
    const said = [], heard = (m) => { const t = String(m?.toString?.() ?? m ?? '').trim(); if (t) said.push(t); };
    bot.on('actionBar', heard); bot.on('message', heard);
    try { await bot.sleep(bed); }
    catch (e) {
        const server = /not sleeping/.test(String(e?.message || e)) ? said.find((t) => /rest|sleep|bed|monster|obstruct|far|occupied|night/i.test(t)) : null;
        const plain = server ? sleepRefusal({ message: server }) : null;
        const why = server ? `the server said "${server}"${plain !== server ? ` - ${plain}` : ''}`
            : /not sleeping/.test(String(e?.message || e)) ? 'the server did not put you to sleep and gave no reason - usually a monster within about 8 blocks, or something blocking the bed'
            : sleepRefusal(e);
        log(bot, `Could not sleep in the bed at ${loc.x}, ${loc.y}, ${loc.z}: ${why}.`);
        // DeepSeek #3851: 17:24 she placed a bed by day and said "把复活点设这儿"; mineflayer refuses by day without clicking the bed, and
        // at 18:00 she respawned at world spawn on a pillar top and fell. By day the bed is clicked anyway, and what the server answers is hers.
        if (/not night/.test(String(e?.message || e))) {
            await bot.activateBlock(bed).catch(() => {});
            await new Promise(resolve => setTimeout(resolve, 600));
        }
        if (said.some((t) => /respawn point set/i.test(t))) noteBed(bot.username, loc, 'respawn point set');
        log(bot, said.some((t) => /respawn point set/i.test(t))
            ? '白天睡不了，不过服务器说 "Respawn point set"：复活点已经设在这张床了，死了会在这里复活。'
            : '这次没听到服务器说 "Respawn point set"，所以不确定复活点有没有设到这张床上。在这张床上睡着一次，就能确认。');
        return false;
    }
    finally { bot.removeListener('actionBar', heard); bot.removeListener('message', heard); }
    noteBed(bot.username, loc, 'slept');
    log(bot, `You are in bed. This bed is now your respawn point.`);
    bot.modes.pause('unstuck');
    // owner 10-28 ("不会起床去关门，说了但是没反应"): asked to close a door while asleep, the new action waited 10 s for this loop and
    // then abandoned it - the loop never looked at a stop request. Now another action gets her up. The leave-bed packet of a cancelled
    // action is dropped by the stale guard, so getting up is its cancel cleanup, which runs outside that guard.
    // 10-30 day-night test: asleep, she answered "已经在家躺着啦" with !stay - that is staying in bed, not getting up (getting up
    // there kept the night from passing). Any other action still gets her up.
    onActionCancel(bot, (by) => { if (bot.isSleeping && by !== 'action:stay') bot.wake().catch(() => {}); });
    while (bot.isSleeping && !bot.interrupt_code) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (bot.isSleeping) return true;   // cut short: the cleanup above gets her up
    log(bot, `You have woken up.`);
    return true;
}

async function _tillAndSow(bot, x, y, z, seedType=null) {
    /**
     * Till the ground at the given position and plant the given seed type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to till.
     * @param {number} y, the y coordinate to till.
     * @param {number} z, the z coordinate to till.
     * @param {string} plantType, the type of plant to plant. Defaults to none, which will only till the ground.
     * @returns {Promise<boolean>} true if the ground was tilled, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.tillAndSow(bot, position.x, position.y - 1, position.x, "wheat");
     **/
    let pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    let block = bot.blockAt(pos);
    log(bot, `Planting ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);

    if (bot.modes.isOn('cheat')) {
        let to_remove = ['_seed', '_seeds'];
        for (let remove of to_remove) {
            if (seedType.endsWith(remove)) {
                seedType = seedType.replace(remove, '');
            }
        }
        placeBlock(bot, 'farmland', x, y, z);
        placeBlock(bot, seedType, x, y+1, z);
        return true;
    }

    if (block.name !== 'grass_block' && block.name !== 'dirt' && block.name !== 'farmland') {
        log(bot, `Cannot till ${block.name}, must be grass_block or dirt.`);
        return false;
    }
    let above = bot.blockAt(new Vec3(x, y+1, z));
    if (above.name !== 'air') {
        if (block.name === 'farmland') {
            log(bot, `Land is already farmed with ${above.name}.`);
            return true;
        }
        let broken = await breakBlockAt(bot, x, y+1, z);
        if (!broken) {
            log(bot, `Cannot cannot break above block to till.`);
            return false;
        }
    }
    // if distance is too far, move to the block
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(new pf.Movements(bot));
        if (!await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4))) return false;
    }
    if (block.name !== 'farmland') {
        let hoe = bot.inventory.items().find(item => item.name.includes('hoe'));
        let to_equip = hoe?.name || 'diamond_hoe';
        if (!await equip(bot, to_equip)) {
            log(bot, `Cannot till, no hoes. A wooden_hoe is crafted from 2 planks and 2 sticks (at a crafting table).`);
            return false;
        }
        await bot.activateBlock(block);
        log(bot, `Tilled block x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    
    if (seedType) {
        if (seedType.endsWith('seed') && !seedType.endsWith('seeds'))
            seedType += 's'; // fixes common mistake
        let equipped_seeds = await equip(bot, seedType);
        if (!equipped_seeds) {
            log(bot, `No ${seedType} to plant.` + (seedType === 'wheat_seeds' ? ' Wheat seeds drop from breaking short_grass or tall_grass (!collectBlocks("short_grass", 5)).' : ''));
            return false;
        }

        await bot.activateBlock(block);
        log(bot, `Planted ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    return true;
}

// owner 10-28: "Used hand on oak_door" / "Activated lever" never said which way the door, gate, lever or button ended - read it back.
async function stateAfterUse(bot, pos) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const p = bot.blockAt(pos)?.getProperties?.() || {};
    if (typeof p.open === 'boolean') return ` It is now ${p.open ? 'OPEN' : 'closed'}.`;
    if (typeof p.powered === 'boolean') return ` It is now ${p.powered ? 'on (powered)' : 'off'}.`;
    return '';
}

async function _activateNearestBlock(bot, type) {
    /**
     * Activate the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} type, the type of block to activate.
     * @returns {Promise<boolean>} true if the block was activated, false otherwise.
     * @example
     * await skills.activateNearestBlock(bot, "lever");
     * **/
    let block = world.getNearestBlock(bot, type, 16);
    if (!block) {
        log(bot, `Could not find any ${type} to activate.`);
        return false;
    }
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(new pf.Movements(bot));
        if (!await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4))) return false;
    }
    await bot.activateBlock(block);
    log(bot, `Activated ${type} at x:${block.position.x.toFixed(1)}, y:${block.position.y.toFixed(1)}, z:${block.position.z.toFixed(1)}.` + await stateAfterUse(bot, block.position));
    return true;
}

/**
 * Helper function to find and navigate to a villager for trading
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager
 * @returns {Promise<Object|null>} the villager entity if found and reachable, null otherwise
 */
async function findAndGoToVillager(bot, id) {
    const tradingEntity = entity => ['villager', 'wandering_trader'].includes(entity.name)
        || [bot.registry.entitiesByName.villager?.id, bot.registry.entitiesByName.wandering_trader?.id]
            .filter(value => value !== undefined).includes(entity.entityType);
    const nearby = world.getNearbyEntities(bot, 16).filter(tradingEntity);
    const nearest = id == null || id === '' || id === 0 || id === '0' || id === 'nearest'
        || id === 'villager' || id === 'wandering_trader';
    const type = id === 'villager' || id === 'wandering_trader' ? id : null;
    const entity = nearest
        ? nearby.filter(entity => !type || entity.name === type)
            .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
        : bot.entities[String(id)];
    
    if (!entity) {
        log(bot, `Cannot find trading entity ${id ?? 'nearest'}`);
        let villager_list = "Available trading entities (use their ID, or 0 for nearest):\n";
        for (let entity of nearby) {
            if (entity.name === 'wandering_trader') {
                villager_list += `${entity.id}: wandering_trader\n`;
            } else {
                if (entity.metadata && entity.metadata[16] === 1) {
                    villager_list += `${entity.id}: baby villager\n`;
                } else {
                    const profession = world.getVillagerProfession(entity);
                    villager_list += `${entity.id}: ${profession}\n`;
                }
            }
        }
        if (nearby.length === 0) {
            log(bot, "No villagers or wandering traders found nearby.");
            return null;
        }
        log(bot, villager_list);
        return null;
    }
    
    if (!tradingEntity(entity)) {
        log(bot, 'Entity is not a villager or wandering trader');
        return null;
    }
    
    if (entity.name !== 'wandering_trader' && entity.metadata && entity.metadata[16] === 1) {
        log(bot, 'This is either a baby villager or a villager with no job - neither can trade');
        return null;
    }
    
    const distance = bot.entity.position.distanceTo(entity.position);
    if (distance > 4) {
        log(bot, `Villager is ${distance.toFixed(1)} blocks away, moving closer...`);
        try {
            bot.modes.pause('unstuck');
            const goal = new pf.goals.GoalFollow(entity, 2);
            if (!await goToGoal(bot, goal)) return false;
            
            
            log(bot, 'Successfully reached villager');
        } catch (err) {
            log(bot, 'Failed to reach villager - pathfinding error or villager moved');
            console.log(err);
            return null;
        } finally {
            bot.modes.unpause('unstuck');
        }
    }
    
    return entity;
}

/**
 * Show available trades for a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - villager or wandering trader entity ID; 0 selects the nearest trading entity.
 * @returns {Promise<boolean>} true if trades were shown successfully, false otherwise
 * @example
 * await skills.showVillagerTrades(bot, "123");
 */
export async function showVillagerTrades(bot, id=0) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    log(bot, `Trading entity: ${villagerEntity.name} (ID ${villagerEntity.id}).`);
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        log(bot, `Villager has ${villager.trades.length} available trades:`);
        stringifyTrades(bot, villager.trades).forEach((trade, i) => {
            const tradeInfo = `${i + 1}: ${trade}`;
            console.log(tradeInfo);
            log(bot, tradeInfo);
        });
        
        villager.close();
        return true;
    } catch (err) {
        log(bot, 'Failed to open villager trading interface - they might be sleeping, a baby, or jobless');
        console.log('Villager trading error:', err.message);
        return false;
    }
}

/**
 * Trade with a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - villager or wandering trader entity ID; 0 selects the nearest trading entity.
 * @param {number} index - the index (1-based) of the trade to execute
 * @param {number} count - how many times to execute the trade (optional)
 * @returns {Promise<boolean>} true if trade was successful, false otherwise
 * @example
 * await skills.tradeWithVillager(bot, "123", "1", "2");
 */
export async function tradeWithVillager(bot, id, index, count=1) {
    if (!Number.isInteger(Number(index)) || Number(index) < 1 || !Number.isInteger(Number(count)) || Number(count) < 1) {
        log(bot, 'Trade index and count must be positive integers.');
        return false;
    }
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    log(bot, `Trading entity: ${villagerEntity.name} (ID ${villagerEntity.id}).`);
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        const tradeIndex = parseInt(index) - 1; // Convert to 0-based index
        const trade = villager.trades[tradeIndex];
        
        if (!trade) {
            log(bot, `Trade ${index} not found. This villager has ${villager.trades.length} trades available.`);
            villager.close();
            return false;
        }
        
        if (trade.disabled || trade.tradeDisabled) {
            log(bot, `Trade ${index} is currently disabled`);
            villager.close();
            return false;
        }

        const item_2 = trade.inputItem2 ? stringifyItem(bot, trade.inputItem2)+' ' : '';
        log(bot, `Trading ${stringifyItem(bot, trade.inputItem1)} ${item_2}for ${stringifyItem(bot, trade.outputItem)}...`);
        
        const maxPossibleTrades = trade.maximumNbTradeUses - trade.nbTradeUses;
        const requestedCount = Number(count);
        const actualCount = Math.min(requestedCount, maxPossibleTrades);
        
        if (actualCount <= 0) {
            log(bot, `Trade ${index} has been used to its maximum limit`);
            villager.close();
            return false;
        }
        
        if (!hasResources(villager.slots, trade, actualCount)) {
            log(bot, `Don't have enough resources to execute trade ${index} ${actualCount} time(s)`);
            villager.close();
            return false;
        }
        
        log(bot, `Executing trade ${index} ${actualCount} time(s)...`);
        
        try {
            await bot.trade(villager, tradeIndex, actualCount);
            log(bot, `Successfully traded ${actualCount} time(s)`);
            villager.close();
            return true;
        } catch (tradeErr) {
            log(bot, 'An error occurred while trying to execute the trade');
            console.log('Trade execution error:', tradeErr.message);
            villager.close();
            return false;
        }
    } catch (err) {
        log(bot, 'Failed to open villager trading interface');
        console.log('Villager interface error:', err.message);
        return false;
    }
}

function hasResources(window, trade, count) {
    const first = enough({...trade.inputItem1, count: trade.realPrice ?? trade.inputItem1.count}, count);
    const second = !(trade.hasItem2 ?? !!trade.inputItem2) || enough(trade.inputItem2, count);
    return first && second;

    function enough(item, count) {
        let c = 0;
        window.forEach((element) => {
            if (element && element.type === item.type && element.metadata === item.metadata) {
                c += element.count;
            }
        });
        return c >= item.count * count;
    }
}

function stringifyTrades(bot, trades) {
    return trades.map((trade) => {
        let text = stringifyItem(bot, trade.inputItem1);
        if (trade.inputItem2) text += ` & ${stringifyItem(bot, trade.inputItem2)}`;
        if (trade.disabled) text += ' x '; else text += ' » ';
        text += stringifyItem(bot, trade.outputItem);
        return `(${trade.nbTradeUses}/${trade.maximumNbTradeUses}) ${text}`;
    });
}

function stringifyItem(bot, item) {
    if (!item) return 'nothing';
    let text = `${item.count} ${item.displayName}`;
    if (item.nbt && item.nbt.value) {
        const ench = item.nbt.value.ench;
        const StoredEnchantments = item.nbt.value.StoredEnchantments;
        const Potion = item.nbt.value.Potion;
        const display = item.nbt.value.display;

        if (Potion) text += ` of ${Potion.value.replace(/_/g, ' ').split(':')[1] || 'unknown type'}`;
        if (display) text += ` named ${display.value.Name.value}`;
        if (ench || StoredEnchantments) {
            text += ` enchanted with ${(ench || StoredEnchantments).value.value.map((e) => {
                const lvl = e.lvl.value;
                const id = e.id.value;
                return bot.registry.enchantments[id].displayName + ' ' + lvl;
            }).join(' ')}`;
        }
    }
    return text;
}

export async function digDown(bot, distance = 10) {
    /**
     * Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {int} distance, distance to dig down.
     * @returns {Promise<boolean>} true if successfully dug all the way down.
     * @example
     * await skills.digDown(bot, 10);
     **/

    let start_block_pos = bot.blockAt(bot.entity.position).position;
    for (let i = 1; i <= distance; i++) {
        const targetBlock = bot.blockAt(start_block_pos.offset(0, -i, 0));
        let belowBlock = bot.blockAt(start_block_pos.offset(0, -i-1, 0));

        if (!targetBlock || !belowBlock) {
            log(bot, `Dug down ${i-1} blocks, but reached the end of the world.`);
            return true;
        }

        // Check for lava, water
        if (targetBlock.name === 'lava' || targetBlock.name === 'water' || 
            belowBlock.name === 'lava' || belowBlock.name === 'water') {
            log(bot, `Dug down ${i-1} blocks, but reached ${belowBlock ? belowBlock.name : '(lava/water)'}`)
            return false;
        }

        const MAX_FALL_BLOCKS = 2;
        let num_fall_blocks = 0;
        for (let j = 0; j <= MAX_FALL_BLOCKS; j++) {
            if (!belowBlock || (belowBlock.name !== 'air' && belowBlock.name !== 'cave_air')) {
                break;
            }
            num_fall_blocks++;
            belowBlock = bot.blockAt(belowBlock.position.offset(0, -1, 0));
        }
        if (num_fall_blocks > MAX_FALL_BLOCKS) {
            log(bot, `Dug down ${i-1} blocks, but reached a drop below the next block.`);
            return false;
        }

        if (targetBlock.name === 'air' || targetBlock.name === 'cave_air') {
            log(bot, 'Skipping air block');
            console.log(targetBlock.position);
            continue;
        }

        let dug = await breakBlockAt(bot, targetBlock.position.x, targetBlock.position.y, targetBlock.position.z);
        if (!dug) {
            log(bot, 'Failed to dig block at position:' + targetBlock.position);
            return false;
        }
    }
    log(bot, `Dug down ${distance} blocks.`);
    return true;
}

export async function goToSurface(bot) {
    /**
     * Navigate to the surface (highest non-air block at current x,z).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the surface was reached, false otherwise.
     **/
    const pos = bot.entity.position;
    for (let y = 360; y > -64; y--) { // probably not the best way to find the surface but it works
        const block = bot.blockAt(new Vec3(pos.x, y, pos.z));
        if (!block || block.name === 'air' || block.name === 'cave_air') {
            continue;
        }
        await goToPosition(bot, block.position.x, block.position.y + 1, block.position.z, 0); // this will probably work most of the time but a custom mining and towering up implementation could be added if needed
        log(bot, `Going to the surface at y=${y+1}.`);``
        return true;
    }
    return false;
}

export async function useToolOn(bot, toolName, targetName) {
    /**
     * Equip a tool and use it on the nearest target.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {string} targetName - entity type, block type, or "nothing" for no target
     * @returns {Promise<boolean>} true if action succeeded
     */
    if (!bot.inventory.slots.find(slot => slot && slot.name === toolName) && !bot.game.gameMode === 'creative') {
        log(bot, `You do not have any ${toolName} to use.`);
        return false;
    }

    targetName = targetName.toLowerCase();
    if (targetName === 'nothing') {
        const equipped = await equip(bot, toolName);
        if (!equipped) {
            return false;
        }
        await bot.activateItem();
        log(bot, `Used ${toolName}.`);
    } else if (world.isEntityType(targetName)) {
        const entity = world.getNearestEntityWhere(bot, e => e.name === targetName, 64);
        if (!entity) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z, 2, true);
        if (toolName === 'hand') {
            await bot.unequip('hand');
        }
        else {
            const equipped = await equip(bot, toolName);
            if (!equipped) return false;
        }
        await bot.useOn(entity);
        log(bot, `Used ${toolName} on ${targetName}.`);
    } else {
        let block = null;
        if (targetName === 'water' || targetName === 'lava') {
            // we want to get liquid source blocks, not flowing blocks
            // so search for blocks with metadata 0 (not flowing)
            let blocks = world.getNearestBlocksWhere(bot, block => block.name === targetName && block.metadata === 0, 64, 1);
            if (blocks.length === 0) {
                log(bot, `Could not find any source ${targetName}.`);
                return false;
            }
            block = blocks[0];
        }
        else {
            block = world.getNearestBlock(bot, targetName, 64);
        }
        if (!block) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        return await useToolOnBlock(bot, toolName, block);
    }

    return true;
 }

 export async function useToolOnBlock(bot, toolName, block) {
    /**
     * Use a tool on a specific block.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {Block} block - the block reference to use the tool on.
     * @returns {Promise<boolean>} true if action succeeded
     */

    // owner 10-30 (screenshot "依旧站在门上关门"): for her door this walked into the door cell, saw the door's own upper half "in the
    // way", stepped to a random cell and gave up ("spruce_door is in the way, not using hand"). A door, gate or trapdoor is simply
    // clicked: from where she stands when it is in reach, else from 2 blocks off; never from inside it.
    if (/(_door|_trapdoor|_fence_gate)$/.test(block.name)) {
        let b = block;
        if (b.getProperties?.().half === 'upper') b = bot.blockAt(b.position.offset(0, -1, 0)) ?? b;
        const reach = () => bot.entity.position.offset(0, 1.62, 0).distanceTo(b.position.offset(0.5, 0.5, 0.5));
        // standing in the doorway of her own house: in first, then the door (she closed it around herself)
        const feet = bot.entity.position.floored(), mine = bot.ownHousePlace?.(feet);
        if (mine?.where === 'door' && mine.house.inside) await goToPosition(bot, mine.house.inside.x, mine.house.inside.y, mine.house.inside.z, 0);
        if (reach() > 4) await goToPosition(bot, b.position.x, b.position.y, b.position.z, 2);
        if (reach() > 4.5) { log(bot, `Could not get within reach of the ${b.name} at ${b.position}.`); return false; }
        await bot.lookAt(b.position.offset(0.5, 0.5, 0.5));
        await bot.activateBlock(b);
        log(bot, `Used ${toolName} on ${b.name}.` + await stateAfterUse(bot, b.position));
        return true;
    }

    const distance = toolName === 'water_bucket' && block.name !== 'lava' ? 1.5 : 2;
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, distance);
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));

    // if block in view is closer than the target block, it is in our way. try to move closer
    const viewBlocked = () => {
        const blockInView = bot.blockAtCursor(5);
        const headPos = bot.entity.position.offset(0, bot.entity.height, 0);
        return blockInView && 
            !blockInView.position.equals(block.position) && 
            blockInView.position.distanceTo(headPos) < block.position.distanceTo(headPos);
    }
    const blockInView = bot.blockAtCursor(5);
    if (viewBlocked()) {
        log(bot, `Block ${blockInView.name} is in the way, moving closer...`);
        // choose random block next to target block, go to it
        const nearbyPos = block.position.offset(Math.random() * 2 - 1, 0, Math.random() * 2 - 1);
        await goToPosition(bot, nearbyPos.x, nearbyPos.y, nearbyPos.z, 1);
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
        if (viewBlocked()) {
            const blockInView = bot.blockAtCursor(5);
            log(bot, `Block ${blockInView.name} is in the way, not using ${toolName}.`);
            return false;
        }
    }

    const equipped = await equip(bot, toolName);

    if (!equipped) {
        log(bot, `Could not equip ${toolName}.`);
        return false;
    }
    if (toolName.includes('bucket')) {
        await bot.activateItem();
    }
    else {
        await bot.activateBlock(block);
    }
    log(bot, `Used ${toolName} on ${block.name}.` + await stateAfterUse(bot, block.position));
    return true;
 }

// Owner pivot 2026-10-25 (docs/log-spec.md): every primitive writes one [act] line - ok only when the skill returned true.
export const craftRecipe = actLogged('craft', _craftRecipe, ['itemName', 'num']);
export const smeltItem = actLogged('craft', _smeltItem, ['itemName', 'num']);
export const attackNearest = actLogged('attack', _attackNearest, ['mobType', 'kill']);
export const attackEntity = actLogged('attack', _attackEntity, ['entity', 'kill']);
export const collectBlock = actLogged('mine', _collectBlock, ['blockType', 'num']);
export const breakBlockAt = actLogged('mine', _breakBlockAt, ['x', 'y', 'z']);
export const placeBlock = actLogged('place', _placeBlock, ['blockType', 'x', 'y', 'z', 'placeOn']);
export const putInChest = actLogged('chest', _putInChest, ['itemName', 'num']);
export const takeFromChest = actLogged('chest', _takeFromChest, ['itemName', 'num']);
export const consume = actLogged('eat', _consume, ['itemName']);
export const giveToPlayer = actLogged('use', _giveToPlayer, ['itemType', 'username', 'num']);
export const goToPosition = actLogged('goto', _goToPosition, ['x', 'y', 'z', 'min_distance']);
export const goToNearestBlock = actLogged('goto', _goToNearestBlock, ['blockType', 'min_distance', 'range']);
export const goToNearestEntity = actLogged('goto', _goToNearestEntity, ['entityType', 'min_distance', 'range']);
export const goToPlayer = actLogged('goto', _goToPlayer, ['username', 'distance']);
export const moveAway = actLogged('goto', _moveAway, ['distance']);
export const useDoor = actLogged('use', _useDoor, ['door_pos']);
export const goToBed = actLogged('sleep', _goToBed, []);
export const tillAndSow = actLogged('use', _tillAndSow, ['x', 'y', 'z', 'seedType']);
export const activateNearestBlock = actLogged('use', _activateNearestBlock, ['type']);
// owner 10-28 MEETING-5: her code reached for skills.swimUp and found nothing - the swim abilities are reachable from code too
export { swimUp, swimDown } from './swim.js';
