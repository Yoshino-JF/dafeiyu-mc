import { readFileSync, mkdirSync, writeFileSync} from 'fs';
import { Examples } from '../utils/examples.js';
import { getCommandDocs } from '../agent/commands/index.js';
import { SkillLibrary } from "../agent/library/skill_library.js";
import { stringifyTurns } from '../utils/text.js';
import { getCommand } from '../agent/commands/index.js';
import settings from '../agent/settings.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { selectAPI, createModel } from './_model_map.js';
import { getKey, hasKey } from '../utils/keys.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 2026-10-27 09:04 final-61: the model began answering in its own native tool-call tokens
// ("<｜｜tool▁call▁begin｜｜>goToCoordinates<｜｜tool▁sep｜｜>{"x":-5,...}<｜｜tool▁call▁end｜｜>") - sent to chat as text, never run, and
// each copy in history invites the next. The call it meant is written as the command it is (args in the command's own order, by name).
const TOKEN = '[｜|]+';
const CALL = new RegExp(`<${TOKEN}tool▁call▁begin${TOKEN}>\\s*!?([\\w]+)\\s*<${TOKEN}tool▁sep${TOKEN}>\\s*(\\{[\\s\\S]*?\\})\\s*<${TOKEN}tool▁call▁end${TOKEN}>`, 'g');
const fmt = (v) => (typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(String(v ?? '')));
// 3-day test 10-27 (final-76 [would-speak]): one reply began with the model's own safety verdict, "<ds_safety>[用户未成年]否 [分类]其他
// [判定]… [规则]无</ds_safety>Safe" - it would have been read aloud and sent to chat. The whole block, and the verdict word after it, is not hers.
// GPT #3776 (B-line copy): "<system_warning>Please use the tool carefully. … </system_warning> 嗯？这里明明有叶子" reached public chat and
// [would-speak] - the model's own wrapper, on the same line as her words, so the tag-only-line rule let it through. Same treatment.
const WRAPPERS = 'ds_safety|system_warning|system_reminder|system_note|safety_warning';
export function stripSafetyBlock(text) {
    if (typeof text !== 'string') return text;
    // final-103 02:4x (DeepSeek #3964): she "said" "SYSTEM: Action output:\nYou are standing at (30, 29, 11). Around you: ..." - a system
    // turn echoed back. A paragraph that opens with "SYSTEM:" is dropped up to a blank line or her next !command.
    if (/^[ \t]*SYSTEM:/m.test(text)) {
        const kept = []; let echo = false;
        for (const line of text.split(/\r?\n/)) {
            if (/^[ \t]*SYSTEM:/.test(line)) { echo = true; continue; }
            if (echo && (!line.trim() || /^[ \t]*[!！]/.test(line))) echo = false;
            if (!echo) kept.push(line);
        }
        text = kept.join('\n').trim();
    }
    if (new RegExp(`<\\/?(${WRAPPERS})\\b`, 'i').test(text)) text = text
        .replace(new RegExp(`<(${WRAPPERS})\\b[^>]*>[\\s\\S]*?<\\/\\1>[ \\t]*(Safe|Unsafe)?[ \\t]*\\r?\\n?`, 'gi'), '')
        .replace(new RegExp(`^[ \\t]*<\\/?(${WRAPPERS})\\b[^>]*>.*$\\r?\\n?`, 'gim'), '')
        .trim();
    // final-107 05:22 (DeepSeek #3985): "<system>你附近有苦力怕还挖水边呢。…</system>" - her own words in a bare tag pair. Any other bare tag
    // (<word> or </word>, no spaces) is markup she never speaks: the tags go, the words between them stay.
    if (/<\/?[A-Za-z_][\w-]*>/.test(text)) text = text.replace(/<\/?[A-Za-z_][\w-]*>/g, '').trim();
    return text;
}

// DeepSeek #3740: in the new save she said "坐标对上了，可地形不一样——旧世界的河边，这里成了石头堆" and walked further to find that river.
// Her own rolling notes (history.memory) carry no world mark, unlike the world-scoped rows. For two hours after a change of world she is
// told that, above those notes; what to keep is hers.
export function oldWorldNote(agent, now = Date.now()) {
    const w = agent?.memoryS?.worldStatus?.();
    if (!w?.since || !(w.worldCount >= 2) || !agent?.history?.memory || now - w.since > 2 * 3600e3) return '';
    const at = new Date(w.since).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    return `（${at} 你换到了一个新世界。下面这段随手记有一部分是在之前的世界写的：里面的坐标、地名和地形（河、家、洞屋……），凡是你在这个世界没亲眼确认过的，都可能根本不存在。改不改、怎么改，你自己定。）\n`;
}

