import {inHeight,claimBlast,styleFor,blastAllowed,actionBudgetMinutes} from './fight_style.js';
import * as skills from './library/skills.js';
import { pickupKeptItems } from './library/pickup.js';
import { logDecision, logAct } from './dafeiyu_log.js';
import { handStats } from './fight_style.js';
import { runEncounter, FIGHT_REACH, styleNow, bestWeapon, meleeDamage } from './encounter.js';
import { observedTargetHealth, fuseObserved, retreat, stepAway, meleePoint } from './library/fight.js';
import * as world from './library/world.js';
import * as mc from '../utils/mcdata.js';
import settings from './settings.js'
import convoManager from './conversation.js';

async function say(agent, message) {
    agent.bot.modes.behavior_log += message + '\n';
    if (agent.shut_up || !settings.narrate_behavior) return;
    agent.openChat(message);
}

// Owner 10-27 11:2x "女巫可以鼓励她去打，如果有伤害足够高的剑，反正她有死亡不掉落": vanilla facts about a witch, what her best weapon would take,
// and - with a weapon of 6+ per hit - that it is worth a try. Her style still decides; a witch she avoids needs !setFightStyle first.
export function witchFact(agent) {
    const bot = agent.bot, best = bestWeapon(bot), dmg = meleeDamage(best?.name), hits = Math.ceil(26 / dmg);
    const tactic = styleNow(agent, 'witch').tactic;
    const how = tactic === 'avoid' ? '你的打法里女巫现在是 avoid（不惹），!fight 会拒绝；想打先 !setFightStyle("witch", "tactic", "melee")，再 !fight("witch")。'
        : `你的打法里女巫是 ${tactic}，想打就 !fight("witch")。`;
    const base = '女巫：26 血；离你十来格就会朝你扔药水（缓慢、中毒、虚弱，最多的是伤害药水，一瓶约 6 点），自己受伤会喝治疗药水回血，贴身连砍、趁她喝药时打最有效；打死会掉红石、萤石粉、火药、糖之类。';
    if (dmg < 6) return base + `你包里最好的是 ${best?.name || '空手'}（每下约 ${dmg} 点），要 ${hits} 下以上；铁剑（6）或斧子（7 以上）会轻松得多。`;
    return base + `你包里的 ${best.name}（每下约 ${dmg} 点）大约 ${hits} 下能打死她（她喝治疗会多几下）。`
        + (bot.keptOnDeath ? '死亡不掉落开着（上次死了东西都还在），打输了也不丢东西——值得试试。' : '值得试试。') + how;
}

// a mode is a function that is called every tick to respond immediately to the world
// it has the following fields:
// on: whether 'update' is called every tick
// active: whether an action has been triggered by the mode and hasn't yet finished
// paused: whether the mode is paused by another action that overrides the behavior (eg followplayer implements its own self defense)
// update: the function that is called every tick (if on is true)
// when a mode is active, it will trigger an action to be performed but won't wait for it to return output

// the order of this list matters! first modes will be prioritized
// while update functions are async, they should *not* be awaited longer than ~100ms as it will block the update loop
// to perform longer actions, use the execute function which won't block the update loop
/** In lava: run (look, forward + jump + sprint) to the nearest cell within 3 blocks with solid ground under it and no lava or fire at the
 * feet, head or below, for at most 3 s. True once her feet are out of lava (final-96 00:34). */
async function outOfLava(bot) {
    const base = bot.entity.position.floored(), bad = /lava|fire|magma/;
    let best = null;
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -1; dy <= 2; dy++) {
        const p = base.offset(dx, dy, dz), feet = bot.blockAt(p), head = bot.blockAt(p.offset(0, 1, 0)), below = bot.blockAt(p.offset(0, -1, 0));
        if (!feet || !head || !below || feet.boundingBox !== 'empty' || head.boundingBox !== 'empty' || below.boundingBox !== 'block') continue;
        if (bad.test(feet.name + head.name + below.name)) continue;
        const d = Math.hypot(dx, dz) + Math.abs(dy) * 0.5;
        if (!best || d < best.d) best = { p, d };
    }
    if (!best) return false;
    const target = best.p.offset(0.5, 0, 0.5), inLava = () => /lava/.test(bot.blockAt(bot.entity.position)?.name || '');
    bot.pathfinder?.setGoal?.(null);
    const end = Date.now() + 3000;
    while (Date.now() < end && (inLava() || !bot.entity.onGround)) {
        await bot.lookAt(target.offset(0, 1.6, 0), true);
        for (const k of ['forward', 'jump', 'sprint']) bot.setControlState(k, true);
        await new Promise((r) => setTimeout(r, 50));
    }
    bot.clearControlStates();
    return !inLava();
}

/** Within reach of a sword now: at most 3 blocks across and about her own level (owner 10-27 19:5x, unreachable mobs), or a visible point
 * of its hitbox within 3 of her eyes (GPT #3947: a skeleton 2 below was in reach but counted as out of it). */
function besideHer(bot,e,st=styleFor(e.name,bot.username)) {
    const d=e.position.minus(bot.entity.position);
    return (Math.hypot(d.x,d.z)<=st.reengageRadius&&inHeight(d.y,st.reengageDy))||(st.reengageOnVisibleReach&&!!meleePoint(bot,e));
}

