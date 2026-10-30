// A toss is not a receipt: bind collection to newly spawned matching item entity ids.
import pf from 'mineflayer-pathfinder';

async function stepBackFromDrop(bot, player) {
    const from = bot.entity.position.floored();
    const dx = bot.entity.position.x - player.position.x, dz = bot.entity.position.z - player.position.z;
    if (!dx && !dz) return;
    const target = Math.abs(dx) >= Math.abs(dz) ? from.offset(Math.sign(dx),0,0) : from.offset(0,0,Math.sign(dz));
    const below = bot.blockAt(target.offset(0,-1,0)), feet = bot.blockAt(target), head = bot.blockAt(target.offset(0,1,0));
    if (below?.boundingBox !== 'block' || feet?.boundingBox !== 'empty' || head?.boundingBox !== 'empty') return;
    const moves = new pf.Movements(bot);
    moves.canDig = false;
    moves.allow1by1towers = false;
    moves.allowParkour = false;
    moves.scafoldingBlocks = [];
    const goal = new pf.goals.GoalBlock(target.x,target.y,target.z);
    if (bot.pathfinder.getPathTo(moves,goal,100).status !== 'success') return;
    bot.pathfinder.setMovements(moves);
    const timeout = setTimeout(() => bot.pathfinder.stop(),800);
    try { await bot.pathfinder.goto(goal); } catch { /* receipt remains the success criterion */ }
    finally { clearTimeout(timeout); }
}

// Discard needs more clearance than a hand-off: leave the nearby drops behind, without digging.
export async function stepAwayFromDrops(bot, drops, fallback, distance=2.5) {
    const start = bot.entity.position.floored();
    const live = drops.filter(e => bot.entities?.[e.id]);
    const points = live.length ? live.map(e => e.position) : [fallback];
    const predicted = live.map(e => e.position.offset((e.velocity?.x || 0)*4,0,(e.velocity?.z || 0)*4));
    const horizontal = (a,b) => Math.hypot(a.x-b.x,a.z-b.z);
    const known = p => bot.blockAt(p.offset(0,-1,0))?.boundingBox === 'block'
        && bot.blockAt(p)?.boundingBox === 'empty' && bot.blockAt(p.offset(0,1,0))?.boundingBox === 'empty';
    const moves = new pf.Movements(bot);
    moves.canDig=false;moves.allow1by1towers=false;moves.allowParkour=false;moves.scafoldingBlocks=[];
    const candidates=[];
    for(let dx=-3;dx<=3;dx++) for(let dz=-3;dz<=3;dz++) {
        if(!dx&&!dz||Math.hypot(dx,dz)>3.2)continue;
        const block=start.offset(dx,0,dz), center=block.offset(.5,0,.5);
        const clearance=Math.min(...points.map(p=>horizontal(center,p)),...predicted.map(p=>horizontal(center,p)));
        if(clearance>=distance&&known(block))candidates.push({block,clearance,travel:horizontal(center,bot.entity.position)});
    }
    candidates.sort((a,b)=>a.travel-b.travel||b.clearance-a.clearance);
    const planningEnd=Date.now()+250;
    for(const {block} of candidates) {
        if(Date.now()>planningEnd)break;
        const goal=new pf.goals.GoalBlock(block.x,block.y,block.z);
        const route=bot.pathfinder.getPathTo(moves,goal,80);
        if(route.status!=='success'||route.path.some(p=>p.y!==start.y||!known(start.offset(p.x-start.x,0,p.z-start.z))))continue;
        bot.pathfinder.setMovements(moves);
        const timer=setTimeout(()=>bot.pathfinder.stop(),1400);
        try {await bot.pathfinder.goto(goal);} catch { /* inspect actual clearance below */ }
        finally {clearTimeout(timer);}
        const current=live.filter(e=>bot.entities?.[e.id]).map(e=>e.position);
        const check=current.length?current:points;
        return check.every(p=>horizontal(bot.entity.position,p)>=2);
    }
    return false;
}

