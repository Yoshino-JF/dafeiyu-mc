// Isolated end-to-end verification. Never reads production keys or starts the companion.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
const base=path.join(root,'dev/gpt-launcher-worlds-20261028');fs.mkdirSync(base,{recursive:true});
const area=fs.mkdtempSync(path.join(base,'e2e-'));
const {chromium}=createRequire(process.env.LAUNCHER_TEST_NODE_MODULES+'/package.json')('playwright');
const results={area,checks:[],screenshots:[],errors:[]};
const child=spawn(process.execPath,[path.join(root,'launcher/server.mjs'),'--port','25695','--data-dir',area],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>results.errors.push(String(b)));
let browser,url,headers,worldId;
async function api(route,data){const r=await fetch(url.split('#')[0]+'api/'+route,{method:data===undefined?'GET':'POST',headers,body:data===undefined?undefined:JSON.stringify(data)});const value=await r.json();if(!r.ok)throw Error(value.error);return value;}
const check=(name,value)=>{assert.ok(value,name);results.checks.push(name);};
try{
 const end=Date.now()+15000;while(!output.includes('DaFeiYu Launcher: ')&&child.exitCode===null&&Date.now()<end)await new Promise(r=>setTimeout(r,50));
 url=output.match(/DaFeiYu Launcher: (http:\/\/127\.0\.0\.1:\d+\/#\w+)/)?.[1];assert.ok(url,'isolated service ready');headers={Authorization:'Bearer '+url.split('#')[1],'Content-Type':'application/json'};
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1200,height:760},deviceScaleFactor:1});
 page.on('pageerror',e=>results.errors.push(e.message));
 await page.goto(url);await page.waitForFunction(()=>window.launcherReady===true);
 async function shot(name){const p=path.join(area,name+'.png');await page.screenshot({path:p});results.screenshots.push(p);}
 await shot('01-home');check('home has no horizontal overflow',await page.evaluate(()=>document.body.scrollWidth===innerWidth));
 await page.locator('.side [data-page=worlds]').click();await page.locator('.world-empty').waitFor();await shot('02-worlds-empty');
 await page.locator('#world-create').click();await page.locator('#world-dialog [name=name]').fill('和大肥鱼的第一天');await page.locator('#world-dialog [name=seed]').fill('9223372036854775807');await page.locator('#world-dialog [name=type]').selectOption('flat');await shot('03-create-dialog');
 await page.locator('#world-dialog-submit').click();await page.locator('#world-dialog').waitFor({state:'hidden'});await page.locator('.world-card').waitFor();
 let ws=await api('worlds');worldId=ws.worlds[0].id;check('UI creates and selects world',ws.mode==='local'&&ws.selected===worldId&&ws.worlds[0].seed==='9223372036854775807');
 await page.locator('.world-card').getByRole('button',{name:'设置',exact:true}).click();await page.locator('#world-dialog [name=difficulty]').selectOption('normal');await page.locator('#world-dialog-submit').click();await page.locator('#world-dialog').waitFor({state:'hidden'});check('UI saves world difficulty',(await api('worlds')).worlds[0].difficulty==='normal');
 await page.locator('.world-card').getByRole('button',{name:'备份',exact:true}).click();await page.locator('.world-detail summary').waitFor();await shot('04-worlds-created');check('UI creates a backup',(await api('worlds')).worlds[0].backups.length===1);
 await page.locator('.world-detail summary').click();await page.locator('.world-detail').getByRole('button',{name:'恢复',exact:true}).click();await page.locator('#world-dialog-submit').click();await page.locator('#world-dialog').waitFor({state:'hidden'});check('UI restore preserves a safety backup',(await api('worlds')).worlds[0].backups.length===2);
 await page.locator('.world-card').getByRole('button',{name:'归档',exact:true}).click();await page.locator('#world-dialog-submit').click();await page.locator('#world-dialog').waitFor({state:'hidden'});await page.locator('[data-world-filter=archived]').click();await page.locator('.world-card').getByRole('button',{name:'从归档取回'}).click();await page.locator('.world-empty').waitFor();await page.locator('[data-world-filter=active]').click();await page.locator('.world-card').waitFor();check('UI archive and restore work',!(await api('worlds')).worlds[0].archived);
 await api('worlds/select',{id:worldId});
 // Exercise the real server only in the test directory. EULA acceptance belongs to this test fixture.
 const e=ws.engine;await api('worlds/engine',{jar:e.jar,java:e.java,memoryMb:1024});
 const start=await api('worlds/start',{id:worldId,agreeEula:true});check('real local server reaches Done',start.phase==='ready'&&start.pid>0);results.serverPid=start.pid;
 const w=(await api('worlds')).worlds[0];check('real generated level.dat exists',fs.statSync(path.join(w.dir,'world/level.dat')).size>100);
 await assert.rejects(api('worlds/update',{id:worldId,name:'不能改'}),/停止/);results.checks.push('live world edits rejected');
 await api('worlds/stop',{});check('owned Java saves and exits zero',(await api('status')).world.lastExit===0);
 await api('worlds/backup',{id:worldId});const generated=await api('worlds');const bp=generated.worlds[0].backups[0];check('generated-world backup includes level.dat',fs.existsSync(path.join(area,'world-backups',worldId,bp.id,'world/level.dat')));
 await api('worlds/restore',{id:worldId,backupId:bp.id});check('generated-world restore works',fs.statSync(path.join(w.dir,'world/level.dat')).size>100);
 check('restored world starts again',(await api('worlds/start',{id:worldId})).phase==='ready');await api('worlds/stop',{});
 await api('worlds/import',{name:'旧世界的副本',source:path.join(w.dir,'world'),sourceClosed:true}).then(()=>assert.fail('managed world import must reject'),e=>assert.match(e.message,/已由启动器/));
 check('world form validation does not mark companion startup failed',(await api('status')).error==='');
 const source=path.join(area,'import-source');fs.cpSync(path.join(w.dir,'world'),source,{recursive:true});
 const imported=await api('worlds/import',{name:'带着旧世界继续',source,sourceClosed:true});check('real level.dat import copies exact bytes',fs.readFileSync(path.join(imported.dir,'world/level.dat')).equals(fs.readFileSync(path.join(source,'level.dat'))));
 await page.reload();await page.waitForFunction(()=>window.launcherReady===true);await page.locator('.side [data-page=worlds]').click();await page.locator('.world-card').first().waitFor();await shot('05-worlds-final');
 for(const size of [{width:1200,height:760},{width:960,height:640}]){
  await page.setViewportSize(size);
  for(const name of ['worlds','player','models','voice','prompt','skin','logs','home']){
   await page.locator('.side [data-page='+name+']').click();check(name+' fits '+size.width,await page.evaluate(()=>document.body.scrollWidth<=innerWidth&&document.querySelector('.side').scrollHeight<=innerHeight));
  }
  if(size.width===960){await shot('06-home-960');await page.locator('.side [data-page=worlds]').click();await page.locator('#world-create').click();await shot('07-dialog-960');check('dialog fits 960x640',await page.locator('#world-dialog').evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.right<=innerWidth;}));await page.locator('.dialog-head .dialog-close').click();}
 }
 check('no browser JavaScript errors',results.errors.length===0);
}catch(e){results.failure=e.message;process.exitCode=1;}
finally{
 if(browser)await browser.close();if(url)try{await api('exit',{});}catch(e){results.shutdownError=e.message;process.exitCode=1;}
 if(child.exitCode===null)await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,5000).unref();});
 results.serviceExited=child.exitCode===0;fs.writeFileSync(path.join(area,'result.json'),JSON.stringify(results,null,2));
 console.log(JSON.stringify({report:path.join(area,'result.json'),checks:results.checks.length,failure:results.failure,errors:results.errors,serviceExited:results.serviceExited},null,2));
}
