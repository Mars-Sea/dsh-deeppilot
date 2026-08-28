# DeepPilot Bridge Protocol — v1

状态：v1 冻结基线（M1）。所有帧均为 WebSocket **文本帧**，UTF-8 编码的 JSON。v1 通过 sendPrompt 的可选 base64 图片字段向后兼容图片输入；二进制帧仍保留。

## 1. 信封（Envelope）

```json
{
  "v": 1,
  "type": "c2s.session.open",
  "id": "b3c1d9e0-…",
  "ts": 1756000000000,
  "payload": { }
}
```

- `v` 必须等于 1；不匹配时服务端回一帧 `s2c.error(E_UNSUPPORTED)` 后以 4500 关闭。
- 命名：客户端请求 `c2s.*`，服务端响应与推送 `s2c.*`。
- 未知 type：服务端回 `E_PROTOCOL` 错误帧，不断连。

## 2. 连接与鉴权

1. 客户端连接 `wss://host/phone`。鉴权优先使用 HTTP `Authorization: Bearer TOKEN`；也可在未预鉴权的 WebSocket 建立后 5 秒内发送 `c2s.hello.auth` 并携带 `payload.token`。`?token=TOKEN` 仅为旧客户端兼容，不应写入新客户端 URL 或日志。
2. 鉴权失败：服务端以关闭码 **4401** 关闭。超时未鉴权：**4402**。`deviceId`
   缺失或非法时以 **4403** 关闭；客户端应把它视为本机身份资料错误，而不是 token 失效。
3. 鉴权成功后服务端必须首先下发 `s2c.welcome`。welcome 之前客户端只允许发 hello 与 ping。

### c2s.hello.auth

```json
{ "type": "c2s.hello.auth", "payload": {
  "token": "…",
  "deviceId": "A1B2…",
  "deviceName": "iPhone 15 Pro",
  "appVersion": "0.1.0",
  "resumeCursor": 1042
} }
```

### s2c.welcome

```json
{ "type": "s2c.welcome", "payload": {
  "protocolVersion": 1,
  "serverVersion": "0.1.0",
  "capabilities": { "historyPaging": true, "replay": true, "approvals": true, "questions": true, "pendingSnapshot": true, "notifyAllCategories": true, "models": true, "sessionManagement": true, "projectSelection": true, "push": true },
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
  "workspaceLabel": "deeppilot-demo",
  "workspaceId": "workspace-…",
  "workspacePath": "/Users/sea/Development/deeppilot-demo"
}
```

`status` 取值：running | idle | error | unknown；当前 v1 Bridge 的会话镜像稳定产生
running/idle，error/unknown 为旧实现与后续 Host 状态扩展保留；`todos` 无则为 null。
`todoItems` 为完整清单条目（`content` 非空字符串；`status` 取值 pending | in_progress |
completed），供会话详情页渲染任务进度；无任务时为 null 或缺省。旧 Bridge 不下发该字段，
客户端必须容忍缺失（可选字段，向后兼容）。

列表变更推送（握手后自动开始，无需订阅）：

```json
{ "type": "s2c.sessions.delta", "payload": { "upserted": [SessionSummary], "removedIds": [] } }
```

会话与项目均按 `lastActivityTs` 从新到旧展示；项目使用项目内最新会话时间排序。归档后 Bridge 必须把该会话放入 `removedIds`，不得继续出现在普通列表。

## 4. 会话明细

### c2s.session.open（payload: sessionId, tailCount? 默认 100）

服务端先回一次性 `s2c.session.tail`，随后该会话实时事件以 `s2c.session.event` 推送。多设备各自 open 各自收，互不影响。

### c2s.session.close（payload: sessionId）

客户端离开会话详情时发送；服务端取消该连接对该会话的实时订阅与“正在查看”标记，
不关闭 WebSocket，也不终止会话 turn。该帧为幂等通知，不产生响应。

### s2c.session.tail 与 c2s.session.history

