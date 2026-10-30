import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isWatery } from './library/swim.js';

// Owner 10-28 (5 drownings on the new save: each receipt left her thinking she was on dry ground): whether her head is under water,
// as a fact, at the end of every action and - once per dive, at half air - while one runs. Told only; nothing is stopped or moved.
function headUnderWater(bot) {
    const p = bot?.entity?.position;
    const head = p && bot.blockAt?.(p.offset(0, 1.62, 0));
    return isWatery(head);   // kelp and seagrass count: they are always in water (10-29 lab run 4)
}
function waterFact(bot) {
    if (!headUnderWater(bot)) return '';
    const air = Math.round(bot.oxygenLevel ?? 20);
    return `（你现在头在水下：氧气 ${air}/20，大约还有 ${Math.max(0, Math.round(air * 0.75))} 秒，到 0 开始掉血。!swimUp 往上游。）`;
}

// Owner 10-28 ("回家忘记关门了"): the pathfinder opens doors on her way and never closes them, and nothing told her. A door, gate or
// trapdoor this action opened that is still open at its end is told, with how to close it. Told only; nothing is closed for her.
const OPENABLE = /(_door|_fence_gate|_trapdoor)$/;
export function watchDoors(bot) {
    const opened = new Map();
    const onUpdate = (old, now) => {
        if (!now || !OPENABLE.test(now.name) || now.getProperties?.().half === 'upper') return;
        if (now.getProperties?.().open === true && old?.getProperties?.().open === false) opened.set(now.position.toString(), now.position.clone());
    };
    bot?.on?.('blockUpdate', onUpdate);
    return () => {
        bot?.removeListener?.('blockUpdate', onUpdate);
        const still = [...opened.values()].map((p) => bot.blockAt?.(p)).filter((b) => b && OPENABLE.test(b.name) && b.getProperties?.().open === true);
        if (!still.length) return '';
        const where = still.slice(0, 3).map((b) => `${b.name} (${b.position.x}, ${b.position.y}, ${b.position.z})`).join('、');
        return `（这一趟你路过时推开了 ${where}，现在还开着。要关就走到旁边 !useOn("hand", "${still[0].name}")，它会点离你最近的那扇。）`;
    };
}

// Owner 10-28 (same talk, "要，一起做"): on a walk the pathfinder may dig through blocks - a wall of her own house too - and put down
// dirt to climb, and she only saw "-2 dirt" in the bag line. For actions whose point is getting somewhere, what her body dug or placed
// on the way is told with where. Actions that dig or place on purpose (collecting, placing, her own code) keep their own receipts.
export const WALKS = /^action:(goToPlayer|followPlayer|goToCoordinates|searchForBlock|searchForEntity|moveAway|goToRememberedPlace|goToBed|givePlayer|putInChest|takeFromChest|viewChest|craftRecipe|smeltItem|clearFurnace|shear|milk|useOn|retreat)$/;
// The house she built in the world she is in now (bots/<name>/house.json), or null - one built before she arrived here belongs to another world
export function currentHouse(agent) {
    try {
        const h = JSON.parse(fs.readFileSync(path.join('bots', agent.name, 'house.json'), 'utf8'));
        const since = agent.memoryS?.worldStatus?.()?.since;
        return Number.isFinite(since) && Date.parse(h.at) < since ? null : h;
    } catch { return null; }
}
export function watchTrail(bot, houseOf = null) {
    const was = new Map(), dug = [], placed = [];
    const key = (p) => `${p.x},${p.y},${p.z}`;
    const onUpdate = (old, now) => { if (old && now && old.name !== now.name && now.type === 0) was.set(key(now.position), old.name); };
    const onDug = (b) => { if (b?.position) dug.push(b.position.clone()); };
    const onPlaced = (_old, now) => { if (now?.position) placed.push({ name: now.name, pos: now.position.clone() }); };
    bot?.on?.('blockUpdate', onUpdate); bot?.on?.('diggingCompleted', onDug); bot?.on?.('blockPlaced', onPlaced);
    return () => {
        bot?.removeListener?.('blockUpdate', onUpdate); bot?.removeListener?.('diggingCompleted', onDug); bot?.removeListener?.('blockPlaced', onPlaced);
        // 10-29 lab: a craft puts a table down and digs it back - not something her body did to get through. A cell put down and dug
        // again in the same trip is net nothing; a table or furnace is never stepped on.
        for (let i = placed.length - 1; i >= 0; i--) {
            const j = dug.findIndex((p) => key(p) === key(placed[i].pos));
            if (j >= 0) { dug.splice(j, 1); placed.splice(i, 1); }
            else if (/^(crafting_table|furnace)$/.test(placed[i].name)) placed.splice(i, 1);
        }
        if (!dug.length && !placed.length) return '';
        const at = (p) => `(${p.x}, ${p.y}, ${p.z})`;
        const list = (rows) => rows.slice(0, 5).join('、') + (rows.length > 5 ? ` 等 ${rows.length} 处` : '');
        // owner 10-29 ("补墙全部删了吧"): a block is named by what it was and where - no house wall, no "a hole now", no door: told as part
        // of her house it set her patching walls all night instead of going home.
        const parts = [];
        if (dug.length) parts.push(`挖掉了 ${dug.length} 块：${list(dug.map((p) => `${was.get(key(p)) || '方块'} ${at(p)}`))}`);
        if (placed.length) parts.push(`垫了 ${placed.length} 块：${list(placed.map((r) => `${r.name} ${at(r.pos)}`))}`);
        return `（这一趟路上你的身体为了过去${parts.join('；')}。）`;
    };
}

