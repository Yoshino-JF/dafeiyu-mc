// Her fighting style for !fight (contract #3351, step 2 #3333/#3334/#3337). Defaults come from the old project's tuned numbers
// (ai-vtuber-client/client-agent/combat-policy.mjs COMBAT / TACTICS / KITE_BANDS); what she changes is hers and is kept in
// bots/<name>/fight_style.json. The engine (library/fight.js) only reads the style it is handed for one encounter.
//
// The rules the team agreed on: the system checks a value can work and records it - it never tunes for her, never suggests a value
// and never limits how often she changes things. Evidence is shown honestly instead: n per cell, "too few to tell" under 3, and
// health lost, kills and time always side by side (lost health alone would reward never finishing a fight).
import fs from 'fs';
import path from 'path';

// tactic: 'melee' close in and trade hits; 'kite' hit, then step back to standoff; 'avoid' never start (the engine refuses).
// Two kite bands (old KITE_BANDS, GPT #3356): 'blast' keeps a creeper beyond the 7 blocks where its fuse unwinds; 'fast' only steps
// out of reach between swings - a spider outruns her, so a wide band means walking backwards while it follows.
const KITE_BLAST = { tactic: 'kite', standoff: 8, retreatTo: 9 };
const KITE_FAST = { tactic: 'kite', standoff: 3.2, retreatTo: 4.5 };
const MELEE = { tactic: 'melee' };
const DEFAULTS = Object.freeze({
    _all: { standoff: 8, retreatTo: 9, approachTo: 2.5, cadence: 1.0, disengageHp: 10, loot: true, lead: 1 },
    creeper: KITE_BLAST,
    spider: KITE_FAST,
    cave_spider: KITE_FAST,
    skeleton: MELEE, stray: MELEE, bogged: MELEE,
    zombie: MELEE, husk: MELEE, drowned: MELEE, zombie_villager: MELEE,
    phantom: MELEE, slime: MELEE, magma_cube: MELEE, silverfish: MELEE, endermite: MELEE,
    witch: { tactic: 'avoid' },
    enderman: { tactic: 'avoid' },
    warden: { tactic: 'avoid' },
});

