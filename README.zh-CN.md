# Lark channel for Claude Code（飞书/Lark 频道插件）

> 🌐 [English](./README.md) · **中文**

一个自建的 **[Channel](https://code.claude.com/docs/en/channels.md)** 插件，让你可以从 **Lark
（Larksuite 国际版，`open.larksuite.com`）** 驱动 Claude Code 并接收它的回复 —— 用法和官方的
Telegram / Discord 频道插件一样。Anthropic 官方提供了 Telegram、Discord、iMessage 频道，但没有
Lark，本插件补上这个空缺。

> **Domain 说明**：Lark 国际版 = `open.larksuite.com`（SDK `Domain.Lark`）；飞书/中国版 =
> `open.feishu.cn`（`Domain.Feishu`）。二者是相互独立的租户 —— 在一边创建的应用无法在另一边使用。
> **本插件面向 Lark 国际版。**

## 功能特性

- **双向消息** —— 私聊机器人，消息会作为 `<channel>` 事件到达 Claude Code，Claude 通过 `reply`
  工具回复回去。
- **群聊支持** —— 把机器人拉进群。在群里它**只**响应 **@机器人** 的消息（普通群聊消息一律忽略）；
  单聊则无需 @。
- **访问控制** —— 基于**发送者 open_id**（而非会话）的允许列表（allowlist），并带有配对
  （pairing）流程供新用户接入。群里还要求：发言人既在 allowlist 里、又 @了机器人才生效；未授权的人
  @机器人会被静默忽略（不会在群里刷配对码）。
- **权限中继** —— Claude 要调用工具时，可在 Lark 里回复 `yes <id>` / `no <id>` 来批准/拒绝。
- **可切换传输方式** —— Webhook（默认，始终可用）或 WebSocket 长连接（可选，无需公网 URL —— 前提是
  你的 Larksuite 后台开放了该模式）。

## 环境要求

- **Node.js ≥ 22.6**（通过 `--experimental-strip-types` 原生剥离 TypeScript，无需构建步骤）。
- 一个启用了「机器人」能力的 Lark 自建应用。

## 安装

本仓库**同时是插件本体和一个单插件 marketplace** —— 添加这个仓库即可一条命令安装。

```bash
# 1. 把本仓库添加为 marketplace，然后安装插件
claude plugin marketplace add junliu/claude-lark-channel
claude plugin install lark@claude-lark-channel

# 2. 安装 MCP 服务器的运行时依赖（必做 —— 不会自动安装）
#    安装命令会打印出插件目录；cd 进去后执行 npm install：
cd ~/.claude/plugins/<...>/claude-lark-channel   # 路径以 install 命令的输出为准
npm install
```

> ⚠️ **你必须在插件目录里执行 `npm install`。** Claude Code **不会**自动安装 npm 依赖。不装的话
> 服务器会报错 "Cannot find package '@larksuiteoapi/node-sdk'"。要求 **Node ≥ 22.6**。

### 本地 / 开发模式安装（不走 marketplace）

```bash
git clone https://github.com/junliu/claude-lark-channel
cd claude-lark-channel && npm install
claude --plugin-dir ./claude-lark-channel     # 仅本次会话加载
claude plugin validate ./claude-lark-channel  # 可选：校验插件结构
```

### ⚠️ 启动时必须开启 channel（两种安装方式都需要）

Channel 是实验性特性，且本插件**不在 Anthropic 的内置允许列表上**，所以启动 Claude Code 时必须带上一个
开发标志 —— 否则机器人能收到消息但**永远不回复**（消息被静默丢弃）：

```bash
claude --dangerously-load-development-channels plugin:lark@claude-lark-channel
```

如果是用 `--plugin-dir` 开发模式加载，标签写作 `plugin:lark@<marketplace 或目录名>`（例如本地目录加载时
可能是 `plugin:lark@inline`）。启动后，banner 下方会出现一行灰色小字
`Channels (experimental) messages from plugin:lark inject directly in this session`，看到它就说明
注册成功。建议把这条命令封装成 shell 别名/函数，免得每次重敲。

## Lark 应用配置（一次性，在开发者后台完成）

1. https://open.larksuite.com/app → **创建自建应用** → 记下 **App ID**（`cli_...`）和 **App Secret**。
2. **添加应用能力 → 机器人（Bot）** → 启用。
3. **权限 / Scopes**：
   - 私聊（最小集）：`im:message.p2p_msg:readonly` + `im:message:send_as_bot`。
   - **群聊**：再加 **`im:message.group_at_msg:readonly`** —— 它让 Lark 只推送**@了机器人**的群消息
     （正好是群聊流程需要的；不要用范围更大的 `im:message.group_msg:readonly`，那会推送每一条群消息）。
4. **事件与回调** → 订阅 `im.message.receive_v1`。
   - 群聊场景还需**把机器人拉进群**，然后 @它。
   - **Webhook（默认）：** Request URL = `https://<你的公网地址>/webhook/event`；设置 **Encrypt Key**
     和 **Verification Token**。
   - **WS（可选）：** 如果后台提供了「长连接」订阅模式，可以用它代替公网 URL（见下方注意事项）。
5. **创建版本 → 发布** → 由租户管理员审批（在自己的租户里通常可自助通过）。

## 配置插件

推荐用 slash 命令，它会写入 `<config-dir>/.env`（默认 `~/.claude/channels/lark/.env`；配置目录见下文）：

```
/lark:configure app_id cli_xxxxxxxx
/lark:configure app_secret xxxxxxxx
/lark:configure encrypt_key xxxxxxxx        # webhook 模式
/lark:configure verify_token xxxxxxxx       # webhook 模式
/lark:configure transport webhook           # 或：ws
```

或者直接写 `<config-dir>/.env`（配置目录见下文）：

```dotenv
LARK_APP_ID=cli_xxxxxxxx
LARK_APP_SECRET=xxxxxxxx
LARK_ENCRYPT_KEY=xxxxxxxx      # 仅 webhook
LARK_VERIFY_TOKEN=xxxxxxxx     # 仅 webhook
LARK_TRANSPORT=webhook         # webhook（默认）| ws
LARK_WEBHOOK_PORT=3000         # 仅 webhook
LARK_WEBHOOK_PATH=/webhook/event
```

### 配置目录 & 同机运行多个机器人

插件从**配置目录**读取 `.env` 和 `access.json`：

- **默认：** `~/.claude/channels/lark/`
- **覆盖：** 设置 `LARK_CONFIG_DIR` 环境变量。相对路径按进程的当前工作目录（CWD）解析。它必须是真正的
  环境变量 / 写在启动命令上 —— **不能**放进 `.env`（因为它正是用来定位 `.env` 的）。

由此可以做两件事：

1. **把配置放进项目仓库** —— 让 `LARK_CONFIG_DIR` 指向你仓库里的某个目录。自带的 `.gitignore` 已经
   排除了 `.env` 和 `access.json`，所以 **App Secret 和允许列表永远不会被提交**。复制
   `.env.example` → `.env` 即可开始。

2. **同一台机器上跑多个互相独立的机器人** —— 给每个 Claude Code 实例各自的 `LARK_CONFIG_DIR`（各自的
   `.env` + `access.json`）：

   ```bash
   LARK_CONFIG_DIR=/path/to/bot-a claude --plugin-dir ... --dangerously-load-development-channels plugin:lark@inline
   LARK_CONFIG_DIR=/path/to/bot-b claude --plugin-dir ... --dangerously-load-development-channels plugin:lark@inline
   ```

   > **硬性约束：** 每个机器人必须使用**不同的 Lark 应用**。同一个 Lark 应用只允许**一条**长连接（WS）——
   > 让两个实例指向同一个应用会导致它们互相抢连接、消息被丢弃。**一个配置目录 → 一个 Lark 应用 → 一个实例。**

## 运行

插件加载时 MCP 服务器会自动启动（见 `.mcp.json`）。**webhook** 模式下，需要把本地端口暴露到公网
Request URL，例如：

```bash
cloudflared tunnel --url http://localhost:3000
# 然后把 Lark 的 Request URL 设为 https://<tunnel-host>/webhook/event
```

单独运行服务器做冒烟测试：

```bash
LARK_APP_ID=cli_xxx LARK_APP_SECRET=xxx npm start
```

## 使用

1. 在 Lark 里**私聊机器人**。如果你不在允许列表上，机器人会回复一个**配对码（pairing code）**。
2. 操作者在 Claude Code 里运行 `/lark:access pair <CODE>` 批准你。
3. 再次私聊机器人 —— 你的消息现在会作为
   `<channel source="lark" chat_id="oc_..." message_id="om_...">...</channel>` 出现在 Claude Code
   里，Claude 会把回复发回 Lark。
4. 当 Claude 请求运行某个工具时，机器人会转发一条权限提示；在 Lark 里回复 `yes <id>` 或 `no <id>`
   即可批准/拒绝。

**在群聊里：** 把机器人拉进群，然后在消息里 **@机器人** —— 只有 @了机器人的消息才会到达 Claude
（普通群聊消息一律忽略）。发言人仍必须在 allowlist 里；请先通过**单聊**完成配对（群里不会显示配对码）。
到达 Claude 前，@机器人的占位符会被自动去掉。

**在飞书里开启新对话：** 发送**恰好为 `新会话`** 的消息。Claude 会忽略该会话之前的上下文，把你的下一条
消息当作全新任务。注意这是**软重置** —— channel 无法执行 `/new` 或 `/compact`，所以它并不真正缩减底层
上下文（只是让 Claude 忽略它）。要真正压缩，请在终端里运行 `/compact`。

随时管理访问权限：`/lark:access list | pair <code> | allow <open_id> | policy <allowlist|public>`。
详见 [ACCESS.md](./ACCESS.md)。

## 传输方式注意事项（WS）

WebSocket 长连接可以省掉公网 URL，但 **Larksuite 国际版开发者后台不一定给每个应用都开放「长连接」订阅
模式**（社区反馈 [openclaw #51663](https://github.com/openclaw/openclaw/issues/51663)）。如果
`LARK_TRANSPORT=ws` 连接时报错，就切回 `webhook`。本插件因此默认使用 webhook。

## 项目结构

```
claude-lark-channel/
├── .claude-plugin/plugin.json   # 插件元数据
├── .mcp.json                    # 启动 MCP 服务器（node --experimental-strip-types server.ts）
├── server.ts                    # 入口：串联 config → client → channel → gate → transport
├── src/
│   ├── config.ts                # 环境变量/路径 + 入站消息类型
│   ├── lark-client.ts           # 通过 @larksuiteoapi/node-sdk 发送 / 回复
│   ├── transport.ts             # 传输接口 + 事件 → LarkInboundMessage
│   ├── transport-webhook.ts     # 默认（Express + EventDispatcher）
│   ├── transport-ws.ts          # 可选（WSClient）
│   ├── access.ts                # 允许列表 / 配对 / 策略
│   ├── permission.ts            # yes/no <id> 解析 + permission_request schema
│   ├── channel.ts               # MCP channel：capability、reply 工具、权限中继
│   └── gate.ts                  # 去重 → 允许列表 → 权限 → 转发
└── skills/
    ├── configure/SKILL.md       # /lark:configure
    └── access/SKILL.md          # /lark:access
```

## 参考资料

- Claude Code Channels：https://code.claude.com/docs/en/channels.md ·
  参考文档 https://code.claude.com/docs/en/channels-reference.md
- 官方频道插件（Telegram/Discord）：https://github.com/anthropics/claude-plugins-official
- Lark SDK：https://github.com/larksuite/node-sdk
- Lark `im.message.receive_v1`：https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive
