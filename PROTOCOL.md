# DeepPilot Bridge Protocol — v2

状态：v2 唯一支持基线。所有帧均为 WebSocket **文本帧**，UTF-8 编码的 JSON。
v2 不接受 v1 Bearer Token、`c2s.hello.auth` 或任何降级握手；升级后设备必须重新配对。

## 1. 信封（Envelope）

```json
{
  "v": 2,
  "type": "c2s.session.open",
  "id": "b3c1d9e0-…",
  "ts": 1756000000000,
  "payload": { }
}
```

- `v` 必须等于 2；不匹配时服务端回一帧 `s2c.error(E_UNSUPPORTED)` 后以 4500 关闭。
- 命名：客户端请求 `c2s.*`，服务端响应与推送 `s2c.*`。
- 未知 type：服务端回 `E_PROTOCOL` 错误帧，不断连。

## 2. 连接与鉴权

### 2.1 一次性配对

设置页在用户主动操作后生成 24 字节随机配对码，base64url 编码、5 分钟过期、成功使用
一次后立即失效。二维码格式：

```json
{
  "v": 2,
  "type": "deeppilot-pairing",
  "host": "https://example.funnel.ts.net",
  "code": "<single-use base64url code>",
  "expiresAt": 1756000300000,
  "audience": "deeppilot:<stable host id>"
}
```

App 为该主机生成 P-256 Signing 私钥；真机优先使用 Secure Enclave，私钥不得离开设备。
App 向 `POST /phone/pair` 发送：

```json
{
  "v": 2,
  "code": "<single-use code>",
  "publicKey": "<65-byte uncompressed X9.63 P-256 key, base64url>",
  "deviceName": "iPhone 15 Pro",
  "appVersion": "0.1.0",
  "scopes": ["sessions.read", "prompt.send", "sessions.manage", "interactions.respond", "notifications.register"]
}
```

成功返回 HTTP 201：

```json
{
  "ok": true,
  "v": 2,
  "deviceId": "<base64url SHA-256 of raw public key>",
  "audience": "deeppilot:<stable host id>",
  "scopes": ["sessions.read", "prompt.send", "sessions.manage", "interactions.respond", "notifications.register"]
}
```

App 扫码时必须确认响应 `audience` 与二维码一致。配对码无效、过期或已使用返回 401；
频率限制返回 429；设备注册表满返回 409。`GET /phone/health` 只返回最小公开状态，
不承担鉴权。

### 2.2 WebSocket 挑战签名

1. 客户端连接 `wss://host/phone`，HTTP Upgrade 不携带凭据。
2. 服务端立即发送 `s2c.auth.challenge`：

```json
{ "v": 2, "type": "s2c.auth.challenge", "payload": {
  "nonce": "<24-byte base64url random>",
  "audience": "deeppilot:<stable host id>",
  "issuedAt": 1756000000000,
  "expiresAt": 1756000030000
} }
```

3. 客户端确认 `audience` 与配对记录一致，并在 30 秒内发送 `c2s.auth.prove`：

```json
{ "v": 2, "type": "c2s.auth.prove", "payload": {
  "nonce": "<challenge nonce>",
  "audience": "deeppilot:<stable host id>",
  "issuedAt": 1756000000000,
  "expiresAt": 1756000030000,
  "deviceId": "<registered device id>",
  "deviceName": "iPhone 15 Pro",
  "appVersion": "0.1.0",
  "resumeCursor": 1042,
  "clientRole": "widget",
  "signature": "<ASN.1 DER ECDSA P-256/SHA-256 signature, base64url>"
} }
```

- `clientRole` 可选，缺省为普通客户端。`"widget"` 声明这是一个短生命周期的
  只读概览客户端（如 iOS 主屏幕小组件）：完成认证后只允许发送
  `c2s.ping`、`c2s.sessions.list`、`c2s.pending.list` 与
  `c2s.widget.push.register`，其余请求一律回 `E_FORBIDDEN`；该连接不注册为
  广播 sink、不参与 seq 重放（`resumeCursor` 被忽略）、不更新设备
  lastSeen，也**不**抑制离线 APNs 告警推送（小组件连接不算"设备在线"）。
  签名输入不含 `clientRole`，v2 签名规范不变。

签名输入必须是下列 UTF-8 字节。文本字段先做无 padding 的 base64url；时间戳和游标
必须是十进制有限整数，缺失游标写 `-`：

```text
deeppilot-auth-v2
device-id:<base64url(deviceId UTF-8)>
nonce:<nonce>
audience:<base64url(audience UTF-8)>
issued-at:<issuedAt>
expires-at:<expiresAt>
device-name:<base64url(deviceName UTF-8)>
app-version:<base64url(appVersion UTF-8)>
resume-cursor:<resumeCursor or ->
```

4. 服务端仅接受注册、未撤销且签名有效的设备。失败以 **4401** 关闭；超时以
   **4402** 关闭；版本不匹配以 **4500** 关闭。welcome 前客户端只允许发送 proof 与 ping。
5. scope 在每次认证时载入内存；scope 变更或撤销会立即断开该设备，重连后重新判定。

scope 与操作映射：