// Policy values are hers. These defaults only preserve the pre-4018 behaviour.
// Reserve 30 s for setup/cleanup under Node's finite action timeout capacity.
export const TIMER_MAX = 2147483647-30000;
export function actionBudgetMinutes(...budgets){
 if(budgets.some(v=>!Number.isFinite(v)||v<0||v>TIMER_MAX))throw RangeError('动作预算超出计时器容量');
 return Math.max(180000,Math.max(0,...budgets)+30000)/60000;
}
const numeric=(value,lo,hi,meaning)=>({value,range:[lo,hi],meaning});
const boolean=(value,meaning)=>({value,boolean:true,meaning});
const choice=(value,values,meaning)=>({value,values,meaning});
export const SPECS=Object.freeze({
 tactic:choice('melee',['melee','kite','avoid'],'打法：melee贴身 / kite打退 / avoid不惹'),
 approachTo:numeric(2.5,Number.MIN_VALUE,3,'冷却期间贴近到几格；不改变真实命中距离'),
 standoff:numeric(8,0,32,'kite或低血脱离所请求的距离；0表示不要求拉开，不保证安全'),
 retreatTo:numeric(9,0,32,'kite重新回去打之前请求的距离，不小于standoff'),
 cadence:numeric(1,Number.MIN_VALUE,Number.MAX_VALUE,'武器冷却的等待倍数；不是修改攻速。空手固定真实5tick，此字段空手时不执行，可保存备用'),
 disengageHp:numeric(10,0,20,'血到几触发低血回应；0不按HP脱离，本服最大20'),
 loot:boolean(true,'目标死后是否尝试捡本次掉落'),
 lead:numeric(1,-Number.MAX_VALUE,Number.MAX_VALUE,'射击速度预测系数；负数落后预测，0瞄当前位置；不是修改箭物理'),
 reflexEnabled:boolean(true,'允许此怪被打还手；还需全局self_defense开且未暂停'),
 hitWindowMs:numeric(1500,Number.MIN_VALUE,TIMER_MAX,'接受多久前的新一次挨打，毫秒；身份和事件去重不变'),
 reflexRange:numeric(8,0,32,'攻击者距自己多远以内允许反射，格'),
 retryDelayMs:numeric(8000,0,TIMER_MAX,'同只未打完后重试等待毫秒，0不因此等；仍需新hit'),
 retryBelowLine:boolean(true,'低于HP线时是否绕过retryDelay等待'),
 avoidRetryDelayMs:numeric(8000,0,TIMER_MAX,'avoid退不动后的等待毫秒'),
 unreachableRetryMs:numeric(30000,0,TIMER_MAX,'够不着后的重试等待毫秒'),
 reengageRadius:numeric(3,0,32,'解除够不着冷却的水平距离；不改变实际攻击触及'),
 reengageDy:numeric(1.5,0,32,'解除够不着冷却的高差，格'),
 reengageOnVisibleReach:boolean(true,'已观察到可见命中点够得着时是否提前解除冷却'),
 blastDodgeEnabled:boolean(true,'允许对已点燃苦力怕短退；还需全局creeper_dodge开且未暂停'),
 blastTriggerRange:numeric(3,0,32,'已点燃苦力怕触发距离，格；不把未点燃当点燃'),
 blastTriggerDy:numeric(3,0,32,'已点燃短退触发高差，格；0只同高'),
 blastRetryMs:numeric(3000,0,TIMER_MAX,'同只点燃源的阶段重试等待，毫秒；阶段内不续预算'),
 blastRetreatTo:numeric(7,0,32,'爆炸短退请求到几格，0不迈步，不能等同安全'),
 blastBudgetMs:numeric(2000,0,TIMER_MAX,'一次点燃短退最多毫秒，0跳过'),
 engageRange:numeric(24,0,32,'开始接战的观察距离，格；不是挥中距离'),
 engageDy:numeric(3,0,32,'起战高差，格；可见真实近战命中例外保留'),
 loseRange:numeric(32,0,32,'目标超此观察距离即丢失，不小于engageRange'),
 loseDy:numeric(6,0,32,'丢失高差，不小于engageDy'),
 threatRange:numeric(16,0,32,'关注其他怪的距离；范围外不等于不存在'),
 targetPolicy:choice('nearer_melee',['selected','nearer_melee'],'只打所选目标 / 允许同场改打更近近战怪'),
 retargetRange:numeric(3,0,32,'改打未跟踪近战怪的距离'),
 retargetDy:numeric(6,0,32,'改打候选高差'),
 retargetGain:numeric(.25,0,32,'新目标要近多少才改打'),
 onCreeperNear:choice('yield',['continue','yield'],'已有接战遇额外苦力怕时继续或交还；原caller作用域保留'),
 onConfirmedRangedHit:choice('yield',['continue','yield'],'受证额外远程攻击后继续或交还'),
 onAvoidedClose:choice('yield',['continue','yield'],'额外avoid近战怪贴近后继续或交还'),
 onNewUnknown:choice('yield',['continue','yield'],'新增未分类威胁后继续或交还'),
 yieldRange:numeric(3,0,32,'近敌交还判据的距离'),
 onThreatAfterTarget:choice('yield',['report_only','yield'],'原目标死亡后的近敌只记事实或交还'),
 encounterBudgetMs:numeric(30000,Number.MIN_VALUE,TIMER_MAX,'一场接战最多毫秒；可取消，不按存活率自动调整'),
 kiteWaitMs:numeric(1500,0,TIMER_MAX,'kite拉开后再接近前等多久，毫秒'),
 approachStallMs:numeric(2000,0,TIMER_MAX,'接近无实际进展多久返回失败，毫秒'),
 noLaneMs:numeric(2000,0,TIMER_MAX,'没有可走局部通路多久返回失败，毫秒'),
 progressDistance:numeric(.25,Number.MIN_VALUE,32,'多少格实际前进算接近有进展'),
 retreatBudgetMs:numeric(2500,0,TIMER_MAX,'公共/低血退步最多毫秒，0不迈步'),
 blockedRetreat:choice('yield',['yield','wait'],'退路全堵立即交还或在预算内等待；不盲走'),
 lootBudgetMs:numeric(1500,0,TIMER_MAX,'本次掉落拾取最多毫秒'),
 lootRange:numeric(3.5,0,32,'从目标死亡处和自身核掉落的距离'),
 belowLineResponse:choice('hit_and_back',['retreat','hit_and_back','keep_fighting'],'低血短退 / 打退 / 保持原战法；每怪选择，不隐式按生存收益换打法'),
 belowLineStandoff:numeric(null,0,32,'低血打退距离；未设时兼容旧max(standoff,6)，可显式改'),
 belowLineRetreatTo:numeric(14,0,32,'低血打退重新接触前距离；未设兼容旧14'),
 avoidResponse:choice('retreat',['report_only','retreat'],'avoid被打时只给事实或短退，不自动挥击'),
 weaponPolicy:choice('best_damage',['keep','best_damage'],'保留手里物品 / 开打前换单下最高伤害工具'),
 approachJump:boolean(true,'接近时是否尝试已观察到的跳步'),
 approachStrafe:boolean(true,'接近时是否尝试侧向和对角步'),
 retreatJump:boolean(true,'退步时是否尝试陆地跳步；游泳浮力按键另属执行'),
 retreatStrafe:boolean(true,'退步时是否尝试左右步'),
 retreatHostileClearance:numeric(2,0,32,'fight内点燃退步避向其他近敌的间距偏好，0不因此挡路；公共retreat原本不核此项'),
 retreatHostileDy:numeric(3,0,32,'fight内点燃退步关注其他怪的高差；公共retreat原本不核此项'),
 shotBudgetMs:numeric(5000,Number.MIN_VALUE,TIMER_MAX,'一次shoot总预算毫秒'),
 aimHeightRatio:numeric(.5,0,1,'弓瞄目标观测高度的比例，不改近战命中核对'),
 bowDrawTicks:numeric(24,1,Math.floor(TIMER_MAX/50),'至少拉弓的客户端物理tick数；瞄准/发包等待可能增加，回执列实际观察值；正整数，短拉可能不出箭/低伤'),
 shieldHoldMs:numeric(2000,Number.MIN_VALUE,TIMER_MAX,'!block未给持续时间时的毫秒；明确命令参数优先'),
});
export const RANGES=Object.freeze(Object.fromEntries(Object.entries(SPECS).filter(([,s])=>s.range).map(([k,s])=>[k,s.range])));
const allFields=Object.keys(SPECS).filter(k=>k!=='tactic');
export const FIELDS=Object.freeze({melee:allFields,kite:allFields,avoid:allFields});
export const ANY_TACTIC=Object.freeze(allFields);
const MEANING=Object.fromEntries(Object.entries(SPECS).map(([k,s])=>[k,s.meaning]));
const policyDefaults=Object.fromEntries(Object.entries(SPECS).map(([k,s])=>[k,s.value]));
export function defaultText(key){
 const exceptions={tactic:'普通melee；creeper/spider/cave_spider为kite；witch/enderman/warden为avoid',
  standoff:'8；spider/cave_spider为3.2',retreatTo:'9；spider/cave_spider为4.5',
  belowLineResponse:'hit_and_back；skeleton/stray/bogged/pillager/blaze为keep_fighting',
  belowLineStandoff:'未设时max(standoff,6)，可显式覆盖'};
 return exceptions[key]??String(SPECS[key]?.value);
}
const lowRanged=new Set(['skeleton','stray','bogged','pillager','blaze']);
export function completeStyle(mob,input={}){
 const base=String(mob||'').split('@')[0];
 const st={...policyDefaults,...DEFAULTS._all,...(DEFAULTS[base]||MELEE),
  belowLineResponse:lowRanged.has(base)?'keep_fighting':'hit_and_back',...input};
 if(st.belowLineStandoff===null)st.belowLineStandoff=Math.max(st.standoff,6);
 return st;
}
export function validateStyle(st){
 for(const[k,s]of Object.entries(SPECS)){
  const v=st[k];
  if(s.boolean&&typeof v!=='boolean')throw TypeError(k+' 必须是true/false');
  if(s.values&&!s.values.includes(v))throw RangeError(k+' 只能是 '+s.values.join('/'));
  if(s.range&&(!Number.isFinite(v)||v<s.range[0]||v>s.range[1]))throw RangeError(k+' 可行范围 '+s.range.join('–'));
 }
 if(!Number.isInteger(st.bowDrawTicks))throw RangeError('bowDrawTicks必须是正整数');
 if(st.tactic==='kite'&&st.retreatTo<st.standoff)throw RangeError('retreatTo不能小于standoff');
 if(st.loseRange<st.engageRange||st.loseDy<st.engageDy)throw RangeError('loseRange/loseDy不能小于engageRange/engageDy');
 if(st.belowLineResponse==='hit_and_back'&&st.belowLineRetreatTo<st.belowLineStandoff)throw RangeError('belowLineRetreatTo不能小于belowLineStandoff');
 return st;
}
export const inHeight=(dy,limit,strict=false)=>limit===0?Math.abs(dy)<1e-9:strict?Math.abs(dy)<limit:Math.abs(dy)<=limit;
export function blastAllowed(bot,st){
 return st.blastDodgeEnabled&&bot.modes?.isOn?.('creeper_dodge')===true&&!bot.modes?.isPaused?.('creeper_dodge');
}
const blastStarts=new WeakMap();
export function claimBlast(bot,source,st,now=Date.now()){
 if(!blastAllowed(bot,st))return false;
 let seen=blastStarts.get(bot);if(!seen){seen=new Map();blastStarts.set(bot,seen);}
 const k=String(source.id)+':'+(source.uuid||''),last=seen.get(k);
 if(last!==undefined&&now-last<st.blastRetryMs)return false;
 seen.set(k,now);return true;
}

