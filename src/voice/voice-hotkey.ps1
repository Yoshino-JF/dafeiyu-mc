param([int]$VirtualKey=5,[string]$TitlePattern='Minecraft',[switch]$Probe,[switch]$SelfTest)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -Path (Join-Path $PSScriptRoot 'voice-hotkey.cs')
if($SelfTest){[GamePtt]::SelfTest();exit 0}
if($Probe){[GamePtt]::Probe();exit 0}
[GamePtt]::Run($VirtualKey,$TitlePattern)
