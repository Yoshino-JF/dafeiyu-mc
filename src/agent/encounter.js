// One encounter, whoever started it (owner 10-26 final plan #3422): her own !fight, the reflex after a confirmed hit, later her own
// approach rules. Same engine (library/fight.js), same style of hers for that mob - the unarmed set when her hands are empty - same
// [combat] record and the same fact sentence back. Who started it is the `trigger`; nothing here decides whether to fight.
import * as skills from './library/skills.js';
import { styleFor, styleVersion, recordFight, inHeight } from './fight_style.js';
import { combatStart, firstHurtMs } from './combat_context.js';
import { logCombat } from './dafeiyu_log.js';
import { FIGHT_START_RANGE,meleePoint } from './library/fight.js';
import { retargetSummary, confirmedThreatText, cancellationText } from './combat_targets.js';
import { escapeSummary } from './library/retreat_step.js';

const RESULT = { killed: '打死了', disengaged: '按你的设置结束接触', lost: '目标丢了', refused: '没开打', interrupted: '被打断了', timeout: '本场预算到，停下了' };
// the engine's reason codes in her words - facts, including the unflattering ones ("could not get away")
const REASON = {
    entity_dead_observed: '', low_health_contact_broken: '已经拉开了距离',
    retreat_blocked_contact_not_broken: '后路被挡住，没能拉开距离，它还在旁边', retreat_budget_contact_not_broken: '退步预算到，没确认拉开距离',
    entity_gone_without_death: '它从视野里消失了，没看到它死', target_left_observation_range: '目标超过本场距离/高差设置', approach_blocked: '按你设的接近/通路预算仍未达到进展条件',
    no_legal_target: '那不是能打的敌对生物', target_out_of_range: '它太远或不在你这一层', tactic_avoid: '你的打法里这种怪是"不惹"',
    action_cancelled: '', action_cancelled_before_start: '', encounter_deadline: '',
    escape_blocked: '', escape_budget: '', escape_aim_deadline: '避让瞄准未完成，身体已经停下', configured_no_step: '按你的设置未迈退步',
};
// reasons that carry data: "threat_changed:creeper@15.9" reached her raw in the third arena run
function reasonText(reason) {
    const t = /^threat_changed:([a-z_]+)@([\d.]+)$/.exec(reason);
    if (t) return `又有一只 ${t[1]} 到了约 ${Math.round(Number(t[2]))} 格内，停下来让你重新决定先对付哪只`;
    return REASON[reason] ?? reason;
}
const WEAPON = /(_sword|_axe)$|^(trident|mace)$/;
// How far !fight reaches, and how far out an approaching mob is announced - one number, so she is never told about a mob she then may
// not fight (DeepSeek #3433: notices at 24 blocks, !fight refused beyond 16). Same level: within 3 blocks up or down.
export const FIGHT_REACH = FIGHT_START_RANGE;   // the engine's own number (GPT #3445), so the two can never drift apart again
export const isArmed = (bot) => WEAPON.test(bot.heldItem?.name || '');

