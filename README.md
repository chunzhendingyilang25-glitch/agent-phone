# Agent Phone：电脑上的 Agent 与手机飞书共用一个工作台

Windows 桌面程序，统一管理本机 Agent、项目和会话。电脑留在宿舍运行，人可以在手机飞书发起任务、继续会话、回答问题、批准或拒绝操作。任务完成、失败或需要操作时发送卡片；暂时断网时通知保存到本地，联网后重试。

**下载 Windows x64：** [安装包](https://github.com/chunzhendingyilang25-glitch/agent-phone/releases/download/v0.3.0/Agent-Phone-Setup-0.3.0-x64.exe) · [便携 ZIP](https://github.com/chunzhendingyilang25-glitch/agent-phone/releases/download/v0.3.0/Agent-Phone-0.3.0-x64.zip) · [发行说明与校验值](https://github.com/chunzhendingyilang25-glitch/agent-phone/releases/tag/v0.3.0)

## 普通用户开始使用

1. 安装 `Agent-Phone-Setup-0.3.0-x64.exe`，或解压便携 ZIP 后运行 `Agent Phone.exe`。程序自带运行环境，无需安装 Node.js、npm 或 PowerShell 7。
2. 打开「设置 → 飞书连接」，按引导用手机飞书绑定自己的机器人；也可以填写已有机器人的凭据。
3. 点击「添加项目」选择文件夹。文件附件通过选择器提供，电脑和手机都无需手写路径。
4. 选择 Codex、Claude Code，或点击「添加 Agent」选择本机 DSH/其他程序，再发送任务。
5. 在自己的飞书机器人里发送 `菜单`，选择 Agent、项目和会话。收到卡片后直接选择操作或继续会话。

已有本项目绑定会自动迁移并复用，无需重新绑定。安装包不包含开发者的飞书凭据、聊天、项目或用户数据。Agent 本身仍需在用户电脑上安装并完成账号登录。

发行包保留第三方依赖的许可证与版权声明。Claude Agent SDK 和原版 Claude Code 可执行文件按 [Anthropic 官方条款](https://code.claude.com/docs/en/legal-and-compliance) 使用；每个使用者通过官方流程认证，并直接承担自己的模型使用费用。

## 添加 Agent 与接入范围

| 接入方式 | 能做什么 | 所需条件 |
| --- | --- | --- |
| Codex 桌面 / CLI | 新任务、历史会话、完成通知、权限审批与问题回复 | 本机 Codex；已有桌面会话续聊仍为实验性接入 |
| Claude Code | 持续对话、完成/失败通知、权限审批、工具提问 | 已配置 Claude 账号/服务；通过官方 Agent SDK 运行 |
| DSH Desktop | 持续对话，监听原应用任务，完成、审批和问题卡片 | DSH 运行，并开启仅本机浏览器访问 |
| 可交互的命令行 Agent | 启动程序、终端输入、保持进程、通知 | 选择可执行程序和参数；配置明确的完成/等待标记 |
| 结构化协议 Agent | 输出、输入、完成、审批与提问 | 程序按一行一个 JSON 的适配协议收发事件 |
| 通知 Hook | 原应用的完成/失败/等待通知，可选阻塞审批或输入回执 | Agent 能调用命令并消费结果；详见后文 |

「添加 Agent」会扫描已知程序，也能通过程序选择器手动添加。任意 GUI 应用的双向控制需要它提供会话接口或适配器；仅添加名称不能获得远程控制能力。Cursor 可安装完成 Hook，并可选手机 Shell 审批。

## 手机操作

- `菜单` 或 `/status`：打开统一菜单，选择 Agent、项目、历史会话或目录/文件。
- `/new`：清空当前会话选择，准备新任务。
- `/resume`：选择已有会话。
- `/stop`：停止当前可控制任务；未接入控制接口的原应用任务需在原应用停止。
- 完成卡片的「继续这个会话」：将后续消息发送到原会话。
- 操作卡片：选择准确的审批选项，或按提示输入答案。过期卡片不能操作其他请求。

工作台和飞书共用同一份状态。手机命令仅接受绑定机器人所有者，接口只监听本机回环地址；飞书使用出站连接，不需要公网 IP。

## 在宿舍持续运行

关闭窗口后程序留在托盘运行；托盘和设置中可开启登录 Windows 后启动、保持运行时不自动休眠。允许屏幕熄灭。电脑需要保持开机联网，程序无法阻止手动关机、手动休眠或笔记本合盖策略。

任务通知先保存到本地队列，投递失败会重试，失效群目标会尝试转发给机器人所有者。网络超时可能产生重复通知。已回答、取消或过期的操作请求不会在恢复连接时重新发送为待操作请求。

程序数据和日志位于 `%USERPROFILE%\.agent-phone`。凭据和接口 token 请勿分享。旧 AppData/Codex 隔离目录自动迁移一次，后续以该用户目录为准。修复了原先双击 CMD 找不到已绑定飞书配置的问题。

## 验证与限制

2026-10-03：`npm test` 100/100 通过，覆盖真实本地 HTTP 请求流程、审批与回复对应关系、断线队列、原生终端中文输入和进程退出、DSH SSE/WebSocket 事件、Hook 原生回执以及旧数据迁移。

实际验证：原统一飞书菜单的新建任务、续聊和目录选择已由用户确认；Claude 的工具提问已从飞书回答并完成；DSH 新任务、原会话续聊、提问与官方接口答复通过。DSH 在统一程序中已收到飞书选项答复并完成，完成通知已投递。安装包使用源码目录之外的隔离用户环境检查首次启动和内置运行依赖；实际 Electron EXE 启动也通过。

已有 Codex 桌面会话续聊依赖本机历史与 app-server，仍属实验性；原桌面正在运行时应等待结束。任意 Agent 的每个任务要被观察，必须接入相应适配器或 Hook。自动启动尚未通过实际 Windows 重启验证，原生系统选择器未通过人工点击验证。

## 源码运行与排查

源码模式需要 Node.js 24+ 和 npm，运行 `npm install`、`npm start`，或双击 `启动.cmd`。该 CMD 使用现代 PowerShell；安装版直接运行 EXE，不依赖该脚本。旧辅助命令保留用于迁移和排查：

```powershell
.\agent-phone.ps1 open
.\agent-phone.ps1 status
.\agent-phone.ps1 doctor
.\agent-phone.ps1 stop
```

旧独立 Router 与统一程序不要同时使用同一机器人。日常只用一个统一入口。方案来源与取舍见 [RESEARCH.md](RESEARCH.md)。

## Windows 安装包与构建

### 在原 Agent 中运行的任务：完成通知与手机审批

工作台启动的 Codex、Claude Code 和 DSH 任务使用各自的实时接口发送完成、批准和提问卡片。要接收从原 Agent 界面启动的任务，可在工作台设置中明确选择「安装通知 Hook」。安装前备份已有文件，保留其他 Hook；读取安装状态不会修改配置。Codex 安装后仍需本人在 `/hooks` 核对并信任新增命令，程序不会替你写入信任记录。

| 原 Agent | 安装的事件 | 手机操作 |
| --- | --- | --- |
| Codex | `Stop`、`PermissionRequest` | 完成通知；批准或拒绝当前权限请求 |
| Claude Code | `Stop`、`StopFailure`、`Notification`、`PermissionRequest` | 完成/失败通知、等待提示和当前权限审批 |
| Cursor | `stop` | 完成通知；可额外启用逐条 Shell 命令手机审批 |

权限 Hook 会等待当前请求对应的飞书或电脑答复。只有点击「批准本次操作」才会批准；手写一条含“allow”的消息不会授予权限。等待超过 9 分钟、请求取消或工作台连接中断，均返回 Agent 原生的拒绝结果。Cursor 的可选 Shell 审批同时启用 `failClosed`，防止 Hook 自身崩溃/超时后执行命令。权限决定仅作用于本次操作，不修改持久权限规则。Notification 是提示事件，它的输出不能直接回答原应用的问题；这类问题的双向回答需要该 Agent 的实时接口或下面的 `input` 协议。[Codex Hook 文档](https://learn.chatgpt.com/docs/hooks)、[Claude Code Hook 文档](https://code.claude.com/docs/en/hooks)、[Cursor Hook 文档](https://prod.cursor.com/docs/hooks)。

安装包生成的命令使用内置 Node 与通知脚本，收件人的数据不写入命令。未运行工作台时，非阻塞完成/等待通知可使用本机绑定信息直接投递；权限与输入请求必须通过运行中的工作台处理。

自定义 Agent 如果支持调用命令并读取其 JSON 输出，可将一个事件 JSON 传入以下命令的标准输入。路径由安装器生成，程序升级/移动后应重新安装 Hook：

```text
"内置 node.exe 的完整路径" "feishu-notify.js 的完整路径" 自定义AgentID completion
"内置 node.exe 的完整路径" "feishu-notify.js 的完整路径" 自定义AgentID attention
"内置 node.exe 的完整路径" "feishu-notify.js 的完整路径" 自定义AgentID permission
"内置 node.exe 的完整路径" "feishu-notify.js 的完整路径" 自定义AgentID input
```

`completion`/`attention` 返回 `{}`；`permission` 返回 `{"decision":{"behavior":"allow"}}` 或 `{"decision":{"behavior":"deny","message":"原因"}}`；`input` 返回 `{"response":{"optionId":"选项ID","text":"用户回复","source":"feishu或desktop"}}`，取消或断开时返回 `response.cancelled:true`。自定义 Agent 必须消费返回值并实际暂停/继续自己的任务。以下是 `input` 事件示例；`permission` 自动使用批准和拒绝两个选项：

```json
{"cwd":"项目目录","session_id":"会话ID","request_id":"每次请求唯一ID","message":"接下来做什么？","options":[{"id":"test","label":"运行测试"},{"id":"edit","label":"修改代码"}]}
```

也可直接接入本机 HTTP 协议：从用户数据目录的 `hub-runtime.json` 读取 URL/token，用 `x-agent-phone-token` 请求头向 `POST /api/hooks` 投递 `event:"attention"`；响应包含 `requestId`，通过 `GET /api/requests/:id` 等待 `status:"answered"` 和 `response`。`POST /api/requests/:id/cancel` 取消尚未完成的请求。该接口只监听本机，不应把本机 token 发到手机或公网。新增 Hook 提供事件通道；任意 GUI 程序仍需要可用的控制接口才能远程续聊。

### DSH Desktop 接入

添加 Agent 时选择 **DSH Desktop**，本机默认地址为 `http://127.0.0.1:43120`。DSH 必须保持运行。DSH Desktop 2.0.3 默认禁止普通浏览器访问；出现 HTTP 403 时，在 DSH 的设置中进入「设置浏览器访问」，启用「允许在浏览器中打开」。浏览器访问要求「兼容模式」；若应用提示切换，选择「切换并开启」，并将访问范围保留为「仅本机」（`loopback`），应用会重启该 Profile。无需开启局域网访问或开放端口。修改过 DSH 端口时，添加 Agent 页面填写对应本机地址。

适配使用 DSH 自带的 HTTP RPC 和 SSE/WebSocket 事件接口，接收明确的任务完成、执行批准和用户问题事件；飞书回复会提交给原 DSH 会话。程序不会使用 DSH 桌面渲染器的私有令牌绕过浏览器访问设置。2026-10-03 用户开启仅本机浏览器访问后，真实模型新任务、原会话续聊、提问答复和原应用事件监听已通过验证。

`dist/Agent-Phone-Setup-0.3.0-x64.exe` 是 Windows x64 安装包；`dist/Agent-Phone-0.3.0-x64.zip` 是便携包，解压后运行 `Agent Phone.exe`。普通用户不需要另外安装 Node.js、npm 或 PowerShell 7。包内包含 Electron、独立 Node.js 24 运行环境和 Hub 的生产依赖；每个使用者首次运行时绑定自己的飞书机器人，并选择自己的 Agent 程序和项目。

关闭窗口会进入托盘并继续接收手机指令。右键托盘可重新打开工作台、设置登录 Windows 后启动、打开日志目录或退出。默认防止程序运行期间电脑因空闲而自动休眠；可在托盘关闭此设置。该设置允许屏幕熄灭，不能阻止手动关机、手动休眠、断网或笔记本合盖策略。

程序数据保存在当前 Windows 用户的 `%USERPROFILE%\.agent-phone`，不会包含在安装包中。安装包未进行代码签名。自动启动记录指向当前程序位置，移动便携包后需要重新设置。

开发和重新构建需要 Windows x64、Node.js 24 和 npm：

```powershell
npm install
npm run desktop:prepare
npm run desktop:dev
npm run desktop:build
npm run desktop:verify
npm run desktop:smoke
```

构建脚本从 Node.js 官方发行目录下载 Node.js 24.16.0 Windows 运行环境，核对官方 SHA256 校验表；Electron ZIP 使用官方 npm 包中的 SHA256 校验并缓存。Hub 源码和生产依赖使用干净暂存目录，再生成安装包和 ZIP。Electron 中不加载 `node-pty`；终端适配在内置 Node 进程中运行，保持原生模块 ABI 一致。`desktop:verify` 检查内置运行文件、生产模块加载、用户数据路径，以及安装包/ZIP 内 Hub、通知脚本与桌面入口和最新源码是否一致；`desktop:smoke` 使用隔离的新用户目录验证首次启动、无预绑凭据、输入请求回执和干净退出。公开下载需要将这些产物发布到用户可访问的发行渠道。
