// When one of her tools changes in a way her own experience would contradict, she is told once - a fact about the tool, never advice.
// DeepSeek #3444: eight refusals of !fight (the engine reached only 16 blocks) taught her "this command does not work" and she stopped
// using it for 41 minutes; once it was fixed nothing would have told her. Each note is shown at the first spawn after it is added.
import fs from 'fs';
import path from 'path';

export const NOTES = [
    {
        id: 'fight-reach-24-2026-10-26',
        text: '（你的工具有变化）!fight 现在能打到 24 格内、上下 3 格以内的怪；以前只有 16 格，所以你之前那几次 !fight 都没开打。'
            + '!entities 也能看到 24 格内。打的时候如果被地形挡住、2 秒都靠近不了，会告诉你"它还在，但你接近不了"，由你决定接下来怎么办。',
    },
    {
        // owner 10-26 "!stay 只管不乱走、被打照常还手"; her own notes said "!stay 期间自保暂停" - true until now
        id: 'stay-and-low-hp-2026-10-26',
        text: '（你的工具有变化）!stay 现在只是"不乱走"：待命时被怪打，反射照样还手（还手会结束待命）；以前待命时自保是暂停的，现在不是了。'
            + '另外，被打时如果你的血已经在你定的撤退线以下，反射不再站着不动，而是往后退一小段拉开距离，然后告诉你结果。',
    },
    {
        // DeepSeek #3490: at 7 HP she tried !setFightStyle(..., "disengageHp", 5) and was refused (floor 8) - she may remember it as impossible
        id: 'disengage-floor-3-2026-10-26',
        text: '（你的工具有变化）撤退线 disengageHp 现在最低能调到 3（以前最低 8，所以你之前设 5 被拒绝了）。'
            + '!entities 现在也会列出 24～32 格的敌对生物，那段距离 !fight 够不着，!shoot 能射；!shoot 找不到目标时，会告诉你上次射的那只还活着在哪、还是已经死了。',
    },
    {
        // owner 10-26 19:1x; DeepSeek #3507: told at 4 m, she kept picking up drops for 12 s and was blown up
        id: 'creeper-close-stop-2026-10-26',
        text: '（你的工具有变化）苦力怕进到你 4 格以内时，你手上正在做的事（挖矿、捡东西、走路这些）会先停下来，好让你马上自己决定跑、打还是堵；不会替你动。'
            + '每只苦力怕只停一次。你自己在 !fight / !block / !shoot / !retreat 的时候不打断。',
    },
    {
        // DeepSeek #3519 (owner 10-26 20:1x): she had mapped "self_defense" to charging in and running back and forth
        id: 'hit-back-named-2026-10-26',
        text: '（你的工具有变化）self_defense 这个模式现在叫"被打还手"，说明也重写了：只有你真的挨了一下才会动，怪在附近或朝你走时它不出手；'
            + '用你自己给那种怪定的打法；血在撤退线以下时边打边退（近战怪打一下就退开，弓箭怪贴上去打完，avoid 的只退）。关掉后你挨打时身体不会自己动。开不开你自己定。',
    },
    {
        // DeepSeek #3573: 2026-10-27 01:21-01:24 she said six times the books made no sense and stopped sealing her door; three "Failed
        // to place cobblestone" cells were cobblestone in the world (server answered late) and a half-done equip read as -11/+11
        id: 'ledger-fixed-2026-10-27',
        text: '（你的工具有变化）之前"背包变化"那行有两处是工具算错了，不是你记错：有几次放方块回执写"Failed to place"，其实服务器回得慢、方块已经放上了，所以扣的那块是真的用掉了；'
            + '还有一次换手里东西换到一半就数了数，显示少了 11 块圆石和一把石镐，下一次又"多出" 11 块——东西其实一直在。现在放方块会先看那格到底放没放上，背包等稳定了再数。'
            + '另外这行算的是整个动作期间的变化，路上顺手捡到的、挡路被敲掉的（比如火把）也算在里面。',
    },
    {
        // 2026-10-27 01:55 final-36: three crafting tables failed in a row, y 53 -> 62; she guessed "位置被占""站得有点偏"
        id: 'step-aside-2026-10-27',
        text: '（你的工具有变化）往自己脚下那格放方块（!placeHere、合成时自动放工作台）要先让开一步。以前让开时会用泥土/圆石往上垫，'
            + '结果把要放的那格垫满了，所以你刚才工作台连放三次都失败、人还越垫越高，每次扣的泥土和圆石就是垫脚用掉的。现在让开只走路，不垫不挖；'
            + '走不开会直接告诉你。',
    },
    {
        // DeepSeek #3607: her own !fight 12x, 0 kills, 11 with no swing - holding dirt or cobblestone ("手里还攥着土块")
        id: 'fight-readies-weapon-2026-10-27',
        text: '（你的工具有变化）!fight 开打时，如果你手里拿的不是剑或斧，而背包里有，会先把最好的那把换到手上，回执里会说换了什么；'
            + '手里本来就是武器就不动。你今晚自己 !fight 的 12 次里有 11 次一下都没挥出去，多半是手里拿着土块或圆石。',
    },
    {
        // owner 10-27 08:2x "退一步"
        id: 'creeper-dodge-2026-10-27',
        text: '（你的身体有变化）苦力怕在 3 格内点燃引信时，身体会自己面朝它往后退一下（最多 2 秒、不往下跳），然后告诉你退到了几格。'
            + '引信只有 1.5 秒，你想一下的工夫它已经炸了，所以这一步交给身体。退完以后跑、打还是堵，还是你自己定。',
    },
    {
        // owner 10-27 08:2x: food by hunting or farming - the ways and the tools, not a plan
        id: 'food-sources-2026-10-27',
        text: '（吃的从哪来，供你参考）打猎：牛、猪、羊、鸡用 !attack("cow") 这样打，会掉生肉；生肉放熔炉用 !smeltItem("beef", 3) 烤熟（要熔炉和燃料，煤或木头都行），'
            + '熟肉回的饱食度是生肉的两三倍。!setMode("hunting", true) 能让身体闲着时自己去打附近的动物（现在是关着的）。'
            + '种地：敲草丛（short_grass）会掉小麦种子；有锄头以后，!tillAndSow("wheat_seeds") 会在你身边的草地或泥土上翻土播种，旁边 4 格内有水长得快，'
            + '几个游戏日后成熟，3 个小麦能合成面包；胡萝卜、土豆直接种。蘑菇要棕、红各一个加一只碗做成蘑菇煲才能吃。做不做、做哪样，你自己定。',
    },
    {
        // owner 10-27 08:4x: the hardest-hitting thing in the bag, any tool, and she is told how it works
        id: 'best-damage-weapon-2026-10-27',
        text: '（你的工具有变化）开打时（你的 !fight 和被打还手），身体会从背包里挑每下伤害最高的东西拿到手上，不只是剑：斧、镐、锹、三叉戟、重锤都算，'
            + '手里那件已经最高就不换，回执里会写换上了什么、每下多少伤害。每下大约：空手 1，木/金剑 4，石/铜剑 5，铁剑 6，钻石剑 7，下界合金剑 8；'
            + '木/金斧 7，石/铜/铁/钻石斧 9（打得重但出手慢，一秒不到一下；剑一秒一下半）；镐 2–6，锹 2.5–6.5，三叉戟 9。'
            + '长矛普通戳只有 1–5（铁矛 3），它厉害的是边跑边冲刺的那一下，伤害随你冲过去的速度变大；身体打架时只会普通戳，不会冲刺。有的僵尸会拿着铁矛刷出来，它的攻击够得远一些。'
            + '所以做一把更好的剑或斧，下次打架就会自动用上。做不做、做哪种，你自己定。',
    },
    {
        // 09:1x: her "钓鱼别耗" came from !useOn("fishing_rod", "water"), which only clicks the water and never catches anything
        id: 'fish-command-2026-10-27',
        text: '（你的工具有变化）现在有 !fish(次数) 了：站在开阔的水边（8 格内），它会抛竿、等鱼咬钩、收竿，每次最多等 60 秒。'
            + '以前用 !useOn("fishing_rod", "water") 只是对着水点了一下，并没有真的在钓，所以你才一直钓不上来。钓上的鳕鱼、鲑鱼能吃，烤熟更顶饿。钓不钓你自己定。',
    },
    {
        // owner 10-27 11:3x: a boat, written in her manual, so that she decides herself whether to cross a lake
        id: 'boat-command-2026-10-27',
        text: '（你的工具有变化）现在有 !boatTo(x, z) 了：包里有船时，它会走到 8 格内的水边，把船放到水上，坐上去，朝 (x, z) 直线划过去，'
            + '到了目标或者水到头了就下船，把船敲回包里。在水上划船比游泳快得多，人也不会泡在水里；船不能上岸，过湖、过河以后要接着走路。'
            + '船用 5 块同一种木板在工作台上做（摆成 U 形）：!craftRecipe("oak_boat", 1)，桦木就是 birch_boat。要不要造船、什么时候坐船，你自己定。',
    },
    {
        // GPT #3735: four of her six falls in the new save were a pathfinder bug, not her not looking - her lesson "走路看脚下" blamed herself
        id: 'parkour-fall-fixed-2026-10-27',
        text: '（你的工具有变化）你在新世界里摔死的那几次，大多不是你没看脚下：寻路带你跳过一道沟时，人还在半空，它就换成了下一步并急停，你就掉了下去。'
            + '这个毛病现在修好了：跳过去要先落地，才算走完这一步。以后寻路要是走不通，会照实说"没有路"，不会再当作已经到了。',
    },
    {
        // owner 10-27 14:3x: "if u want to use this skill u need to craft a bucket and collect water first"
        id: 'water-clutch-2026-10-27',
        text: '（你的身体多了一个反射：落地水）从会摔伤的高度（3 格以上）掉下来时，如果身上带着水桶，落地前身体会自己低头往脚下放一桶水，你落进水里就不会摔伤，落地后再把水收回桶里，事后会告诉你。'
            + '想用它，得先自己准备：用 3 个铁锭在工作台上摆成 V 形，做一个桶（!craftRecipe("bucket", 1)），再走到水边对着水用它装满，变成水桶（water_bucket）。'
            + '水桶最好放在快捷栏里，掉下来时换得快。没有水桶时它什么也不做。下界里水会蒸发；落在树叶、台阶、楼梯、栅栏这类会把水吸进去的方块上，或者落在岩浆上，都不放（放了也接不住）；从很高的地方掉下来时下落太快，不保证每次都接得住。'
            + '这个反射叫 water_clutch，默认关着，想用就用 !setMode("water_clutch", true) 打开。做不做水桶、带不带、开不开，都由你自己定。',
    },
    {
        // owner 10-27 13:0x: who is online and where is now in her stats, and what she says reaches everyone online
        id: 'online-players-2026-10-27',
        text: '（你的信息有变化）现在状态里多了一行「在线玩家」：谁在线、是不是老大、看得见的话在你哪个方向、离你多少格，太远的会写看不到在哪。'
            + '你在聊天里说的话，所有在线的人都看得到，不用走到他身边。想找人帮忙、借东西、约人一起去哪做什么，都可以直接开口；找不找、找谁、说什么，你自己定。',
    },
    {
        // owner 10-27 19:0x "先修自动脱困打断她自救动作": her lesson "卡住时!placeHere/!goToSurface会被自动unstuck打断" was the body's fault
        id: 'unstuck-no-move-2026-10-27',
        text: '（你的身体有变化：自动脱困）以前你卡住时，身体会自己往随便哪个方向挪 5 格，把你正在做的事打断，有一次还把你从往上挖的路上挪到了更深的地方。'
            + '在水里游泳时按着的上浮也被当成"卡住"，打断过你的 !placeHere。这两个毛病都改了：游泳不再算卡住；'
            + '真卡住（一个动作 20 秒没挪动 2 格）时，那个动作会停下，身体不替你挪，并告诉你卡在哪里、卡了多久；接下来怎么脱身由你自己定。',
    },
    {
        // owner 10-27 19:1x: every low-HP stretch (20 of 20 stats) had no food in the bag; she had stopped fishing ("钓鱼这水面不行")
        // after casts that were wrongly called dry
        id: 'fish-dry-fixed-2026-10-27',
        text: '（你的工具有变化：!fish）以前有几次说"浮漂没落进水里"其实是误判：浮漂落在海草里（海草长在水里，鱼照样会咬），或者抛得远、3 秒时还在空中，都被当成了落在岸上。'
            + '这个毛病修好了。你记下的"这片水面钓不了鱼"可能就是这么来的，那片水其实也许能钓；真落在岸上时还是会照实告诉你。',
    },
    {
        // GPT #3904-#3909 (final-94): a late cursor packet after an equip counted one item twice - "-1 bow" / "+1 fishing_rod" while the
        // server always had bow 1, rod 1. Her memory says "钓鱼竿丢了想捡回".
        id: 'ledger-equip-fixed-2026-10-27',
        text: '（你的工具有变化：背包变化）以前换手上拿的东西时，"背包变化"有时会把一件东西多算或少算一次，比如显示"-1 bow"或"+1 fishing_rod"，其实东西一件没丢。'
            + '这个毛病修好了。你记下的"钓鱼竿丢了""弓丢了"可能就是这么来的；想确认的话用 !inventory 看一眼。',
    },
    {
        // owner 10-28: "给她工具，让她选择，而不是强迫她打开" - the body's automatic habits became switches that start off
        id: 'tools-not-scripts-2026-10-28',
        text: '（你的身体有变化：几个自动习惯改成了开关，默认关着）以前身体会自己做这些事：苦力怕在 3 格内点燃就自己往后退（creeper_dodge）、掉下来时自己放水桶接住（water_clutch）、'
            + '一个动作 20 秒没挪动就自己停下（unstuck）、饿到 14 就自己掏东西吃。现在这些都不会自己发生了，想要哪个就用 !setMode 打开，比如 !setMode("creeper_dodge", true)；!modes 能看到全部开关。'
            + '你自己开着的被打还手（self_defense）和自保（self_preservation）照旧。自保在水下不再替你游上来：你的氧气在状态里（Air: 几/20），!swimUp 往上游、!swimDown 往下沉，什么时候上来你自己定。'
            + '挖开挨着岩浆的方块、或者挖掉脚下唯一的落脚块时，也不再拦着你，只会告诉你一声。空闲时自己离玩家远一点（elbow_room）也改成默认关了。'
            + '作弊开关（cheat：走路变瞬移、挖放变成直接改方块）老大让你自己决定开不开，别滥用就行。新命令 !teleportToPlayer("名字") 能传送到在线玩家身边（会先说一声），什么时候用你自己定。自己过日子时不一定每次都要做点什么，想歇着就歇着。',
    },
    {
        // owner 10-28: "战斗部分的反射是可以保留，但也要保证参数高度可自定义，给她开关选择的权利" + "记得在说明里写明白她可以怎么用能改哪些东西"
        id: 'fight-settings-guide-2026-10-28',
        text: '（你能自己改的东西，一次说清楚）'
            + '【身体开关】!modes 看全部开关和现在开没开；!setMode("名字", true/false) 开关：被打还手 self_defense、自保 self_preservation（着火找水、头顶落沙走开、快死时逃开再吃）、'
            + '苦力怕点燃退一步 creeper_dodge、落地水 water_clutch、卡住自动停 unstuck、作弊 cheat、空闲打猎 hunting、空闲捡东西 item_collecting、空闲插火把 torch_placing、空闲给玩家让位 elbow_room、空闲张望 idle_staring。'
            + '【怎么打】按怪的种类分别设（zombie、creeper、skeleton……；加 @hand 是空手时的那一套，比如 zombie@hand；_all 是所有怪共用的）。'
            + '!fightStyle("zombie") 看这种怪你现在的每一项设置、含义、能填的范围和缺省值，还有你打它的战绩（打了几场、打死几只、掉了多少血、用了多久）；'
            + '!setFightStyle("zombie", "设置名", "值") 改一项，下一场起生效、一直保留。能改的有：'
            + '打法 tactic（melee 贴身打 / kite 打一下退开 / avoid 不惹）；距离和节奏 approachTo、standoff、retreatTo、cadence、kiteWaitMs；'
            + '血多少脱离 disengageHp，到了之后怎么做 belowLineResponse（retreat 退开 / hit_and_back 打一下退 / keep_fighting 接着打）和 belowLineStandoff、belowLineRetreatTo；'
            + '被打还手 reflexEnabled（这种怪还不还手）、hitWindowMs、reflexRange、retryDelayMs、retryBelowLine、unreachableRetryMs（够不着的隔多久再去够）、reengageRadius、reengageDy、reengageOnVisibleReach；'
            + '不惹的怪被打时 avoidResponse（report_only 只告诉你 / retreat 退开）和 avoidRetryDelayMs；'
            + '苦力怕点燃退一步 blastDodgeEnabled、blastTriggerRange、blastTriggerDy、blastRetryMs、blastRetreatTo、blastBudgetMs（还要 creeper_dodge 开着才生效）；'
            + '打谁 engageRange、engageDy、loseRange、loseDy、threatRange、targetPolicy、retargetRange、retargetDy、retargetGain；'
            + '中途来了别的怪 onCreeperNear、onConfirmedRangedHit、onAvoidedClose、onNewUnknown、yieldRange、onThreatAfterTarget（continue 接着打 / yield 先停下交给你）；'
            + '时间 encounterBudgetMs（一场最多多久）、approachStallMs、noLaneMs、progressDistance、retreatBudgetMs、blockedRetreat；'
            + '武器 weaponPolicy（keep 用手上的 / best_damage 开打前换最狠的）；走位 approachJump、approachStrafe、retreatJump、retreatStrafe、retreatHostileClearance、retreatHostileDy；'
            + '捡掉落 loot、lootBudgetMs、lootRange；弓和盾 lead、aimHeightRatio、bowDrawTicks、shotBudgetMs、shieldHoldMs。'
            + '缺省值就是你以前一直在用的；系统只检查值能不能执行，不替你改、不给你建议。打得好不好、哪样收益高，看 !fightStyle 的战绩自己比。'
            + '【水里】状态里有氧气 Air（几/20），!swimUp 往上游、!swimDown 往下沉。【传送】!teleportToSurface 被困时传到正上方地面，!teleportToPlayer("名字") 传到玩家身边。'
            + '用不用、怎么调，都是你自己的事。',
    },
    {
        // final-109b 10:21: drowned inside her own !newAction staircase code - while code runs she gets no turn, so the Air line in her
        // stats is not seen until it ends. Her code can read it itself; whether to is hers.
        id: 'air-in-code-2026-10-28',
        text: '（你的工具：水下的氧气）你自己写的代码（!newAction）跑的时候，你看不到状态里的 Air，要等代码跑完才看得到。'
            + '代码里可以自己读：bot.oxygenLevel 是现在的氧气（满是 20，头在水下时大约每 0.75 秒少 1，到 0 开始掉血）。'
            + '在水下挖东西、走远路时，要不要让代码自己看一眼氧气、低了先上来，你自己定。',
    },
    {
        // owner 10-28: "动作超时强制打断改成提醒" / "3分钟后改成每分钟一次，如果她说明理由就不做提醒"
        id: 'long-action-reminder-2026-10-28',
        text: '（你的身体有变化：做得久的动作）以前一个动作做满 3 分钟会被强行停下，现在不会了：做满 3 分钟后每分钟提醒你一次，告诉你做了多久、最近的输出。'
            + '要停就 !stop，想做别的直接下新命令；想接着做，用 !continueAction("理由") 说一句为什么（比如"还在烧 20 块铁"），这个动作就不再提醒。'
            + '另外：烧东西时动作被停下，以前会报一个程序错误，现在会照实说熔炉没打开或烧了多少；钓鱼被打断时也会说是被打断了。',
    },
    {
        // owner 10-28 (DeepSeek #4066): a !collectBlocks stood still for 10 minutes before the first reminder
        id: 'no-progress-60s-2026-10-28',
        text: '（你的身体有变化：卡住时会告诉你）一个动作在跑、你却 60 秒没挪动 1 格、背包也没变化时，会提醒你一句，之后每分钟一次；动作不会被停下。'
            + '要停就 !stop，换别的直接下命令，想接着等就 !continueAction("理由")。原地等、钓鱼、烧东西、睡觉、吃、合成、射箭、举盾这些本来就不动的不提醒。做满 3 分钟的提醒现在对所有动作都是 3 分钟起。',
    },
    {
        // owner 10-28: 5 drownings on the new save - each receipt left her believing she stood on dry ground
        id: 'water-facts-2026-10-28',
        text: '（你的身体有变化：水下的事实）以前一个动作做完，回执不说你是不是还在水里：放方块时让开一步掉进深水、挖坑灌进水、走着走着进了深水，你都以为自己站在干地上。'
            + '现在每个动作做完，只要你头在水下，回执末尾会写一句"你现在头在水下：氧气几/20、大约还有几秒"；动作还在跑时，头在水下、氧气掉到一半，也会提醒你一句，动作不停。'
            + '!swimUp 现在也只在你停下后头仍在水面上才说"出水了"；水比你深、一停就沉回去时会照实说。上不上去、怎么上去，你自己定。',
    },
    {
        // owner 10-28: "她只是不知道羊毛可以做什么东西，牛奶能做什么，还是得做这两种功能" + MEETING-5
        id: 'wool-milk-respawn-2026-10-28',
        text: '（你的工具有变化）新命令 !shear(只数)：用剪刀剪附近的羊，一只给 1-3 块羊毛，羊吃草后会再长出来（杀羊只掉 1 块）。剪刀是 2 个铁锭：!craftRecipe("shears", 1)。'
            + '羊毛能做床：3 块同色羊毛 + 3 块木板，比如 !craftRecipe("white_bed", 1)；在床上睡着一次，那张床就是你的复活点。羊毛还能做地毯、旗帜。'
            + '新命令 !milk：用空桶（3 个铁锭：!craftRecipe("bucket", 1)）挤附近的牛。喝牛奶 !consume("milk_bucket") 会一下清掉你身上所有效果——吃河豚的中毒、吃腐肉的饥饿都算——桶会还给你；牛奶还能做蛋糕。'
            + '另外 !stats 现在会写：正在做的动作已经做了多久、在走路还是在挖、最后一句输出；还有你的复活点——世界出生点在哪、服务器确认过的床在哪、上次在哪醒来。'
            + '复活时也会照实告诉你是在床边还是在出生点醒的。你自己写代码时，走到某个坐标用 skills.goToPosition(bot, x, y, z, 2)，水里用 skills.swimUp(bot, 秒数)。用不用、怎么用，你自己定。',
    },
];

