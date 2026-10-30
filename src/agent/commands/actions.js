import * as skills from '../library/skills.js';
import Vec3 from 'vec3';
import { buildCaveHouse } from '../library/cave-house.js';
import { pillarUp, teleportToSurface, teleportToPlayer, surroundingsFact } from '../library/escape.js';
import { swimUp, swimDown } from '../library/swim.js';
import { shear, milk } from '../library/animals.js';
import { boatTo } from '../library/boat.js';
import { addProtection, removeProtectionAt } from '../protect.js';
import { loadRespawn } from '../respawn.js';
import { getLearned, listLearned, recordUse, judgeRun, inventorySnapshot, inventoryDelta } from '../learned_skills.js';
import { createSkillFrame, moveCoords } from '../skill_frame.js';
import { lockdown } from '../library/lockdown.js';
import { buildHouse } from '../library/house.js';
import settings from '../settings.js';
import convoManager from '../conversation.js';
import { snapshot, settledSnapshot, collectFactsLine, craftFactsLine, inventoryChangeLine, heardChangeLine } from '../action_facts.js';
import { logAct, logCombat } from '../dafeiyu_log.js';
import { styleFor, styleVersion, setStyle, describe as describeStyle,TIMER_MAX,actionBudgetMinutes,SPECS } from '../fight_style.js';
import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';
import { combatStart } from '../combat_context.js';
import { runEncounter, backAway, styleNow,withinEngagement } from '../encounter.js';
import { isOneOffRequest } from '../memory/promises.js';
import { saveModeChoice } from '../mode_choices.js';
import { findPlace, allPlaceNames } from '../memory_bank.js';


// dafeiyu: facts(args, before, after) adds a measured line for that action (action_facts.js); every action also reports how her
// inventory changed, when it did.
function runAsAction (actionFn, resume = false, timeout = -1, facts = null) {
    let actionLabel = null;  // Will be set on first use
    
    const wrappedAction = async function (agent, ...args) {
        // Set actionLabel only once, when the action is first created
        if (!actionLabel) {
            const actionObj = actionsList.find(a => a.perform === wrappedAction);
            actionLabel = actionObj.name.substring(1); // Remove the ! prefix
        }

        // Count inside the action's own turn, once the server's last inventory updates have landed (2026-10-26: a craft read -3
        // planks for -2; 2026-10-27: a place read an equip half-done, DeepSeek #3573). Outside it the next action may already be
        // running and its items would be put on this one (GPT #3581). Cut short, it is the reading taken the moment it stopped.
        let after = null;
        const actionFnWithAgent = async () => {
            try { await actionFn(agent, ...args); }
            finally { after = snapshot(agent.bot); }
            after = await settledSnapshot(agent.bot);
        };
        const before = snapshot(agent.bot), startedAt = Date.now();
        const code_return = await agent.actions.runAction(`action:${actionLabel}`, actionFnWithAgent, { timeout:typeof timeout==='function'?timeout(agent,...args):timeout, resume });
        if (code_return.message === 'abandoned')
            return code_return.message;
        const change = inventoryChangeLine(before, after), lines = [];
        if (facts) lines.push(facts(args, before, after, { full: agent.bot.inventory?.emptySlotCount?.() === 0 }));
        if (facts || change !== '[实测] 背包变化：无') lines.push(change);
        const heard = agent._heardDuringAction;
        if (heard && heard.at >= startedAt && change !== '[实测] 背包变化：无') { const l = heardChangeLine(heard, after); if (l) lines.push(l); }
        if (heard && heard.at >= startedAt) agent._heardDuringAction = null;
        for (const line of lines) console.log(line);   // each facts line on its own in the host log too (DeepSeek #3026: interrupted ones never got there)
        if (code_return.interrupted && !code_return.timedout) {
            // Interrupted (a mode or a new command took over): still nothing is returned, so the agent loop stops as upstream does,
            // but what really happened goes into her history for her next turn (2026-10-26: unstuck cut !collectBlocks and the
            // facts were lost exactly when they mattered).
            if (lines.length) agent.history?.add?.('system', [`（${actionLabel} 被打断）`, ...lines].join('\n'))?.catch?.(() => {});
            return;
        }
        return lines.length ? [code_return.message, ...lines].filter(Boolean).join('\n') : code_return.message;
    }

    return wrappedAction;
}

// Only combat wrappers use this: preserve the 3-minute legacy outer guard,
// but do not silently cut a longer user policy short. 30 s is setup/cleanup.
function combatBudget(agent,type,seconds){
 const want=String(type||'nearest').toLowerCase();
 const names=want==='nearest'?[...new Set(Object.values(agent.bot.entities||{}).filter(e=>e!==agent.bot.entity&&mc.isHostile(e)&&world.isAlive(agent.bot,e)).map(e=>e.name))]:[want==='none'?'_all':want];
 const styles=(names.length?names:['_all']).map(n=>styleNow(agent,n));
 const ms=Math.max(0,...styles.flatMap(st=>[st.encounterBudgetMs,st.retreatBudgetMs,st.shotBudgetMs,st.shieldHoldMs]),Number.isFinite(seconds)&&seconds>0?seconds*1000:0);
 return actionBudgetMinutes(ms);
}

// Her !archiveMemory / !restoreMemory (memory/worlds.js). When more than 3 rows match she sees 3 of them first; the same command
// again within 2 minutes is her confirmation (commands take a fixed number of args, so no separate "confirm" argument).
function memorySort(agent, op, match) {
    const fn = op === 'archive' ? agent.memoryS?.archiveWorldRows : agent.memoryS?.restoreWorldRows;
    if (typeof fn !== 'function') return 'Memory sorting is not available.';
    const words = String(match || '').trim();
    const pending = agent._memPending;
    const confirm = !!pending && pending.op === op && pending.match === words && Date.now() - pending.at < 120000;
    agent._memPending = null;
    const r = fn.call(agent.memoryS, words, { confirm });
    if (r.needConfirm) {
        agent._memPending = { op, match: words, at: Date.now() };
        const cmd = op === 'archive' ? '!archiveMemory' : '!restoreMemory';
        return `${r.matched} memories match "${words}", for example:\n${(r.preview || []).slice(0, 3).map((p) => `- ${p.who ? p.who + ': ' : ''}${p.text}`).join('\n')}\nIf all ${r.matched} are meant, run ${cmd}("${words}") again; otherwise use more specific words.`;
    }
    if (!r.ok) return r.matched ? `Nothing changed (${r.matched} matched).` : `No memory contains "${words}".`;
    return op === 'archive'
        ? `Put away ${r.moved} memories (kept with their world, never deleted; !restoreMemory brings them back).`
        : `Brought back ${r.restored} memories (from ${(r.from || []).join(', ')}).`;
}

// !fight (contract #3351): she picks the fight, the engine (library/fight.js, GPT) runs it with her style for that mob, and what
// happened comes back as facts. One [combat] line per encounter carries what else was true at the start, so a style can later be
// compared fairly (DeepSeek #3334).
async function fightCommand(agent, type) {
    const bot = agent.bot, me = bot.entity.position, want = String(type || 'nearest').trim().toLowerCase();
    const onLevel=e=>withinEngagement(bot,e,styleNow(agent,e.name));
    const target = world.getNearestEntityWhere(bot, (e) => (want === 'nearest' ? mc.isHostile(e) : e.name === want) && world.isAlive(bot, e) && onLevel(e), 32);
    const { startedAt, ...start } = combatStart(bot, target);
    const context = { caller: 'her', trigger: 'her', ...start };
    if (!target) {
        const style = styleFor(want, agent.name), held = bot.heldItem?.name || null;
        logCombat({ ...context, target: { name: want, id: null }, tactic: style.tactic, result: 'refused', reason: 'no_target', hits: 0, swings: 0, startHp: bot.health, endHp: bot.health,
            damageTaken: 0, seconds: 0, armed: !!held && /sword|axe|trident|mace/.test(held), weapon: held || 'hand', styleVersion: styleVersion(agent.name), style });
        // DeepSeek #3419: 3/3 of her !fight aimed at a zombie the reflex had just killed - say what is around her *now*
        const around = Object.values(bot.entities || {}).filter((e) => e !== bot.entity && mc.isHostile(e) && world.isAlive(bot, e) && e.position.distanceTo(me) < 24)
            .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me)).slice(0, 4)
            .map((e) => `${e.name} ${Math.round(e.position.distanceTo(me))} 格${Math.abs(e.position.y - me.y) >= 3 ? `（${e.position.y > me.y ? '高' : '低'} ${Math.round(Math.abs(e.position.y - me.y))} 格）` : ''}`);
        // final-2 15:1x: she asked !fight for skeletons 8 blocks above her four times running - say the tool's own rule, as a fact
        // owner 10-26: "为什么不能告诉她如果想打可以挖下去打" - the ways to get there are hers to know; whether to go is still her call
        const off = Object.values(bot.entities || {}).filter((e) => e !== bot.entity && (want === 'nearest' ? mc.isHostile(e) : e.name === want) && world.isAlive(bot, e)
            && e.position.distanceTo(me) <=32 && !onLevel(e)).sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
        const below = off && off.position.y < me.y, dy = off ? Math.round(Math.abs(off.position.y - me.y)) : 0;
        const gate=off?styleNow(agent,off.name):null;
        const ways = !off ? '' : below
            ? `!fight 当前按该怪的距离/高差设置筛选（engageRange=${gate.engageRange}、engageDy=${gate.engageDy}）。想打它的话，可以先下到它那一层：!digDown(${dy}) 往下挖（脚下可能是空洞，挖穿会摔；挖到它头顶时它也够得着你），或者找路走下去；也可以等它上来，或者不打。`
            : `!fight 当前按该怪的距离/高差设置筛选（engageRange=${gate.engageRange}、engageDy=${gate.engageDy}）。想打它的话，可以先上到它那一层：在脚下垫方块往上（!placeHere 或你自己的代码）、挖台阶上去，或者找路走上去；也可以等它下来，或者不打。`;
        skills.log(bot, `战斗结果：没开打（当前各怪型engageRange/engageDy内没有符合条件的 ${want === 'nearest' ? '敌对生物' : want}）。现在24格内：${around.length ? around.join('，') : '没有活着的敌对生物'}。` + ways);
        return;
    }
    // She chose this fight: modes that would take the body over pause until it ends (self_defense - which she may have turned on -
    // interrupts every action and would cut her own !fight short). self_preservation stays: fire and water are not this fight.
    const paused = ['self_defense', 'cowardice', 'hunting', 'item_collecting', 'unstuck', 'elbow_room'];
    for (const m of paused) bot.modes?.pause?.(m);
    try { await runEncounter(agent, target, { caller: 'her', trigger: 'her' }); }
    finally { for (const m of paused) bot.modes?.unpause?.(m); }
}