// Owner 10-28 (launcher run, "给出提示也读出来了"): while the owner chatted with her she sometimes went on to write his next line,
// "…现在能挖石头了。\n\nJFors: 嗯？", and it was spoken. The history gives every other speaker as "name: text"; a line of hers that opens
// with one of those names (or system) is the model writing someone else's turn, so her reply ends there.
export function cutAtOtherSpeaker(text, messages, self) {
    if (typeof text !== 'string') return text;
    const names = new Set(['system']);
    for (const m of messages || []) {
        const n = m?.role === 'user' && /^([A-Za-z0-9_]{1,16}): /.exec(String(m.content ?? ''));
        if (n && n[1].toLowerCase() !== String(self || '').toLowerCase()) names.add(n[1]);
    }
    const alt = [...names].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const hit = new RegExp(`(^|\\n)[ \\t]*(${alt})[ \\t]*[:：]`, 'i').exec(text);
    return hit ? text.slice(0, hit.index).trimEnd() : text;
}

export function toolCallsToCommands(text) {
    if (typeof text !== 'string' || !text.includes('▁')) return text;
    // 09:53 "<｜end▁of▁thinking｜>苦力怕已经贴到 4 格了…" reached chat: what comes before that token is the model's thinking, like </think>
    const thinkEnd = new RegExp(`<${TOKEN}end▁of▁thinking${TOKEN}>`);
    if (thinkEnd.test(text)) text = text.split(thinkEnd).pop();
    let out = text.replace(CALL, (_, name, json) => {
        let args = {};
        try { args = JSON.parse(json) || {}; } catch { /* keep the name, no args */ }
        const params = Object.keys(getCommand('!' + name)?.params || {}), values = Object.values(args);
        const ordered = params.length ? params.map((p, i) => (p in args ? args[p] : values[i])).filter((v) => v !== undefined) : values;
        return `\n!${name}(${ordered.map(fmt).join(', ')})\n`;
    });
    out = out.replace(new RegExp(`<${TOKEN}[^<>]*?▁[^<>]*?${TOKEN}>`, 'g'), '');   // any other of the model's own tokens (they all hold ▁)
    return out.replace(/\n{2,}/g, '\n').trim();
}

export class Prompter {
    constructor(agent, profile) {
        this.agent = agent;
        this.profile = profile;
        const defaults_dir = path.join(__dirname, '../../profiles/defaults');
        let default_profile = JSON.parse(readFileSync(path.join(defaults_dir, '_default.json'), 'utf8'));
        let base_fp = '';
        if (settings.base_profile.includes('survival')) {
            base_fp = path.join(defaults_dir, 'survival.json');
        } else if (settings.base_profile.includes('assistant')) {
            base_fp = path.join(defaults_dir, 'assistant.json');
        } else if (settings.base_profile.includes('creative')) {
            base_fp = path.join(defaults_dir, 'creative.json');
        } else if (settings.base_profile.includes('god_mode')) {
            base_fp = path.join(defaults_dir, 'god_mode.json');
        }
        let base_profile = JSON.parse(readFileSync(base_fp, 'utf8'));

        // first use defaults to fill in missing values in the base profile
        for (let key in default_profile) {
            if (base_profile[key] === undefined)
                base_profile[key] = default_profile[key];
        }
        // then use base profile to fill in missing values in the individual profile
        for (let key in base_profile) {
            if (this.profile[key] === undefined)
                this.profile[key] = base_profile[key];
        }
        // base overrides default, individual overrides base

        this.convo_examples = null;
        this.coding_examples = null;
        
        let name = this.profile.name;
        this.cooldown = this.profile.cooldown ? this.profile.cooldown : 0;
        this.last_prompt_time = 0;
        this.awaiting_coding = false;

        // for backwards compatibility, move max_tokens to params
        let max_tokens = null;
        if (this.profile.max_tokens)
            max_tokens = this.profile.max_tokens;

        let chat_model_profile = selectAPI(this.profile.model);
        this.chat_model = createModel(chat_model_profile);

        if (this.profile.code_model) {
            let code_model_profile = selectAPI(this.profile.code_model);
            this.code_model = createModel(code_model_profile);
        }
        else {
            this.code_model = this.chat_model;
        }

        if (this.profile.vision_model) {
            let vision_model_profile = selectAPI(this.profile.vision_model);
            this.vision_model = createModel(vision_model_profile);
        }
        else {
            this.vision_model = this.chat_model;
        }

        
        let embedding_model_profile = null;
        if (this.profile.embedding) {
            try {
                embedding_model_profile = selectAPI(this.profile.embedding);
            } catch (e) {
                embedding_model_profile = null;
            }
        }
        // owner 10-31 ("有百炼api的享受更好的，没有就纯deepseek"): the qwen embedding runs on the same Alibaba Cloud key as her voice, so a
        // user who set a Bailian key in the launcher gets it with nothing more to set; without any such key she runs on DeepSeek alone.
        if (embedding_model_profile?.api === 'qwen' && !hasKey('QWEN_API_KEY')) {
            const voiceKey = [settings.voice?.asr?.api_key_env, settings.voice?.tts?.api_key_env, 'DASHSCOPE_API_KEY'].find((n) => n && hasKey(n));
            if (voiceKey) process.env.QWEN_API_KEY = getKey(voiceKey);
        }
        // release test 10-30: a new user sets only the DeepSeek key, and the qwen embedding's missing QWEN_API_KEY stopped her at
        // start. Without it: every example goes in (examples.js), skills and memory use their offline rules.
        try {
            this.embedding_model = embedding_model_profile ? createModel(embedding_model_profile) : null;
        } catch (e) {
            console.warn(`Embedding model unavailable (${e.message}); using word overlap instead.`);
            this.embedding_model = null;
        }
        // No stand-in model when there is none: the chat API's embed() only failed and printed "Error with embedding model" at each start.

        this.skill_libary = new SkillLibrary(agent, this.embedding_model);
        mkdirSync(`./bots/${name}`, { recursive: true });
        writeFileSync(`./bots/${name}/last_profile.json`, JSON.stringify(this.profile, null, 4), (err) => {
            if (err) {
                throw new Error('Failed to save profile:', err);
            }
            console.log("Copy profile saved.");
        });
    }

