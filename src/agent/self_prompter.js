const STOPPED = 0
const ACTIVE = 1
const PAUSED = 2
// Owner pivot 2026-10-25 ("她想干什么，是api决定的"; never a statue): with no goal of her own she would stand still until someone
// spoke to her. After LIFE_IDLE_MS idle with self-prompting stopped, she is handed her own life back - an open goal that says
// nothing about WHAT to do. The model picks; a goal she sets herself with !goal replaces it.
export const LIFE_IDLE_MS = 20000;
export const LIFE_PROMPT = '自由地过你自己的生活：按你现在的心情和想法决定想做什么，探索、采集、建造、找人聊天、休息看风景都行，做腻了就换一件，不用请示任何人。记忆里有你自己写下的长远想做的事和教训，想参考就参考。';
export class SelfPrompter {
    constructor(agent) {
        this.agent = agent;
        this.state = STOPPED;
        this.loop_active = false;
        this.interrupt = false;
        this.prompt = '';
        this.idle_time = 0;
        this.cooldown = 2000;
        this.stopped_idle = 0;
    }

    start(prompt) {
        console.log('Self-prompting started.');
        if (!prompt) {
            if (!this.prompt)
                return 'No prompt specified. Ignoring request.';
            prompt = this.prompt;
        }
        this.state = ACTIVE;
        this.prompt = prompt;
        this.startLoop();
    }

    isActive() {
        return this.state === ACTIVE;
    }

    isStopped() {
        return this.state === STOPPED;
    }

    isPaused() {
        return this.state === PAUSED;
    }

    async handleLoad(prompt, state) {
        if (state == undefined)
            state = STOPPED;
        this.state = state;
        this.prompt = prompt;
        if (state !== STOPPED && !prompt)
            throw new Error('No prompt loaded when self-prompting is active');
        if (state === ACTIVE) {
            await this.start(prompt);
        }
    }

    setPromptPaused(prompt) {
        this.prompt = prompt;
        this.state = PAUSED;
    }

    async startLoop() {
        if (this.loop_active) {
            console.warn('Self-prompt loop is already active. Ignoring request.');
            return;
        }
        console.log('starting self-prompt loop')
        this.loop_active = true;
        while (!this.interrupt) {
            // owner 10-28: doing nothing for a while is hers to choose too - no "MUST contain a command", and a turn without one is a pause,
            // not a failure that stops her loop
            const msg = `You are self-prompting with the goal: '${this.prompt}'. Use a command (!commandName) if you want to do something; doing nothing for now is fine too. Respond:`;

            const began = Date.now();
            let used_command = await this.agent.handleMessage('system', msg, -1);
            // owner 10-28 ("有时候会顿住，不回话"): a turn of hers dropped because the owner spoke meanwhile counted as her choosing a
            // 20 s rest, and the rest could not be cut short, so after his command she stood silent until it ran out (20:02:38-20:03:00).
            // A dropped turn is not her pause; and any rest ends as soon as the loop is asked to stop.
            const cutShort = (this.agent.prompter?.most_recent_player_msg_time || 0) >= began;
            const until = Date.now() + (used_command || cutShort ? this.cooldown : LIFE_IDLE_MS);
            while (!this.interrupt && Date.now() < until) await new Promise(r => setTimeout(r, 250));
        }
        console.log('self prompt loop stopped')
        this.loop_active = false;
        this.interrupt = false;
    }

    update(delta) {
        // automatically restarts loop
        if (this.state === ACTIVE && !this.loop_active && !this.interrupt) {
            if (this.agent.isIdle())
                this.idle_time += delta;
            else
                this.idle_time = 0;

            if (this.idle_time >= this.cooldown) {
                console.log('Restarting self-prompting...');
                this.startLoop();
                this.idle_time = 0;
            }
        }
        else {
            this.idle_time = 0;
        }
        if (this.state === STOPPED && !this.loop_active) {
            this.stopped_idle = this.agent.isIdle() ? this.stopped_idle + delta : 0;
            if (this.stopped_idle >= LIFE_IDLE_MS) {
                this.stopped_idle = 0;
                console.log('Idle with no goal: handing her own life back.');
                this.start(LIFE_PROMPT);
            }
        }
        else {
            this.stopped_idle = 0;
        }
    }

    async stopLoop() {
        // you can call this without await if you don't need to wait for it to finish
        if (this.interrupt)
            return;
        console.log('stopping self-prompt loop')
        this.interrupt = true;
        while (this.loop_active) {
            await new Promise(r => setTimeout(r, 500));
        }
        this.interrupt = false;
    }

    async stop(stop_action=true) {
        this.interrupt = true;
        if (stop_action)
            await this.agent.actions.stop('self_prompt:stop');
        this.stopLoop();
        this.state = STOPPED;
    }

    async pause() {
        this.interrupt = true;
        await this.agent.actions.stop('self_prompt:pause');
        this.stopLoop();
        this.state = PAUSED;
    }

    shouldInterrupt(is_self_prompt) { // to be called from handleMessage
        return is_self_prompt && (this.state === ACTIVE || this.state === PAUSED) && this.interrupt;
    }

    handleUserPromptedCmd(is_self_prompt, is_action) {
        // if a user messages and the bot responds with an action, stop the self-prompt loop
        if (!is_self_prompt && is_action) {
            this.stopLoop();
            // this stops it from responding from the handlemessage loop and the self-prompt loop at the same time
        }
    }
}