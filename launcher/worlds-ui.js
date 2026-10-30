const $=s=>document.querySelector(s);
const modes={survival:'生存',creative:'创造',adventure:'冒险',spectator:'旁观'};
const difficulties={peaceful:'和平',easy:'简单',normal:'普通',hard:'困难'};
const types={normal:'默认地形',flat:'超平坦',large_biomes:'巨型生物群系',amplified:'放大化'};
const date=t=>new Date(t).toLocaleString('zh-CN',{hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const icon=()=>{const e=document.createElementNS('http://www.w3.org/2000/svg','svg'),use=document.createElementNS(e.namespaceURI,'use');use.setAttribute('href','#i-world');e.append(use);return e;};
const button=(text,fn,cls='btn')=>{const b=node('button',cls,text);b.type='button';b.onclick=fn;return b;};
const p=text=>node('p','',text);
export function initWorlds({api,toast,run,selectionChanged,beforeSelection,go}){
 let state=null,filter='active',query='',request=0,dialogBusy=false;
 const dialog=$('#world-dialog'),content=$('#world-dialog-content'),form=$('#world-dialog-form');
 function close(){if(!dialogBusy)dialog.close();}
 dialog.querySelectorAll('.dialog-close').forEach(b=>b.onclick=close);
 dialog.addEventListener('cancel',e=>{if(dialogBusy)e.preventDefault();});
 function field(name,label,value='',options){
  const l=node('label','',label),input=node(options?'select':'input');input.name=name;
  if(options)for(const [v,t]of Object.entries(options))input.append(new Option(t,v));
  input.value=value;l.append(input);return l;
 }
 function check(name,text,checked=false){const l=node('label','check-label'),i=node('input');i.type='checkbox';i.name=name;i.checked=checked;l.append(i,node('span','',text));return l;}
 function show(title,submit,build,action){
  content.replaceChildren();$('#world-dialog-title').textContent=title;
  $('#world-dialog-submit').textContent=submit;$('#world-dialog-error').hidden=true;build(content);dialog.showModal();
  form.onsubmit=async e=>{e.preventDefault();if(dialogBusy)return;dialogBusy=true;
   dialog.querySelectorAll('button').forEach(b=>b.disabled=true);
   try{await action(new FormData(form));dialogBusy=false;dialog.close();await load();await selectionChanged();}
   catch(e){$('#world-dialog-error').textContent=e.message;$('#world-dialog-error').hidden=false;}
   finally{dialogBusy=false;dialog.querySelectorAll('button').forEach(b=>b.disabled=false);}
  };
 }
 function worldFields(c,w={},editing=false,importing=false){
  const name=field('name','世界名称',w.name||'');name.lastChild.required=true;name.lastChild.maxLength=50;name.lastChild.placeholder='例如：和大肥鱼的第一天';c.append(name);
  if(!importing){const row=node('div','form-grid');row.append(field('gamemode','游戏模式',w.gamemode||'survival',modes),field('difficulty','难度',w.difficulty||'easy',difficulties));c.append(row);}
  if(!editing&&!importing){const row=node('div','form-grid');row.append(field('seed','世界种子（可留空）',''),field('type','地形','normal',types));c.append(row);}
  const advanced=node('details');advanced.append(node('summary','','高级设置'));
  const row=node('div','form-grid'),port=field('port','服务器端口',w.port||'');port.lastChild.type='number';port.lastChild.min='1024';port.lastChild.max='65535';port.lastChild.placeholder='自动分配';row.append(port);advanced.append(row);
  if(!editing&&!importing)advanced.append(check('structures','生成村庄、遗迹等建筑',true));
  advanced.append(check('pvp','允许玩家间伤害',w.pvp||false));c.append(advanced);
  if(!editing){const agree=check('agreeEula','我已阅读并同意 Minecraft EULA（启动服务器前需要同意）');const a=node('a','','阅读协议 ↗');a.href='https://aka.ms/MinecraftEULA';a.target='_blank';a.rel='noopener';agree.lastChild.append(' ',a);c.append(agree);}
 }
 function data(f){return {name:f.get('name'),seed:f.get('seed')||'',gamemode:f.get('gamemode')||'survival',difficulty:f.get('difficulty')||'easy',type:f.get('type')||'normal',port:f.get('port')||undefined,structures:f.has('structures'),pvp:f.has('pvp'),agreeEula:f.has('agreeEula')};}
 function create(){show('新建世界','创建世界',c=>{worldFields(c);c.append(p('创建后会设为当前世界；地形在首次启动服务器时生成。'));},async f=>{await beforeSelection();const w=await api('worlds/create',data(f));await api('worlds/select',{id:w.id});toast('世界已创建，返回启程页即可启动陪玩。');});}
 function importWorld(){show('导入已有存档','复制并导入',c=>{
  c.append(p('选择包含 level.dat 的存档文件夹。启动器会复制到 worlds，原存档不会移动或覆盖。'));
  const source=field('source','存档文件夹的完整路径');source.lastChild.required=true;source.lastChild.placeholder='D:\\Minecraft\\saves\\我的世界';c.append(source);worldFields(c,{},false,true);
  const closed=check('sourceClosed','源游戏和源服务器已正常关闭，存档不在写入中');closed.firstChild.required=true;c.append(closed);
 },async f=>{await beforeSelection();const w=await api('worlds/import',{...data(f),source:f.get('source'),sourceClosed:f.has('sourceClosed')});await api('worlds/select',{id:w.id});toast('存档已复制，原文件保持不变。');});}
 function edit(w){show('世界设置','保存修改',c=>{worldFields(c,w,true);if(w.generated)c.append(p('存档已生成，种子与地形保持原样。游戏模式默认值不会强制覆盖已有玩家模式。'));},async f=>{const d=data(f);for(const k of ['seed','type','structures','agreeEula'])delete d[k];await api('worlds/update',{id:w.id,...d});toast('世界设置已保存。');});}
 function confirm(title,text,label,action){show(title,label,c=>c.append(p(text)),action);}
 function start(w){
  if(!w.eulaAccepted){show('首次启动世界','同意并启动',c=>{c.append(p('服务器将在本机运行。首次生成地形可能需要一些时间。'));
   const agree=check('agreeEula','我已阅读并同意 Minecraft EULA');agree.firstChild.required=true;c.append(agree);const a=node('a','','阅读 Minecraft EULA ↗');a.href='https://aka.ms/MinecraftEULA';a.target='_blank';a.rel='noopener';c.append(a);
  },async f=>{await api('worlds/start',{id:w.id,agreeEula:f.has('agreeEula')});toast('世界已就绪，可从多人游戏连接 127.0.0.1:'+w.port);});}
  else task(async()=>{await api('worlds/start',{id:w.id});toast('世界已就绪：127.0.0.1:'+w.port);});
 }
 async function task(fn){await run(async()=>{await fn();await load();await selectionChanged();});}
 function render(){
  if(!state)return;const worlds=state.worlds,server=state.server,locked=server.running||server.busy;
  const selected=worlds.find(w=>w.id===state.selected&&!w.archived),banner=$('#world-connection');banner.replaceChildren();
  const text=node('div');text.append(node('strong','',state.mode==='local'&&selected?'当前世界 · '+selected.name:'当前使用外部服务器'),node('span','',state.mode==='local'&&selected?'　127.0.0.1:'+selected.port:'　现有连接配置已保留'));
  banner.append(text,button(state.mode==='local'?'查看连接':'设置连接',()=>go('player'),'link'));
  const list=$('#world-list');list.replaceChildren();
  const shown=worlds.filter(w=>w.archived===(filter==='archived')&&w.name.toLowerCase().includes(query.toLowerCase()));$('#world-count').textContent=worlds.filter(w=>!w.archived).length;
  if(!shown.length){const empty=node('div','world-empty');empty.append(icon(),node('h3','',query?'没有找到这个世界':filter==='archived'?'还没有归档的世界':'还没有本地世界。'),p(query?'换个名称再找找。':filter==='archived'?'归档会保留存档，随时可以取回。':'新建一个，或导入已有存档。'));if(filter==='active'&&!query)empty.append(button('＋ 创建第一个世界',create,'btn primary'));list.append(empty);}
  for(const w of shown){
   const card=node('article','world-card'+(selected?.id===w.id?' selected':''));card.dataset.worldId=w.id;
   const art=node('div','world-art '+w.type);art.append(icon());const info=node('div'),title=node('div','world-title');title.append(node('h3','',w.name));
   if(w.active)title.append(node('span','pill green',server.phase==='ready'?'运行中':'正在处理'));
   else if(selected?.id===w.id)title.append(node('span','pill','当前世界'));
   else if(!w.generated)title.append(node('span','pill','待生成'));
   info.append(title);const meta=node('div','world-meta');for(const t of [modes[w.gamemode]+' · '+difficulties[w.difficulty],w.source==='import'?'导入的存档':types[w.type],'端口 '+w.port,w.lastPlayed?'上次 '+date(w.lastPlayed):'创建 '+date(w.createdAt)])meta.append(node('span','',t));info.append(meta);
   const actions=node('div','world-actions');
   const add=(label,fn,cls='btn',disabled=false)=>{const b=button(label,fn,cls);b.disabled=disabled;actions.append(b);};
   if(w.archived)add('从归档取回',()=>task(async()=>{await api('worlds/unarchive',{id:w.id});toast('世界已取回。');}),'btn primary',locked);
   else{
    add(selected?.id===w.id?'已设为当前':'设为当前',()=>task(async()=>{await beforeSelection();await api('worlds/select',{id:w.id});toast('当前世界已切换。');}),'btn'+(selected?.id===w.id?'':' primary'),locked||selected?.id===w.id);
    if(w.active)add('保存并停服',()=>task(async()=>{await api('worlds/stop',{});toast('世界已保存并关闭。');}),'btn',server.busy);
    else add('启动世界',()=>start(w),'btn',locked);
    add('设置',()=>edit(w),'btn',locked);add('备份',()=>task(async()=>{await api('worlds/backup',{id:w.id});toast('备份已保存。');}),'btn',locked);
    add('归档',()=>confirm('归档这个世界？','将「'+w.name+'」移到归档目录，存档和备份都会保留，随时可以取回。','归档世界',async()=>{await api('worlds/archive',{id:w.id});toast('世界已归档。');}),'btn danger last-action',locked);
   }
   add('文件夹',()=>task(()=>api('worlds/open-folder',{id:w.id,archived:w.archived})),'btn');info.append(actions);card.append(art,info);
   if(!w.archived&&w.backups.length){const detail=node('details','world-detail');detail.append(node('summary','','备份历史 · '+w.backups.length+' 份'));const ul=node('ul');for(const b of w.backups){const li=node('li');li.append(node('span','',date(b.createdAt)+' · '+(b.bytes/1024/1024).toFixed(1)+' MB'+(b.reason==='before-restore'?' · 恢复前快照':'')));const restore=button('恢复',()=>confirm('恢复这份备份？','恢复到 '+date(b.createdAt)+' 的存档。当前状态会先自动备份，恢复失败会回滚。','备份当前并恢复',async()=>{await api('worlds/restore',{id:w.id,backupId:b.id});toast('备份已恢复，恢复前的状态也已保存。');}),'btn small');restore.disabled=locked;li.append(restore);ul.append(li);}detail.append(ul);card.append(detail);}
   if(w.active||(server.id===w.id&&server.phase==='error')){const detail=node('details','world-detail');detail.open=server.phase!=='ready';detail.append(node('summary','','服务器状态 · '+server.message));const log=node('pre','world-server-log',server.logs.join('\n'));detail.append(log);card.append(detail);}
   list.append(card);
  }
  $('#engine-state').textContent=state.engine.available?'核心已找到':'需要选择核心';$('#world-storage').textContent='存档位置 · '+state.folder;
  if(!$('#engine-form').contains(document.activeElement))for(const key of ['jar','java','memoryMb'])$('#engine-form').elements[key].value=state.engine[key];
  $('#engine-form').querySelectorAll('input,button').forEach(e=>e.disabled=locked);
 }
 async function load(){const n=++request;try{const s=await api('worlds');if(n!==request)return;state=s;render();return s;}catch(e){toast(e.message);}}
 $('#world-create').onclick=create;$('#world-import').onclick=importWorld;$('#world-folder').onclick=()=>task(()=>api('worlds/open-folder',{}));
 $('#world-search').oninput=e=>{query=e.target.value;render();};
 document.querySelectorAll('[data-world-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.worldFilter;document.querySelectorAll('[data-world-filter]').forEach(x=>x.classList.toggle('active',x===b));render();});
 $('#engine-form').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target);task(async()=>{await api('worlds/engine',Object.fromEntries(f));toast('本地服务器设置已保存。');});};
 return {load,updateServer(server){if(state&&JSON.stringify(state.server)!==JSON.stringify(server)){state.server=server;if($('#worlds').classList.contains('active')&&!dialog.open&&!state.server.busy)render();}},selectedName(){return state?.worlds.find(w=>w.id===state.selected&&!w.archived)?.name;}};
}
