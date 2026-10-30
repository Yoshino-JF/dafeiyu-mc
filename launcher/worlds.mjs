import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import zlib from 'node:zlib';

const META = 'launcher-world.json';
const DATA = ['world', 'world_nether', 'world_the_end'];
const MODES = new Set(['survival', 'creative', 'adventure', 'spectator']);
const DIFFICULTIES = new Set(['peaceful', 'easy', 'normal', 'hard']);
const TYPES = new Set(['normal', 'flat', 'large_biomes', 'amplified']);
const delay = ms => new Promise(r => setTimeout(r, ms));
const exists = p => fs.existsSync(p);
const read = (p, fallback = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const write = (p, value) => { const tmp = p + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(value, null, 2)); fs.renameSync(tmp, p); };
export function properties(text) {
  return Object.fromEntries(text.split(/\r?\n/).filter(l => l.trim() && !/^[#!]/.test(l)).map(l => { const i=l.indexOf('='); return i<0?[l.trim(),'']:[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/\\:/g,':')]; }));
}
function safeName(name) {
  const s=String(name??'').trim();
  if (!s || s.length>50 || /[\x00-\x1f<>:"/\\|?*]/.test(s) || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s) || /^\.+$/.test(s)) throw Error('世界名称请用 1–50 个中文、字母或数字，不要包含路径符号。');
  return s;
}
function inside(parent, child) { const r=path.relative(parent,child); return !!r && !r.startsWith('..'+path.sep) && r!=='..' && !path.isAbsolute(r); }
function noLink(p) { if (exists(p) && fs.lstatSync(p).isSymbolicLink()) throw Error('此目录是链接，请选择实际存档文件夹。'); }
/** One file out of a zip (a jar): Paper's META-INF/download-context names Mojang's file, its URL and SHA-256. */
function zipEntry(file, name) {
  try {
    const b = fs.readFileSync(file), end = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0) return null;
    for (let i = 0, p = b.readUInt32LE(end + 16); i < b.readUInt16LE(end + 10); i++) {
      const method = b.readUInt16LE(p + 10), size = b.readUInt32LE(p + 20), n = b.readUInt16LE(p + 28), x = b.readUInt16LE(p + 30), c = b.readUInt16LE(p + 32), at = b.readUInt32LE(p + 42);
      if (b.toString('utf8', p + 46, p + 46 + n) === name) {
        const data = b.subarray(at + 30 + b.readUInt16LE(at + 26) + b.readUInt16LE(at + 28)).subarray(0, size);
        return method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
      }
      p += 46 + n + x + c;
    }
  } catch { /* not a readable jar */ }
  return null;
}
/** Download to a file. With watch, give up when after 10 s it averages under 300 KB/s, so the next source is tried. */
async function download(url, file, { watch = false, onProgress } = {}) {
  const ctl = new AbortController(), t0 = Date.now(); let got = 0, slow = false;
  const timer = setInterval(() => { const s = (Date.now() - t0) / 1000; if (watch && s >= 10 && got / s < 300 * 1024) { slow = true; ctl.abort(); } if (s > 900) ctl.abort(); }, 1000);
  const out = fs.createWriteStream(file);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) throw Error('HTTP ' + r.status);
    const total = Number(r.headers.get('content-length')) || 0;
    for await (const chunk of r.body) { got += chunk.length; if (!out.write(chunk)) await new Promise((res) => out.once('drain', res)); onProgress?.(got, total); }
    await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
  } catch (e) { out.destroy(); throw Error(slow ? '速度太慢' : e.name === 'AbortError' ? '超时' : e.message); }
  finally { clearInterval(timer); }
}
async function copyTree(source, destination) {
  noLink(source);
  await fsp.mkdir(destination,{recursive:true});
  for (const entry of await fsp.readdir(source,{withFileTypes:true})) {
    if (entry.isSymbolicLink()) throw Error('存档包含目录链接，未复制；请先整理为普通文件夹。');
    if (entry.name==='session.lock') continue;
    const from=path.join(source,entry.name),to=path.join(destination,entry.name);
    if(entry.isDirectory())await copyTree(from,to); else if(entry.isFile())await fsp.copyFile(from,to);
  }
}
async function sizeOf(dir) {
  let bytes=0;
  for(const e of await fsp.readdir(dir,{withFileTypes:true}).catch(()=>[])) {
    if(e.isSymbolicLink())continue;
    const p=path.join(dir,e.name);
    if(e.isDirectory())bytes+=await sizeOf(p);else if(e.isFile())bytes+=(await fsp.stat(p)).size;
  }
  return bytes;
}
export const portOpen = (port,host='127.0.0.1') => new Promise(resolve=>{
  const s=net.createConnection({port,host});let done=false;
  const finish=v=>{if(done)return;done=true;s.destroy();resolve(v);};
  s.on('connect',()=>finish(true));s.on('error',()=>finish(false));s.setTimeout(500,()=>finish(false));
});

export class WorldManager {
  constructor({root,sourceRoot=root,log=()=>{},spawnProcess=spawn}={}) {
    this.root=path.resolve(root);this.sourceRoot=sourceRoot;this.log=log;this.spawnProcess=spawnProcess;
    this.dir=path.join(this.root,'worlds');this.backupDir=path.join(this.root,'world-backups');
    this.archiveDir=path.join(this.root,'worlds-archive');this.engineFile=path.join(this.dir,'engine.json');
    for(const p of [this.dir,this.backupDir,this.archiveDir]){noLink(p);fs.mkdirSync(p,{recursive:true});}
    this.child=null;this.current=null;this.phase='stopped';this.message='';this.tail=[];this.mutating=false;this.lastExit=null;this.operation=0;
    this.engineState={phase:'idle'};this.preparing=null;
  }
  location(id, archived=false) {
    if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(id)))throw Error('无效的世界标识。');
    const base=archived?this.archiveDir:this.dir,p=path.join(base,id);
    if(!inside(base,p))throw Error('无效的世界目录。');noLink(p);return p;
  }
  get(id, archived=false) {
    const dir=this.location(id,archived),w=read(path.join(dir,META));
    if(!w||w.id!==id)throw Error('找不到这个世界，请刷新列表。');
    return {...w,dir,archived};
  }
  status() { return {id:this.current,phase:this.phase,message:this.message,running:!!this.child,pid:this.child?.pid??null,logs:this.tail.slice(-12),busy:this.mutating,lastExit:this.lastExit,engine:this.engineState}; }
  engine() {
    const saved=read(this.engineFile,{})||{};
    const candidates=[path.join(this.sourceRoot,'server/server.jar'),path.join(this.sourceRoot,'services/server/server.jar'),path.join(this.sourceRoot,'dev/server/server.jar')];
    const jar=saved.jar||candidates.find(exists)||'';
    // the release ships its own Java 25 (java/, a jlink of Temurin) so a new user needs no Java of their own
    const bundled=path.join(this.sourceRoot,'java/bin/java.exe');
    const java=saved.java||(exists(bundled)?bundled:process.env.JAVA_HOME&&exists(path.join(process.env.JAVA_HOME,'bin/java.exe'))?path.join(process.env.JAVA_HOME,'bin/java.exe'):'java');
    return {jar,java,memoryMb:saved.memoryMb||2048,available:!!jar&&exists(jar)};
  }
  async setEngine(data) {
    return this.exclusive(async()=>{
      this.assertStopped();const e={...this.engine(),...data};
      e.jar=path.resolve(String(e.jar||''));
      if(!/\.jar$/i.test(e.jar)||!exists(e.jar)||!fs.statSync(e.jar).isFile())throw Error('请选择实际存在的 Minecraft 服务器 .jar 文件。');
      e.java=String(e.java||'java').trim();e.memoryMb=Number(e.memoryMb);
      if(!e.java||/[\r\n\x00]/.test(e.java)||!Number.isInteger(e.memoryMb)||e.memoryMb<1024||e.memoryMb>16384)throw Error('Java 路径无效，或内存不在 1024–16384 MB 范围内。');
      write(this.engineFile,{jar:e.jar,java:e.java,memoryMb:e.memoryMb});return this.engine();
    });
  }
  async list() {
    const out=[];
    for(const archived of [false,true])for(const e of fs.readdirSync(archived?this.archiveDir:this.dir,{withFileTypes:true})) {
      if(!e.isDirectory()||e.isSymbolicLink())continue;
      try{const w=this.get(e.name,archived);out.push({...w,generated:exists(path.join(w.dir,'world/level.dat')),backups:await this.backups(w.id),active:this.current===w.id&&!!this.child});}catch{}
    }
    return out.sort((a,b)=>Number(a.archived)-Number(b.archived)||(b.lastPlayed||b.createdAt)-(a.lastPlayed||a.createdAt));
  }
  validate(data, previous={}) {
    const w={...previous,...data};w.name=safeName(w.name);w.seed=String(w.seed??'').trim();
    if(w.seed.length>128||/[\r\n\x00]/.test(w.seed))throw Error('种子最多 128 个字符，不能包含换行。');
    if(!MODES.has(w.gamemode)||!DIFFICULTIES.has(w.difficulty)||!TYPES.has(w.type))throw Error('请选择有效的游戏模式、难度和地形。');
    w.port=Number(w.port);
    if(!Number.isInteger(w.port)||w.port<1024||w.port>65535)throw Error('世界端口需为 1024–65535 的整数。');
    w.structures=w.structures!==false;w.pvp=!!w.pvp;return w;
  }
  async nextPort() {
    const used=new Set((await this.list()).filter(w=>!w.archived).map(w=>w.port));
    for(let p=25688;p<=25699;p++)if(!used.has(p)&&!await portOpen(p))return p;
    throw Error('默认端口范围已满，请在高级设置中填写一个空闲端口。');
  }
  async exclusive(fn) { if(this.mutating)throw Error('正在处理世界文件，请稍候。');this.mutating=true;try{return await fn();}finally{this.mutating=false;} }
  assertStopped() { if(this.child)throw Error('请先停止本地世界，保存完成后再修改存档。'); }
  async assertOffline(w) { this.assertStopped();if(await portOpen(w.port))throw Error('这个世界的端口正在使用，未改动存档。请先从原窗口关闭服务器。'); }
  writeSettings(w) {
    const settings={
      'server-ip':'127.0.0.1','server-port':w.port,'level-name':'world','level-seed':w.seed,'level-type':'minecraft:'+w.type,
      gamemode:w.gamemode,difficulty:w.difficulty,'generate-structures':w.structures,'force-gamemode':false,
      'online-mode':false,'enforce-secure-profile':false,'spawn-protection':0,'view-distance':8,'simulation-distance':6,
      'enable-rcon':false,'enable-query':false,'white-list':false,pvp:w.pvp,'max-players':8,motd:'DaFeiYu Local World',
    };
    fs.writeFileSync(path.join(w.dir,'server.properties'),'# Managed by DaFeiYu Launcher\n'+Object.entries(settings).map(([k,v])=>k+'='+String(v).replace(/:/g,'\\:')).join('\n')+'\n');
    write(path.join(w.dir,META),Object.fromEntries(Object.entries(w).filter(([k])=>!['dir','archived','backups','active','generated'].includes(k))));
  }
  async create(data) {
    return this.exclusive(async()=>{
      const id=crypto.randomUUID(),port=data.port?Number(data.port):await this.nextPort();
      const w=this.validate({name:data.name,seed:data.seed,gamemode:data.gamemode||'survival',difficulty:data.difficulty||'easy',type:data.type||'normal',structures:data.structures,pvp:data.pvp,port});
      w.id=id;w.createdAt=Date.now();w.lastPlayed=null;w.source='new';w.eulaAccepted=!!data.agreeEula;
      w.dir=this.location(id);fs.mkdirSync(w.dir);this.writeSettings(w);
      if(w.eulaAccepted)fs.writeFileSync(path.join(w.dir,'eula.txt'),'eula=true\n');
      return this.get(id);
    });
  }
  async update(id,data) {
    return this.exclusive(async()=>{
      const old=this.get(id);await this.assertOffline(old);
      const generated=exists(path.join(old.dir,'world/level.dat'));
      if(generated&&((data.seed!==undefined&&String(data.seed)!==old.seed)||(data.type!==undefined&&data.type!==old.type)))throw Error('已有世界不能更换种子或地形；请新建世界。');
      const input=Object.fromEntries(Object.entries(data).filter(([k])=>['name','seed','gamemode','difficulty','type','structures','pvp','port'].includes(k)));
      const w=this.validate(input,old);this.writeSettings(w);return this.get(id);
    });
  }
  async importWorld(data) {
    if(data.sourceClosed!==true)throw Error('请先退出源世界，并勾选已关闭确认。');
    const source=path.resolve(String(data.source||''));noLink(source);
    if(!exists(path.join(source,'level.dat'))||!fs.statSync(path.join(source,'level.dat')).isFile())throw Error('请选择包含 level.dat 的世界存档文件夹。');
    if(source===this.root||inside(this.dir,source)||inside(this.backupDir,source)||inside(this.archiveDir,source))throw Error('这个存档已由启动器管理，请直接选择或恢复。');
    const parent=path.dirname(source),prop=path.join(parent,'server.properties');
    if(exists(prop)){const old=properties(fs.readFileSync(prop,'utf8'));if(old['server-port']&&await portOpen(Number(old['server-port'])))throw Error('源服务器仍在运行，请先正常关闭再导入。');}
    const w=await this.create({...data,name:data.name||path.basename(source)});
    try{
      await this.exclusive(async()=>{
        const stamp=fs.statSync(path.join(source,'level.dat')).mtimeMs;
        await copyTree(source,path.join(w.dir,'world'));
        for(const suffix of ['_nether','_the_end']){const extra=source+suffix;if(exists(path.join(extra,'level.dat')))await copyTree(extra,path.join(w.dir,'world'+suffix));}
        if(fs.statSync(path.join(source,'level.dat')).mtimeMs!==stamp)throw Error('复制时源世界发生变化，未完成导入；请关服后重试。');
        w.source='import';this.writeSettings(w);
      });
      return this.get(w.id);
    }catch(e){
      // Keep any partial copy out of the playable list, without removing the original.
      fs.renameSync(w.dir,path.join(this.archiveDir,w.id));throw e;
    }
  }
  async backups(id) {
    this.location(id);const dir=path.join(this.backupDir,id);
    if(!exists(dir))return [];
    noLink(dir);
    return fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.isSymbolicLink()&&/^[0-9a-z-]+$/.test(e.name))
      .map(e=>read(path.join(dir,e.name,'backup.json'))).filter(x=>x&&x.worldId===id).sort((a,b)=>b.createdAt-a.createdAt);
  }
  async makeBackup(w,reason='manual') {
    const id=Date.now().toString(36)+'-'+crypto.randomBytes(3).toString('hex'),dir=path.join(this.backupDir,w.id,id);
    fs.mkdirSync(dir,{recursive:true});
    for(const name of DATA)if(exists(path.join(w.dir,name)))await copyTree(path.join(w.dir,name),path.join(dir,name));
    for(const name of ['server.properties',META])if(exists(path.join(w.dir,name)))fs.copyFileSync(path.join(w.dir,name),path.join(dir,name));
    const record={id,worldId:w.id,createdAt:Date.now(),reason,bytes:await sizeOf(dir),name:w.name};
    write(path.join(dir,'backup.json'),record);return record;
  }
  async backup(id) { return this.exclusive(async()=>{const w=this.get(id);await this.assertOffline(w);return this.makeBackup(w);}); }
  async restore(id,backupId) {
    return this.exclusive(async()=>{
      const w=this.get(id);await this.assertOffline(w);
      if(!/^[0-9a-z-]+$/.test(String(backupId)))throw Error('无效的备份。');
      const source=path.join(this.backupDir,id,backupId),record=read(path.join(source,'backup.json'));
      if(!record||record.worldId!==id)throw Error('找不到这个世界的备份。');noLink(source);
      const saved=read(path.join(source,META));if(!saved||saved.id!==id)throw Error('备份的世界信息不完整。');
      const safety=await this.makeBackup(w,'before-restore');
      const stage=path.join(w.dir,'.restore-'+Date.now()),old=path.join(stage,'previous');fs.mkdirSync(old,{recursive:true});
      const moved=[],installed=[];
      try{
        for(const name of DATA)if(exists(path.join(source,name)))await copyTree(path.join(source,name),path.join(stage,name));
        for(const name of DATA){if(exists(path.join(w.dir,name))){fs.renameSync(path.join(w.dir,name),path.join(old,name));moved.push(name);}if(exists(path.join(stage,name))){fs.renameSync(path.join(stage,name),path.join(w.dir,name));installed.push(name);}}
        this.writeSettings({...saved,name:w.name,port:w.port,dir:w.dir});
        return {restored:true,safetyBackup:safety};
      }catch(e){
        for(const name of installed)fs.renameSync(path.join(w.dir,name),path.join(stage,'failed-'+name));
        for(const name of moved)fs.renameSync(path.join(old,name),path.join(w.dir,name));
        this.writeSettings(w);throw e;
      }
    });
  }
  async archive(id,restore=false) {
    return this.exclusive(async()=>{this.assertStopped();const w=this.get(id,restore);if(await portOpen(w.port))throw Error('端口仍在使用，未移动世界。');const dest=this.location(id,!restore);if(exists(dest))throw Error('目标目录已经存在。');fs.renameSync(w.dir,dest);return {archived:!restore};});
  }
  async prepareEngine(w) {
    const engine=this.engine();
    if(!engine.available)throw Error('没有找到服务器核心。请在“本地服务器设置”里选择 server.jar。');
    await this.patchEngine(engine);
    const from=path.dirname(engine.jar);
    for(const name of ['libraries','versions','cache'])if(exists(path.join(from,name))&&!exists(path.join(w.dir,name))){
      const stage=path.join(w.dir,'.engine-'+name+'-'+crypto.randomBytes(4).toString('hex'));
      await copyTree(path.join(from,name),stage);fs.renameSync(stage,path.join(w.dir,name));
    }
    return engine;
  }
  // The release ships Paper's server.jar alone (Mojang's server file may not be passed on): the first start lets Paper fetch it and
  // build libraries/versions next to the jar, once, so every world after that copies them locally. Only for the bundled server/ jar -
  // a jar the user picked keeps its old behaviour.
  async patchEngine(engine) { await this.prepare(engine); }
  // Owner 10-31 ("提前下载加镜像"): the launcher starts this as soon as it opens, so the core is usually ready before the first world is
  // started; a start meanwhile waits for the same run. Mojang's file comes from the official source, or from the BMCLAPI mirror (same
  // path) when the official one fails or is slow; it is checked against the SHA-256 Paper records, and if both fail Paper fetches it.
  prepare(engine=this.engine()) {
    const from=path.dirname(engine.jar);
    if(!engine.available||path.resolve(engine.jar)!==path.resolve(this.sourceRoot,'server/server.jar')||exists(path.join(from,'versions'))){this.engineState={phase:'ready'};return Promise.resolve();}
    this.preparing??=this._prepare(engine,from).then(()=>{this.engineState={phase:'ready'};},e=>{this.engineState={phase:'error',message:e.message};throw e;}).finally(()=>{this.preparing=null;});
    return this.preparing;
  }
  async _prepare(engine,from) {
    const [sha,url,name]=String(zipEntry(engine.jar,'META-INF/download-context')||'').trim().split('\t');
    const file=name&&path.join(from,'cache',name),good=f=>exists(f)&&crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')===sha;
    if(sha&&/^https:\/\//.test(url||'')&&!good(file)){
      fs.mkdirSync(path.dirname(file),{recursive:true});const part=file+'.part';
      for(const [label,u,watch] of [['官方',url,true],['镜像',url.replace(/^https:\/\/piston-data\.mojang\.com\//,'https://bmclapi2.bangbang93.com/'),false]]){
        this.engineState={phase:'downloading',source:label,percent:0,message:`正在下载 Minecraft 官方服务器文件（${label}源）`};
        try{
          await download(u,part,{watch,onProgress:(got,total)=>{if(total)this.engineState.percent=Math.floor(got*100/total);}});
          if(!good(part))throw Error('文件校验不通过');
          fs.renameSync(part,file);this.log('服务器文件已下载（'+label+'源）');break;
        }catch(e){fs.rmSync(part,{force:true});this.log('服务器文件'+label+'源下载未成功：'+e.message);}
      }
    }
    this.engineState={phase:'patching',message:'正在准备服务器核心'};
    this.message='首次使用，正在准备服务器核心（需要联网，约 1–3 分钟）';
    const child=this.spawnProcess(engine.java,['-Dpaperclip.patchonly=true','-jar',engine.jar],{cwd:from,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let out='';const keep=d=>{out=(out+d).slice(-4000);};child.stdout?.on('data',keep);child.stderr?.on('data',keep);
    const code=await new Promise(r=>{const t=setTimeout(()=>{child.kill();r('timeout');},600000);child.once('error',e=>{clearTimeout(t);out+=e.message;r('error');});child.once('close',c=>{clearTimeout(t);r(c);});});
    if(code!==0||!exists(path.join(from,'versions')))throw Error('服务器核心准备失败（第一次需要联网下载 Minecraft 官方服务器文件），请检查网络后重试。'+(out.trim()?'\n'+out.trim().split(/\r?\n/).slice(-3).join('\n'):''));
  }
  async start(id,{agreeEula=false,players=[]}={}) {
    if(this.child){if(this.current!==id)throw Error('请先停止当前世界。');if(this.phase==='ready')return this.status();throw Error('本地世界正在启动或保存，请稍候。');}
    return this.exclusive(async()=>{
      const operation=++this.operation;
      const w=this.get(id);await this.assertOffline(w);
      if(!w.eulaAccepted&&!agreeEula)throw Error('首次启动需要阅读并同意 Minecraft EULA。');
      this.current=id;this.phase='preparing';this.message='正在准备服务器文件';this.tail=[];
      try{
        const engine=await this.prepareEngine(w);
        if(operation!==this.operation){this.phase='stopped';this.message='已取消启动';throw Error(this.message);}
        w.eulaAccepted=true;w.lastPlayed=Date.now();this.writeSettings(w);
        fs.writeFileSync(path.join(w.dir,'eula.txt'),'eula=true\n');
        // offline-mode UUID algorithm; OP is needed for the already-supported house/teleport tools.
        const ops=players.filter(n=>/^[A-Za-z0-9_]{3,16}$/.test(n)).map(name=>{
          const bytes=crypto.createHash('md5').update('OfflinePlayer:'+name).digest();bytes[6]=(bytes[6]&15)|48;bytes[8]=(bytes[8]&63)|128;const h=bytes.toString('hex');
          return {uuid:[h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-'),name,level:4,bypassesPlayerLimit:false};
        });write(path.join(w.dir,'ops.json'),ops);
        this.phase='starting';this.message=exists(path.join(w.dir,'world/level.dat'))?'正在加载世界':'首次启动，正在生成地形';
        // A real, short path avoids Windows 8.3 TEMP aliases / AF_UNIX pipe failures in Java 25.
        const temp=path.join(fs.realpathSync(this.sourceRoot),'runtime/world-tmp',w.id.slice(0,8));fs.mkdirSync(temp,{recursive:true});
        const child=this.spawnProcess(engine.java,['-Xms512M','-Xmx'+engine.memoryMb+'M','-Dterminal.jline=false','-Dterminal.ansi=false','-Djava.io.tmpdir='+temp,'-Djdk.net.unixdomain.tmpdir='+temp,'-jar',engine.jar,'nogui'],{cwd:w.dir,windowsHide:true,stdio:['pipe','pipe','pipe']});
        this.child=child;let ready=false,problem=null;
        const buffers=new Map();
        const append=(stream,data)=>{const parts=((buffers.get(stream)||'')+String(data)).split(/\r?\n/);buffers.set(stream,parts.pop().slice(-16384));for(const l of parts.filter(Boolean)){this.tail.push(l.replace(/\x1b\[[0-9;]*m/g,''));if(this.tail.length>60)this.tail.shift();if(/Done \([\d.,]+s\)!/.test(l)){ready=true;this.phase='ready';this.message='世界已就绪';}if(/UnsupportedClassVersionError|requires running the server with Java|Unsupported Java detected/i.test(l))problem='Java 版本不合适，请在本地服务器设置中选择与核心兼容的 Java。';}};
        child.stdout?.on('data',data=>append('out',data));child.stderr?.on('data',data=>append('err',data));
        child.once('error',e=>{problem='无法启动 Java：'+e.message;this.phase='error';this.message=problem;});
        child.once('close',code=>{if(this.child===child){this.child=null;this.lastExit=code;this.phase=ready&&code===0?'stopped':'error';this.message=ready&&code===0?'世界已保存并关闭':problem||'服务器未能完成启动，请查看世界文件夹中的 logs/latest.log';}});
        const end=Date.now()+120000;
        while(this.child===child&&!ready&&!problem&&Date.now()<end)await delay(200);
        if(operation!==this.operation)throw Error('已取消启动');
        if(problem)throw Error(problem);
        if(!ready)throw Error(this.child?'世界仍在生成，请稍后查看状态；没有强制停止服务器。':this.message);
        this.log('本地世界已就绪：'+w.name+' · 127.0.0.1:'+w.port);return this.status();
      }catch(e){if(!this.child){this.phase='error';this.message=e.message;}throw e;}
    });
  }
  async stop() {
    this.operation++;
    const child=this.child;if(!child)return this.status();
    this.phase='stopping';this.message='正在保存世界，请稍候';
    if(!child.stdin?.writable)throw Error('服务器控制输入不可用，未强制结束进程。');
    child.stdin.write('save-all flush\nstop\n');
    const end=Date.now()+30000;while(this.child===child&&Date.now()<end)await delay(100);
    if(this.child===child)throw Error('世界还在保存，未强制结束进程。请稍后重试。');
    return this.status();
  }
}