    getName() {
        return this.profile.name;
    }

    getInitModes() {
        return this.profile.modes;
    }

    async initExamples() {
        try {
            this.convo_examples = new Examples(this.embedding_model, settings.num_examples);
            this.coding_examples = new Examples(this.embedding_model, settings.num_examples);
            
            // Wait for both examples to load before proceeding
            await Promise.all([
                this.convo_examples.load(this.profile.conversation_examples),
                this.coding_examples.load(this.profile.coding_examples),
                this.skill_libary.initSkillLibrary()
            ]).catch(error => {
                // Preserve error details
                console.error('Failed to initialize examples. Error details:', error);
                console.error('Stack trace:', error.stack);
                throw error;
            });

            console.log('Examples initialized.');
        } catch (error) {
            console.error('Failed to initialize examples:', error);
            console.error('Stack trace:', error.stack);
            throw error; // Re-throw with preserved details
        }
    }

    /** dafeiyu (PLAN S/R): her long-term memory, with what matters right now (what was just said, her current goal) recalled first. */
    memoryBlock(messages) {
        const last = Array.isArray(messages) ? messages.slice(-2).map((m) => String(m?.content || '')).join(' ') : '';
        const query = `${last} ${this.agent.self_prompter?.prompt || ''}`.slice(-600);
        try { return this.agent.memoryS?.promptBlock?.({ query, k: 5 }) || ''; } catch { return ''; }
    }

