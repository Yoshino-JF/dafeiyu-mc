import fs from 'node:fs';
import path from 'node:path';
import Vec3 from 'vec3';
import {loadProtections} from '../protect.js';
import {actLogged} from '../dafeiyu_log.js';

export const houseCatalog=JSON.parse(fs.readFileSync(new URL('./house-assets/catalog.json',import.meta.url),'utf8'));
const say=(bot,text)=>{bot.output=(bot.output||'')+text+'\n';};
export function selectHouse(style='plains'){
 const s=String(style).replace(/^minecraft:/,'');
 // owner 10-28: the small houses have a 2x3 / 3x3 room and the bed blocks her way - the vanilla medium and big village houses are offered too
 const sized=s.match(/^(plains|desert|savanna|snowy|taiga)_(medium|big)(?:_(\d+))?$/);
 const id=s==='igloo_basement'?'igloo/bottom':s.startsWith('village/')||s==='igloo/bottom'?s:sized?`village/${sized[1]}/houses/${sized[1]}_${sized[2]}_house_${sized[3]||1}`:`village/${s.replace(/_\d+$/,'')}/houses/${s.replace(/_(\d+)$/,'_small_house_$1').replace(/^(plains|desert|savanna|snowy|taiga)$/,'$1_small_house_1')}`;
 // 10-31 release test (dev/claude-bed-walk-test.mjs): in these two no bed is in the room behind the door, and at night she reached a
 // bed from outside without using the door - not offered
 if(['village/snowy/houses/snowy_small_house_3','village/desert/houses/desert_medium_house_2'].includes(id))throw Error(`The ${s} house is not offered: its beds are not in the room behind its door. Choose another style.`);
 if(!houseCatalog[id])throw Error('Unknown house style. Use plains, desert, savanna, snowy, taiga (small), e.g. plains_2, or a bigger one: plains_medium, plains_medium_2, plains_big, taiga_medium_3, snowy_medium_2 ...');
 return houseCatalog[id];
}
export function overlapsProtected(areas,box){return areas.some(a=>{const r=a.radius,c=a.center;return c.x+r>=box.min.x&&c.x-r<=box.max.x&&c.y+r>=box.min.y&&c.y-r<=box.max.y&&c.z+r>=box.min.z&&c.z-r<=box.max.z;});}
function block(bot,p){return bot.blockAt(new Vec3(p.x,p.y,p.z),false);}
// 2026-10-26 (owner: "她似乎把房子放到地下了"): the house took her foot height, and she is often in a pit or a tunnel she dug - so it
// was carved into the ground with the earth still over the roof. Where she stands still picks the spot (x, z); the height is now the
// open ground there: scan the loaded column from the actual world top, not a window that may end inside a mountain.
const NOT_GROUND=/leaves|_log$|_wood$|_stem$|hyphae|mushroom_block|vine|bamboo|sugar_cane|cactus|flower|grass$|fern|bush|snow$|torch|sapling/;
function surfaceColumn(bot,x,z,worldMin,worldMax){
 let obstructionTop=null;
 for(let y=worldMax;y>=worldMin;y--){const b=block(bot,{x,y,z});if(!b)return null;const solid=b.boundingBox==='block'||/water|lava/.test(b.name);if(solid&&obstructionTop===null)obstructionTop=y;if(solid&&!NOT_GROUND.test(b.name))return {ground:y,obstructionTop};}
 return null;
}
export function groundHeight(bot,x,z,_fromY,worldMin,worldMax){return surfaceColumn(bot,x,z,worldMin,worldMax)?.ground??null;}
export function planHouse(bot,style,options={}){
 const template=selectHouse(style),p=bot.entity.position;
 const worldMin=bot.game.minY??-64,worldMax=worldMin+(bot.game.height??384)-1;
 const origin={x:Math.floor(p.x)+3,y:Math.floor(p.y),z:Math.floor(p.z)+2};
 const grounds=[];let obstructionTop=worldMin;
 if(!options.here){for(let x=origin.x;x<origin.x+template.size[0];x++)for(let z=origin.z;z<origin.z+template.size[2];z++){const surface=surfaceColumn(bot,x,z,worldMin,worldMax);if(!surface)throw Error('No observed ground surface in a footprint column (unloaded terrain or void). Load the area or choose observed ground, then retry.');grounds.push(surface.ground);obstructionTop=Math.max(obstructionTop,surface.obstructionTop);}
 grounds.sort((a,b)=>a-b);origin.y=grounds[Math.floor(grounds.length/2)]+1;}
 const max={x:origin.x+template.size[0]-1,y:origin.y+template.size[1]-1,z:origin.z+template.size[2]-1};
 if(origin.y<worldMin+1||max.y>worldMax)throw Error('House would exceed the world build height. Choose a different elevation.');
 let floor=origin.y-1;
 for(let x=origin.x;x<=max.x;x++)for(let z=origin.z;z<=max.z;z++){
  let support=null;
  for(let y=origin.y-1;y>=Math.max(worldMin,origin.y-32);y--){const b=block(bot,{x,y,z});if(b&&b.boundingBox==='block'&&!b.name.includes('leaves')){support=y;break;}}
  floor=Math.min(floor,support===null?Math.max(worldMin,origin.y-8):support);
 }
 const clearTop=Math.min(worldMax,Math.max(max.y+4,obstructionTop));
 return {template,origin,here:Boolean(options.here),roofY:max.y,clearTop,box:{min:{x:origin.x,y:floor,z:origin.z},max:{...max,y:clearTop}},floor};
}
function command(bot,text,accept){return new Promise((resolve,reject)=>{
 let timer;
 const done=(error,value)=>{clearTimeout(timer);bot.removeListener('messagestr',message);if(error)reject(error);else resolve(value);};
 const message=(line)=>{if(accept(String(line)))done(null,String(line));else if(/Unknown or incomplete command|do not have permission|not allowed|position is not loaded|outside of the world|Too many blocks|not a valid/i.test(line))done(Error(String(line)));};
 bot.on('messagestr',message);timer=setTimeout(()=>done(Error('House command had no server receipt: '+text.split(' ').slice(0,2).join(' '))),5000);
 try{bot.chat(text);}catch(e){done(e);}
});}
function checkSite(bot,plan){
 if(bot.interrupt_code)throw Error('House building interrupted. The cleared/placed parts remain at the chosen site.');
 if(overlapsProtected(loadProtections(bot.username),plan.box))throw Error('protected: house or foundation overlaps a player-protected area. Choose another place.');
 for(const e of Object.values(bot.entities||{}))if(e.type==='player'&&e!==bot.entity){const p=e.position,b=plan.box;if(p.x>=b.min.x-1&&p.x<=b.max.x+2&&p.y>=b.min.y&&p.y<=b.max.y+2&&p.z>=b.min.z-1&&p.z<=b.max.z+2)throw Error('A player is inside the building footprint. Ask them to step outside before building.');}
}
const material=n=>/(_log|_wood|_planks|_stem|_hyphae)$/.test(n)||['stone','cobblestone','cobbled_deepslate','deepslate','sandstone','red_sandstone'].includes(n);
async function build(bot,style='plains',options={}){
 let plan;
 try{
  plan=planHouse(bot,style,options);checkSite(bot,plan);const {origin:o,box:{max:m},template:t}=plan;
  // Loaded geometry is needed for honest post-placement checks; loading never changes her choice of site.
  const until=Date.now()+5000;while(!block(bot,m)&&Date.now()<until){if(bot.interrupt_code)throw Error('House building interrupted');await new Promise(r=>setTimeout(r,100));}
  checkSite(bot,plan);
  const fill=(y1,y2,name)=>command(bot,`/fill ${o.x} ${y1} ${o.z} ${m.x} ${y2} ${m.z} minecraft:${name}`,s=>/filled|fill|blocks|changed/i.test(s));
  const step=Math.max(1,Math.floor(32768/(t.size[0]*t.size[2])));
  // The protection box includes every cleared cell, including high cliffs/canopies over the roof.
  for(let y=o.y;y<=plan.clearTop;y+=step){checkSite(bot,plan);await fill(y,Math.min(plan.clearTop,y+step-1),'air');}
  checkSite(bot,plan);
  // Split tall foundations to stay within the server's native fill volume limit.
  for(let y=plan.floor;y<o.y;y+=step){checkSite(bot,plan);await fill(y,Math.min(o.y-1,y+step-1),'cobblestone');}
  checkSite(bot,plan);
  await command(bot,`/place template ${t.id} ${o.x} ${o.y} ${o.z}`,s=>s.includes('Loaded template "'+t.id+'" at '));
  // 2026-10-28 house test: /place template leaves each template's jigsaw blocks (unbreakable; one stood in front of a savanna door) - the
  // catalog's cleanup turns every one into the block the template names for it (why:'jigsaw'), with its block state.
  for(const fix of t.cleanup||[]){checkSite(bot,plan);await command(bot,`/setblock ${o.x+fix.pos[0]} ${o.y+fix.pos[1]} ${o.z+fix.pos[2]} minecraft:${fix.name}${fix.state||''}`,s=>/Changed the block|Could not set the block|already/i.test(s));}
  let matches=false;const end=Date.now()+4000;
  while(Date.now()<end){matches=[...t.anchors,...(t.cleanup||[])].every(a=>block(bot,{x:o.x+a.pos[0],y:o.y+a.pos[1],z:o.z+a.pos[2]})?.name===a.name);if(matches)break;await new Promise(r=>setTimeout(r,100));}
  if(!matches)throw Error('Template command returned, but the house blocks have not been confirmed. Do not claim it is built.');
  let remaining=t.materialBudget,paid=0;
  for(const item of bot.inventory.items().filter(i=>material(i.name))){if(!remaining)break;checkSite(bot,plan);const n=Math.min(item.count,remaining);await command(bot,`/clear @s minecraft:${item.name} ${n}`,s=>/Removed|removed|No items|no items|found/i.test(s));remaining-=n;paid+=n;}
  const home={style:t.id,origin:o,entry:{x:o.x+t.entry[0],y:o.y+t.entry[1],z:o.z+t.entry[2]},here:plan.here,size:t.size,foundationY:plan.floor,paid,subsidized:t.materialBudget-paid,at:new Date().toISOString()};
  // owner 10-28 (new save, screenshot): the receipt named the corner (o) and she took that pillar outside as "home". The door and the first
  // cell inside it (room to stand, a roof over it, within the house) are found and said; "home" points inside.
  {const max={x:o.x+t.size[0]-1,y:o.y+t.size[1]-1,z:o.z+t.size[2]-1},inBox=c=>c.x>=o.x&&c.x<=max.x&&c.z>=o.z&&c.z<=max.z;
   const free=c=>{const b=block(bot,c);return b&&b.boundingBox!=='block'&&!/_door$/.test(b.name);};
   const roofed=c=>{for(let y=c.y+2;y<=max.y+1;y++){const b=block(bot,{x:c.x,y,z:c.z});if(b&&b.boundingBox==='block')return true;}return false;};
   let door=null;for(let x=o.x;x<=max.x&&!door;x++)for(let y=o.y;y<=max.y&&!door;y++)for(let z=o.z;z<=max.z&&!door;z++){const b=block(bot,{x,y,z});if(b&&/_door$/.test(b.name)&&b.getProperties?.().half!=='upper')door={x,y,z};}
   // a roofed porch is on one side of some doors (savanna 1/2/3/7): of the two sides, the one walled in on more sides is the room
   const walls=c=>[[1,0],[-1,0],[0,1],[0,-1]].filter(([dx,dz])=>{for(let d=1;d<=4;d++){const b=block(bot,{x:c.x+dx*d,y:c.y+1,z:c.z+dz*d});if(b&&b.boundingBox==='block')return true;}return false;}).length;
   if(door){home.door=door;let best=null;for(const [dx,dz]of[[1,0],[-1,0],[0,1],[0,-1]]){const c={x:door.x+dx,y:door.y,z:door.z+dz};if(!(inBox(c)&&free(c)&&free({...c,y:c.y+1})&&roofed(c)))continue;const w=walls(c);if(!best||w>best.w)best={c,w};}if(best)home.inside=best.c;}
   // owner 10-28 ("需要返回屋内实际不包括边界的范围而且要回报具体地板高度"): the room on the door's level, walls excluded - every cell she can
   // stand in under the roof, reached from the first cell inside without crossing a wall or the door
   if(home.inside){const seen=new Set(),todo=[home.inside],cells=[];const k=c=>c.x+','+c.z;seen.add(k(home.inside));
    while(todo.length&&cells.length<400){const c=todo.pop();cells.push(c);for(const [dx,dz]of[[1,0],[-1,0],[0,1],[0,-1]]){const n={x:c.x+dx,y:c.y,z:c.z+dz};if(seen.has(k(n)))continue;seen.add(k(n));if(inBox(n)&&free(n)&&free({...n,y:n.y+1})&&roofed(n))todo.push(n);}}
    const xs=cells.map(c=>c.x),zs=cells.map(c=>c.z),floor=block(bot,{...home.inside,y:home.inside.y-1});
    home.interior={min:{x:Math.min(...xs),z:Math.min(...zs)},max:{x:Math.max(...xs),z:Math.max(...zs)},cells:cells.length,feetY:home.inside.y,floorY:home.inside.y-1,floorBlock:floor?.name||null};}}
  // 10-30 home-walk round 30: on a slope the house sits at the middle height of its ground, and on the door side the land was 3 lower -
  // a 2-block climb onto the foundation, nothing to stand on, no tool: no way in at all, and she spent the night in the water below it.
  // From the door outwards, past any porch of the house itself (GPT #4177: savanna 4 has 4 cells of it), each cell may be at most one
  // lower than the last; where the land is lower, cobblestone steps are added (up to 8), never into a protected area or anyone's body.
  // Where they stop is said as it is (land reached, blocked, out of steps, not loaded), and a stop never undoes the house (DeepSeek #4180).
  if(home.door&&home.inside){const out={x:home.door.x-home.inside.x,z:home.door.z-home.inside.z},onPlot=(x,z)=>x>=o.x&&x<o.x+t.size[0]&&z>=o.z&&z<o.z+t.size[2];
   const st={count:0,out,end:null,left:0,on:null};let prev=home.door.y-1;
   try{for(let d=1;d<=24;d++){const x=home.door.x+out.x*d,z=home.door.z+out.z*d;let g=null;
     for(let y=prev+1;y>=prev-16;y--){const b=block(bot,{x,y,z});if(!b)break;if(b.boundingBox==='block'||/water|lava/.test(b.name)){g=y;st.on=b.name;break;}}
     if(g===null){st.end='unseen';break;}
     if(g>=prev-1){prev=g;if(onPlot(x,z))continue;st.end='land';break;}
     if(st.count>=8){st.end='out of steps';st.left=prev-g;break;}
     const top=prev-1,body=e=>e.position&&Math.abs(e.position.x-(x+0.5))<0.8&&Math.abs(e.position.z-(z+0.5))<0.8&&e.position.y<=top+2&&e.position.y+1.8>g;
     if(overlapsProtected(loadProtections(bot.username),{min:{x,y:g+1,z},max:{x,y:top+2,z}})||Object.values(bot.entities||{}).some(body)){st.end='blocked';st.left=prev-g;break;}
     checkSite(bot,plan);await command(bot,`/fill ${x} ${g+1} ${z} ${x} ${top} ${z} minecraft:cobblestone`,s=>/filled|fill|blocks|changed/i.test(s));
     st.count++;prev=top;}
   }catch{st.end='interrupted';}
   if(st.count||st.end==='blocked')home.steps=st;}
  const homeAt=home.inside||home.entry;
  const dir=path.join('bots',bot.username);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'house.json'),JSON.stringify(home,null,2));
  bot.lastBuiltHouse=home;
  const xyz=c=>`(${c.x}, ${c.y}, ${c.z})`;
  say(bot,`House confirmed (${t.id}): it covers ${xyz(o)} to ${xyz({x:o.x+t.size[0]-1,y:o.y+t.size[1]-1,z:o.z+t.size[2]-1})} - those are its outer corners, outside the walls.`
   +(home.door?` The door is at ${xyz(home.door)}.`:' No door was found in it.')
   +(home.inside?` The first cell inside the door is ${xyz(home.inside)}: stand there and you are in the house.`:'')
   +(home.interior?` Inside, walls not counted: x ${home.interior.min.x}..${home.interior.max.x}, z ${home.interior.min.z}..${home.interior.max.z} (${home.interior.cells} cells you can stand in on this floor). The floor is ${home.interior.floorBlock||'a block'} at y ${home.interior.floorY}; standing on it your feet are at y ${home.interior.feetY}.`:'')
   +(home.steps?((s)=>` The land outside the door was lower: `+(s.count?`${s.count} cobblestone step${s.count>1?'s':''} lead${s.count>1?'':'s'} down from the door`:'no step could be added')
     +({land:/water|lava/.test(s.on||'')?` to the ${s.on.includes('lava')?'lava':'water'}'s edge`:' to the land',blocked:`; a protected area or someone in the way stopped ${s.count?'them':'it'} ${s.left} above the land there`,'out of steps':`, and the last one is still ${s.left} above the land`,unseen:', past them the land is not loaded, so it is not known whether they reach it',interrupted:', then the building was interrupted'}[s.end]||'')+'.')(home.steps):'')
   +` "home" now points to ${xyz(homeAt)}. Used ${paid} of your wood/stone items, the house allowance covered the rest.`);
  if(t.note)say(bot,t.note);return true;
 }catch(e){say(bot,'House not completed: '+e.message);return false;}
}
export const buildHouse=actLogged('op-fill',build,['style','options']);
