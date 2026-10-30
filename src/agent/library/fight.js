// Mineflayer encounter executor, contract bridge #3351.
// Tactics/spacing: ai-vtuber-client/client-agent/combat-policy.mjs (COMBAT,
// KITE_BANDS, aimAt, retreatStep); blast cycle: combat-kite-cycle.mjs.
// Cadence: combat-cadence.mjs, adapted to real local physics ticks + attributes.
// Deliberately no home/food gate, dig-out, model decision, logging or persistence.
import Vec3 from 'vec3';
import {isCancelledAction,cancelledBy as actionCancelledBy} from '../action_manager.js';
import {styleFor,completeStyle,validateStyle,inHeight,blastAllowed,claimBlast} from '../fight_style.js';
import {selectRetreatStep} from './retreat_step.js';
import {swimmingStart,swimLane} from './swim_lane.js';

const encounters = new WeakMap();
const keys = ['forward', 'back', 'left', 'right', 'jump', 'sprint'];
const hostileNames = new Set(['creeper','zombie','husk','drowned','zombie_villager','skeleton','stray','bogged','spider','cave_spider','phantom','slime','magma_cube','silverfish','endermite','witch','enderman','warden','blaze','ghast','pillager','vindicator','evoker','ravager','wither_skeleton','piglin_brute','hoglin','zoglin','breeze']);
const meleeNames = new Set(['zombie','husk','drowned','zombie_villager','spider','cave_spider','phantom','slime','magma_cube','silverfish','endermite','warden','vindicator','ravager','wither_skeleton','piglin_brute','hoglin','zoglin']);
const rangedNames = new Set(['skeleton','stray','bogged','pillager','witch','blaze','ghast','evoker','breeze']);
const projectileNames = new Set(['arrow','spectral_arrow','trident','fireball','small_fireball','wither_skull','shulker_bullet','wind_charge','breeze_wind_charge','dragon_fireball']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const finite = value => Number.isFinite(value) ? value : null;
const distance = (a,b) => a && b ? Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z) : Infinity;
const bare = name => String(name || '').replace(/^minecraft:/,'');
export const FIGHT_START_RANGE = 24;
export const FIGHT_REACH = 3;
export const FIGHT_OBSERVE_RANGE = 32;

export function observedTargetHealth(bot,target) {
    const layout=bot.registry?.entitiesByName?.[bare(target?.name)]?.metadataKeys;
    const index=Array.isArray(layout)?layout.indexOf('health'):-1;
    const value=index>=0?target?.metadata?.[index]:undefined;
    return Number.isFinite(value)&&value>=0?value:null;
}

export class BlastCycle {
    constructor(style, now = Date.now) { this.style=style;this.now=now;this.phase='approach';this.safeSince=null; }
    step(d, charged) {
        if(this.phase==='retreat') {
            if(d<this.style.standoff) {this.safeSince=null;return 'back';}
            if(this.safeSince===null)this.safeSince=this.now();
            if(this.now()-this.safeSince<(this.style.kiteWaitMs??1500) || !charged || d<this.style.retreatTo)return 'back';
            this.phase='approach';this.safeSince=null;
        }
        if(d<=3)return charged?'attack':'back';
        return charged?'advance':'hold';
    }
    swung() {this.phase='retreat';this.safeSince=null;}
}

export function attackSpeed(bot) {
    const attribute=Object.entries(bot.entity?.attributes || {}).find(([key])=>key.endsWith('attack_speed'))?.[1];
    if(attribute && Number.isFinite(attribute.value)) {
        let base=attribute.value;
        const mods=attribute.modifiers || [];
        for(const m of mods)if(m.operation===0 || m.operation==='add_value')base+=m.amount;
        let value=base;
        for(const m of mods)if(m.operation===1 || m.operation==='add_multiplied_base')value+=base*m.amount;
        for(const m of mods)if(m.operation===2 || m.operation==='add_multiplied_total')value*=1+m.amount;
        if(Number.isFinite(value)&&value>0)return value;
    }
    const name=bare(bot.heldItem?.name);
    if(!name)return 4; // Known vanilla empty-hand speed; never refuse her choice.
    if(name.endsWith('_sword'))return 1.6;
    if(/^(wooden|stone|copper)_axe$/.test(name))return .8;
    if(name==='iron_axe')return .9;
    if(name.endsWith('_axe'))return 1;
    if(name.endsWith('_pickaxe'))return 1.2;
    if(name.endsWith('_shovel'))return 1;
    if(name==='trident')return 1.1;
    if(name==='mace')return .6;
    // 26.1 spears, Java jab cooldowns (minecraft.wiki/w/Spear): wooden 1.54 ... netherite 0.87
    const spear={wooden_spear:1.54,stone_spear:1.33,copper_spear:1.18,golden_spear:1.05,iron_spear:1.05,diamond_spear:.95,netherite_spear:.87}[name];
    if(spear)return spear;
    return 4; // Ordinary held non-weapons keep the base attack speed.
}

