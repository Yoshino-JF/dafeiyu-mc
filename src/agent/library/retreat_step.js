// Pure observed steering shared by public retreat and in-encounter evasion.
// No keys, ownership, timers, or action starts happen in this module.
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
export function selectRetreatStep(position,from,canWalk,{others=[],policy={}}={}) {
    const dx=from.x-position.x,dz=from.z-position.z,n=Math.hypot(dx,dz),attempted=[];
    if(n<.001)return {plan:null,attempted,reason:'no_horizontal_direction'};
    const ux=dx/n,uz=dz/n;
    // owner 10-29 ("可以被炸，但完全不动"): twice at her house door the dodge found back, left and right all "blocked" and she stood
    // still until the blast - the lanes only took level ground, and the diagonals were never tried. A step down of one block (no fall
    // damage) and the two back diagonals are lanes too.
    const r2=Math.SQRT1_2;
    const options=
        [{name:'back',x:-ux,z:-uz,input:{back:true}},
            {name:'back_jump',x:-ux,z:-uz,jump:true,input:{back:true,jump:true}},
            {name:'back_down',x:-ux,z:-uz,down:true,input:{back:true}},
            {name:'back_left',x:(-ux+uz)*r2,z:(-uz-ux)*r2,input:{back:true,left:true}},
            {name:'back_right',x:(-ux-uz)*r2,z:(-uz+ux)*r2,input:{back:true,right:true}},
            {name:'back_left_down',x:(-ux+uz)*r2,z:(-uz-ux)*r2,down:true,input:{back:true,left:true}},
            {name:'back_right_down',x:(-ux-uz)*r2,z:(-uz+ux)*r2,down:true,input:{back:true,right:true}},
            {name:'left',x:uz,z:-ux,input:{left:true}},
            {name:'right',x:-uz,z:ux,input:{right:true}},
            {name:'left_down',x:uz,z:-ux,down:true,input:{left:true}},
            {name:'right_down',x:-uz,z:ux,down:true,input:{right:true}}];
    for(const option of options) {
        if(option.jump&&policy.retreatJump===false)continue;
        if(/left|right/.test(option.name)&&!/^back_/.test(option.name)&&policy.retreatStrafe===false)continue;
        let reason=null;
        if(!canWalk(option.x,option.z,option.down?'down':!!option.jump))reason='unsafe_lane';
        else if(others.length)for(const t of [.35,.7,1.1]) {
            // Do not count a predicted jump height as already-separated danger.
            const next={x:position.x+option.x*t,y:position.y,z:position.z+option.z*t};
            const dy=policy.retreatHostileDy??3,clearance=policy.retreatHostileClearance??2;
            const toward=others.find(e=>e.position&&(dy===0?Math.abs(e.position.y-position.y)<1e-9:Math.abs(e.position.y-position.y)<dy)&&distance(next,e.position)<Math.min(clearance,distance(position,e.position))-.05);
            if(toward){reason='toward_hostile';break;}
        }
        attempted.push({direction:option.name,reason:reason||'chosen'});
        if(!reason)return {plan:option,attempted,reason:null};
    }
    return {plan:null,attempted,reason:'no_observed_lane'};
}

export function escapeSummary(info) {
    if(!info)return '';
    const mobNames={creeper:'苦力怕',zombie:'僵尸',skeleton:'骷髅',drowned:'溺尸',spider:'蜘蛛',husk:'尸壳',stray:'流浪者'};
    const direction=p=>!p?'位置未知':`${p.dx>=0?'东':'西'}${Math.abs(p.dx).toFixed(1)}、${p.dz>=0?'南':'北'}${Math.abs(p.dz).toFixed(1)}、高差${p.dy.toFixed(1)}格`;
    const c=info.creeper;
    const where=c?`苦力怕在${direction(c.relative)}，相距${c.distance.toFixed(1)}格，${c.fuse?'已观察到引信点燃':'未观察到引信点燃'}`:'苦力怕已不在有效观测中';
    const others=info.others.filter(e=>e.distance<=8&&Math.abs(e.relative.dy)<=3).sort((a,b)=>a.distance-b.distance).slice(0,3).map(e=>`${mobNames[e.name]||e.name}在${direction(e.relative)}，相距${e.distance.toFixed(1)}格`).join('；')||'没有其他已观测近敌';
    const tried=[...new Set(info.attempted.map(x=>({back:'后退',back_jump:'后退跳',left:'左移',right:'右移'})[x.direction]||x.direction))].join('、')||'未发出退步';
    const result=info.outcome==='escape_blocked'?'退路被挡，没退开':info.outcome==='escape_budget'?`${(info.budgetMs??2000)/1000}秒预算已到，没确认退开`:info.outcome==='opened'?'已观察到拉开距离并交回原战斗':info.outcome==='source_gone'?'避让源已消失，重新核对原战斗':info.outcome==='disabled'?'已按你的模式开关停止爆炸避让':'避让被中断';
    const takeover=info.events.some(e=>e.type==='creeper_dodge_takeover')?'；已观察到点燃，身体在同一控制权下执行爆炸避让':'';
    return `短避让：${result}。${where}；${others}。试过${tried}${takeover}。`;
}
