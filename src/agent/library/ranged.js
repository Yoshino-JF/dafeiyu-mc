import {styleFor,completeStyle,validateStyle,TIMER_MAX} from '../fight_style.js';
// Installed Paper 26.1.2: speed=3 when fully drawn, air drag=.99, gravity=.05.
// Discrete air model only; LIVE traces must still validate the integration order/spread.
import * as actionControl from '../action_manager.js';
import {observedTargetHealth} from './fight.js';
// Vanilla BowItem draw strength, followed by Paper's strength * 3 launch speed.
// Saturation/launch threshold are projectile physics, not style clamping.
export function bowSpeedForTicks(ticks){
 if(!Number.isFinite(ticks)||ticks<0)throw RangeError('Nonnegative finite draw ticks required');
 const u=Math.min(20,Math.floor(ticks))/20,power=Math.min(1,(u*u+2*u)/3);
 return power<.1?0:3*power;
}
export function pathFrom(start,velocity,{steps=100,drag=.99,gravity=.05}={}) {
 let p={...start},v={...velocity};const out=[{...p}];
 for(let i=0;i<steps;i++){p={x:p.x+v.x,y:p.y+v.y,z:p.z+v.z};out.push(p);v={x:v.x*drag,y:v.y*drag-gravity,z:v.z*drag};}
 return out;
}
function heightAt(distance,pitch,speed) {
 const path=pathFrom({x:0,y:0,z:0},{x:speed*Math.cos(pitch),y:speed*Math.sin(pitch),z:0});
 for(let i=1;i<path.length;i++)if(path[i].x>=distance){const f=(distance-path[i-1].x)/(path[i].x-path[i-1].x);return {height:path[i-1].y+(path[i].y-path[i-1].y)*f,ticks:i-1+f};}
 return null;
}
export function solveShot(origin,target,speed=3) {
 if(![origin.x,origin.y,origin.z,target.x,target.y,target.z,speed].every(Number.isFinite)||speed<=0)throw TypeError('Finite positive projectile data required');
 const dx=target.x-origin.x,dz=target.z-origin.z,d=Math.hypot(dx,dz),dy=target.y-origin.y;
 if(d<.1)throw RangeError('Too close for the flat-range lab');
 let previous=null;
 for(let i=0;i<=280;i++){
  const pitch=(-70+i*.5)*Math.PI/180,value=heightAt(d,pitch,speed);if(!value)continue;
  const error=value.height-dy;
  if(previous&&previous.error<=0&&error>=0){let a=previous.pitch,b=pitch;for(let j=0;j<40;j++){const m=(a+b)/2;if(heightAt(d,m,speed).height<dy)a=m;else b=m;}const result=(a+b)/2;return {yaw:Math.atan2(-dx,-dz),pitch:result,flightTicks:heightAt(d,result,speed).ticks,speed};}
  previous={pitch,error};
 }
 return null;
}
// Owner 10-28: a skeleton in a cave under her - she aimed down through the ground and both arrows stuck at her feet. solveShot only says
// the bow reaches that far; this walks the arrow's real arc (or a straight line) in 0.25-block steps and returns the first solid block
// on it before the target, or null when the way is open.
const solidAt=(bot,p)=>{const b=bot.blockAt?.(new p.constructor(Math.floor(p.x),Math.floor(p.y),Math.floor(p.z)));return b&&b.boundingBox==='block'?b:null;};
export function firstBlockOnArc(bot,origin,aim,speed,target){
 const v={x:-Math.sin(aim.yaw)*Math.cos(aim.pitch)*speed,y:Math.sin(aim.pitch)*speed,z:-Math.cos(aim.yaw)*Math.cos(aim.pitch)*speed};
 const path=pathFrom({x:origin.x,y:origin.y,z:origin.z},v,{steps:Math.ceil(aim.flightTicks)+2});
 const reach=Math.hypot(target.x-origin.x,target.z-origin.z);
 for(let i=1;i<path.length;i++){const a=path[i-1],b=path[i],n=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z)/.25));
  for(let k=1;k<=n;k++){const p=origin.offset(a.x+(b.x-a.x)*k/n-origin.x,a.y+(b.y-a.y)*k/n-origin.y,a.z+(b.z-a.z)*k/n-origin.z);
   if(Math.hypot(p.x-origin.x,p.z-origin.z)>=reach-.4||p.distanceTo(target)<.6)return null;
   const hit=solidAt(bot,p);if(hit)return hit;}}
 return null;
}
export function firstBlockOnLine(bot,from,to){
 const n=Math.max(1,Math.ceil(from.distanceTo(to)/.25));
 for(let k=1;k<n;k++){const p=from.offset((to.x-from.x)*k/n,(to.y-from.y)*k/n,(to.z-from.z)*k/n);if(p.distanceTo(to)<.6)return null;const hit=solidAt(bot,p);if(hit)return hit;}
 return null;
}
export function segmentBox(a,b,box) {
 let lo=0,hi=1;
 for(const [key,min,max]of [['x',box.min.x,box.max.x],['y',box.min.y,box.max.y],['z',box.min.z,box.max.z]]){const d=b[key]-a[key];if(Math.abs(d)<1e-10){if(a[key]<min||a[key]>max)return false;continue;}const x=(min-a[key])/d,y=(max-a[key])/d;lo=Math.max(lo,Math.min(x,y));hi=Math.min(hi,Math.max(x,y));if(lo>hi)return false;}
 return true;
}
export function incomingArrow(position,velocity,player) {
 const box={min:{x:player.x-.3,y:player.y,z:player.z-.3},max:{x:player.x+.3,y:player.y+1.8,z:player.z+.3}},path=pathFrom(position,velocity,{steps:30});
 return path.slice(1).some((point,i)=>segmentBox(path[i],point,box));
}
export function bowOutcome({beforeHp,afterHp,dead=false,arrowsSpent,targetUuid,observedUuid}) {
 if(!targetUuid||targetUuid!==observedUuid||arrowsSpent!==1||!Number.isFinite(beforeHp)||!dead&&!Number.isFinite(afterHp))return {valid:false,hit:null,reason:'missing_or_mismatched_evidence'};
 return {valid:true,hit:dead||afterHp<beforeHp,reason:dead?'target_death_observed':'native_target_health'};
}
export function shieldOutcome({incoming,damageTaken,wear,blockSignal=false}) {
 if(!Number.isFinite(damageTaken)||!Number.isFinite(wear))return {valid:false,blocked:null,reason:'missing_measurement'};
 const valid=damageTaken>0||wear>0||!!blockSignal;
 return {valid,blocked:valid&&damageTaken===0&&(wear>0||blockSignal),reason:valid?'damage_or_block_evidence':incoming?'prediction_only_needs_confirmation':'arrow_miss_or_unknown'};
}

