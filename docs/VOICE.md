# 语音和模型接口配置说明（用户看这一份就够）

大肥鱼用到三种 AI 接口：**对话模型**（她想什么、说什么）、**语音合成**（她说话的声音）、**语音识别**（听懂你按住说的话）。三种都可以换成你自己的服务。

## 1. 密钥放在哪：`keys.json`

项目根目录下的 `keys.json`，只存放密钥，不会上传到 git。格式如下：

```json
{
  "DEEPSEEK_API_KEY": "sk-…",
  "DASHSCOPE_API_KEY": "sk-…",
  "QWEN_API_KEY": "sk-…"
}
```

- `DEEPSEEK_API_KEY`：对话模型（DeepSeek）。
- `DASHSCOPE_API_KEY`：阿里云百炼，用于语音合成和语音识别。
- `QWEN_API_KEY`：语义检索（记忆、例子挑选）用的通义千问。通常和百炼是同一个 key。

其他服务的密钥按 Mindcraft 的命名规则添加，比如 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY`。

## 2. 对话模型在哪改：`profiles/dafeiyu.json`

- `"model": "deepseek-chat"`：换成别的模型名，或者写成对象，例如 `{"api": "openai", "model": "gpt-4o", "url": "https://你的地址/v1"}`。凡是兼容 OpenAI 接口格式的服务，都可以用 `url` 指过去。
- `"embedding": "qwen"`：语义检索用的服务。

## 3. 她的声音在哪改

- **音色：** `profiles/dafeiyu.json` 里的 `"speak_model": "bailian/qwen-audio-3.1-tts-flash/qiaoxiaojiao_v3.1"`，格式是"服务/模型/音色"。
- **服务地址和密钥名：** `settings.js` 里 `"voice"` → `"tts"` 的 `provider`、`base_url`、`api_key_env`。目前支持 `bailian` 和 `openai`，后者兼容 OpenAI 的 `/audio/speech` 接口，可以接本地或第三方 TTS。
- **总开关：** `settings.js` 里的 `"speak": true`。设成 false，她就只打字、不出声。

## 4. 按住说话在哪改：`settings.js` 里的 `"voice"`

| 字段 | 作用 |
|---|---|
| `input_enabled` | true 打开按住说话 |
| `owner_name` | 你在游戏里的名字（她会把听到的话当作你说的） |
| `hotkey` | 按住说话的键，默认 `MOUSE4`（鼠标侧键）。可选 A–Z、0–9、F1–F24、SPACE、LALT/RALT、LCTRL/RCTRL、LSHIFT/RSHIFT、MOUSE4/MOUSE5 |
| `game_window` | 只在标题含这个词的窗口位于前台时生效，默认 `Minecraft` |
| `asr.provider` / `asr.base_url` / `asr.model` / `asr.api_key_env` | 语音识别服务，默认百炼的 `qwen3-asr-flash`；`openai` 表示兼容 OpenAI 的 `/audio/transcriptions` 接口 |

**用法：** Minecraft 在前台时，按住鼠标侧键说话，说完松开（最长 20 秒）；按 Esc 取消。

## 5. 出错时你会看到什么

不会只说一句"没听清"，而是告诉你具体原因：
- 密钥错误或没有权限（HTTP 401/403）
- 被限流（HTTP 429）
- 服务端故障
- 网络连不上
- 没听到声音
- 麦克风打不开

这些提示会出现在游戏聊天里，同时写进日志。

## 6. 代码在哪（给开发者）

- `src/voice/providers.js`：语音合成接口
- `src/voice/asr.js`：语音识别接口和出错提示
- `src/voice/hotkey.js`，加上 `voice-hotkey.ps1` / `voice-hotkey.cs`：按键录音
- `src/voice/playback.js`，加上 `owned-playback.ps1`：播放
- `src/voice/index.js`：把以上几部分串起来
- `src/agent/speak.js`：她说话时调用的入口

**自检：** 运行 `node dev/voice-roundtrip.mjs`。它先把一句话合成语音，再拿去识别，全程不播放声音。2026-10-26 实测，说的是"老大，我是大肥鱼，今天去砍树了。"，识别回来一字不差。


**实机验证（2026-10-26 上午，主人亲测）：**
- 用启动器启动后，按住侧键说"喂"和"哎呀，没事，你去睡觉吧"，都识别对了；
- 她回的"哎，在呢在呢……"和"那我去睡了，你也早点歇"，主人从扬声器听到了。
- 注意：启动器的"语音与按键"里有两个开关（她说话、按住说话），现在默认都是打开的。