const hazardous = b => !b || /^(lava|water|fire|soul_fire|cactus|magma_block|campfire|soul_campfire|powder_snow|sweet_berry_bush|cobweb)$/.test(b.name);
function intersects(a,b) {return a[0]<b[3]&&a[3]>b[0]&&a[1]<b[4]&&a[4]>b[1]&&a[2]<b[5]&&a[5]>b[2];}
// Check the actual body footprint and observed collision shapes, not block-name floors.
export function lane(bot, dx, dz, stepUp = false, partialStart = false) {
    const p=bot.entity.position, rise=stepUp?1:0;
    for(const n of [.35,.7,1.1]) {
        const x=p.x+dx*n,z=p.z+dz*n,y=p.y+rise;
        const box=[x-.3,y+.03,z-.3,x+.3,y+(bot.entity.height||1.8),z+.3];
        let supported=0;
        for(let bx=Math.floor(box[0]);bx<=Math.floor(box[3]);bx++)for(let bz=Math.floor(box[2]);bz<=Math.floor(box[5]);bz++) {
            for(let by=Math.floor(box[1]);by<=Math.floor(box[4]);by++) {
                const b=bot.blockAt(new Vec3(bx,by,bz));
                if(hazardous(b)||!Array.isArray(b.shapes))return false;
                if(b.shapes.some(s=>intersects(box,[bx+s[0],by+s[1],bz+s[2],bx+s[3],by+s[4],bz+s[5]])))return false;
            }
            if(stepUp&&n<1.1)continue; // The jump may cross air before landing on the observed step.
            const floor=bot.blockAt(new Vec3(bx,Math.floor(y-.05),bz));
            if(hazardous(floor)||!Array.isArray(floor.shapes))return false;
            if(floor.shapes.some(s=>Math.abs(Math.floor(y-.05)+s[4]-y)<.12))supported++;
            // A body already on the edge of a step can walk fully onto it. Earlier
            // samples still need observed support; the final footprint stays fully supported.
            else if(!partialStart||n===1.1)return false;
        }
        if(partialStart&&(!stepUp||n===1.1)&&supported===0)return false;
    }
    return true;
}

// Local collision-tested steering, not a route search. Keep one side through a
// corner instead of alternating keys; the existing no-progress budget still applies.
export function approachMovement(bot, dx, dz, side = null, policy={}) {
    const n=Math.hypot(dx,dz);
    if(n<.001)return {input:{},side,route:'blocked'};
    const ux=dx/n,uz=dz/n;
    if(lane(bot,ux,uz,false,true))return {input:{forward:true,sprint:true},side,route:'direct'};
    if(policy.approachJump!==false&&lane(bot,ux,uz,true,true))return {input:{forward:true,jump:true},side,route:'jump'};
    if(policy.approachStrafe===false)return {input:{},side,route:'blocked'};
    for(const nextSide of side?[side,side==='left'?'right':'left']:['left','right']) {
        const sign=nextSide==='left'?1:-1,lx=uz*sign,lz=-ux*sign;
        if(lane(bot,(ux+lx)*Math.SQRT1_2,(uz+lz)*Math.SQRT1_2,false,true))
            return {input:{forward:true,[nextSide]:true},side:nextSide,route:'diagonal'};
        if(lane(bot,lx,lz,false,true))return {input:{[nextSide]:true},side:nextSide,route:'side'};
    }
    return {input:{},side,route:'blocked'};
}

export function retreatLane(bot,dx,dz,stepUp=false) {
    if(stepUp==='down')return !swimmingStart(bot)&&laneDown(bot,dx,dz);
    return swimmingStart(bot)?!stepUp&&swimLane(bot,dx,dz):lane(bot,dx,dz,stepUp);
}

// owner 10-29 ("可以被炸，但完全不动"): a lane that steps down one block - off a doorstep or down a slope. The body must pass at its
// own height first (no wall), and the last sample stands on a floor one block lower; one block down hurts nothing.
export function laneDown(bot,dx,dz) {
    const p=bot.entity.position,h=bot.entity.height||1.8;
    const clear=(x,y,z)=>{
        const box=[x-.3,y+.03,z-.3,x+.3,y+h,z+.3];
        for(let bx=Math.floor(box[0]);bx<=Math.floor(box[3]);bx++)for(let bz=Math.floor(box[2]);bz<=Math.floor(box[5]);bz++)for(let by=Math.floor(box[1]);by<=Math.floor(box[4]);by++) {
            const b=bot.blockAt(new Vec3(bx,by,bz));
            if(hazardous(b)||!Array.isArray(b.shapes))return false;
            if(b.shapes.some(s=>intersects(box,[bx+s[0],by+s[1],bz+s[2],bx+s[3],by+s[4],bz+s[5]])))return false;
        }
        return true;
    };
    for(const n of [.35,.7])if(!clear(p.x+dx*n,p.y,p.z+dz*n))return false;
    const x=p.x+dx*1.1,z=p.z+dz*1.1,y=p.y-1;
    if(!clear(x,y,z))return false;
    for(let bx=Math.floor(x-.3);bx<=Math.floor(x+.3);bx++)for(let bz=Math.floor(z-.3);bz<=Math.floor(z+.3);bz++) {
        const floor=bot.blockAt(new Vec3(bx,Math.floor(y-.05),bz));
        if(hazardous(floor)||!Array.isArray(floor?.shapes))return false;
        if(floor.shapes.some(s=>Math.abs(Math.floor(y-.05)+s[4]-y)<.12))return true;   // one supported footprint cell is enough to land
    }
    return false;
}

function aimPoint(target) {
    const height=Number.isFinite(target.height)&&target.height>0?target.height:1.7;
    return target.position.offset(0,Math.min(height-.05,Math.max(.15,height*.5)),0);
}
function visible(bot, point) {
    const eye=bot.entity.position.offset(0,bot.entity.eyeHeight||1.62,0),delta=point.minus(eye),length=delta.norm();
    for(let n=0;n<length;n+=.08) {
        const p=eye.plus(delta.scaled(n/length)),b=bot.blockAt(p.floored());
        if(!b||!Array.isArray(b.shapes))return false;
        const local=p.minus(p.floored());
        if(b.shapes.some(s=>local.x>s[0]&&local.x<s[3]&&local.y>s[1]&&local.y<s[4]&&local.z>s[2]&&local.z<s[5]))return false;
    }
    return true;
}