const dir = (name) => path.join('./bots', name);
const styleFile = (name) => path.join(dir(name), 'fight_style.json');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) || d; } catch { return d; } };
const append = (f, rec) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(rec) + '\n'); } catch { /* best effort */ } };
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };

function saved(name) { return name ? readJson(styleFile(name), { version: 1, mobs: {} }) : { version: 1, mobs: {} }; }

/** Version of her style (1 = the defaults); each change bumps it, and every [combat] record carries the version it fought with. */
export function styleVersion(name) { return saved(name).version || 1; }
export const STYLE_VERSION = 1;   // the defaults; kept for callers without a bot name

/**
 * The full style for one mob type: shared values, that mob's defaults, then her own changes. Unknown mobs fight melee.
 * "zombie@hand" is the set for fighting it bare-handed (owner 10-26): it starts as her armed set and only differs once she changes it
 * (DeepSeek #3417: copy on first write, so her samples are not split on day one).
 */
function fromSaved(mob,mine){
 const [base,hand]=String(mob||'').split('@');
 return completeStyle(base,{...(mine._all||{}),...(mine[base]||{}),...(hand?mine[mob]||{}:{})});
}
export function styleFor(mob,name=null){return fromSaved(mob,saved(name).mobs||{});}

/** Change one setting for one mob. A value that cannot work is refused with the reason and the allowed range - never clamped. */
export function setStyle(name,mob,key,raw,{day=null}={}){
 mob=String(mob||'').trim().toLowerCase();key=String(key||'').trim();
 if(!mob)return {ok:false,msg:'要说是哪种怪。'};
 const spec=Object.hasOwn(SPECS,key)?SPECS[key]:null;if(!spec)return {ok:false,msg:'没有这个字段：'+key+'；可设：'+Object.keys(SPECS).join('、')};
 if(key.startsWith('blast')&&!['creeper','_all'].includes(mob.split('@')[0]))return {ok:false,msg:'blast字段读取creeper/creeper@hand（或_all继承），不是当前被打的其他怪。'};
 const s=saved(name),before=fromSaved(mob,s.mobs||{});let value;
 if(spec.boolean){
  const t=String(raw).trim();value=/^(true|on|yes|1|捡)$/i.test(t)?true:/^(false|off|no|0|不捡)$/i.test(t)?false:null;
 }else value=spec.values?String(raw).trim().toLowerCase():String(raw??'').trim()===''?NaN:Number(raw);
 const mobs={...(s.mobs||{}),[mob]:{...(s.mobs?.[mob]||{}),[key]:value}};
 const affected=mob==='_all'?[...new Set([...Object.keys(DEFAULTS),...Object.keys(mobs)])]
  :[...new Set([mob,...Object.keys(mobs).filter(m=>m.startsWith(mob+'@'))])];
 try{for(const m of affected){try{validateStyle(fromSaved(m,mobs));}catch(e){throw Error(m+'：'+e.message);}}}
 catch(e){return {ok:false,msg:MEANING[key]+'：'+e.message};}
 if(before[key]===value)return {ok:false,msg:mob+' 的 '+key+' 已经是 '+value+'，没改。'};
 s.mobs=mobs;s.version=(s.version||1)+1;
 try{fs.mkdirSync(dir(name),{recursive:true});fs.writeFileSync(styleFile(name),JSON.stringify(s,null,2));}
 catch(e){return {ok:false,msg:'没存上：'+e.message};}
 append(path.join(dir(name),'fight_style_changes.jsonl'),{at:Date.now(),day,version:s.version,mob,key,from:before[key],to:value});
 return {ok:true,version:s.version,msg:mob+' 的 '+key+'：'+before[key]+' → '+value+'（第'+s.version+'版；下一场/阶段起生效，不会自动开启模式）。'};
}

