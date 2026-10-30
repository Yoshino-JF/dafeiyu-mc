import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {io} from 'socket.io-client';
import settings from '../settings.js';
import {WorldManager} from './worlds.mjs';

const root=path.resolve(import.meta.dirname,'..');
const dataArg=process.argv.indexOf('--data-dir'),dataRoot=dataArg<0?root:path.resolve(process.argv[dataArg+1]||'');
const runtime=path.join(dataRoot,'runtime/launcher');
fs.mkdirSync(runtime,{recursive:true});
const configFile=path.join(dataRoot,'launcher.settings.json'),sessionFile=path.join(runtime,'session.json');
const defaults={connectionMode:'external',selectedWorldId:'',host:settings.host||'127.0.0.1',port:Number(settings.port)||25677,botName:'DaFeiYu',ownerName:'',provider:'deepseek',model:'deepseek-chat',modelUrl:'https://api.deepseek.com',mindserverPort:8092,otherMindserverPort:Number(settings.mindserver_port)||8091,customPrompt:'',wallpaper:'default'};
const readJSON=(p,fallback={})=>{try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch{return fallback;}};
const config=()=>({...defaults,...readJSON(configFile)});
const keys=()=>readJSON(path.join(dataRoot,'keys.json'));
const baseVoice=readJSON(path.join(root,'profiles/dafeiyu.json')).speak_model?.split('/')||[];
Object.assign(defaults,{speak:Boolean(settings.speak),voiceInput:Boolean(settings.voice?.input_enabled),hotkey:settings.voice?.hotkey||'MOUSE4',ttsProvider:settings.voice?.tts?.provider||'bailian',ttsUrl:settings.voice?.tts?.base_url||'',ttsModel:settings.voice?.tts?.model||baseVoice[1]||'qwen-audio-3.1-tts-flash',ttsVoice:settings.voice?.tts?.voice||baseVoice[2]||'',ttsKeyEnv:settings.voice?.tts?.api_key_env||'DASHSCOPE_API_KEY',asrProvider:settings.voice?.asr?.provider||'bailian',asrUrl:settings.voice?.asr?.base_url||'',asrModel:settings.voice?.asr?.model||'qwen3-asr-flash',asrKeyEnv:settings.voice?.asr?.api_key_env||'DASHSCOPE_API_KEY'});
const keyName=()=>'DEEPSEEK_API_KEY';
const portArg=process.argv.indexOf('--port'),requestedPort=portArg<0?25673:Number(process.argv[portArg+1]);
if(!Number.isInteger(requestedPort)||requestedPort<25600||requestedPort>25699)throw Error('启动器端口必须在 25600–25699 之间。');
const token=crypto.randomBytes(32).toString('hex');let port=requestedPort,core=null,socket=null,busy=false,agents=[],lines=[],lastError='',operation=0,state=null,chat=[];
// what she says (bot-output) and what the owner sent from here, apart from the raw process log
function said(who,text){chat.push({at:Date.now(),who,text:redact(text)});if(chat.length>200)chat.shift();}
function redact(s){let t=String(s);for(const v of Object.values(keys()))if(typeof v==='string'&&v.length>6)t=t.split(v).join('[已隐藏]');return t.replace(/Bearer\s+\S+/gi,'Bearer [已隐藏]');}
function log(s){for(const l of redact(s).split(/\r?\n/).filter(Boolean)){lines.push(l);if(lines.length>100)lines.shift();fs.appendFileSync(path.join(runtime,'launcher.log'),l+'\n');}}
const worlds=new WorldManager({root:dataRoot,sourceRoot:root,log});
worlds.prepare().catch(()=>{});   // owner 10-31: the server core is fetched as soon as the launcher opens, not when the first world starts
const coreRunning=()=>Boolean(core&&core.exitCode===null);
function worldSelection(c){
 if(c.connectionMode!=='local')return c;
 const w=worlds.get(c.selectedWorldId);return {...c,host:'127.0.0.1',port:w.port};
}
function externalSelection(c){return {...c,connectionMode:'external',selectedWorldId:'',...(c.externalConnection||{})};}
function validate(input){
 const c={...config(),...input};for(const k of ['apiKey','apiKeyConfigured','ttsKey','asrKey','ttsKeyConfigured','asrKeyConfigured','running'])delete c[k];
 if(!['external','local'].includes(c.connectionMode))throw Error('请选择本地世界或外部服务器。');
 if(c.connectionMode==='local'){const w=worlds.get(c.selectedWorldId);c.host='127.0.0.1';c.port=w.port;}
 if(!/^[a-zA-Z0-9_.-]+$/.test(c.host))throw Error('服务器地址请填写主机名或 IPv4 地址。');
 c.port=Number(c.port);c.mindserverPort=Number(c.mindserverPort);
 for(const n of [c.port,c.mindserverPort])if(!Number.isInteger(n)||n<1024||n>65535)throw Error('端口应为 1024–65535 的整数。');
 if(!/^[A-Za-z0-9_]{3,16}$/.test(c.botName))throw Error('游戏用户名需为 3–16 个英文字母、数字或下划线。');
 c.provider='deepseek';   // owner 10-30: DeepSeek only (the OpenAI-compatible choice is gone; an older saved "openai" becomes deepseek)
 const u=new URL(c.modelUrl);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search)throw Error('模型接口地址应为 http/https，不含账号或密钥参数。');
 if(typeof c.model!=='string'||!c.model.trim()||c.model.length>160)throw Error('请填写模型名。');
 if(String(c.customPrompt).length>16000)throw Error('补充提示词过长，请控制在 16000 字以内。');
 c.ttsProvider=c.asrProvider='bailian';   // owner 10-30: voice is Alibaba Cloud Bailian only, like the model is DeepSeek only
 for(const key of ['ttsUrl','asrUrl'])if(c[key]&&!['https:','http:'].includes(new URL(c[key]).protocol))throw Error('语音接口地址应为 http/https。');
 c.customPrompt=String(c.customPrompt);c.ownerName=String(c.ownerName||'').trim();if(!/^[A-Za-z0-9_]{3,16}$/.test(c.ownerName))throw Error('请填写你自己的游戏用户名（3–16 个英文字母、数字或下划线），她会把这个人当老大。');return c;
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function probe(p,host='127.0.0.1'){return new Promise(r=>{const s=net.createConnection({host,port:p});let done=false;const finish=x=>{if(done)return;done=true;s.destroy();r(x);};s.on('connect',()=>finish(true));s.on('error',()=>finish(false));s.setTimeout(1000,()=>finish(false));});}
function otherAgentOnline(c){return new Promise(resolve=>{const client=io('http://localhost:'+c.otherMindserverPort,{reconnection:false,forceNew:true,timeout:700});let timer;const finish=value=>{clearTimeout(timer);client.disconnect();resolve(value);};timer=setTimeout(()=>finish(false),1500);client.on('connect',()=>client.emit('listen-to-agents'));client.on('agents-status',a=>finish(a.some(x=>x.name===c.botName&&x.in_game)));client.on('connect_error',()=>finish(false));});}
async function stop(){
 operation++;
 if(!core)return;
 const child=core;if(child.exitCode!==null){core=null;socket?.disconnect();socket=null;return;}
 const connecting=Date.now()+5000;while(!socket?.connected&&child.exitCode===null&&Date.now()<connecting)await wait(50);
 if(child.exitCode!==null)return;
 if(!socket?.connected)throw Error('陪玩控制连接暂不可用，请稍后重试安全退出。');
 socket.emit('shutdown');const end=Date.now()+10000;
 while(child.exitCode===null&&Date.now()<end)await wait(100);
 if(child.exitCode===null)throw Error('陪玩仍在退出中，请稍后重试；未强制结束进程。');
 socket?.disconnect();socket=null;core=null;agents=[];state=null;log('陪玩已正常退出。');
}
async function start(){
 if(core&&core.exitCode===null)return;
 const current=++operation;
 if(dataRoot!==root)throw Error('预览环境不启动陪玩，只允许验证本地世界与界面。');
 const c=validate(config());
 if(c.connectionMode==='local')await worlds.start(c.selectedWorldId,{players:[c.botName,c.ownerName]});
 if(!await probe(c.port,c.host))throw Error('连接不到 Minecraft 服务器，请核对地址并启动服务器。');
 if(await otherAgentOnline(c))throw Error('另一个同名大肥鱼会话已经在线，请先从原会话退出，避免互相挤下线。');
 if(await probe(c.mindserverPort))throw Error('陪玩控制端口已被占用，请结束旧会话或修改 launcher.settings.json 中的 mindserverPort。');
 if(current!==operation)return;
 const profile=readJSON(path.join(root,'profiles/dafeiyu.json'));if(!profile.conversing)throw Error('大肥鱼默认人设不存在或未写完。');
 profile.name=c.botName;profile.model={api:c.provider,model:c.model,url:c.modelUrl};
 // release 10-31: her persona and examples were written with the owner JFors as her 老大 - the player who runs this launcher takes that place
 const asOwner=(t)=>String(t).replaceAll('JFors',c.ownerName);profile.conversing=asOwner(profile.conversing);profile.conversation_examples=(profile.conversation_examples||[]).map(e=>e.map(t=>({...t,content:asOwner(t.content)})));
 if(c.customPrompt.trim())profile.conversing+='\n\n主人补充的人设偏好：\n'+c.customPrompt;
 const generated=path.join(runtime,'profile.json');fs.writeFileSync(generated,JSON.stringify(profile,null,2));
 lastError='';agents=[];state=null;socket=io('http://localhost:'+c.mindserverPort,{reconnection:true});
 socket.on('connect',()=>socket.emit('listen-to-agents'));
 socket.on('agents-status',a=>{agents=a;});socket.on('bot-output',(name,message)=>{log(message);said(name,message);});
 socket.on('state-update',all=>{state=all?.[c.botName]||null;});   // health, food, position, time, current action - once a second
 const voice={...settings.voice,owner_name:c.ownerName,input_enabled:Boolean(c.voiceInput),hotkey:c.hotkey,tts:{...settings.voice?.tts,provider:c.ttsProvider,base_url:c.ttsUrl,model:c.ttsModel,voice:c.ttsVoice,api_key_env:c.ttsKeyEnv},asr:{...settings.voice?.asr,provider:c.asrProvider,base_url:c.asrUrl,model:c.asrModel,api_key_env:c.asrKeyEnv}};
 core=spawn(process.execPath,[path.join(root,'main.js')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,MINDSERVER_PORT:String(c.mindserverPort),SETTINGS_JSON:JSON.stringify({host:c.host,port:c.port,profiles:[generated],auto_open_ui:false,speak:Boolean(c.speak),voice})}});
 const child=core;for(const s of [child.stdout,child.stderr])s.on('data',b=>log(b.toString()));
 child.on('error',e=>{lastError=redact(e.message);log(lastError);});child.on('close',code=>{log('陪玩会话退出，代码 '+code);if(core===child){core=null;agents=[];state=null;socket?.disconnect();socket=null;}});
 const deadline=Date.now()+12000;while(!socket?.connected&&child.exitCode===null&&Date.now()<deadline)await wait(100);
 if(!socket?.connected)throw Error('陪玩已启动但控制连接尚未就绪，请查看运行日志；可稍后重试。');
 log('陪玩控制已就绪，正在进入世界。');
}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
async function body(req){let n=0,parts=[];for await(const b of req){n+=b.length;if(n>12*1024*1024)throw Error('文件过大，图片最大 8MB。');parts.push(b);}return JSON.parse(Buffer.concat(parts).toString()||'{}');}
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'};
function file(res,p,type){if(!fs.existsSync(p)){res.writeHead(404);res.end('未找到页面');return;}res.writeHead(200,{'Content-Type':type||mime[path.extname(p)]||'application/octet-stream','Cache-Control':'no-cache'});fs.createReadStream(p).pipe(res);}
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1:'+port),p=url.pathname;
  if(p==='/health')return json(res,200,{app:'dafeiyu-mc-launcher',root,dataRoot,requestedPort,port});
  if(p.startsWith('/api/')){
   if(req.headers.authorization!=='Bearer '+token)return json(res,401,{error:'本机会话已失效，请重新打开启动器。'});
   if(req.method==='GET'&&p==='/api/config'){const c=worldSelection(config());return json(res,200,{...c,apiKeyConfigured:Boolean(keys()[keyName(c.provider)]),ttsKeyConfigured:Boolean(keys()[c.ttsKeyEnv]),asrKeyConfigured:Boolean(keys()[c.asrKeyEnv]),running:coreRunning()});}
   if(req.method==='GET'&&p==='/api/status')return json(res,200,{running:coreRunning(),busy,agents,error:lastError,logs:lines,state,chat,world:worlds.status()});
   if(req.method==='GET'&&p==='/api/worlds')return json(res,200,{worlds:await worlds.list(),engine:worlds.engine(),server:worlds.status(),selected:config().selectedWorldId,mode:config().connectionMode,folder:worlds.dir});
   if(req.method!=='POST')return json(res,404,{error:'未找到接口。'});
   const data=await body(req);
   if(p.startsWith('/api/worlds/')){
    const action=p.slice('/api/worlds/'.length);
    if(busy)throw Error('正在处理上一步操作，请稍候。');
    if(coreRunning()&&!['open-folder','start'].includes(action))throw Error('请先停止陪玩，再操作世界存档。');
    busy=true;
    try{
     let result;
     if(action==='create')result=await worlds.create(data);
     else if(action==='import')result=await worlds.importWorld(data);
     else if(action==='update')result=await worlds.update(data.id,data);
     else if(action==='backup')result=await worlds.backup(data.id);
     else if(action==='restore')result=await worlds.restore(data.id,data.backupId);
     else if(action==='archive'||action==='unarchive'){
      result=await worlds.archive(data.id,action==='unarchive');
      if(action==='archive'&&config().selectedWorldId===data.id)fs.writeFileSync(configFile,JSON.stringify(externalSelection(config()),null,2));
     }
     else if(action==='engine')result=await worlds.setEngine(data);
     else if(action==='select'){
      if(worlds.child)throw Error('请先停止本地世界，再切换连接。');
      const c=config();
      if(data.external){Object.assign(c,externalSelection(c));}
      else{const w=worlds.get(data.id);if(c.connectionMode!=='local')c.externalConnection={host:c.host,port:c.port};c.connectionMode='local';c.selectedWorldId=w.id;c.host='127.0.0.1';c.port=w.port;}
      fs.writeFileSync(configFile,JSON.stringify(c,null,2));result={selected:c.selectedWorldId};
     }
     else if(action==='start'){
      if(coreRunning()&&data.id!==config().selectedWorldId)throw Error('陪玩正在另一个连接中，请先停止。');
      const c=config();result=await worlds.start(data.id,{agreeEula:data.agreeEula===true,players:[c.botName,c.ownerName]});
     }
     else if(action==='stop')result=await worlds.stop();
     else if(action==='open-folder'){
      const dir=data.id?worlds.get(data.id,!!data.archived).dir:worlds.dir;
      const child=spawn('explorer.exe',[dir],{windowsHide:true,stdio:'ignore'});child.on('error',()=>{});result={opened:true};
     }
     else return json(res,404,{error:'未找到世界操作。'});
     return json(res,200,result);
    }finally{busy=false;}
   }
   if(p==='/api/config'){
    const c=validate(data);if(core&&core.exitCode===null)throw Error('请先退出陪玩，再保存会影响运行的配置。');
    if(worlds.child&&(c.connectionMode!==config().connectionMode||c.selectedWorldId!==config().selectedWorldId))throw Error('请先停止本地世界，再切换连接。');
    if(data.apiKey||data.ttsKey||data.asrKey){const k=keys();if(data.apiKey)k[keyName(c.provider)]=String(data.apiKey).trim();if(data.ttsKey){c.ttsKeyEnv='DAFEIYU_TTS_API_KEY';k[c.ttsKeyEnv]=String(data.ttsKey).trim();}if(data.asrKey){c.asrKeyEnv='DAFEIYU_ASR_API_KEY';k[c.asrKeyEnv]=String(data.asrKey).trim();}fs.writeFileSync(path.join(dataRoot,'keys.json'),JSON.stringify(k,null,2));}
    fs.writeFileSync(configFile,JSON.stringify(c,null,2));return json(res,200,{saved:true});
   }
   if(p==='/api/wallpaper'){
    const c=config();if(data.default)c.wallpaper='default';else{
     const match=String(data.image).match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);if(!match)throw Error('请选择 PNG、JPEG 或 WebP 图片。');
     const image=Buffer.from(match[2],'base64');if(image.length>8*1024*1024)throw Error('图片最大 8MB。');
     const ext={png:'png',jpeg:'jpg',webp:'webp'}[match[1]];fs.writeFileSync(path.join(runtime,'wallpaper.'+ext),image);c.wallpaper='wallpaper.'+ext;
    }fs.writeFileSync(configFile,JSON.stringify(c,null,2));return json(res,200,{saved:true});
   }
   if(p==='/api/message'){if(!socket?.connected||!agents.some(a=>a.in_game))throw Error('大肥鱼还没有进入世界。');const message=String(data.message).slice(0,3000);socket.emit('send-message',config().botName,{from:config().ownerName,message});said('你',message);return json(res,200,{sent:true});}
   if(!['/api/start','/api/stop','/api/exit','/api/check'].includes(p))return json(res,404,{error:'未找到接口。'});
   if(busy&&(p==='/api/stop'||p==='/api/exit')){await stop();if(p==='/api/exit')await worlds.stop();json(res,200,{ok:true});if(p==='/api/exit')setTimeout(()=>process.exit(0),100);return;}
   if(busy)throw Error('正在处理上一步操作，请稍候。');busy=true;lastError='';   // an old failure is not shown after the next try
   try{
    if(p==='/api/start')await start();else if(p==='/api/stop'||p==='/api/exit'){await stop();if(p==='/api/exit')await worlds.stop();}else{const c=validate(config());if(!await probe(c.port,c.host))throw Error(c.connectionMode==='local'?'本地世界尚未启动，请从“世界”页启动。':'服务器未响应，请核对连接地址。');}
    json(res,200,{ok:true});if(p==='/api/exit')setTimeout(()=>{server.close();process.exit(0);},100);
   }finally{busy=false;}return;
  }
  if(p==='/wallpaper.png'){const c=config(),custom=/^wallpaper\.(png|jpg|webp)$/.test(c.wallpaper);return file(res,custom?path.join(runtime,c.wallpaper):path.join(root,'launcher/assets/default.png'));}
  const staticFiles={'/':'index.html','/app.js':'app.js','/worlds-ui.js':'worlds-ui.js','/style.css':'style.css'};if(staticFiles[p])return file(res,path.join(root,'launcher',staticFiles[p]));
  res.writeHead(404);res.end('未找到页面');
 }catch(e){const message=redact(e.message);if(['/api/start','/api/stop','/api/exit','/api/check'].includes(String(req.url).split('?')[0]))lastError=message;json(res,400,{error:message});}
});
server.on('error',async error=>{
 if(error.code!=='EADDRINUSE'){console.error(redact(error.message));process.exitCode=1;return;}
 const old=readJSON(sessionFile);if(old.root===root&&old.dataRoot===dataRoot){try{const r=await fetch(old.url.split('#')[0]+'api/status',{headers:{Authorization:'Bearer '+old.token},signal:AbortSignal.timeout(1500)});if(r.ok){console.log('DaFeiYu Launcher: '+old.url);process.exit(0);}}catch{}}
 if(++port>25699){console.error('没有空闲的本地启动器端口。');process.exit(1);}server.listen(port,'127.0.0.1');
});
server.on('listening',()=>{const url='http://127.0.0.1:'+port+'/#'+token;fs.writeFileSync(sessionFile,JSON.stringify({url,token,root,dataRoot,pid:process.pid},null,2));console.log('DaFeiYu Launcher: '+url);});
server.listen(port,'127.0.0.1');