// !shoot / !block (step 3, GPT library/ranged.js; gates passed #3392: bow 5/5 at 10 and 15 m on still targets, shield 6 -> 0 against a
// real skeleton on hard). The engine only draws/holds; which mob, when and how long are hers. What she gets back is what was seen.
async function rangedCommand(agent, op, type, seconds) {
    const bot = agent.bot, me = bot.entity.position, want = String(type || 'nearest').trim().toLowerCase();
    let ranged;
    try { ranged = await import('../library/ranged.js'); } catch { skills.log(bot, 'Bow and shield are not available yet.'); return; }
    const pick = (r) => world.getNearestEntityWhere(bot, (e) => (want === 'nearest' ? mc.isHostile(e) : e.name === want) && world.isAlive(bot, e), r);
    const paused = ['self_defense', 'cowardice', 'hunting', 'item_collecting', 'unstuck', 'elbow_room'];
    for (const m of paused) bot.modes?.pause?.(m);
    try {
        if (op === 'shoot') {
            const target = pick(32);
            if (!target) {
                // bow arena 10-26: after three arrows the skeleton (1 HP) ran past 32 and she only heard "32 格内没有 skeleton" - "没说它是还活着
                // 跑了，还是已经死了". Say what is known about the one she last shot.
                const last = bot._lastShot, e = last ? bot.entities?.[last.id] : null;
                const about = !last || (want !== 'nearest' && last.name !== want) || Date.now() - last.at > 120000 ? ''
                    : last.dead ? `你上次射的那只 ${last.name} 已经死了。`
                    : e && world.isAlive(bot, e) ? `你上次射的那只 ${last.name} 还活着，在 ${Math.round(e.position.distanceTo(me))} 格外，超出了 32 格射程${Number.isFinite(last.hp) ? `；上次看到它 ${Math.round(last.hp)} 血` : ''}。`
                    : `你上次射的那只 ${last.name} 已经看不到了（离开了视野范围，没看到它死）${Number.isFinite(last.hp) ? `；上次看到它 ${Math.round(last.hp)} 血` : ''}。`;
                skills.log(bot, `没射（32 格内没有 ${want === 'nearest' ? '敌对生物' : want}）。${about}`);
                return;
            }
            const style = styleNow(agent,target.name);
            const r = await ranged.shoot(bot, target, { style });
            bot._lastShot = { id: target.id, name: target.name, at: Date.now(), dead: !!r.targetDeathObserved, hp: r.targetHpAfter ?? r.targetHpBefore };
            logAct({ kind: 'shoot', args: { target: target.name, lead: style.lead }, ok: r.result === 'released', reason: r.result === 'released' ? undefined : r.result, ...r });
            const left = bot.inventory.items().filter((i) => /arrow$/.test(i.name)).reduce((s, i) => s + i.count, 0);
            const hp = (v) => Number.isFinite(v) ? Math.round(v) : '?';
            const seen = r.targetDeathObserved ? '它死了' : Number.isFinite(r.targetHpBefore) && Number.isFinite(r.targetHpAfter)
                ? (r.targetHpAfter < r.targetHpBefore ? `它的血 ${hp(r.targetHpBefore)}→${hp(r.targetHpAfter)}` : `没看到它掉血（${hp(r.targetHpBefore)}→${hp(r.targetHpAfter)}）`) : '看不到它的血量';
            skills.log(bot, r.result === 'released'
                ? `射出 ${r.arrowsSpent ?? 1} 支箭（还剩 ${left}，lead=${style.lead}，距离 ${Math.round(target.position.distanceTo(me))} 格）；${seen}。`
                // final-13 18:0x: "没射成（no_bow）" reached her raw - the arena bow had been taken back
                // owner 10-28: the arc was never checked for blocks, yet this text said "中间有东西挡着" - now each reason says what it is
                : r.reason === 'blocked_path'
                ? `没射：箭的路线被挡住了，${r.blockedBy} (${r.blockedAt.x}, ${r.blockedAt.y}, ${r.blockedAt.z}) 在中间，${target.name} 在它后面或下面（离你 ${Math.round(target.position.distanceTo(me))} 格，高度差 ${Math.round(target.position.y - me.y)}）。箭射出去只会插在那块上。`
                : `没射成（${{ no_bow: '身上没有弓（训练场的弓测完收回了）', no_arrow: '身上没有箭', target_not_observed: '看不到它了', no_air_trajectory: '角度太陡或者太远，这把弓够不到它',
                    no_predicted_trajectory: '它在动，算不出能射中的弧线', no_release_trajectory: '松手前它移动了，射不到', equip_incomplete: '没能把弓拿到手上' }[r.reason] || r.reason || r.result}）。`);
            return;
        }
        const target = want === 'none' ? null : pick(24);
        if (want !== 'none' && !target) skills.log(bot, `24 格内没有 ${want === 'nearest' ? '敌对生物' : want}，盾就朝着你现在的方向举。`);
        // keep turned towards it while the shield is up: a shield only stops what comes from the front
        const face = target ? setInterval(() => { if (bot.entities?.[target.id]) bot.lookAt(target.position.offset(0, (target.height || 1.8) * 0.8, 0), true).catch(() => {}); }, 200) : null;
        let r;
        try { if (target) await bot.lookAt(target.position.offset(0, (target.height || 1.8) * 0.8, 0), true); r = await ranged.raiseShield(bot, seconds>0?seconds:undefined,{style:styleNow(agent,target?.name||'_all'),mob:target?.name||'_all'}); }
        finally { if (face) clearInterval(face); }
        logAct({ kind: 'block', args: { seconds, facing: target?.name || 'none' }, ok: r.result === 'held', reason: r.result, ...r });
        if (r.result === 'refused') { skills.log(bot, `没举盾（${r.reason === 'no_shield' ? '身上没有盾' : r.reason}）。`); return; }
        const wear = Number.isFinite(r.wearAfter) && Number.isFinite(r.wearBefore) ? r.wearAfter - r.wearBefore : null;
        skills.log(bot, `举盾 ${Math.round((r.heldSeconds ?? 0) * 10) / 10} 秒${target ? `（朝着 ${target.name}）` : ''}；你的血 ${Math.round(r.startHp ?? bot.health)}→${Math.round(r.endHp ?? bot.health)}`
            // arena feedback 10-26 "没说哪几刀被盾挡了": the server does not report each blocked blow - say what the two numbers mean
            + (wear === null ? '' : wear > 0 ? `；盾磨损了 ${wear}（有东西打在盾上，被挡住了）` : '；盾没有磨损（没东西打到盾上）')
            + (Number.isFinite(r.startHp) && Number.isFinite(r.endHp) && r.endHp < r.startHp ? `；你还是掉了 ${Math.round(r.startHp - r.endHp)} 血——那是没挡住的（盾只挡正面来的，侧面、背后或举盾前后打到的都会掉血）` : '')
            // GPT's shield fix (ranged.js, 17:25) reads the server's "using off hand" flag: say what it saw, including "could not confirm"
            + (r.result === 'released_early' ? `；盾提前放下了（${r.reason === 'server_use_ended' ? '服务器那边显示你不再举着盾' : '盾不在副手了'}）`
                : r.result === 'unconfirmed' ? '；服务器一直没有显示你举起了盾，这次可能根本没举起来'
                : r.result === 'interrupted' ? '；被别的事打断了' : '') + '。');
    } finally { for (const m of paused) bot.modes?.unpause?.(m); }
}

