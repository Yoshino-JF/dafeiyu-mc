import { exec, spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { TTSConfig as gptTTSConfig } from '../models/gpt.js';
import { TTSConfig as geminiTTSConfig } from '../models/gemini.js';
import { synthesize, playWavs } from '../voice/index.js';
import settings from './settings.js';

// dafeiyu 2026-10-25 (PLAN F): a "bailian/model/voice" speak_model goes through src/voice (configurable provider, WAV playback).
const ownVoice = (model) => typeof model === 'string' ? model.startsWith('bailian/') : model?.api === 'bailian';

let speakingQueue = []; // each item: {text, model, audioData, ready, at}
let isSpeaking = false;
// Owner 10-28 ("她会把每一句都读出来…文本都过好多句了她还在读以前的"): she says lines faster than they can be read aloud, and the queue read
// every one in order, minutes behind. Like a person talking: the line being read finishes at the end of its sentence, then only her
// newest line is read - older ones still waiting, or waiting longer than STALE_MS, are skipped. Every line still goes to chat and memory.
const STALE_MS = 10_000;
const skipped = (item, why) => console.log(`[tts] skipped (${why}): ${JSON.stringify(String(item.text).slice(0, 60))}`);

// Owner 10-29 ("她的语音也一直在报坐标之类的，甚至还有命令，很出戏"): her voice read "放到 (-3,68,14) 门口去了" and "placeHere 只能在我
// 脚下那一格放，那就试试 useOn". What she says aloud is talk: coordinates, command and code names and item ids are left out of the
// voice only - chat, memory and logs keep her line as written.
export function spokenText(text) {
    const COORD = '\\s*-?\\d+(?:\\.\\d+)?\\s*[,，]\\s*-?\\d+(?:\\.\\d+)?(?:\\s*[,，]\\s*-?\\d+(?:\\.\\d+)?)?\\s*';
    return String(text ?? '')
        .replace(/[!！]\s*[a-zA-Z_]\w*(\([^)]*\))?/g, '\u0000这个\u0000')                              // !command(args), args included
        .replace(/\b(skills|world|bot)\.[\w.]+(\([^)]*\))?/g, '\u0000这个\u0000')                         // code
        .replace(/\b[a-z]+[A-Z]\w*(\([^)]*\))?/g, '\u0000这个\u0000')                                   // camelCase names (placeHere, useOn)
        .replace(new RegExp(`（${COORD}）`, 'g'), '')                                                    // an aside "（x,y,z）" goes
        .replace(new RegExp(`[（(]${COORD}[)）]`, 'g'), '\u0000那儿\u0000')                               // "到 (x,y,z) 去" -> "到那儿去"
        .replace(new RegExp(`-?\\d+(?:\\.\\d+)?\\s*[,，]\\s*-?\\d+(?:\\.\\d+)?\\s*[,，]\\s*-?\\d+(?:\\.\\d+)?`, 'g'), '\u0000那儿\u0000')
        .replace(/\b[a-z]+(_[a-z]+)+\b/g, '')                                                            // item/block ids (spruce_log)
        .replace(/[ \t]*\u0000[ \t]*/g, '')                                                              // no gaps around what replaced them
        .replace(/[（(]\s*[)）]/g, '')
        .replace(/\s*([，。！？、；：,.!?])(\s*[，、,])+/g, '$1')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

export function speak(text, speak_model) {
    const model = speak_model || 'system';
    text = spokenText(text);
    if (!text || !/[\p{L}\p{N}]/u.test(text)) return;

    const item = { text, model, audioData: null, ready: null, at: Date.now() };

    if (model === 'system') {
        // no preprocessing needed
        item.ready = Promise.resolve();
    } else if (ownVoice(model)) {
        item.ready = synthesize(text, typeof model === 'string' ? model : `bailian/${model.model}/${model.voice}`, settings.voice?.tts || {})
            .then(files => { item.files = files; })
            .catch(err => { item.error = err; });
    } else {
    item.ready = fetchRemoteAudio(text, model)
        .then(data => { item.audioData = data; })
        .catch(err => { item.error = err; });
    }

    speakingQueue.push(item);
    if (!isSpeaking) processQueue();
}