// Owner 10-28 ("提醒她卡住了…不然的话感觉又脚本化了 / 你有更好的提议吗"): when she is stuck she is told what is around her body - what she
// stands on and how far the ground is, each side at foot and head height, what is over her head. Facts only; what to do is hers.
export function bodyFact(bot) {
    const pos = bot?.entity?.position;
    if (!pos || !bot.blockAt) return '';
    const p = pos.floored(), at = (dx, dy, dz) => bot.blockAt(p.offset(dx, dy, dz));
    const nm = (b) => (!b ? '没加载' : b.boundingBox === 'block' ? b.name : (b.name === 'air' || b.name === 'cave_air' ? '空' : `${b.name}(能穿过)`));
    const under = at(0, -1, 0);
    let ground = '';
    if (under && under.boundingBox !== 'block') {
        let d = 1; while (d < 8 && at(0, -d, 0) && at(0, -d, 0).boundingBox !== 'block') d++;
        ground = d < 8 ? `，下面空着，离下面的实地 ${d} 格` : '，下面空着 8 格以上';
    }
    else if (under && /leaves|_log$|_wood$/.test(under.name)) {
        // 10-28 23:37 she stood on an oak's leaves 2 above the ground: say it is a tree, and how far down the ground is
        let d = 1; while (d < 12 && at(0, -d, 0) && (/leaves|_log$|_wood$/.test(at(0, -d, 0).name) || at(0, -d, 0).boundingBox !== 'block')) d++;
        ground = d < 12 ? `（是树，你在树上；往下 ${d} 格才是 ${at(0, -d, 0)?.name}）` : '（是树，往下 12 格内没有别的实地）';
    }
    const sides = [['东', 1, 0], ['南', 0, 1], ['西', -1, 0], ['北', 0, -1]].map(([n, dx, dz]) => `${n}边 脚边${nm(at(dx, 0, dz))}/头边${nm(at(dx, 1, dz))}`);
    return `（你身边：脚下 ${nm(under)}${ground}；${sides.join('；')}；头顶 ${nm(at(0, 2, 0))}。）`;
}

// A shared boolean is not cancellation: a new action clears it while an old await
// may still resume. Preserve ownership across awaits, including plugin callbacks.
const actionScope = new AsyncLocalStorage();

export function isCancelledAction(bot) {
    const run = actionScope.getStore();
    return !!(run && run.manager.agent.bot === bot && (run.cancelled || run.finished || run.id !== run.manager.runId));
}

/** The first actual stop request for this run; never infer it from a newer run. */
export function cancelledBy(bot) {
    const run = actionScope.getStore();
    return run && run.manager.agent.bot === bot && run.cancelled ? run.cancelledBy ?? null : null;
}