const modes_list = [
    // creeper_dodge first: a lit fuse is 1.5 s, and a mode that is running (self_preservation fleeing at 5 HP, 10:1x) stops the
    // modes after it from even being looked at - the dodge never fired and she was blown up.
    {
        // Owner 10-27 08:2x "退一步": a creeper lit within 3 blocks - the body backs off on its own, then she is told and decides. Told at 1-2 m
        // she could not answer before the 1.5 s fuse (DeepSeek #3615: 02:00, 04:13, 05:46 deaths one second after the notice). Only a lit
        // creeper, only a bounded step facing it (fight.js retreat: no drops, 2 s), never while her own fight or the reflex handles it.
        name: 'creeper_dodge',
        description: '已点燃苦力怕短退；默认关，开启后使用你在fight_style里设的blast开关、距离、高差、预算和冷却。只报告实际结果，不保证安全。',
        interrupts: ['all'],
        // owner 10-28: a tool she may turn on (!setMode), not a script forced on her
        on: false,
        active: false,
        dodged: {},
        update: async function (agent) {
            const bot = agent.bot, me = bot.entity?.position, now = Date.now();
            if (!me || /^(mode:self_defense|action:(fight|retreat|block|shoot))$/.test(agent.actions.currentActionLabel || '')) return;
            const st=styleNow(agent,'creeper');
            if(!st.blastDodgeEnabled||st.blastBudgetMs===0||st.blastRetreatTo===0)return;
            const lit=world.getNearestEntityWhere(bot,e=>e.name==='creeper'&&world.isAlive(bot,e)&&inHeight(e.position.y-me.y,st.blastTriggerDy,true)&&fuseObserved(bot,e),st.blastTriggerRange);
            if(!lit||!claimBlast(bot,lit,st,now))return;
            const d0 = lit.position.distanceTo(me);
            execute(this, agent, async () => {
                // final-100 01:47: she was eating when it lit - eating slows the walk, so the food is let go first
                if (bot.usingHeldItem) { try { bot.deactivateItem(); } catch { /* best effort */ } }
                // owner 10-29 ("可以被炸，但完全不动"): the lane-by-lane retreat stood still at her house twice; the pathfinder walks away
                const r = await stepAway(bot, lit, { distance: Math.max(6, st.blastRetreatTo || 0), timeoutMs: st.blastBudgetMs });
                const d1 = Number.isFinite(r.endDistance) ? Math.round(r.endDistance * 10) / 10 : null;
                skills.log(bot, `苦力怕在你 ${Math.round(d0 * 10) / 10} 格内点燃了引信，身体自己往后退了一下：`
                    + (r.result === 'opened' ? `退到了 ${d1} 格外` : r.result === 'blocked' ? `四周走不开，没退开（现在 ${d1 ?? '?'} 格）` : r.result === 'interrupted' ? `短退已中断，现在 ${d1 ?? '?'} 格` : `本次预算${st.blastBudgetMs/1000}秒，现在 ${d1 ?? '?'} 格`)
                    + '。爆炸半径约 3 格。接下来跑、打还是堵，你自己定。');
            },actionBudgetMinutes(st.blastBudgetMs));
        }
    },
    {
        // Owner 10-27 14:0x/14:3x 落地水: the work happens on every physics tick in library/water_clutch.js; this entry is her switch and
        // what !modes tells her. It never moves her unless she is falling far enough to be hurt and carries a water bucket.
        name: 'water_clutch',
        description: '落地水：从会摔伤的高度（3 格以上）掉下来、身上又带着水桶时，落地前身体自己低头往脚下放一桶水接住，落进水里后再把水收回桶里，事后告诉你。没有水桶就什么也不做。下界里水会蒸发；落在树叶、台阶、楼梯、栅栏这类会把水吸进去的方块上或岩浆上不放；掉得很高时下落太快，不保证每次都接得住。默认关着，想用就用 !setMode 打开。',
        interrupts: [],
        // owner 10-28: a tool she may turn on (!setMode), not a script forced on her. GPT #3751/#3759: stone/grass 10-40 blocks 60/60,
        // bag 10/10, walking fall 1/1; leaves/slab/Nether place nothing
        on: false,
        active: false,
        update: async function () { /* per-tick work: library/water_clutch.js */ }
    },
    {
        name: 'self_preservation',
        description: 'Respond to drowning, burning, and damage at low health. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        fall_blocks: ['sand', 'gravel', 'concrete_powder'], // includes matching substrings like 'sandstone' and 'red_sand'
        update: async function (agent) {
            const bot = agent.bot;
            let block = bot.blockAt(bot.entity.position);
            let blockAbove = bot.blockAt(bot.entity.position.offset(0, 1, 0));
            if (!block) block = {name: 'air'}; // hacky fix when blocks are not loaded
            if (!blockAbove) blockAbove = {name: 'air'};
            if (blockAbove.name === 'water') {
                // Owner 10-28: under water the body does nothing on its own - no jump when idle (it floated her up and pushed
                // against !swimDown). Her air is in !stats; !swimUp / !swimDown are hers.
            }
            else if (this.fall_blocks.some(name => blockAbove.name.includes(name))) {
                execute(this, agent, async () => {
                    await skills.moveAway(bot, 2);
                });
            }
            else if (block.name === 'lava' || block.name === 'fire' ||
                blockAbove.name === 'lava' || blockAbove.name === 'fire') {
                say(agent, 'I\'m on fire!');
                // if you have a water bucket, use it
                let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                if (waterBucket) {
                    execute(this, agent, async () => {
                        let success = await skills.placeBlock(bot, 'water_bucket', block.position.x, block.position.y, block.position.z);
                        if (success) say(agent, 'Placed some water, ahhhh that\'s better!');
                    });
                }
                else {
                    execute(this, agent, async () => {
                        let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                        if (waterBucket) {
                            let success = await skills.placeBlock(bot, 'water_bucket', block.position.x, block.position.y, block.position.z);
                            if (success) say(agent, 'Placed some water, ahhhh that\'s better!');
                            return;
                        }
                        // final-96 00:34: in a lava pool 2 blocks from the ledge she had jumped from, this walked her toward water 4+ blocks
                        // away through the lava (17 -> 2 HP in 3 s, dead). Out of the lava onto the nearest safe cell first.
                        if (/lava/.test(block.name + blockAbove.name)) {
                            const hp = Math.round(bot.health);
                            if (await outOfLava(bot)) { skills.log(bot, `自保：你掉进了岩浆，身体先冲回最近的安全落脚点（血 ${hp}→${Math.round(bot.health)}）。身上还在烧的话，找水或者等火灭。`); return; }
                        }
                        let nearestWater = world.getNearestBlock(bot, 'water', 20);
                        if (nearestWater) {
                            const pos = nearestWater.position;
                            let success = await skills.goToPosition(bot, pos.x, pos.y, pos.z, 0.2);
                            if (success) say(agent, 'Found some water, ahhhh that\'s better!');
                            return;
                        }
                        await skills.moveAway(bot, 5);
                    });
                }
            }
            else if (Date.now() - bot.lastDamageTime < 3000 && (bot.health < 5 || bot.lastDamageTaken >= bot.health)) {
                // Owner 10-26 20:0x "自保也要智能一些". The old step walked 20 blocks any way at all: into other mobs, down drops (19:35, 0.5 HP,
                // fell to death), and with no food she still could not heal ("饿着肚子回不了血"). Now: run *from* the mobs for a few seconds without
                // long drops, eat if she has food and nothing is right beside her, and tell her what happened. Nothing near and nothing to eat: stay put.
                // A fight already under way keeps the body: the hit-back reflex fights-while-retreating below her line (owner 10-26), and
                // her own !fight/!retreat/!block/!shoot are her choice. DeepSeek #3599: 4 of 4 "action_cancelled" fights tonight were this
                // mode taking over in the same second, during !stay, at 5-7 HP; 3 of those 4 died within 15 s. It steps in once the fight ends.
                const busy = agent.actions.currentActionLabel || '';
                // her own !consume too: eating is her saving herself (DeepSeek #3623: 04:55 she said "先吃点熟牛肉垫上", this kept taking over)
                if (/^(mode:self_defense|action:(fight|retreat|block|shoot|consume))$/.test(busy)) return;
                // archers count from 20 blocks: they shoot from about 15 (02:3x she was shot dead by one 11-15 blocks off)
                const enemy = world.getNearestEntityWhere(bot, (e) => mc.isHostile(e) && world.isAlive(bot, e) && e.name !== 'enderman'
                    && (e.position.distanceTo(bot.entity.position) < 12 || /^(skeleton|stray|bogged|pillager)$/.test(e.name)), 20);
                const food = skills.bestFood(bot);
                if (!enemy && !(food && bot.food < 20)) return;
                say(agent, 'I\'m dying!');
                const startHp = bot.health;
                execute(this, agent, async () => {
                    const held = bot.heldItem?.name;
                    // 2026-10-27 02:1x: she died while running; this then read her respawned 20/20 and said she had got away.
                    let died = false;
                    const onDeath = () => { died = true; };
                    bot.once('death', onDeath);
                    const r = enemy ? await skills.fleeFromEnemies(bot, 12, 6000).finally(() => bot.removeListener('death', onDeath)) : { fled: false, nearest: null };
                    if (!enemy) bot.removeListener('death', onDeath);
                    if (died || bot.health <= 0) {   // 02:3x: health 0 came a moment before the death event
                        skills.log(bot, `自保：从 ${enemy.name} 那边跑的时候，你还是被打死了（跑之前血 ${Math.round(startHp)}/20）。`);
                        return;
                    }
                    const meal = skills.bestFood(bot), beside = world.getNearestEntityWhere(bot, (e) => mc.isHostile(e) && world.isAlive(bot, e), 4);
                    let ate = null;
                    if (meal && bot.food < 20 && !beside) {
                        if (await skills.consume(bot, meal.name)) ate = meal.name;
                        const back = held && held !== meal.name && bot.inventory.items().find((i) => i.name === held);
                        if (back) await bot.equip(back, 'hand').catch(() => {});
                    }
                    // 05:5x "你的血 0/20 ... 跑开了" while she was alive at 0.4
                    const hpNow = bot.health > 0 && bot.health < 1 ? '不到 1' : Math.round(bot.health);
                    skills.log(bot, `自保：你的血 ${hpNow}/20，饱食度 ${bot.food}/20。`
                        + (enemy ? (r.nearest ? `从 ${enemy.name} 那边跑开了，现在最近的是 ${r.nearest.name}，离你 ${r.nearest.d} 格` : `从 ${enemy.name} 那边跑开了，24 格内没有怪了`) : '附近没有怪')
                        + (ate ? `；吃了 ${ate}` : meal ? (bot.food >= 20 ? '；饱食度满的，没吃' : '；怪就在旁边，没顾上吃') : '；身上没有能吃的（饱食度不满时血回得很慢）')
                        + '。接下来怎么办你自己定。');
                });
            }
            else if (agent.isIdle()) {
                bot.clearControlStates(); // clear jump if not in danger or doing anything else
            }
        }
    },
    {
        name: 'unstuck',
        description: 'When an action has tried to move for 20 s without getting 2 blocks anywhere, stops it and tells you where; it does not move you.',
        interrupts: ['all'],
        on: true,
        active: false,
        prev_location: null,
        distance: 2,
        stuck_time: 0,
        last_time: Date.now(),
        max_stuck_time: 20,
        prev_dig_block: null,
        update: async function (agent) {
            if (agent.isIdle()) { 
                this.prev_location = null;
                this.stuck_time = 0;
                return; // don't get stuck when idle
            }
            const bot = agent.bot;
            const cur_dig_block = bot.targetDigBlock;
            // Stuck means trying to move (or dig) and not getting anywhere. Standing still on purpose is not: 2026-10-27 03:50 it cut her
            // fishing line again ("unstuck 一接管就把甩竿打断，跟记的教训一样") while fish were the food she was short of. The same goes
            // for waiting at a furnace or building in place.
            // Actions whose whole job is to go somewhere or gather count as trying the whole time: 04:46 a !collectBlocks hung in some wait
            // with nothing moving, and with only the checks below nothing came for it (10-minute timeout).
            const goingAction = /^action:(collectBlocks|goTo\w*|searchFor\w*|moveAway|getDiamondPickaxe)$/.test(agent.actions.currentActionLabel || '');
            // A pathfinder goal still set means she is trying to get somewhere, whatever called it: 05:5x her own code's goToPosition sat
            // 3+ min inside the shell she had sealed herself in (no path, so isMoving() stayed false).
            // final-83 18:0x: with her head in water the swim reflex holds jump; that was read as trying and cut her !placeHere
            const swimming = bot.blockAt(bot.entity.position.offset(0, 1, 0))?.name === 'water';
            const trying = goingAction || bot.pathfinder?.isMoving?.() || !!bot.pathfinder?.goal || cur_dig_block
                || ['forward', 'back', 'left', 'right', ...(swimming ? [] : ['jump'])].some((k) => bot.getControlState?.(k));
            if (!trying) {
                this.prev_location = null;
                this.stuck_time = 0;
                this.last_time = Date.now();
                return;
            }
            if (cur_dig_block && !this.prev_dig_block) {
                this.prev_dig_block = cur_dig_block;
            }
            if (this.prev_location && this.prev_location.distanceTo(bot.entity.position) < this.distance && cur_dig_block == this.prev_dig_block) {
                this.stuck_time += (Date.now() - this.last_time) / 1000;
            }
            else {
                this.prev_location = bot.entity.position.clone();
                this.stuck_time = 0;
                this.prev_dig_block = null;
            }
            const max_stuck_time = cur_dig_block?.name === 'obsidian' ? this.max_stuck_time * 2 : this.max_stuck_time;
            if (this.stuck_time > max_stuck_time) {
                say(agent, 'I\'m stuck!');
                this.stuck_time = 0;
                const label = (agent.actions.currentActionLabel || '').replace(/^action:/, '!'), p = bot.entity.position;
                const where = `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`, secs = Math.round(max_stuck_time);
                // final-96 00:0x: three commands in a row stuck at (27,33,19) in a pool (water below and around her) - she was told only a coordinate
                const wet = [p, p.offset(0, -1, 0)].some((q) => bot.blockAt(q)?.name === 'water') ? '你现在泡在水里（脚下是水），寻路在水里常常走不动。' : '';
                execute(this, agent, async () => {
                    // dafeiyu 2026-10-25: upstream killed the whole process here after 10 s, so a dense forest restarted her every few minutes.
                    // Owner 10-27 "先修自动脱困打断她自救动作": the 5-block step away that replaced it went any way at all - final-87 18:4x it took
                    // her from y 13 to 9, deeper, in the middle of !goToSurface. Now the stuck action stops, every key is released, and she is
                    // told what, where and for how long; the body is not moved for her.
                    bot.pathfinder?.setGoal?.(null); bot.clearControlStates();
                    skills.log(bot, `你的 ${label || '动作'} 有 ${secs} 秒没挪动 2 格（卡在 ${where} 附近），已经停下了，身体没替你挪。${wet}`
                        + '下一步你自己决定：换条路、挖开、垫方块、!pillarUp 往上爬、!moveAway 走开一段，或者喊人帮忙。');
                });
            }
            this.last_time = Date.now();
        },
        unpause: function () {
            this.prev_location = null;
            this.stuck_time = 0;
            this.prev_dig_block = null;
        }
    },
    {
        name: 'cowardice',
        description: 'Run away from enemies. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        update: async function (agent) {
            const enemy = world.getNearestEntityWhere(agent.bot, entity => mc.isHostile(entity) && world.isAlive(agent.bot, entity), 16);
            if (enemy && await world.isClearPath(agent.bot, enemy)) {
                say(agent, `Aaa! A ${enemy.name.replace("_", " ")}!`);
                execute(this, agent, async () => {
                    await skills.avoidEnemies(agent.bot, 24);
                });
            }
        }
    },
    {
        // Owner 10-26 (final plan #3422): "被打还手执行 fight 是正常的，因为 ai 确实没有反应能力" - but what to do when one only comes closer is
        // hers. So this fires only on a confirmed hit by a living hostile (agent.js lastAttacker, from the server's damage source) and
        // fights it with her own style for that mob through the same engine as !fight. A player hitting her never triggers it.
        name: 'self_defense',
        // Owner 10-26 20:1x, DeepSeek #3519: she read "self defence" as charging in and running back and forth ("跟它硬碰纯送命", "来回跑反而送命") and
        // turned it off. Named by what it does, in her language, with what it never does and what being off means - facts, not advice.
        description: '真实挨打才按你给该怪设的fight_style反射；总开关、每怪开关、重试/冷却/低血回应均由你选择，!fightStyle看实际值。已有fight/block/shoot/retreat不被另一个控制器抢走。',
        interrupts: ['all'],
        on: true,
        active: false,
        handledAt: 0,
        quietUntil: {},
        stuckAway: {},
        unreachable: {},
        update: async function (agent) {
            const bot = agent.bot, hit = bot.lastAttacker, now = Date.now();
            if(!hit||hit.at<=this.handledAt||!hit.entity?.name)return;
            const st=styleNow(agent,hit.entity.name);
            if(!st.reflexEnabled||now-hit.at>st.hitWindowMs)return;
            // her own fight, shield or shot takes the hit itself (GPT #3418: do not restart a defence on every blow)
            if (/^action:(fight|block|shoot|retreat)$/.test(agent.actions.currentActionLabel || '')) return;
            const enemy = hit.entity;
            this.handledAt = hit.at;
            if (!world.isAlive(bot, enemy) || bot.entities?.[enemy.id] !== enemy || enemy.position.distanceTo(bot.entity.position) > st.reflexRange) return;
            // the same one again right after a fight that did not finish it (she broke off, or could not get away): hers to decide
            // ...unless she is under her line now: final-26 23:3x a fight began at 13 HP, broke off at 10 (path blocked), and the quiet window
            // then left 10 -> 8 -> 5 -> dead unanswered. Under her line every hit is answered, whenever she got there.
            const underLine = Number.isFinite(bot.health) && bot.health <= st.disengageHp;
            if (now < (this.quietUntil[enemy.id] || 0) && !(underLine&&st.retryBelowLine)) return;
            // ...but a mob she avoids that she just could not back away from is not stepped back from again (DeepSeek #3665: an enderman,
            // 10:09:43-48, four back-offs "retreat_blocked_contact_not_broken" in 5 s, each one taking her body, 16 -> 1 HP, dead). Hers to decide.
            if (now < (this.stuckAway[enemy.id] || 0)) return;
            // owner 10-27 19:5x "够不着的怪反射不再反复接近，告诉她位置和办法，由她自己决定": final-90 19:46-19:49 one skeleton 4 below her,
            // 10 reflex fights, 0 reached (approach_blocked x7), each one cancelling her !stay; dead twice. One it could not reach is not
            // gone after again for 30 s unless it comes up beside her; danger_notice tells her where it is and the ways out.
            if (now < (this.unreachable[enemy.id] || 0) && !besideHer(bot,enemy,st)) return;
            // at or under her own break-off line the reflex does not start a fight she has said to leave; runEncounter only steps back
            // (owner 10-26 "低于撤退线时反射改成短后退" - standing still there got her shot, DeepSeek #3473)
            say(agent, `Fighting ${enemy.name}!`);
            execute(this, agent, async () => {
                const { record } = await runEncounter(agent, enemy, { caller: 'self_defense', trigger: 'hit',style:st });
                this.handledAt = Date.now();
                // under her line there is no quiet window: every hit is answered (DeepSeek #3517: 8 s of "no-reflex" then dead, three times)
                if (record.result !== 'killed' && (!record.belowLine||!st.retryBelowLine)) this.quietUntil[enemy.id] = Date.now() + st.retryDelayMs;
                if (record.tactic === 'avoid' && !/^retreat_(opened|kept)$/.test(record.reason || '')) this.stuckAway[enemy.id] = Date.now() + st.avoidRetryDelayMs;
                if (/^(approach_blocked|target_out_of_range)$/.test(record.reason || '')) this.unreachable[enemy.id] = Date.now() + st.unreachableRetryMs;
            },actionBudgetMinutes(st.encounterBudgetMs,st.retreatBudgetMs));
        }
    },
    {
        // Facts about danger, nothing more (owner 10-26: what to do when something comes closer is her decision). It never moves her and
        // never stops what she is doing - except a hit with nothing fighting back for her, so that she gets her turn. Texts: DeepSeek #3423.
        name: 'danger_notice',
        description: 'Tells you facts about danger - something hostile coming your way, a creeper near you, being hit, a player hitting you. It never moves you; it only stops what you are doing when something hits you and nothing fights back for you.',
        interrupts: ['all'],
        on: true,
        active: false,
        last: 0,
        told: {},
        seen: {},
        hitTold: 0,
        playerTold: 0,
        update: async function (agent) {
            const bot = agent.bot, now = Date.now(), me = bot.entity.position;
            const label = agent.actions.currentActionLabel || '';
            if (/^action:(fight|block|shoot|retreat)$/.test(label) || bot.pvp?.target) return;   // she is already dealing with it
            const hp = Math.round(bot.health);
            // final-104 03:15/03:40: creepers caught her in the flooded pit by her house - in water she could not back away (2.48 at best in the lab)
            const inWater = () => [me, me.offset(0, 1, 0)].some((p) => bot.blockAt(p)?.name === 'water') ? '你在水里：水里走得慢，苦力怕贴近时很难退开。' : '';
            const where = (e) => {
                const d = e.position.minus(me), dist = Math.round(Math.hypot(d.x, d.z));
                const dir = (Math.abs(d.z) > Math.abs(d.x) * 2 ? '' : d.x > 0 ? '东' : '西') + (Math.abs(d.x) > Math.abs(d.z) * 2 ? '' : d.z < 0 ? '北' : '南');
                const dy = Math.round(d.y);
                return `在你${dir || '旁边'} ${dist} 格${dy > 1 ? `、高 ${dy} 格` : dy < -1 ? `、低 ${-dy} 格` : ''}`;
            };
            // DeepSeek #3742 (14:28): "苦力怕贴过来了" then "咦，突然又变 21 格了？" - two creepers, one 10 blocks south and one coming from 21;
            // the notices never said there were two, so she read one creeper's distance jumping. How many there are, and which one this is.
            const others = (e) => {
                const same = Object.values(bot.entities || {}).filter((o) => o !== e && o.name === e.name && world.isAlive(bot, o) && o.position.distanceTo(me) <= 24);
                return same.length ? `（24 格内一共有 ${same.length + 1} 只 ${e.name}，这条说的是${where(e)}的那只。）` : '';
            };
            const bare = (e) => {
                if (bot.heldItem) return '';
                const mine = e ? handStats(agent.name, e.name) : null;
                if (mine) return `你现在空手。上次空手打 ${e.name}：${mine.n} 场，挥了 ${mine.swings} 下、${mine.hits} 次伤到它，平均掉 ${mine.dmg} 血，打死 ${mine.killed}/${mine.n}。`;
                const its = e ? observedTargetHealth(bot, e) : null;
                return `你现在空手：没有增益时满蓄力一拳基础伤害 1（原版数值）${e ? `，${e.name} 现在的血${Number.isFinite(its) ? ` ${Math.round(its)}` : '看不到'}` : ''}。`;
            };
            const tell = (text, kind, why, stop = false) => {
                this.noticeAt = Date.now();
                logDecision({ gate: kind === 'approach' ? 'approach' : 'danger', options: ['notice'], chosen: 'notice', why });
                console.log(`【危险】${text}`);
                const busy = !!label;
                const stopped = stop && busy && !label.startsWith('mode:') ? agent.actions.stop('mode:danger_notice') : Promise.resolve();
                if (agent.self_prompter.isActive() || (busy && !stop)) { agent.history.add('system', `【危险】${text}`)?.catch?.(() => {}); stopped.catch(() => {}); }
                else stopped.then(() => agent.handleMessage('system', `【危险】${text}`, 1)).catch(() => {});
            };
            // 1. a hostile hit her
            const hit = bot.lastAttacker;
            if (hit && now - hit.at < 1500 && hit.at > this.hitTold) {
                this.hitTold = hit.at;
                const e = hit.entity;
                // final-99 01:3x: the reflex had just killed it (6 -> 0); its last blow arrived after and was told as an attack on "a mob
                // it cannot reach" - she set out to fight a dead zombie. A blow from one already dead is not an attack now.
                if (!world.isAlive(bot, e) || hit.at <= (bot._diedAt || 0)) return;
                // (when the reflex does take it, this mode is not reached that tick - the takeover line in execute() tells her)
                const st=styleNow(agent,e.name),line=st.disengageHp,low=Number.isFinite(bot.health)&&bot.health<=line;
                const sd = modes_map.self_defense, stuck = now < (sd.stuckAway?.[e.id] || 0), unreach = now < (sd.unreachable?.[e.id] || 0) && !besideHer(bot,e,st);
                const quiet = (now < (sd.quietUntil?.[e.id] || 0) && !(low&&st.retryBelowLine)) || stuck || unreach;
                const reflex = bot.modes?.isOn?.('self_defense') && !bot.modes?.isPaused?.('self_defense') && st.reflexEnabled && !quiet;
                const how = st.tactic === 'avoid' ? `${e.name}在你的打法里是avoid；回应=${st.avoidResponse}，不挥击`
                    : low ? (/^(skeleton|stray|bogged|pillager|blaze)$/.test(e.name) ? `你的血在撤退线（${line}）以下，回应=${st.belowLineResponse}` : `你的血在撤退线（${line}）以下，回应=${st.belowLineResponse}`)
                    : `会用你给 ${e.name} 定的打法还手`;
                // arena feedback 10-26 "打到一半想判断要不要退就靠猜": the attacker's health as observed right now
                const itsHp = observedTargetHealth(bot, e), its = Number.isFinite(itsHp) ? `，${e.name} 现在 ${Math.round(itsHp)} 血` : '';
                // 10:2x she was killed by an angry enderman at 1 HP while backing off from it - it teleports after you; two vanilla facts
                const fact = e.name === 'enderman' ? '惹怒的末影人会瞬移追你，往后退甩不掉；它有 3 格高，钻不进不到 3 格高的地方（站到 2 格高的顶棚下它就打不着你），碰到水会受伤并瞬移走。'
                    : e.name === 'witch' ? witchFact(agent) : '';
                if (reflex) return tell(`${e.name} 在打你（你 ${hp}/20${its}）；被打还手开着，${how}。${fact}${bare(e)}`, 'hit', `${e.name} hit reflex${low ? ' low' : ''}`);
                // off: say what it would have done (DeepSeek #3519: the other half of the same fact), never that she should turn it on
                const why = !st.reflexEnabled ? '你把这种怪的reflexEnabled关了，没有触发还手。' : !bot.modes?.isOn?.('self_defense') ? `被打还手现在关着，没有动作被触发。开着的话：${how}`
                    : unreach ? `被打还手刚才走不到它身边，近战够不着它，在你设的${st.unreachableRetryMs/1000}秒冷却内不再去够这只，除非它到了你身边${/^(skeleton|stray|bogged|pillager|blaze)$/.test(e.name) ? `；${e.name} 会站在远处一直射你` : ''}。`
                        + '能做的有：垫方块上去或挖下去，走到够得着它的地方；在你和它之间放方块挡住视线；躲到它看不见你的地方；身上有弓的话用 !shoot。怎么办你自己定'
                    : stuck ? `刚才没退开，按你设的${st.avoidRetryDelayMs/1000}秒冷却不再替你退这只`
                    : quiet ? `刚打过一场没打完，按你设的${st.retryDelayMs/1000}秒冷却暂不接手这只` : '被打还手这会儿被暂停了，没有动作被触发';
                return tell(`${e.name} 在打你（你 ${hp}/20，它${where(e)}${its}）；${why}。${fact}${bare(e)}`, 'hit', `${e.name} hit no-reflex`, true);
            }
            // 2. a player hit her - never a reflex; whether to hit back is hers to think about (owner 10-26)
            const ph = bot.lastPlayerHit;
            if (ph && now - ph.at < 1500 && ph.at > this.playerTold) {
                this.playerTold = ph.at;
                const taken = Math.round(bot.lastDamageTaken || 0);
                return tell(`${ph.name} 打了你一下（你 ${hp}/20${taken ? `，掉了 ${taken}` : ''}，${ph.entity?.position ? `他${where(ph.entity)}` : '看不到他在哪'}）。`, 'player_hit', `${ph.name} hit`);
            }
            // 2b. a creeper within 4 blocks: stop what she is doing and hand her the turn (owner 10-26 19:1x: "苦力怕进到 4 格内时停下她手上的动作、
            // 把提示交给她，让她自己决定跑、打还是堵，我们不替她动"). DeepSeek #3507: told at 4 m, she spent 12 s picking up drops, mining and placing a
            // torch before "先跑" - the notice never reached her turn. Once per creeper; never moves her; the body modes protecting her are left alone.
            const close = world.getNearestEntityWhere(bot, (e) => e.name === 'creeper' && world.isAlive(bot, e) && Math.abs(e.position.y - me.y) < 3, 4);
            if (close && !(this.closeTold ||= {})[close.id]) {
                this.closeTold[close.id] = now; this.told[close.id] = now; this.last = now;
                handBackUntil = now + 5000;
                // final-18 19:2x: at 4 HP she was running (!moveAway) from one creeper and this stopped her run; a second creeper killed her.
                // An action begun after a danger notice is her answer to it - fleeing, backing off, walling up - and is never stopped.
                const answering = (agent.actions.currentActionStartedAt || 0) >= (this.noticeAt || Infinity);
                this.noticeAt = now;
                const stoppable = label && !label.startsWith('mode:self_') && label !== 'mode:cowardice' && !answering;
                const text = `【危险】creeper ${where(close)}，已经进到 4 格内（你 ${hp}/20）。苦力怕 3 格内点燃引信，约 1.5 秒后炸，爆炸半径约 3 格；点燃短退仅在你开启creeper_dodge且该怪blastDodgeEnabled时，按你的blast配置执行。${inWater()}`
                    + `${stoppable ? `你手上的 ${label.replace(/^(action|mode):/, '')} 先停下了，` : ''}跑、打还是堵，你自己定。${bare(close)}`;
                logDecision({ gate: 'danger', options: ['notice'], chosen: 'notice', why: `creeper ${Math.round(close.position.distanceTo(me))}m close stop` });
                console.log(text);
                const stopped = stoppable ? agent.actions.stop('mode:danger_notice') : Promise.resolve();
                stopped.then(() => agent.self_prompter.isActive() ? agent.history.add('system', text) : agent.handleMessage('system', text, 1)).catch(() => {});
                return;
            }
            if (now - this.last < 6000) return;
            // 3. a creeper near her: its mechanism, once per creeper per 20 s
            const creeper = world.getNearestEntityWhere(bot, (e) => e.name === 'creeper' && world.isAlive(bot, e) && Math.abs(e.position.y - me.y) < 3, 10);
            if (creeper && now - (this.told[creeper.id] || 0) > 20000) {
                this.last = now; this.told[creeper.id] = now;
                return tell(`creeper ${where(creeper)}（你 ${hp}/20）。苦力怕：3 格内点燃引信，约 1.5 秒后炸；爆炸半径约 3 格，贴身处会掉十几点血。${inWater()}${others(creeper)}${bare(creeper)}`, 'creeper', `creeper ${Math.round(creeper.position.distanceTo(me))}m`);
            }
            // 3b. a witch within 16: what she is and what fighting her would take (owner 10-27 11:2x), once per witch per 2 min
            const witch = world.getNearestEntityWhere(bot, (e) => e.name === 'witch' && world.isAlive(bot, e) && Math.abs(e.position.y - me.y) < 6, 16);
            if (witch && now - ((this.witchTold ||= {})[witch.id] || 0) > 120000) {
                this.last = now; this.witchTold[witch.id] = now; this.told[witch.id] = now;
                return tell(`witch ${where(witch)}（你 ${hp}/20）。${witchFact(agent)}${bare(witch)}`, 'witch', `witch ${Math.round(witch.position.distanceTo(me))}m`);
            }
            // 4. something hostile coming her way, far enough out that she has time to think (DeepSeek #3402: ~20 blocks)
            for (const e of Object.values(bot.entities || {})) {
                if (e === bot.entity || !mc.isHostile(e) || !world.isAlive(bot, e) || Math.abs(e.position.y - me.y) >= 3) continue;   // same reach as !fight (DeepSeek #3433)
                const d = e.position.distanceTo(me);
                if (d > FIGHT_REACH) { delete this.seen[e.id]; continue; }
                const before = this.seen[e.id];
                // DeepSeek #3462 (arena, her words "实际是它随便晃悠"): 48 notices, median closing speed 0. The old gap shrink over 1 s counted
                // her own walking and one wander step. Now: only the mob's own movement toward her, over at least 2 s, at walking pace.
                if (!before || now - before.at < 2000) { if (!before) this.seen[e.id] = { pos: e.position.clone(), at: now }; continue; }
                this.seen[e.id] = { pos: e.position.clone(), at: now };
                const to = me.minus(before.pos), len = Math.hypot(to.x, to.z) || 1, moved = e.position.minus(before.pos);
                const speed = (moved.x * to.x + moved.z * to.z) / len / ((now - before.at) / 1000);
                if (speed < 1 || d < 8 || now - (this.told[e.id] || 0) < 20000) continue;
                // final-1 15:0x: a skeleton pacing at 21-26 blocks was announced every 20 s; again only once it is 5 blocks closer
                if (this.toldDist?.[e.id] !== undefined && d > this.toldDist[e.id] - 5 && now - (this.told[e.id] || 0) < 120000) continue;
                this.last = now; this.told[e.id] = now; (this.toldDist ||= {})[e.id] = d;
                return tell(`${e.name} 在 ${Math.round(d)} 格外，朝你这边过来（约 ${Math.max(1, Math.round(d / speed))} 秒后到你身边）。${others(e)}${bare(e)}`, 'approach', `${e.name} ${Math.round(d)}m approaching`);
            }
        }
    },
    {
        name: 'hunting',
        description: 'Hunt nearby animals when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        update: async function (agent) {
            const huntable = world.getNearestEntityWhere(agent.bot, entity => mc.isHuntable(entity), 8);
            if (huntable && await world.isClearPath(agent.bot, huntable)) {
                execute(this, agent, async () => {
                    say(agent, `Hunting ${huntable.name}!`);
                    await skills.attackEntity(agent.bot, huntable);
                });
            }
        }
    },
    {
        name: 'item_collecting',
        description: 'Collect nearby items when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,

        wait: 2, // number of seconds to wait after noticing an item to pick it up
        prev_item: null,
        noticed_at: -1,
        update: async function (agent) {
            // dafeiyu: not what she just threw away herself (agent.js keeps bot.ignoredItems)
            let item = world.getNearestEntityWhere(agent.bot, entity => entity.name === 'item' && !agent.bot.ignoredItems?.has(entity.id), 8);
            let empty_inv_slots = agent.bot.inventory.emptySlotCount();
            if (item && item !== this.prev_item && await world.isClearPath(agent.bot, item) && empty_inv_slots > 1) {
                if (this.noticed_at === -1) {
                    this.noticed_at = Date.now();
                }
                if (Date.now() - this.noticed_at > this.wait * 1000) {
                    say(agent, `Picking up item!`);
                    this.prev_item = item;
                    execute(this, agent, async () => {
                        await pickupKeptItems(agent.bot);   // dafeiyu: skips her own fresh discards (library/pickup.js)
                    });
                    this.noticed_at = -1;
                }
            }
            else {
                this.noticed_at = -1;
            }
        }
    },
    {
        name: 'torch_placing',
        description: 'Place torches when idle and there are no torches nearby.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        cooldown: 5,
        last_place: Date.now(),
        update: function (agent) {
            if (world.shouldPlaceTorch(agent.bot)) {
                if (Date.now() - this.last_place < this.cooldown * 1000) return;
                execute(this, agent, async () => {
                    const pos = agent.bot.entity.position;
                    await skills.placeBlock(agent.bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
                });
                this.last_place = Date.now();
            }
        }
    },
    {
        name: 'elbow_room',
        description: 'Move away from nearby players when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        distance: 0.5,
        update: async function (agent) {
            const player = world.getNearestEntityWhere(agent.bot, entity => entity.type === 'player', this.distance);
            if (player) {
                execute(this, agent, async () => {
                    // wait a random amount of time to avoid identical movements with other bots
                    const wait_time = Math.random() * 1000;
                    await new Promise(resolve => setTimeout(resolve, wait_time));
                    if (player.position.distanceTo(agent.bot.entity.position) < this.distance) {
                        await skills.moveAwayFromEntity(agent.bot, player, this.distance);
                    }
                });
            }
        }
    },
    {
        name: 'idle_staring',
        description: 'Animation to look around at entities when idle.',
        interrupts: [],
        on: true,
        active: false,

        staring: false,
        last_entity: null,
        next_change: 0,
        update: function (agent) {
            const entity = agent.bot.nearestEntity();
            let entity_in_view = entity && entity.position.distanceTo(agent.bot.entity.position) < 10 && entity.name !== 'enderman';
            if (entity_in_view && entity !== this.last_entity) {
                this.staring = true;
                this.last_entity = entity;
                this.next_change = Date.now() + Math.random() * 1000 + 4000;
            }
            if (entity_in_view && this.staring) {
                let isbaby = entity.type !== 'player' && entity.metadata[16];
                let height = isbaby ? entity.height/2 : entity.height;
                agent.bot.lookAt(entity.position.offset(0, height, 0));
            }
            if (!entity_in_view)
                this.last_entity = null;
            if (Date.now() > this.next_change) {
                // look in random direction
                this.staring = Math.random() < 0.3;
                if (!this.staring) {
                    const yaw = Math.random() * Math.PI * 2;
                    const pitch = (Math.random() * Math.PI/2) - Math.PI/4;
                    agent.bot.look(yaw, pitch, false);
                }
                this.next_change = Date.now() + Math.random() * 10000 + 2000;
            }
        }
    },
    {
        name: 'cheat',
        // owner 10-28 "给她自己选，不滥用就行"
        description: 'Cheats: while on, walking becomes teleporting and digging/placing becomes instant commands. Off unless you turn it on; the owner leaves it to you, just do not abuse it.',
        interrupts: [],
        on: false,
        active: false,
        update: function (agent) { /* do nothing */ }
    }
];

