// Voice for 大肥鱼 (PLAN F, owner 2026-10-25): she speaks with a configurable TTS provider (bailian by default, the old project's
// voice qiaoxiaojiao_v3.1), and the owner talks to her by holding a mouse side button while Minecraft is in front. Ported from
// ai-vtuber-client (voice-providers / voice-hotkey / owned-playback / voice-input); the provider, model, voice, endpoint and key name
// all live in settings.js "voice" and keys.json - see docs/VOICE.md.
import path from 'path';
import { readFileSync } from 'fs';
import { createSpeechSynthesizer, speechConfiguration } from './providers.js';
import { createOwnedPlayback } from './playback.js';
import { startGameHotkey } from './hotkey.js';
import { transcribeWav, classifyAsrFailure } from './asr.js';

let keys = {};
try { keys = JSON.parse(readFileSync('./keys.json', 'utf8')); } catch { /* keys may come from the environment */ }
const keyOf = (name) => (name ? keys[name] || process.env[name] || '' : '');

/** "bailian/model/voice" from a profile speak_model plus the settings.voice.tts block -> the provider config. */
export function ttsConfig(speakModel, tts = {}) {
    const parts = String(speakModel || '').split('/');
    const provider = tts.provider || parts[0] || 'bailian';
    return speechConfiguration({ provider, model: tts.model || parts[1], voice: tts.voice || parts[2], base_url: tts.base_url, api_key_env: tts.api_key_env || 'DASHSCOPE_API_KEY',
        timeout_ms: tts.timeout_ms }, {}, speakModel, { keys });
}
/** Split a reply into pieces the provider accepts (bailian: 120 chars) at sentence ends where possible. */
export function speechPieces(text, max = 120) {
    const out = [];
    let rest = String(text || '').replace(/\s+/g, ' ').trim();
    while (rest.length > max) {
        const cut = Math.max(...['。', '！', '？', '…', '~', '～', '，', ',', ' '].map((c) => rest.lastIndexOf(c, max - 1)));
        const at = cut > max / 3 ? cut + 1 : max;
        out.push(rest.slice(0, at).trim()); rest = rest.slice(at).trim();
    }
    if (rest) out.push(rest);
    return out;
}

let synth = null, synthKey = '';
/** WAV files for the reply, or throws with readable prose (missing key, HTTP status, timeout). */
export async function synthesize(text, speakModel, tts = {}) {
    const config = ttsConfig(speakModel, tts), key = JSON.stringify([config.provider, config.model, config.voice, config.base_url]);
    if (!synth || synthKey !== key) { synth = await createSpeechSynthesizer(config, { cacheDir: path.resolve('./bots/voice_cache') }); synthKey = key; }
    const files = [];
    for (const piece of speechPieces(text, config.provider === 'bailian' ? 120 : 500)) files.push(await synth.synthesizeBailian(piece));
    return files;
}

const player = createOwnedPlayback({ onError: (e) => console.error('[voice] playback:', e.message) });
export function playWavs(files) {
    return files.reduce((chain, file) => chain.then(() => new Promise((resolve) => player.playWav(file, () => resolve()))), Promise.resolve());
}
export function stopSpeaking() { player.close(); }

/**
 * Push-to-talk: hold the hotkey with Minecraft in front, speak, let go. The text goes to her as a chat message from the owner.
 * A failure is told to the owner in plain words (bad key, rate limit, network) - never a silent "没听清".
 */
export function startVoiceInput(agent, voice) {
    const asr = voice?.asr || {}, owner = voice?.owner_name;
    if (!owner) { console.warn('[voice] voice.owner_name is not set - push-to-talk off'); return null; }
    const key = keyOf(asr.api_key_env || 'DASHSCOPE_API_KEY');
    let busy = false;
    return startGameHotkey({
        settings: { hotkey: voice.hotkey || 'MOUSE4', game_window: voice.game_window || 'Minecraft' },
        onStart: () => !busy,
        onCancel: () => {},
        onError: (code) => agent.openChat(`（麦克风打不开，Windows 音频错误 ${code}，检查一下默认输入设备）`),
        onAudio: async (wav) => {
            busy = true;
            try {
                const text = await transcribeWav(wav, { provider: asr.provider || 'bailian', base_url: asr.base_url, model: asr.model || 'qwen3-asr-flash', timeout_ms: asr.timeout_ms || 20000 }, key);
                console.log(`[voice] ${owner} said: ${text}`);
                agent.respondFunc(owner, text);
            } catch (e) {
                const why = classifyAsrFailure(e);
                console.warn('[voice] ASR failed:', why.code, why.status ?? '');
                agent.openChat(why.reason === 'invalid_audio' ? why.message : `（${why.message}）`);
            } finally { busy = false; }
        },
        log: (line) => console.log(line),
    });
}