const holders=new WeakMap();
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const ammoCount=bot=>bot.inventory.items().filter(x=>['arrow','spectral_arrow','tipped_arrow'].includes(x.name)).reduce((n,x)=>n+x.count,0);
function ownership(bot,kind){
 const previous=holders.get(bot);previous?.release();
 const owner={kind,using:false,released:false,release:null};holders.set(bot,owner);
 const owns=()=>holders.get(bot)===owner;
 const cancelled=()=>!owns()||bot.interrupt_code||actionControl.isCancelledAction(bot);
 owner.release=()=>{
  if(!owns())return;
  if(owner.using){
   // Releasing a drawn bow fires it. A cancelled draw instead changes hotbar
   // slot before the next action starts; never fire a fresh arrow as cleanup.
   if(kind==='bow'&&!owner.released)bot.setQuickBarSlot((bot.quickBarSlot+1)%9);
   else if(kind==='shield'||bot.usingHeldItem)bot.deactivateItem();
   owner.using=false;
  }
  holders.delete(bot);
 };
 const unregister=actionControl.onActionCancel?.(bot,owner.release);
 return {owner,owns,cancelled,close(){owner.release();if(typeof unregister==='function')unregister();}};
}
async function bounded(promise,cancelled,deadline){
 let done=false,error,value;Promise.resolve(promise).then(x=>{value=x;done=true;},e=>{error=e;done=true;});
 await Promise.resolve();while(!done&&!cancelled()&&Date.now()<deadline)await wait(20);
 if(error)throw error;return done&&!cancelled()?{ok:true,value}:{ok:false};
}

