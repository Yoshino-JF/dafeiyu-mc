import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';
import { getCommandDocs } from './index.js';
import convoManager from '../conversation.js';
import { allPlaceNames, findPlace } from '../memory_bank.js';
import { airLine } from '../library/swim.js';
import { respawnLine } from '../respawn.js';
import { FIGHT_REACH } from '../encounter.js';
import { firstBlockOnLine } from '../library/ranged.js';
import { checkLevelBlueprint, checkBlueprint } from '../tasks/construction_tasks.js';
import { load } from 'cheerio';
import settings from '../settings.js';

// Owner 10-27 13:0x: she only saw players within 64 blocks, so the owner online but far away was invisible to her and she never asked
// anyone for anything. Who is online, the owner marked, and where when she can see them - facts only; whether to talk to them is hers.
/** What in her bag the game lets her eat, with counts; raw meat and fish are marked (cooked fills far more). */
export function foodLine(bot) {
    const foods = bot.registry?.foodsByName || {}, counts = {};
    for (const i of bot.inventory?.items?.() || []) if (foods[i.name]) counts[i.name] = (counts[i.name] || 0) + i.count;
    const names = Object.keys(counts);
    if (!names.length) return '- 包里能吃的：没有。';
    const raw = /^(beef|porkchop|chicken|mutton|rabbit|cod|salmon)$/;
    return '- 包里能吃的：' + names.map((n) => `${n}×${counts[n]}${raw.test(n) ? '（生的，烤熟更顶饿）' : ''}`).join('，') + '。';
}

const COMPASS = ['南', '西南', '西', '西北', '北', '东北', '东', '东南'];
export function onlinePlayersLine(agent, bots = []) {
    const bot = agent.bot, me = bot.entity?.position, owner = settings.voice?.owner_name;
    const others = Object.values(bot.players || {}).filter((p) => p?.username && p.username !== bot.username && !bots.includes(p.username));
    if (!others.length) return '- 在线玩家：除了你没有别人。';
    const one = (p) => {
        const who = p.username + (owner && p.username === owner ? '（老大）' : '');
        const at = p.entity?.position;
        if (!at || !me) return `${who}，太远，看不到在哪`;
        const dx = at.x - me.x, dz = at.z - me.z, d = Math.round(Math.hypot(dx, dz));
        // yaw-style angle: 0 = south (+z), 90 = west (-x)
        const dir = COMPASS[Math.round(((Math.atan2(-dx, dz) * 180 / Math.PI + 360) % 360) / 45) % 8];
        return d < 2 ? `${who}，就在你身边` : `${who}，${dir}方约 ${d} 格`;
    };
    return `- 在线玩家（你在聊天里说的话他们都看得到）：${others.map(one).join('；')}`;
}

const pad = (str) => {
    return '\n' + str + '\n';
}

