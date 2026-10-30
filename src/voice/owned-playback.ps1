param([switch]$SelfTest)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Media;
using System.Threading.Tasks;
public static class OwnedWavPlayer {
    public static void Run(string file) {
        using (SoundPlayer player = new SoundPlayer(file)) {
            player.Load();
            Task playback = Task.Run((Action)(() => player.PlaySync()));
            Task<string> stop = Task.Run((Func<string>)(() => Console.ReadLine()));
            int winner = Task.WaitAny(playback, stop);
            player.Stop();
            if (winner == 0) playback.GetAwaiter().GetResult();
        }
    }
}
'@
if($SelfTest){Write-Output '{"ownedPlaybackCompiled":true,"audioStarted":false}';exit 0}
if([String]::IsNullOrWhiteSpace($env:DAFEIYU_PLAY_WAV)){throw 'Missing owned WAV path'}
[OwnedWavPlayer]::Run($env:DAFEIYU_PLAY_WAV)
