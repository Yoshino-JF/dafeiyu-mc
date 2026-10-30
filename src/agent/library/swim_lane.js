import Vec3 from 'vec3';
const dangerous=b=>!b||/^(lava|fire|soul_fire|cactus|magma_block|campfire|soul_campfire|powder_snow|sweet_berry_bush|cobweb)$/.test(b.name);
const overlap=(a,b)=>a[0]<b[3]&&a[3]>b[0]&&a[1]<b[4]&&a[4]>b[1]&&a[2]<b[5]&&a[5]>b[2];
export function swimmingStart(bot) {
    const p=bot.entity.position.floored(),feet=bot.blockAt(p);
    return feet?.name==='water'||feet?.name==='air'&&bot.blockAt(p.offset(0,-1,0))?.name==='water';
}
// A shallow observed water column is not an unsupported air cliff. Require a
// known full-footprint bottom, within four cells, and never a lower next bottom.
export function swimLane(bot,dx,dz) {
    const p=bot.entity.position;
    const at=(x,y,z)=>bot.blockAt(new Vec3(x,y,z));
    const bottom=(x,z)=>{
        let air=0,water=false;
        for(let dy=0;dy<=4;dy++){
            const y=Math.floor(p.y-.05)-dy,b=at(x,y,z);
            if(dangerous(b)||!Array.isArray(b.shapes))return null;
            const tops=b.shapes.filter(s=>s[0]===0&&s[2]===0&&s[3]===1&&s[5]===1).map(s=>y+s[4]);
            if(tops.length)return Math.max(...tops);
            if(b.name==='water'){water=true;continue;}
            if(b.name==='air'&&!water&&++air<=1)continue;
            return null;
        }
        return null;
    };
    const footprint=(x,z)=>{
        const cells=[];
        for(let bx=Math.floor(x-.3);bx<=Math.floor(x+.3-1e-7);bx++)for(let bz=Math.floor(z-.3);bz<=Math.floor(z+.3-1e-7);bz++)cells.push([bx,bz]);
        return cells;
    };
    const origins=footprint(p.x,p.z).map(([x,z])=>bottom(x,z));
    if(origins.some(y=>y===null))return false;
    const originBottom=Math.max(...origins);
    for(const n of [.35,.7,1.1]){
        const x=p.x+dx*n,z=p.z+dz*n,box=[x-.3,p.y+.03,z-.3,x+.3,p.y+(bot.entity.height||1.8),z+.3];
        for(const [bx,bz]of footprint(x,z)){
            for(let y=Math.floor(box[1]);y<=Math.floor(box[4]);y++){
                const b=at(bx,y,bz);
                if(dangerous(b)||!Array.isArray(b.shapes)||b.shapes.some(s=>overlap(box,[bx+s[0],y+s[1],bz+s[2],bx+s[3],y+s[4],bz+s[5]])))return false;
            }
            const floor=bottom(bx,bz);
            if(floor===null||floor<originBottom-.12)return false;
            const feet=at(bx,Math.floor(p.y),bz),below=at(bx,Math.floor(p.y)-1,bz);
            if(feet.name!=='water'&&!(feet.name==='air'&&(below?.name==='water'||Math.abs(floor-p.y)<.12)))return false;
        }
    }
    return true;
}
