import {initWorlds} from './worlds-ui.js';
const token = location.hash.slice(1), $ = (s) => document.querySelector(s);
let config = {}, page = 'home', dirty = false, working = false, logView = 'chat', last = null, toastTimer;

async function api(route, data) {
  const r = await fetch('/api/' + route, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const j = await r.json();
  if (!r.ok) throw Error(j.error || '操作失败');
  return j;
}
function toast(text) {
  const t = $('#toast'); t.textContent = text; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 4500);
}

// [key, label, type, hint]
const pages = {
  player: { title: '连接', description: '她要进入的 Minecraft 服务器。', groups: [
    { fields: [['connectionMode', '连接方式', 'connection-select'], ['host', '服务器地址'], ['port', '端口', 'number'], ['botName', '她的游戏用户名', 'text', '3–16 位英文字母、数字或下划线。'], ['ownerName', '你的游戏用户名', 'text', '必填。她会把这个名字的玩家当老大。']] },
    { title: '高级', fields: [['mindserverPort', '控制端口', 'number', '一般不用改。']] },
  ] },
  models: { title: '模型', description: '她用来思考和说话的文字模型。', groups: [
    { fields: [['modelUrl', 'DeepSeek API 地址', 'url'], ['model', '模型名'], ['apiKey', 'DeepSeek API Key', 'password', '只保存在这台电脑上。']] },
  ] },
  voice: { title: '语音', description: '', groups: [
    { fields: [['speak', '语音播报', 'checkbox'], ['voiceInput', '按住说话', 'checkbox', '游戏窗口在前台时按住按键说话。'], ['hotkey', '说话按键', 'text', 'MOUSE4、MOUSE5 或一个字母。']] },
    { title: '播报', fields: [['ttsUrl', 'API 地址', 'url'], ['ttsModel', '模型'], ['ttsVoice', '音色'], ['ttsKey', '百炼 API Key', 'password']] },
    { title: '识别', fields: [['asrUrl', 'API 地址', 'url'], ['asrModel', '模型'], ['asrKey', '百炼 API Key', 'password']] },
  ] },
  prompt: { title: '人设', description: '补充她的性格和称呼；原来的设定不会变。', groups: [
    { fields: [['customPrompt', '补充设定', 'textarea']] },
  ] },
};
const options = {
  'connection-select': [['external','外部服务器'],['local','本地世界（在“我的世界”中选择）']],
};

function mark() { dirty = true; $('#dirty').textContent = '有未保存的修改'; $('#dirty').classList.add('dirty'); }
function field(key, label, type = 'text', hint) {
  const row = document.createElement('div'); row.className = 'field' + (type === 'textarea' ? ' tall' : '');
  const id = 'f-' + key, l = document.createElement('label'); l.htmlFor = id; l.textContent = label;
  let input;
  if (type === 'textarea') input = document.createElement('textarea');
  else if (options[type]) { input = document.createElement('select'); for (const [v, t] of options[type]) input.append(new Option(t, v)); }
  else { input = document.createElement('input'); input.type = type; }
  input.id = id; input.name = key;
  if(page==='player'&&config.connectionMode==='local'&&['host','port'].includes(key))input.disabled=true;
  if (type === 'checkbox') input.checked = Boolean(config[key]);
  else input.value = type === 'password' ? '' : config[key] ?? '';
  if (type === 'password') input.placeholder = config[key + 'Configured'] ? '已填写，留空则不改' : '未填写';
  input.oninput = input.onchange = () => { config[key] = type === 'checkbox' ? input.checked : input.value; mark();if(key==='connectionMode'){if(config.connectionMode==='external'&&config.externalConnection)Object.assign(config,config.externalConnection);render();} };
  row.append(l, input);
  if (hint) { const h = document.createElement('div'); h.className = 'hint'; h.textContent = hint; row.append(h); }
  return row;
}
function render() {
  document.querySelectorAll('.page').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.side nav button').forEach((x) => x.classList.toggle('active', x.dataset.page === page));
  const p = pages[page];
  if (!p) { $('#' + page).classList.add('active'); if (page === 'logs') drawLog();if(page==='worlds')worldUI.load(); return; }
  $('#settings').classList.add('active');
  $('#page-title').textContent = p.title; $('#page-description').textContent = p.description; $('#page-description').hidden = !p.description;
  const form = $('#fields'); form.replaceChildren();
  if(page==='player'&&config.connectionMode==='local'){
    const box=document.createElement('div');box.className='local-connection';box.textContent='已选择本地世界：'+(worldUI.selectedName()||'请先选择世界')+'。地址和端口会自动填好。';
    const b=document.createElement('button');b.className='btn small';b.type='button';b.textContent='选择或管理世界';b.onclick=()=>{page='worlds';render();};box.append(document.createElement('br'),b);form.append(box);
  }
  for (const g of p.groups) {
    const box = document.createElement('div'); box.className = 'group';
    if (g.title) { const h = document.createElement('h3'); h.textContent = g.title; box.append(h); }
    for (const f of g.fields) box.append(field(...f));
    form.append(box);
  }
  if (page === 'prompt') {
    const row = document.createElement('div'); row.className = 'row-actions';
    const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'btn secondary'; reset.textContent = '清空补充设定';
    reset.onclick = () => { config.customPrompt = ''; mark(); render(); toast('已清空，保存后生效。'); };
    row.append(reset); form.lastChild.append(row);
  }
  $('#dirty').textContent = dirty ? '有未保存的修改' : '已保存'; $('#dirty').classList.toggle('dirty', dirty);
}

