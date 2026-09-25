# DeepPilot rc.2 功能实施规划

> 状态：M1–M3 Host facade、协议、权限和幂等实现已完成；iOS UI、真机联调和发布验证尚未完成。
> 目标：把 DSH `0.1.7-rc.2` 的两个高价值能力安全地暴露给 DeepPilot：
> 1. 定时任务/提醒；
> 2. 从某一轮创建会话分支。

## 总体原则

- 先完成 DSH rc.2 依赖升级和基线验证，再实现手机协议。
- DSH Host Service 只在 `DshApiProxy` 后面适配，手机端不直接依赖 DSH Controller 类型。
- 新能力全部采用可选 capability；旧 iOS 客户端继续使用协议 v2 的既有行为。
- `PROTOCOL.md` 与 `src/protocol.ts` 必须同步修改，私有 iOS 仓库必须同步更新 Swift mirror。
- 所有新增操作都使用 request id 和 Host 侧幂等保护，避免手机重试造成重复提醒或重复分支。
- 不在日志、APNs 标题/正文或 Relay payload 中写入提醒正文、消息正文、工具参数或凭据。

## 里程碑

| 阶段 | 内容 | 退出条件 |
| --- | --- | --- |
| M0 | DSH rc.2 依赖、lockfile、兼容性测试和配置 schema 升级 | rc.2 CLI/schema 检查、typecheck、build 通过 |
| M1 | 协议和 Host adapter 设计落地 | `PROTOCOL.md`、TypeScript mirror、授权矩阵、幂等 journal 设计完成 |
| M2 | 手机端定时任务/提醒 MVP | 创建、列表、更新、删除、历史记录在真实 iPhone + DSH rc.2 上通过 |
| M3 | 手机端会话分支 MVP | 从消息/轮次创建新会话、旧会话不变、重连和重复请求通过 |
| M4 | 稳定性与发布 | 安全审计、回归测试、npm pack、真实 DSH web profile 验证完成 |

---

## 一、手机端定时任务/提醒

### 1.1 用户价值

用户可以在手机上为某个 DeepPilot 会话设置：

- “10 分钟后提醒我检查构建”；
- “每隔 30 分钟检查部署状态”；
- “每天 23:00 汇总今天任务”；
- 查看任务当前状态、下一次执行时间和最近投递记录；
- 修改、暂停（通过删除/重建或后续扩展）和删除任务。

DSH rc.2 负责持久化、定时触发、Session 恢复和 delivery history；DeepPilot 只负责安全的手机控制面和状态展示。

### 1.2 Host 适配

在 [src/dsh-api-proxy.ts](../src/dsh-api-proxy.ts) 增加可选的 `schedule` facade，不把 `ctx.schedule` 放进 `inject`，避免没有定时任务插件的 DSH profile 使整个 DeepPilot 插件失效。

建议内部接口：

```ts
interface ScheduleControllerLike {
  create(sessionId: string, request: ScheduleCreateRequest): Promise<ScheduleRecord>
  list(request: { sessionId: string }): Promise<ScheduleRecord[]>
  catalog(): Promise<ScheduleCatalogEntry[]>
  history(request: ScheduleHistoryRequest): Promise<ScheduleHistoryResult>
  update(request: ScheduleUpdateRequest): Promise<ScheduleUpdateResult>
  delete(request: ScheduleDeleteRequest): Promise<ScheduleDeleteResult>
}
```

`DshApiProxy` 通过 `ctx.get('schedule')` 获取服务；服务不存在时：

- `welcome.capabilities.schedules = false`；
- 相关请求返回稳定的 `E_UNSUPPORTED`；
- 不影响会话、消息、审批、通知和已有连接。

### 1.3 手机协议草案

保持协议 v2 的已有帧语义，新增可选帧和能力位：

```json
{
  "type": "c2s.schedule.list",
  "id": "schedule-list-1",
  "payload": { "sessionId": "session-..." }
}
```

```json
{
  "type": "s2c.schedule.snapshot",
  "payload": {
    "sessionId": "session-...",
    "tasks": []
  }
}
```

新增请求：

- `c2s.schedule.list`：列出会话的活动任务；
- `c2s.schedule.history`：读取某个任务的 delivery history，分页游标使用 DSH 的 `before`；
- `c2s.schedule.create`：创建一次性、固定间隔、每日、每周或 Cron 任务；
- `c2s.schedule.update`：更新标题、提醒内容和时间规则；
- `c2s.schedule.delete`：删除任务；
- `s2c.schedule.updated`：推送任务新增/修改/删除后的增量结果。

每个变更请求带 `clientRequestId`。Bridge 使用持久化幂等 journal，避免网络重试重复调用 DSH 的非幂等 `create`/`fork`。

建议新增设备 scope：

```text
schedule.manage
```

权限策略：

- 列表/历史：`sessions.read` + `schedule.manage`；
- 创建/修改/删除：`sessions.manage` + `schedule.manage`；
- 任务只能操作请求中明确给出的 Session；
- subagent、归档会话和未知 Session 默认拒绝；
- `schedule.manage` 不允许读取其他会话的提醒正文。

### 1.4 数据模型和安全边界

手机端只展示任务标题、规则、状态、下一次执行时间和有限历史摘要。提醒 prompt 属于用户内容：

