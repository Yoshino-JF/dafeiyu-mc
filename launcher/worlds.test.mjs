import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {EventEmitter} from 'node:events';
import {WorldManager,properties} from './worlds.mjs';

const area=path.resolve(import.meta.dirname,'../dev/gpt-launcher-worlds-20261028/unit');fs.mkdirSync(area,{recursive:true});
function setup(spawnProcess){const root=fs.mkdtempSync(path.join(area,'case-'));return new WorldManager({root,sourceRoot:root,spawnProcess});}
function bytes(p,v){fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,v);}

test('create keeps precise seed text and uses an independent managed folder',async()=>{
 const m=setup(),w=await m.create({name:'大肥鱼的世界',seed:'9223372036854775807',type:'flat',port:29101});
 assert.equal(w.seed,'9223372036854775807');assert.equal(w.eulaAccepted,false);assert.equal(fs.existsSync(path.join(w.dir,'world')),false);
 const s=properties(fs.readFileSync(path.join(w.dir,'server.properties'),'utf8'));assert.equal(s['server-ip'],'127.0.0.1');assert.equal(s['level-name'],'world');assert.equal(s['level-type'],'minecraft:flat');assert.equal(s['enable-rcon'],'false');
});
test('invalid path identifiers, names, and property injection are rejected',async()=>{
 const m=setup();for(const id of ['../elsewhere','C:\\test','..','a/b'])assert.throws(()=>m.get(id));
 for(const name of ['../世界','NUL','hello\nseed=1',''])await assert.rejects(m.create({name}));
 await assert.rejects(m.create({name:'正常',seed:'x\ngamemode=creative'}));assert.equal((await m.list()).length,0);
});
test('import copies files, excludes session.lock, leaves source unchanged',async()=>{
 const m=setup(),source=path.join(m.root,'source-world');bytes(path.join(source,'level.dat'),'fixture-level');bytes(path.join(source,'region/r.0.0.mca'),'fixture-region');bytes(path.join(source,'session.lock'),'lock');
 await assert.rejects(m.importWorld({name:'导入',source}),/关闭/);
 const w=await m.importWorld({name:'导入',source,sourceClosed:true,port:29103});
 assert.equal(fs.readFileSync(path.join(w.dir,'world/region/r.0.0.mca'),'utf8'),'fixture-region');assert.equal(fs.existsSync(path.join(w.dir,'world/session.lock')),false);assert.equal(fs.readFileSync(path.join(source,'session.lock'),'utf8'),'lock');assert.equal(w.source,'import');
 await assert.rejects(m.importWorld({source:path.join(w.dir,'world'),sourceClosed:true}),/已由启动器/);
});
test('backup and restore preserve a pre-restore snapshot and current connection',async()=>{
 const m=setup(),w=await m.create({name:'恢复',port:29104});bytes(path.join(w.dir,'world/level.dat'),'original');bytes(path.join(w.dir,'world/dimensions/minecraft/overworld/region/test'),'old-region');
 const b=await m.backup(w.id);bytes(path.join(w.dir,'world/level.dat'),'changed');await m.update(w.id,{name:'新名字',port:29105});
 const r=await m.restore(w.id,b.id);assert.equal(fs.readFileSync(path.join(w.dir,'world/level.dat'),'utf8'),'original');assert.equal(m.get(w.id).port,29105);assert.equal(m.get(w.id).name,'新名字');
 assert.equal(fs.readFileSync(path.join(m.backupDir,w.id,r.safetyBackup.id,'world/level.dat'),'utf8'),'changed');assert.equal((await m.backups(w.id)).length,2);
});
test('archive can be reversed without deleting world or backups',async()=>{
 const m=setup(),w=await m.create({name:'归档',port:29106});await m.backup(w.id);await m.archive(w.id);
 assert.equal((await m.list())[0].archived,true);assert.equal((await m.backups(w.id)).length,1);await m.archive(w.id,true);assert.equal(m.get(w.id).name,'归档');
});
test('running-port lock blocks editing, backup, restore and archive',async()=>{
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const m=setup(),w=await m.create({name:'在用',port:server.address().port});await assert.rejects(m.update(w.id,{name:'不改'}),/端口/);await assert.rejects(m.backup(w.id),/端口/);await assert.rejects(m.archive(w.id),/端口/);assert.equal(m.get(w.id).name,'在用');}finally{await new Promise(r=>server.close(r));}
});
test('generated worlds refuse seed and terrain rewriting',async()=>{
 const m=setup(),w=await m.create({name:'已生成',port:29108,seed:'abc'});bytes(path.join(w.dir,'world/level.dat'),'fixture');
 await assert.rejects(m.update(w.id,{seed:'new'}),/已有世界/);await assert.rejects(m.update(w.id,{type:'flat'}),/已有世界/);await m.update(w.id,{difficulty:'hard'});assert.equal(m.get(w.id).difficulty,'hard');
});
test('server start requires EULA and consumes split ready lines; stop only writes to owned child',async()=>{
 let args,commands='',spawns=0;const child=new EventEmitter();child.pid=123;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin={writable:true,write(s){commands+=s;queueMicrotask(()=>child.emit('close',0));}};
 const m=setup((...a)=>{spawns++;args=a;queueMicrotask(()=>{child.stdout.emit('data','[Server thread/INFO]: Do');child.stdout.emit('data','ne (0.123s)! For help, type "help"\n');});return child;});
 const jar=path.join(m.root,'engine/server.jar');bytes(jar,'fake-core');await m.setEngine({jar,java:'java',memoryMb:1024});const w=await m.create({name:'启动',port:29109});
 await assert.rejects(m.start(w.id),/EULA/);assert.equal(spawns,0);
 await m.start(w.id,{agreeEula:true,players:['JFors','DaFeiYu']});assert.equal(m.status().phase,'ready');assert.equal(args[2].cwd,w.dir);assert.equal(args[2].windowsHide,true);assert.equal(JSON.parse(fs.readFileSync(path.join(w.dir,'ops.json'))).length,2);
 await assert.rejects(m.backup(w.id),/先停止/);await m.stop();assert.equal(commands,'save-all flush\nstop\n');assert.equal(m.status().running,false);assert.equal(m.status().lastExit,0);
});
test('stop during engine preparation prevents a late Java process',async()=>{
 let release,entered;const gate=new Promise(r=>release=r),inPreparation=new Promise(r=>entered=r);let spawned=false;
 const m=setup(()=>{spawned=true;throw Error('late spawn');}),w=await m.create({name:'取消准备',port:29110,agreeEula:true});
 m.prepareEngine=async()=>{entered();await gate;return {java:'java',jar:'fake.jar',memoryMb:1024};};
 const starting=m.start(w.id);await inPreparation;await m.stop();release();await assert.rejects(starting,/取消/);assert.equal(spawned,false);
});