| scope | 允许的操作 |
|---|---|
| `sessions.read` | 会话/工作区/目录读取、会话打开与历史、模型目录读取 |
| `prompt.send` | `c2s.session.sendPrompt` |
| `sessions.manage` | 创建/重命名/归档/取消会话，创建工作区，切换模型 |
| `interactions.respond` | pending 快照、回答 approval 与 question |
| `notifications.register` | 注册 APNs token 与通知偏好 |

缺少所需 scope 时服务端回 `E_FORBIDDEN`，连接保持打开。当前产品默认配对授予
全部 scope，普通设置页不提供逐项权限控制，只提供全局连接开关和逐设备删除。
`c2s.ping` 与 `c2s.resume` 是已认证连接的控制帧，不额外要求业务 scope。

#### 下行（S→C）广播权限

scope 同样约束服务端**推送**给已认证连接的内容。桥在每次广播与重放时按帧类型
执行下行权限判定；未满足 scope 的帧不下发，但计入 seq 游标并加入重放环，使
权限收紧不影响其他设备的投递。

| 下行帧类型 | 需要的 scope |
|---|---|
| `s2c.session.event`、`s2c.sessions.delta`、`s2c.session.tail`、`s2c.history.page` | `sessions.read` |
| `s2c.pending.approval`、`s2c.pending.question`、`s2c.pending.cleared` | `interactions.respond` |
| `s2c.notify`（`category` 为 `approval.required` / `question.asked`） | `interactions.respond` |
| `s2c.notify`（`category` 为 `turn.completed` / `session.error`） | `sessions.read`（正文可能包含助手输出） |
| welcome / ack / error / challenge 及对已通过 scope 检查的 c2s 请求的点对点响应 | 无 |

未知广播类型默认不下发。重放按每帧权限过滤，不要求设备拥有 sessions.read；
有效 cursor 的重放以 s2c.resume.done 结束，过期 cursor 下发 s2c.resync。
这些控制帧不携带业务内容。仅 interactions.respond 的设备可通过 pending 快照恢复。
APNs 必须同时具备 notifications.register 和对应通知类别的内容权限；
单独的注册权限不授予通知正文读取权限。点对点响应由对应请求权限保护。

### s2c.welcome

```json
{ "type": "s2c.welcome", "payload": {
  "protocolVersion": 2,
  "serverVersion": "0.1.0",
  "deviceId": "<authenticated device id>",
  "scopes": ["sessions.read", "prompt.send"],
  "capabilities": { "historyPaging": true, "replay": true, "approvals": true, "questions": true, "pendingSnapshot": true, "notifyAllCategories": true, "models": true, "sessionManagement": true, "projectSelection": true, "push": true, "widgetPush": true },
  "cursor": 1042,
  "resumed": true
} }
```

## 3. 会话列表

### c2s.sessions.list → s2c.sessions.snapshot

```json
{ "type": "s2c.sessions.snapshot", "payload": { "full": true, "sessions": [SessionSummary] } }
```

SessionSummary：

```json
{
  "id": "session-…",
  "title": "修复登录 bug",
  "status": "running",
  "lastActivityTs": 1756000000000,
  "todos": { "done": 3, "total": 7 },
  "todoItems": [
    { "content": "定位登录跳转问题", "status": "completed" },
    { "content": "修复重定向逻辑", "status": "in_progress" },
    { "content": "补充回归测试", "status": "pending" }
  ],
  "pendingApproval": false,
  "pendingQuestion": true,
  "stats": {
    "turns": 12, "steps": 34, "llmMs": 680000, "toolMs": 210000,
    "ttftMs": 15980, "ttftSteps": 34, "decodeMs": 262000, "decodeTokens": 29700,
    "inputTokens": 169000, "outputTokens": 29700,
    "cacheReadTokens": 1131000, "cacheWriteTokens": 0
  },
  "workspaceLabel": "deeppilot-demo",
  "workspaceId": "workspace-…",
  "workspacePath": "/Users/sea/Development/deeppilot-demo"
}
```

`status` 取值：running | idle | error | unknown；当前 v2 Bridge 的会话镜像稳定产生
running/idle，error/unknown 为 Host 状态扩展保留；`todos` 无则为 null。
`todoItems` 为完整清单条目（`content` 非空字符串；`status` 取值 pending | in_progress |
completed），供会话详情页渲染任务进度；无任务时为 null 或缺省。该字段为可选字段，
客户端必须容忍缺失。

`stats` 为会话累计用量统计，由 Bridge 镜像 Host 的 `sessionStats` 与 `tokenUsage`
两个 projection 合并而来（分别来自 dsh-session-stats / dsh-token-meter）。所有字段为
非负整数（0 表示尚未记录），随 `s2c.sessions.delta` 实时更新。客户端展示派生值：
首 token 平均 = `ttftMs / ttftSteps`；输出速度 = `decodeTokens / decodeMs × 1000`
（tok/s）；缓存命中率 = `cacheReadTokens / (inputTokens + cacheReadTokens +
cacheWriteTokens)`；输入总量 = `inputTokens + cacheReadTokens + cacheWriteTokens`。
该字段为可选字段：未安装统计 projection 的旧版 Host 或尚未产生任何统计的会话
会缺省或为 null，客户端必须容忍并回退。

列表变更推送（握手后自动开始，无需订阅）：