/** One draw/release only. Facts are observations, not a guarantee of damage attribution. */
export async function shoot(bot,target,{lead,timeoutMs,style=null}={}){
    const cfg=validateStyle(completeStyle(target?.name,style||styleFor(target?.name,bot.username)));
    lead??=cfg.lead;timeoutMs??=cfg.shotBudgetMs;
 if(!Number.isFinite(lead))throw RangeError('lead must be finite');
 if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw RangeError('Positive finite shot timeout required');
 const began=Date.now(),deadline=began+timeoutMs,before=observedTargetHealth(bot,target),ammoBefore=ammoCount(bot);
 let ticks=0,dead=false,aim=null,releasedAt=null,projectile=null,hurtAt=null,drawStartTick=null,drawnTicks=null,launchSpeed=null;
 const same=e=>e===target||e?.id===target?.id&&!!target?.uuid&&e.uuid===target.uuid;
 const result=(status,reason)=>({result:status,reason,target:{name:target?.name??null,id:target?.id??null},lead,aim,drawTicksObserved:drawnTicks??(drawStartTick===null?null:ticks-drawStartTick),drawTickMeaning:'client_physics_ticks_not_server_confirmation',initialSpeedPredicted:launchSpeed,targetHpBefore:before,targetHpAfter:dead?(observedTargetHealth(bot,target)===0?0:null):observedTargetHealth(bot,target),targetDeathObserved:dead,arrowsSpent:ammoBefore-ammoCount(bot),releaseSent:releasedAt!==null,releasedAt,flightMs:releasedAt!==null&&hurtAt!==null?hurtAt-releasedAt:null,flightTimingEvidence:hurtAt===null?null:'target_hurt_event_network_timing',observationMsSinceRelease:releasedAt===null?null:Date.now()-releasedAt,projectile,seconds:(Date.now()-began)/1000});
 if(!target?.position||bot.entities?.[target.id]!==target)return result('refused','target_not_observed');
 const bow=bot.heldItem?.name==='bow'?bot.heldItem:bot.inventory.items().find(x=>x.name==='bow');
 if(!bow||ammoBefore<1)return result('refused',bow?'no_arrow':'no_bow');
 const plannedSpeed=bowSpeedForTicks(cfg.bowDrawTicks+1);
 if(plannedSpeed===0)return result('refused','draw_below_launch_threshold');
 const scope=ownership(bot,'bow'),{owner,cancelled}=scope;
 const onTick=()=>ticks++,onDead=e=>{if(same(e))dead=true;},onSpawn=e=>{if(releasedAt!==null&&e.name==='arrow'&&!projectile)projectile={id:e.id,uuid:e.uuid,position:{...e.position},velocity:{...e.velocity}};};
 const onHurt=e=>{if(same(e)&&releasedAt!==null&&hurtAt===null)hurtAt=Date.now();};
 bot.on('physicsTick',onTick);bot.on('entityDead',onDead);bot.on('entitySpawn',onSpawn);bot.on('entityHurt',onHurt);
 try{
  if(!await bounded(bot.equip(bow,'hand'),cancelled,Math.min(deadline,Date.now()+1500)).then(x=>x.ok))return result(cancelled()?'interrupted':'timeout','equip_incomplete');
  const origin=bot.entity.position.offset(0,(bot.entity.eyeHeight||1.62)-.1,0);
  let point=target.position.offset(0,(target.height||1.8)*cfg.aimHeightRatio,0);aim=solveShot(origin,point,plannedSpeed);
  if(!aim)return result('refused','no_air_trajectory');
  if(lead&&target.velocity){
   point=point.offset(target.velocity.x*aim.flightTicks*lead,target.velocity.y*aim.flightTicks*lead,target.velocity.z*aim.flightTicks*lead);
   if(![point.x,point.y,point.z].every(Number.isFinite)){aim=null;return result('refused','predicted_point_not_finite');}
   aim=solveShot(origin,point,plannedSpeed);
  }
  if(!aim)return result('refused','no_predicted_trajectory');
  {const wall=firstBlockOnArc(bot,origin,aim,plannedSpeed,point);if(wall){const r=result('refused','blocked_path');r.blockedBy=wall.name;r.blockedAt={x:wall.position.x,y:wall.position.y,z:wall.position.z};return r;}}
  if(!await bounded(bot.look(aim.yaw,aim.pitch,true),cancelled,Math.min(deadline,Date.now()+300)).then(x=>x.ok))return result(cancelled()?'interrupted':'timeout','aim_incomplete');
  if(cancelled())return result('interrupted','cancelled_before_draw');
  bot.activateItem(false);owner.using=true;const startTick=ticks,drawAt=Date.now();drawStartTick=startTick;
  while(ticks-startTick<cfg.bowDrawTicks||Date.now()-drawAt<cfg.bowDrawTicks*50){if(cancelled())return result('interrupted','draw_cancelled');if(Date.now()>deadline)return result('timeout','draw_deadline');await wait(20);}
  if(cancelled()||bot.entities?.[target.id]!==target)return result(cancelled()?'interrupted':'lost','target_or_owner_changed');
  // The target can move during the 1.2-second draw. Re-read BOTH positions and
  // velocity immediately before release, rather than firing at the old point.
  const releaseOrigin=bot.entity.position.offset(0,(bot.entity.eyeHeight||1.62)-.1,0);
  // The required following physics tick also holds the bow. Predict that tick,
  // then recheck below in case an awaited aim took longer than one tick.
  const releaseSpeed=bowSpeedForTicks(ticks-startTick+1);
  let releasePoint=target.position.offset(0,(target.height||1.8)*cfg.aimHeightRatio,0);aim=solveShot(releaseOrigin,releasePoint,releaseSpeed);
  if(aim&&lead&&target.velocity){
   releasePoint=releasePoint.offset(target.velocity.x*(aim.flightTicks+1)*lead,target.velocity.y*(aim.flightTicks+1)*lead,target.velocity.z*(aim.flightTicks+1)*lead);
   if(![releasePoint.x,releasePoint.y,releasePoint.z].every(Number.isFinite)){aim=null;return result('refused','predicted_point_not_finite');}
   aim=solveShot(releaseOrigin,releasePoint,releaseSpeed);
  }
  if(!aim)return result('refused','no_release_trajectory');
  {const wall=firstBlockOnArc(bot,releaseOrigin,aim,releaseSpeed,releasePoint);if(wall){const r=result('refused','blocked_path');r.blockedBy=wall.name;r.blockedAt={x:wall.position.x,y:wall.position.y,z:wall.position.z};return r;}}
  if(!await bounded(bot.look(aim.yaw,aim.pitch,true),cancelled,Math.min(deadline,Date.now()+300)).then(x=>x.ok))return result(cancelled()?'interrupted':'timeout','release_aim_incomplete');
  const aimedTick=ticks;
  while(ticks===aimedTick){if(cancelled())return result('interrupted','cancelled_before_release');if(Date.now()>deadline)return result('timeout','release_tick_deadline');await wait(20);}
  while(aim.speed!==bowSpeedForTicks(ticks-startTick)){
   if(cancelled())return result('interrupted','cancelled_before_release');
   if(Date.now()>=deadline)return result('timeout','release_aim_deadline');
   if(bot.entities?.[target.id]!==target)return result('lost','target_or_owner_changed');
   const speedNow=bowSpeedForTicks(ticks-startTick),originNow=bot.entity.position.offset(0,(bot.entity.eyeHeight||1.62)-.1,0);
   let pointNow=target.position.offset(0,(target.height||1.8)*cfg.aimHeightRatio,0);aim=solveShot(originNow,pointNow,speedNow);
   if(aim&&lead&&target.velocity){
    pointNow=pointNow.offset(target.velocity.x*(aim.flightTicks+1)*lead,target.velocity.y*(aim.flightTicks+1)*lead,target.velocity.z*(aim.flightTicks+1)*lead);
    if(![pointNow.x,pointNow.y,pointNow.z].every(Number.isFinite)){aim=null;return result('refused','predicted_point_not_finite');}
    aim=solveShot(originNow,pointNow,speedNow);
   }
   if(!aim)return result('refused','no_release_trajectory');
   if(!await bounded(bot.look(aim.yaw,aim.pitch,true),cancelled,Math.min(deadline,Date.now()+300)).then(x=>x.ok))return result(cancelled()?'interrupted':'timeout','release_aim_incomplete');
  }
  if(cancelled())return result('interrupted','cancelled_before_release');
  if(bot.entities?.[target.id]!==target)return result('lost','target_or_owner_changed');
  drawnTicks=ticks-startTick;launchSpeed=bowSpeedForTicks(drawnTicks);
  releasedAt=Date.now();owner.released=true;bot.deactivateItem();owner.using=false;
  const until=Math.min(deadline,releasedAt+Math.max(600,aim.flightTicks*50+300));
  while(Date.now()<until&&!cancelled()&&!dead)await wait(20);
  return result(cancelled()?'interrupted':'released',cancelled()?'cancelled_after_release':'single_release_observed');
 }finally{scope.close();bot.removeListener('physicsTick',onTick);bot.removeListener('entityDead',onDead);bot.removeListener('entitySpawn',onSpawn);bot.removeListener('entityHurt',onHurt);}
}

