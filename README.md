# 大肥鱼

大肥鱼是一个会自己玩 Minecraft 的 AI 角色。她以普通玩家的身份进入你的服务器，自己决定去做什么：砍树、挖矿、盖房子、打怪，也会跟你聊天。她会记住你教过她的事、去过的地方和吃过的亏，下次做决定时用得上。

## 她的记忆在哪里，重装前一定要备份

她学到的所有东西都在这个文件夹里：

```text
bots/DaFeiYu/
```

这里面有她的记忆、你教过她的事、她记下的地点、经验教训、自己写出来的技能、战斗记录和复活点。这个文件夹在程序目录里面，**删除程序文件夹、重装或升级之前，请先把整个 `bots/DaFeiYu/` 复制到别处**，装好以后再放回原处。不备份就重装，她会忘掉以前的一切。

复制前先在启动器里点“停止陪玩”，等她下线后再复制，这样不会复制到写了一半的文件。

如果你用启动器的“我的世界”建过本地世界，存档在根目录的 `worlds/`、`world-backups/`、`worlds-archive/` 里，重装前也一起备份。

## 需要准备

- Windows 10 或 11，装有 Microsoft Edge WebView2 Runtime（Windows 11 自带）。
- 一个 Minecraft Java 版 26.1.2 服务器：用你自己的，或者在启动器的“我的世界”里新建一个本地世界。本地世界不用另装 Java，发布包里带了服务器核心（Paper）和 Java 25；第一次启动世界时会联网下载一次 Minecraft 官方服务器文件（约 1–3 分钟），之后不再下载。
- 一个 DeepSeek API Key（她用 DeepSeek 思考和说话）。
- 可选：阿里云百炼的 API Key。填了以后她能语音播报、你能按住鼠标侧键跟她说话，她挑参考对话也会用上千问向量，更贴合当下；不填就只用 DeepSeek，照样能玩。

服务器需要给她管理员权限，她才能一键盖房、在被困时传送到你身边。死亡不掉落（`keep_inventory`）开不开由你决定。

## 下载

在本仓库的 Releases 页面下载压缩包，解压到任意文件夹（路径里可以有中文和空格），整个文件夹保留完整。

## 开始

1. 双击根目录的 **大肥鱼启动器.exe**。
2. 在“服务器连接”里填服务器地址、端口、她的游戏名和**你自己的游戏名（必填，她会把这个玩家当老大）**；想用本地世界就先在“我的世界”里新建一个并选中。
3. 在“思考模型”里填 DeepSeek 的 API Key；要语音的话在“语音”里填百炼的 API Key。
4. 回到“启程”页，点“启动陪玩”。

各个页面的用法见 [launcher/README.md](launcher/README.md)。整个文件夹要保留完整，不要只把 exe 单独复制出去：启动器要用到旁边的 `node22/`、`launcher/` 和 `src/`。

## 文件夹里有什么

```text
大肥鱼启动器.exe     启动器
bots/DaFeiYu/        她的记忆和技能（重装前备份）
profiles/            她的默认人设 dafeiyu.json
launcher/            启动器界面和说明
src/                 程序本体
docs/                设计说明：需求、接口、日志格式、记忆结构、语音配置
node22/              随附的 Node.js
java/                随附的 Java 25（Eclipse Temurin 精简运行时，许可见 java/legal/）
server/              本地世界用的服务器核心（Paper，GPL-3.0，源码见 https://github.com/PaperMC/Paper）
patches/             对依赖库的修补，安装依赖时自动应用
keys.json            你的密钥，只在本机，不要发给别人
```

## 来源

本项目基于 [Mindcraft](https://github.com/mindcraft-bots/mindcraft)（MIT 许可，见 LICENSE）改写。
