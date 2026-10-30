// Protocol adapters only. Import never starts a recorder, player or network request.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export function audioBase(base) {
    let u;try{u=new URL(base);}catch{throw Error('语音 API 地址无效');}
    const local=['127.0.0.1','localhost','[::1]'].includes(u.hostname);
    if(u.username||u.password||u.search||u.hash||!(u.protocol==='https:'||u.protocol==='http:'&&local))
        throw Error('语音接口需要 HTTPS 或本机 HTTP 基础地址，不能包含密钥、查询参数或片段');
    return {url:u.href.replace(/\/+$/,''),local};
}
export function voiceConfigured(settings,key) {
    if(key)return true;
    try{return settings.provider==='openai'&&audioBase(settings.base_url).local;}catch{return false;}
}
export function speechConfiguration(settings,voiceSettings,profileVoice,{env=process.env,keys={}}={}) {
    const provider=settings.provider||'bailian';
    if(!['bailian','openai'].includes(provider))throw Error('未知语音播报接口类型');
    const parts=String(profileVoice||'').split('/');
    const configured=String(settings.voice||'').split('/');
    const legacySpec=provider==='bailian'&&configured.length>=3;
    const model=settings.model||(legacySpec?configured[1]:'')||(provider==='bailian'?parts[1]||'qwen-audio-3.1-tts-flash':'tts-1');
    const voice=(legacySpec?configured[2]:settings.voice)||(provider==='bailian'?parts[2]||'qiaoxiaojiao_v3.1':'alloy');
    const base_url=settings.base_url||(provider==='bailian'?'https://trial.cn-beijing.maas.aliyuncs.com':'https://api.openai.com/v1');
    const key=settings.api_key||(provider==='bailian'&&(voiceSettings.provider||'bailian')==='bailian'?voiceSettings.api_key:'')
        ||env[settings.api_key_env]||keys[settings.api_key_env]||'';
    audioBase(base_url);
    return {provider,model,voice,base_url,key,timeout_ms:settings.timeout_ms||20000};
}

// SoundPlayer needs a WAV, not an MP3/JSON error page. Handle streaming RIFF length placeholders.
export function playbackWav(value) {
    const b=Buffer.from(value);
    if(b.length<44||b.length>16*1024*1024||b.toString('ascii',0,4)!=='RIFF'||b.toString('ascii',8,12)!=='WAVE')throw Error('播报接口未返回有效 WAV 音频');
    let fmt=false,data=false;
    for(let at=12;at+8<=b.length;) {
        const id=b.toString('ascii',at,at+4);let size=b.readUInt32LE(at+4);
        // Qwen also emits this paired signed-31-bit streaming RIFF/data sentinel.
        // Do not treat an arbitrary oversized chunk (a truncated file) as streaming.
        const signedStream=id==='data'&&at===36&&b.readUInt32LE(4)===0x7fffffbf&&size===0x7fffff9b;
        if(id==='data'&&(size===0xffffffff||size===0||signedStream)) {
            size=b.length-at-8;
            if(signedStream&&(!fmt||size%b.readUInt16LE(32)!==0))throw Error('播报 WAV 音频不完整');
            b.writeUInt32LE(size,at+4);
        }
        if(at+8+size>b.length)throw Error('播报 WAV 音频不完整');
        if(id==='fmt '){fmt=size>=16&&b.readUInt16LE(at+8)===1&&[1,2].includes(b.readUInt16LE(at+10))&&[8,16].includes(b.readUInt16LE(at+22));}
        if(id==='data'&&size>0)data=true;
        at+=8+size+(size%2);
    }
    if(!fmt||!data)throw Error('播报接口需要 PCM WAV 音频');
    b.writeUInt32LE(b.length-8,4);return b;
}

export async function createSpeechSynthesizer(config,{cacheDir,fetchFn=fetch}={}) {
    const {provider,model,voice,key,timeout_ms=20000}=config,base=audioBase(config.base_url);
    if(!['bailian','openai'].includes(provider))throw Error('未知语音播报接口类型');
    if(!key&&!(provider==='openai'&&base.local))throw Error('缺少语音播报 API Key');
    return {synthesizeBailian:async text=>{
        if(typeof text!=='string'||!text.trim()||text.length>(provider==='bailian'?120:512))throw Error('播报文字无效或过长');
        const hash=createHash('sha256').update(JSON.stringify([provider,base.url,model,voice,text])).digest('hex');
        const file=path.join(cacheDir,provider+'-'+hash+'.wav');
        if(fs.existsSync(file)){try{playbackWav(fs.readFileSync(file));return file;}catch{}}
        const signal=AbortSignal.timeout(timeout_ms),endpoint=provider==='bailian'?'/api/v1/services/audio/tts/SpeechSynthesizer':'/audio/speech';
        let r;
        try{r=await fetchFn(base.url+endpoint,{method:'POST',redirect:'error',signal,
            headers:{'content-type':'application/json',...(key?{authorization:'Bearer '+key}:{})},
            body:JSON.stringify(provider==='bailian'?{model,input:{text,voice,format:'wav',sample_rate:24000}}:{model,input:text,voice,response_format:'wav'})});}
        catch{throw Error('语音播报超时或连接失败');}
        if(!r.ok)throw Error('语音播报接口 HTTP '+r.status);
        if(provider==='bailian'){
            const data=await r.json().catch(()=>null),url=data?.output?.audio?.url||data?.output?.url;
            let download;try{download=new URL(url);}catch{throw Error('百炼未返回有效音频地址');}
            // Official responses can still contain plain-HTTP OSS links. Use TLS for those known audio hosts.
            if(download.protocol==='http:'&&/^dashscope-result-[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/i.test(download.hostname))download.protocol='https:';
            if(download.username||download.password||download.hash||!(download.protocol==='https:'||download.protocol==='http:'&&base.local&&['127.0.0.1','localhost','[::1]'].includes(download.hostname)))throw Error('百炼音频地址不安全');
            try{r=await fetchFn(download.href,{redirect:'error',signal});}catch{throw Error('百炼音频下载失败');}
            if(!r.ok)throw Error('百炼音频下载 HTTP '+r.status);
        }
        const chunks=[];let size=0;
        try{for await(const chunk of r.body){size+=chunk.length;if(size>16*1024*1024)throw Error();chunks.push(Buffer.from(chunk));}}
        catch{throw Error('语音播报音频读取失败或过大');}
        const wav=playbackWav(Buffer.concat(chunks));
        fs.mkdirSync(cacheDir,{recursive:true});
        fs.writeFileSync(file,wav);
        const files=fs.readdirSync(cacheDir).filter(f=>/^(openai|bailian)-[a-f0-9]{64}\.wav$/.test(f)).map(f=>({file:path.join(cacheDir,f),time:fs.statSync(path.join(cacheDir,f)).mtimeMs})).sort((a,b)=>b.time-a.time);
        for(const old of files.slice(60))try{fs.unlinkSync(old.file);}catch{}
        return file;
    }};
}
