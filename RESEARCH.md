# GitHub 方案选择与本机实现

2026-09-30 的初始调研优先查看 GitHub 项目。用户随后要求将多个 Agent 集合到一个程序，并同时提供电脑管理界面和统一飞书机器人，路径通过选择器提供。

| 项目 | 能力 | 对本需求的限制 |
| --- | --- | --- |
| [agents-router](https://github.com/lumpinif/agents-router) | Windows Codex Desktop 完成监听；飞书 Personal Agent；桌面任务创建及实验性原会话续聊 | 不提供本需求的一体化多 Agent 管理界面，CLI 双向控制未覆盖 |
| [lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) | 飞书与本地 Codex/Claude Code CLI 双向对话、持续会话、工作目录切换与历史恢复 | 原版按 profile 分别运行机器人，不能直接接管已有 Codex 桌面聊天 |
| [AgentTerm](https://github.com/haibindev/AgentTerm) | 多终端管理，离开模式可从飞书查看和输入 CLI 终端 | 需要在其终端内运行会话；不覆盖现有 Codex 桌面聊天 |
| [coding-agent-notifier](https://github.com/Wangmerlyn/coding-agent-notifier) | 多种 Agent 飞书完成通知 | 主要提供单向通知 |
| [codex-away-mode](https://github.com/sudoHG/codex-away-mode) | Codex Desktop 完成通知与飞书卡片续聊 | 仅覆盖 Codex；项目说明 Windows 尚未真机验证 |

初版采用 `agents-router@0.12.1` 加 `lark-channel-bridge@0.7.1`，分别绑定「Agent助手」「Agent助手2」「codex助手」。用户已在 2026-10-01 确认两种 CLI 手机任务正常回复，以及桌面项目群已绑定。桌面原会话续聊没有得到同等验证。

本机部署发现 Agents Router 的 Windows named pipe 入口可能挂起并导致监听进程退出，CLI/IDE 完成 Hook 因此改用 `feishu-notify.js`。这也是新 Hub 不依赖该本地入口的原因。

2026-10-01 另确认 Codex MSIX 的 AppData 文件虚拟化导致资源管理器双击启动时找不到配置。绑定与状态现已自动迁移至 `%USERPROFILE%\.agent-phone`，PowerShell、Hub 和完成 Hook 共用同一份数据。已验证文件真实路径未重定向、原 CMD 从其他工作目录冷启动成功、缺失旧 AppData 路径时可复用服务；修复后的完整测试为 43/43。

新版保留已绑定的「Agent助手」凭据，将飞书长连接、任务引擎、已有会话目录、完成事件与本机管理界面放进同一个 Node.js Hub。Codex 接入本机 app-server；Claude Code 使用进程会话接口；飞书接入 `@larksuite/channel`。目录和文件同时提供电脑原生选择器、网页目录浏览与飞书卡片选择，避免在手机输入完整 Windows 路径。

新版启动时停止本管理脚本记录的旧版 Router 和两个 CLI Bridge。旧应用的绑定信息保留用于兼容排查，统一 Hub 日常只使用一个飞书机器人。本机已设置登录后隐藏自动启动统一服务，尚未通过重启 Windows 验证。

2026-10-01，新版 `npm test` 34/34 通过。Codex 桌面入口的 Hub 新会话、Codex CLI、Claude Code 的真实任务及同一会话 ID 的上下文续聊均成功，Claude Code 服务重启后续聊通过，飞书完成通知已投递。用户确认统一「Agent助手」的卡片选 Agent/项目、任务、完成卡片续聊及电脑目录浏览正常。电脑界面的目录分页、项目选择、附件点选/移除已验证；原生系统选择器仅脚本检查，尚未实际操控。

外部桌面会话已测试运行状态与拒绝并发，真实外部已有桌面会话续聊仍未单独实测。在原应用运行的外部任务需由原应用停止，Hub 管理的任务可从手机停止。完成通知使用持久化待发送队列重试，永久群错误转发给创建者、卡片错误降级文本；网络超时可能因至少一次投递而产生重复通知。

「任意 Agent」的通用部分是完成 Hook：提供目录、会话 ID 和任务结果即可通知。远程控制仍须按 Agent 接入会话接口；Cursor IDE 当前只有完成通知。Codex 桌面续聊依赖实验性接口和本地会话数据，不能作为所有桌面 Agent 的通用实现。