// Aim within the observed hitbox, rather than its often-occluded body centre.
// A ledge can hide a swimmer's torso while leaving its head in melee reach.
export function meleePoint(bot,target) {
    const eye=bot.entity.position.offset(0,bot.entity.eyeHeight||1.62,0);
    const width=Number.isFinite(target.width)&&target.width>0?target.width:.6;
    const height=Number.isFinite(target.height)&&target.height>0?target.height:1.7;
    const p=target.position,half=width/2,inset=.01;
    const clamp=(n,lo,hi)=>Math.max(lo,Math.min(hi,n));
    const point=new Vec3(clamp(eye.x,p.x-half+inset,p.x+half-inset),
        clamp(eye.y,p.y+inset,p.y+height-inset),clamp(eye.z,p.z-half+inset,p.z+half-inset));
    return point.distanceTo(eye)<=FIGHT_REACH&&visible(bot,point)?point:null;
}

async function face(bot,point,cancelled,deadline) {
    let settled=false,error;
    Promise.resolve(bot.lookAt(point,true)).then(()=>{settled=true;},e=>{error=e;settled=true;});
    await Promise.resolve();
    // Core force-look resolves immediately. Keep cancellation bounded even if a
    // replacement/plugin leaves that promise pending; never attack on an unconfirmed look.
    while(!settled&&!cancelled()&&Date.now()<deadline)await sleep(25);
    if(error)throw error;
    return settled&&!cancelled();
}

function chosenStyle(name,input){
 return Object.freeze(validateStyle(completeStyle(name,input?.[name]||(input?.tactic?input:{}))));
}

function takeControls(bot,cancelled) {
    const prior=encounters.get(bot);if(prior)prior.release();
    const owner={keys:new Map(),release:null},owns=()=>encounters.get(bot)===owner;
    const controls=input=>{
        if(!owns()||cancelled())return;
        for(const key of keys){const next=!!input[key];if(bot.getControlState(key)!==next){bot.setControlState(key,next);owner.keys.set(key,next);}}
    };
    owner.release=()=>{
        if(!owns())return;
        if(!isCancelledAction(bot))for(const [key,value]of owner.keys)if(value&&bot.getControlState(key)===value)bot.setControlState(key,false);
        encounters.delete(bot);
    };
    encounters.set(bot,owner);
    return {owner,owns,controls};
}

// Cached observations only. A known death is not a new opponent during its death animation.
function nearbyThreats(bot,deadIds,range=16) {
    return Object.values(bot.entities||{}).filter(e=>e!==bot.entity&&e.position&&hostileNames.has(bare(e.name))&&!deadIds.has(e.id)&&!bot._knownDead?.has(e.id)&&observedTargetHealth(bot,e)!==0&&distance(e.position,bot.entity.position)<=range);
}
export function fuseObserved(bot,e) {
    const layout=bot.registry?.entitiesByName?.creeper?.metadataKeys;
    const value=key=>Array.isArray(layout)?e.metadata?.[layout.indexOf(key)]:undefined;
    return Number(value('swell_dir'))>0||value('is_ignited')===true||value('is_ignited')===1;
}

/** A bounded observed step away, not a route to a remote destination or a promise of safety. */
export async function retreat(bot,from,{distance:desired,timeoutMs,style=null,continueWhile=()=>true}={}) {
    const cfg=validateStyle(completeStyle(bare(from?.name),style||styleFor(bare(from?.name),bot.username)));
    timeoutMs??=cfg.retreatBudgetMs;
    if(!Number.isFinite(desired)||desired<0||!Number.isFinite(timeoutMs)||timeoutMs<0)throw RangeError('Positive retreat distance and timeout required');
    const began=Date.now(),point=()=>from?.position||from;
    const valid=p=>p&&['x','y','z'].every(k=>Number.isFinite(p[k]));
    const currentDistance=()=>valid(point())&&valid(bot.entity?.position)?distance(point(),bot.entity.position):null;
    const startDistance=currentDistance();
    const receipt=(result,reason)=>({result,startDistance,endDistance:currentDistance(),seconds:(Date.now()-began)/1000,reason,cancelledBy:reason?.startsWith('action_cancelled')?actionCancelledBy(bot):null});
    const cancelled=()=>bot.interrupt_code||isCancelledAction(bot)||!continueWhile();
    if(cancelled())return receipt('interrupted','action_cancelled_before_start');
    if(startDistance===null)return receipt('blocked','source_position_unknown');
    if(desired===0||timeoutMs===0)return receipt('kept','configured_no_step');
    if(startDistance>=desired)return receipt('kept','distance_already_kept');
    const {owner,owns,controls}=takeControls(bot,cancelled);
    let ticks=0,lastTick=-1,ended=false;
    const onTick=()=>ticks++,onEnd=()=>{ended=true;};
    bot.on('physicsTick',onTick);bot.on('end',onEnd);
    try {
        bot.pvp?.forceStop?.();bot.pathfinder?.setGoal(null);
        while(Date.now()-began<timeoutMs) {
            if(!owns()||cancelled()||ended)return receipt('interrupted',ended?'connection_ended':'action_cancelled');
            const d=currentDistance();if(d===null)return receipt('blocked','source_position_unknown');
            if(d>=desired)return receipt('opened','distance_observed');
            if(ticks===lastTick){await sleep(25);continue;}lastTick=ticks;
            const p=point(),dx=p.x-bot.entity.position.x,dz=p.z-bot.entity.position.z,n=Math.hypot(dx,dz);
            if(n<.001)return receipt('blocked','no_horizontal_direction');
            const aim=from?.position?aimPoint(from):new Vec3(p.x,p.y+1,p.z);
            if(!await face(bot,aim,()=>!owns()||cancelled()||ended,Math.min(began+timeoutMs,Date.now()+250))){
                if(!owns()||cancelled()||ended)continue;
                return receipt('timeout','aim_deadline');
            }
            // Recheck after every await; no step is authorized by an old look result.
            if(!owns()||cancelled()||ended)continue;
            const step=selectRetreatStep(bot.entity.position,p,(x,z,jump)=>retreatLane(bot,x,z,jump),{policy:cfg});
            if(step.plan)controls({...step.plan.input,...(swimmingStart(bot)?{jump:true}:{})});
            else if(cfg.blockedRetreat==='yield')return receipt('blocked','retreat_blocked_contact_not_broken');
            else controls({});
            await sleep(25);
        }
        return receipt('timeout','retreat_budget_contact_not_broken');
    }finally {owner.release();bot.removeListener('physicsTick',onTick);bot.removeListener('end',onEnd);}
}

