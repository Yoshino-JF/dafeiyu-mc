import { parse } from 'acorn';

const legacy = code => /-?\d{1,5}\s*,\s*-?\d{1,3}\s*,\s*-?\d{1,5}/.test(code)
    || /(?<![\w$.])[xyz]\s*(?:<=|>=|<|>|=)\s*-?\d+(?![\w.])/.test(code);
const finite = n => typeof n === 'number' && Number.isFinite(n);
const point = v => v && ['x','y','z'].every(k => finite(v[k]));
const nameOf = n => n?.type === 'Identifier' ? n.name : n?.type === 'MemberExpression' && !n.computed ? `${nameOf(n.object)}.${n.property.name}` : '';

// Only evaluate numeric constants/objects, never execute the skill to infer its anchor.
function value(n, env) {
    if (!n) return undefined;
    if (n.type === 'Literal') return finite(n.value) ? n.value : undefined;
    if (n.type === 'Identifier') return env.get(n.name);
    if (n.type === 'UnaryExpression') { const v=value(n.argument,env); return finite(v) && ['+','-'].includes(n.operator) ? (n.operator==='-'?-v:v) : undefined; }
    if (n.type === 'BinaryExpression') {
        const a=value(n.left,env),b=value(n.right,env);
        if (!finite(a)||!finite(b)) return undefined;
        const ops={'+':()=>a+b,'-':()=>a-b,'*':()=>a*b,'/':()=>a/b};
        const r=ops[n.operator]?.(); return finite(r)?r:undefined;
    }
    if (n.type === 'ObjectExpression') return Object.fromEntries(n.properties.filter(p=>p.type==='Property'&&!p.computed).map(p=>[p.key.name??p.key.value,value(p.value,env)]));
    if (n.type === 'ArrayExpression') return n.elements.map(e=>value(e,env));
    if (n.type === 'MemberExpression'&&!n.computed) return value(n.object,env)?.[n.property.name];
    if (n.type === 'NewExpression'&&nameOf(n.callee)==='Vec3') return Object.fromEntries(['x','y','z'].map((k,i)=>[k,value(n.arguments[i],env)]));
    return undefined;
}

export function analyzeCoordinates(code) {
    const env=new Map(),candidates=[],partial=[],unsupported=new Set(),calls=new Set();
    let relativeRead=false,spatialUse=false,ast;
    try { ast=parse(String(code),{ecmaVersion:'latest',sourceType:'script',allowAwaitOutsideFunction:true,allowReturnOutsideFunction:true}); }
    catch { return {error:'技能代码无法解析，不能可靠推断坐标',hasCoordinates:legacy(String(code))}; }
    const add=(v,start)=>{if(point(v))candidates.push({at:v,start});else if(v&&['x','y','z'].some(k=>finite(v[k])))partial.push(v);};
    const bind=(pattern,v)=>{
        if(pattern.type==='Identifier')env.set(pattern.name,v);
        else if(pattern.type==='ArrayPattern'&&Array.isArray(v))pattern.elements.forEach((p,i)=>{if(p)bind(p,v[i]);});
    };
    const visit=n=>{
        if(!n||typeof n!=='object')return;
        if(n.type==='VariableDeclarator'&&n.init)bind(n.id,value(n.init,env));
        if(n.type==='ForOfStatement'&&n.left.type==='VariableDeclaration'){
            const v=value(n.right,env);if(Array.isArray(v)&&v.length)bind(n.left.declarations[0].id,v[0]);
        }
        if(n.type==='ObjectExpression') { const v=value(n,env); if(point(v))add(v,n.start); }
        const member=nameOf(n);
        if(member==='bot.entity.position')relativeRead=true;
        if(member.startsWith('bot.pathfinder')||member.startsWith('bot._client')||member.startsWith('bot.world'))unsupported.add(member);
        if(n.type==='CallExpression'){
            const fn=nameOf(n.callee),a=n.arguments;
            if(fn)calls.add(fn);
            if(n.callee.type==='MemberExpression'&&n.callee.property.name==='push'){
                const array=value(n.callee.object,env),v=value(a[0],env);
                if(Array.isArray(array)&&v!==undefined)array.push(v);
            }
            if(fn==='world.getPosition')relativeRead=true;
            const index=({'skills.goToPosition':1,'skills.breakBlockAt':1,'skills.tillAndSow':1,'skills.placeBlock':2})[fn];
            if(index!==undefined||['bot.blockAt','bot.lookAt','bot.findBlock','bot.findBlocks'].includes(fn))spatialUse=true;
            if(index!==undefined)add(Object.fromEntries(['x','y','z'].map((k,i)=>[k,value(a[index+i],env)])),n.start);
            else if(['bot.blockAt','bot.lookAt'].includes(fn))add(value(a[0],env),n.start);
            else if(['bot.findBlock','bot.findBlocks'].includes(fn)){const options=value(a[0],env);if(options?.point)add(options.point,n.start);}
        }
        for(const [key,child]of Object.entries(n))if(!['start','end','type'].includes(key)){
            if(Array.isArray(child))child.forEach(visit);else if(child&&typeof child==='object')visit(child);
        }
    };
    visit(ast);
    candidates.sort((a,b)=>a.start-b.start);
    return {anchor:candidates[0]?.at??null,partial:partial.length>0,relativeRead,unsupported:[...unsupported],calls:[...calls],hasCoordinates:(spatialUse||unsupported.size>0)&&(!!candidates.length||partial.length>0||legacy(String(code)))};
}

export function coordinatePlan(skill, position) {
    const analysis=analyzeCoordinates(skill.code||'');
    if(analysis.error)return {error:analysis.error};
    if(!analysis.hasCoordinates)return {active:false};
    if(!point(skill.at)&&!analysis.anchor&&!analysis.partial&&analysis.relativeRead)return {active:false};
    const anchor=point(skill.at)?skill.at:analysis.anchor;
    if(!anchor)return {error:'这个技能没法平移：没有记录学习位置，代码里的三个坐标轴也无法可靠推断。原样运行会继续作用在代码写死的位置；本次没有运行，请改用相对当前位置的写法。'};
    if(!point(position))return {error:'当前位置未知，不能平移技能，本次没有运行。'};
    if(analysis.unsupported.length)return {error:`这个技能使用了还没适配的坐标接口（${analysis.unsupported.join('、')}），不能可靠平移，本次没有运行。`};
    // Integer translation preserves the block lattice: floor(p - shift) + shift === floor(p).
    const at=Object.fromEntries(['x','y','z'].map(k=>[k,Math.floor(anchor[k])]));
    const shift=Object.fromEntries(['x','y','z'].map(k=>[k,Math.floor(position[k])-at[k]]));
    const anchorInferred=!point(skill.at),text=`(${shift.x},${shift.y},${shift.z})`;
    return {active:true,anchor:at,shift,anchorInferred,calls:analysis.calls,
        note:`按你当前脚下格平移了 ${text} 来跑${anchorInferred?'；锚点是从代码推断的（anchorInferred:true），不是当时脚位的实测记录':''}。技能自己打印的坐标里，三个数一组的（x,y,z）和标了 x=/y=/z= 的已经加上 ${text} 换算成真实位置；只有两个数的（比如 -30,10）分不清是哪两个轴，没有换算，要自己按 ${text} 加上；底层工具回执本来就是真实坐标。平移不能保证新位置的地形与原来相同。`};
}