    async replaceStrings(prompt, messages, examples=null, to_summarize=[], last_goals=null) {
        prompt = prompt.replaceAll('$NAME', this.agent.name);

        if (prompt.includes('$STATS')) {
            let stats = await getCommand('!stats').perform(this.agent) + '\n';
            stats += await getCommand('!entities').perform(this.agent) + '\n';
            stats += await getCommand('!nearbyBlocks').perform(this.agent);
            prompt = prompt.replaceAll('$STATS', stats);
        }
        if (prompt.includes('$INVENTORY')) {
            let inventory = await getCommand('!inventory').perform(this.agent);
            prompt = prompt.replaceAll('$INVENTORY', inventory);
        }
        if (prompt.includes('$ACTION')) {
            prompt = prompt.replaceAll('$ACTION', this.agent.actions.currentActionLabel);
        }
        if (prompt.includes('$COMMAND_DOCS'))
            prompt = prompt.replaceAll('$COMMAND_DOCS', getCommandDocs(this.agent));
        if (prompt.includes('$CODE_DOCS')) {
            const code_task_content = messages.slice().reverse().find(msg =>
                msg.role !== 'system' && msg.content.includes('!newAction(')
            )?.content?.match(/!newAction\((.*?)\)/)?.[1] || '';

            prompt = prompt.replaceAll(
                '$CODE_DOCS',
                await this.skill_libary.getRelevantSkillDocs(code_task_content, settings.relevant_docs_count)
            );
        }
        if (prompt.includes('$EXAMPLES') && examples !== null)
            prompt = prompt.replaceAll('$EXAMPLES', await examples.createExampleMessage(messages));
        if (prompt.includes('$MEMORY'))
            // dafeiyu (PLAN S): her long-term memory (src/agent/memory, DeepSeek) next to upstream's short rolling summary.
            prompt = prompt.replaceAll('$MEMORY', [this.memoryBlock(messages), oldWorldNote(this.agent) + (this.agent.history.memory || '')].filter(Boolean).join('\n\n'));
        if (prompt.includes('$TO_SUMMARIZE'))
            prompt = prompt.replaceAll('$TO_SUMMARIZE', stringifyTurns(to_summarize));
        if (prompt.includes('$CONVO'))
            prompt = prompt.replaceAll('$CONVO', 'Recent conversation:\n' + stringifyTurns(messages));
        if (prompt.includes('$SELF_PROMPT')) {
            // if active or paused, show the current goal
            let self_prompt = !this.agent.self_prompter.isStopped() ? `YOUR CURRENT ASSIGNED GOAL: "${this.agent.self_prompter.prompt}"\n` : '';
            prompt = prompt.replaceAll('$SELF_PROMPT', self_prompt);
        }
        if (prompt.includes('$LAST_GOALS')) {
            let goal_text = '';
            for (let goal in last_goals) {
                if (last_goals[goal])
                    goal_text += `You recently successfully completed the goal ${goal}.\n`
                else
                    goal_text += `You recently failed to complete the goal ${goal}.\n`
            }
            prompt = prompt.replaceAll('$LAST_GOALS', goal_text.trim());
        }
        if (prompt.includes('$BLUEPRINTS')) {
            if (this.agent.npc.constructions) {
                let blueprints = '';
                for (let blueprint in this.agent.npc.constructions) {
                    blueprints += blueprint + ', ';
                }
                prompt = prompt.replaceAll('$BLUEPRINTS', blueprints.slice(0, -2));
            }
        }

        // check if there are any remaining placeholders with syntax $<word>
        let remaining = prompt.match(/\$[A-Z_]+/g);
        if (remaining !== null) {
            console.warn('Unknown prompt placeholders:', remaining.join(', '));
        }
        return prompt;
    }

    async checkCooldown() {
        let elapsed = Date.now() - this.last_prompt_time;
        if (elapsed < this.cooldown && this.cooldown > 0) {
            await new Promise(r => setTimeout(r, this.cooldown - elapsed));
        }
        this.last_prompt_time = Date.now();
    }

    async promptConvo(messages, opts = {}) {
        // a counter, not Date.now(): two turns can start in the same millisecond (Windows timers tick ~15 ms) and then looked equally new
        this.most_recent_msg_time = (this.most_recent_msg_time || 0) + 1;
        let current_msg_time = this.most_recent_msg_time;
        if (opts.fromPlayer) this.most_recent_player_msg_time = current_msg_time;
        // GPT #3784: her right answer to the owner (!goToRememberedPlace("营地")) was thrown away because a system/self-prompt turn started
        // meanwhile; that turn then walked her to the owner instead. A reply to a player stands unless another player message came in;
        // a non-player turn that began before such a reply was kept is the one dropped.
        const superseded = () => {
            if (!opts.fromPlayer && (this.player_reply_kept_at || 0) >= current_msg_time) return true;
            if (current_msg_time === this.most_recent_msg_time) return false;
            return !opts.fromPlayer || (this.most_recent_player_msg_time || 0) > current_msg_time;
        };

        for (let i = 0; i < 3; i++) { // try 3 times to avoid hallucinations
            await this.checkCooldown();
            if (superseded()) {
                return '';
            }

            let prompt = this.profile.conversing;
            prompt = await this.replaceStrings(prompt, messages, this.convo_examples);
            let generation;

            try {
                generation = await this.chat_model.sendRequest(messages, prompt);
                if (typeof generation !== 'string') {
                    console.error('Error: Generated response is not a string', generation);
                    throw new Error('Generated response is not a string');
                }
                console.log("Generated response:", generation);
                await this._saveLog(prompt, messages, generation, 'conversation');

            } catch (error) {
                console.error('Error during message generation or file writing:', error);
                continue;
            }

            // Check for hallucination or invalid output
            if (generation?.includes('(FROM OTHER BOT)')) {
                console.warn('LLM hallucinated message as another bot. Trying again...');
                continue;
            }

            if (superseded()) {
                console.warn(`${this.agent.name} received new message while generating, discarding old response.`);
                return '';
            }
            if (opts.fromPlayer) this.player_reply_kept_at = this.most_recent_msg_time;   // every turn begun so far is older than this reply

            if (generation?.includes('</think>')) {
                const [_, afterThink] = generation.split('</think>')
                generation = afterThink
            }

            // 2026-10-27 final-45: the model began wrapping her words in made-up tags (<system_warning>, <prose>) - in nothing we send -
            // and each one kept in history made the next more likely (2 of 23 replies, then 7 of 30). Only a line that is nothing but
            // such a tag is dropped; every word she wrote stays.
            generation = stripSafetyBlock(generation);
            generation = generation.replace(/^[ \t]*<\/?[a-z_]{2,30}>[ \t]*(\r?\n|$)/gim, '');
            generation = toolCallsToCommands(generation);
            const own = cutAtOtherSpeaker(generation, messages, this.agent?.name);
            if (own !== generation) console.log('[other-speaker] cut:', JSON.stringify(generation.slice(own.length).trim().slice(0, 120)));
            generation = own;

            return generation;
        }

        return '';
    }

