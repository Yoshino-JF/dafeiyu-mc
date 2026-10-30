import { History } from './history.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { loadModeChoices } from './mode_choices.js';
import { initBot, isHostile } from '../utils/mcdata.js';
import { isAlive } from './library/world.js';
import { takeUnseen, takeOnce } from './tool_notes.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands, availableCommandNames, getCommand } from './commands/index.js';
import { logDecision, logLifecycle, logAct, logPos } from './dafeiyu_log.js';
import { guardDig } from './protect.js';
import { attachWaterClutch } from './library/water_clutch.js';
import { attachAirWatch } from './library/swim.js';
import { noteRespawn } from './respawn.js';
import { attachBlackbox } from './blackbox.js';
import { snapshot } from './action_facts.js';
import { startVoiceInput } from '../voice/index.js';
import { getLearned } from './learned_skills.js';
import { StuckHints } from './stuck_hints.js';
import { ActionManager, watchKills } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank, allPlaceNames, findPlace } from './memory_bank.js';
import { MemoryS, nearbyDeathLine } from './memory/index.js';
import { isTestBot } from './memory/promises.js';
import { setActObserver } from './dafeiyu_log.js';
import { SelfPrompter } from './self_prompter.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import { addBrowserViewer } from './vision/browser_viewer.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import settings from './settings.js';
import { Task } from './tasks/tasks.js';
import { speak, spokenText } from './speak.js';
import { Houses } from './houses.js';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';

// DeepSeek's native tool-call markup (<｜｜DSML｜｜ invoke name="viewChest">…). A single call without parameters becomes the !command
// it clearly meant; anything else is dropped from the reply (the text before the markup stays), so markup never reaches chat.
export function fromDsml(res) {
    const start = String(res).search(/<[^>\n]*DSML/);
    if (start < 0) return { res };
    const before = res.slice(0, start).trim(), markup = res.slice(start);
    const calls = [...markup.matchAll(/invoke\s+name="([A-Za-z_]+)"/g)].map((m) => m[1]);
    if (calls.length === 1 && !/parameter/i.test(markup)) return { res: (before + '\n!' + calls[0]).trim(), converted: calls[0] };
    // final-68 11:0x: <…DSML… parameter name="name" string="true">洞屋</…parameter> was dropped and she never went home. One call with
    // parameters becomes !cmd(args) in the command's own parameter order; string="true" values are quoted, the rest kept as numbers.
    if (calls.length === 1 && getCommand('!' + calls[0])) {
        const given = Object.fromEntries([...markup.matchAll(/parameter\s+name="([A-Za-z_]+)"([^>]*)>([\s\S]*?)<\/[^>]*parameter\s*>/gi)]
            .map(([, k, attrs, v]) => [k, /string="true"/i.test(attrs) || !/^-?\d+(\.\d+)?$|^(true|false)$/.test(v.trim()) ? JSON.stringify(v.trim()) : v.trim()]));
        const names = Object.keys(getCommand('!' + calls[0]).params || {});
        if (names.length && names.every((n) => n in given))
            return { res: (before + `\n!${calls[0]}(${names.map((n) => given[n]).join(', ')})`).trim(), converted: calls[0] };
    }
    return { res: before, dropped: true };
}

export class Agent {
    async start(load_mem=false, init_message=null, count_id=0) {
        this.last_sender = null;
        this.count_id = count_id;
        this._disconnectHandled = false;

        // Initialize components
        this.actions = new ActionManager(this);
        this.prompter = new Prompter(this, settings.profile);
        this.name = (this.prompter.getName() || '').trim();
        console.log(`Initializing agent ${this.name}...`);
        
        // Validate Name Format
        // connection_handler now ensures the message has [LoginGuard] prefix
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
            return;
        }
        
