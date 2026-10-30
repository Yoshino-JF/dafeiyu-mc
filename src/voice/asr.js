// ASR, ported from ai-vtuber-client/client-agent/voice-input.mjs (owner pivot 2026-10-25): the recogniser and its failure prose, without
// the old bridge-specific scope checks.
import {audioBase} from './providers.js';

const MAX_AUDIO=44+16000*2*20;
// Audio that fails validation is reported as invalid_audio (re-record), not as an ASR failure.
const INVALID_AUDIO=/录制 20 秒以内|没有检测到清晰声音/;
const cleanText=text=>typeof text==='string'&&text.trim().length>0&&text.trim().length<=512&&!/[\r\n\x00-\x1f]/.test(text);

// Structured failure codes. The boss's complaint (2026-10-18) was that EVERY real failure came back
// as "没听清，你再说一次", so he could not tell a broken API key from a rate limit from a dead
// network. The cause is knowable at the point it happens, so it is attached to the error here and
// turned into fixed, sanitised prose by `classifyAsrFailure`. Messages never carry the key, the page
// token, the audio or the recognised text.
const asrError=Object.assign;
function fail(code,message,extra={}){const error=asrError(new Error(message),{code,...extra});return error;}

/** Turn a thrown ASR error into {code, reason, message, status} with fixed player-facing prose. */
export function classifyAsrFailure(error){
    const code=String(error?.code||''),status=Number(error?.status);
    const http=Number.isFinite(status)?status:null;
    if(code==='recording_silent')return {code,reason:'invalid_audio',status:null,
        message:'刚才没听到你说话，再按住侧键说一次？'};   // R192: said in her voice in-game - no system wording
    if(code==='recording_invalid'||(!code&&INVALID_AUDIO.test(String(error?.message||''))))return {code:code||'recording_invalid',reason:'invalid_audio',status:null,
        message:'录音格式不合格（需要 20 秒以内的单声道录音），请重录'};
    if(code==='config_no_key')return {code,reason:'asr_failed',status:null,
        message:'语音识别没有配置好：缺少识别 Key'};
    if(code==='config_provider')return {code,reason:'asr_failed',status:null,
        message:'语音识别没有配置好：接口类型不受支持'};
    if(code==='asr_http'){
        if(http===401||http===403)return {code,reason:'asr_failed',status:http,
            message:'语音接口鉴权失败（HTTP '+http+'），检查识别 Key 的权限'};
        if(http===429)return {code,reason:'asr_failed',status:http,
            message:'语音接口限流（HTTP 429），稍等几秒再说'};
        if(http!==null&&http>=500)return {code,reason:'asr_failed',status:http,
            message:'语音接口故障（HTTP '+http+'），服务端暂时不可用'};
        return {code,reason:'asr_failed',status:http,
            message:'语音接口拒绝了这次请求（HTTP '+(http===null?'?':http)+'）'};
    }
    if(code==='asr_network')return {code,reason:'asr_failed',status:http,
        message:'语音接口连接失败或超时（没有收到任何响应）'};
    if(code==='asr_empty_text')return {code,reason:'asr_failed',status:http,
        message:'语音接口有响应，但没有识别出文字'};
    return {code:code||'asr_unknown',reason:'asr_failed',status:http,
        message:'语音识别失败（原因未知）'};
}

export function validateWav(audio) {
    // The bundled recorder always emits this canonical mono 16kHz PCM16 header.
    if(!Buffer.isBuffer(audio)||audio.length<46||audio.length>MAX_AUDIO
        ||audio.toString('ascii',0,4)!=='RIFF'||audio.toString('ascii',8,12)!=='WAVE'
        ||audio.toString('ascii',12,16)!=='fmt '||audio.readUInt32LE(16)!==16
        ||audio.readUInt16LE(20)!==1||audio.readUInt16LE(22)!==1||audio.readUInt32LE(24)!==16000
        ||audio.readUInt32LE(28)!==32000||audio.readUInt16LE(32)!==2||audio.readUInt16LE(34)!==16
        ||audio.toString('ascii',36,40)!=='data'||audio.readUInt32LE(40)!==audio.length-44
        ||audio.readUInt32LE(4)!==audio.length-8||(audio.length-44)%2)throw fail('recording_invalid','请录制 20 秒以内的单声道语音');
    let energy=0;for(let i=44;i<audio.length;i+=2)energy+=audio.readInt16LE(i)**2;
    // Silence is decided BEFORE any network call: that is why the message may say "not request sent".
    if(Math.sqrt(energy/((audio.length-44)/2))<80)throw fail('recording_silent','没有检测到清晰声音，请靠近麦克风重试');
}

export async function transcribeWav(audio,{provider='bailian',base_url,model,timeout_ms=20000},key,{fetchFn=fetch,signal}={}) {
    validateWav(audio);
    if(!['bailian','openai'].includes(provider))throw fail('config_provider','未知语音识别接口类型');
    const base=audioBase(base_url);
    if(!key&&!(provider==='openai'&&base.local))throw fail('config_no_key','缺少语音识别 API Key，请配置识别密钥或指定环境变量');
    const requestSignal=AbortSignal.any([AbortSignal.timeout(timeout_ms),...(signal?[signal]:[])]);
    let body,headers={...(key?{authorization:'Bearer '+key}:{})};
    if(provider==='openai'){
        body=new FormData();body.append('model',model);body.append('response_format','json');body.append('file',new Blob([audio],{type:'audio/wav'}),'speech.wav');
    }else{
        headers['content-type']='application/json';
        body=JSON.stringify({model,messages:[{role:'user',content:[{type:'input_audio',input_audio:{data:'data:audio/wav;base64,'+audio.toString('base64')}}]}],stream:false,asr_options:{language:'zh',enable_itn:true}});
    }
    let response;
    try { response=await fetchFn(base.url+(provider==='openai'?'/audio/transcriptions':'/chat/completions'),{
        method:'POST',redirect:'error',headers,signal:requestSignal,body}); }
    catch {throw fail('asr_network','语音识别超时、取消或连接失败');}
    if(!response.ok)throw fail('asr_http','语音识别接口 HTTP '+response.status,{status:Number(response.status)});
    const data=await response.json().catch(()=>null),text=provider==='openai'?data?.text:data?.choices?.[0]?.message?.content;
    if(!cleanText(text)||data?.choices?.[0]?.finish_reason==='length')throw fail('asr_empty_text','没有取得有效识别文字，请重试');
    return text.trim();
}

