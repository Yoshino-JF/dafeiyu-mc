# dev/ 清理清单（2026-10-28，等主人确认后执行）

做法：确认后先把下面"建议删"的目录**移到 `D:/DeepSeek/dafeiyu-mc/.trash/2026-10-28/`**（同一块盘，秒级，随时能移回），跑一天确认没有东西缺了，再由主人确认真删。不对运行中的目录和 bots/ 动手。

## 保留
| 目录 | 为什么 |
|---|---|
| dev/logs | 她每一轮的运行日志 |
| dev/gpt-3265 | **正在运行的服务器和她的世界**（stage-server、stage-host.mjs），绝对不动 |
| dev/gpt-3823 | 这次恢复用的副本，等恢复的数据跑稳一两天再删 |
| dev/gpt-3996、gpt-4000、gpt-4006、gpt-4010 | 今天会议和去脚本化的工作目录 |
| dev/claude-backup-bots-after-rm-20261028-0755、claude-backup-descript-*、claude-backup-diaglava | 今天改动前的备份，上线跑稳后再删 |
| dev/ 根目录的工具脚本（control-new.mjs、rebuild-patch.mjs、safe-to-restart.mjs、newworld-report.mjs 等，共 108 项） | 日常要用的工具；其中 DeepSeek 自己同意删的 `_probe-*.mjs`、`_personhours.mjs` 一并移走 |

## 建议删（81 个目录，共约 26.9 GB）
GPT 历次实验场（多数带着她的记忆副本和整套程序）、我 10-27 的分步备份、2.8 GB 的内存快照（dev/gpt-3565）。

| 目录 | 大小 |
|---|---|
| dev/gpt-3914 | 3.3G |
| dev/gpt-3565 | 2.8G |
| dev/gpt-3940 | 1.7G |
| dev/gpt-3967 | 1.4G |
| dev/gpt-3925 | 1.4G |
| dev/gpt-3889 | 1.4G |
| dev/gpt-3864 | 1.4G |
| dev/gpt-3904 | 1.1G |
| dev/gpt-3705 | 1.1G |
| dev/gpt-3311 | 882M |
| dev/gpt-3937 | 856M |
| dev/gpt-3811 | 847M |
| dev/gpt-3365 | 744M |
| dev/gpt-3797 | 564M |
| dev/gpt-3790 | 563M |
| dev/gpt-3422 | 527M |
| dev/gpt-3007 | 467M |
| dev/gpt-3428 | 446M |
| dev/gpt-3351 | 377M |
| dev/gpt-3725 | 363M |
| dev/gpt-3457 | 317M |
| dev/gpt-3761 | 288M |
| dev/gpt-3778 | 283M |
| dev/gpt-3765 | 283M |
| dev/gpt-3786 | 282M |
| dev/gpt-3770 | 282M |
| dev/gpt-3849 | 278M |
| dev/gpt-3753 | 272M |
| dev/gpt-3749 | 271M |
| dev/gpt-3744 | 269M |
| dev/gpt-3699 | 269M |
| dev/gpt-3696 | 269M |
| dev/gpt-3690 | 269M |
| dev/gpt-3685 | 269M |
| dev/gpt-3681 | 269M |
| dev/gpt-3676 | 269M |
| dev/gpt-3660 | 268M |
| dev/gpt-3486 | 120M |
| dev/gpt-3492 | 84M |
| dev/gpt-3542 | 21M |
| dev/gpt-3215 | 6.7M |
| dev/gpt-3974 | 2.5M |
| dev/gpt-3955 | 2.5M |
| dev/gpt-3523 | 1.9M |
| dev/gpt-3055 | 1.9M |
| dev/gpt-3640 | 1.5M |
| dev/gpt-3027 | 705K |
| dev/gpt-2992 | 683K |
| dev/gpt-3601 | 677K |
| dev/gpt-3035 | 548K |
| dev/gpt-3950 | 454K |
| dev/gpt-3627 | 390K |
| dev/gpt-3196 | 360K |
| dev/gpt-3617 | 318K |
| dev/gpt-3555 | 214K |
| dev/gpt-3576 | 191K |
| dev/claude-backup-3737 | 92K |
| dev/claude-backup-3667 | 76K |
| dev/claude-backup-3932 | 56K |
| dev/claude-backup-3962 | 48K |
| dev/claude-backup-3923 | 48K |
| dev/claude-backup-3909 | 48K |
| dev/claude-backup-3854 | 48K |
| dev/claude-backup-3979 | 44K |
| dev/claude-backup-3900 | 44K |
| dev/gpt-3308 | 41K |
| dev/gpt-2984 | 41K |
| dev/claude-backup-3972 | 40K |
| dev/claude-backup-3840 | 40K |
| dev/claude-backup-3684 | 40K |
| dev/gpt-3439 | 36K |
| dev/gpt-2966 | 36K |
| dev/claude-backup-3954 | 32K |
| dev/claude-backup-3947 | 32K |
| dev/gpt-3580 | 13K |
| dev/gpt-3415 | 12K |
| dev/gpt-3412 | 8.0K |
| dev/gpt-3252 | 8.0K |
| dev/claude-backup-3870 | 8.0K |
| dev/gpt-3409 | 4.0K |
| dev/gpt-3365.setup-copy.txt | 4.0K |

## 其他
| 东西 | 建议 |
|---|---|
| `_debug/`（37 MB，10-25/26 的旧备份和实验） | 一起移到 .trash |
| `src/agent/memory/_fix10.mjs`、`src/agent/commands/_add-promise-cmds.mjs`（一次性改文件脚本） | 移到 .trash |
| `src/agent/memory/test-*.mjs`（28 个测试混在源码里） | 移到 `tests/memory/`，不删 |