        this.history = new History(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();
        // dafeiyu (PLAN S): long-term memory. Failures become lessons, places go into her place book, what she says into the raw record.
        this.memoryS = new MemoryS({ dir: `./bots/${this.name}/memory`, ownerName: settings.voice?.owner_name || '老大' });   // release 10-31: no owner configured -> her 老大 stays 老大, not the old owner's name
        // #3168: semantic dedupe for owner facts. The profile's embedding model is handed in once; if it is missing or has
        // no embed(), memory falls back to the character/topic rules on its own.
        try {
            const emb = this.prompter?.embedding_model;
            if (typeof emb?.embed === 'function') this.memoryS.setEmbedder((text) => emb.embed(text));
        } catch { /* never fail startup over dedupe */ }
        // #3195: a promise clock pauses while the owner is not in the game (Claude review: memory exposed this but nothing called it).
        // With no owner_name configured, presence is unknown and memory keeps its default (treated as online).
        const ownerName = settings.voice?.owner_name;
        if (ownerName) this.memoryS?.setOwnerPresence?.(() => !!this.bot?.players?.[ownerName]);
        // #3262: memory sorting is only offered when she is safe - enough health and nothing hostile within 16 blocks - never in danger
        this.memoryS?.setTriageAllowed?.(() => {
            const b = this.bot;
            if (!b?.entity || b.health < 12) return false;
            return !Object.values(b.entities || {}).some((e) => e !== b.entity && isHostile(e) && e.position?.distanceTo(b.entity.position) < 16);
        });
        // D6 (#3282): the dawn summary is checked against what is really true now - her inventory, this world's place book, where
        // she stands - so it cannot carry "5 iron ingots" from memory. No bot yet means null: memory then leaves the numbers out.
        this.memoryS?.setFactsProvider?.(() => {
            const b = this.bot;
            if (!b?.entity) return null;
            const counts = {};
            for (const it of b.inventory?.items?.() || []) counts[it.name] = (counts[it.name] || 0) + it.count;
            const here = this.memoryS.worldStatus?.()?.key;
            const places = allPlaceNames(this).filter((n) => { const w = this.memoryS.placeWorld?.(n); return !w || !here || w === here; })
                .map((name) => { const p = findPlace(this, name); return p ? { name, x: Math.round(p[0]), y: Math.round(p[1]), z: Math.round(p[2]) } : null; }).filter(Boolean);
            const pos = b.entity.position;
            return { day: this.memoryS.day?.(), inventory: Object.entries(counts).map(([item, count]) => ({ item, count })), places, pos: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } };
        });
        this.stuckHints = new StuckHints(this);   // dafeiyu 2026-10-26: suggestions when she stays stuck, never an action
        setActObserver((entry) => { if (entry.ok === false) this.memoryS.noteFailure({ kind: entry.kind, reason: entry.reason, args: entry.args }); });
        this.self_prompter = new SelfPrompter(this);
        convoManager.initAgent(this);
        await this.prompter.initExamples();

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }
        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        blacklistCommands(this.blocked_actions);

        console.log(this.name, 'logging into minecraft...');
        this.bot = initBot(this.name);
        // fight-6 14:32: a reply with a tab in it ("\t——行吧…") got her kicked - "Illegal characters in chat" - and the process restarted.
        // The server refuses control characters and the section sign in chat; every chat path goes through these two, so clean here.
        // (the chat plugin only defines them once the bot is injected - wrap on login, before any action guard wraps them in turn)
        this.bot.once('login', () => {
            for (const fn of ['chat', 'whisper']) {
                if (typeof this.bot[fn] !== 'function') continue;
                const send = this.bot[fn].bind(this.bot);
                this.bot[fn] = (...args) => { const i = args.length - 1; args[i] = String(args[i] ?? '').replace(/[\x00-\x1F\x7F§]+/g, ' ').replace(/ {2,}/g, ' ').trim(); return args[i] ? send(...args) : undefined; };
            }
        });
        // world identity for world-scoped memory (owner 10-26): the server's hashed seed arrives in the login/respawn packets
        const keepSeed = (p) => { const h = p?.hashedSeed ?? p?.worldState?.hashedSeed; if (h !== undefined && h !== null) this._hashedSeed = String(h); };
        this.bot._client.on('login', keepSeed);
        this.bot._client.on('respawn', keepSeed);
        
        // Connection Handler
        const onDisconnect = (event, reason) => {
            if (this._disconnectHandled) return;
            this._disconnectHandled = true;

            // Log and Analyze
            // handleDisconnection handles logging to console and server
            const { type } = handleDisconnection(this.name, reason);
     
            process.exit(1);
        };
        
        // Bind events
        this.bot.once('kicked', (reason) => onDisconnect('Kicked', reason));
        this.bot.once('end', (reason) => onDisconnect('Disconnected', reason));
        this.bot.on('error', (err) => {
            if (String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED')) {
                 onDisconnect('Error', err);
            } else {
                 log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
            }
        });

        initModes(this);
        // her own earlier !setMode choices win over the profile defaults (mode_choices.js)
        try { const mine = loadModeChoices(this.name); if (Object.keys(mine).length) { this.bot.modes.loadJson(mine); console.log('[modes] restored her own choices', JSON.stringify(mine)); } } catch { /* defaults stay */ }

        this.bot.on('login', () => {
            console.log(this.name, 'logged in!');
            serverProxy.login();
            
            // Skin: dafeiyu 2026-10-26 - a SkinsRestorer skin name (profile.skin.name, e.g. "whale_maid") is set with /skin set <name>;
            // upstream's Fabric Tailor URL form is kept for profile.skin.path. No skin configured: nothing is sent (upstream sent
            // /skin clear, which with SkinsRestorer wipes the skin the server already gave her).
            const skin = this.prompter.profile.skin;
            if (skin?.name) this.bot.chat(`/skin set ${skin.name}`);
            else if (skin?.path) this.bot.chat(`/skin set URL ${skin.model} ${skin.path}`);
        });
		const spawnTimeoutDuration = settings.spawn_timeout;
        const spawnTimeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);
            process.exit(1);
        }, spawnTimeoutDuration * 1000);
        this.bot.once('spawn', async () => {
            guardDig(this.bot, this.name);
            attachWaterClutch(this);   // owner 10-27 落地水: per-tick, only acts with the water_clutch mode on and a water bucket
            attachAirWatch(this);   // owner 10-28: at half air under water she is told, action or not; nothing is stopped
            attachBlackbox(this);   // owner 10-27 加速: the last ~10 s of her body go to logs/blackbox/ when she dies; it only records
            // GPT #3810 (C9): the owner went off and came back; her promise clock resumed but nothing said "老大回来了", and the 3 logs she had
            // promised stayed in her bag. Coming and going are told once, with how many promises are still open - whether to go is hers.
            {
                const ownerName = settings.voice?.owner_name;
                const quietUntil = Date.now() + 5000;   // (on spawn) the players already online arrive as "joined" right after it
                this.bot.on('playerJoined', (p) => {
                    if (!ownerName || p?.username !== ownerName || Date.now() < quietUntil) return;
                    let n = 0; try { n = this.memoryS?.openPromises?.().length || 0; } catch { /* none */ }
                    this.history.add('system', `（${ownerName}（老大）刚上线了。${n ? `你答应他、还没做完的事有 ${n} 件（见【答应老大还没做完的事】）。` : ''}要不要过去、说什么，你自己定。）`)?.catch?.(() => {});
                });
                this.bot.on('playerLeft', (p) => {
                    if (!ownerName || p?.username !== ownerName || Date.now() < quietUntil) return;
                    this.history.add('system', `（${ownerName}（老大）刚下线了。）`)?.catch?.(() => {});
                });
            }
            if (settings.voice?.input_enabled && !this.voiceInput) this.voiceInput = startVoiceInput(this, settings.voice);   // PLAN F push-to-talk   // owner rule: never break a player's protected area (protect.js); bot.dig exists from spawn on
            try {
                clearTimeout(spawnTimeout);
                addBrowserViewer(this.bot, count_id);
                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 1000));
                
                console.log(`${this.name} spawned.`);
                // DeepSeek #3881: 17 spawns in one day mixed builds in its counts - which run this is (the launcher's log name) and the process
                logLifecycle('spawn', { name: this.name, build: process.env.DAFEIYU_BUILD || null, pid: process.pid });
                // Which world is this? Agreed order (#3261/#3257): the configured world_name > hashed seed > spawn point + host:port.
                // Told to memory once per process: a key change mid-run is never a world switch (respawn/spawn jitter must not
                // split her memory); a confirmed switch is the first spawn after a restart with a different key.
                if (!this._worldTold) {
                    this._worldTold = true;
                    const sp = this.bot.spawnPoint, hostPort = settings.host + ':' + settings.port;
                    const parts = { name: settings.world_name || null, seed: this._hashedSeed || null, spawn: sp ? [Math.round(sp.x), Math.round(sp.z)] : null, server: hostPort };
                    const key = parts.name ? 'name:' + parts.name : parts.seed ? 'seed:' + parts.seed : 'spawn:' + (parts.spawn || []).join(',') + '@' + hostPort;
                    console.log('[world] key', key, JSON.stringify(parts));
                    logLifecycle('world', { key, ...parts });
                    try { this.memoryS?.setWorld?.(key, parts); } catch (e) { console.warn('[world] memory setWorld failed', e?.message); }
                    // a tool of hers changed since she last played: she is told once (tool_notes.js)
                    for (const note of takeUnseen(this.name)) { console.log('[tool-note]', note.id); this.history.add('system', note.text)?.catch?.(() => {}); }
                }
                // her houses in this save, and what happens to them (houses.js); after the world is known, once per bot
                try { (this.houses ||= new Houses(this)).attach(this.bot); } catch (e) { console.warn('[houses] attach failed', e?.message); }
                // owner 10-30 (screenshot "把牛打死了但是说牛去哪了"): she killed the cow, but her !equip cancelled the attack in the same
                // moment and its result was dropped - she looked for "the cow that ran away". A thing she hit that dies is told, always.
                watchKills(this.bot, (text) => this.history.add('system', text)?.catch?.(() => {}));
                // dafeiyu (PLAN I, DeepSeek #3090): a position sample every 5 s, so a stall ("moved under 1 m for 60 s") can be measured.
                clearInterval(this._posTimer);
                this._posTimer = setInterval(() => { if (this.bot?.entity) logPos(this.bot.entity.position); }, 5000);
                // fight-8 14:59: the agent ran out of heap ("Ineffective mark-compacts near heap limit") during a !collectBlocks and was
                // gone. One memory sample a minute, with what she was doing, so the next one shows what grew and when.
                clearInterval(this._memTimer);
                this._memTimer = setInterval(() => {
                    const m = process.memoryUsage(), mb = (v) => Math.round(v / 1048576);
                    logLifecycle('mem', { rss: mb(m.rss), heapUsed: mb(m.heapUsed), heapTotal: mb(m.heapTotal), external: mb(m.external), action: this.actions?.currentActionLabel || '', entities: Object.keys(this.bot?.entities || {}).length });
                }, 60000);
                // dafeiyu 2026-10-26 (companionship run): what she throws away is hers to leave. item_collecting picked her discards straight
                // back up and she concluded "背包反复自动塞满…疑有人塞东西". Items that appear right by her just after she tosses are
                // remembered here; item_collecting and pickupNearbyItems skip them until they are gone.
                const bot = this.bot;
                bot.ignoredItems = new Set();
                for (const name of ['toss', 'tossStack']) {
                    const original = bot[name];
                    if (typeof original === 'function') bot[name] = function (...args) { bot._lastTossAt = Date.now(); return original.apply(this, args); };
                }
                bot.on('entitySpawn', (e) => {
                    if (e?.name === 'item' && Date.now() - (bot._lastTossAt || 0) < 1500 && bot.entity && e.position.distanceTo(bot.entity.position) < 3)
                        bot.ignoredItems.add(e.id);
                });
                bot.on('entityGone', (e) => { if (e) bot.ignoredItems.delete(e.id); });
                // Every item she picks up - by the reflex, a skill or the game's own pickup - is a fact the audits can check her
                // "捡到了…" against (DeepSeek #3191: "还捡了根骨头" had no [act] to verify it).
                bot.on('playerCollect', (collector, collected) => {
                    if (collector !== bot.entity) return;
                    let item = null; try { item = collected?.getDroppedItem?.(); } catch { /* not an item entity */ }
                    if (item) logAct({ kind: 'pickup', args: { item: item.name, count: item.count }, ok: true });
                });
                this.clearBotLogs();
              
                this._setupEventHandlers(save_data, init_message);
                this.startEvents();
              
                if (!load_mem) {
                    if (settings.task) {
                        this.task.initBotTask();
                        this.task.setAgentGoal();
                    }
                } else {
                    // set the goal without initializing the rest of the task
                    if (settings.task) {
                        this.task.setAgentGoal();
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);
                process.exit(0);
            }
        });
    }

    async _setupEventHandlers(save_data, init_message) {
        const ignore_messages = [
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];
        
        const respondFunc = async (username, message) => {
            if (message === "") return;
            if (username === this.name) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;

                this.shut_up = false;

                console.log(this.name, 'received message from', username, ':', message);

                if (convoManager.isOtherAgent(username)) {
                    console.warn('received whisper from other bot??')
                }
                else {
                    let translation = await handleEnglishTranslation(message);
                    this.handleMessage(username, translation);
                }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        }

		this.respondFunc = respondFunc;

        this.bot.on('whisper', respondFunc);

        // 10-31 release test: an op's command is echoed to the other ops as "[JFors: Set minecraft:overworld to time marker ...]" (a system
        // message, chat.type.admin), mineflayer's legacy chat pattern read it as JFors talking, and she answered "是让我把时间调成晚上吗".
        // Seen first (prepended), so the chat event that the same message raises can be told apart; real chat is never a system message.
        let adminEcho = null;
        this.bot.prependListener('messagestr', (text, position, jsonMsg) => { adminEcho = position === 'system' && jsonMsg?.translate === 'chat.type.admin' ? text : null; });

        this.bot.on('chat', (username, message) => {
            if (adminEcho !== null && adminEcho === `[${username}: ${message}`) return;
            if (serverProxy.getNumOtherAgents() > 0) return;
            // only respond to open chat messages when there are no other agents
            respondFunc(username, message);
        });

        // Owner 10-28: tools she chooses, not scripts forced on her. The auto-eat plugin ate whenever hunger fell to 14, under no switch,
        // swapping her held item mid-action. Eating is !consume, or self_preservation's low-health eat when she has that mode on.
        this.bot.autoEat.disable();

        if (save_data?.self_prompt) {
            if (init_message) {
                this.history.add('system', init_message);
            }
            await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
        }
        if (save_data?.last_sender) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `You have restarted and this message is auto-generated. Continue the conversation with me.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        else if (init_message) {
            await this.handleMessage('system', init_message, 2);
        }
        else {
            this.openChat("Hello world! I am "+this.name);
        }
    }

    checkAllPlayersPresent() {
        if (!this.task || !this.task.agent_names) {
          return;
        }

        const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        this.bot.stopDigging();
        this.bot.collectBlock.cancelTask();
        this.bot.pathfinder.stop();
        this.bot.pvp.stop();
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.shut_up = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    async handleMessage(source, message, max_responses=null) {
        await this.checkTaskDone();
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
        }
        if (max_responses === -1) {
            max_responses = Infinity;
        }

        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = convoManager.isOtherAgent(source);
        // dafeiyu (PLAN S / R1): what a player says is remembered without her having to take notes (memory/index.js noteHeard).
        if (!self_prompt && !from_other_bot) { try { this.memoryS?.noteHeard?.({ who: source, text: message }); } catch { /* best effort */ } }
        // GPT #3771: what the running action adds after a player speaks is its own line in that action's receipt (actions.js runAsAction)
        if (!self_prompt && !from_other_bot && this.actions?.executing) { try { this._heardDuringAction = { who: source, at: Date.now(), inv: snapshot(this.bot) }; } catch { /* no reading */ } }
        // #3132: an accepted owner request must outlive the interruption chain, so keep the request until her reply is out.
        // Only the REAL owner arms a promise; test bots are ignored and a missed record is better than a fake one.
        // Claude review: "the owner" is the configured owner_name (launcher / settings.voice), not any human who happens to talk to her.
        // Since 10-27 12:4x a typed !command is a request like any other (owner: "她自己选择"), so it can become a promise too.
        const owner = settings.voice?.owner_name;
        if (!self_prompt && !from_other_bot && !isTestBot(source) && (!owner || source === owner)) {
            this._ownerRequest = { text: message, who: source, at: Date.now() };
        }

        if (!self_prompt && !from_other_bot) { // from user, check for forced commands
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                if (!commandExists(user_command_name)) {
                    this.routeResponse(source, `没有 ${user_command_name} 这个命令。`);   // goes to chat and her voice: said in her language
                    return false;
                }
                // Owner 10-27 12:4x "她可以自己选择要不要执行老大的命令，总之她自己选择", and asked again: a !command typed in chat - by the owner
                // or anyone - is no longer run for her. It reaches her as a request; if she wants it done she sends it herself.
                console.log(`${source} typed ${user_command_name} - passed to her as a request`);
                // GPT #3796: "他让我停3秒，行吧，歇口气" with no !stay sent - agreeing in words moved nothing. The exact command, and that fact.
                const typed = (message.match(new RegExp(user_command_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\([^)]*\\))?')) || [user_command_name])[0];
                message = `${message}\n（${source} 在聊天里打了 ${typed} 这条命令，是想让你这样做。做不做、什么时候做由你自己决定；要做就在回答里自己写上 ${typed}。只在嘴上答应、不写命令的话，身体不会动。）`;
            }
        }

        if (from_other_bot)
            this.last_sender = source;

        // Now translate the message
        message = await handleEnglishTranslation(message);
        console.log('received message from', source, ':', message);

        const checkInterrupt = () => this.self_prompter.shouldInterrupt(self_prompt) || this.shut_up || convoManager.responseScheduledFor(source);
        
        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            const MAX_LOG = 500;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = 'Recent behaviors log: \n' + behavior_log;
            await this.history.add('system', behavior_log);
        }

        // Handle other user messages
        await this.history.add(source, message);
        this.history.save();

        if (!self_prompt && this.self_prompter.isActive()) // message is from user during self-prompting
            max_responses = 1; // force only respond to this message, then let self-prompting take over
        for (let i=0; i<max_responses; i++) {
            if (checkInterrupt()) break;
            let history = this.history.getHistory();
            const asked_at = Date.now();
            let res = await this.prompter.promptConvo(history, { fromPlayer: !self_prompt && !from_other_bot && source !== 'system' });
            const think_ms = Date.now() - asked_at;

            console.log(`${this.name} full response to ${source}: ""${res}""`);
            // 3-day run 10-26: the model sometimes answers in its own tool-call markup (DSML) instead of !command, and that went to chat.
            {
                const ds = fromDsml(res);
                if (ds.converted || ds.dropped) {
                    console.log('[dsml]', ds.converted ? 'converted to !' + ds.converted : 'dropped from chat');
                    res = ds.res;
                    if (ds.dropped) this.history.add('system', '（刚才的回答用了工具调用的内部格式，没有执行，也没发到聊天里。命令请用 !命令(参数) 的写法。）');
                }
            }

            if (res.trim().length === 0) {
                console.warn('no response')
                break; // empty response ends loop
            }

            let command_name = containsCommand(res);
            // dafeiyu 2026-10-26: she called her own learned skill by its name (!escape_stuck_position) - that is !useSkill, not a mistake.
            // 10:4x she wrote !scan_row_of_blocks("z", 38, 52, -10, 2): a learned skill takes no arguments, so she is told they were not used.
            let skill_args_note = '';
            if (command_name && !commandExists(command_name) && getLearned(this.name, command_name.slice(1))) {
                const after = res.slice(res.indexOf(command_name) + command_name.length).match(/^\(([^)]*)\)/);
                if (after && after[1].trim())
                    skill_args_note = `（你学会的技能不接收参数，括号里的 (${after[1].trim()}) 没有用上；它照代码里写好的做。想换位置或范围，要用 !newAction 写新代码。）\n`;
                res = res.replace(command_name, `!useSkill("${command_name.slice(1)}")`);
                command_name = '!useSkill';
            }
            // [decision] (docs/log-spec.md): every answer is a choice among what she can do now - a command or just talking.
            const model = this.prompter.profile.model?.model || this.prompter.profile.model;
            const decided_at = Date.now();
            logDecision({ at: decided_at, gate: self_prompt ? 'autonomy' : 'chat', options: [...availableCommandNames(this).map((c) => c.slice(1)), 'chat'],
                chosen: command_name ? command_name.slice(1) : 'chat', why: (command_name ? res.substring(0, res.indexOf(command_name)) : res).trim().slice(0, 40),
                ms: think_ms, model: typeof model === 'string' ? model : undefined, ...(command_name && !commandExists(command_name) ? { offmenu: true } : {}) });

            if (command_name) { // contains query or command
                res = truncCommandMessage(res); // everything after the command is ignored
                this.history.add(this.name, res);
                
                if (!commandExists(command_name)) {
                    this.history.add('system', `Command ${command_name} does not exist.`);
                    console.warn('Agent hallucinated command:', command_name)
                    logDecision({ at: decided_at, gate: 'result', chosen: command_name.slice(1), executed: false, reason: 'no_such_command' });
                    continue;
                }

                if (checkInterrupt()) {
                    logDecision({ at: decided_at, gate: 'result', chosen: command_name.slice(1), executed: false, reason: 'interrupted' });
                    // !fight run 10-26 13:41: a mode started while she was thinking, her !fight was dropped here without a word, and she
                    // told the player she had won. Say plainly that it did not run and what was moving her body instead.
                    const busy = this.actions.currentActionLabel || '';
                    this.history.add('system', `（你刚才的 ${command_name} 没有执行${busy.startsWith('mode:') ? `：自动的 ${busy.slice(5)} 正在动，你的命令被它挤掉了` : busy ? `：${busy.replace(/^action:/, '!')} 还在进行` : ''}。还想做的话再说一次。）`)?.catch?.(() => {});
                    break;
                }
                this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                if (settings.show_command_syntax === "full") {
                    this.routeResponse(source, res);
                }
                else if (settings.show_command_syntax === "shortened") {
                    // show only "used !commandname"
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    let chat_message = `*used ${command_name.substring(1)}*`;
                    if (pre_message.length > 0)
                        chat_message = `${pre_message}  ${chat_message}`;
                    this.routeResponse(source, chat_message);
                }
                else {
                    // no command at all
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    if (pre_message.trim().length > 0)
                        this.routeResponse(source, pre_message);
                }

                let execute_res = await executeCommand(this, res);

                console.log('Agent executed:', command_name, 'and got:', execute_res);
                // DeepSeek #3261: the [decision] line says what she chose; this one says whether it actually ran (same 'at' pairs them).
                logDecision({ at: decided_at, gate: 'result', chosen: command_name.slice(1), executed: true, result: String(execute_res ?? '').slice(0, 80) });
                used_command = true;

                if (execute_res)
                    this.history.add('system', skill_args_note + execute_res);
                else
                    break;
            }
            else { // conversation response
                this.history.add(this.name, res);
                this.routeResponse(source, res);
                break;
            }
            
            this.history.save();
        }

        return used_command;
    }

    async routeResponse(to_player, message) {
        if (this.shut_up) return;
        let self_prompt = to_player === 'system' || to_player === this.name;
        if (self_prompt && this.last_sender) {
            // this is for when the agent is prompted by system while still in conversation
            // so it can respond to events like death but be routed back to the last sender
            to_player = this.last_sender;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            // if we're in an ongoing conversation with the other bot, send the response to it
            convoManager.sendToBot(to_player, message);
        }
        else {
            // otherwise, use open chat
            this.openChat(message);
            // note that to_player could be another bot, but if we get here the conversation has ended
        }
    }

    async openChat(message) {
        // owner 10-28 (screenshot "肚子还饿着呢（16/20）"): a bar value in brackets was read aloud and shown in chat. She still reads the
        // numbers in her own turns and history; only what is spoken and sent loses the "n/m" reading inside brackets (her bracketed asides
        // keep their words; a bracket left empty goes).
        message = String(message).replace(/([ \t]*)([（(])([^（()）\n]*)([)）])/g, (all, sp, open, inner, close) => {
            if (!/\d+\s*\/\s*\d+/.test(inner)) return all;
            const rest = inner.replace(/\s*\d+\s*\/\s*\d+\s*/g, '').replace(/([，,、])[，,、\s]+/g, '$1').replace(/^[，,、\s]+|[，,、\s]+$/g, '');
            return rest ? `${sp}${open}${rest}${close}` : '';
        });
        let to_translate = message;
        let remaining = '';
        let command_name = containsCommand(message);
        let translate_up_to = command_name ? message.indexOf(command_name) : -1;
        if (translate_up_to != -1) { // don't translate the command
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        message = (await handleTranslation(to_translate)).trim() + " " + remaining;
        // newlines are interpreted as separate chats, which triggers spam filters. replace them with spaces
        message = message.replaceAll('\n', ' ');

        if (settings.only_chat_with.length > 0) {
            for (let username of settings.only_chat_with) {
                this.bot.whisper(username, message);
            }
        }
        else {
            // owner 10-27 12:3x "会不会把命令也读出来": what her voice says (or would say, muted) is logged as it is, so it can be checked
            if (spokenText(to_translate)) console.log('[would-speak] ' + JSON.stringify(spokenText(to_translate)));   // as the voice gets it (10-29)
            if (settings.speak) {
                speak(to_translate, this.prompter.profile.speak_model);
            }
            // #3132: if her reply to the owner accepts, that is a promise - record it before any interruption can eat it
            {
                const req = this._ownerRequest;
                this._ownerRequest = null;                 // one reply answers one request; never let it linger
                if (req && Date.now() - req.at < 120_000) {
                    try { this.memoryS?.notePromise?.({ request: req.text, reply: message, who: req.who }); } catch { /* memory must never break chat */ }
                }
            }
            this.memoryS?.noteSaid(message);   // dafeiyu (PLAN S)
            logAct({ kind: 'chat', args: { text: String(message).slice(0, 300) }, ok: true });   // timestamped, so a stated wait ("等天亮") can be matched to a pause (PLAN I)
            if (settings.chat_ingame) {this.bot.chat(message);}
            sendOutputToServer(this.name, message);
        }
    }

    startEvents() {
        // Custom events
        // dafeiyu 2026-10-26: the time packet comes every ~20 ticks, so "timeOfDay == 0" almost never held and the dawn memory work never
        // ran (self.md, goals.md and the diary stayed empty). An event fires when the clock crosses its mark.
        let last_tod = null, last_death_at = 0;
        // Forward crossings only. The old form also counted ANY backward step as crossing every mark (for a step back "now >= 0" is
        // always true), so a small time correction was a dawn; a real new day is only the wrap below.
        const crossed = (prev, now, mark) => prev !== null && prev < now && prev < mark && now >= mark;
        this.bot.on('time', () => {
            const tod = this.bot.time.timeOfDay, day = this.bot.time.day;
            // A real new day is a wrap (a backward jump of more than half a day); a few ticks back is a server time correction and
            // made the dawn work run twice within a second (2026-10-26 multiday run, day 23). Once per in-game day at most.
            const wrapped = last_tod !== null && last_tod - tod > 12000;
            // New-world run 10-26: a dawn fired 0.6 s after a dusk death in a fresh process, where no dawn had been seen yet and the
            // day-number guard compared against -Infinity. The first reading of a process is the baseline day.
            if (this._dawnDay === undefined && Number.isFinite(day)) this._dawnDay = day;
            if (last_tod !== null && tod < last_tod && !wrapped) logLifecycle('time_back', { from: last_tod, to: tod, day, sinceDeathMs: last_death_at ? Date.now() - last_death_at : null });
            if (wrapped && !(Number.isFinite(day) && day > (this._dawnDay ?? -Infinity))) {
                console.log(`[dawn] rejected (day ${day} not after ${this._dawnDay}; time ${last_tod} -> ${tod})`);
                logLifecycle('dawn_rejected', { day, prevDay: this._dawnDay ?? null, from: last_tod, to: tod });
            }
            else if (wrapped) {
                logLifecycle('dawn', { day, prevDay: this._dawnDay ?? null, from: last_tod, to: tod, sinceDeathMs: last_death_at ? Date.now() - last_death_at : null });
                this._dawnDay = day;
                this.bot.emit('sunrise');
                // dafeiyu (PLAN S): each in-game dawn she rewrites "about me", her goals and the diary from what was recorded - never blocks a decision.
                this.memoryS?.nightlyConsolidate((p) => this.prompter.chat_model.sendRequest([{ role: 'user', content: p }], '你是大肥鱼，在整理自己的记忆。'))
                    .then((r) => console.log('[memory] dawn consolidation', JSON.stringify(r))).catch((e) => console.warn('[memory] dawn consolidation failed', e?.message));
            }
            else if (crossed(last_tod, tod, 6000)) this.bot.emit('noon');
            else if (crossed(last_tod, tod, 12000)) this.bot.emit('sunset');
            else if (crossed(last_tod, tod, 18000)) this.bot.emit('midnight');
            last_tod = tod;
        });
        this.bot.on('death', () => { last_tod = null; last_death_at = Date.now(); });   // the reading after respawn is a baseline, not a crossing (see above)
        // Owner 10-26 19:0x: "应该是告诉她晚上可以睡觉度过，不是告诉她在测试，这样她会自己记下来". A game fact, once, at the first dusk she has a
        // bed for - whether she sleeps, and whether she keeps it, is hers.
        // also at night when the process starts after dusk (19:0x: the first dusk with a bed had already gone by)
        let sleepTipDone = false, sleepTipAt = 0;
        const sleepTip = () => {
            if (sleepTipDone || Date.now() - sleepTipAt < 30000) return;   // at most one bed search per 30 s
            sleepTipAt = Date.now();
            try {
                const bed = this.bot.inventory.items().find((i) => i.name.endsWith('_bed'));
                const placed = this.bot.findBlock({ matching: (b) => b.name.endsWith('_bed'), maxDistance: 32 });
                if (!bed && !placed) return;
                sleepTipDone = true;
                if (!takeOnce(this.name, 'sleep-at-night-2026-10-26')) return;
                const where = placed ? `离你 ${Math.round(placed.position.distanceTo(this.bot.entity.position))} 格有一张已经放好的床` : `你背包里有 ${bed.name}，要先放到地上（!placeHere("${bed.name}")，床要占两格空地）`;
                this.history.add('system', `（游戏常识）${(this.bot.time?.timeOfDay ?? 0) >= 13000 ? '现在是夜里' : '天要黑了'}。晚上可以睡觉把这一夜过掉：天完全黑下来以后（或者雷雨天），躺到床上就能直接睡到天亮。${where}；`
                    + '!goToBed 会走到 32 格内最近的床上去睡。附近有怪的时候睡不着；睡过的床会变成你的复活点。睡不睡你自己定。')?.catch?.(() => {});
            } catch { /* a hint, never a failure */ }
        };
        this.bot.on('sunset', sleepTip);
        this.bot.on('time', () => { const tod = this.bot.time?.timeOfDay; if (tod >= 12000 && tod < 23000) sleepTip(); });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
                // the last 40 s of damage - longer than one encounter (30 s) - (DeepSeek #3380): "how much was she hurt before a fight began" is what tells a first strike
                // from a counter-attack; one tiny entry per hit, nothing on a quiet day
                const now = Date.now();
                this.bot.recentDamage = [...(this.bot.recentDamage || []).filter((d) => now - d.at < 40000), { at: now, amount: prev_health - this.bot.health }];
            }
            prev_health = this.bot.health;
        });
        // Who hit her (owner 10-26: "被打还手执行 fight 是正常的" - the reflex starts only on a confirmed hit). The server's damage_event names
        // the entity responsible (for an arrow: the skeleton). A fall, fire, drowning or an unknown source is not an attacker (GPT #3418).
        this.bot.on('entityHurt', (victim, source) => {
            if (victim !== this.bot.entity || !source || source === this.bot.entity) return;
            // a player hitting her is never a reflex: whether to hit back is hers to think about (owner 10-26) - she is only told
            if (source.type === 'player') { this.bot.lastPlayerHit = { name: source.username, entity: source, at: Date.now() }; return; }
            if (!isHostile(source) || !isAlive(this.bot, source)) return;
            this.bot.lastAttacker = { entity: source, at: Date.now() };
        });
        // Logging callbacks
        this.bot.on('error' , (err) => {
            console.error('Error event!', err);
        });
        // Use connection handler for runtime disconnects
        this.bot.on('end', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('death', () => {
            // GPT #3853 (final-83 18:00): dead while idle, stop() returned at once and the old goto goal walked her respawned body
            // off the spawn pillar and back to where she drowned. Body goals can outlive an action; a death ends them too.
            this.bot.pathfinder.setGoal(null);
            this.bot.clearControlStates();
            // DeepSeek #3708: 6 of 29 deaths could not be put in day or night - the clock goes with the death itself
            const deathTod = this.bot.time?.timeOfDay;
            logLifecycle('death', { pos: this.bot.entity?.position ? { x: Math.round(this.bot.entity.position.x), y: Math.round(this.bot.entity.position.y), z: Math.round(this.bot.entity.position.z) } : null,
                tod: Number.isFinite(deathTod) ? deathTod : null, isNight: Number.isFinite(deathTod) ? deathTod >= 13000 && deathTod <= 23000 : null });
            this.actions.cancelResume();
            this.actions.stop('lifecycle:death');
        });
        this.bot.on('kicked', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                let death_pos = this.bot.entity.position;
                this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                let death_pos_text = null;
                if (death_pos) {
                    death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.z.toFixed(2)}`;
                }
                let dimention = this.bot.game.dimension;
                // dafeiyu (DeepSeek #3023): her death lessons never mentioned rain though every daytime zombie death was in a thunderstorm -
                // she was never told the weather. Record it with the time of day (memory) and tell her, so she can draw the lesson herself.
                const weather = this.bot.thunderState > 0 ? '雷雨' : this.bot.isRaining ? '下雨' : '晴';
                const tod = this.bot.time?.timeOfDay, partOfDay = !Number.isFinite(tod) ? '时间未知' : (tod >= 13000 && tod <= 23000 ? '夜里' : '白天');
                // DeepSeek #3519 (owner 10-26 20:1x): whether "被打还手" was on when she died - so she can join off -> nothing answered -> dead herself
                this.memoryS?.noteDeath({ cause: message, pos: death_pos ? { x: Math.round(death_pos.x), y: Math.round(death_pos.y), z: Math.round(death_pos.z) } : null, weather, tod });
                // DeepSeek #3977: five deaths in 21 minutes in one patch by her house, five causes - how often here lately is a fact she gets
                let hereAgain = '';
                try {
                    const now = Date.now(), days = [...new Set([now - 3600e3, now].map((t) => new Date(t).toISOString().slice(0, 10)))];
                    hereAgain = nearbyDeathLine(days.flatMap((d) => this.memoryS?.deaths?.(d) || []), death_pos, now);
                } catch { /* a fact to add, never a reason to fail */ }
                this.handleMessage('system', `You died at position ${death_pos_text || "unknown"} in the ${dimention} dimension with the final message: '${message}'. It was ${partOfDay}, weather: ${weather}. ${this.bot.modes?.isOn?.('self_defense') ? '被打还手当时是开着的' : '被打还手当时是关着的'}. Your place of death is saved as 'last_death_position' if you want to return. Previous actions were stopped and you have respawned.${hereAgain ? ' ' + hereAgain : ''}`);
                // arena 10-26: with keep_inventory on she said "东西全丢在那边" without looking. Once the respawned inventory has arrived, tell her what she has.
                setTimeout(() => {
                    try {
                        const n = this.bot.inventory.items().length;
                        this.bot.keptOnDeath = n > 0;   // seen, not assumed: the witch notice says "死亡不掉落" only after a death kept her things
                        this.history.add('system', n ? `（复活后你背包里还有 ${n} 格东西，这次死亡没有掉东西。）` : '（复活后你背包是空的，东西掉在死亡点附近，掉落物大约 5 分钟后消失。）');
                        // final-26..29: every death respawned her at world spawn in the open at night. Where she woke, and what is known about
                        // her bed - owner 10-28 MEETING-5: no more "you have never slept" from being near spawn (GPT #4081: not proven).
                        const me = this.bot.entity?.position;
                        if (me) this.history.add('system', noteRespawn(this.name, me, this.bot.spawnPoint, this.memoryS?.worldStatus?.()?.since));
                    } catch { /* bot gone */ }
                }, 3000);
            }
        });
        this.bot.on('idle', () => {
            this.bot.clearControlStates();
            this.bot.pathfinder.stop(); // clear any lingering pathfinder
            this.bot.modes.unPauseAll();
            setTimeout(() => {
                if (this.isIdle()) {
                    this.actions.resumeAction();
                }
            }, 1000);
        });

        // Init NPC controller
        this.npc.init();

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        setTimeout(async () => {
            while (true) {
                let start = Date.now();
                await this.update(start - last);
                let remaining = INTERVAL - (Date.now() - start);
                if (remaining > 0) {
                    await new Promise((resolve) => setTimeout(resolve, remaining));
                }
                last = start;
            }
        }, INTERVAL);

        this.bot.emit('idle');
    }

    async update(delta) {
        await this.bot.modes.update();
        this.self_prompter.update(delta);
        try { this.stuckHints?.update(); } catch { /* best effort */ }
        await this.checkTaskDone();
    }

    isIdle() {
        return !this.actions.executing;
    }
    

    cleanKill(msg='Killing agent process...', code=1) {
        logLifecycle('exit', { code, msg: String(msg).slice(0, 200) });
        this.history.add('system', msg);
        this.bot.chat(code > 1 ? 'Restarting.': 'Exiting.');
        this.history.save();
        process.exit(code);
    }
    async checkTaskDone() {
        if (this.task.data) {
            let res = this.task.isDone();
            if (res) {
                await this.history.add('system', `Task ended with score : ${res.score}`);
                await this.history.save();
                // await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 second for save to complete
                console.log('Task finished:', res.message);
                this.killAll();
            }
        }
    }

    killAll() {
        serverProxy.shutdown();
    }
}
