import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Each handle owns one child stdin. No PID files, process searches, or kill fallback.
export function createOwnedPlayback({spawnFn=spawn,platform=process.platform,onError=()=>{}}={}) {
    let active=null;
    function playWav(file,done=()=>{}){
        if(platform!=='win32')throw Error('Owned WAV playback requires Windows');
        active?.stop();
        const child=spawnFn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
            fileURLToPath(new URL('./owned-playback.ps1',import.meta.url))],{
            windowsHide:true,stdio:['pipe','ignore','ignore'],
            env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,TEMP:process.env.TEMP,TMP:process.env.TMP,DAFEIYU_PLAY_WAV:file},
        });
        let ended=false,stopping=false;
        const handle={stop(){
            if(stopping||ended)return;stopping=true;
            if(!child.stdin.destroyed&&!child.stdin.writableEnded)child.stdin.end('stop\n');
        }};
        active=handle;
        const finish=error=>{
            if(ended)return;ended=true;if(active===handle)active=null;
            if(error&&!stopping)onError(new Error('语音播放器不可用'));
            done(error&&!stopping?new Error('语音播放器不可用'):undefined);
        };
        child.stdin.on('error',()=>{});
        child.once('error',finish);
        child.once('close',code=>finish(code===0?null:Error('playback exited')));
        return handle;
    }
    return {playWav,close(){active?.stop();}};
}