/** Her own bare-handed fights with one mob type, or null under 3 (DeepSeek #3423: her measured numbers before the vanilla constant). */
export function handStats(name, mob) {
    const list = readLines(path.join(dir(name), 'fight_history.jsonl'))
        .filter((r) => (!Array.isArray(r.targets) || r.targets.length <= 1) && r.weapon === 'hand' && (r.target?.name || r.target) === mob && r.result !== 'refused');
    if (list.length < 3) return null;
    const sum = (k) => list.reduce((s, r) => s + (Number.isFinite(r[k]) ? r[k] : 0), 0);
    return { n: list.length, swings: sum('swings'), hits: sum('hits'), dmg: Math.round(sum('damageTaken') / list.length * 10) / 10, killed: list.filter((r) => r.result === 'killed').length };
}

/** Every encounter, kept for good (logs rotate after 7 days; her evidence should not). */
export function recordFight(name, rec) { if (name) append(path.join(dir(name), 'fight_history.jsonl'), rec); }

/** What she can see: her style for that mob, and the facts of her fights with it - with this style and in all. */
export function describe(name,mob,{modes=null}={}){
 const state=saved(name),history=readLines(path.join(dir(name),'fight_history.jsonl'));
 const mobs=mob&&mob!=='all'?[String(mob)]:[...new Set(['_all',...Object.keys(state.mobs||{}),...history.map(r=>r.styleKey||r.target?.name||r.target).filter(Boolean)])];
 const flags=modes?['self_defense','creeper_dodge'].map(m=>m+'='+modes.isOn(m)+'（暂停='+ (typeof modes.isPaused==='function'?modes.isPaused(m):'未知')+'）').join('，'):'全局模式状态未传入，不推测';
 const legend=Object.entries(SPECS).map(([k,s])=>k+'：'+s.meaning+'；合法 '+(s.boolean?'true/false':s.values?s.values.join('/'):s.range.join('–'))+'；缺省 '+defaultText(k)).join('\n');
 const blocks=mobs.map(m=>{
  const st=styleFor(m,name),own=state.mobs?.[m]||{};
  const values=Object.keys(SPECS).map(k=>k+'='+st[k]+(Object.hasOwn(own,k)?'（你设的）':'（继承/兼容缺省）')).join('，');
  const typed=history.filter(r=>(r.target?.name||r.target)===m.split('@')[0]&&r.result!=='refused');
  const facts=typed.filter(r=>r.styleKey===m),unknown=typed.filter(r=>!r.styleKey).length;
  const same=facts.filter(r=>r.styleVersion===(state.version||1));
  return m+'：'+values+'\n开场配置 '+m+' 的事实记录 '+facts.length+' 场，其中全局版本'+(state.version||1)+'记录 '+same.length+' 场；该怪旧记录开场配置未知 '+unknown+' 场（未混入本配置）；未自动判断或调整打法。';
 });
 return flags+'；写style不自动开模式；总开关关/暂停时每怪开关不能越过。blast字段读creeper/creeper@hand；fight内只在self_defense起效，主动fight不触发。每场按开场手持物选配置并冻结；开打换武器不切换本场配置。各阶段仍受接战总预算约束。avoid下攻击/loot字段保存备用，不在本次执行。\n'+blocks.join('\n')+'\n字段含义与单位（不附建议值）：\n'+legend;
}