async function execute(mode, agent, func, timeout=-1) {
    if (agent.self_prompter.isActive())
        agent.self_prompter.stopLoop();
    let interrupted_action = agent.actions.currentActionLabel;
    logDecision({ gate: 'danger', options: [mode.name], chosen: mode.name, why: String(mode.description || '').slice(0, 40) });   // a reflex: one option
    mode.active = true;
    let code_return = await agent.actions.runAction(`mode:${mode.name}`, async () => {
        await func();
    }, { timeout });
    mode.active = false;
    console.log(`Mode ${mode.name} finished executing, code_return: ${code_return.message}`);
    // !fight run 10-26 13:41: self_defense killed a zombie and she never heard it (in her own loop no reprompt is sent), then
    // called !fight on it and told the player "打倒了吧". The modes that move her body - and any mode that cut something of hers
    // short - leave one line in her history, so what her body did is something she knows, not guesses.
    const body = ['self_defense', 'self_preservation', 'cowardice', 'unstuck', 'hunting'].includes(mode.name);
    if ((body || interrupted_action) && agent.self_prompter.isActive?.()) {
        const said = String(code_return.message || '').replace(/^Action output:\s*/, '').trim().split('\n').filter(Boolean).slice(-2).join(' ');
        agent.history?.add?.('system', `（自动的 ${mode.name} 刚才接管了身体${interrupted_action && !interrupted_action.startsWith('mode:') ? `，打断了你的 ${interrupted_action.replace(/^action:/, '!')}` : ''}${said ? '：' + said.slice(0, 160) : ''}）`)?.catch?.(() => {});
    }

    let should_reprompt = 
        interrupted_action && // it interrupted a previous action
        !agent.actions.resume_func && // there is no resume function
        !agent.self_prompter.isActive() && // self prompting is not on
        !code_return.interrupted; // this mode action was not interrupted by something else

    if (should_reprompt) {
        // auto prompt to respond to the interruption
        let role = convoManager.inConversation() ? agent.last_sender : 'system';
        let logs = agent.bot.modes.flushBehaviorLog();
        agent.handleMessage(role, `(AUTO MESSAGE)Your previous action '${interrupted_action}' was interrupted by ${mode.name}.
        Your behavior log: ${logs}\nRespond accordingly.`);
    }
}