```json
{ "type": "s2c.sessions.delta", "payload": { "upserted": [SessionSummary], "removedIds": [] } }
```

会话与项目均按 `lastActivityTs` 从新到旧展示；项目使用项目内最新会话时间排序。归档后 Bridge 必须把该会话放入 `removedIds`，不得继续出现在普通列表。

## 4. 会话明细

### c2s.session.open（payload: sessionId, tailCount? 默认 100）

服务端先回一次性 `s2c.session.tail`，随后该会话实时事件以 `s2c.session.event` 推送。历史快照请求尚未完成时产生的实时事件必须暂存，并在 tail 之后按原顺序发送，客户端不得先看到 event 再被较旧的 tail 回滚。多设备各自 open 各自收，互不影响。

### c2s.session.close（payload: sessionId）

客户端离开会话详情时发送；服务端取消该连接对该会话的实时订阅与“正在查看”标记，
不关闭 WebSocket，也不终止会话 turn。该帧为幂等通知，不产生响应。

### s2c.session.tail 与 c2s.session.history

```json
{ "type": "s2c.session.tail", "payload": { "sessionId": "…", "messages": [Message], "oldestSeq": 12, "hasMore": true } }
{ "type": "c2s.session.history", "id": "history-1", "payload": { "sessionId": "…", "beforeSeq": 12, "limit": 100 } }
{ "type": "s2c.history.page", "id": "history-1", "payload": { "sessionId": "…", "messages": [Message], "hasMore": false } }
```

`c2s.session.history` 必须携带 `id`；对应的 `s2c.history.page` 回显同一 `id`，使客户端能够在页面真正应用后结束加载状态并恢复可见消息锚点。同一会话在前一个 history 请求完成前不得并发请求下一页。

`Message.seq` 是会话内唯一且稳定的消息行身份。同一个 tail/page 内不得重复 `seq`；`s2c.history.page.messages` 必须全部满足 `seq < beforeSeq`。Host 返回重复或包含边界的事件时，Bridge 必须先按 `seq` 去重并过滤边界，避免客户端上滑时反复追加同一页。

Message 投影：

```json
{
  "seq": 41,
  "role": "assistant",
  "text": "……markdown 原文……",
  "thinking": "……推理（thinking）原文……",
  "streaming": false,
  "tool": { "name": "bash", "state": "ok", "summary": "pnpm test 通过" },
  "attachments": [
    { "kind": "image", "name": "photo.jpg", "mediaType": "image/jpeg",
      "attachmentId": "att-…", "width": 2048, "height": 1536 },
    { "kind": "document", "name": "notes.md", "mediaType": "text/markdown" }
  ],
  "context": { "label": "runtime-context", "form": "snapshot" },
  "ts": 1756000000000,
  "truncated": false
}
```

- `role`：user | assistant | tool | system | error；`tool` 仅 tool 行存在，state 为 running | ok | error。
- `role: system` 表示宿主注入的模型侧上下文（运行时快照、后台任务通知、工作区指令、技能内容等），
  不是真人发言。DSH Host 会把这类 `agent.inject()` 内容与真人 prompt 同样记为 user-role 消息，
  但其消息 `source.kind` 不是 `'user'`；Bridge 参照 Host 轨迹视图的分类规则，把这类行投影为
  `system`，客户端必须与用户气泡区分展示。
- `context`：仅 system 行可选携带的来源信息。`label` 为生产者名（插件名 / 技能名 / 指令路径等），
  `form` 为语义类别（instructions | catalog | snapshot | notice | relay | recall）。两者皆可缺省，
  出现未知取值时客户端按不透明文本处理，不得丢弃该行。
- `thinking`：assistant 行可选，携带模型的推理（reasoning）文本；正文与推理均为空的 assistant 行不下发。
- `streaming: true` 只出现在推送中间态，final/tail/history 中恒为 false。
- `truncated: true` 表示该条 Message 的 UTF-8 JSON 序列化投影原本超过 256KB，
  Bridge 已缩短正文/推理/摘要或附件元数据，使最终单条投影不超过 256KB。
- 一次 `s2c.session.tail` / `s2c.history.page` 的 `messages` JSON 数组不超过 900KB；超出时保留最接近请求边界的较新后缀，并令 `hasMore: true`，客户端继续分页即可完整取回，禁止发送一个超大整帧后让客户端静默丢弃。
- `attachments`：仅 user 行携带的附件清单。图片的 `kind=image`，`attachmentId` 是宿主附件服务的持久引用，
  供 c2s.session.attachment 读回原图；`width`/`height` 为像素尺寸（可选，供客户端预留布局）。
  文本文档的 `kind=document`，由 Bridge 以带边界的模型文本提交；当前 Host 没有通用二进制附件服务，
  因此文档不提供 attachmentId/read-back。`truncated=true` 表示客户端只提交了可读文本前缀。
  attachmentId/宽高为可选字段，客户端必须容忍缺失。

### 会话模型目录与切换

模型列表必须由 Host 的 `session.models` 动态提供，DeepPilot Bridge 和 App 不得内置供应商、模型名称或思考强度选项。`welcome.capabilities.models=false` 时客户端保留入口并显示明确的能力不可用状态。