// Vanilla Java per-hit melee damage (1.21; copper tools as of 1.21.9). Owner 10-27 08:4x: the fight takes whatever in her bag hits hardest,
// not only swords, and she is told the numbers - so making a better weapon is something she can see the point of. Anything not listed
// hits like a bare hand (1). Spears (26.1): their plain jab, from minecraft.wiki/w/Spear (Java) - the engine never charge-attacks, and a
// spear's charge (tier multiplier x her speed, from 4.6 blocks/s) is what makes it strong.
const DAMAGE = {
    wooden_spear: 1, golden_spear: 1, stone_spear: 2, copper_spear: 2, iron_spear: 3, diamond_spear: 4, netherite_spear: 5,
    wooden_sword: 4, golden_sword: 4, stone_sword: 5, copper_sword: 5, iron_sword: 6, diamond_sword: 7, netherite_sword: 8,
    wooden_axe: 7, golden_axe: 7, stone_axe: 9, copper_axe: 9, iron_axe: 9, diamond_axe: 9, netherite_axe: 10,
    wooden_pickaxe: 2, golden_pickaxe: 2, stone_pickaxe: 3, copper_pickaxe: 3, iron_pickaxe: 4, diamond_pickaxe: 5, netherite_pickaxe: 6,
    wooden_shovel: 2.5, golden_shovel: 2.5, stone_shovel: 3.5, copper_shovel: 3.5, iron_shovel: 4.5, diamond_shovel: 5.5, netherite_shovel: 6.5,
    trident: 9, mace: 6,
};
// swings per second, for ties: the same damage from a faster item is more damage over a fight
const SPEED = (n) => (/_sword$/.test(n) ? 1.6 : /_shovel$|^trident$/.test(n) ? 1.1 : /_pickaxe$/.test(n) ? 1.2 : /_axe$/.test(n) ? 0.9 : /^mace$/.test(n) ? 0.6 : /_spear$/.test(n) ? 1 : 4);
export const meleeDamage = (name) => (name && DAMAGE[name]) || 1;
/** What in her bag hits hardest per swing (the faster one on a tie), or null when nothing beats a bare hand. */
export function bestWeapon(bot) {
    return (bot.inventory?.items?.() || []).filter((i) => meleeDamage(i.name) > 1)
        .sort((a, b) => meleeDamage(b.name) - meleeDamage(a.name) || SPEED(b.name) - SPEED(a.name))[0] || null;
}

/** Bare hands: nothing in the main hand. A pickaxe, a block or food is not a weapon either, but it is not bare-handed (GPT #3424). */
export const isBareHanded = (bot) => !bot.heldItem;

/** Her style for this mob as it applies right now: the bare-hand set ("mob@hand") when her main hand is empty. */
export function styleNow(agent, mob) {
    return styleFor(isBareHanded(agent.bot) ? `${mob}@hand` : mob, agent.name);
}

const RETREAT = { opened: '拉开了', kept: '本来就够远，没动', blocked: '后路被挡住，没拉开', interrupted: '被打断了', timeout: '退步预算内没退到' };

/** Back away from it (library/fight.js retreat, GPT #3429): no fighting, no digging, no destination chosen for her. */
export async function backAway(agent, target, distance, givenStyle=null, {continueWhile=()=>true}={}) {
    const bot = agent.bot, startHp = bot.health, policy=givenStyle||styleNow(agent,target.name);
    let r;
    try { const { retreat } = await import('./library/fight.js'); r = await retreat(bot, target, { distance,style:policy,continueWhile }); }
    catch (e) { r = { result: 'blocked', reason: 'engine_error: ' + (e?.message || e), startDistance: null, endDistance: null, seconds: 0 }; }
    const d = (v) => Number.isFinite(v) ? Math.round(v * 10) / 10 : '?';
    const sentence = `往后退（离 ${target.name} 想退到 ${distance} 格）：${r.reason==='configured_no_step'?'按你的设置不迈步':RETREAT[r.result] || r.result}；距离 ${d(r.startDistance)}→${d(r.endDistance)} 格，你的血 ${Math.round(startHp)}→${Math.round(bot.health)}，用时 ${Math.round((r.seconds ?? 0) * 10) / 10} 秒。`
        + (cancellationText(r) ? ` ${cancellationText(r)}。` : '');
    return { r, sentence };
}

