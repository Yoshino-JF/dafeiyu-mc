# 决策 / 动作日志规范（`[decision]` / `[act]`）

> 这份规范是**审计的输入契约**。字段名一旦定下就不要再改；要改请当天通知 DeepSeek（改名 ⇒ 解析重写，约 +2 h）。
> 目标：让「她是不是像脚本」可以被**算出来**，而不是靠人读聊天记录。

## 1. 为什么必须有这两行

两个数字决定了这个项目有没有真的变自由：

- **`menu_size`**：她做决定时，眼前有几个**不同**的选择。恒为 1 ⇒ 她只是在执行唯一路径（脚本）。
- **`canned_share`**：她说的话里，固定台词占多少。高 ⇒ 玩家听到的就是复读机。

这两样都只能从**决策发生的那一刻**取到。事后再从聊天记录反推是做不到的。

## 2. `[decision]` —— 每次决策一行

```
[decision] {"at":1792811345163,"gate":"autonomy","options":["gather wood","explore","follow owner","build","idle"],"chosen":"gather wood","why":"附近有树，木头不够做工具","ms":812}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `at` | epoch ms | ✓ | 决策时刻（与聊天/动作日志同一时钟） |
| `gate` | enum | ✓ | `autonomy`（她自己想干的）/ `chat`（回应老大）/ `danger`（保命反射） |
| `options` | string[] | ✓ | **她当时真的能选的项**（去重后）；用短名，别写句子。**反射类（`danger`）允许只有 1 项** |
| `chosen` | string | ✓ | 必须是 `options` 里的一个；若模型选了不在列表里的，记原文并**加 `offmenu:true`** |
| `why` | string | ✓ | 一句话理由（≤ 40 字）。**允许是"不知道/随便"**，那也是有信息量的 |
| `ms` | number | ✗ | 模型耗时 |
| `model` | string | ✗ | 本次用的模型名（配置可换模型时有用） |
| `seed` | number | ✗ | 若开了固定随机种子，写上（可复现） |

## 3. `[act]` —— 每个动作一行（原语级，不是技能级）

```
[act] {"at":1792811345773,"kind":"goto","args":{"x":-119,"y":54,"z":138},"ok":true,"ms":4120}
[act] {"at":1792811349991,"kind":"mine","args":{"x":-121,"y":62,"z":144},"ok":false,"reason":"no_path","tries":2,"fallback":"goto alternate"}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `at` | epoch ms | ✓ | 动作开始 |
| `kind` | enum | ✓ | `goto` / `mine` / `place` / `attack` / `use` / `craft` / `chest` / `sleep` / `eat` / `chat` / `op-fill` / `op-tp` / `facts` / `mode`（她自己用 !setMode 切换模式：args {mode,on}） |
| `args` | object | ✓ | 原语参数原样（坐标/方块名/实体 id/物品名） |
| `ok` | boolean | ✓ | **世界真的变了才算 true**（挖到方块消失、放到方块出现），不是"命令发出去了" |
| `reason` | enum | `ok:false` 必填 | `no_path` / `out_of_reach` / `need_tool` / `protected` / `blocked` / `not_found` / `timeout` / `refused` / `op_denied` |
| `tries` | number | ✗ | 同一原语重试次数（**>1 说明重试/降级链在工作**） |
| `fallback` | string | ✗ | 失败后换的做法（没有就写 `none`） |
| `ms` | number | ✗ | 耗时 |

**`reason` 必须是枚举**：只有这样我才能统计"哪类失败最多"、才能自动写进她的 `lessons.md`。自由文本会让统计失效。

**`kind:"facts"`（Claude 2026-10-26，C 项）**：动作结束后，从背包里数出来的真实结果，不是动作自己报的。目前只有 `!collectBlocks` 会写。字段：`action`、`args` {type,num}、`drops`（会掉出的物品名）、`start`、`now`、`missing`、`met`（尚差为 0 时为 true）。数不出来时 `met:null, unknown:true`。故意**不带 `ok`**，免得一次没收够在失败统计里被算两次。同一组数字也会以 `[实测] …` 一行进入她下一次的输入。

> 说话 vs 做到的指标定义与基线另见 `docs/metrics-said-vs-did.md`（脚本 `dev/said-vs-did.mjs`）。


## 3.2 死亡记录（PLAN D，#3028）—— 天气与昼夜必须一起记

死亡是**唯一的强信号**，但只记「被僵尸打死」学不到东西：
她今天死了 **15 次**，**39 条教训里 0 条提到雨**，而白天的僵尸死亡**全部发生在雷雨里**（雨 = 僵尸不烧）。
漏掉的不是她的推理，是**输入**。