const file = (name) => path.join('./bots', name, 'tool_notes_seen.json');

/** A fact given once ever, at the moment it applies (not at spawn): true the first time for this id, then false. */
export function takeOnce(name, id) {
    let seen = [];
    try { seen = JSON.parse(fs.readFileSync(file(name), 'utf8')) || []; } catch { /* none yet */ }
    if (seen.includes(id)) return false;
    try { fs.mkdirSync(path.dirname(file(name)), { recursive: true }); fs.writeFileSync(file(name), JSON.stringify([...seen, id], null, 2)); }
    catch { /* if it cannot be stored she is simply told again next time */ }
    return true;
}

/** The notes she has not been shown yet; marks them as shown. */
export function takeUnseen(name) {
    let seen = [];
    try { seen = JSON.parse(fs.readFileSync(file(name), 'utf8')) || []; } catch { /* none yet */ }
    // a note marked pending (its feature not yet field-tested) is held back, so she is never told about something that is not live
    const fresh = NOTES.filter((n) => !n.pending && !seen.includes(n.id));
    if (fresh.length) {
        try { fs.mkdirSync(path.dirname(file(name)), { recursive: true }); fs.writeFileSync(file(name), JSON.stringify([...seen, ...fresh.map((n) => n.id)], null, 2)); }
        catch { /* if it cannot be stored she is simply told again next time */ }
    }
    return fresh;
}