export async function fight(bot,{target=null,style=null,caller='her',timeoutMs,blastStyle=null}={}) {
    if(timeoutMs!==undefined&&(!Number.isFinite(timeoutMs)||timeoutMs<=0))throw RangeError('Positive combat timeout required');
    const began=Date.now(),startHp=finite(bot.health),weapon=bare(bot.heldItem?.name)||'hand';
    const armed=/(_sword|_axe)$|^(trident|mace)$/.test(weapon);
    const legal=e=>e&&e!==bot.entity&&Number.isInteger(e.id)&&e.position&&hostileNames.has(bare(e.name))&&e.isValid!==false&&observedTargetHealth(bot,e)!==0&&!bot._knownDead?.has(e.id);
    if(!target)target=Object.values(bot.entities||{}).filter(e=>legal(e)&&distance(e.position,bot.entity.position)<=chosenStyle(bare(e.name),style).engageRange&&(inHeight(e.position.y-bot.entity.position.y,chosenStyle(bare(e.name),style).engageDy,true)||meleePoint(bot,e))).sort((a,b)=>distance(a.position,bot.entity.position)-distance(b.position,bot.entity.position))[0]||null;
    let name=bare(target?.name);
    const initialTarget=target,initialName=name,chosen=chosenStyle(name,style),key=e=>`${e?.id}:${e?.uuid||''}`;
    timeoutMs??=chosen.encounterBudgetMs;
    const blast=validateStyle(completeStyle('creeper',blastStyle||styleFor('creeper'+(weapon==='hand'?'@hand':''),bot.username)));
    let hits=0,swings=0,damageTaken=0,previousHp=startHp,healthKnown=startHp!==null,dead=false,gone=false,approachBlockedMs=0,approachInfo=null;
    const targetHpBefore=observedTargetHealth(bot,target);
    const records=new Map(),targetSequence=[],selfHurtSources=new Map(),avoidCache=new Map();
    let retargets=0,threatTrigger=null,threatSource=null,threatResponse=null;
    let escapeInfo=null,escapeSource=null,escapeActive=false,escapeDeadline=null,escapeLastTick=-1;
    const track=e=>{
        let r=records.get(key(e));
        if(!r){r={entity:e,id:e.id,uuid:e.uuid||null,name:bare(e.name),swings:0,hits:0,targetHpBefore:observedTargetHealth(bot,e),targetDead:false,gone:false,lootAttempted:false};records.set(key(e),r);}
        return r;
    };
    const snapshot=r=>({id:r.id,uuid:r.uuid,name:r.name,swings:r.swings,hits:r.hits,targetHpBefore:r.targetHpBefore,targetHpAfter:r.targetDead?(observedTargetHealth(bot,r.entity)===0?0:null):r.gone?null:observedTargetHealth(bot,r.entity),targetDead:r.targetDead,gone:r.gone});
    const receipt=(result,reason)=>{
        const original=records.get(key(initialTarget)),observed=observedTargetHealth(bot,initialTarget),originalDead=!!original?.targetDead;
        // Death proves death, not a fresh numeric metadata value. Never turn a
        // stale pre-death value into "after HP", or infer damage from hurt events.
        const targetHpAfter=originalDead?(observed===0?0:null):original?.gone||bot.entities?.[initialTarget?.id]!==initialTarget?null:observed;
        return {result,caller,target:{name:initialName||null,id:initialTarget?.id??null},tactic:chosen.tactic,hits,swings,startHp,endHp:finite(bot.health),damageTaken:healthKnown?damageTaken:null,targetHpBefore,targetHpAfter,targetDead:originalDead,cadenceApplied:weapon!=='hand',approachBlockedMs,seconds:(Date.now()-began)/1000,distanceEnd:finite(distance(initialTarget?.position,bot.entity?.position)),reason,armed,weapon,
            retargets,targetSequence:targetSequence.map(x=>({...x})),targets:[...records.values()].map(snapshot),allEngagedTargetsDead:records.size>0&&[...records.values()].every(r=>r.targetDead),threatTrigger,threatSource,threatResponse,policy:chosen,hitMeaning:'observed_entity_hurt_not_damage_attribution',cancelledBy:reason?.startsWith('action_cancelled')?actionCancelledBy(bot):null,approach:approachInfo,escape:escapeInfo};
    };
    if(!legal(target))return receipt('refused','no_legal_target');
    if(distance(target.position,bot.entity.position)>chosen.engageRange||!inHeight(target.position.y-bot.entity.position.y,chosen.engageDy,true)&&!meleePoint(bot,target))return receipt('refused','target_out_of_range');
    if(chosen.tactic==='avoid')return receipt('refused','tactic_avoid');
    const cancelled=()=>bot.interrupt_code||isCancelledAction(bot)||(caller==='self_defense'&&(bot.modes?.isOn?.('self_defense')===false||bot.modes?.isPaused?.('self_defense')));
    if(cancelled())return receipt('interrupted','action_cancelled_before_start');
    // A new caller explicitly takes over only the previous encounter's recorded keys.
    const {owner,owns,controls}=takeControls(bot,cancelled);
    let ended=false,ticks=0,lastTicks=-1,lastSwingTick=0,lastSwingAt=began;
    let equipped=weapon,speed=attackSpeed(bot),retreatStarted=null,blockedSince=null,approachSince=null,approachBest=null,approachAnchor=null,approachLaneSince=null,approachSide=null;
    let cycle=new BlastCycle(chosen);
    const same=e=>e===target||e?.id===target.id&&(!target.uuid||e.uuid===target.uuid);
    const deadIds=new Set(bot._knownDead||[]);
    const living=e=>legal(e)&&bot.entities?.[e.id]===e&&!deadIds.has(e.id)&&!records.get(key(e))?.targetDead;
    const melee=e=>meleeNames.has(bare(e.name))||bare(e.name)==='enderman'&&selfHurtSources.has(key(e));
    const avoided=e=>{
        if(records.has(key(e)))return false; // Already chosen for this encounter.
        const mob=bare(e.name);if(!avoidCache.has(mob))avoidCache.set(mob,(style?.[mob]||styleFor(weapon==='hand'?mob+'@hand':mob,bot.username)).tactic==='avoid');
        return avoidCache.get(mob);
    };
    const unknown=e=>!melee(e)&&!rangedNames.has(bare(e.name))&&bare(e.name)!=='creeper';
    const initialUnknown=nearbyThreats(bot,deadIds,chosen.threatRange).filter(e=>!same(e)&&unknown(e)),initialIds=new Set(initialUnknown.map(key));
    track(target);targetSequence.push({id:target.id,uuid:target.uuid||null,name,atMs:0,reason:'initial'});
    const preferred=()=>chosen.targetPolicy==='selected'?(living(target)?target:null):Object.values(bot.entities||{}).filter(e=>living(e)&&inHeight(e.position.y-bot.entity.position.y,chosen.retargetDy)&&(records.has(key(e))?distance(e.position,bot.entity.position)<=chosen.loseRange:melee(e)&&distance(e.position,bot.entity.position)<=chosen.retargetRange&&!avoided(e))).sort((a,b)=>distance(a.position,bot.entity.position)-distance(b.position,bot.entity.position))[0]||null;
    const selectPreferred=()=>{
        const next=preferred();if(!next||same(next))return false;
        if(living(target)&&distance(next.position,bot.entity.position)+chosen.retargetGain>=distance(target.position,bot.entity.position))return false;
        const reason=dead?'target_dead':gone?'target_gone':'nearer_melee';
        target=next;name=bare(next.name);dead=false;gone=false;track(next);retargets++;
        targetSequence.push({id:next.id,uuid:next.uuid||null,name,atMs:Date.now()-began,reason});
        // New direction, not a new budget/cooldown/low-health retreat window.
        approachSince=null;approachBest=null;approachAnchor=null;approachLaneSince=null;approachSide=null;approachInfo=null;blockedSince=null;cycle=new BlastCycle(chosen);
        return true;
    };
    const threatChanged=(looting=false)=>{
        const now=nearbyThreats(bot,deadIds,chosen.threatRange);
        // The selected creeper is already handled by BlastCycle; otherwise its
        // own <=3m melee range would be forbidden by this mixed-threat check.
        const creeper=caller==='self_defense'&&!looting?null:now.find(e=>bare(e.name)==='creeper'&&(looting||!same(e))&&(distance(e.position,bot.entity.position)<=chosen.yieldRange||fuseObserved(bot,e)));
        // Distance after knockback is not evidence of a ranged hit. A melee
        // attacker drifting beyond 3m must not recreate the interruption loop.
        const confirmed=[...selfHurtSources.values()].find(r=>r.ranged&&!same(r.entity)&&living(r.entity)&&distance(r.entity.position,bot.entity.position)<=chosen.loseRange)?.entity;
        const avoidClose=now.find(e=>!same(e)&&melee(e)&&distance(e.position,bot.entity.position)<=chosen.yieldRange&&avoided(e));
        const others=now.filter(e=>!same(e)&&unknown(e)),added=others.length>initialUnknown.length?(others.find(e=>!initialIds.has(key(e)))||others[0]):null;
        const causes=[
            {e:creeper,type:'creeper_near_or_fuse',response:chosen.onCreeperNear},
            {e:confirmed,type:'confirmed_self_hurt',response:chosen.onConfirmedRangedHit},
            {e:avoidClose,type:'avoided_melee_close',response:chosen.onAvoidedClose},
            {e:added,type:'new_unclassified_hostile',response:chosen.onNewUnknown}
        ].filter(c=>c.e);
        if(!causes.length)return null;
        const canYield=c=>looting?chosen.onThreatAfterTarget==='yield':c.response==='yield';
        const c=causes.find(canYield)||causes[0],e=c.e;
        threatTrigger=c.type;threatSource={id:e.id,uuid:e.uuid||null,name:bare(e.name)};
        threatResponse=canYield(c)?'yield':'continue';
        return canYield(c)?`threat_changed:${bare(e.name)}@${distance(e.position,bot.entity.position).toFixed(1)}`:null;
    };
    const onDead=e=>{if(e?.id!==undefined)deadIds.add(e.id);const r=records.get(key(e));if(r)r.targetDead=true;if(same(e))dead=true;};
    const onGone=e=>{if(e?.id!==undefined)deadIds.delete(e.id);const r=records.get(key(e));if(r)r.gone=true;if(same(e))gone=true;};
    const onHurt=(e,source)=>{
        const r=records.get(key(e));if(r){r.hits++;hits++;} // Observation, not attribution to her attacks.
        if(e===bot.entity&&legal(source)){const prior=selfHurtSources.get(key(source));selfHurtSources.set(key(source),{entity:source,ranged:!!prior?.ranged||rangedNames.has(bare(source.name))});}
    };
    const onDamagePacket=packet=>{
        if(packet.entityId!==bot.entity.id)return;
        const source=bot.entities?.[packet.sourceCauseId-1],direct=bot.entities?.[packet.sourceDirectId-1];
        if(legal(source)&&projectileNames.has(bare(direct?.name)))selfHurtSources.set(key(source),{entity:source,ranged:true});
    };
    const onTick=()=>ticks++;
    const onEnd=()=>{ended=true;};
    const onHealth=()=>{if(Number.isFinite(previousHp)&&Number.isFinite(bot.health))damageTaken+=Math.max(0,previousHp-bot.health);else healthKnown=false;previousHp=finite(bot.health);};
    const listeners=[['entityDead',onDead],['entityGone',onGone],['entityHurt',onHurt],['health',onHealth],['physicsTick',onTick],['end',onEnd]];
    for(const [event,fn]of listeners)bot.on(event,fn);
    bot._client?.on?.('damage_event',onDamagePacket);
    const escapeEvent=type=>escapeInfo.events.push({type,atMs:Date.now()-began,owner:'fight:self_defense',sourceId:escapeSource?.id??null,sourceUuid:escapeSource?.uuid||null});
    const observeEscape=()=>{
        const me=bot.entity.position;
        const view=e=>({id:e.id,uuid:e.uuid||null,name:bare(e.name),position:{x:e.position.x,y:e.position.y,z:e.position.z},relative:{dx:e.position.x-me.x,dy:e.position.y-me.y,dz:e.position.z-me.z},distance:distance(e.position,me)});
        escapeInfo.creeper=escapeSource&&living(escapeSource)?{...view(escapeSource),fuse:fuseObserved(bot,escapeSource)}:null;
        escapeInfo.others=nearbyThreats(bot,deadIds,chosen.threatRange).filter(e=>e!==escapeSource&&living(e)).map(view);
        escapeInfo.elapsedMs=Date.now()-escapeInfo.startedAt;
    };
    const finishEscape=reason=>{
        escapeInfo.outcome=reason;escapeEvent(reason);controls({});
        return {reason};
    };
    const dodgeEnabled=()=>blastAllowed(bot,blast);
    const disableDodge=()=>{
        if(escapeActive){escapeActive=false;escapeInfo.outcome='disabled';escapeEvent('dodge_disabled');controls({});}
        return null;
    };
    // This phase uses the encounter's existing keys/lease and cooldown. The
    // public retreat() wrapper would revoke that lease and cannot be awaited here.
    const evadeCreeper=async()=>{
        if(caller!=='self_defense'||dead||gone)return null;
        if(!dodgeEnabled())return disableDodge();
        const creepers=nearbyThreats(bot,deadIds,Math.max(chosen.threatRange,blast.blastTriggerRange)).filter(e=>bare(e.name)==='creeper'&&!same(e)&&living(e));
        const lit=creepers.filter(e=>fuseObserved(bot,e)&&distance(e.position,bot.entity.position)<=blast.blastTriggerRange&&inHeight(e.position.y-bot.entity.position.y,blast.blastTriggerDy,true)).sort((a,b)=>distance(a.position,bot.entity.position)-distance(b.position,bot.entity.position))[0];
        const current=escapeActive&&living(escapeSource)?escapeSource:null;
        if(!lit&&!current){
            if(escapeActive){escapeActive=false;escapeInfo.outcome='source_gone';observeEscape();escapeEvent('source_gone');controls({});}
            return null;
        }
        escapeSource=lit||current;
        if(!escapeInfo){
            if(blast.blastBudgetMs===0||blast.blastRetreatTo===0||!claimBlast(bot,escapeSource,blast))return null;
            escapeInfo={startedAt:Date.now(),phase:'creeper_dodge',outcome:'active',events:[],attempted:[],creeper:null,others:[],elapsedMs:0};
            escapeInfo.budgetMs=blast.blastBudgetMs;escapeInfo.style={...blast};
            escapeDeadline=escapeInfo.startedAt+blast.blastBudgetMs;escapeInfo.deadline=escapeDeadline;escapeEvent('escape_begin');escapeEvent('creeper_dodge_takeover');
        }
        escapeActive=true;
        observeEscape();
        const desired=blast.blastRetreatTo;
        if(escapeInfo.creeper.distance>=desired){
            escapeActive=false;escapeInfo.outcome='opened';escapeEvent('escape_opened');controls({});return null;
        }
        if(Date.now()>=escapeDeadline)return finishEscape('escape_budget');
        if(ticks===escapeLastTick)return {handled:true};
        escapeLastTick=ticks;
        const looked=await face(bot,aimPoint(escapeSource),()=>!owns()||cancelled()||ended,Math.min(began+timeoutMs,escapeDeadline,Date.now()+250));
        if(!owns()||cancelled()||ended)return {handled:true};
        if(!dodgeEnabled())return disableDodge();
        if(!looked){escapeInfo.outcome='interrupted';controls({});return {reason:'escape_aim_deadline'};}
        if(!living(escapeSource)){escapeActive=false;escapeInfo.outcome='source_gone';observeEscape();escapeEvent('source_gone');controls({});return {handled:true};}
        observeEscape();
        const urgent=threatChanged();if(urgent)return {reason:urgent};
        if(Date.now()>=escapeDeadline)return finishEscape('escape_budget');
        const otherLit=nearbyThreats(bot,deadIds,chosen.threatRange).find(e=>e!==escapeSource&&bare(e.name)==='creeper'&&fuseObserved(bot,e)&&
            (!fuseObserved(bot,escapeSource)||distance(e.position,bot.entity.position)+.05<distance(escapeSource.position,bot.entity.position)));
        if(otherLit){controls({});return {handled:true};} // re-aim before stepping away from a different fuse
        const selection=selectRetreatStep(bot.entity.position,escapeSource.position,(x,z,jump)=>retreatLane(bot,x,z,jump),{
            policy:blast,others:nearbyThreats(bot,deadIds,chosen.threatRange).filter(e=>e!==escapeSource&&living(e))
        });
        for(const attempt of selection.attempted)if(!escapeInfo.attempted.some(x=>x.direction===attempt.direction&&x.reason===attempt.reason))escapeInfo.attempted.push(attempt);
        if(!selection.plan){
            if(blast.blockedRetreat==='yield')return finishEscape('escape_blocked');
            controls({});return {handled:true};
        }
        controls({...selection.plan.input,...(swimmingStart(bot)?{jump:true}:{})});return {handled:true};
    };
    try {
        // Do not run the PVP plugin and this controller simultaneously. No unbounded pvp.stop await.
        if(bot.pvp?.target)bot.pvp.forceStop();
        bot.pathfinder?.setGoal(null);
        while(Date.now()-began<timeoutMs) {
            if(!owns()||cancelled())return receipt('interrupted','action_cancelled');
            if(ended)return receipt('interrupted','connection_ended');
            const changed=threatChanged(dead);if(changed)return receipt('interrupted',changed);
            const escape=await evadeCreeper();
            if(escape?.reason)return receipt('interrupted',escape.reason);
            if(escape?.handled){await sleep(25);continue;}
            if(selectPreferred()){controls({});const urgent=threatChanged();if(urgent)return receipt('interrupted',urgent);}
            if(dead) {
                controls({});
                const unconfirmed=[...records.values()].find(r=>!r.targetDead);
                if(unconfirmed)return receipt('lost',bot.entities?.[unconfirmed.id]===unconfirmed.entity?'target_left_observation_range':'entity_gone_without_death');
                // Only loot after real target death, within the same bounded/cancellable encounter.
                let pendingMelee=false;
                if(chosen.loot)for(const r of records.values())if(r.targetDead&&!r.lootAttempted){
                    const changed=await collectOwnNearbyDrops(bot,r.entity,chosen,controls,()=>!owns()||cancelled(),Math.min(began+timeoutMs,Date.now()+chosen.lootBudgetMs),()=>threatChanged(true)||(preferred()?'melee_pending':null));
                    if(changed==='melee_pending'){controls({});pendingMelee=true;break;}
                    if(changed)return receipt('interrupted',changed);r.lootAttempted=true;
                }
                if(pendingMelee)continue;
                if(!owns()||cancelled())return receipt('interrupted','action_cancelled');
                return receipt('killed','entity_dead_observed');
            }
            if(gone||!same(bot.entities?.[target.id]))return receipt('lost','entity_gone_without_death');
            const d=distance(target.position,bot.entity.position);
            if(d>chosen.loseRange||!inHeight(target.position.y-bot.entity.position.y,chosen.loseDy))return receipt('lost','target_left_observation_range');
            if(ticks===lastTicks){await sleep(25);continue;}lastTicks=ticks;
            const currentWeapon=bare(bot.heldItem?.name)||'hand',currentSpeed=attackSpeed(bot);
            if(currentWeapon!==equipped||currentSpeed!==speed){equipped=currentWeapon;speed=currentSpeed;lastSwingTick=ticks;lastSwingAt=Date.now();}
            const cooldownTicks=currentWeapon==='hand'?5:Math.ceil(20/speed*chosen.cadence)+1;
            const charged=ticks-lastSwingTick>=cooldownTicks&&Date.now()-lastSwingAt>=cooldownTicks*50;
            const point=meleePoint(bot,target)||aimPoint(target);
            // force=true has no tick-wait in Mineflayer; never leave an unscoped look task.
            if(!await face(bot,point,()=>!owns()||cancelled()||ended,Math.min(began+timeoutMs,Date.now()+250))){
                if(!owns()||cancelled()||ended)continue;
                return receipt('timeout','aim_deadline');
            }
            if(!owns()||cancelled())continue;
            const changedAfterAim=threatChanged();if(changedAfterAim)return receipt('interrupted',changedAfterAim);
            const escapeAfterAim=await evadeCreeper();
            if(escapeAfterAim?.reason)return receipt('interrupted',escapeAfterAim.reason);
            if(escapeAfterAim?.handled){await sleep(25);continue;}
            if(dead||gone)continue;
            // GPT #3954 (final-102 02:14, 9 s, 19 retargets, 0 swings): picking the nearer of two again after aiming could skip every
            // charged swing. This aimed frame stays on its target; nearer ordinary targets are reconsidered at the top of the next one.
            const low=Number.isFinite(bot.health)&&bot.health<=chosen.disengageHp;
            if(low&&retreatStarted===null)retreatStarted=Date.now();
            if(retreatStarted!==null&&(chosen.retreatBudgetMs===0||chosen.standoff===0))return receipt('disengaged','configured_no_step');
            if(retreatStarted!==null&&d>=chosen.standoff)return receipt('disengaged','low_health_contact_broken');
            let step=retreatStarted!==null?'back':name==='creeper'&&chosen.tactic==='kite'?cycle.step(d,charged):chosen.tactic==='kite'?(d<=3&&charged?'attack':d<chosen.standoff?'back':d>chosen.retreatTo&&charged?'advance':'hold'):(d<=3&&charged?'attack':d>chosen.approachTo?'advance':'hold');
            const contact=meleePoint(bot,target);
            // Keep retreat steering, but do not stand helpless beside a reachable
            // ordinary enemy. Creeper hit-and-retreat phases remain authoritative.
            if(contact&&name!=='creeper') {
                if(charged)step='attack';
                else if(retreatStarted===null&&chosen.tactic==='melee')step='hold';
            }
            let needsApproach=step==='advance';
            if(step==='attack') {
                if(contact) {
                    const attacked=target;bot.attack(attacked);swings++;track(attacked).swings++;lastSwingTick=ticks;lastSwingAt=Date.now();
                    if(chosen.tactic==='kite'||retreatStarted!==null){cycle.swung();step='back';}else step='hold';
                }else {step='advance';needsApproach=true;}
            }
            const dx=target.position.x-bot.entity.position.x,dz=target.position.z-bot.entity.position.z,n=Math.hypot(dx,dz)||1;
            const direction=step==='back'?-1:1,ux=dx/n*direction,uz=dz/n*direction;
            let input={};
            let approachRoute=null;
            if(step==='advance') {
                const next=approachMovement(bot,dx,dz,approachSide,chosen);
                input=next.input;approachSide=next.side;approachRoute=next.route;
                if(!Object.keys(input).length&&blockedSince===null)blockedSince=Date.now();
            }else if(step==='back') {
                if(lane(bot,ux,uz))input=step==='back'?{back:true}:{forward:true,sprint:true};
                else if(chosen.retreatJump&&lane(bot,ux,uz,true))input=step==='back'?{back:true,jump:true}:{forward:true,jump:true};
                else if(chosen.retreatStrafe&&step==='back'&&lane(bot,dz/n,-dx/n))input={left:true};
                else if(chosen.retreatStrafe&&step==='back'&&lane(bot,-dz/n,dx/n))input={right:true};
                else {if(blockedSince===null)blockedSince=Date.now();}
            }
            if(Object.keys(input).length)blockedSince=null;
            // A moving opponent can keep its distance even while she is really
            // advancing. Count observed forward body displacement too; a sent key
            // or knockback away from the target is not that progress.
            if(needsApproach&&retreatStarted===null) {
                const now=Date.now(),p=bot.entity.position;
                if(approachSince===null){approachSince=now;approachBest=d;approachAnchor=p.clone();}
                const ax=target.position.x-approachAnchor.x,az=target.position.z-approachAnchor.z,an=Math.hypot(ax,az);
                const forwardProgress=an>.001?((p.x-approachAnchor.x)*ax+(p.z-approachAnchor.z)*az)/an:0;
                if(d<approachBest-chosen.progressDistance||forwardProgress>chosen.progressDistance){approachSince=now;approachBest=d;approachAnchor=p.clone();}
                if(!Object.keys(input).length){if(approachLaneSince===null)approachLaneSince=now;}else approachLaneSince=null;
                const stationaryMs=now-approachSince,blockedMs=approachLaneSince===null?0:now-approachLaneSince;
                const xyz=v=>({x:v.x,y:v.y,z:v.z});
                approachInfo={atMs:now-began,route:approachRoute,side:approachSide,input:{...input},feet:xyz(p),targetFeet:xyz(target.position),deltaY:target.position.y-p.y,stationaryMs,noLaneMs:blockedMs};
                if(stationaryMs>=chosen.approachStallMs||(approachLaneSince!==null&&blockedMs>=chosen.noLaneMs)){approachBlockedMs=Math.max(stationaryMs,blockedMs);return receipt('lost','approach_blocked');}
            }else {approachSince=null;approachBest=null;approachAnchor=null;approachLaneSince=null;}
            controls(input);
            if(retreatStarted!==null&&((chosen.blockedRetreat==='yield'&&blockedSince!==null&&(!contact||name==='creeper'))||Date.now()-retreatStarted>=chosen.retreatBudgetMs))return receipt('disengaged',blockedSince!==null?'retreat_blocked_contact_not_broken':'retreat_budget_contact_not_broken');
            await sleep(25);
        }
        return receipt('timeout','encounter_deadline');
    }finally {
        owner.release();for(const [event,fn]of listeners)bot.removeListener(event,fn);bot._client?.removeListener?.('damage_event',onDamagePacket);
    }
}

