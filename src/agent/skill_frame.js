import Vec3 from 'vec3';
import { coordinatePlan } from './skill_coordinates.js';

const point=v=>v&&['x','y','z'].every(k=>Number.isFinite(v[k]));
const botPlain=new Set(['chat','whisper','look','setControlState','getControlState','clearControlStates','equip','unequip','activateItem','deactivateItem','waitForTicks','stopDigging','consume','craft','toss','tossStack','clickWindow','closeWindow','setQuickBarSlot','getEquipmentDestSlot','supportFeature']);
const botObject=new Set(['dig','activateBlock','activateEntity','attack','canDigBlock','canSeeBlock','openContainer','openChest','openFurnace','sleep','mount','placeBlock']);
const botData=new Set(['inventory','registry','heldItem','game','time','controlState']);
const worldPoints=new Set(['getPosition','getNearestFreeSpace']);
const worldObjects=new Set(['getBlockAtPosition','getNearestBlock','getNearestBlocks','getNearestBlocksWhere','getNearbyEntities','getNearestEntityWhere','getNearbyPlayers']);
const worldPlain=new Set(['getSurroundingBlocks','getFirstBlockAboveHead','getInventoryCounts','getCraftableItems','getNearbyEntityTypes','isEntityType','getNearbyPlayerNames','getNearbyBlockTypes','shouldPlaceTorch','getBiomeName','getVillagerProfession','isAlive']);
const skillXYZ={goToPosition:1,breakBlockAt:1,tillAndSow:1,placeBlock:2};
const skillPlain=new Set(['log','craftRecipe','wait','smeltItem','clearNearestFurnace','attackNearest','attackEntity','defendSelf','collectBlock','pickupNearbyItems','equip','discard','putInChest','takeFromChest','viewChest','consume','giveToPlayer','goToNearestBlock','goToNearestEntity','goToPlayer','followPlayer','moveAway','moveAwayFromEntity','bestFood','fleeFromEnemies','avoidEnemies','stay','useDoor','sleepRefusal','goToBed','activateNearestBlock','showVillagerTrades','tradeWithVillager','digDown','goToSurface','useToolOn','useToolOnBlock']);
const botSpatial=new Set(['blockAt','lookAt','findBlock','findBlocks','nearestEntity']);

/** Moves the coordinates written in a text by shift*sign: labelled x/y/z values ("x=4", "\"y\":57") and bare x,y,z triples.
 * sign 1 turns her skill's printed coordinates into real ones; sign -1 turns a run's output back into the skill's own frame for the judge. */