export const actionsList = [
    {
        name: '!buildHouse',
        description: 'Build a small village house on the open ground at a spot you chose (it goes on the surface even if you stand in a pit). Move to the site first; space in front is cleared and a foundation added. Protected buildings are never touched. Uses some of your wood/stone; a house allowance covers missing materials. Small styles: plains, desert, savanna, snowy, taiga, numbered variants e.g. plains_2 - their room is small (2 to 6 cells to stand in), a bed fills much of it. Roomier (cells to stand in on the door floor): plains_medium 43, plains_medium_2 20, snowy_medium 15, taiga_medium_3 15, plains_big 14, snowy_medium_3 10, desert_medium 9; also savanna_medium, savanna_medium_2, snowy_medium_2, taiga_medium_4, taiga_medium, taiga_medium_2. The receipt says where the door is, the room inside the walls and the floor height. To build at your own height instead (underground, in a cliff), use !buildHouseHere.',
        params: {'style': {type:'string',description:'Village house style, e.g. plains, taiga_2, or a roomier plains_medium / snowy_medium.'}},
        perform: runAsAction(async (agent, style) => {
            if(await buildHouse(agent.bot,style)){
                const h=agent.bot.lastBuiltHouse, p=h.inside||h.entry;   // inside the door, not the corner (owner 10-28)
                agent.memory_bank.rememberPlace('home',p.x,p.y,p.z);
                agent.memoryS?.appendPlace?.('home', p);
                const rec=agent.houses?.add?.(h);   // owner 10-29: kept with this save, every block of it; damage to it is told
                if (rec) skills.log(agent.bot, `（这栋记成了你的「${rec.name}」，门在 (${rec.door?.x}, ${rec.door?.y}, ${rec.door?.z})。${agent.houses.bedsOf(rec).length ? `屋里有床，在 ${agent.houses.bedsOf(rec).map((b) => `(${b.x}, ${b.y}, ${b.z})`).join('、')}（!goToBed 会走过去睡）` : '屋里没有床'}。!myHouses 能看你在这个存档里的房子。）`);   // last line: survives the receipt cut (10-30)
            }
        })
    },
    {
        // Owner 2026-10-26: where to live is her choice - this builds at her own height; the advice is in the words, nothing is enforced.
        name: '!buildHouseHere',
        description: 'Build a home right at your own height, wherever you are: underground, in a cave, in a cliff side. Suggestion (only a suggestion): underground, "cave" carves a cosy stone room with a door, bed, crafting table and torches; on the surface the village styles of !buildHouse look best. Protected buildings are never touched.',
        params: {'style': {type:'string', description:'"cave" for the carved underground room, or a village style (plains, taiga_2 ...).'}},
        perform: runAsAction(async (agent, style) => {
            const built = String(style).toLowerCase() === 'cave' ? await buildCaveHouse(agent.bot) : await buildHouse(agent.bot, style, { here: true });
            if (built && agent.bot.lastBuiltHouse) {
                const h = agent.bot.lastBuiltHouse, p = h.inside || h.entry;   // inside the door, not the corner (owner 10-28)
                agent.memory_bank.rememberPlace('home', p.x, p.y, p.z);
                agent.memoryS?.appendPlace?.('home', p);
                const rec = agent.houses?.add?.(h);   // owner 10-29: kept with this save, every block of it; damage to it is told
                if (rec) skills.log(agent.bot, `（这栋记成了你的「${rec.name}」，门在 (${rec.door?.x}, ${rec.door?.y}, ${rec.door?.z})。${agent.houses.bedsOf(rec).length ? `屋里有床，在 ${agent.houses.bedsOf(rec).map((b) => `(${b.x}, ${b.y}, ${b.z})`).join('、')}（!goToBed 会走过去睡）` : '屋里没有床'}。!myHouses 能看你在这个存档里的房子。）`);   // last line: survives the receipt cut (10-30)
            }
        })
    },
    {
        // owner 10-29: a house she gives up no longer counts as hers (her walks may dig it, collecting may take it); listed as given up
        name: '!abandonHouse',
        description: 'Give up one of your houses: it no longer counts as yours (walks may dig through it, collecting may take its blocks). Use the name from !myHouses, e.g. "房子1".',
        params: {'name': { type: 'string', description: 'The house name from !myHouses, e.g. 房子1.' }},
        perform: async function (agent, name) {
            const h = agent.houses?.abandon?.(name);
            if (!h) return `No house named "${name}" in this world. ` + (agent.houses ? agent.houses.summary() : '');
            return `「${h.name}」（门在 ${h.door ? `(${h.door.x}, ${h.door.y}, ${h.door.z})` : '—'}）已放弃：它不再算你的房子，!myHouses 里还会列着。`;
        }
    },
    {
        name: '!newAction',
        description: 'Perform new and unknown custom behaviors that are not available as a command.', 
        params: {
            'prompt': { type: 'string', description: 'A natural language prompt to guide code generation. Make a detailed step-by-step plan.' }
        },
        perform: async function(agent, prompt) {
            // just ignore prompt - it is now in context in chat history
            if (!settings.allow_insecure_coding) { 
                agent.openChat('newAction is disabled. Enable with allow_insecure_coding=true in settings.js');
                return "newAction not allowed! Code writing is disabled in settings. Notify the user.";
            }
            let result = "";
            const actionFn = async () => {
                try {
                    result = await agent.coder.generateCode(agent.history, prompt);
                } catch (e) {
                    result = 'Error generating code: ' + e.toString();
                    // 08:3x her code tried require('mineflayer-pathfinder') / import(...) and got only "SES_IMPORT_REJECTED"
                    if (/SES_IMPORT_REJECTED|require is not defined|import/i.test(String(e)))
                        result += '\nYour code runs in a sandbox: require(...) and import(...) are not available, and no library can be loaded. '
                            + 'Use what is already there - bot, skills, world, Vec3 - e.g. await skills.goToPosition(bot, x, y, z, 2) to walk somewhere.';
                }
            };
            await agent.actions.runAction('action:newAction', actionFn, {timeout: settings.code_timeout_mins});
            return result;
        }
    },
    {
        name: '!promiseDone',
        description: 'Mark the thing you promised the owner as finished. Pass a few words from the promise so the right one is closed.',
        params: {
            'match': { type: 'string', description: 'A few words from the promise, e.g. "箱子".' }
        },
        perform: async function (agent, match) {
            const row = agent.memoryS?.closePromise?.({ match, status: 'done' });
            if (!row) return 'No open promise matched that.';
            return `Closed the promise: ${row.text}`;
        }
    },
    {
        name: '!promiseDrop',
        description: 'Drop a promise you told the owner you would do, with a reason you will tell him.',
        params: {
            'match': { type: 'string', description: 'A few words from the promise.' },
            'reason': { type: 'string', description: 'Why you are dropping it, in your own words.' }
        },
        perform: async function (agent, match, reason) {
            const row = agent.memoryS?.closePromise?.({ match, status: 'dropped', reason });
            if (!row) return 'No open promise matched that.';
            return `Dropped the promise: ${row.text}${reason ? ` (${reason})` : ''}`;
        }
    },
    {
        // owner 10-28: a long action is not stopped any more - after 3 min she is reminded once a minute; a reason ends the reminders
        name: '!continueAction',
        description: 'Say why the action you are running should keep going (for example "还在烧 20 块铁"); it is not stopped and you are no longer reminded about it. Does not start or stop anything.',
        params: {'reason': { type: 'string', description: 'Why it should keep going.' }},
        perform: async function (agent, reason) {
            const ok = agent.actions.keepGoing(reason);
            logAct({ kind: 'continue_action', args: { reason }, ok, ...(ok ? { label: agent.actions.currentActionLabel } : { reason: 'blocked', msg: 'nothing running' }) });
            return ok ? `Got it - ${agent.actions.currentActionLabel.replace(/^action:/, '!')} keeps going and you will not be reminded about it again.` : 'Nothing is running right now.';
        }
    },
    {
        name: '!stop',
        description: 'Force stop all actions and commands that are currently executing.',
        perform: async function (agent) {
            await agent.actions.stop('action:stop');
            agent.clearBotLogs();
            agent.actions.cancelResume();
            agent.bot.emit('idle');
            let msg = 'Agent stopped.';
            if (agent.self_prompter.isActive())
                msg += ' Self-prompting still active.';
            return msg;
        }
    },
    {
        name: '!stfu',
        description: 'Stop all chatting and self prompting, but continue current action.',
        perform: async function (agent) {
            agent.openChat('Shutting up.');
            agent.shutUp();
            return;
        }
    },
    {
        name: '!restart',
        description: 'Restart the agent process.',
        perform: async function (agent) {
            agent.cleanKill();
        }
    },
    {
        name: '!clearChat',
        description: 'Clear the chat history.',
        perform: async function (agent) {
            agent.history.clear();
            return agent.name + "'s chat history was cleared, starting new conversation from scratch.";
        }
    },
    {
        name: '!goToPlayer',
        description: 'Go to the given player.',
        params: {
            'player_name': {type: 'string', description: 'The name of the player to go to.'},
            'closeness': {type: 'float', description: 'How close to get to the player.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, closeness) => {
            const ok = await skills.goToPlayer(agent.bot, player_name, closeness);
            // GPT #3769: asked "带我回营地", she went to the player and said "营地也到了" 31 blocks from it. Where she now is, said plainly.
            if (ok !== false) skills.log(agent.bot, `(You are next to ${player_name} now - that is where ${player_name} stands, not any saved place.)`);
        })
    },
    {
        name: '!followPlayer',
        description: 'Endlessly follow the given player.',
        params: {
            'player_name': {type: 'string', description: 'name of the player to follow.'},
            'follow_dist': {type: 'float', description: 'The distance to follow from.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, follow_dist) => {
            await skills.followPlayer(agent.bot, player_name, follow_dist);
        }, true)
    },
    {
        name: '!goToCoordinates',
        description: 'Go to the given x, y, z location.',
        params: {
            'x': {type: 'float', description: 'The x coordinate.', domain: [-Infinity, Infinity]},
            'y': {type: 'float', description: 'The y coordinate.', domain: [-64, 320]},
            'z': {type: 'float', description: 'The z coordinate.', domain: [-Infinity, Infinity]},
            'closeness': {type: 'float', description: 'How close to get to the location.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, x, y, z, closeness) => {
            // owner 10-28: she walked to a house corner by coordinates and said "这下总在屋里了吧" - arriving says where she stands too
            if (await skills.goToPosition(agent.bot, x, y, z, closeness)) skills.log(agent.bot, surroundingsFact(agent.bot));
        })
    },
    {
        name: '!searchForBlock',
        description: 'Find and go to the nearest block of a given type in a given range.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the block. Minimum 32.', domain: [10, 512] }
        },
        perform: runAsAction(async (agent, block_type, range) => {
            if (range < 32) {
                skills.log(agent.bot, `Minimum search range is 32.`);
                range = 32;
            }
            await skills.goToNearestBlock(agent.bot, block_type, 4, range);
        })
    },
    {
        name: '!searchForEntity',
        description: 'Find and go to the nearest entity of a given type in a given range.',
        params: {
            'type': { type: 'string', description: 'The type of entity to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the entity.', domain: [32, 512] }
        },
        perform: runAsAction(async (agent, entity_type, range) => {
            await skills.goToNearestEntity(agent.bot, entity_type, 4, range);
        })
    },
    {
        name: '!moveAway',
        description: 'Move away from the current location in any direction by a given distance.',
        params: {'distance': { type: 'float', description: 'The distance to move away.', domain: [0, Infinity] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.moveAway(agent.bot, distance);
        })
    },
    {
        name: '!rememberHere',
        description: 'Save the current location with a given name.',
        params: {'name': { type: 'string', description: 'The name to remember the location as.' }},
        perform: async function (agent, name) {
            const pos = agent.bot.entity.position;
            // GPT #3784/#3785: asked to take the owner back to "营地", she walked to the owner and saved that spot as "营地" too - the old one,
            // 29 blocks away, was gone without a word. Saving over a name now says where the old one was.
            const old = agent.memory_bank.recallPlace?.(name);
            agent.memory_bank.rememberPlace(name, pos.x, pos.y, pos.z);
            agent.memoryS?.appendPlace(name, pos);   // dafeiyu (PLAN S): also into her long-term place book
            if (Array.isArray(old) && old.length >= 3) {
                const d = Math.round(Math.hypot(old[0] - pos.x, old[1] - pos.y, old[2] - pos.z));
                if (d >= 2) return `Location saved as "${name}". There was already a "${name}" at (${Math.round(old[0])}, ${Math.round(old[1])}, ${Math.round(old[2])}), ${d} blocks from here - it is replaced by this spot now. If you meant the old one, save it again there under its name.`;
            }
            return `Location saved as "${name}".`;
        }
    },
    {
        // dafeiyu (owner 10-26): in a new world she decides herself what still holds; memory/worlds.js suggests, never deletes.
        name: '!showMemories',
        description: 'Look through your memories from other worlds, a few at a time, to decide what still holds here. "next" for the next batch, "first" to start over.',
        params: { 'which': { type: 'string', description: '"next" for the next batch, "first" to start from the beginning.' } },
        perform: async function (agent, which) {
            agent._memBatch = which === 'next' ? (agent._memBatch || 1) + 1 : 1;
            let r = agent.memoryS?.showWorldBatch?.(agent._memBatch);
            if (!r) return 'Memory sorting is not available.';
            if (!r.items?.length && agent._memBatch > 1) { agent._memBatch = 1; r = agent.memoryS.showWorldBatch(1); }
            if (!r.items?.length) return 'Nothing from other worlds to look through.';
            const lines = r.items.map((it) => `- ${it.who ? it.who + ': ' : ''}${it.text}${it.world ? `（${it.world}）` : ''}`);
            return `Memories from other worlds, batch ${r.index}/${r.total} (${r.remaining} in all) - you decide; !archiveMemory("a few words") puts away what does not hold here, nothing is deleted, keeping them is fine too:\n${lines.join('\n')}${r.hasMore ? '\n(more with !showMemories("next"))' : ''}`;
        }
    },
    {
        name: '!archiveMemory',
        description: 'Put away memories that only belonged to another world (they are kept, never deleted; !restoreMemory brings them back). Name a few words from them; when more than 3 match you are shown them first and run the same command again to confirm.',
        params: { 'match': { type: 'string', description: 'A few words from the memories to put away.' } },
        perform: async function (agent, match) {
            return memorySort(agent, 'archive', match);
        }
    },
    {
        name: '!restoreMemory',
        description: 'Bring back memories you put away earlier (for example when you are back in that world). When more than 3 match you are shown them first and run the same command again to confirm.',
        params: { 'match': { type: 'string', description: 'A few words from the memories to bring back.' } },
        perform: async function (agent, match) {
            return memorySort(agent, 'restore', match);
        }
    },
    {
        // dafeiyu (PLAN S / R1): something a player taught her - kept for good (memory/taught.js), recalled when it matters.
        name: '!rememberFact',
        description: 'Remember something a player told you or taught you (a place, a tip, a preference, a promise), in your own words. It is kept for good and comes back when it is relevant.',
        params: {
            'who': { type: 'string', description: 'Who told you (a player name, or your own name for something you found out).' },
            'fact': { type: 'string', description: 'What to remember, one fact, short.' }
        },
        perform: async function (agent, who, fact) {
            const row = agent.memoryS?.rememberTaught({ who, what: fact, source: 'chat' });
            // one-off task requests stay out of the never-delete facts (memory/promises.js isOneOffRequest); say why, so she doesn't retry
            if (!row) return isOneOffRequest(fact) ? '这是一次性的请求，不进长期记忆；如果你答应了，它在【答应老大还没做完的事】里，做完用 !promiseDone。' : 'Could not remember that.';
            return row.duplicate ? `I already knew that (${who}: ${fact}).` : `Remembered: ${who} - ${fact}`;
        }
    },
    {
        name: '!forgetFact',
        description: 'Forget something you were taught, only when a player clearly asks you to forget it or says it is no longer true.',
        params: { 'match': { type: 'string', description: 'A few words from the fact to forget.' } },
        perform: async function (agent, match) {
            const n = agent.memoryS?.forgetTaught(match) || 0;
            return n ? `Forgot ${n} thing(s) matching "${match}".` : `I don't remember anything about "${match}".`;
        }
    },
    {
        // dafeiyu (PLAN H): run a skill she learned herself (kept by coder.js after a judged success).
        name: '!useSkill',
        description: 'Run a skill you learned yourself earlier (see "Your own learned skills" in the docs). Faster than writing new code.',
        params: { 'name': { type: 'string', description: 'The learned skill name.' } },
        perform: async function (agent, name) {
            if (!settings.allow_insecure_coding) return 'Learned skills are code, and code is disabled in settings.';
            const skill = getLearned(agent.name, name);
            if (!skill) return `No learned skill "${name}". You know: ${listLearned(agent.name).map((s) => s.name).join(', ') || 'none yet'}.`;
            let note = '';
            let result = '';
            await agent.actions.runAction('action:useSkill', async () => {
                lockdown();
                const frame = createSkillFrame(skill, agent.bot, { skills, world });
                if (frame.error) { result = frame.error; return; }
                note = frame.note || '';
                const staged = await agent.coder._stageCode(skill.code, frame.active ? frame : null);
                if (!staged?.func) { recordUse(agent.name, skill.name, false); result = `Could not load skill ${skill.name}.`; return; }
                try {
                    const before = inventorySnapshot(agent.bot);
                    await staged.func.main(frame.bot);
                    const full = String(agent.bot.output || '');   // the judge reads all of it, not the 500-character summary she gets
                    const output = agent.actions.getBotOutputSummary();
                    // 2026-10-26: "no exception" counted a run that dug nothing as a success. The same second look as when it was learned decides.
                    // 08:5x a translated run was judged against the goal's old coordinates ("do not match the requested scan ranges x:9-15...")
                    // and she read that as the skill being wrong again. Telling the judge to add the shift itself did not hold (10:4x: "reports
                    // y=52 ... missing the target row"), so the judge reads the output moved back into the goal's own coordinates - no arithmetic.
                    const s = frame.active ? frame.shift : null;
                    const goal = skill.goal || skill.description;
                    const verdict = await judgeRun(agent.prompter, { goal, output: s ? moveCoords(full, s, -1) : full, delta: inventoryDelta(before, inventorySnapshot(agent.bot)) });
                    recordUse(agent.name, skill.name, verdict?.success === true);
                    result = `Ran your skill ${skill.name} (${verdict?.success ? 'it worked' : 'it did not reach its goal this time' + (verdict?.reason ? ': ' + verdict.reason : '')}). Output:\n` + output;
                } catch (e) {
                    recordUse(agent.name, skill.name, false);
                    result = `Your skill ${skill.name} failed this time: ${e}`;
                }
            }, { timeout: settings.code_timeout_mins });
            return note ? `${skill.name}：${note}\n${result}` : result;
        }
    },
    {
        // Owner rule 2026-10-25 (PLAN D): a player can mark "don't dig here"; she never breaks blocks there (protect.js guards bot.dig).
        name: '!protectAround',
        description: 'Mark an area that must never be dug or broken, e.g. when a player says "这里别挖" or "这是我的房子". The area is a box of the given radius around that player (or around you if you give your own name).',
        params: {
            'player_name': { type: 'string', description: 'Whose position is the centre.' },
            'radius': { type: 'int', description: 'Half the size of the box in blocks.', domain: [1, 64] },
            'note': { type: 'string', description: 'What it is, e.g. "老大的房子".' }
        },
        perform: async function (agent, player_name, radius, note) {
            const who = player_name === agent.name ? agent.bot.entity : agent.bot.players[player_name]?.entity;
            if (!who) return `I can't see ${player_name} right now, so I don't know where to protect.`;
            const area = addProtection(agent.name, who.position, radius, note, player_name);
            // GPT #3769: "记成营地" became a protected area, and "回营地" later had no saved place to go to. What this is, and what it is not.
            return `Protected a box of radius ${area.radius} around ${area.center.x},${area.center.y},${area.center.z} (${area.note}). I will not break blocks there.`
                + ` This only marks it as not to be dug - it is not a saved place; to be able to go back to it later by name, use !rememberHere("${area.note || 'name'}").`;
        }
    },
    {
        name: '!unprotectHere',
        description: 'Remove the protected area you are standing in, when a player says it may be dug again.',
        perform: async function (agent) {
            const hit = removeProtectionAt(agent.name, agent.bot.entity.position);
            return hit ? `Removed the protection "${hit.note}".` : 'There is no protected area where I stand.';
        }
    },
    {
        name: '!goToRememberedPlace',
        description: 'Go to a saved location.',
        params: {'name': { type: 'string', description: 'The name of the location to go to.' }},
        perform: runAsAction(async (agent, name) => {
            const pos = findPlace(agent, name);
            if (!pos) {
            // dafeiyu 2026-10-26 (final run): she asked for "大肥鱼的小屋" while "小屋" was saved - list what is there so she can pick
            const names = allPlaceNames(agent), known = names.join(', ');
            // final-94 23:3x: "地下橡木小屋" asked, "地下的橡木小屋" saved - one character off, and only the full list came back.
            // The nearest name by edit distance is pointed out when it is close; which place she means stays hers.
            const dist = (a, b) => { const d = Array.from({ length: b.length + 1 }, (_, j) => j);
                for (let i = 1; i <= a.length; i++) { let prev = d[0]; d[0] = i;
                    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; } }
                return d[b.length]; };
            const near = names.map((n) => ({ n, d: dist(String(name), n) })).sort((x, y) => x.d - y.d)[0];
            const hint = near && near.d <= Math.max(1, Math.floor(Math.max(String(name).length, near.n.length) / 3)) ? ` 最像的是「${near.n}」，是它的话用这个名字原样再说一次。` : '';
            skills.log(agent.bot, `No location named "${name}" saved.` + hint + (known ? ` Saved places: ${known}.` : ' No places are saved yet.'));
            return;
            }
            // a place saved in another world is still hers to try (memory/worlds.js marks it, never hides it): say so, don't block
            const from = agent.memoryS?.placeWorld?.(name), here = agent.memoryS?.worldStatus?.()?.key;
            if (from && here && from !== here) skills.log(agent.bot, `"${name}" was saved in another world (${from}); it may not be right here.`);
            // 10-30 day-night round 15: "home" is the first cell inside her door, and closeness 1 ended the walk in the doorway - the
            // door stood open under her and she spent her next turns stepping in and closing it, then forgot the bed. A cell inside one
            // of her houses is walked to exactly.
            const indoors = agent.bot.ownHousePlace?.({ x: Math.floor(pos[0]), y: Math.floor(pos[1]), z: Math.floor(pos[2]) })?.where === 'inside';
            const reached = await skills.goToPosition(agent.bot, pos[0], pos[1], pos[2], indoors ? 0 : 1);
            // owner 10-28: at "林地小屋" she said "到家了…我进屋待着" while standing outside it - the saved point is by the door outside.
            if (reached) {
                const around = surroundingsFact(agent.bot);
                skills.log(agent.bot, around);
                // owner 10-28 ("她现在又把外边当成家了"): told she was outside, she kept her note "小屋(2,87,29)…头顶露天需补屋顶" and laid a
                // plank "roof" over open ground. Where her confirmed bed is, and how to move the name indoors, are said; what to do is hers.
                const bed = loadRespawn(agent.name).bed, me = agent.bot.entity.position;
                if (bed && /」外面/.test(around) && Math.hypot(bed.x - me.x, bed.z - me.z) <= 32) {
                    const dx = bed.x - me.x, dz = bed.z - me.z, dir = Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? '东' : '西') : (dz > 0 ? '南' : '北');
                    skills.log(agent.bot, `（你记的「${name}」这个点在屋子外面。服务器确认的你的床在 (${bed.x}, ${bed.y}, ${bed.z})，在你${dir}边约 ${Math.round(Math.hypot(dx, dz))} 格——床在哪，家多半就在哪。想把「${name}」改记到屋里，进屋后用 !rememberHere("${name}")。）`);
                }
            }
        })
    },
    {
        name: '!givePlayer',
        description: 'Give the specified item to the given player.',
        params: { 
            'player_name': { type: 'string', description: 'The name of the player to give the item to.' }, 
            'item_name': { type: 'ItemName', description: 'The name of the item to give.' },
            'num': { type: 'int', description: 'The number of items to give.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, player_name, item_name, num) => {
            await skills.giveToPlayer(agent.bot, item_name, player_name, num);
        })
    },
    {
        name: '!consume',
        description: 'Eat/drink the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to consume.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.consume(agent.bot, item_name);
        })
    },
    {
        name: '!equip',
        description: 'Equip the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to equip.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.equip(agent.bot, item_name);
        })
    },
    {
        name: '!putInChest',
        description: 'Put the given item in the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to put in the chest.' },
            'num': { type: 'int', description: 'The number of items to put in the chest.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.putInChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!takeFromChest',
        description: 'Take the given items from the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to take.' },
            'num': { type: 'int', description: 'The number of items to take.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.takeFromChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!viewChest',
        description: 'View the items/counts of the nearest chest.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.viewChest(agent.bot);
        })
    },
    {
        name: '!discard',
        description: 'Discard the given item from the inventory.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to discard.' },
            'num': { type: 'int', description: 'The number of items to discard.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.discard(agent.bot, item_name, num);
        })
    },
    {
        name: '!collectBlocks',
        description: 'Collect the nearest blocks of a given type.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to collect.' },
            'num': { type: 'int', description: 'The number of blocks to collect.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, type, num) => {
            await skills.collectBlock(agent.bot, type, num);
        }, false, 10, ([type, num], before, after, extra) => collectFactsLine(type, num, before, after, extra)) // 10 minute timeout
    },
    {
        name: '!craftRecipe',
        description: 'Craft the given recipe a given number of times.',
        params: {
            'recipe_name': { type: 'ItemName', description: 'The name of the output item to craft.' },
            'num': { type: 'int', description: 'The number of times to craft the recipe. This is NOT the number of output items, as it may craft many more items depending on the recipe.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, recipe_name, num) => {
            await skills.craftRecipe(agent.bot, recipe_name, num);
        }, false, -1, ([recipe_name, num], before, after, extra) => craftFactsLine(recipe_name, num, before, after, extra))
    },
    {
        name: '!smeltItem',
        description: 'Smelt the given item the given number of times.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the input item to smelt.' },
            'num': { type: 'int', description: 'The number of times to smelt the item.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.smeltItem(agent.bot, item_name, num);
        })
    },
    {
        name: '!clearFurnace',
        description: 'Take all items out of the nearest furnace.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.clearNearestFurnace(agent.bot);
        })
    },
        {
        name: '!placeHere',
        description: 'Place a given block in the cell you are standing in (at your feet - you step aside first; it never places above your head or beside you). Do NOT use to build structures, only use for single blocks/torches.',
        params: {'type': { type: 'BlockOrItemName', description: 'The block type to place.' }},
        perform: runAsAction(async (agent, type) => {
            let pos = agent.bot.entity.position;
            await skills.placeBlock(agent.bot, type, pos.x, pos.y, pos.z);
        })
    },
    {
        // owner 10-27 08:2x: food from hunting or farming - she is given the means; whether and where to farm is hers.
        // tillAndSow was code-only; this picks the nearest grass/dirt within 5 blocks with air above (not the block she stands on), near water first.
        name: '!tillAndSow',
        description: 'Farm one block next to you: till the nearest grass_block/dirt within 5 blocks with a hoe and plant a seed in it (e.g. "wheat_seeds", "carrot", "potato", "beetroot_seeds"; "none" to only till). Crops grow over time (several in-game days), about twice as fast with water within 4 blocks.',
        params: { 'seed': { type: 'string', description: 'The seed to plant, or "none".' } },
        perform: runAsAction(async (agent, seed) => {
            const bot = agent.bot, feet = bot.entity.position.floored();
            const spots = bot.findBlocks({ matching: (b) => b && ['grass_block', 'dirt', 'farmland'].includes(b.name), maxDistance: 5, count: 64 })
                .filter((p) => !(p.x === feet.x && p.z === feet.z && p.y === feet.y - 1) && ['air', 'short_grass', 'tall_grass'].includes(bot.blockAt(p.offset(0, 1, 0))?.name));
            if (!spots.length) { skills.log(bot, 'No grass_block or dirt with open air above within 5 blocks to farm on.'); return; }
            const wet = (p) => !!bot.findBlock({ point: p, matching: (b) => b?.name === 'water', maxDistance: 4 });
            const pick = spots.find(wet) || spots[0];
            if (!wet(pick)) skills.log(bot, `No water within 4 blocks of ${pick} - a crop there still grows, only about half as fast.`);
            await skills.tillAndSow(bot, pick.x, pick.y, pick.z, String(seed || '').toLowerCase() === 'none' ? null : seed);
        })
    },
    {
        // 2026-10-27 09:1x: she "fished" with !useOn("fishing_rod", "water"), which only clicks the water block - nothing was ever caught
        // ("钓鱼别耗"). mineflayer's own bot.fish() casts, waits for the bite and reels in. A food source like the others; using it is hers.
        name: '!fish',
        description: 'Fish with a fishing rod next to open water (within 8 blocks): cast, wait for a bite, reel in - the given number of times, each cast waiting at most 60 s. Cod and salmon can be eaten, better cooked with !smeltItem.',
        params: { 'num': { type: 'int', description: 'How many casts.', domain: [1, 10] } },
        perform: runAsAction(async (agent, num) => {
            const bot = agent.bot;
            const rod = bot.inventory.items().find((i) => i.name === 'fishing_rod');
            if (!rod) { skills.log(bot, 'No fishing_rod. One is crafted from 3 sticks and 2 string.'); return; }
            // final-93 22:49-23:12: 4 of 4 casts sessions failed at the narrow water by 水边新屋 ("这水域太窄，鱼钩老落地"), at 6 HP with no
            // food. Width = open water cells in the 5x5 around a cell; a wide surface within 8 blocks is fished first, and when the casts
            // keep landing on the bank (or there is no water) she is told where the nearest wide one is - going there is hers.
            const openWater = (b) => b?.name === 'water' && ['air', 'cave_air'].includes(bot.blockAt(b.position.offset(0, 1, 0))?.name);
            const width = (p) => { let n = 0; for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (openWater(bot.blockAt(p.offset(dx, 0, dz)))) n++; return n; };
            const wideWater = (range, min) => (bot.findBlocks?.({ matching: (b) => b?.name === 'water', maxDistance: range, count: 400 }) || [])
                .map((p) => bot.blockAt(p)).filter(openWater).map((b) => ({ b, w: width(b.position) })).filter((x) => x.w >= min)
                .sort((x, y) => x.b.position.distanceTo(bot.entity.position) - y.b.position.distanceTo(bot.entity.position))[0] || null;
            const widerHint = (except) => {
                const far = wideWater(48, 12);
                if (!far || (except && far.b.position.distanceTo(except.position) < 3)) return '';
                const p = far.b.position;
                return ` 最近一片宽一点的水面在 (${p.x}, ${p.y}, ${p.z})，周围约 ${far.w} 格开阔水，离你 ${Math.round(p.distanceTo(bot.entity.position))} 格。`;
            };
            const water = wideWater(8, 9)?.b || bot.findBlock({ matching: (b) => b?.name === 'water', maxDistance: 8, useExtraInfo: (b) => ['air', 'cave_air'].includes(bot.blockAt(b.position.offset(0, 1, 0))?.name) });
            if (!water) { skills.log(bot, 'No open water (water with air above it) within 8 blocks to fish in.' + widerHint(null)); return; }
            // 11:1x final-71: 3.7 blocks from a small pond one step up behind a dirt bank, five casts in a row hit the bank and lay on the grass
            // 1.4 blocks from her (RCON: bobber OnGround, block grass_block) - "60 s no bite". She now stands at the water's edge to cast.
            const toWater = () => skills.goToPosition(bot, water.position.x, water.position.y + 1, water.position.z, 2);
            if (bot.entity.position.distanceTo(water.position) > 2.5) await toWater();
            await bot.equip(rod, 'hand');
            await bot.lookAt(water.position.offset(0.5, 1, 0.5));
            // 10-27 19:1x: "钓鱼这水面不行" (low HP, no food) came from false dry casts - a float in tall_seagrass is in the water too
            const wet = (b) => !!b && (b.name === 'water' || /^(seagrass|tall_seagrass|kelp|kelp_plant|bubble_column)$/.test(b.name) || b.getProperties?.()?.waterlogged === true);
            const isWater = (p) => [p, p.offset(0, -0.3, 0)].some((q) => wet(bot.blockAt(q)));
            const inAir = (p) => [p, p.offset(0, -0.3, 0)].every((q) => ['air', 'cave_air'].includes(bot.blockAt(q)?.name));
            let dry = 0, dryRun = 0;
            let caught = 0, casts = 0, empty = 0, noBite = 0, fetched = 0;   // DeepSeek #3665: a cast with no bite is neither caught nor empty - counted on its own
            const count = () => inventorySnapshot(bot);
            const gained = (before) => Object.entries(count()).some(([name, amount]) => amount > (before[name] || 0));
            // 10:5x final-70: three real bites, nothing in the bag - six raw cod lay on a ledge 4 blocks away (the line was cast almost straight
            // down and the catch flew over her). What a reel throws out is watched, and fetched when it does not come to her by itself.
            const spawned = [];
            const onSpawn = (e) => { if (e?.name === 'item') spawned.push(e); };
            bot.on('entitySpawn', onSpawn);
            let stoppedBy = null;
            try {
            for (let i = 0; i < num && !bot.interrupt_code; i++) {
                casts++;
                let timer;
                const before = count(), castAt = Date.now();
                spawned.length = 0;
                const bite = bot.fish(); bite.catch(() => {});
                let landTimer;
                // 3 s after the cast the float has landed: on dry ground no fish can ever bite, so it is reeled in and she is told where it lay
                // ...and a float still in the air at 3 s (a long or downhill cast) gets 2.5 s more before it counts as dry
                const bobber = () => bot.nearestEntity?.((e) => e.name === 'fishing_bobber' && e.position.distanceTo(bot.entity.position) < 32);
                const landed = new Promise((r) => { landTimer = setTimeout(() => {
                    const f = bobber();
                    if (!f || isWater(f.position)) return;
                    if (!inAir(f.position)) return r({ dryAt: f.position.clone() });
                    landTimer = setTimeout(() => { const g = bobber(); if (g && !isWater(g.position)) r({ dryAt: g.position.clone() }); }, 2500);
                }, 3000); });
                // final-90 19:4x: hit while fishing, self_defense asked this to stop; it kept waiting on the bite, was abandoned after 10 s
                // (10 s of not hitting back) and she was shot dead soon after. A stop request ends the wait at once.
                let stopPoll;
                const outcome = await Promise.race([bite.then(() => 'caught', (e) => 'lost: ' + (e?.message || e)), landed,
                    new Promise((r) => { timer = setTimeout(() => r('timeout'), 60000); }),
                    new Promise((r) => { stopPoll = setInterval(() => { if (bot.interrupt_code) r('interrupted'); }, 100); })]);
                clearTimeout(timer); clearTimeout(landTimer); clearInterval(stopPoll);
                if (outcome === 'interrupted') { stoppedBy = 'interrupted'; try { bot.activateItem(); } catch { /* a stale run's reel is dropped anyway */ } skills.log(bot, `Fishing was stopped during cast ${casts} (something else took over).`); break; }
                if (outcome?.dryAt) {
                    const p = outcome.dryAt, on = bot.blockAt(p.offset(0, -0.3, 0))?.name || bot.blockAt(p)?.name || 'something';
                    bot.activateItem(); await new Promise((r) => setTimeout(r, 500));
                    dry++; dryRun++;
                    const at = p.floored();
                    if (dryRun >= 2) { skills.log(bot, `The float landed on ${on} at (${at.x}, ${at.y}, ${at.z}) again, not in the water - reeled in and stopped. The water at (${water.position.x}, ${water.position.y}, ${water.position.z}) may be too small or behind a step from where you can stand.` + widerHint(water)); break; }
                    skills.log(bot, `The float landed on ${on} at (${at.x}, ${at.y}, ${at.z}), not in the water - reeled in, moving to the water's edge and casting again.`);
                    await toWater(); await bot.equip(rod, 'hand').catch(() => {}); await bot.lookAt(water.position.offset(0.5, 1, 0.5));
                    i--; continue;
                }
                dryRun = 0;
                // A reel and an inventory gain are separate facts. Check per item: a rod breaking can cancel a fish in the total count.
                if (outcome === 'caught') {
                    await new Promise((r) => setTimeout(r, 1200));
                    const home = bot.entity.position.clone();
                    const landed = gained(before) ? [] : spawned.filter((e) => bot.entities[e.id] === e && e.position.distanceTo(home) <= 16);
                    for (const e of landed) {
                        if (bot.interrupt_code || bot.entities[e.id] !== e) continue;
                        const at = e.position.floored(), d = Math.round(e.position.distanceTo(home));
                        await skills.goToPosition(bot, e.position.x, e.position.y, e.position.z, 1, true);
                        await new Promise((r) => setTimeout(r, 400));
                        skills.log(bot, bot.entities[e.id] === e ? `The catch landed ${d} blocks away at (${at.x}, ${at.y}, ${at.z}) and could not be reached.`
                            : `The catch flew past you and landed ${d} blocks away at (${at.x}, ${at.y}, ${at.z}); walked over and picked it up.`);
                    }
                    if (landed.length && !bot.interrupt_code) {
                        if (bot.entity.position.distanceTo(home) > 1.5) await skills.goToPosition(bot, home.x, home.y, home.z, 1);
                        await bot.equip(rod, 'hand').catch(() => {});
                        await bot.lookAt(water.position.offset(0.5, 1, 0.5));
                    }
                    if (gained(before)) { caught++; if (landed.length) fetched++; }
                    else { empty++; if (!landed.length && Date.now() - castAt < 3000) i--; }   // Existing bounded retry after a fast reel with no bag gain.
                    if (empty >= num + 3) { skills.log(bot, 'Repeated reels produced no observed inventory gain. This alone does not prove a bad bite signal; check whether the bag has room.'); break; }
                    continue;
                }
                if (outcome === 'timeout') { noBite++; bot.activateItem(); skills.log(bot, 'No bite within 60 s; reeled in.'); await new Promise((r) => setTimeout(r, 500)); continue; }
                stoppedBy = 'lost'; skills.log(bot, `The line came back without a catch (${outcome.slice(6)}).`); break;
            }
            } finally { bot.removeListener('entitySpawn', onSpawn); }
            // DeepSeek #4031: 4 failed runs with every count 0 and no reason - a stop or a lost line now says so, to her and in the record
            logAct({ kind: 'fish', args: { num }, ok: caught > 0, ...(caught > 0 ? {} : { reason: stoppedBy || (noBite ? 'no_bite' : dry ? 'dry' : empty ? 'no_gain' : 'unknown') }), casts, caught, fetched, empty, noBite, dry, emptySlots: bot.inventory.emptySlotCount?.() ?? null, emptyMeaning: 'reels_without_observed_inventory_gain' });   // Separate missing bag gain from a proved empty hook.
            if (bot.inventory.emptySlotCount?.() === 0) skills.log(bot, 'Your bag is full - a catch that does not fit drops at your feet.');
            skills.log(bot, `Cast ${casts} time${casts === 1 ? '' : 's'}: ${caught} catch${caught === 1 ? '' : 'es'} came into the bag${empty ? `, ${empty} reel${empty === 1 ? '' : 's'} had no observed inventory gain` : ''}${noBite ? `, ${noBite} cast${noBite === 1 ? '' : 's'} timed out` : ''}${dry ? `, ${dry} landed on dry ground` : ''} - what entered the bag is in the inventory change below.`);
        }, false, 12)
    },
    {
        // owner 10-27 11:3x: a boat, so that she can decide herself whether to cross a lake (library/boat.js says what it does and why)
        name: '!boatTo',
        description: 'Cross water by boat toward the point (x, z): go to the water within 8 blocks, put a boat from your bag on it, get in, row straight toward the point '
            + 'until you reach it or the water ends, step out and take the boat back into your bag. Over water a boat is far faster than swimming and keeps you dry; '
            + 'it does not go over land. A boat is crafted from 5 planks of one wood (!craftRecipe("oak_boat", 1)).',
        params: {
            'x': { type: 'float', description: 'The x coordinate to row toward.', domain: [-Infinity, Infinity] },
            'z': { type: 'float', description: 'The z coordinate to row toward.', domain: [-Infinity, Infinity] }
        },
        perform: runAsAction(async (agent, x, z) => {
            const ok = await boatTo(agent.bot, x, z);
            logAct({ kind: 'boat', args: { x, z }, ok });
        }, false, 5)
    },
    {
        name: '!attack',
        description: 'Attack and kill the nearest entity of a given type.',
        params: {'type': { type: 'string', description: 'The type of entity to attack.'}},
        perform: runAsAction(async (agent, type) => {
            await skills.attackNearest(agent.bot, type, true);
        })
    },
    {
        name: '!fight',
        description: 'Fight one hostile mob your way (your fighting style for that mob type: how close to get, how far to back off, when to break off). It uses that mob style engageRange/engageDy (not weapon hit reach). Ends when it dies, when you lose it, when you drop to your break-off health, or when interrupted, and tells you what happened: hits, health lost, seconds.',
        params: {'type': { type: 'string', description: 'The mob type to fight (zombie, creeper, skeleton ...), or "nearest" for the closest hostile.' }},
        perform: runAsAction(async (agent, type) => {
            await fightCommand(agent, type);
        },false,(agent,type)=>combatBudget(agent,type))
    },
    {
        name: '!fightStyle',
        description: '看某怪或all的完整战斗设置：当前值、中文含义、合法范围、缺省、全局模式状态及记录场数；没有战斗历史也能看。',
        params: {'type': { type: 'string', description: 'A mob type (zombie, creeper ...), or "all".' }},
        perform: async function (agent, type) {
            return describeStyle(agent.name, String(type || 'all').trim().toLowerCase(),{modes:agent.bot.modes});
        }
    },
    {
        name: '!setFightStyle',
        description: '按怪种或怪种@hand改一个战斗字段，_all作共享继承；下场/下一阶段生效并保存，不自动开启模式或调整其他值。!fightStyle查看每项含义、范围、缺省和实际值。可改字段：'+Object.keys(SPECS).join('、'),
        params: {
            'type': { type: 'string', description: '怪种（zombie、creeper等），怪种@hand为空手开场配置，_all为共享继承。' },
            'setting': { type: 'string', description: '要改的设置名（!fightStyle 列出每一项的中文含义、能填的范围和缺省值），比如 disengageHp、belowLineResponse、weaponPolicy。' },
            'value': { type: 'string', description: '新值：数字、true/false，或 !fightStyle 里列出的选项之一。系统只检查能不能执行，不替你改、不给建议。' }
        },
        perform: async function (agent, type, setting, value) {
            const r = setStyle(agent.name, type, setting, value, { day: agent.memoryS?.day?.() ?? null });
            logAct({ kind: 'fight_style', args: { mob: type, key: setting, value }, ok: r.ok, ...(r.ok ? { version: r.version } : { reason: 'refused', msg: r.msg }) });
            return r.msg;
        }
    },
    {
        name: '!shoot',
        description: 'Shoot one arrow with your bow at the nearest mob of a type (up to 32 blocks, needs a bow and arrows). Aims with your "lead" setting for that mob (!fightStyle). Tells you what was seen: arrows left, its health before and after.',
        params: {'type': { type: 'string', description: 'The mob type to shoot (skeleton, creeper ...), or "nearest" for the closest hostile.' }},
        perform: runAsAction(async (agent, type) => {
            await rangedCommand(agent, 'shoot', type);
        },false,(agent,type)=>combatBudget(agent,type))
    },
    {
        name: '!block',
        description: 'Raise your shield for some seconds, turned towards a mob (needs a shield). You cannot attack while it is up. Tells you how much health you lost while holding it and how much the shield wore (wear means something hit it).',
        params: {
            'seconds': { type: 'float', description: 'Seconds; 0 uses this mob style shieldHoldMs. A positive explicit value wins.', domain: [0, TIMER_MAX/1000] },
            'facing': { type: 'string', description: 'The mob type to keep facing, "nearest" for the closest hostile, or "none" to keep facing where you face now.' }
        },
        perform: runAsAction(async (agent, seconds, facing) => {
            await rangedCommand(agent, 'block', facing, seconds);
        },false,(agent,seconds,facing)=>combatBudget(agent,facing,seconds))
    },
    {
        name: '!retreat',
        description: 'Back away from a mob with your retreatBudgetMs/jump/strafe settings. It does not fight, dig, or choose where you end up - it only steps back where the ground lets you, and tells you the real distance before and after.',
        params: {
            'type': { type: 'string', description: 'The mob type to back away from, or "nearest" for the closest hostile.' },
            'distance': { type: 'float', description: 'Requested separation in blocks, 0 means no step; actual distance is reported.', domain: [0, 32] }
        },
        perform: runAsAction(async (agent, type, distance) => {
            const bot = agent.bot, want = String(type || 'nearest').trim().toLowerCase();
            const target = world.getNearestEntityWhere(bot, (e) => (want === 'nearest' ? mc.isHostile(e) : e.name === want) && world.isAlive(bot, e), 24);
            if (!target) { skills.log(bot, `没退（24 格内没有 ${want === 'nearest' ? '敌对生物' : want}）。`); return; }
            const paused = ['self_defense', 'cowardice', 'hunting', 'item_collecting', 'unstuck', 'elbow_room'];
            for (const m of paused) bot.modes?.pause?.(m);
            try {
                const { r, sentence } = await backAway(agent, target, distance);
                logAct({ kind: 'retreat', args: { target: target.name, distance }, ok: r.result === 'opened' || r.result === 'kept', reason: r.result, ...r });
                skills.log(bot, sentence);
            } finally { for (const m of paused) bot.modes?.unpause?.(m); }
        },false,(agent,type)=>combatBudget(agent,type))
    },
    {
        name: '!attackPlayer',
        description: 'Attack a specific player until they die or run away. Remember this is just a game and does not cause real life harm.',
        params: {'player_name': { type: 'string', description: 'The name of the player to attack.'}},
        perform: runAsAction(async (agent, player_name) => {
            let player = agent.bot.players[player_name]?.entity;
            if (!player) {
                skills.log(agent.bot, `Could not find player ${player_name}.`);
                return false;
            }
            await skills.attackEntity(agent.bot, player, true);
        })
    },
    {
        name: '!goToBed',
        description: 'Go to the nearest bed and sleep.',
        perform: runAsAction(async (agent) => {
            const before = loadRespawn(agent.name).bed?.at || 0;
            await skills.goToBed(agent.bot);
            // owner 10-28 ("最好让她记住家/房子的位置"): her saved "林地小屋" is a point outside the door. A bed the server confirmed is
            // inside her home, so it is kept as a place of hers by the same name each time; the old spot is said if it moved.
            const bed = loadRespawn(agent.name).bed;
            if (bed && bed.at > before) {
                const old = agent.memory_bank.recallPlace?.('我的床');
                agent.memory_bank.rememberPlace('我的床', bed.x, bed.y, bed.z);
                agent.memoryS?.appendPlace?.('我的床', bed);
                const moved = Array.isArray(old) && (Math.round(old[0]) !== bed.x || Math.round(old[2]) !== bed.z) ? `（原来记的「我的床」在 (${old.map(Math.round).join(', ')})）` : '';
                skills.log(agent.bot, `（这张床记成了你的地点「我的床」(${bed.x}, ${bed.y}, ${bed.z})${moved}，以后 !goToRememberedPlace("我的床") 就能回到它旁边。）`);
            }
        })
    },
    {
        name: '!stay',
        description: 'Stay in the current location: you do not wander (cowardice, unstuck, hunting, item collecting and torch placing pause while you wait). If something hits you and you have self_defense on, it fights back and that ends the wait; self_preservation, if you have it on, stays on too. Your ON/OFF mode settings are not changed.',
        params: {'type': { type: 'int', description: 'The number of seconds to stay. -1 for forever.', domain: [-1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, seconds) => {
            await skills.stay(agent.bot, seconds);
        })
    },
    {
        name: '!setMode',
        description: 'Set a mode to on or off. A mode is an automatic behavior that constantly checks and responds to the environment.',
        params: {
            'mode_name': { type: 'string', description: 'The name of the mode to enable.' },
            'on': { type: 'boolean', description: 'Whether to enable or disable the mode.' }
        },
        perform: async function (agent, mode_name, on) {
            const modes = agent.bot.modes;
            if (!modes.exists(mode_name))
            return `Mode ${mode_name} does not exist.` + modes.getDocs();
            if (modes.isOn(mode_name) === on)
            return `Mode ${mode_name} is already ${on ? 'on' : 'off'}.`;
            modes.setOn(mode_name, on);
            saveModeChoice(agent.name, mode_name, on);   // kept across restarts (mode_choices.js)
            logAct({ kind: 'mode', args: { mode: mode_name, on }, ok: true });   // her own mode choices, countable by name (DeepSeek #3042)
            // DeepSeek #3519 (owner 10-26 20:1x): what the switch now means, as fact - never whether she should have done it
            if (mode_name === 'self_defense')
                return on ? '被打还手已开。只有你真的挨了一下才会动，用你给那种怪定的打法；血到撤退线以下时怎么做，看那种怪的 belowLineResponse（!fightStyle 能看到）；怪只是在附近或朝你走时它不出手。'
                    : '被打还手已关。现在起你挨打时这个反射不会替你动；你开着的其他开关（比如 creeper_dodge、self_preservation）照旧。想开回来：!setMode("self_defense", true)。';
            return `Mode ${mode_name} is now ${on ? 'on' : 'off'}.`;
        }
    },
    {
        name: '!goal',
        description: 'Set a goal prompt to endlessly work towards with continuous self-prompting.',
        params: {
            'selfPrompt': { type: 'string', description: 'The goal prompt.' },
        },
        perform: async function (agent, prompt) {
            if (convoManager.inConversation()) {
                agent.self_prompter.setPromptPaused(prompt);
            }
            else {
                agent.self_prompter.start(prompt);
            }
        }
    },
    {
        name: '!endGoal',
        description: 'Call when you have accomplished your goal. It will stop self-prompting and the current action. ',
        perform: async function (agent) {
            agent.self_prompter.stop();
            return 'Self-prompting stopped.';
        }
    },
    {
        name: '!showVillagerTrades',
        description: 'Show trades of a specified villager or wandering trader (use the id from !entities).',
        params: {'id': { type: 'int', description: 'The id of the villager or wandering trader (from !entities), or 0 for the nearest one.' }},
        perform: runAsAction(async (agent, id) => {
            await skills.showVillagerTrades(agent.bot, id);
        })
    },
    {
        name: '!tradeWithVillager',
        description: 'Trade with a specified villager or wandering trader (use the id from !entities).',
        params: {
            'id': { type: 'int', description: 'The id of the villager or wandering trader (from !entities), or 0 for the nearest one.' },
            'index': { type: 'int', description: 'The index of the trade you want executed (1-indexed).', domain: [1, Number.MAX_SAFE_INTEGER] },
            'count': { type: 'int', description: 'How many times that trade should be executed.', domain: [1, Number.MAX_SAFE_INTEGER] },
        },
        perform: runAsAction(async (agent, id, index, count) => {
            await skills.tradeWithVillager(agent.bot, id, index, count);
        })
    },
    {
        name: '!startConversation',
        description: 'Start a conversation with a bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to send the message to.' },
            'message': { type: 'string', description: 'The message to send.' },
        },
        perform: async function (agent, player_name, message) {
            if (!convoManager.isOtherAgent(player_name))
                return player_name + ' is not a bot, cannot start conversation.';
            if (convoManager.inConversation() && !convoManager.inConversation(player_name)) 
                convoManager.forceEndCurrentConversation();
            else if (convoManager.inConversation(player_name))
                agent.history.add('system', 'You are already in conversation with ' + player_name + '. Don\'t use this command to talk to them.');
            convoManager.startConversation(player_name, message);
        }
    },
    {
        name: '!endConversation',
        description: 'End the conversation with the given bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to end the conversation with.' }
        },
        perform: async function (agent, player_name) {
            if (!convoManager.inConversation(player_name))
                return `Not in conversation with ${player_name}.`;
            convoManager.endConversation(player_name);
            return `Converstaion with ${player_name} ended.`;
        }
    },
    {
        name: '!lookAtPlayer',
        description: 'Turn your head to a player ("at") or the way the player is looking ("with"); you are told where they are and whether a block stands between you, from the game data.',
        params: {
            'player_name': { type: 'string', description: 'Name of the target player' },
            'direction': {
                type: 'string',
                description: 'How to look ("at": look at the player, "with": look in the same direction as the player)',
            }
        },
        perform: async function(agent, player_name, direction) {
            if (direction !== 'at' && direction !== 'with') {
                return "Invalid direction. Use 'at' or 'with'.";
            }
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPlayer(player_name, direction);
            };
            await agent.actions.runAction('action:lookAtPlayer', actionFn);
            return result;
        }
    },
    {
        name: '!lookAtPosition',
        description: 'Turn your head to a block cell; you are told which block is there, how far, which way, and whether another block stands in between, from the game data.',
        params: {
            'x': { type: 'int', description: 'x coordinate' },
            'y': { type: 'int', description: 'y coordinate' },
            'z': { type: 'int', description: 'z coordinate' }
        },
        perform: async function(agent, x, y, z) {
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPosition(x, y, z);
            };
            await agent.actions.runAction('action:lookAtPosition', actionFn);
            return result;
        }
    },
    {
        // owner 10-28: breaking one particular block (a leaf in the way, a wall, the block over her head) took her own code; a tool for it
        name: '!breakBlockAt',
        description: 'Break the one block at x, y, z (walks closer first if it is out of reach) and leave everything else as it is. Protected buildings are never touched. The coordinates are a block cell, as other receipts give them.',
        params: {
            'x': { type: 'int', description: 'x of the block' },
            'y': { type: 'int', description: 'y of the block' },
            'z': { type: 'int', description: 'z of the block' }
        },
        perform: runAsAction(async (agent, x, y, z) => {
            const bot = agent.bot, block = bot.blockAt(new Vec3(x, y, z));
            if (!block) { skills.log(bot, `(${x}, ${y}, ${z}) is not loaded - too far to see.`); return; }
            await skills.breakBlockAt(bot, x, y, z);
        })
    },
    {
        name: '!digDown',
        description: 'Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.',
        params: {'distance': { type: 'int', description: 'Distance to dig down', domain: [1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.digDown(agent.bot, distance)
        })
    },
    {
        name: '!goToSurface',
        description: 'Moves the bot to the highest block above it (usually the surface).',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.goToSurface(agent.bot);
        })
    },
    {
        // Owner 2026-10-26: ways out when stuck, in the owner's order (walk, dig/pillar, teleport last and aloud). Hers to choose.
        name: '!pillarUp',
        description: 'Climb straight up out of a hole or a cave: digs the block over your head and places dirt/stone under your feet, again and again, until the sky is open. Needs some dirt or stone in your bag. Does nothing when you are already under open sky, and it never builds walls around you.',
        params: {'max_blocks': { type: 'int', description: 'At most this many blocks up.', domain: [1, 128] }},
        perform: runAsAction(async (agent, max_blocks) => {
            await pillarUp(agent.bot, max_blocks);
        })
    },
    {
        // owner 10-28: she gets the ability and her air value; when to come up is hers
        name: '!swimUp',
        description: 'Swim straight up until your head is out of the water (or something blocks you above), for at most max_seconds. Your air is in !stats.',
        params: {'max_seconds': { type: 'int', description: 'At most this many seconds.', domain: [1, 30] }},
        perform: runAsAction(async (agent, max_seconds) => {
            await swimUp(agent.bot, max_seconds);
        })
    },
    {
        name: '!swimDown',
        description: 'Sink down in water for the given seconds (stops on the bottom). Your air drops while your head is under; it is in !stats.',
        params: {'seconds': { type: 'int', description: 'How many seconds to sink.', domain: [1, 15] }},
        perform: runAsAction(async (agent, seconds) => {
            await swimDown(agent.bot, seconds);
        })
    },
    {
        name: '!teleportToSurface',
        description: 'Last resort when you really cannot get out after trying to walk, dig and climb: say it, then teleport straight up to the open ground above you. Do not use it as a shortcut.',
        params: {},
        perform: runAsAction(async (agent) => {
            await teleportToSurface(agent.bot);
        })
    },
    {
        // owner 10-28: a teleport to a player is hers to use; said aloud first
        name: '!teleportToPlayer',
        description: 'Teleport to an online player (you say it aloud first). Yours to decide when; do not abuse it.',
        params: {'player_name': { type: 'string', description: 'The online player to go to.' }},
        perform: runAsAction(async (agent, player_name) => {
            await teleportToPlayer(agent.bot, player_name);
        })
    },
    {
        name: '!useOn',
        description: 'Use (right click) the given tool on the nearest target of the given type.',
        params: {
            'tool_name': { type: 'string', description: 'Name of the tool to use, or "hand" for no tool.' },
            'target': { type: 'string', description: 'The target as an entity type, block type, or "nothing" for no target.' }
        },
        perform: runAsAction(async (agent, tool_name, target) => {
            await skills.useToolOn(agent.bot, tool_name, target);
        })
    },
    {
        // owner 10-28: what wool and milk are for, and a way to get them
        name: '!shear',
        description: 'Shear up to num sheep near you with shears in your bag: each gives 1-3 wool and grows it back after eating grass (a killed sheep drops only 1). Shears are 2 iron_ingot (!craftRecipe("shears", 1)). Wool makes a bed (3 wool of one colour + 3 planks, e.g. !craftRecipe("white_bed", 1)) - sleeping in a bed sets your respawn point there - and carpets and banners. What you got is read from your bag.',
        params: {'num': { type: 'int', description: 'How many sheep to shear.', domain: [1, 10] }},
        perform: runAsAction(async (agent, num) => {
            await shear(agent.bot, num);
        })
    },
    {
        name: '!milk',
        description: 'Milk the nearest cow (or mooshroom) into an empty bucket in your bag (a bucket is 3 iron_ingot: !craftRecipe("bucket", 1)). Drinking milk (!consume("milk_bucket")) clears every effect on you - poison from pufferfish, hunger from rotten flesh and the rest - and gives the bucket back; milk also makes a cake. What you got is read from your bag.',
        params: {},
        perform: runAsAction(async (agent) => {
            await milk(agent.bot);
        })
    },
];
