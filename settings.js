const settings = {
    "minecraft_version": "26.1.2", // or specific version like "1.21.6"
    "host": "127.0.0.1", // or "localhost", "your.ip.address.here"
    "port": 25677, // set to -1 to automatically scan for open ports
    "auth": "offline", // or "microsoft"

    // the mindserver manages all agents and hosts the UI
    "mindserver_port": 8091,
    "auto_open_ui": false, // opens UI in browser on startup
    
    "base_profile": "survival", // survival, assistant, creative, or god_mode
    "world_name": "", // optional name of this world/save; her world-bound memories are kept per world (empty = the server's seed decides)
    "profiles": [
        "./profiles/dafeiyu.json",

        // using more than 1 profile requires you to /msg each bot indivually
        // individual profiles override values from the base profile
    ],

    "load_memory": false, // load memory from previous session
    "init_message": "你刚进入世界，用一句中文打个招呼，然后自己决定想做什么。", // sends to all on spawn
    "only_chat_with": [], // users that the bots listen to and send general messages to. if empty it will chat publicly

    "speak": true,
    // allows all bots to speak through text-to-speech. 
    // specify speech model inside each profile with format: {provider}/{model}/{voice}.
    // if set to "system" it will use basic system text-to-speech. 
    // Works on windows and mac, but linux requires you to install the espeak package through your package manager eg: `apt install espeak` `pacman -S espeak`.

    "chat_ingame": true, // bot responses are shown in minecraft chat
    "language": "en", // translate to/from this language. Supports these language names: https://cloud.google.com/translate/docs/languages
    "render_bot_view": false, // show bot's view in browser at localhost:3000, 3001...

    "allow_insecure_coding": true, // allows newAction command and model can write/run code on your computer. enable at own risk
    "allow_vision": false, // allows vision model to interpret screenshots as inputs
    "blocked_actions" : ["!checkBlueprint", "!checkBlueprintLevel", "!getBlueprint", "!getBlueprintLevel"] , // commands to disable and remove from docs. Ex: ["!setMode"]
    "code_timeout_mins": 5, // minutes code is allowed to run. -1 for no timeout
    "relevant_docs_count": 5, // number of relevant code function docs to select for prompting. -1 for all

    "max_messages": 15, // max number of messages to keep in context
    "num_examples": 2, // number of examples to give to the model, picked by the embedding model (qwen, on the Bailian key). Without one every example goes in (examples.js)
    "max_commands": -1, // max number of commands that can be used in consecutive responses. -1 for no limit
    "show_command_syntax": "none", // "full", "shortened", or "none"
    "narrate_behavior": false,
    // dafeiyu voice (PLAN F, docs/VOICE.md): her TTS voice is the profile's speak_model ("bailian/model/voice"); "speak" turns it on.
    // Push-to-talk: hold the hotkey with the Minecraft window in front. Keys are read from keys.json by name, never written here.
    "voice": {
        "input_enabled": true,
        "owner_name": "", // the launcher sets the player who runs it (release 10-31: no built-in owner)
        "hotkey": "MOUSE4",
        "game_window": "Minecraft",
        "tts": { "provider": "bailian", "base_url": "https://trial.cn-beijing.maas.aliyuncs.com", "api_key_env": "DASHSCOPE_API_KEY" },
        "asr": { "provider": "bailian", "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "model": "qwen3-asr-flash", "api_key_env": "DASHSCOPE_API_KEY", "timeout_ms": 20000 }
    }, // chat simple automatic actions ('Picking up item!')
    "chat_bot_messages": true, // publicly chat messages to other bots

    "spawn_timeout": 30, // num seconds allowed for the bot to spawn before throwing error. Increase when spawning takes a while.
    "block_place_delay": 0, // delay between placing blocks (ms) if using newAction. helps avoid bot being kicked by anti-cheat mechanisms on servers.
  
    "log_all_prompts": false, // log ALL prompts to file
};

export default settings;