/** Hold only; facing, duration and whether to use a shield are the caller's choice. */
export async function raiseShield(bot,seconds,{style=null,mob='_all'}={}){
    const cfg=validateStyle(completeStyle(mob,style||styleFor(mob,bot.username)));
    seconds??=cfg.shieldHoldMs/1000;
 if(!Number.isFinite(seconds)||seconds<=0||seconds>TIMER_MAX/1000)throw RangeError('Positive shield duration within timer capacity required');
 const held=bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')];
 const began=Date.now(),shield=held?.name==='shield'?held:bot.inventory.items().find(x=>x.name==='shield');
 if(!shield)return {result:'refused',reason:'no_shield',seconds:0};
 const scope=ownership(bot,'shield'),{owner,cancelled}=scope;
 const equipped=()=>bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')];
 const wear=()=>Number.isFinite(equipped()?.durabilityUsed)?equipped().durabilityUsed:null;
 let startHp=bot.health,startWear=null,heldAt=null,useObserved=false,ended=false,releasedEarly=false;
 const onEnd=()=>{ended=true;};bot.on('end',onEnd);
 const flagIndex=bot.registry?.entitiesByName?.player?.metadataKeys?.indexOf('living_entity_flags')??-1;
 const serverUsing=()=>{const flags=flagIndex>=0?bot.entity?.metadata?.[flagIndex]:undefined;return Number.isFinite(flags)?(flags&3)===3:null;};
 try{
  if(!await bounded(bot.equip(shield,'off-hand'),cancelled,Date.now()+1500).then(x=>x.ok))return {result:cancelled()?'interrupted':'timeout',reason:'equip_incomplete',seconds:(Date.now()-began)/1000};
  if(cancelled())return {result:'interrupted',reason:'cancelled_before_raise',seconds:(Date.now()-began)/1000};
  startWear=wear();startHp=bot.health;bot.activateItem(true);owner.using=true;heldAt=Date.now();
  while(Date.now()-heldAt<seconds*1000){
   if(cancelled()||ended)break;
   const using=serverUsing();if(using===true)useObserved=true;
   // Mineflayer clears usingHeldItem for ANY entity_status packet, including
   // unrelated permission/status packets. That local flag cannot prove release.
   if(equipped()?.name!=='shield'||useObserved&&using===false){releasedEarly=true;break;}
   await wait(20);
  }
  return {result:cancelled()||ended?'interrupted':releasedEarly?'released_early':useObserved?'held':'unconfirmed',reason:ended?'connection_ended':releasedEarly?'server_use_ended':useObserved?'use_window_ended':'server_use_not_observed',useObserved,seconds:(Date.now()-began)/1000,heldSeconds:(Date.now()-heldAt)/1000,startHp,endHp:bot.health,wearBefore:startWear,wearAfter:wear()};
 }finally{bot.removeListener('end',onEnd);scope.close();}
}
