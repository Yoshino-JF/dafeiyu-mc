import { Vec3 } from 'vec3';
import { Camera } from "./camera.js";
import fs from 'fs';

export class VisionInterpreter {
    constructor(agent, allow_vision) {
        this.agent = agent;
        this.allow_vision = allow_vision;
        this.fp = './bots/'+agent.name+'/screenshots/';
        if (allow_vision) {
            this.camera = new Camera(agent.bot, this.fp);
        }
    }

    // owner 10-28 (screenshot "视力功能被关了……"): without a picture model these two commands did not even turn her head and answered
    // "Vision is disabled", which she took as her eyesight being switched off. Now she turns, and is told from the game's own data what
    // is there and whether something stands in the line of sight - no picture is claimed.
    dirWord(dx, dz) {
        const a = Math.atan2(dz, dx) * 180 / Math.PI, i = Math.round(((a % 360) + 360) % 360 / 45) % 8;
        return ['东', '东南', '南', '西南', '西', '西北', '北', '东北'][i];
    }

    sightFact(to) {
        const bot = this.agent.bot, eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0), dist = eye.distanceTo(to);
        const hit = bot.blockAtCursor(Math.max(1, dist - 0.6));
        return hit ? `视线在 ${hit.position.distanceTo(eye).toFixed(0)} 格处先碰到 ${hit.name} (${hit.position.x}, ${hit.position.y}, ${hit.position.z})，它挡在中间。` : '中间没有方块挡着。';
    }

    async lookWithoutPictures(kind, a, b, c) {
        const bot = this.agent.bot, me = bot.entity.position;
        if (kind === 'player') {
            const player = bot.players[a]?.entity;
            if (!player) return `附近找不到 ${a}（不在你能感知的范围里）。`;
            const p = player.position;
            if (b === 'with') {
                await bot.look(player.yaw, player.pitch, true);
                const hit = bot.blockAtCursor(64);
                return `你顺着 ${a} 看的方向看过去。` + (hit ? `最先看到的是 ${hit.name} (${hit.position.x}, ${hit.position.y}, ${hit.position.z})，离你约 ${Math.round(hit.position.distanceTo(me))} 格。` : '64 格内没有方块，那边是天空或很远的地方。');
            }
            const head = new Vec3(p.x, p.y + (player.height || 1.8) * 0.9, p.z);
            await bot.lookAt(head, true);
            const dy = Math.round(p.y - me.y);
            return `你转头看向 ${a}：在你${this.dirWord(p.x - me.x, p.z - me.z)}边约 ${Math.round(p.distanceTo(me))} 格${dy ? `，比你${dy > 0 ? '高' : '低'} ${Math.abs(dy)} 格` : ''}。${this.sightFact(head)}`;
        }
        const x = Math.floor(a), y = Math.floor(b), z = Math.floor(c), center = new Vec3(x + 0.5, y + 0.5, z + 0.5);
        await bot.lookAt(center, true);
        const there = bot.blockAt(new Vec3(x, y, z));
        const dy = Math.round(y - me.y);
        let fact = this.sightFact(center);
        const hit = bot.blockAtCursor(Math.max(1, center.distanceTo(me.offset(0, 1.62, 0)) + 0.5));
        if (hit && hit.position.x === x && hit.position.y === y && hit.position.z === z) fact = '中间没有方块挡着。';
        return `你转头看向 (${x}, ${y}, ${z})：在你${this.dirWord(x + 0.5 - me.x, z + 0.5 - me.z)}边约 ${Math.round(center.distanceTo(me))} 格${dy ? `，比你脚下${dy > 0 ? '高' : '低'} ${Math.abs(dy)} 格` : ''}，那一格是 ${there ? there.name : '没加载的地方'}。${fact}`;
    }

    async lookAtPlayer(player_name, direction) {
        if (!this.allow_vision || !this.agent.prompter.vision_model.sendVisionRequest) {
            return this.lookWithoutPictures('player', player_name, direction);
        }
        let result = "";
        const bot = this.agent.bot;
        const player = bot.players[player_name]?.entity;
        if (!player) {
            return `Could not find player ${player_name}`;
        }

        let filename;
        if (direction === 'with') {
            await bot.look(player.yaw, player.pitch);
            result = `Looking in the same direction as ${player_name}\n`;
            filename = await this.camera.capture();
        } else {
            await bot.lookAt(new Vec3(player.position.x, player.position.y + player.height, player.position.z));
            result = `Looking at player ${player_name}\n`;
            filename = await this.camera.capture();

        }

        return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
    }

    async lookAtPosition(x, y, z) {
        if (!this.allow_vision || !this.agent.prompter.vision_model.sendVisionRequest) {
            return this.lookWithoutPictures('position', x, y, z);
        }
        let result = "";
        const bot = this.agent.bot;
        await bot.lookAt(new Vec3(x, y + 2, z));
        result = `Looking at coordinate ${x}, ${y}, ${z}\n`;

        let filename = await this.camera.capture();

        return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
    }

    getCenterBlockInfo() {
        const bot = this.agent.bot;
        const maxDistance = 128; // Maximum distance to check for blocks
        const targetBlock = bot.blockAtCursor(maxDistance);
        
        if (targetBlock) {
            return `Block at center view: ${targetBlock.name} at (${targetBlock.position.x}, ${targetBlock.position.y}, ${targetBlock.position.z})`;
        } else {
            return "No block in center view";
        }
    }

    async analyzeImage(filename) {
        try {
            const imageBuffer = fs.readFileSync(`${this.fp}/${filename}.jpg`);
            const messages = this.agent.history.getHistory();

            const blockInfo = this.getCenterBlockInfo();
            const result = await this.agent.prompter.promptVision(messages, imageBuffer);
            return result + `\n${blockInfo}`;

        } catch (error) {
            console.warn('Error reading image:', error);
            return `Error reading image: ${error.message}`;
        }
    }
} 