export function moveCoords(text,shift,sign=1){
    const d={x:shift.x*sign,y:shift.y*sign,z:shift.z*sign};
    return text
        .replace(/(["']?)\b([xyz])\1(\s*[:=]\s*)(-?\d+(?:\.\d+)?)/g,(_,q,axis,sep,v)=>`${q}${axis}${q}${sep}${+v+d[axis]}`)
        .replace(/(-?\d+(?:\.\d+)?)(\s*,\s*)(-?\d+(?:\.\d+)?)(\s*,\s*)(-?\d+(?:\.\d+)?)/g,
            (_,x,a,y,b,z)=>`${+x+d.x}${a}${+y+d.y}${b}${+z+d.z}`);
}

/** Per-run views only: no monkey-patch of bot, modules, or shared position objects. */
export function createSkillFrame(skill, bot, {skills,world}) {
    const plan=coordinatePlan(skill,bot.entity?.position);
    if(plan.error||!plan.active)return {...plan,bot,skills,world};
    const missing=plan.calls.filter(call=>{
        const [group,name,...tail]=call.split('.');
        if(group==='bot')return tail.length?!['entity','entities','players','inventory'].includes(name):!botPlain.has(name)&&!botObject.has(name)&&!botSpatial.has(name);
        if(group==='skills')return !skillPlain.has(name)&&skillXYZ[name]===undefined;
        if(group==='world')return !worldPoints.has(name)&&!worldObjects.has(name)&&!worldPlain.has(name)&&name!=='isClearPath';
        return false;
    });
    if(missing.length)return {...plan,error:`这个技能的接口还没适配平移（${missing.join('、')}），原样会作用在原坐标系；本次没有运行。`,bot,skills,world};
    const shift=plan.shift,rawOf=new WeakMap(),pointCache=new WeakMap(),objectCache=new WeakMap();
    const unsupported=name=>{throw Error(`技能平移尚未适配接口 ${name}，已停止；没有按旧坐标继续执行。`);};
    const unwrap=v=>v&&typeof v==='object'?(rawOf.get(v)||v):v;
    const realPoint=p=>{
        if(!point(p))throw TypeError('技能坐标必须是有限的 x/y/z');
        return new Vec3(p.x+shift.x,p.y+shift.y,p.z+shift.z);
    };
    const viewPoint=p=>{
        if(!point(p))return p;
        if(pointCache.has(p))return pointCache.get(p);
        const view=new Proxy(p,{
            get(target,key,receiver){return ['x','y','z'].includes(key)?target[key]-shift[key]:Reflect.get(target,key,receiver);},
            set(target,key,v){target[key]=['x','y','z'].includes(key)?v+shift[key]:v;return true;}
        });
        rawOf.set(view,p);pointCache.set(p,view);return view;
    };
    const viewObject=obj=>{
        if(!obj||typeof obj!=='object')return obj;
        if(Array.isArray(obj))return obj.map(viewObject);
        if(objectCache.has(obj))return objectCache.get(obj);
        const view=new Proxy(obj,{
            get(target,key){
                if(key==='position')return viewPoint(target.position);
                const v=target[key];
                if(typeof v==='function')return (...args)=>viewObject(v.apply(target,args.map(unwrap)));
                return v&&typeof v==='object'&&('position'in v||key==='entity')?viewObject(v):v;
            },
            set(target,key,v){target[key]=key==='position'?realPoint(v):unwrap(v);return true;}
        });
        rawOf.set(view,obj);objectCache.set(obj,view);return view;
    };
    const wrapResult=(value,convert)=>value&&typeof value.then==='function'?value.then(convert):convert(value);
    const findOptions=options=>({...options,
        ...(options?.point?{point:realPoint(options.point)}:{}),
        ...(typeof options?.matching==='function'?{matching:b=>options.matching(viewObject(b))}:{}),
        ...(typeof options?.useExtraInfo==='function'?{useExtraInfo:b=>options.useExtraInfo(viewObject(b))}:{})});
    const callBot=(name,args)=>bot[name](...args);
    const botView=new Proxy(bot,{
        get(target,key){
            if(key==='entity')return viewObject(target.entity);
            if(key==='entities')return new Proxy(target.entities,{get:(all,id)=>viewObject(all[id])});
            if(key==='players')return new Proxy(target.players||{},{get:(all,id)=>viewObject(all[id])});
            if(['_client','pathfinder','world'].includes(key))return unsupported('bot.'+key);
            if(botData.has(key)||typeof target[key]!=='object'&&typeof target[key]!=='function')return target[key];
            if(key==='blockAt'||key==='lookAt')return (p,...rest)=>wrapResult(callBot(key,[realPoint(p),...rest]),viewObject);
            if(key==='findBlock')return options=>wrapResult(callBot(key,[findOptions(options)]),viewObject);
            if(key==='findBlocks')return options=>wrapResult(callBot(key,[findOptions(options)]),positions=>positions.map(viewPoint));
            if(key==='nearestEntity')return predicate=>viewObject(callBot(key,[e=>!predicate||predicate(viewObject(e))]));
            if(botPlain.has(key))return (...args)=>{
                if(key==='chat'&&/^\s*\//.test(String(args[0])))return unsupported('bot.chat(原始游戏命令)');
                return callBot(key,args.map(unwrap));
            };
            if(botObject.has(key))return (...args)=>wrapResult(callBot(key,args.map(unwrap)),viewObject);
            return unsupported('bot.'+String(key));
        },
        set(target,key,v){if(['output','interrupt_code'].includes(key)){target[key]=v;return true;}return unsupported('bot.'+String(key)+'=');}
    });
    rawOf.set(botView,bot);
    const skillView=new Proxy(skills,{
        get(target,name){
            if(typeof target[name]!=='function')return target[name];
            if(!skillPlain.has(name)&&skillXYZ[name]===undefined)return ()=>unsupported('skills.'+name);
            return (...original)=>{
                const args=original.map(unwrap),index=skillXYZ[name];
                if(index!==undefined)for(let i=0;i<3;i++){
                    if(!Number.isFinite(args[index+i]))throw TypeError('技能坐标必须是有限数');
                    args[index+i]+=shift[['x','y','z'][i]];
                }
                // 08:5x she read "ROOF_GAPS:9,66,-19 ..." as old-world coordinates and dropped the result. What HER code prints is in the
                // skill's frame; tool receipts come from the real bot and never pass here, so only these x,y,z triples are moved.
                // 09:1x also labelled values: inspect_wall_gaps printed [{"x":4,"y":57,"z":12}] and the bare-triple rule left them unmoved
                if(name==='log'&&typeof args[1]==='string')args[1]=moveCoords(args[1],shift);
                if(name==='useDoor'&&args[1])args[1]=realPoint(original[1]);
                if(name==='collectBlock'&&args[3])args[3]=original[3].map(realPoint);
                return wrapResult(target[name](...args),viewObject);
            };
        }
    });
    const worldView=new Proxy(world,{
        get(target,name){
            if(typeof target[name]!=='function')return target[name];
            if(!worldPoints.has(name)&&!worldObjects.has(name)&&!worldPlain.has(name)&&name!=='isClearPath')return ()=>unsupported('world.'+name);
            return (...original)=>{
                const args=original.map(unwrap);
                // getBlockAtPosition takes RELATIVE offsets, not world coordinates.
                if(['getNearestBlocksWhere','getNearestEntityWhere'].includes(name)&&typeof args[1]==='function'){
                    const predicate=args[1];args[1]=value=>predicate(viewObject(value));
                }
                if(name==='isClearPath'&&args[1]===original[1]&&point(args[1]?.position))args[1]={...args[1],position:realPoint(args[1].position)};
                const result=target[name](...args);
                return wrapResult(result,worldPoints.has(name)?viewPoint:viewObject);
            };
        }
    });
    return {...plan,bot:botView,skills:skillView,world:worldView};
}