async function collectOwnNearbyDrops(bot,target,policy,controls,cancelled,deadline,threatChanged) {
    const origin=target.position.clone();
    while(Date.now()<deadline&&!cancelled()) {
        const changed=threatChanged();if(changed)return changed;
        const item=Object.values(bot.entities||{}).filter(e=>e.name==='item'&&distance(e.position,origin)<policy.lootRange&&distance(e.position,bot.entity.position)<policy.lootRange).sort((a,b)=>distance(a.position,bot.entity.position)-distance(b.position,bot.entity.position))[0];
        if(!item)return;
        const looked=await face(bot,item.position.offset(0,.2,0),cancelled,Math.min(deadline,Date.now()+250));
        const changedAfterLook=threatChanged();if(changedAfterLook)return changedAfterLook;
        if(!looked)return;
        const dx=item.position.x-bot.entity.position.x,dz=item.position.z-bot.entity.position.z,n=Math.hypot(dx,dz)||1;
        if(!lane(bot,dx/n,dz/n)){controls({});return;}
        controls({forward:true});await sleep(25);
    }
    controls({});
}



// owner 10-29 ("可以被炸，但完全不动" / "简单，可靠，实用"): at her real house the step-by-step retreat found every lane "blocked" and she
// stood still. The dodge now just walks away with the pathfinder - it already handles steps, slopes, doors and diagonals: keep at least
// `distance` from the creeper, walking only (no digging, no placing), for at most timeoutMs.
export async function stepAway(bot, from, { distance = 6, timeoutMs = 2000 } = {}) {
    const pf = (await import('mineflayer-pathfinder')).default;
    const gap = () => (from?.position ? bot.entity.position.distanceTo(from.position) : null);
    const d0 = gap();
    if (d0 === null) return { result: 'blocked', endDistance: null };
    const m = new pf.Movements(bot);
    m.canDig = false; m.allow1by1towers = false; m.scafoldingBlocks = []; m.allowParkour = false; m.maxDropDown = 3;
    bot.pathfinder.setMovements(m);
    bot.pathfinder.setGoal(new pf.goals.GoalInvert(new pf.goals.GoalFollow(from, distance)), true);
    const began = Date.now();
    try {
        while (Date.now() - began < timeoutMs && from.isValid !== false && (gap() ?? distance) < distance) await sleep(50);
    } finally { bot.pathfinder.setGoal(null); bot.clearControlStates(); }
    const end = gap();
    return { result: end === null || end >= distance ? 'opened' : end - d0 < 0.5 ? 'blocked' : 'timeout', endDistance: end };
}