```json
{ "type": "c2s.session.models", "id": "m-1", "payload": { "sessionId": "session-…" } }
{ "type": "s2c.session.models", "id": "m-1", "payload": {
  "sessionId": "session-…",
  "current": { "provider": "deepseek", "model": "deepseek-chat", "reasoningEffort": "high" },
  "routable": true,
  "groups": [{
    "id": "deepseek",
    "name": "DeepSeek",
    "models": [{
      "id": "deepseek-chat",
      "name": "DeepSeek Chat",
      "description": "…",
      "reasoning": {
        "efforts": [{ "id": "high", "name": "高", "description": "…" }],
        "defaultEffort": "high"
      }
    }]
  }],
  "failures": []
} }
```

切换提交完整路由；`reasoningEffort` 可选，并使用模型目录中对应模型声明的 effort id。服务端只在 Host 校验并应用成功后返回 selected。

```json
{ "type": "c2s.session.selectModel", "id": "m-2", "payload": {
  "sessionId": "session-…", "provider": "deepseek", "model": "deepseek-reasoner", "reasoningEffort": "high"
} }
{ "type": "s2c.session.modelSelected", "id": "m-2", "payload": {
  "sessionId": "session-…",
  "selected": { "provider": "deepseek", "model": "deepseek-reasoner", "reasoningEffort": "high" }
} }
```

`groups` 是建议目录，是否能启动下一轮以 `routable` 为准；单个 Provider 目录失败进入 `failures`，不得使其他 Provider 消失。

### s2c.session.event（实时推送）

`kind` 取值：message.start / message.delta / thinking.delta / message.final / tool.start / tool.end / turn.start / turn.end / projection / error。
当前 v2 Bridge 主动发射 message.delta / thinking.delta / message.final / tool.start /
tool.end / turn.start / turn.end；其余 kind 为兼容 Host 后续事件投影而保留，客户端必须忽略未知或暂未使用的 kind。

```json
{ "type": "s2c.session.event", "payload": {
  "sessionId": "…",
  "kind": "message.delta",
  "seq": 42,
  "data": { "text": "增量片段" }
} }
```

- message.delta/message.final 共用同一会话内 seq；data.text 为增量/全文。极端超大增量同样会被限制在 256KB 内，并在 data 附 `truncated:true`。
- thinking.delta 的 data.text 为推理增量，seq 与同会话其他事件一致；客户端应把连续增量折叠进同一条"思考"行（role=assistant、thinking 累积、streaming=true），final 到达后由带 `thinking` 字段的正式行替换。
- tool.start 的 `data.tool` 为 `{name, state:"running", summary}`；Host 事件携带调用 id 时额外附带 `tool.callId`。tool.end 的 data 附带 ok 布尔与该结果事件自身的 seq，并在 Host 事件携带调用 id 时附带 `callId`——`seq` 标识的是 result 事件本身，客户端必须用 `callId`（缺失时按"最旧的未完成工具行"兜底）把结果合并回对应的 tool.start 行，不得按 seq 匹配。
- turn.end 的 data 附带 ok 布尔；projection 的 data 为 key/value（如 todos）。

## 4b. 项目选择与新建会话

`welcome.capabilities.projectSelection=true` 表示 Bridge 同时具备 Host `workspace.list/create` 能力。新建会话界面先列出现有项目：

```json
{ "type": "c2s.workspaces.list", "id": "w-1", "payload": {} }
{ "type": "s2c.workspaces.snapshot", "id": "w-1", "payload": { "workspaces": [{
  "id": "workspace-…", "title": "deeppilot-demo", "path": "/Users/sea/Development/deeppilot-demo", "sessionIds": ["session-…"]
}] } }
```

添加项目时优先使用 Host 的远程目录浏览能力。`path` 缺省时从 Host 用户主目录开始；客户端只能回传 Host 给出的绝对路径，不自行拼接路径：

```json
{ "type": "c2s.directory.list", "id": "d-1", "payload": { "path": "/Users/sea/Development" } }
{ "type": "s2c.directory.listing", "id": "d-1", "payload": {
  "path": "/Users/sea/Development", "home": "/Users/sea", "crumbs": [], "entries": [], "truncated": false
} }
```

DeepPilot 的标准 bundle 固定组合 Host 官方 `directory-picker-browse` 双面包，使远程 iPhone 能调用 `directory.list`。Host 不提供该能力时请求返回 `E_UNSUPPORTED`；客户端可在用户明确点击后请求 Mac 系统选择器。取消时 `path=null`：

```json
{ "type": "c2s.directory.pick", "id": "d-2", "payload": {} }
{ "type": "s2c.directory.picked", "id": "d-2", "payload": { "path": "/Users/sea/Development/new-project" } }
```

选中已有文件夹后，以 Host `workspace.create` 采用为项目；重复采用同一路径是幂等成功（`created=false`）：

```json
{ "type": "c2s.workspace.create", "id": "w-2", "payload": { "path": "/Users/sea/Development/new-project" } }
{ "type": "s2c.workspace.created", "id": "w-2", "payload": { "workspace": {
  "id": "workspace-…", "title": "new-project", "path": "/Users/sea/Development/new-project", "sessionIds": []
}, "created": true } }
```

### c2s.session.create（payload: workspaceId? 或 cwd?）

