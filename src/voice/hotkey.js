import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

export function hotkeyCode(name) {
    const key=String(name).trim().toUpperCase();
    if(/^[A-Z0-9]$/.test(key))return key.charCodeAt(0);
    if(/^F([1-9]|1[0-9]|2[0-4])$/.test(key))return 111+Number(key.slice(1));
    const named={SPACE:32,LALT:164,RALT:165,LCTRL:162,RCTRL:163,LSHIFT:160,RSHIFT:161,MOUSE4:5,MOUSE5:6};
    if(Object.hasOwn(named,key))return named[key];
    throw new Error('voice.hotkey requires A-Z, 0-9, F1-F24, SPACE, LALT/RALT, LCTRL/RCTRL, LSHIFT/RSHIFT or MOUSE4/MOUSE5');
}

// One owned audio helper, no Minecraft controller or global key suppression.
export function startGameHotkey({settings,onStart,onAudio,onCancel,onError,log=console.log,spawnFn=spawn,platform=process.platform}) {
    if(platform!=='win32')throw new Error('游戏按住说话目前需要 Windows，可设 input_mode=web');
    const vk=hotkeyCode(settings.hotkey),script=fileURLToPath(new URL('./voice-hotkey.ps1',import.meta.url));
    const child=spawnFn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,
        '-VirtualKey',String(vk),'-TitlePattern',settings.game_window],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let closed=false,active=false,admitted=false,press=0,rejectReason='no_scope';
    const lines=createInterface({input:child.stdout});
    lines.on('line',line=>{
        if(closed||line.length>900000)return;
        let data;try{data=JSON.parse(line);}catch{return;}
        if(data.type==='ready')log('[voice] 游戏按住说话：'+settings.hotkey+'（Minecraft 前台，Esc 取消）');
        else if(data.type==='start'){
            press=Number.isInteger(data.id)&&data.id>0?data.id:press+1;
            rejectReason='no_scope';
            // Admission handshake. The helper has NOT opened the microphone yet: it waits for this line,
            // plays the start cue and only then records. A rejected press therefore never enters the audio
            // and never sounds like a successful start.
            let accepted=false;
            try{accepted=onStart()===true;}catch{accepted=false;}
            active=accepted;admitted=accepted;
            child.stdin.write(accepted?'accept:'+press+'\n':'reject:'+press+':'+rejectReason+'\n');
            log('[voice] '+(accepted?'录音中…':'当前状态不接受语音'));
        }else if(data.type==='rejected'){active=false;if(admitted){admitted=false;onCancel();}}
        else if(data.type==='audio'){
            if(!active)return;active=false;admitted=false;
            if(typeof data.data==='string'&&/^[A-Za-z0-9+/]*={0,2}$/.test(data.data))
                Promise.resolve().then(()=>onAudio(Buffer.from(data.data,'base64'))).catch(()=>log('[voice] 游戏语音处理失败'));
        }else if(data.type==='cancel'||data.type==='focus_lost'){active=false;admitted=false;onCancel();}
        else if(data.type==='error'){active=false;
            if(typeof onError==='function'){try{onError(Number(data.code||0));}catch{}}
            else onCancel();
            log('[voice] 麦克风不可用（Windows 音频错误 '+Number(data.code||0)+'），请检查默认输入设备与麦克风权限');}
    });
    // Do not print native compiler stderr or audio into the brain log.
    child.stderr.on('data',()=>{});
    child.stdin.on('error',()=>{});
    child.once('error',()=>{active=false;onCancel();log('[voice] 游戏热键录音器启动失败');});
    child.once('exit',code=>{active=false;onCancel();lines.close();if(!closed&&code!==0)log('[voice] 游戏热键录音器已退出，请检查 PowerShell/音频设备');});
    return {child,setRejectReason(reason){if(['no_key','busy','no_scope','closed'].includes(reason))rejectReason=reason;},
        cancel(){active=false;onCancel();if(!closed)child.stdin.write('cancel\n');},
        close(){if(closed)return;closed=true;active=false;onCancel();child.stdin.end('stop\n');}};
}
