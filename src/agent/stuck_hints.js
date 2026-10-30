// Suggestions, not rules (owner 2026-10-26): when she has stayed within a few blocks for a while although she is busy moving, she is
// told what she could try, a little more each time - dig or go round, then climb out (!pillarUp / !goToSurface), and only after
// several minutes that a teleport up is allowed if she really cannot get out (!teleportToSurface, said aloud). She decides; staying,
// sleeping or simply being idle never counts as stuck.
const STAGES = [
    { after: 90e3, text: '你在这附近转了一分半钟还没出去。可以考虑换条路、把挡路的方块挖开，或者用你学会的脱困技能。' },
    { after: 180e3, text: '已经卡了三分钟。可以考虑直接往上出去：!pillarUp 会一边往上挖一边在脚下垫方块，一直爬到见天；也可以试 !goToSurface。' },
    { after: 300e3, text: '卡了五分钟了。如果真的出不去，可以用 !teleportToSurface 传送到正上方的地面（会先说一声）。要不要用由你决定，也可以喊老大帮忙。' },
];
const RADIUS = 3;

export class StuckHints {
    constructor(agent) { this.agent = agent; this.anchor = null; this.since = 0; this.stage = 0; }
    reset(pos) { this.anchor = pos ? pos.clone() : null; this.since = Date.now(); this.stage = 0; }
    update() {
        const a = this.agent, bot = a.bot, pos = bot?.entity?.position;
        if (!pos) return;
        // fishing and smelting stand still on purpose (10-27: three casts drew two "stuck" hints and she ran her escape skill)
        const busy = a.actions?.executing && !/stay|sleep|bed|fish|smelt/i.test(a.actions.currentActionLabel || '');
        if (!busy || bot.isSleeping) { this.reset(pos); return; }   // idle, resting or asleep is not stuck
        if (!this.anchor || pos.distanceTo(this.anchor) > RADIUS) { this.reset(pos); return; }
        const held = Date.now() - this.since, next = STAGES[this.stage];
        if (next && held >= next.after) {
            this.stage++;
            a.history.add('system', next.text);
            console.log(`[stuck] ${Math.round(held / 1000)} s near ${this.anchor.floored()} - stage ${this.stage} hint`);
        }
    }
}