客户端正常流程必须先选择项目并发送 `workspaceId`。`cwd` 用于显式路径创建；两者互斥。服务端通过核心 API 创建空白会话并返回 id，随后客户端可 session.open 订阅。

```json
{ "type": "s2c.ack", "payload": { "sessionId": "session-…" } }
```

`projectSelection=false` 时，客户端保留入口并明确提示能力不可用，不得静默创建到 Host 默认目录。

## 4c. 会话管理

会话重命名真实调用 Host `session.rename`，成功后返回 Host 接受的规范化名称：

```json
{ "type": "c2s.session.rename", "id": "r-1", "payload": { "sessionId": "session-…", "title": "新的名称" } }
{ "type": "s2c.session.renamed", "id": "r-1", "payload": { "sessionId": "session-…", "title": "新的名称" } }
```

归档真实调用 Host `workspace.archiveSession`。归档仅从所有普通分组界面隐藏会话，保留会话日志与原项目位置；成功响应后同一会话还会通过 sessions delta 的 `removedIds` 从列表镜像移除。

```json
{ "type": "c2s.session.archive", "id": "a-1", "payload": { "sessionId": "session-…" } }
{ "type": "s2c.session.archived", "id": "a-1", "payload": { "sessionId": "session-…" } }
```

Host 不具备这两个 RPC 时 `welcome.capabilities.sessionManagement=false`，请求返回 `E_UNSUPPORTED`，客户端不得伪造本地成功状态。

## 5. 写链路

### c2s.session.sendPrompt（payload: sessionId, text, images?, documents?）

服务端受理后回 `s2c.ack`（payload 附 `userSeq`），随后该输入以正常消息事件流入会话流。`userSeq` 是 Bridge 生成的受理回执标记，不属于会话事件 seq，客户端不得拿它与 `session.event.seq` 对账。会话正忙回 `E_BUSY`。`text`、`images` 与 `documents` 至少一项非空。

`images` 最多 4 项，每项为 `{mediaType,data,name?}`。`mediaType` 仅允许 `image/png`、`image/jpeg`、`image/webp`、`image/gif`，`data` 为无 data-URL 前缀的标准 base64。Bridge 做数量、类型和单项体积初筛，DSH Host 再按当前模型与附件服务限制完成最终校验和持久化。

`documents` 最多 4 项，且与 images 合计不超过 4 项。每项为 `{mediaType,name,text,truncated?}`：App 在本机提取 UTF-8 文本（包括 PDF 的文本层），单项不超过 256K 字符；Bridge 以明确文件名和边界的 text block 交给 Host。二进制 Office/压缩包等无法安全提取文本的格式必须由客户端拒绝，不得假装上传成功。

```json
{ "type": "c2s.session.sendPrompt", "payload": {
  "sessionId": "session-…",
  "text": "分析这张图",
  "images": [{"mediaType":"image/jpeg","data":"/9j/…","name":"photo.jpg"}],
  "documents": [{"mediaType":"text/markdown","name":"notes.md","text":"# Notes"}]
} }
```

### c2s.session.attachment（payload: sessionId, attachmentId）

按 id 读回一张会话引用过的持久化图片（宿主校验该会话日志确实包含此 id 后才返回）。
RPC 响应 result 为 `{ "mediaType": "image/jpeg", "data": "<base64>" }`；宿主不可用或 id 无效回 `E_NOT_FOUND`。
客户端应做磁盘缓存，避免重复拉取。

```json
{ "type": "c2s.session.attachment", "id": "r-9", "payload": { "sessionId": "session-…", "attachmentId": "att-…" } }
{ "type": "s2c.ack", "id": "r-9", "payload": { "mediaType": "image/jpeg", "data": "/9j/…" } }
```

### c2s.session.cancel（payload: sessionId）

中止该会话当前正在执行的 turn（真实调用 Host `session.cancel({sessionId})`，保留队列 FIFO 续跑）。服务端受理后回 `s2c.ack`（payload 附 sessionId），随后 turn 以正常 `turn.end`（reason=interrupted）事件流入会话流。会话空闲时同样回 ack（幂等）；会话不存在回 `E_NOT_FOUND`。

```json
{ "type": "c2s.session.cancel", "id": "c-1", "payload": { "sessionId": "session-…" } }
{ "type": "s2c.ack", "id": "c-1", "payload": { "sessionId": "session-…" } }
```

### 审批

```json
{ "type": "s2c.pending.approval", "payload": {
  "requestId": "apr-1",
  "sessionId": "…",
  "toolName": "bash",
  "summary": "pnpm install",
  "riskLevel": "write"
} }
{ "type": "c2s.approval.respond", "payload": { "requestId": "apr-1", "decision": "allow", "reason": "" } }
{ "type": "s2c.pending.cleared", "payload": { "requestId": "apr-1" } }
```

- decision：allow | deny；reason 可选，deny 时可附说明。
- riskLevel：read | write | destructive。
- 挂起审批同时体现在 SessionSummary.pendingApproval。

### 提问

```json
{ "type": "s2c.pending.question", "payload": {
  "requestId": "q-1",
  "sessionId": "…",
  "questions": [
    { "id": "mode", "question": "选择方案", "multiSelect": false,
      "options": [ { "label": "方案 A（推荐）", "description": "改动最小" } ] }
  ]
} }
{ "type": "c2s.question.respond", "payload": { "requestId": "q-1",
  "answers": [ { "id": "mode", "selected": ["方案 A"] } ] } }
```

