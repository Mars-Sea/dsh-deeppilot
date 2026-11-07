# DeepPilot 0.9.18

## 中文

- **本机网页直接在 App 内打开**：会话里出现的 `http://127.0.0.1:<端口>`、`localhost:<端口>` 链接（例如 Agent 启动的设计画布、开发服务器）可在 App 内直接查看，页面实时刷新照常。
- **预览只认会话里出现过的本机地址**：端口必须先在该会话的消息里出现过；插件自身端口和 DSH Web 默认端口 `3080` 始终拒绝，且只接受带显式端口的 `http` 回环链接。
- **设置页新增「本机网页预览」开关**：默认开启，关闭后对所有已配对手机生效，正在打开的通道立即断开。
- **认证超时不再要求重新配对**：认证没在时限内完成（链路慢、App 被挂起）时按普通断线重连，不再提示重新配对。
- **预览失败显示原因**：端口没在会话里提到、电脑端关闭了预览、该端口没有服务在监听等情况，App 会给出对应的中文提示。
- **兼容**：协议仍为 v2，新增内容均为可选，旧版 App 不会建立预览连接、行为不变；本机网页预览需搭配新版 App 才能使用。

## English

- **Open local web pages inside the app**: `http://127.0.0.1:<port>` or `localhost:<port>` links that appear in the conversation (a design canvas or dev server the agent started) can be viewed directly in the app, with live reload intact.
- **Preview only accepts loopback ports mentioned in the session**: a port must have appeared in that session's messages; the plugin's own ports and the DSH Web default port `3080` are always refused, and only `http` loopback links with an explicit port qualify.
- **New Local web preview switch in settings**: on by default, applies to every paired phone when turned off, and open streams close at once.
- **Auth timeouts no longer ask to re-pair**: when authentication does not finish in time (slow link, app suspended), the connection reconnects like an ordinary drop instead of prompting to pair again.
- **Preview failures explain themselves**: a port that was never mentioned, preview turned off on the computer, or nothing listening on that port each get their own message.
- **Compatibility**: still protocol v2 with every addition optional; older apps never open a preview connection and behave as before. Local web preview needs the new app.