/** Run one encounter with the engine and report it. Returns { record, sentence }. */
export async function runEncounter(agent, target, { caller = 'her', trigger = 'her',style:givenStyle=null } = {}) {
    const bot = agent.bot;
    const { startedAt, ...context } = combatStart(bot, target);
    const style = givenStyle||styleNow(agent, target.name), version = styleVersion(agent.name);
    const styleKey=target.name+(isBareHanded(bot)?'@hand':''),blastPolicy=styleNow(agent,'creeper');
    // her style for this mob is "avoid" and it hit her: the reflex only backs away (final plan #3422) - it never fights what she avoids.
    const low = Number.isFinite(bot.health) && bot.health <= style.disengageHp;
    // Owner 10-26 20:0x "改成边打边退吧": under her line the reflex no longer only steps back (final-22: backed into a wall at 9 HP, then
    // 8 s with nothing answering, dead). Melee mobs: hit, back off, hit again when it closes - never chase. Archers: close in and finish it
    // (backing off only lets them shoot). Mobs she avoids: still only step back.
    const fightBack=low&&style.tactic!=='avoid'&&trigger!=='her';
    const response=style.belowLineResponse;
    const engineStyle=!fightBack||response==='retreat'?style:response==='keep_fighting'?{...style,disengageHp:0}
        :{...style,tactic:'kite',disengageHp:0,standoff:style.belowLineStandoff,retreatTo:style.belowLineRetreatTo};
    const retreatOnly=fightBack&&response==='retreat';
    if ((style.tactic === 'avoid'||retreatOnly) && trigger !== 'her') {
        const hp0 = bot.health;
        const { r, sentence: back } = !retreatOnly&&style.avoidResponse==='report_only'
            ? {r:{result:'kept',reason:'configured_report_only',seconds:0,endDistance:target.position.distanceTo(bot.entity.position)},sentence:'按你的设置只给信息，没有后退。'}
            : await backAway(agent, target, retreatOnly?style.standoff:style.retreatTo,style,{continueWhile:()=>caller!=='self_defense'||(bot.modes?.isOn?.('self_defense')===true&&!bot.modes?.isPaused?.('self_defense'))});
        const record = { at: Date.now(), caller, trigger, ...context, firstHurtMs: firstHurtMs(bot, startedAt), styleVersion: version, styleKey,style,
            tactic: retreatOnly?'below_line':'avoid',...(retreatOnly?{belowLine:true,lineHp:style.disengageHp}:{}),
            result: r.result === 'interrupted' ? 'interrupted' : r.result === 'timeout' ? 'timeout' : 'disengaged',
            reason: r.result === 'opened' || r.result === 'kept' ? `retreat_${r.result}` : r.reason || `retreat_${r.result}`, cancelledBy: r.cancelledBy ?? null,
            hits: 0, swings: 0, startHp: hp0, endHp: bot.health, damageTaken: Math.max(0, Math.round(((bot.recentDamage || []).filter((x) => x.at >= startedAt).reduce((s, x) => s + x.amount, 0)) * 10) / 10),
            seconds: r.seconds ?? 0, distanceEnd: r.endDistance ?? null, armed: isArmed(bot), weapon: bot.heldItem?.name || 'hand', target: { name: target.name, id: target.id } };
        logCombat(record);
        recordFight(agent.name, record);
        const sentence = `${trigger === 'hit' ? '被打后反射' : '按你的规矩'}：${retreatOnly?'血低于你设置的线，按你的选择只退不挥':`你的打法里${target.name}是不惹，没还手`}，${back}`;
        skills.log(bot, sentence);
        return { record, sentence };
    }
    // A fight is fought with the best weapon in her bag, not whatever she was holding (final-27 23:4x: cobblestone, 4 swings, 2 hits, 15 -> 10 HP;
    // "手里还拿着圆石……先把铜剑换上！" came too late). Her own !fight too since 10-27 03:2x (DeepSeek #3607): 12 of hers, 0 kills, 11 with no
    // swing at all, holding dirt or cobblestone ("手里还攥着土块，真是够笨的"), while the reflex killed 10 of 22. Which fight is still hers;
    // readying a weapon is part of the tool. Since 10-27 08:4x (owner): whatever in the bag hits hardest per swing, any tool, when it beats
    // what is in her hand; the receipt gives both numbers.
    let switched = null;
    const heldBefore = bot.heldItem?.name || null, best = bestWeapon(bot);
    if (style.weaponPolicy==='best_damage' && best && meleeDamage(best.name) > meleeDamage(heldBefore)) {
        try { await bot.equip(best, 'hand'); switched = `${best.name}（每下约 ${meleeDamage(best.name)} 点伤害；原来手里的 ${heldBefore || '空手'} 约 ${meleeDamage(heldBefore)} 点）`; }
        catch { /* fight with what she has */ }
    }
    let r;
    try {
        const { fight } = await import('./library/fight.js');
        r = await fight(bot, { target, style: engineStyle, caller,blastStyle:blastPolicy });
    } catch (e) {
        r = { result: 'refused', reason: 'engine_error: ' + (e?.message || e), tactic: style.tactic, hits: 0, swings: 0, startHp: bot.health, endHp: bot.health,
            damageTaken: 0, seconds: 0, armed: isArmed(bot), weapon: bot.heldItem?.name || 'hand' };
    }
    const record = { at: Date.now(), caller, trigger, ...context, firstHurtMs: firstHurtMs(bot, startedAt), styleVersion: version, styleKey,style, ...r,
        weapon: r.weapon || 'hand', target: { name: target.name, id: target.id }, ...(fightBack ? { belowLine: true, lineHp: style.disengageHp } : {}) };
    logCombat(record);
    recordFight(agent.name, record);
    const hp = (v) => Number.isFinite(v) ? Math.round(v) : '?';
    const who = (trigger === 'hit' ? '被打后反射' : trigger === 'rule' ? '按你的规矩' : '战斗结果')
        + (fightBack ? `（你的血 ${hp(r.startHp)} 在你定的撤退线 ${style.disengageHp} 以下，${{retreat:'按你的设置脱离接触',hit_and_back:'按你的设置边打边退',keep_fighting:'按你的设置继续原战法'}[response]}）` : '');
    // arena feedback 10-26: "就我一个在打，为什么还带个不确定" - only say so when the count really says it; "20→?" after a kill read as
    // "跑了还是死了"; "空手" while she held cobblestone hid that a sword was in her bag
    const extraHits = Number.isFinite(r.hits) && Number.isFinite(r.swings) && r.hits > r.swings ? `（受伤事件比挥击多 ${r.hits - r.swings} 次，可能包含横扫或其他伤害，不等于你的命中次数）` : '';
    const hpAfter = r.targetDead || r.result === 'killed' ? 0 : r.targetHpAfter;
    const held = bot.heldItem?.name, bagWeapon = bot.inventory?.items?.().find((i) => WEAPON.test(i.name))?.name;
    const hands = (switched ? `，开打前把 ${switched}换到了手上` : '')
        + (r.armed !== false ? '' : (held ? `，手里拿的是 ${held}（不算武器）` : '，空手') + (bagWeapon ? `，背包里有 ${bagWeapon}` : ''));
    const group = retargetSummary(r);
    const detail = cancellationText(r) || (r.reason && REASON[r.reason] !== '' ? confirmedThreatText(r) || reasonText(r.reason) : '');
    const sentence = `${who}：${RESULT[r.result] || r.result}（${target.name}，${r.tactic || style.tactic}；你挥了 ${r.swings ?? '?'} 下，观察到目标受伤合计 ${r.hits ?? '?'} 次${extraHits}，`
        + `你的血 ${hp(r.startHp)}→${hp(r.endHp)}，掉了 ${hp(r.damageTaken)}，用时 ${Math.round(r.seconds ?? 0)} 秒`
        + (Number.isFinite(r.targetHpBefore) ? `，它的血 ${hp(r.targetHpBefore)}→${Number.isFinite(hpAfter) ? hp(hpAfter) : '看不到'}` : '')
        + (Number.isFinite(r.distanceEnd) ? `，结束时相距 ${Math.round(r.distanceEnd)} 格` : '') + hands
        + (detail ? `；${detail}` : '') + '）。'
        // 17:3x: twice at 9 and 7 HP she tried to finish an 8-HP skeleton and was turned back in 0 s, never told why or what she could change
        + (trigger==='her'&&r.result==='disengaged'&&Number.isFinite(r.startHp)&&r.startHp<=style.disengageHp
            ? `开打时血${hp(r.startHp)}在你设置的HP线${style.disengageHp}以下；结果按你的设置执行。`:'')
        + (r.threatResponse==='continue'&&r.threatSource?` 期间观察到${r.threatSource.name}，按你的策略继续，没有替你停战。`:'')
        + (group?` ${group}`:'')+(r.escape?` ${escapeSummary(r.escape)}`:'');
    skills.log(bot, sentence);
    return { record, sentence };
}

export function withinEngagement(bot,target,style){return target.position.distanceTo(bot.entity.position)<=style.engageRange&&(inHeight(target.position.y-bot.entity.position.y,style.engageDy,true)||!!meleePoint(bot,target));}
