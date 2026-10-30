# 自由度基线（第一份数字，2026-10-25 01:4x）

来源：`logs/agent.ndjson`（run12+13，Claude 那轮 0 重启的 8 分钟 + 后续），用 `docs/check-log-contract.mjs` 跑出来的。
**这不是验收，是基线** —— 以后每轮都跑同一条命令，比数字。

```
events 222 · decisions 131 · acts 91 · span 1.05 h
decisions/h 124.6 · acts/h 86.5 · act ok 47.3%
kinds 6 {"attack":2,"mine":22,"eat":1,"goto":47,"place":6,"craft":13}
options median 52 min 1   ← 这是「动作空间」，不是「目标菜单」
offmenu 0 · chat-gate 0 · questions 8 · retried 0
failure reasons {"blocked":38,"not_found":10}
silent gaps >60s 3 · longest 1896.2s
contract ok
```

## 读数（哪些是好的，哪些是问题）

| 指标 | 读数 | 判断 |
|---|---|---|
| **动作成功率 47.3%** | 一半动作失败 | **正常起步水平**，但要看失败类型（下面） |
| **做了 6 种事** | goto/mine/craft/place/attack/eat | ✓ 不是只会一种；`goto` 占一半说明在赶路 |
| **124 次决定/小时** | ≈ 每 29 秒一次 | ✓ 没在发呆（对着 86 次动作/小时） |
| **`blocked` 38 次（占失败的 42%）** | 分类太粗 | ✗ **看不出为什么失败** —— 见下 §1 |
| **`retried 0`** | 从没重试过 | ✗ **重试/降级链还没接上**，`tries` 恒为 1 |
| **`chat-gate 0`** | 一小时里没有一次"回应老大" | ⚪ 那轮主人不在，合理；但需要确认 `gate` 真的会记 `chat` |
| **最长静默 1896 s（31 分钟）** | 3 次 >60 s 的空白 | ⚪ 大概率是 bot 被停掉省 token；**但日志里看不出来** —— 见 §2 |
| **`options` 中位 52** | 恒定的命令表 | ✗ **`menu_size` 这个指标对本架构无效**，见 §3 |

## §1 需要一条 `msg` 字段（最重要）
`blocked` 现在是**垃圾桶**：38/91 次。`reasonFrom()` 的正则没吃到 Mindcraft 的真实失败文案（`no_path` 一次都没出现，明显不对）。

**改法（一行）**：`[act]` 失败时带上失败原文的尾部 ——
```js
logAct({ kind, args, ok:false, reason, tries, fallback, msg: String(bot.output||'').slice(-200) })
```
有了 `msg`，我就能用真实样本把 `reasonFrom` 的枚举调准（离线调，不占真机）；没有它，我只能永远看到"42% 说了等于没说"。

## §2 需要一条 `[lifecycle]` 行
31 分钟的空白**分不清**是「她卡住了」还是「bot 被我停掉了」。这是审计里最忌讳的两种含义混在一起。
```js
[lifecycle] {"at":…,"event":"start|stop|respawn|reconnect"}
```
有了它，"静默"才能只在**她真的在跑**的时候算。

## §3 `menu_size` 作废，换成三个真指标
Mindcraft 的决策是「从命令表里挑一个动作」，所以 `options` 永远是那张 52 项的表 —— 它衡量的是**动作空间大小**，不是**她的选择空间**。
真正该看的三个：
1. **`distinct_kinds` 每小时**（她做的事的种类）—— 现在 6 种/1 小时 ✓
2. **`act ok 率`** —— 现在 47.3%（低说明环境难或原语弱）
3. **`silent gaps`（仅计算 bot 在跑的时间）** —— 需要 §2

如果想让 `menu_size` 有意义，只有一条路：日志里记**"她当时考虑的 2–3 个目标"**（不是命令）。这需要 agent 侧先有"目标候选"，属于 Day 3–4 的自由层，现在不做。

## §4 另外两个小发现
- `questions 8` 是我从 `why` 里按关键词猜的，**是近似值**；等 `msg` 和 `chat` 通道稳定后再校准。
- `offmenu 0` ✓ 说明她没瞎编命令名 —— 这一点目前是干净的。