```
[lifecycle] {"at":…,"event":"death","pos":{…},"cause":"was slain by Zombie","weather":"thunder","tod":6000}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `cause` | ✗ | 服务端死亡消息去掉名字后的部分（`was slain by Zombie`）；缺省记 `unknown` |
| `weather` | ✗ | `clear` / `rain` / `thunder`；**缺省记 `unknown`，不许猜成晴天** |
| `tod` | ✗ | 游戏内时间 0–23999；`13000–23000` 判为夜里 |

**memory 侧的入口**（一行，harness 调用即可）：

```js
memoryS.noteDeath({ cause, pos, weather, tod });
```

它写进 `raw/<day>.jsonl` 的 `type:"death"`，并在**教训生成**的输入里生成这段：

```
死亡记录（天气与昼夜是事实，不是我编的；「unknown」表示当时没测到）：
  今天死了 2 次：
    - 04:00 was slain by Zombie（thunder·白天）
    - 04:01 suffocated in a wall（clear·夜里）
```

同时 ③ 段的指令加了一句：**同一种天气或同一个时段反复出事，就把天气/昼夜一起写进教训**。

**为什么不做「死后 60 秒冷却」**（#3028 转述主人）：那是替她做决定，属于脚本化。
给她**数据**，让她自己决定；冷却不是学习，是替身。


## 4. 我从这两行算出的指标（`freedom` 审计行）

| 指标 | 算法 | 目标（第 3–7 天） |
|---|---|---|
| `menu_size` | `decision.options.length` 的中位数 / 最小值 | 中位 ≥ 4；**连续 2 次不得都为 1** |
| `canned_share` | 固定台词行数 / 总台词行数 | ≤ 20% |
| `stall_silence` | 停摆（见 I 条定义）时**没有**任何 `[decision]`/解释的次数 | **0** |
| `retry_after_failure` | `act.tries > 1` 的次数 / 天 | ≥ 1/天 |
| `distinct_kinds` | 每天 `act.kind` 的去重种类数 | ≥ 3 |
| `questions_to_player` | `[decision]{gate:"chat"}` 中 `chosen` 含提问的次数 | 1–2/天 |
| `op_use` | `kind:"op-fill"` 与其他 op 动作计数（按用途） | 记录，不设上限 |
| `world_damage` | 世界快照差分：玩家建筑附近的方块减少 | **必须为 0** |

## 5. 落地建议（1 小时以内能做完）

1. 在 Mindcraft 的 agent 循环里，**决策点**（决定做什么之前）拼好 `options` 后打一行；
2. 在**原语执行器**里，动作结束（复读世界状态确认后）打一行 `[act]`；
3. 两行都写到同一个文件：`dafeiyu-mc/logs/agent.ndjson`（**NDJSON，一行一条，不要 pretty print**）；
4. 启动时把 `logs/agent.ndjson` 轮转（按日切），保留 7 天。

## 6. 验收这两行真的在写（我来跑）

```bash
node docs/check-log-contract.mjs dafeiyu-mc/logs/agent.ndjson   # 待我提供
```
它会检查：字段齐全、`chosen ∈ options`、`reason` 是枚举、`ok:true` 的动作是否有对应的世界变化证据。

**2026-10-26 新增**（为了算 PLAN I 的停摆）：
- `[pos] {"at","x","y","z"}`：她的进程每 5 秒记一次位置，精确到 0.1 格。
- `[act] {"kind":"chat","args":{"text"},"ok":true}`：她说的每一句话都带上时间戳，这样"等天亮""先躲着"这类说明过理由的等待就能对上对应的停顿。
- 这两种都只由她本人的进程写入；测试进程写的是 `logs/test.ndjson`。
- `[act] {"kind":"pickup","args":{"item","count"},"ok":true}`：她每捡起一件东西就记一条（不管是反射、技能还是游戏自动吸取），用来核对她说的"捡到了……"（2026-10-26）。
- `[decision] {"at","gate":"result","chosen","executed":true|false,"reason"?,"result"?}`：紧跟在她做出的决定后面记一条，说明这个命令最后有没有真的执行；如果没执行，`reason` 是 `no_such_command`（没有这个命令）或 `interrupted`（被打断）。和原来那条决定共用同一个 `at`，所以能一一对上（2026-10-26）。
- `[lifecycle] {"event":"dawn_rejected","day","prevDay","from","to"}`：一次"天亮"被拒绝时记下，原因可能是死亡或复活时时间读数跳了，也可能是天数没有往前走（2026-10-26）。
- `[lifecycle] {"event":"world","key","name","seed","spawn","server"}`：每次启动后她第一次进入世界时记一条，写明这次用的世界编号由哪些部分组成（2026-10-26）。