// queries are commands that just return strings and don't affect anything in the world
export const queryList = [
    {
        name: "!stats",
        description: "Get your bot's location, health, hunger, and time of day.", 
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'STATS';
            let pos = bot.entity.position;
            // display position to 2 decimal places
            res += `\n- Position: x: ${pos.x.toFixed(2)}, y: ${pos.y.toFixed(2)}, z: ${pos.z.toFixed(2)}`;
            // 10-30 day-night test: inside her own house she called it "别人的屋子" - which house of hers she is in (or at), from its record
            { const at = bot.ownHousePlace?.(pos.floored()); if (at) res += `（${at.where === 'inside' ? `在你自己的「${at.house.name}」屋里` : at.where === 'door' ? `在你自己的「${at.house.name}」门口` : `在你自己的「${at.house.name}」外面`}）`; }
            // Gameplay
            res += `\n- Gamemode: ${bot.game.gameMode}`;
            res += `\n- Health: ${Math.round(bot.health)} / 20`;
            res += `\n- Hunger: ${Math.round(bot.food)} / 20`;
            // final-25..29: "猪排填肚子不回血" at hunger 17 - health only regenerates at 18 or more; she never knew why it would not come back
            if (bot.health < 20) res += bot.food >= 18 ? ' (health regenerates by itself while hunger is 18 or more)' : ' (health does NOT regenerate by itself below 18 hunger - eat to get it to 18+)';
            // DeepSeek #3755: two hours on 2 glow berries, then at 1 HP in a shell "壳再结实也不能当饭吃" - learnt from a death. What she can eat
            // right now is one line, not something to work out from the inventory.
            res += '\n' + foodLine(bot);
            const air = airLine(bot);   // owner 10-28: her air value, so when to come up is her call
            if (air) res += '\n' + air;
            res += '\n' + respawnLine(agent.name, bot.spawnPoint, agent.memoryS?.worldStatus?.()?.since);   // owner 10-28 MEETING-5: where she would wake, with its source
            res += `\n- Biome: ${world.getBiomeName(bot)}`;
            let weather = "Clear";
            if (bot.rainState > 0)
                weather = "Rain";
            if (bot.thunderState > 0)
                weather = "Thunderstorm";
            res += `\n- Weather: ${weather}`;
            // let block = bot.blockAt(pos);
            // res += `\n- Artficial light: ${block.skyLight}`;
            // res += `\n- Sky light: ${block.light}`;
            // light properties are bugged, they are not accurate


            if (bot.time.timeOfDay < 6000) {
                res += '\n- Time: Morning';
            } else if (bot.time.timeOfDay < 12000) {
                res += '\n- Time: Afternoon';
            } else {
                res += '\n- Time: Night';
            }

            // get the bot's current action
            let action = agent.actions.currentActionLabel;
            if (agent.isIdle())
                action = 'Idle';
            res += `\- Current Action: ${action}`;
            // owner 10-28 (MEETING-5): how a running action is going, as facts she can look up - not only its name
            if (!agent.isIdle() && agent.actions.currentActionStartedAt) {
                const secs = Math.round((Date.now() - agent.actions.currentActionStartedAt) / 1000);
                const pf = bot.pathfinder, last = String(bot.output || '').trim().split('\n').filter(Boolean).slice(-1)[0] || '';
                const doing = [pf?.isMoving?.() && 'walking a path', pf?.isMining?.() && 'digging', pf?.isBuilding?.() && 'placing a block'].filter(Boolean);
                res += ` (running ${secs} s${doing.length ? `; now ${doing.join(', ')}` : ''}${pf?.goal ? '; it has a path goal' : ''}${last ? `; its last output: ${last.slice(0, 120)}` : '; no output from it yet'})`;
            }


            let players = world.getNearbyPlayerNames(bot);
            let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
            players = players.filter(p => !bots.includes(p));

            res += '\n- Nearby Human Players: ' + (players.length > 0 ? players.join(', ') : 'None.');
            res += '\n' + onlinePlayersLine(agent, bots);
            res += '\n- Nearby Bot Players: ' + (bots.length > 0 ? bots.join(', ') : 'None.');

            res += '\n' + agent.bot.modes.getMiniDocs() + '\n';
            return pad(res);
        }
    },
    {
        name: "!inventory",
        description: "Get your bot's inventory.",
        perform: function (agent) {
            let bot = agent.bot;
            let inventory = world.getInventoryCounts(bot);
            let res = 'INVENTORY';
            for (const item in inventory) {
                if (inventory[item] && inventory[item] > 0)
                    res += `\n- ${item}: ${inventory[item]}`;
            }
            if (res === 'INVENTORY') {
                res += ': Nothing';
            }
            else if (agent.bot.game.gameMode === 'creative') {
                res += '\n(You have infinite items in creative mode. You do not need to gather resources!!)';
            }
            // arena 10-26: her bag was full, eight given items fell to the floor and she never knew why nothing new showed up
            const free = typeof bot.inventory.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : null;
            if (Number.isFinite(free))
                res += `\nSLOTS: ${36 - free}/36 used` + (free === 0 ? ' (full: anything new you pick up or are given falls to the ground)' : '');
            res += `\nHOLDING: ${bot.heldItem?.name || 'nothing (bare hand)'}`;

            let helmet = bot.inventory.slots[5];
            let chestplate = bot.inventory.slots[6];
            let leggings = bot.inventory.slots[7];
            let boots = bot.inventory.slots[8];
            res += '\nWEARING: ';
            if (helmet)
                res += `\nHead: ${helmet.name}`;
            if (chestplate)
                res += `\nTorso: ${chestplate.name}`;
            if (leggings)
                res += `\nLegs: ${leggings.name}`;
            if (boots)
                res += `\nFeet: ${boots.name}`;
            if (!helmet && !chestplate && !leggings && !boots)
                res += 'Nothing';

            return pad(res);
        }
    },
    {
        name: "!nearbyBlocks",
        description: "Get the blocks near the bot.",
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'NEARBY_BLOCKS';
            let blocks = world.getNearestBlocks(bot);
            let block_details = new Set();
            
            for (let block of blocks) {
                let details = block.name;
                if (block.name === 'water' || block.name === 'lava') {
                    details += block.metadata === 0 ? ' (source)' : ' (flowing)';
                }
                block_details.add(details);
            }
            for (let details of block_details) {
                res += `\n- ${details}`;
            }
            if (block_details.size === 0) {
                res += ': none';
            } 
            else {
                res += '\n- ' + world.getSurroundingBlocks(bot).join('\n- ');
                res += `\n- First Solid Block Above Head: ${world.getFirstBlockAboveHead(bot, null, 32)}`;
            }
            return pad(res);
        }
    },
    {
        name: "!craftable",
        description: "Get the craftable items with the bot's inventory.",
        perform: function (agent) {
            let craftable = world.getCraftableItems(agent.bot);
            let res = 'CRAFTABLE_ITEMS';
            for (const item of craftable) {
                res += `\n- ${item}`;
            }
            if (res == 'CRAFTABLE_ITEMS') {
                res += ': none';
            }
            return pad(res);
        }
    },
    {
        name: "!entities",
        description: "Get the nearby players and entities (within 24 blocks), plus hostiles up to 32 blocks away that only a bow (!shoot) reaches, and the dropped items lying on the ground within 16 blocks (what, how many, where).",
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'NEARBY_ENTITIES';
            let players = world.getNearbyPlayerNames(bot);
            let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
            players = players.filter(p => !bots.includes(p));

            for (const player of players) {
                res += `\n- Human player: ${player}`;
            }
            for (const bot of bots) {
                res += `\n- Bot player: ${bot}`;
            }

            // DeepSeek #3444: "a skeleton 20 blocks out is coming" - then !entities (16 blocks) showed only bats. Same reach as the notices
            // and !fight (encounter.js FIGHT_REACH), so what she is told about is also what she can look up.
            let nearbyEntities = world.getNearbyEntities(bot, FIGHT_REACH);
            let entityCounts = {};
            let villagerIds = [];
            let babyVillagerIds = [];
            let villagerDetails = []; // Store detailed villager info including profession
            
            for (const entity of nearbyEntities) {
                if (entity.type === 'player' || entity.name === 'item')
                    continue;
                    
                if (!entityCounts[entity.name]) {
                    entityCounts[entity.name] = 0;
                }
                entityCounts[entity.name]++;
                
                if (entity.name === 'villager') {
                    if (entity.metadata && entity.metadata[16] === 1) {
                        babyVillagerIds.push(entity.id);
                    } else {
                        const profession = world.getVillagerProfession(entity);
                        villagerIds.push(entity.id);
                        villagerDetails.push({
                            id: entity.id,
                            profession: profession
                        });
                    }
                }
            }
            
            for (const [entityType, count] of Object.entries(entityCounts)) {
                if (entityType === 'villager') {
                    let villagerInfo = `${count} ${entityType}(s)`;
                    if (villagerDetails.length > 0) {
                        const detailStrings = villagerDetails.map(v => `(${v.id}:${v.profession})`);
                        villagerInfo += ` - Adults: ${detailStrings.join(', ')}`;
                    }
                    if (babyVillagerIds.length > 0) {
                        villagerInfo += ` - Baby IDs: ${babyVillagerIds.join(', ')} (babies cannot trade)`;
                    }
                    res += `\n- entities: ${villagerInfo}`;
                } else if (entityType === 'wandering_trader') {
                    // dafeiyu 3-day run 10-26: a trader was only "1 wandering_trader(s)" - no id, so the trade commands had nothing to aim at.
                    const ids = nearbyEntities.filter(e => e.name === 'wandering_trader').map(e => e.id);
                    res += `\n- entities: ${count} ${entityType}(s) - IDs: ${ids.join(', ')}`;
                } else {
                    res += `\n- entities: ${count} ${entityType}(s)`;
                }
            }
            
            // bow arena 10-26: a skeleton 30 blocks off was in !shoot's reach (32) but never in what she could look up, so she said
            // "没看见骷髅…视野被墙挡着" and never drew. Hostiles past !fight's reach but within a bow shot, with that fact.
            const me = bot.entity.position;
            const far = world.getNearbyEntities(bot, 32).filter((e) => mc.isHostile(e) && world.isAlive(bot, e) && e.position.distanceTo(me) > FIGHT_REACH);
            // owner 10-28: told only "within !shoot's 32", she shot at a skeleton in a cave under her through the ground - say whether blocks stand between
            const eye = me.offset(0, 1.52, 0);
            for (const e of far) {
                const wall = firstBlockOnLine(bot, eye, e.position.offset(0, (e.height || 1.8) * 0.5, 0));
                res += `\n- ${e.name} ${Math.round(e.position.distanceTo(me))} blocks away, ${Math.round(e.position.y - me.y)} blocks ${e.position.y >= me.y ? 'up' : 'down'} (beyond !fight's ${FIGHT_REACH}, within !shoot's 32)`
                    + (wall ? ` - ${wall.name} at (${wall.position.x}, ${wall.position.y}, ${wall.position.z}) is in the straight line between you; an arrow would hit that first` : ' - open line between you');
            }

            // owner 10-28 ("她能否看到身边掉落物"): item entities were skipped above, so a drop she had just thrown or lost was invisible -
            // she guessed "掉落物没捡上来" and walked back over her own discards. What lies on the ground within 16 blocks, nearest first.
            const drops = nearbyEntities.filter((e) => e.name === 'item' && e.position.distanceTo(me) <= 16)
                .map((e) => { let it = null; try { it = e.getDroppedItem?.(); } catch { /* not readable */ } return { it, e, d: e.position.distanceTo(me) }; })
                .filter((x) => x.it).sort((a, b) => a.d - b.d);
            for (const { it, e, d } of drops.slice(0, 8)) {
                const p = e.position.floored();
                res += `\n- on the ground: ${it.count} ${it.name} at (${p.x}, ${p.y}, ${p.z}), ${Math.round(d)} blocks away`;
            }
            if (drops.length > 8) res += `\n- on the ground: ${drops.length - 8} more dropped item stack(s) further off`;

            if (res == 'NEARBY_ENTITIES') {
                res += ': none';
            }
            return pad(res);
        }
    },
    {
        name: "!modes",
        description: "Get all available modes and their docs and see which are on/off.",
        perform: function (agent) {
            return agent.bot.modes.getDocs();
        }
    },
    {
        name: '!savedPlaces',
        description: 'List all saved locations.',
        perform: async function (agent) {
            const names = allPlaceNames(agent);
            if (!names.length) return "No places are saved yet.";
            // 10-28 new save: names only, so a place from an earlier world read as one in this world - each now carries its coordinates and,
            // when saved in another world, that mark (the same one her place book shows)
            const here = agent.memoryS?.worldStatus?.()?.key;
            return "Saved places:\n" + names.map((n) => {
                const p = findPlace(agent, n), w = agent.memoryS?.placeWorld?.(n);
                return `- ${n}${Array.isArray(p) ? ` (${p.map(Math.round).join(', ')})` : ''}${here && w && w !== here ? '（旧世界）' : ''}`;
            }).join('\n');
        }
    },
    {
        // owner 10-29: her houses in this save - door, room, floor, when she was last in each, and what of each is still broken
        name: '!myHouses',
        description: 'List the houses you built in this world: door, room inside the walls, floor height, when you were last in each, and any damage not yet repaired.',
        perform: async function (agent) {
            return agent.houses ? agent.houses.summary() : 'Your houses are not loaded yet.';
        }
    },
    {
        name: '!checkBlueprintLevel',
        description: 'Check if the level is complete and what blocks still need to be placed for the blueprint',
        params: {
            'levelNum': { type: 'int', description: 'The level number to check.', domain: [0, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent, levelNum) {
            let res = checkLevelBlueprint(agent, levelNum);
            console.log(res);
            return pad(res);
        }
    }, 
    {
        name: '!checkBlueprint',
        description: 'Check what blocks still need to be placed for the blueprint',
        perform: function (agent) {
            let res = checkBlueprint(agent);
            return pad(res);
        }
    }, 
    {
        name: '!getBlueprint',
        description: 'Get the blueprint for the building',
        perform: function (agent) {
            let res = agent.task.blueprint.explain();
            return pad(res);
        }
    }, 
    {
        name: '!getBlueprintLevel',
        description: 'Get the blueprint for the building',
        params: {
            'levelNum': { type: 'int', description: 'The level number to check.', domain: [0, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent, levelNum) {
            let res = agent.task.blueprint.explainLevel(levelNum);
            console.log(res);
            return pad(res);
        }
    },
    {
        name: '!getCraftingPlan',
        description: "Provides a comprehensive crafting plan for a specified item. This includes a breakdown of required ingredients, the exact quantities needed, and an analysis of missing ingredients or extra items needed based on the bot's current inventory.",
        params: {
            targetItem: { 
                type: 'string', 
                description: 'The item that we are trying to craft' 
            },
            quantity: { 
                type: 'int',
                description: 'The quantity of the item that we are trying to craft',
                optional: true,
                domain: [1, Infinity, '[)'], // Quantity must be at least 1,
                default: 1
            }
        },
        perform: function (agent, targetItem, quantity = 1) {
            let bot = agent.bot;

            // Fetch the bot's inventory
            const curr_inventory = world.getInventoryCounts(bot); 
            const target_item = targetItem;
            let existingCount = curr_inventory[target_item] || 0;
            let prefixMessage = '';
            if (existingCount > 0) {
                curr_inventory[target_item] -= existingCount;
                prefixMessage = `You already have ${existingCount} ${target_item} in your inventory. If you need to craft more,\n`;
            }

            // Generate crafting plan
            try {
                let craftingPlan = mc.getDetailedCraftingPlan(target_item, quantity, curr_inventory);
                craftingPlan = prefixMessage + craftingPlan;
                return pad(craftingPlan);
            } catch (error) {
                console.error("Error generating crafting plan:", error);
                return `An error occurred while generating the crafting plan: ${error.message}`;
            }
            
            
        },
    },
    {
        name: '!searchWiki',
        description: 'Search the Minecraft Wiki for the given query.',
        params: {
            'query': { type: 'string', description: 'The query to search for.' }
        },
        perform: async function (agent, query) {
            const url = `https://minecraft.wiki/w/${query}`
            try {
                const response = await fetch(url);
                if (response.status === 404) {
                  return `${query} was not found on the Minecraft Wiki. Try adjusting your search term.`;
                }
                const html = await response.text();
                const $ = load(html);
            
                const parserOutput = $("div.mw-parser-output");
                
                parserOutput.find("table.navbox").remove();

                const divContent = parserOutput.text();
            
                return divContent.trim();
              } catch (error) {
                console.error("Error fetching or parsing HTML:", error);
                return `The following error occurred: ${error}`
              }
        }
    },
    {
        name: '!help',
        description: 'Lists all available commands and their descriptions.',
        perform: async function (agent) {
            return getCommandDocs(agent);
        }
    },
];