- 不进入 debug 日志；
- 不进入通用 push 标题/正文；
- 不进入 Relay 的通用消息字段；
- 需要显示时只能由已授权的在线手机通过 Bridge 请求取得；
- APNs 最多发送“某会话有提醒任务更新/投递”的通用提示。

DSH 的任务必须保持原始 `sessionId` 绑定。删除任务时接受 DSH 当前语义：删除任务及其保存的 delivery history，但不影响原会话已经排队的消息。

### 1.5 MVP 范围

第一版只实现：

- `after_seconds`；
- `every_seconds`；
- `daily`；
- 列表、创建、修改、删除；
- 最近投递历史；
- 任务变化后的手机端刷新。

`weekly` 和 `cron` 在第二阶段实现，原因是手机端需要时区、DST、weekday 和表达式校验 UI。Host 端仍先保留 DSH 的完整校验。

### 1.6 测试计划

- DSH service 缺失时 capability 降级；
- 空标题、超长标题、非法时区、非法 selector、Every 小于 60 秒；
- 创建成功、重复 `clientRequestId` 不重复创建；
- 修改时使用过期 `expected` 返回 conflict；
- 删除不存在的任务；
- history 游标、1–100 限制和空页；
- 归档会话存在活动提醒时的 `workspace/session-active`；
- APNs generic push 不含提醒正文；
- 断线重连后 snapshot 能恢复任务列表。

---

## 二、从某一轮创建会话分支

### 2.1 用户价值

用户在手机聊天中选中一条消息或一个完整轮次，选择“从这里创建分支”，生成一个新的 DSH Session：

- 原会话完全不变；
- 新会话继承选中位置及之前的上下文；
- 新会话可以立即打开、发送消息或切换模型；
- 适合尝试不同方案、修复失败结果或从某个决策点重新开始。

### 2.2 Host 适配

在 `SessionControllerLike` 增加可选能力：

```ts
fork(request: { sessionId: string; atSeq?: number }): Promise<{ sessionId: string }>
```

`DshApiProxy.sessions.fork` 只暴露稳定 bridge 结构，不把 DSH 的 `SessionAddress` 或 controller 类型传给手机。`atSeq` 必须验证：

- 目标 Session 存在；
- 目标不是 subagent；
- 目标不是归档会话；
- `atSeq` 属于目标会话可见历史；
- 没有 `atSeq` 时由 DSH 选择最新完成轮次；
- DSH 返回的 fork 错误统一映射为稳定的 `E_NOT_FOUND`、`E_INVALID` 或 `E_UNSUPPORTED`。

### 2.3 手机协议草案

请求：

```json
{
  "type": "c2s.session.fork",
  "id": "fork-1",
  "payload": {
    "sessionId": "session-...",
    "atSeq": 42,
    "clientRequestId": "1730000000000-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  }
}
```

响应：

```json
{
  "type": "s2c.session.forked",
  "id": "fork-1",
  "payload": {
    "sourceSessionId": "session-...",
    "sessionId": "new-session-...",
    "atSeq": 42
  }
}
```

Bridge 在成功后：

1. 通过 DSH 返回的新 Session id 触发 `sessions.delta`；
2. 给新会话补齐 `origin/parentSessionId` 等手机显示字段；
3. iOS 收到响应后打开新会话；
4. 失败时不创建本地“假会话”。

### 2.4 幂等和授权

- scope：`sessions.read` + `sessions.manage`；
- `clientRequestId` 写入 prompt delivery 类似的持久化 journal；
- 同一个请求 id 重试只返回第一次创建的新 Session id；
- 不同请求 id 对同一源会话允许创建多个分支；
- 不允许手机指定任意新 Session id；
- 不允许从 subagent 或归档会话分支，除非未来明确设计并测试该策略。

### 2.5 UI 行为

- 消息气泡长按/更多菜单提供“从这里分支”；
- 轮次级操作提供“从本轮结束处分支”；
- 操作前显示源会话和分界点摘要；
- 成功后自动切换到新会话；
- 失败时保留原页面，并显示可重试的非敏感错误；
- 旧客户端忽略未知 capability 和新帧，不影响原有聊天。

### 2.6 测试计划

- 有效 `atSeq` 生成新会话且原会话不变；
- 不带 `atSeq` 时使用 DSH 最新完成轮次；
- 无效 seq、未知 Session、归档 Session、subagent 被拒绝；
- 重复 `clientRequestId` 不产生第二个分支；
- fork 后列表、历史、模型选择和发送 prompt 正常；
- 手机断线重连后能收到新会话 delta；
- DSH fork 错误不会被伪装成成功；
- iOS 旧版本收到 capability=false 时隐藏入口。

---

## 实施顺序建议

1. 先完成 rc.2 依赖升级、lockfile、兼容性测试和配置 schema 检查；
2. 先实现 Schedule 的 Host facade、协议、幂等 journal 和服务端测试；
3. 再实现 Fork 的 Host facade、协议和幂等 journal；
4. 两个能力都完成后，再修改私有 iOS UI；
5. 最后做真实 DSH rc.2 web profile + iPhone 的端到端验证。

不建议先做手机 UI 再补 Host 协议，因为 DSH 的 fork 边界和 schedule update conflict 规则会直接影响协议字段和错误处理。
