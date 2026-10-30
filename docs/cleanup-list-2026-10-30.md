# 发布前清理清单（2026-10-30，等主人确认后执行）

做法和 10-28 一样：确认后先把"移走"的东西**移到 `D:/DeepSeek/dafeiyu-mc/.trash/2026-10-30/`**（同一块盘，秒级，随时能移回），保持原来的相对路径，另写一份清单 `.trash/2026-10-30/MANIFEST.txt`。跑一天确认没缺东西，再由主人确认真删。

以下不动：
- 她的世界和备份：`worlds/`、`world-backups/`、`worlds-archive/`；
- 她的记忆：`bots/DaFeiYu/`；
- `keys.json`、`launcher.settings.json`；
- 源码。

## 一、移走：dev/ 里的旧实验场和备份（45 个目录，约 4.0 GB）
- **GPT 历次实验场 `dev/gpt-*`**（30 个）。最大的几个：
  - gpt-3823：10-27 恢复用副本，1.1G。数据已经跑稳三天。
  - gpt-launcher-worlds-20261028：启动器测试留下的世界，965M。测试会自己重建这个目录。
  - gpt-4111 / 4123 / 4131 / 4143：10-29 的实验场，各约 280–620M。
  - gpt-3265：旧的 stage-server，344M。现在她的世界由启动器放在 `worlds/`，这里已经没人用。
- **备份**（都是 10-27 到 10-29 改动前的备份，改动已经跑稳）：
  - `dev/claude-backup-*`，13 个；
  - `backup-before-gpt-world-c-3705-*`；
  - `claude-snap-before-world-switch-2335`；
  - `launcher-before-20261028-gpt`；
  - `launcher-review-gpt`；
  - `patch-backup`。
- **一次性重建、诊断和旧实验室**：
  - `ds-raw-rebuild`、`ds-skills-rebuild`；
  - `oom-20261027`；
  - `claude-lab-b`：旧的 B 实验室，现在用的是 `claude-newworld-server-b`。

## 二、移走：实验室里测过的世界副本（55 个，约 1.3 GB）
- `claude-newworld-server/`：
  - `dn-world-1` ~ `dn-world-35`；
  - `dn-world-24-stuck-copy`、`dn-world-30-stuck-copy`、`dn-world-30-gpt`；
  - `lab-world-1` ~ `lab-world-7`。
- `claude-newworld-server-b/`：
  - `dn-world-24-stuck-copy`；
  - `dn-world-30-claude`、`dn-world-30-steps`、`dn-world-30-steps2`、`dn-world-30-steps3`、`dn-world-30-stuck-copy`；
  - `lab-b-world-1~3`。
- `claude-house-test-server/house-test-r30`：今天的回归副本。
- 第 30 轮已查清修好。三个实验服本身（server.jar、配置）保留；level-name 改回一个新名字，下次启动自动生成新世界。

## 三、移走：实验室里她记忆的旧副本（42 个，约 289 MB）
- `dev/claude-lab/bots/DaFeiYu-run-*-before`：每轮实验开始前挪开的记忆副本。
- 保留 `DaFeiYu-snapshot-1030`、`DaFeiYu-snapshot-1850`、`DaFeiYu-snapshot-r30end`，以后做实验还要用。

## 四、保留（不动）
| 东西 | 为什么 |
|---|---|
| **`dev/server/`** | **启动器现在用的就是这里的 `server.jar`**（`launcher/worlds.mjs:73` 的第三个候选，本机没有 engine.json），绝对不能动 |
| dev/ 根目录 114 个工具脚本、`HANDOFF.md` / `READY.md` / `TEMPLATES.md` | 日常工具；其中有些被 `src/agent/memory/test-*.mjs` 引用 |
| `dev/logs`、`dev/claude-lab/logs` | 运行日志，很小 |
| 三个实验服的程序本体、`dev/mineskin`、`dev/java-tmp` | 以后测试要用 |

## 五、顺手修：.gitignore
`worlds/`、`world-backups/`、`worlds-archive/`、`.trash/` 现在没有被忽略：`git status` 里有 1300+ 个她世界的文件。补上这 4 行，免得以后提交时把世界带进去。只改 .gitignore，不动文件。

## 六、发布要注意（不在这次清理里）
`release-exclude.txt` 排除了整个 `dev/`，而启动器找服务器核心正好落在 `dev/server/server.jar`，所以发布包里**没有服务器核心**。启动器 README 写了"新包若未附带服务器核心，请自行选择"。要不要在发布包里带一个 `server/`（server.jar + libraries/versions/cache），到打包那一步再定。

## 执行记录（2026-10-30）
- **移动**：142 项移到 `.trash/2026-10-30/`，相对路径不变，清单在 `.trash/2026-10-30/MANIFEST.txt`。没有失败，也没有遗漏。dev/ 从 7.0 GB 降到 1.6 GB，.trash 里共 5.5 GB。
- **补救一项**：启动器 UI 测试要用的 playwright 原来在 `dev/gpt-4108/test-deps` 里。已单独移回到 `dev/launcher-test-deps/`，用法：`LAUNCHER_TEST_NODE_MODULES=dev/launcher-test-deps/node_modules`。gpt-4108 的其余部分还在 .trash。
- **实验服 level-name**：claude-newworld-server 改为 `lab-world-new`，-b 改为 `lab-b-world-new`；house-test-server 还原为原来的 `livecopy-1029`。
- **.gitignore**：加了 `/worlds/` `/world-backups/` `/worlds-archive/` `/.trash/`。
- **验证**：
  - 启动器能找到 `dev/server/server.jar`（available: true）；
  - `launcher/worlds.test.mjs` 9/9；
  - `launcher/launcher-ui.test.mjs` 33 项检查，没有错误；
  - 源码测试 213 项，211 项在临时目录通过；剩下 2 项只读她的真实日志和记忆，从项目根目录跑 35/35 通过。