export async function tossWithReceipt(bot, player, item, count) {
    const existing = new Set(Object.values(bot.entities || {}).map(e => e.id));
    const origin = bot.entity.position.clone();
    const drops = new Map();
    let tossedAt = null;
    const read = entity => {
        try {
            const stack = entity.getDroppedItem?.();
            return stack?.name === item.name && stack.count > 0 && stack.count <= count ? stack : null;
        } catch { return null; } // metadata is not necessarily present at entitySpawn
    };
    const update = entity => {
        const drop = drops.get(entity.id);
        if (!drop) return;
        drop.entity = entity;
        drop.position = entity.position.clone();
        const stack = read(entity);
        if (stack) { drop.count = stack.count; bot.ignoredItems?.add(entity.id); }
    };
    const spawned = entity => {
        if (existing.has(entity.id) || (tossedAt !== null && Date.now() > tossedAt + 1000)
            || entity.position.distanceTo(origin) > 3) return;
        drops.set(entity.id, { entity, position: entity.position.clone(), count: null, gone: false, firstPickupCount: null, taken: 0, received: 0, otherCollectors: new Set() });
        update(entity);
    };
    // playerCollect omits pickupItemCount. A partial pickup must not count as a whole-stack receipt.
    const collected = packet => {
        const drop = drops.get(packet.collectedEntityId);
        if (!drop) return;
        update(drop.entity);
        const stack = read(drop.entity), count = packet.pickupItemCount;
        if (!stack || !Number.isInteger(count) || count <= 0) return;
        drop.firstPickupCount ??= stack.count;
        drop.taken += count;
        const collector = bot.entities[packet.collectorEntityId];
        if (collector?.id === player.id && collector.username === player.username) drop.received += count;
        else drop.otherCollectors.add(collector?.username || 'another entity');
    };
    const gone = entity => { const drop = drops.get(entity.id); if (drop) drop.gone = true; };
    const summarize = () => {
        const matching = [...drops.entries()].filter(([,d]) => d.taken || (!d.gone && d.count));
        const total = matching.reduce((n,[,d]) => n + (d.firstPickupCount ?? d.count),0);
        const received = matching.reduce((n,[,d]) => n + d.received,0);
        return { total, received, itemIds: matching.map(([id]) => id), ground: matching.filter(([,d]) => !d.gone).map(([,d]) => d.position), collectedBy: [...new Set(matching.flatMap(([,d]) => [...d.otherCollectors]))] };
    };
    bot.on('entitySpawn',spawned);
    bot.on('entityUpdate',update);
    bot.on('itemDrop',update);
    bot._client.on('collect',collected);
    bot.on('entityGone',gone);
    try {
        await bot.toss(item.type,item.metadata,count);
        tossedAt = Date.now();
        // Ignoring a drop in AI pickup logic cannot prevent vanilla proximity pickup by the giver.
        // One observed, non-destructive step leaves room for the intended recipient to collect it.
        await stepBackFromDrop(bot,player);
        while (!bot.interrupt_code && Date.now() - tossedAt <= 4000) {
            for (const drop of drops.values()) if (!drop.gone) update(drop.entity);
            const result = summarize();
            // Allow the one-second spawn/metadata window to close before accepting an unambiguous set.
            if (Date.now() - tossedAt >= 1000 && result.total === count && result.received === count)
                return { ...result, ok: true };
            await new Promise(resolve => setTimeout(resolve,25));
        }
        const result = summarize();
        return { ...result, ok: false, reason: bot.interrupt_code ? 'cancelled' : result.total > count ? 'ambiguous drop identity' : 'receipt unconfirmed' };
    } finally {
        bot.off('entitySpawn',spawned);
        bot.off('entityUpdate',update);
        bot.off('itemDrop',update);
        bot._client.off('collect',collected);
        bot.off('entityGone',gone);
    }
}