```json
{ "type": "s2c.session.tail", "payload": { "sessionId": "…", "messages": [Message], "oldestSeq": 12, "hasMore": true } }
{ "type": "c2s.session.history", "payload": { "sessionId": "…", "beforeSeq": 12, "limit": 100 } }
{ "type": "s2c.history.page", "payload": { "sessionId": "…", "messages": [Message], "hasMore": false } }
```

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
      "attachmentId": "att-…", "width": 2048, "height": 1536 }
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
  `system`，客户端必须与用户气泡区分展示。旧 Bridge 不做该分类，此类行仍是 `user`——客户端须容忍。
- `context`：仅 system 行可选携带的来源信息。`label` 为生产者名（插件名 / 技能名 / 指令路径等），
  `form` 为语义类别（instructions | catalog | snapshot | notice | relay | recall）。两者皆可缺省，
  出现未知取值时客户端按不透明文本处理，不得丢弃该行。
- `thinking`：assistant 行可选，携带模型的推理（reasoning）文本；正文与推理均为空的 assistant 行不下发。
- `streaming: true` 只出现在推送中间态，final/tail/history 中恒为 false。
- `truncated: true` 表示该条 Message 的 UTF-8 JSON 序列化投影原本超过 256KB，
  Bridge 已缩短正文/推理/摘要或附件元数据，使最终单条投影不超过 256KB。
- `attachments`：仅 user 行携带的图片清单。`kind` 恒为 image；`attachmentId` 是宿主附件服务的持久引用，
  供 c2s.session.attachment 读回原图；`width`/`height` 为像素尺寸（可选，供客户端预留布局）。
  旧 Bridge 不下发 attachmentId/宽高，客户端必须容忍缺失。

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
当前 v1 Bridge 主动发射 message.delta / thinking.delta / message.final / tool.start /
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

DeepPilot 的标准 bundle 固定组合 Host 官方 `directory-picker-browse` 双面包，使远程 iPhone 能调用 `directory.list`。连接旧 Bridge 或其他仍使用 `native` 的组合时，该请求返回 `E_UNSUPPORTED`；客户端可在用户明确点击后请求 Mac 系统选择器。取消时 `path=null`：

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

客户端正常流程必须先选择项目并发送 `workspaceId`。`cwd` 仅为旧客户端兼容；两者互斥。服务端通过核心 API 创建空白会话并返回 id，随后客户端可 session.open 订阅。

```json
{ "type": "s2c.ack", "payload": { "sessionId": "session-…" } }
```

旧 Bridge 的 `projectSelection` 缺省或为 false 时，客户端保留入口并明确提示更新，不得静默创建到 Host 默认目录。

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

旧 Host 不具备这两个 RPC 时 `welcome.capabilities.sessionManagement=false`，请求返回 `E_UNSUPPORTED`，客户端不得伪造本地成功状态。

## 5. 写链路

### c2s.session.sendPrompt（payload: sessionId, text, images?）

服务端受理后回 `s2c.ack`（payload 附 `userSeq`），随后该输入以正常消息事件流入会话流。`userSeq` 是 Bridge 生成的受理回执标记，不属于会话事件 seq，客户端不得拿它与 `session.event.seq` 对账。会话正忙回 `E_BUSY`。`text` 与 `images` 至少一项非空。

`images` 最多 4 项，每项为 `{mediaType,data,name?}`。`mediaType` 仅允许 `image/png`、`image/jpeg`、`image/webp`、`image/gif`，`data` 为无 data-URL 前缀的标准 base64。Bridge 做数量、类型和单项体积初筛，DSH Host 再按当前模型与附件服务限制完成最终校验和持久化。