/**
 * Something the running action must undo if it is cancelled - e.g. a raised shield (activateItem) that pathfinder.setGoal(null) does
 * not release (GPT #3377; keys did not need this, #3357). It runs once, before the next action takes over, outside the stale guard;
 * an action that finishes normally cleans up in its own finally and the hook is simply dropped. Clean only what that action set.
 */
export function onActionCancel(bot, fn) {
    const run = actionScope.getStore();
    if (!run || run.manager.agent.bot !== bot || typeof fn !== 'function') return false;
    (run.cleanups ||= []).push(fn);
    return true;
}

function runCleanups(run) {
    const list = run?.cleanups || [];
    if (run) run.cleanups = [];
    for (const fn of list) { try { actionScope.run(null, () => fn(run?.cancelledBy ?? null)); } catch (e) { console.warn('[action] cancel cleanup failed:', e?.message || e); } }
}

export class ActionManager {
    constructor(agent) {
        this.agent = agent;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.timedout = false;
        this.resume_func = null;
        this.resume_name = '';
        this.last_action_time = 0;
        this.recent_action_counter = 0;
        this.activeRun = null;
    }

    _guardBody() {
        const bot = this.agent.bot;
        if (this.guardedBot === bot) return;
        this.guardedBot = bot;
        const stale = () => {
            const run = actionScope.getStore();
            return run?.manager === this && (run.cancelled || run.finished || run.id !== this.runId);
        };
        for (const key of ['interrupt_code', 'output']) {
            let value = bot[key];
            Object.defineProperty(bot, key, { configurable: true, enumerable: true,
                get: () => stale() ? (key === 'interrupt_code' ? true : '') : value,
                set: next => { if (!stale()) value = next; }
            });
        }
        const guard = (object, names, asyncResult = false) => {
            for (const name of names) {
                const original = object?.[name];
                if (typeof original !== 'function') continue;
                object[name] = function (...args) {
                    if (stale()) return asyncResult ? Promise.resolve(false) : undefined;
                    return original.apply(this, args);
                };
            }
        };
        // closeWindow / close_window always go through: closing a container is harmless, and a cancelled action's cleanup is exactly
        // when it has to (10-29 lab: a dropped close left the furnace window open and broke every equip after it)
        guard(bot, ['setControlState', 'clearControlStates', 'chat', 'whisper', 'attack', 'stopDigging', 'deactivateItem', 'activateItem', 'swingArm', 'setQuickBarSlot']);
        guard(bot, ['dig', 'look', 'lookAt', 'equip', 'unequip', 'placeBlock', 'activateBlock', 'activateEntity', 'consume', 'craft', 'toss', 'tossStack', 'transfer', 'clickWindow', 'putAway', 'putSelectedItemRange', 'moveSlotItem', 'openContainer', 'openFurnace', 'sleep', 'wake'], true);
        guard(bot.pathfinder, ['stop', 'setGoal', 'setMovements']);
        guard(bot.pathfinder, ['goto'], true);
        guard(bot.collectBlock, ['cancelTask']);
        guard(bot.collectBlock, ['collect'], true);
        guard(bot.pvp, ['stop', 'attack']);
        // An operation already inside a plugin can resume below the public API.
        // Drop only its gameplay writes; ordinary network keepalives remain valid.
        const writes = new Set(['block_dig', 'block_place', 'use_item', 'use_entity', 'held_item_slot', 'arm_animation', 'window_click', 'position', 'position_look', 'look', 'flying', 'chat', 'chat_command', 'chat_message', 'player_input', 'entity_action']);
        if (bot._client?.write) {
            const write = bot._client.write;
            bot._client.write = function (name, ...args) {
                if (stale() && writes.has(name)) return;
                return write.call(this, name, ...args);
            };
        }
        const emit = bot.emit;
        bot.emit = function (name, ...args) {
            if (name === 'idle' && stale()) return false;
            return emit.call(this, name, ...args);
        };
    }

    async resumeAction(actionFn, timeout) {
        return this._executeResume(actionFn, timeout);
    }

    async runAction(actionLabel, actionFn, { timeout, resume = false } = {}) {
        if (resume) {
            return this._executeResume(actionLabel, actionFn, timeout);
        } else {
            return this._executeAction(actionLabel, actionFn, timeout);
        }
    }