- 无 options 的题为自由文本：selected 留空数组、填 custom。multiSelect 为 true 时 selected 可多项。
- `custom` 仅在用户确实输入了非空白自由文本时携带；禁止发送 `"custom": ""`。
  主机侧严格校验答案批次（逐题 id、选项 label 集合），出现空 `custom`、重复 label，
  或单选题同时携带 selected 与 custom，都会被整体拒绝（`E_PROTOCOL`，answer rejected）。
- Bridge 在转发前会按上述规则归一化 answers（剔除空白 custom 等）。

### 待处理快照

APNs 只承载通知投影，不承载回答所需的 requestId 和完整问题选项。客户端在握手、
通知点击或 `s2c.resync` 后应主动请求当前待处理快照；这条路径不依赖有限长度的重放环。

```json
{ "type": "c2s.pending.list", "id": "pending-1", "payload": {} }
{ "type": "s2c.pending.snapshot", "id": "pending-1", "payload": {
  "approvals": [ { "requestId": "apr-1", "sessionId": "…", "toolName": "bash", "summary": "pnpm install", "riskLevel": "write" } ],
  "questions": [ { "requestId": "q-1", "sessionId": "…", "questions": [ { "id": "mode", "question": "选择方案", "multiSelect": false, "options": [] } ] } ]
} }
```

- `welcome.capabilities.pendingSnapshot=true` 表示服务端支持此请求；false 或缺失时客户端依赖重放并降级展示。
- 快照是全量替换语义；空数组表示当前没有对应的待处理请求。

### 与 DSH 官方 Web 回答者的共存

DSH `0.1.2-alpha.3` 起，Host 侧的 `approval/request` 与
`user-questions/request` 只由官方 API Remotes 接入一次；API Gateway 为每个请求
保存统一 pending 状态，并把相同请求并行投递给官方 Web Client 与 DeepPilot
驻留 Remote Client。任一 Client 先回答后，由 Gateway 统一结算并取消其他 Client
上的同一请求。因此 DeepPilot 不直接注册或抢占 Host waterfall，也不替换官方
Web composer。

存在至少一台已配对且未吊销的设备时，DeepPilot Client 保持请求待答并向手机
发布 `s2c.pending.*`；设备离线、APNs 不可用或通知被静默都不影响稍后通过
`c2s.pending.list` 主动拉取。没有可用配对设备时，DeepPilot Client 对自己的
delivery 调用 `next()`；这不会撤销 Gateway 已经并行交给官方 Web 的 delivery。

Web 或另一 Client 先回答时，Gateway cancellation 会让插件发布对应的
`s2c.pending.*.resolved`，手机上的卡片随即失效。手机先回答时，
`c2s.*.respond` 的结果沿官方 Remote Events result 通道返回 Gateway，由 Gateway
负责 first-answer-wins 仲裁。

## 6. 通知

```json
{ "type": "s2c.notify", "payload": {
  "notificationId": "n-1",
  "category": "turn.completed",
  "sessionId": "…",
  "title": "任务完成",
  "body": "测试全部通过",
  "ts": 1756000000000
} }
```

- category：turn.completed | approval.required | question.asked | session.error。
- `welcome.capabilities.notifyAllCategories=true` 表示 Bridge 会为上述四类事件统一发送
  `s2c.notify`。此时客户端只能从 `s2c.notify` 触发横幅、声音等通知展示，不得再从
  `s2c.session.event(turn.end)`、`s2c.pending.approval` 或 `s2c.pending.question` 重复展示。
- `s2c.session.event` 和 `s2c.pending.*` 仍是会话内容、待处理状态及回答操作的权威数据源；
  `s2c.notify` 只是面向用户的展示投影。Bridge 必须先记录权威事件，再记录对应 notify，
  以保证按 seq 重放时状态先于通知到达。
- `notifyAllCategories` 为 false 或缺失时，客户端可从 turn.end / pending.* 做回退；
  一旦能力为 true，就必须关闭这些回退分支。
- 触发规则（F-9）：对未打开该会话的在线设备，在 turn 结束、出现
  pending.approval / pending.question 或会话 error 时发送；离线设备走同事实的 APNs 投影。
- `notificationId` 标识同一个逻辑通知，在实时 WS、WS 重放和 APNs 投影之间保持稳定；
  客户端应按该字段幂等去重。notify 计入 seq 游标参与重放。
- `title` / `body` 是可直接展示的回退文本；客户端可按已知 category 使用本地化标题，
  但不得改写动态 body 或依赖 title 文案判断类别。

### 离线推送（APNs）

`welcome.capabilities.push=true` 表示 Bridge 已配置 APNs。App 在获得系统远程通知
token 后发送：

```json
{ "type": "c2s.push.register", "id": "pu-1", "payload": {
  "deviceToken": "<64 位 hex 设备 token>",
  "environment": "development",
  "categories": { "turn.completed": true, "approval.required": true },
  "enrollKey": "<可选：分发版 App 内置的注册密钥>"
} }
{ "type": "s2c.ack", "id": "pu-1", "payload": { "enabled": true } }
```