let _agent = null;
const modes_map = {};
// DeepSeek #3511: the creeper-4m rule stopped her action and torch_placing - not she - took the turn, placing a torch 3 m from it.
// For a short window after the turn is handed to her, the modes that act on their own errands stay out (her protection stays in).
let handBackUntil = 0;
const ERRAND_MODES = new Set(['torch_placing', 'item_collecting', 'hunting', 'elbow_room', 'idle_staring', 'unstuck']);
for (let mode of modes_list) {
    modes_map[mode.name] = mode;
}

class ModeController {
    /*
    SECURITY WARNING:
    ModesController must be reference isolated. Do not store references to external objects like `agent`.
    This object is accessible by LLM generated code, so any stored references are also accessible.
    This can be used to expose sensitive information by malicious prompters.
    */
    constructor() {
        this.behavior_log = '';
    }

    exists(mode_name) {
        return modes_map[mode_name] != null;
    }

    setOn(mode_name, on) {
        modes_map[mode_name].on = on;
    }

    isOn(mode_name) {
        return modes_map[mode_name].on;
    }

    isPaused(mode_name) {
        return !!modes_map[mode_name]?.paused;
    }

    pause(mode_name) {
        modes_map[mode_name].paused = true;
    }

    unpause(mode_name) {
        const mode = modes_map[mode_name];
        //if  unpause func is defined and mode is currently paused
        if (mode.unpause && mode.paused) {
            mode.unpause();
        }
        mode.paused = false;
    }