    async stop(by = null) {
        if (!this.executing) return;
        const run = this.activeRun;
        if (run) {
            if (!run.cancelled) run.cancelledBy = typeof by === 'string' && by.length ? by : null;
            run.cancelled = true;
        }
        runCleanups(run);
        const owns = () => this.executing && this.activeRun === run;
        const interrupt = () => actionScope.run(null, () => this.agent.requestInterrupt());
        // setGoal(null) cancels now; pathfinder.stop() alone waits for a waypoint.
        actionScope.run(null, () => this.agent.bot.pathfinder?.setGoal?.(null));
        // dafeiyu 2026-10-26 (soak2: a !placeHere hung for 10+ min): an action that will not stop is abandoned, not answered with a process
        // restart - movement and keys are released, she is told, and she carries on. The abandoned promise is left to settle on its own.
        const timeout = setTimeout(() => {
            if (!owns()) return;
            console.warn(`Action "${this.currentActionLabel}" refused to stop after 10 s - abandoning it.`);
            try { actionScope.run(null, () => { this.agent.bot.pathfinder?.setGoal?.(null); this.agent.bot.clearControlStates(); }); } catch { /* best effort */ }
            this.agent.history.add('system', `上一个动作（${this.currentActionLabel}）卡死了，已经强行放弃。换个做法或者做点别的。`);
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            this.activeRun = null;
            this.runId = (this.runId || 0) + 1;
        }, 10000);
        while (owns()) {
            interrupt();
            console.log('waiting for code to finish executing...');
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        clearTimeout(timeout);
    } 

    cancelResume() {
        this.resume_func = null;
        this.resume_name = null;
    }

    async _executeResume(actionLabel = null, actionFn = null, timeout = 10) {
        const new_resume = actionFn != null;
        if (new_resume) { // start new resume
            this.resume_func = actionFn;
            assert(actionLabel != null, 'actionLabel is required for new resume');
            this.resume_name = actionLabel;
        }
        if (this.resume_func != null && (this.agent.isIdle() || new_resume) && (!this.agent.self_prompter.isActive() || new_resume)) {
            this.currentActionLabel = this.resume_name;
            let res = await this._executeAction(this.resume_name, this.resume_func, timeout);
            return res;
        } else {
            return { success: false, message: null, interrupted: false, timedout: false };
        }
    }

    async _executeAction(actionLabel, actionFn, timeout = 10) {
        let TIMEOUT, run;
        try {
            if (this.last_action_time > 0) {
                let time_diff = Date.now() - this.last_action_time;
                if (time_diff < 20) {
                    this.recent_action_counter++;
                }
                else {
                    this.recent_action_counter = 0;
                }
                if (this.recent_action_counter > 3) {
                    console.warn('Fast action loop detected, cancelling resume.');
                    this.cancelResume(); // likely cause of repetition
                }
                if (this.recent_action_counter > 5) {
                    console.error('Infinite action loop detected, shutting down.');
                    this.agent.cleanKill('Infinite action loop detected, shutting down.');
                    return { success: false, message: 'Infinite action loop detected, shutting down.', interrupted: false, timedout: false };
                }
            }
            this.last_action_time = Date.now();
            console.log('executing code...\n');

            // await current action to finish (executing=false), with 10 seconds timeout
            // also tell agent.bot to stop various actions
            if (this.executing) {
                console.log(`action "${actionLabel}" trying to interrupt current action "${this.currentActionLabel}"`);
            }
            await this.stop(actionLabel);

            // clear bot logs and reset interrupt code
            this._guardBody();
            this.agent.clearBotLogs();
            // 10-29 lab (DeepSeek #4121): a furnace window an earlier action never closed stayed bot.currentWindow, so every equip clicked
            // inventory slots in the furnace's numbering ("invalid operation") and she could dig nothing for 10 minutes. No action keeps
            // a container open for the next one.
            if (this.agent.bot?.currentWindow) {
                console.warn(`[actions] closing a ${this.agent.bot.currentWindow.type} window an earlier action left open`);
                try { this.agent.bot.closeWindow(this.agent.bot.currentWindow); } catch (e) { console.warn('[actions] close failed', e?.message); }
            }

            this.executing = true;
            this.currentActionLabel = actionLabel;
            this.currentActionFn = actionFn;
            this.currentActionStartedAt = Date.now();   // danger_notice: an action begun after a warning is her answer to it
            this.runId = (this.runId || 0) + 1;
            run = this.activeRun = { manager: this, id: this.runId, cancelled: false, cancelledBy: null, finished: false };
            this.timedout = false;
            const mine = () => this.runId === run.id && this.activeRun === run;

            // timeout in minutes; dafeiyu 2026-10-26: upstream actions default to none (-1), so one hung step froze her for good
            TIMEOUT = this._startTimeout(timeout > 0 ? timeout : 3, run);

            // start the action
            run.doors = watchDoors(this.agent.bot);
            run.trail = WALKS.test(actionLabel) ? watchTrail(this.agent.bot, () => this.agent.houses?.active?.() ?? currentHouse(this.agent)) : null;
            await actionScope.run(run, actionFn);
            { const wet = waterFact(this.agent.bot); if (wet) this.agent.bot.output = (this.agent.bot.output || '') + wet + '\n'; }
            { const trail = run.trail?.() || ''; run.trail = null; if (trail) this.agent.bot.output = (this.agent.bot.output || '') + trail + '\n'; }
            { const door = run.doors(); run.doors = null; if (door) this.agent.bot.output = (this.agent.bot.output || '') + door + '\n'; }
            run.finished = true;
            run.cleanups = [];   // finished on its own: its finally already cleaned up

            // mark action as finished + cleanup
            clearTimeout(TIMEOUT);
            if (!mine()) return { success: false, message: 'abandoned', interrupted: true, timedout: true };
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            this.activeRun = null;

            // get bot activity summary
            let output = this.getBotOutputSummary();
            let interrupted = this.agent.bot.interrupt_code;
            let timedout = this.timedout;
            this.agent.clearBotLogs();

            // if not interrupted and not generating, emit idle event
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }

            // return action status report
            return { success: true, message: output, interrupted, timedout };
        } catch (err) {
            clearTimeout(TIMEOUT);
            run?.doors?.(); run?.trail?.();   // only to remove their listeners
            if (run) { run.finished = true; run.cleanups = []; run.doors = null; run.trail = null; }
            if (run && (this.runId !== run.id || this.activeRun !== run)) return { success: false, message: 'abandoned', interrupted: true, timedout: true };
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            this.activeRun = null;
            this.cancelResume();
            console.error("Code execution triggered catch:", err);
            // Log the full stack trace
            console.error(err.stack);
            await this.stop();
            err = err.toString();

            let message = this.getBotOutputSummary() +
                '!!Code threw exception!!\n' +
                'Error: ' + err + '\n' +
                'Stack trace:\n' + err.stack+'\n';

            let interrupted = this.agent.bot.interrupt_code;
            this.agent.clearBotLogs();
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }
            return { success: false, message, interrupted, timedout: false };
        }
    }

    getBotOutputSummary() {
        const { bot } = this.agent;
        if (bot.interrupt_code && !this.timedout) return '';
        let output = bot.output;
        const MAX_OUT = 500;
        if (output.length > MAX_OUT) {
            output = `Action output is very long (${output.length} chars) and has been shortened.\n
          First outputs:\n${output.substring(0, MAX_OUT / 2)}\n...skipping many lines.\nFinal outputs:\n ${output.substring(output.length - MAX_OUT / 2)}`;
        }
        else {
            output = 'Action output:\n' + output.toString();
        }
        bot.output = '';
        return output;
    }

    // Owner 10-28: "动作超时强制打断改成提醒" / "3分钟后改成每分钟一次，如果她说明理由就不做提醒". A long action is no longer stopped: after
    // TIMEOUT_MINS she is told how long it has run, then once a minute, until it ends, she stops it or changes course, or she gives a
    // reason with !continueAction. (A stop she asks for that does not take within 10 s is still abandoned - see stop().)
    _startTimeout(TIMEOUT_MINS = 10, run = this.activeRun) {
        const label = this.currentActionLabel, startedAt = Date.now();
        const remind = () => {
            if (this.activeRun !== run || run?.finished || run?.cancelled || run?.reason) return;
            const mins = Math.round((Date.now() - startedAt) / 60000);
            const last = String(this.agent.bot.output || '').trim().split('\n').filter(Boolean).slice(-1)[0] || '';
            const text = `（提醒）${String(label).replace(/^action:/, '!')} 已经做了 ${mins} 分钟还没结束${last ? `，最近的输出：${last.slice(0, 120)}` : ''}。`
                + '要停就 !stop，想做别的直接下命令；想接着做，用 !continueAction("理由") 说一句为什么，这个动作就不再提醒。';
            console.warn(`Action ${label} has run ${mins} min - reminded, not stopped.`);
            this.agent.handleMessage('system', text, 1)?.catch?.(() => {});
            setTimeout(remind, 60 * 1000);
        };
        // Owner 10-28 (DeepSeek #4066): a !collectBlocks stood still for 10 min with no turn of hers in between. While an action runs and
        // her body has neither moved a block nor gained/lost an item for 60 s, she is told once a minute - told, never stopped. Actions that
        // stand still on purpose (waiting, fishing, a furnace, a bed, eating, aiming, a shield - not crafting: it walks to a table first, and
        // final-114 15:20 a !craftRecipe stood 126 s on that walk) and the body's own modes are left out.
        const still = /^(mode:|action:(stay|fish|smeltItem|clearFurnace|goToBed|consume|shoot|block|lookAtPosition)$)/.test(label);
        const bot = this.agent.bot, bag = () => (bot.inventory?.items?.() || []).map((i) => `${i.name}:${i.count}`).sort().join(',');
        let at = bot.entity?.position?.clone?.(), held = bag(), since = Date.now();
        const watch = still ? null : setInterval(() => {
            if (this.activeRun !== run || run?.finished || run?.cancelled) { clearInterval(watch); return; }
            const p = bot.entity?.position, now = bag();
            if (!p || !at || p.distanceTo(at) >= 1 || now !== held) { at = p?.clone?.(); held = now; since = Date.now(); return; }
            if (run?.reason || Date.now() - since < 60 * 1000) return;
            since = Date.now();
            const last = String(bot.output || '').trim().split('\n').filter(Boolean).slice(-1)[0] || '';
            console.warn(`Action ${label}: no progress for 60 s - told, not stopped.`);
            this.agent.handleMessage('system', `（提醒）${String(label).replace(/^action:/, '!')} 已经做了 ${Math.round((Date.now() - startedAt) / 1000)} 秒，最近 60 秒没有进展：你没挪动 1 格，背包也没变化${last ? `，最近的输出：${last.slice(0, 120)}` : ''}。`
                + bodyFact(bot)
                + '要停就 !stop，想做别的直接下命令；想接着等，用 !continueAction("理由") 说一句为什么。', 1)?.catch?.(() => {});
        }, 5000);
        // final-112 13:12-13:22: !collectBlocks carries its own 10 min, so the first reminder came at 10 min instead of the owner's 3
        return setTimeout(remind, Math.min(TIMEOUT_MINS, 3) * 60 * 1000);
    }

    /** !continueAction: her reason for letting the running action go on; no more reminders for it. */
    keepGoing(reason) {
        if (!this.executing || !this.activeRun) return false;
        this.activeRun.reason = String(reason || '').slice(0, 200) || '(no reason given)';
        return true;
    }

}

// owner 10-30 (screenshot "把牛打死了但是说牛去哪了"): she killed the cow, but her own !equip cancelled the attack in the same moment
// and its result was dropped as late - she then looked for "the cow that ran away". A thing she hit that dies within 10 s is told,
// whatever became of the action that hit it. Once per bot.
export function watchKills(bot, tell) {
    if (!bot || bot._killNotes) return;
    bot._killNotes = true;
    const hits = new Map(), attack = bot.attack;
    bot.attack = function (target, ...rest) {
        if (target?.id !== undefined) hits.set(target.id, { name: target.name, at: Date.now() });
        return attack.call(this, target, ...rest);
    };
    bot.on('entityDead', (e) => {
        const h = hits.get(e?.id);
        if (!h || Date.now() - h.at > 10_000) return;
        hits.delete(e.id);
        const p = e.position?.floored?.();
        tell(`（你打的 ${h.name} 死了${p ? `，在 (${p.x}, ${p.y}, ${p.z})` : ''}，掉的东西在那附近地上。）`);
    });
}