    async promptCoding(messages) {
        if (this.awaiting_coding) {
            console.warn('Already awaiting coding response, returning no response.');
            return '```//no response```';
        }
        this.awaiting_coding = true;
        await this.checkCooldown();
        let prompt = this.profile.coding;
        prompt = await this.replaceStrings(prompt, messages, this.coding_examples);

        let resp = await this.code_model.sendRequest(messages, prompt);
        this.awaiting_coding = false;
        await this._saveLog(prompt, messages, resp, 'coding');
        return resp;
    }

    async promptMemSaving(to_summarize) {
        await this.checkCooldown();
        let prompt = this.profile.saving_memory;
        prompt = await this.replaceStrings(prompt, null, null, to_summarize);
        let resp = await this.chat_model.sendRequest([], prompt);
        await this._saveLog(prompt, to_summarize, resp, 'memSaving');
        if (resp?.includes('</think>')) {
            const [_, afterThink] = resp.split('</think>')
            resp = afterThink;
        }
        return resp;
    }

    async promptShouldRespondToBot(new_message) {
        await this.checkCooldown();
        let prompt = this.profile.bot_responder;
        let messages = this.agent.history.getHistory();
        messages.push({role: 'user', content: new_message});
        prompt = await this.replaceStrings(prompt, null, null, messages);
        let res = await this.chat_model.sendRequest([], prompt);
        return res.trim().toLowerCase() === 'respond';
    }

    async promptVision(messages, imageBuffer) {
        await this.checkCooldown();
        let prompt = this.profile.image_analysis;
        prompt = await this.replaceStrings(prompt, messages, null, null, null);
        return await this.vision_model.sendVisionRequest(messages, prompt, imageBuffer);
    }

    async promptGoalSetting(messages, last_goals) {
        // deprecated
        let system_message = this.profile.goal_setting;
        system_message = await this.replaceStrings(system_message, messages);

        let user_message = 'Use the below info to determine what goal to target next\n\n';
        user_message += '$LAST_GOALS\n$STATS\n$INVENTORY\n$CONVO'
        user_message = await this.replaceStrings(user_message, messages, null, null, last_goals);
        let user_messages = [{role: 'user', content: user_message}];

        let res = await this.chat_model.sendRequest(user_messages, system_message);

        let goal = null;
        try {
            let data = res.split('```')[1].replace('json', '').trim();
            goal = JSON.parse(data);
        } catch (err) {
            console.log('Failed to parse goal:', res, err);
        }
        if (!goal || !goal.name || !goal.quantity || isNaN(parseInt(goal.quantity))) {
            console.log('Failed to set goal:', res);
            return null;
        }
        goal.quantity = parseInt(goal.quantity);
        return goal;
    }

    async _saveLog(prompt, messages, generation, tag) {
        if (!settings.log_all_prompts)
            return;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        let logEntry;
        let task_id = this.agent.task.task_id;
        if (task_id == null) {
            logEntry = `[${timestamp}] \nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        } else {
            logEntry = `[${timestamp}] Task ID: ${task_id}\nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        }
        const logFile = `${tag}_${timestamp}.txt`;
        await this._saveToFile(logFile, logEntry);
    }

    async _saveToFile(logFile, logEntry) {
        let task_id = this.agent.task.task_id;
        let logDir;
        if (task_id == null) {
            logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs`);
        } else {
            logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs/${task_id}`);
        }

        await fs.mkdir(logDir, { recursive: true });

        logFile = path.join(logDir, logFile);
        await fs.appendFile(logFile, String(logEntry), 'utf-8');
    }
}
