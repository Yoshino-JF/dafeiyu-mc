# 新项目接口说明（给 GPT / DeepSeek，2026-10-25 Claude）

项目根目录 `D:\DeepSeek\dafeiyu-mc` 就是 Mindcraft 的分支：上游 `mindcraft-bots/mindcraft` 的 develop，提交 `f6a9556`（2026-10-02），本地分支名 `dafeiyu`。

所有新东西都放在这个目录里：
- `docs/`：文档
- `dev/`：开发用的服务器和世界（GPT 的，不进 git）
- `logs/`：她的决策和动作日志（不进 git）

## 1. 运行

- **Node：** `D:/DeepSeek/ai-vtuber-play/ai-vtuber/node22/node.exe`
- **启动：** 在项目根目录执行 `node main.js`。它先启动 MindServer（端口 8091），再拉起一个 agent 进程，她就进服了。agent 退出后，MindServer 会自动重启它。
- **主要设置（`settings.js`）：**
  - `host` 127.0.0.1，`port` 25677（GPT 的开发副本），`minecraft_version` "26.1.2"，`auth` offline
  - `base_profile` survival，`profiles` 目前是 `./profiles/dafeiyu-dev.json`（临时用）。DeepSeek 写的 `profiles/dafeiyu.json` 复核过后，改成指向它
  - `show_command_syntax` none：聊天里不显示 `!命令`
- **密钥：** `keys.json`（不进 git），里面有 `DEEPSEEK_API_KEY`、`DASHSCOPE_API_KEY`，`QWEN_API_KEY` 和 DashScope 是同一个 key。发布版只用 DeepSeek（10-30 主人：千问不在分工里），语义检索（10-31 主人定）：填了百炼 key 的用户，千问向量直接用这个 key（src/models/prompter.js），挑 2 段示例、挑技能说明、记忆去重都走向量；没有百炼 key 就纯 DeepSeek：8 段示例全部放进提示词（src/utils/examples.js），技能说明和记忆去重用离线规则。
- **依赖：** `mineflayer` 锁在 4.39.0，`minecraft-data` 3.117.0，`package-lock.json` 进 git。上游的补丁里，只有 mineflayer 那一份针对 4.39 重新生成过（`patches/mineflayer+4.39.0.patch`）。
- **已验证：** 2026-10-25 23:27 在 GPT 的开发副本上，她能登录、能出生，用中文打了招呼，执行了 `!stats`，自己选择去 `!collectBlocks("birch_log",5)`。

## 2. 决策和动作日志（Claude 已实现，格式见 `docs/log-spec.md`）

- **文件：** `logs/agent.ndjson`，每行一条，格式是 `[decision] {json}` 或 `[act] {json}`。每天启动时，把前一天的文件改名为 `agent-YYYY-MM-DD.ndjson`，保留 7 天。
- **`[decision]`：** 写在 `src/agent/agent.js` 里，她每回答一次就写一行。
  - `gate`：自己发起的（system 或 self-prompt）记 `autonomy`，回应玩家记 `chat`。
  - `options`：当时所有可用的命令名，加上 `chat`（只说话不做动作）。
  - `chosen`：她用的命令名，没用命令就记 `chat`。
  - `why`：命令前面那句话，最多 40 个字。
  - `ms`：模型想了多久。
  - 用了不存在的命令，加 `offmenu:true`。
- **反射也算决策：** 写在 `src/agent/modes.js`，反射触发时写一行，`gate:'danger'`，选项只有这一个反射。
- **`[act]`：** 写在 `src/agent/library/skills.js`，用 `src/agent/dafeiyu_log.js` 里的 `actLogged` 包住 20 个最底层的技能函数（走、挖、放、打、合成、熔炼、开箱存取、吃、给物品、开门、睡、种地、使用方块）。
  - 技能函数返回 `true` 才记 `ok:true`。这些函数自己会检查世界的实际变化。
  - 失败时，从技能写到 `bot.output` 的话里归出 `reason`（固定的几类）。
  - 嵌套调用也会记，比如挖方块时先走过去，会多出一行 `goto`。
- **以后新加的底层动作：** 照这个办法用 `actLogged('kind', fn, [参数名])` 包一层。用管理员权限盖房记成 `kind:'op-fill'`（DeepSeek 的要求）。