- ack 的 `enabled`：注册处理完成后的实际就绪状态。自动注册
  场景下 Bridge 可能在本次注册中才切换为就绪，客户端据此立即更新本地能力
  标记，无需等待下一次握手；客户端须容忍 `enabled` 缺省。

- `deviceToken`：hex 字符串，32–512 个字符；服务端只接受 `[0-9a-f]`。
- `environment`：development | production。设备按自身构建自动上报
  （调试=sandbox，TestFlight/App Store=production），Bridge 按设备逐一路由。
- `categories` 可选：设备端按类别的开关镜像；缺省视为全开。Bridge 对离线设备
  推送时必须尊重该开关。
- 投递前提：目标设备必须持有 `notifications.register` scope——即使持有 APNs
  token，scope 被撤销的设备也不接收离线推送；同时必须满足上述通知类别的内容权限。
- `enrollKey` 可选：分发者内置到 App 的共享注册密钥。Bridge 在
  未配置任何推送 provider 时收到它，会自动切换为 relay 模式并向中继执行
  自动注册（零配置接入）；已显式配置 provider 的 Bridge 忽略该字段。
- 每次握手成功后 App 应重新发送（token 与开关都可能变化）；重复注册幂等。
- 能力为 false 时请求回 `E_UNSUPPORTED`。

**推送触发规则**：与 notify 帧相同的事件（turn 完成/异常、待审批、提问、会话出错），
对「已持有 token 且当前无活跃 WebSocket 连接」的设备经 APNs 下发；在线设备的
通知仍走 WS 帧 + 本地通知路径，两条通道互斥以避免重复横幅。推送不计入 seq
游标、不参与重放（重连后的离线事件由 resume 重放覆盖）。

### 小组件刷新推送（WidgetKit）

`welcome.capabilities.widgetPush=true` 表示 Bridge 支持小组件内容失效推送。
小组件扩展（iOS 26+）经系统拿到 WidgetKit 专属推送 token 后，用
`clientRole:"widget"` 的短连接发送：

```json
{ "type": "c2s.widget.push.register", "id": "wp-1", "payload": {
  "deviceToken": "<64 位 hex WidgetKit token>",
  "environment": "development",
  "enrollKey": "<可选，同 c2s.push.register>"
} }
{ "type": "s2c.ack", "id": "wp-1", "payload": { "enabled": true } }
```

- 该 token 与告警推送 token **相互独立**：两者类型不同、生命周期不同，分别
  存储，吊销设备时一并清除；重新配对/重复注册幂等，token 轮换会覆盖旧值。
- 注册除 `notifications.register` 外还要求设备持有 `sessions.read` 与
  `interactions.respond` scope（小组件概览同时包含会话与待处理计数）。
- **载荷完全无内容**：APNs 帧体固定为 `{ "aps": { "content-changed": true } }`，
  头为 `apns-push-type: widgets`、topic 追加 `.push-type.widgets` 后缀、
  `apns-priority: 5`、`apns-collapse-id: widget-overview`。它不含会话、
  标题或任何业务字段，只表达"概览已变化，请重新拉取"。
- **触发与节流**：Bridge 在概览投影（会话摘要 + 待处理集合）的指纹实际变化
  时触发，服务端按每 Host 30 秒合并/节流（保留尾沿状态，不饿死持续更新）。
  在线/离线都发送；小组件收到推送后自行以 `clientRole:"widget"` 短连接
  拉取 `sessions.list` + `pending.list` 并断开。
- WidgetKit token 由系统管理且预算受限，Bridge 侧超 7 天未刷新的 token 视为
  过期不再发送；APNs 返回终态失效（Unregistered/ExpiredToken）时立即清除，
  BadDeviceToken 可能只是环境不匹配，保留以便诊断。
- 能力为 false/缺失时客户端不得发送该请求（服务端回 `E_UNSUPPORTED` 或
  `E_PROTOCOL`）。Relay 分发模式同样透传该推送，中继只做转发与限流。


## 7. 断线重放

- 每个 s2c 推送帧信封额外携带数值字段 seq（服务端本次启动以来单调递增），覆盖 sessions.delta / session.event / notify / pending.* 。请求响应帧不占 seq。
- 重连时 `c2s.auth.prove` 带 `resumeCursor`：命中缓冲则按序补发原帧，补发完追加一帧 `s2c.resume.done`。
- 游标过旧（超出环形缓冲）则发 `s2c.resync`（payload.reason 为 gap），客户端应重新拉 sessions.list 并重开关注的会话。

## 8. 心跳与生命周期

- 客户端每 25 秒发 `c2s.ping`（payload 空）；服务端回 `s2c.pong`（payload.serverTime）。
- 服务端对死连接：60 秒无任何入站帧即以 **1001** 关闭。
- 服务端优雅停机：先向所有连接发 `s2c.error`（E_INTERNAL，server stopping），
  再以 **1001** 关闭；客户端不应把这两类 1001 当成异常网络故障。
- 单个客户端持续来不及读取、服务端待发送缓冲超过 4MB 时，以 **1013** 关闭；
  客户端可按临时过载执行退避重连。

## 9. 错误帧