async function save() { await api('config', config); config = await api('config'); dirty = false; render(); toast('已保存。'); }
async function run(fn) {
  if (working) return; working = true;
  for (const id of ['start', 'stop', 'restart', 'check', 'save']) $('#' + id).disabled = true;
  try { await fn(); } catch (e) { toast(e.message); }
  finally { working = false; for (const id of ['start', 'stop', 'restart', 'check', 'save']) $('#' + id).disabled = false; await refresh(); }
}

document.querySelectorAll('[data-page]').forEach((b) => b.onclick = () => { page = b.dataset.page; render(); });
$('#fields').onsubmit = (e) => e.preventDefault();
$('#save').onclick = () => run(save);
$('#start').onclick = () => run(async () => { if (dirty) await save(); await api('start', {}); toast('正在进入世界。'); });
$('#stop').onclick = () => run(async () => { await api('stop', {}); toast('已停止。'); });
$('#restart').onclick = () => run(async () => { await api('stop', {});if (dirty) await save(); await api('start', {}); toast('已重启，正在进入世界。'); });
$('#to-log').onclick = () => { page = 'logs'; logView = 'raw'; document.querySelectorAll('[data-log]').forEach((x) => x.classList.toggle('active', x.dataset.log === 'raw')); render(); drawLog(true); };
$('#check').onclick = () => run(async () => { if (dirty) await save(); await api('check', {}); toast('服务器可以连接。'); });

function wallpaper() { const u = '/wallpaper.png?t=' + Date.now(); $('#home').style.backgroundImage = `url(${u})`; $('#wallpaper-preview').src = u; }
$('#wallpaper-default').onclick = () => run(async () => { await api('wallpaper', { default: true }); config.wallpaper = 'default'; wallpaper(); });
$('#wallpaper-file').onchange = () => run(async () => {
  const f = $('#wallpaper-file').files[0]; if (!f) return;
  if (f.size > 8 * 1024 * 1024) throw Error('图片不能超过 8 MB。');
  const image = await new Promise((r, j) => { const reader = new FileReader(); reader.onload = () => r(reader.result); reader.onerror = j; reader.readAsDataURL(f); });
  await api('wallpaper', { image }); config.wallpaper = (await api('config')).wallpaper; wallpaper(); $('#wallpaper-file').value = '';
});

document.querySelectorAll('[data-log]').forEach((b) => b.onclick = () => { logView = b.dataset.log; document.querySelectorAll('[data-log]').forEach((x) => x.classList.toggle('active', x === b)); drawLog(true); });
$('#chat-form').onsubmit = (e) => { e.preventDefault(); run(async () => { const message = $('#chat').value.trim(); if (message) { await api('message', { message }); $('#chat').value = ''; } }); };

