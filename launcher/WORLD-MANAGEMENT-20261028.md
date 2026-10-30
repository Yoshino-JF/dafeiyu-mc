# 启动器美化与本地世界管理 · 2026-10-28

本轮按主人要求在 `D:/DeepSeek/dafeiyu-mc` 的 Claude 已完成版上继续。默认壁纸、原有配置和 C# WebView2 独立窗口沿用；重做侧栏、首页、设置页、日志页，加入独立“我的世界”页面及弹窗。没有修改游戏行为源、模型调用、语音或线上开发服。

## 交付

- `launcher/index.html` / `style.css`：统一深蓝侧栏、壁纸首页、半透明状态卡、世界卡片与设置布局；适配 1200×760、960×640。
- `launcher/app.js` / `worlds-ui.js`：保留原设置、语音、密钥遮罩和人设入口；接入新建、导入、选择、搜索、设置、备份恢复、归档取回。重启时先停止再保存配置，避免运行中保存失败。
- `launcher/worlds.mjs`：每个世界独立目录和端口；精确保存长种子；运行中锁档；恢复前自动快照；仅通过自有 Java 子进程的 stdin 正常保存/停止。
- `launcher/server.mjs`：本地世界先就绪再启动陪玩；关闭启动器先下线陪玩再保存本次自启世界；外部服务器不接管。`--data-dir` 支持隔离验证，隔离模式拒绝启动陪玩。
- `launcher/README.md`：用户流程、目录、核心配置与验证方法。

目录：`worlds/`、`world-backups/`、`worlds-archive/` 位于项目根目录，核心/Java/内存在 `worlds/engine.json`。现有外部地址在选择本地世界时另存，切回时恢复。导入复制源文件，跳过 session.lock，不移动原档；源需正常关服。服务器仅本机监听，离线模式，配置中的 NPC 和主人名字获 OP 以支持已有能力。

## 验证证据

1. `node22/node.exe --test launcher/worlds.test.mjs`：最终 9/9，exit 0（549.8774ms）。覆盖长种子、路径/注入拒绝、导入不改源、备份恢复/恢复前快照、归档取回、监听端口锁、已有世界禁止改种子、拆分日志识别、自有进程停止、准备阶段取消禁止迟到启动。
2. 最后一次浏览器端到端：`dev/gpt-launcher-worlds-20261028/e2e-eHxNBS/result.json`：33 项通过，0 JS 错误，服务正常退出。真实 Paper 26.1.2 超平坦服务器在独立目录生成 level.dat、Done 就绪、保存退出码 0、备份恢复后再次启动成功，再次正常停服；真实存档复制导入。未起 NPC、未调用模型/语音 API。
3. 原始 EXE 的独立副本自检：`dev/gpt-launcher-worlds-20261028/native-smoke/runtime/launcher/native-ui-smoke.json`：ready=true、grid、width=contentWidth=1027、voiceFields=12、keyMasked=true、resetDefault=true。自检 EXE PID33548 已自然退出。原 C#/EXE 无需重建，加载新的页面和服务文件。
4. `git diff --check -- launcher` 无错误，只有现有 Git 自动换行提示。当前工作区原有 staged/unstaged 内容全部保留，未提交。
5. 收尾核 25688 / 25694 / 25695 无监听。所有本轮自启服务和 Java 正常结束，没有强杀。原开发服、世界、配置及密钥未更改。

## 失败与修正保留

- `e2e-Doxsse` 首次真实 Java 启动失败：Windows Java 25 的 AF_UNIX/Pipe 回环创建失败；保留 latest.log 和 crash report。复用既有开发服办法，为本地服务器显式配置项目内的短实际临时路径及 `java.io.tmpdir` / `jdk.net.unixdomain.tmpdir`。后续实际生成与重启通过。退出码 0 但未 Done 不再显示成“已成功关闭”。
- 准备阶段取消首个夹具 8/9：stop 后仍有 late spawn；增加操作代际检查和完整复制后才安装核心缓存。最终 9/9。
- 世界表单校验失败原先污染首页“启动失败”；改为世界表单显示，不改陪玩启动状态；最终端到端包含该断言。

## 边界与打包交接

- 是本机 Java 服务器世界管理。远程服务器的建档/切档仍由其管理员负责。
- 只验证了本机提供的 Paper 26.1.2 和现有 Java 25；其他核心、模组世界需要用户选择兼容核心。导入不是原服务器插件/配置迁移。
- 本轮没有运行完整 NPC 行为回归，不能据此声明 Claude 的游戏行为任务已完成。
- 当前自动检测可复用 `dev/server/server.jar`。**纯净包排除 dev 时，请另外保留/提供 `server/server.jar`（及核心需要的运行依赖），或明确让用户在服务器设置里选择核心；不要把 dev 整目录带入包。** 不要只复制 EXE，整个 launcher 目录都需要保留。
- 修改前备份：`dev/launcher-before-20261028-gpt`。所有测试数据均在 `dev/gpt-launcher-worlds-20261028`，不放入正式包。

主人使用时，重新打开根目录“大肥鱼启动器.exe”，进入“我的世界”即可。存档首次启动需要用户确认 Minecraft EULA。