async function fetchRemoteAudio(txt, model) {
    function getModelUrl(prov) {
        if (prov === 'openai') return gptTTSConfig.baseUrl;
        if (prov === 'google') return geminiTTSConfig.baseUrl;
        return 'https://api.openai.com/v1';
    }

    let prov, mdl, voice, url;
    if (typeof model === 'string') {
        [prov, mdl, voice] = model.split('/');
        url = getModelUrl(prov);
    } else {
        prov = model.api;
        mdl = model.model;
        voice = model.voice;
        url = model.url || getModelUrl(prov);
    }

    if (prov === 'openai') {
        return gptTTSConfig.sendAudioRequest(txt, mdl, voice, url);
    } else if (prov === 'google') {
        return geminiTTSConfig.sendAudioRequest(txt, mdl, voice, url);
    }
    else {
        throw new Error(`TTS Provider ${prov} is not supported.`);
    }
}

async function processQueue() {
    isSpeaking = true;
    if (speakingQueue.length === 0) {
        isSpeaking = false;
        return;
    }
    for (const old of speakingQueue.splice(0, speakingQueue.length - 1)) skipped(old, 'newer line waiting');
    const item = speakingQueue.shift();
    if (Date.now() - item.at > STALE_MS) {
        skipped(item, `waited ${Math.round((Date.now() - item.at) / 1000)} s`);
        isSpeaking = false;
        processQueue();
        return;
    }
    const { text: txt, model, audioData } = item;
    if (txt.trim() === '') {
        isSpeaking = false;
        processQueue();
        return;
    }

    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    // wait for preprocessing if needed
    try {
        await item.ready;
        if (item.error) throw item.error;
    } catch (err) {
        console.error('[TTS] preprocess error', err);
        isSpeaking = false;
        processQueue();
        return;
    }

    if (item.files) {
        // piece by piece (each ends at a sentence): when a newer line is waiting, the rest of this one is dropped
        for (const [i, file] of item.files.entries()) {
            if (i > 0 && speakingQueue.length) { skipped({ text: `${item.files.length - i} more piece(s) of ${txt}` }, 'newer line waiting'); break; }
            await playWavs([file]);
        }
        isSpeaking = false;
        processQueue();
        return;
    }

    if (model === 'system') {
        // system TTS
        const cmd = isWin
            ? `powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; \
            $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate=2; \
            $s.Speak('${txt.replace(/'/g,"''")}'); $s.Dispose()"`
            : isMac
            ? `say "${txt.replace(/"/g,'\\"')}"`
            : `espeak "${txt.replace(/"/g,'\\"')}"`;

        exec(cmd, err => {
            if (err) console.error('TTS error', err);
            isSpeaking = false;
            processQueue();
        });

    } 
    else {
        // audioData was already fetched in speak()
        const audioData = item.audioData;

        if (!audioData) {
            console.error('[TTS] No audio data ready');
            isSpeaking = false;
            processQueue();
            return;
        }

        try {
            if (isWin) {
                const tmpPath = path.join(os.tmpdir(), `tts_${Date.now()}.mp3`);
                await fs.writeFile(tmpPath, Buffer.from(audioData, 'base64'));

                const player = spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', tmpPath], {
                    stdio: 'ignore', windowsHide: true
                });
                player.on('error', async (err) => {
                    console.error('[TTS] ffplay error', err);
                    try { await fs.unlink(tmpPath); } catch {}
                    isSpeaking = false;
                    processQueue();
                });
                player.on('exit', async () => {
                    try { await fs.unlink(tmpPath); } catch {}
                    isSpeaking = false;
                    processQueue();
                });

            } else {
                const player = spawn('ffplay', ['-nodisp','-autoexit','pipe:0'], {
                    stdio: ['pipe','ignore','ignore']
                });
                player.stdin.write(Buffer.from(audioData, 'base64'));
                player.stdin.end();
                player.on('exit', () => {
                    isSpeaking = false;
                    processQueue();
                });
            }
        } catch (e) {
            console.error('[TTS] Audio error', e);
            isSpeaking = false;
            processQueue();
        }
    }
}