const clock = (ticks) => { const m = Math.floor(((ticks + 6000) % 24000) * 60 / 1000); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const hhmm = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
const dimension = { 'minecraft:overworld': '主世界', 'minecraft:the_nether': '下界', 'minecraft:the_end': '末地', overworld: '主世界', the_nether: '下界', the_end: '末地' };
function doing(a) {
  if (!a) return '';
  if (a.kind === 'acting') {
    const current = String(a.current || ''), key = current.replace(/^(action:|mode:|!)/, '');
    return actionNames[key] || modeNames[key] || current;
  }
  return { thinking: '在想下一步做什么', chatting: '聊天', idle: '空闲', stopped: '待命（等你吩咐）' }[a.kind] || a.current;
}
const actionNames = {
  collectBlocks:'采集', goToCoordinates:'走路', goToPlayer:'去找你', goToRememberedPlace:'去记住的地点', followPlayer:'跟随', moveAway:'走开',
  craftRecipe:'合成', smeltItem:'熔炼', clearFurnace:'取出炉中物品', goToBed:'睡觉', buildHouse:'建房', buildHouseHere:'建房', fish:'钓鱼', boatTo:'划船',
  fight:'战斗', attack:'战斗', attackPlayer:'战斗', shoot:'射箭', block:'举盾', retreat:'后退', consume:'吃喝', equip:'换装备',
  givePlayer:'交东西', putInChest:'存东西', takeFromChest:'取东西', viewChest:'查看箱子', discard:'丢东西', placeHere:'放方块', tillAndSow:'耕种',
  searchForBlock:'寻找方块', searchForEntity:'寻找生物', lookAtPlayer:'看着你', lookAtPosition:'张望', stay:'等待', newAction:'执行自己的动作',
  useSkill:'使用学会的技能', swimUp:'向上游', swimDown:'向下游', goToSurface:'走向地面', digDown:'向下挖', pillarUp:'向上搭',
  teleportToPlayer:'传送到你身边', teleportToSurface:'传送到地面', useOn:'使用物品', shear:'剪羊毛', milk:'挤牛奶',
};
const modeNames = {
  self_preservation:'自保', self_defense:'自卫', cowardice:'避开敌人', hunting:'狩猎', item_collecting:'捡东西', torch_placing:'放火把',
  unstuck:'脱困', auto_eat:'吃东西', auto_light:'放火把', auto_follow:'跟随',
  creeper_dodge:'避开苦力怕', water_clutch:'落地水', danger_notice:'观察危险', elbow_room:'让开一点', idle_staring:'张望', cheat:'管理员辅助',
};

function drawLog(force) {
  const box = $('#log-output'), atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.classList.toggle('raw', logView === 'raw');
  if (!last) return;
  if (logView === 'raw') box.textContent = last.logs.length ? last.logs.join('\n') : '还没有日志。';
  else {
    box.replaceChildren();
    if (!last.chat?.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = '她还没说话。启动后，她说的话和你从这里发的话会显示在这里。'; box.append(e); }
    for (const m of last.chat || []) {
      const line = document.createElement('div'); line.className = 'line' + (m.who === '你' ? ' me' : '');
      const t = document.createElement('span'); t.className = 'time'; t.textContent = hhmm(m.at);
      const w = document.createElement('span'); w.className = 'who'; w.textContent = m.who === '你' ? '你' : '她';
      line.append(t, w, document.createTextNode(m.text)); box.append(line);
    }
  }
  if (atEnd || force) box.scrollTop = box.scrollHeight;
}

async function refresh() {
  try {
    const s = await api('status'); last = s;worldUI.updateServer(s.world);
    const inGame = s.running && s.agents.some((a) => a.in_game), st = s.state?.gameplay;
    const label = inGame ? '在线' : s.running ? '正在进入世界' : '未启动';
    const cls = s.error && !s.running ? 'bad' : inGame ? 'on' : s.running ? 'wait' : '';
    $('#status').textContent = label; $('#side-state').textContent = label;
    for (const d of ['#state-dot', '#side-dot']) $(d).className = 'dot ' + cls;
    $('#target').textContent = `${config.botName || 'DaFeiYu'} · 模型 ${config.model || ''}`;
    $('#home-mode').textContent=config.connectionMode==='local'?'本地世界':'外部服务器';
    const worldName = config.connectionMode==='local' ? worldUI.selectedName() : (config.host ? config.host+(config.port ? ':'+config.port : '') : '');
    $('#home-world-name').textContent=worldName; $('#home-world-name').hidden=!worldName;
    if(!s.running&&s.world?.running){$('#status').textContent=s.world.message;$('#side-state').textContent='本地服务器运行中';}
    $('#vitals').hidden = !(inGame && st);
    if (inGame && st) {
      $('#v-health').textContent = `${st.health} / 20`; $('#v-food').textContent = `${st.hunger} / 20`;
      $('#v-pos').textContent = `${Math.round(st.position.x)}, ${Math.round(st.position.y)}, ${Math.round(st.position.z)}` + (dimension[st.dimension] && st.dimension !== 'minecraft:overworld' && st.dimension !== 'overworld' ? ' · ' + dimension[st.dimension] : '');
      $('#v-time').textContent = clock(st.timeOfDay);
      $('#v-doing').textContent = doing(s.state.action);
    }
    const said = [...(s.chat || [])].reverse().find((m) => m.who !== '你');
    $('#last-said').hidden = !(inGame && said); if (said) $('#last-said').textContent = `${hhmm(said.at)}  她：${said.text}`;
    $('#error-row').hidden = !s.error; $('#error').textContent = s.error || '';
    $('#start').hidden = s.running; $('#stop').hidden = !s.running; $('#restart').hidden = !s.running;
    if (page === 'logs') drawLog();
  } catch (e) {
    $('#status').textContent = '和启动器断开了，请重新打开。'; $('#error-row').hidden = false; $('#error').textContent = e.message;
  }
}

const worldUI=initWorlds({api,toast,run,beforeSelection:async()=>{if(dirty)await save();},selectionChanged:async()=>{if(!dirty)config=await api('config');await refresh();},go:p=>{page=p;render();}});
try { config = await api('config');await worldUI.load(); render(); wallpaper(); await refresh(); window.launcherReady = true; setInterval(refresh, 1500); }
catch (e) { toast(e.message); }