```json
{ "type": "c2s.session.sendPrompt", "payload": {
  "sessionId": "session-…",
  "text": "分析这张图",
  "images": [{"mediaType":"image/jpeg","data":"/9j/…","name":"photo.jpg"}]
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
- Bridge 在转发前会按上述规则归一化 answers（剔除空白 custom 等），旧版客户端仍可正常作答。

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

- `welcome.capabilities.pendingSnapshot=true` 表示服务端支持此请求；旧服务端缺失该字段时客户端继续依赖重放并降级展示。
- 快照是全量替换语义；空数组表示当前没有对应的待处理请求。

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
- 旧 Bridge 缺失 `notifyAllCategories` 时，客户端可继续从 turn.end / pending.* 做兼容回退；
  一旦能力为 true，就必须关闭这些回退分支。
- 触发规则（F-9）：对未打开该会话的在线设备，在 turn 结束、出现
  pending.approval / pending.question 或会话 error 时发送；离线设备走同事实的 APNs 投影。
- `notificationId` 标识同一个逻辑通知，在实时 WS、WS 重放和 APNs 投影之间保持稳定；
  客户端应按该字段幂等去重。notify 计入 seq 游标参与重放。
- `title` / `body` 是可直接展示的回退文本；客户端可按已知 category 使用本地化标题，
  但不得改写动态 body 或依赖 title 文案判断类别。

### 离线推送（APNs，v1.x 追加）

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

- ack 的 `enabled`（v1.x 追加）：注册处理完成后的实际就绪状态。自动注册
  场景下 Bridge 可能在本次注册中才切换为就绪，客户端据此立即更新本地能力
  标记，无需等待下一次握手；旧 Bridge 回空 payload，客户端须容忍缺省。

- `deviceToken`：hex 字符串，32–512 个字符；服务端只接受 `[0-9a-f]`。
- `environment`：development | production。设备按自身构建自动上报
  （调试=sandbox，TestFlight/App Store=production），Bridge 按设备逐一路由。
- `categories` 可选：设备端按类别的开关镜像；缺省视为全开。Bridge 对离线设备
  推送时必须尊重该开关。
- `enrollKey` 可选（v1.x 追加）：分发者内置到 App 的共享注册密钥。Bridge 在
  未配置任何推送 provider 时收到它，会自动切换为 relay 模式并向中继执行
  自动注册（零配置接入）；已显式配置 provider 的 Bridge 忽略该字段。
- 每次握手成功后 App 应重新发送（token 与开关都可能变化）；重复注册幂等。
- 能力为 false 时请求回 `E_UNSUPPORTED`。

**推送触发规则**：与 notify 帧相同的事件（turn 完成/异常、待审批、提问、会话出错），
对「已持有 token 且当前无活跃 WebSocket 连接」的设备经 APNs 下发；在线设备的
通知仍走 WS 帧 + 本地通知路径，两条通道互斥以避免重复横幅。推送不计入 seq
游标、不参与重放（重连后的离线事件由 resume 重放覆盖）。


## 7. 断线重放

- 每个 s2c 推送帧信封额外携带数值字段 seq（服务端本次启动以来单调递增），覆盖 sessions.delta / session.event / notify / pending.* 。请求响应帧不占 seq。
- 重连时 hello.auth 带 resumeCursor：命中缓冲则按序补发原帧，补发完追加一帧 `s2c.resume.done`。
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
| E_AUTH | token 缺失或错误 |
| E_PROTOCOL | 未知类型或非法 payload |
| E_NOT_FOUND | 会话或请求不存在 |
| E_BUSY | 会话正在处理上一条输入 |
| E_UNSUPPORTED | 协议版本或能力不支持 |
| E_INTERNAL | 服务端内部错误 |

## 10. 能力协商与版本策略

- welcome.capabilities 中为 false 的能力，客户端不得调用对应 c2s 帧（服务端将回 E_UNSUPPORTED）。
- `notifyAllCategories` 是服务端投影保证而非新请求权限：缺失/false 表示客户端保留旧事件
  通知回退，true 表示四类通知均由 `s2c.notify` 唯一负责展示。
- v1.x 新增字段一律向后兼容：双方必须忽略未知字段。
- 破坏性变更升级 v 为 2，v1 保持可用一个过渡期。