    unPauseAll() {
        for (let mode of modes_list) {
            if (mode.paused) console.log(`Unpausing mode ${mode.name}`);
            this.unpause(mode.name);
        }
    }

    getMiniDocs() { // no descriptions
        let res = 'Agent Modes:';
        for (let mode of modes_list) {
            let on = mode.on ? 'ON' : 'OFF';
            res += `\n- ${mode.name}(${on})`;
        }
        return res;
    }

    getDocs() {
        let res = 'Agent Modes:';
        for (let mode of modes_list) {
            let on = mode.on ? 'ON' : 'OFF';
            res += `\n- ${mode.name}(${on}): ${mode.description}`;
        }
        return res;
    }

    async update() {
        if (_agent.isIdle()) {
            this.unPauseAll();
        }
        for (let mode of modes_list) {
            let interruptible = mode.interrupts.some(i => i === 'all') || mode.interrupts.some(i => i === _agent.actions.currentActionLabel);
            if (ERRAND_MODES.has(mode.name) && Date.now() < handBackUntil) continue;
            if (mode.on && !mode.paused && !mode.active && (_agent.isIdle() || interruptible)) {
                await mode.update(_agent);
            }
            if (mode.active) break;
        }
    }

    flushBehaviorLog() {
        const log = this.behavior_log;
        this.behavior_log = '';
        return log;
    }

    getJson() {
        let res = {};
        for (let mode of modes_list) {
            res[mode.name] = mode.on;
        }
        return res;
    }

    loadJson(json) {
        for (let mode of modes_list) {
            if (json[mode.name] != undefined) {
                mode.on = json[mode.name];
            }
        }
    }
}

export function initModes(agent) {
    _agent = agent;
    // the mode controller is added to the bot object so it is accessible from anywhere the bot is used
    agent.bot.modes = new ModeController();
    // final-99 01:5x: a blow from before a death was told after the respawn ("drowned 在打你 ... 东 45 格、低 70 格")
    agent.bot.on?.('death', () => { agent.bot._diedAt = Date.now(); });
    if (agent.task) {
        agent.bot.restrict_to_inventory = agent.task.restrict_to_inventory;
    }
    let modes_json = agent.prompter.getInitModes();
    if (modes_json) {
        agent.bot.modes.loadJson(modes_json);
    }
}
