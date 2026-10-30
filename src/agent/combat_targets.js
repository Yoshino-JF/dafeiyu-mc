const names={zombie:'僵尸',husk:'尸壳',drowned:'溺尸',zombie_villager:'僵尸村民',skeleton:'骷髅',creeper:'苦力怕',spider:'蜘蛛',cave_spider:'洞穴蜘蛛',enderman:'末影人'};
const label=t=>`${names[t.name]||t.name}#${t.id}`;
/** Observation counts only; entityHurt is not proof that she caused each hit. */
export function retargetSummary(record){
 const targets=record.targets;if(!Array.isArray(targets)||targets.length<2)return '';
 const sequence=(record.targetSequence||[]).map(label).join('→');
 return `本场转打${record.retargets}次，涉及${targets.length}只；${targets.map(t=>`${label(t)}：挥${t.swings}下、观察到受伤${t.hits}次，${t.targetDead?'已见死亡':'未确认死亡'}`).join('；')}。`
  +(sequence?`目标顺序：${sequence}。`:'')+'受伤次数不保证都由你造成。';
}
export function confirmedThreatText(record){return record.threatTrigger==='confirmed_self_hurt'?`${names[record.threatSource?.name]||record.threatSource?.name||'另一只怪'}实际伤到了你，停下来让你重新决定` : '';}
export function cancellationText(record){return record.reason?.startsWith('action_cancelled')&&typeof record.cancelledBy==='string'&&record.cancelledBy.length?`被 ${record.cancelledBy} 打断`:'';}