## 3. 各自接入的位置

| 谁 | 做什么 | 接在哪里 |
|---|---|---|
| GPT：启动器 | 启动、停止、看状态 | 用 socket.io 连 MindServer `http://localhost:8091`。<br>· 发：`start-agent`、`stop-agent`、`restart-agent`（参数是 agent 名字）；`shutdown` 关闭全部<br>· 订阅：先发 `listen-to-agents`，之后会收到 `bot-output`（agent 名字, 文字），也就是她的输出<br>· 给她发文字：`send-message`（agent 名字, {from, message}）<br>· 也可以直接管 `node main.js` 这个子进程 |
| GPT：一键盖房 | 新命令 `!buildHouse` | 在 `src/agent/commands/actions.js` 里加一条，格式照着同文件的其他命令写；底层函数用 `actLogged('op-fill', …)` 包住。她有管理员权限，可以用 `bot.chat('/place template …')` 和 `/fill`，先清场、垫地基再放房子 |
| GPT：寻路和基础动作 | 在开发副本上比较寻路库 | Mindcraft 里所有移动都走 `skills.js` 的 `goToPosition` 等函数（用的是 `bot.pathfinder`）；要换寻路库，就换这几个函数的内部实现，函数名不改 |
| DeepSeek：人设 | `profiles/dafeiyu.json` | `settings.js` 的 `profiles` 指过去即可；占位符写法见 `profiles/defaults/` |
| DeepSeek：长期记忆 S | 换掉只有 500 字的记忆 | 现在的记忆在 `src/agent/history.js`（第 37 行截到 500 字），地点存在 `src/agent/memory_bank.js`。新模块放 `src/agent/memory/`，对外提供 `remember(entry)`、`recall(query, k)`、`consolidate()`；提示词里通过 profile 的占位符注入，我负责在 `prompter` 里接上 |
| Claude：语音 | 按住说话 → 识别 → 模型 → 语音回复 | 上游的说话在 `src/agent/speak.js`（`settings.speak`，只支持系统自带的 TTS）；我把旧项目的百炼 TTS 和按住说话面板接过来，供应商做成可配置 |
| Claude：保护别人的规矩 | 不拆主人保护的建筑等 | 在 `skills.js` 的 `breakBlockAt`、`collectBlock`、`placeBlock` 加保护区检查，失败记 `reason:'protected'` |

## 4. 已知问题（今晚记下，明天处理）

- 第一次登录约 40 秒后，她自己说了一句 "Exiting."，然后退出，MindServer 自动重启后一切正常。原因还没查。
- `profiles/dafeiyu-dev.json` 只是临时用的人设，等 DeepSeek 的正式人设复核完就替换。
- 自动反射（自动保命、自卫等）目前还是上游 survival 的默认值，大多是开着的。主人要求默认关掉、由她自己开关，明天在 profile 里改。

## 5. 2026-10-26 凌晨补充（Claude）

- **正式人设已启用：** `settings.js` 改指向 `profiles/dafeiyu.json`。我改了其中两处，备份在 `dev/dafeiyu.json.before-claude-20261025`：
  - 语义检索改用 qwen，因为没有 OpenAI 的 key（10-30 已去掉：发布版只用 DeepSeek）；
  - 反射开关按主人的要求改了：只开脱困、捡东西、让位置、发呆时四处看，自动保命、自卫、自动打猎、自动插火把都关掉。
- **保护区：** `src/agent/protect.js`。
  - 在她出生时给 `bot.dig` 套上一层检查，现成技能和她现写的代码都绕不过去。
  - 保护区存在 `bots/<名字>/play-protections.json`，格式和旧项目一样。
  - 新命令：`!protectAround(玩家名, 半径, 说明)`，以这个玩家为中心圈出保护区；`!unprotectHere()`，取消她所站位置的保护。
  - 挖保护区里的方块会失败，`[act]` 里记 `reason:'protected'`。
- **现写新动作 `!newAction` 已打开：** `allow_insecure_coding: true`，单次运行最多 5 分钟。代码在 SES 沙箱里运行，只能用 `skills`、`world`、`Vec3`、`log`，拿不到文件、网络、子进程这些系统功能。
- **稳定性：** run12 和 run13 合计 8 分钟，一次都没有重启。她会自己从坑里出来、换地方砍树。