```json
{ "type": "s2c.error", "id": "<ref>", "payload": { "code": "E_NOT_FOUND", "message": "session not found" } }
```

| 码 | 含义 |
|---|---|
| E_AUTH | 设备未注册、已撤销或签名证明无效 |
| E_FORBIDDEN | 设备 scope 不允许该操作 |
| E_PROTOCOL | 未知类型或非法 payload |
| E_NOT_FOUND | 会话或请求不存在 |
| E_BUSY | 会话正在处理上一条输入 |
| E_UNSUPPORTED | 协议版本或能力不支持 |
| E_INTERNAL | 服务端内部错误 |

## 10. 能力协商与版本策略

- welcome.capabilities 中为 false 的能力，客户端不得调用对应 c2s 帧（服务端将回 E_UNSUPPORTED）。
- `notifyAllCategories` 是服务端投影保证而非新请求权限：缺失/false 表示客户端保留事件
  通知回退，true 表示四类通知均由 `s2c.notify` 唯一负责展示。
- v2 同版本新增可选字段时双方必须忽略未知字段。
- v1 不受支持；服务端不得接受 Bearer、`c2s.hello.auth` 或通过错误重试降级。
- 后续破坏性变更必须升级 `v`，不能静默重新解释 v2 字段。

### 通知 Host 路由（向后兼容扩展）

`s2c.notify` 与 APNs/Relay notification 可携带可选 `hostAudience`，值为配对时
登记的稳定 Host audience（`deeppilot:` 加 22 位 base64url）。Bridge 在发送时填写，
Relay 校验并原样转发。App 根据该值匹配本地实例，不能用当前选中实例代替来源。
多个本地配置匹配时，通知点击由用户选择；后台审批必须唯一匹配并重新获取 pending。
旧 Bridge/Relay 没有该字段时，仅单实例可自动路由，多实例点击需选择；未知或已删除
Host 不自动回退。旧客户端可忽略新增字段，协议版本及其他字段保持不变。
APNs collapse/thread 标识在存在 hostAudience 时按 Host 隔离；通知原始 notificationId
保持不变，以继续解析旧审批的 `apr-<requestId>`。

### 客户端请求字段验证

已认证的请求在业务调用前验证 payload 必须为对象；无参数请求允许省略 payload。
可选字段若提供则必须符合声明类型，不把错误类型当作未提供。新增未知字段仍忽略。
标识符最多 4096 字符，路径最多 32768 字符，标题最多 4096 字符；模型 provider/model/
reasoningEffort 分别最多 256/1024/128 字符。history.beforeSeq 必须为非负安全整数，
limit 为 1–500 的整数；tailCount 为 1–10000 的整数。审批 reason 和提问 custom
最多 65536 字符；answers 及每项 selected 最多 100 项，answer id 不能重复。
APNs environment 若提供只接受 development/production，categories 的值必须为布尔值。
非法字段返回 E_PROTOCOL；权限不足仍优先返回 E_FORBIDDEN。既有附件及正文预算继续生效。

### 稳定发送身份与投递回执（可选 v2 扩展）

`welcome.capabilities.promptDelivery = true` 表示支持以下契约。旧客户端仍可省略
`clientSendId`，沿用旧 ack；新客户端对不支持该能力的 Bridge 保留兼容路径。

- `c2s.session.sendPrompt` 可增加 `clientSendId`，格式为 13 位毫秒时间戳、连字符、UUID。
  同一发送的 ID、会话、正文和附件在重试时必须保持不变。
- ID 以已认证设备为命名空间，不能用帧 `id` 代替。相同设备＋ID＋内容只调度一次；
  并发重复请求复用回执。同 ID 不同内容返回 rejected/E_PROTOCOL。
- 携带该字段时 `s2c.ack` payload 为 `{clientSendId, status, userSeq?, code?}`。
  status 为 accepted/rejected/unknown/notFound/expired。accepted 表示上游已受理，
  不表示 turn 完成；userSeq 仍仅为回执标记，不能与消息 seq 对账。
- `c2s.session.delivery` payload 为 `{sessionId, clientSendId}`，返回相同回执结构，
  要求 `prompt.send` 权限且只能查询本设备的记录。查询没有副作用。
- Bridge 在调度上游前原子写入并同步本地 journal，再保存最终结果。中断、内部错误或
  存储异常均保留 unknown，不重放可能已经执行的请求。journal 不应被手动删除；
  数据目录由单一 Host 进程拥有，同进程 Bridge 重建共享 journal。
- 新 ID 允许至多 5 分钟未来时钟偏移和 7 天回溯。超过 7 天的旧 ID 不再触发新调度。
  journal 最多保留 10000 项；未过期项不会为腾出空间被淘汰，容量满时拒绝新发送。
- App 在网络请求前保存待确认 ID、显示正文和附件数量，最多每实例 100 项；不保存
  自动重试所需的图片原始数据。重连、前台会话轮询会查询回执；accepted 清除待确认
  记录，rejected 显示明确拒绝，notFound/expired/unknown 均不自动重发。
  新路径不以相同正文或附件数量认定投递成功。

此契约提供有持久化记录时的至多一次调度，不宣称在上游不支持幂等键的情况下实现
崩溃后的 exactly-once。若上游已接收而 Bridge 来不及记录结果，需用户核对会话。
