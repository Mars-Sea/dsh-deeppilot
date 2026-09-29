# DeepPilot 0.9.0 — DSH 0.2.0-rc.1

## English

DeepPilot now targets **DSH `0.2.0-rc.1`**. The DSH peer and development pins move
from `0.1.7-rc.2` to `0.2.0-rc.1` in both `package.json` and
`package-lock.json`, and the compatibility test now rejects every unaudited host
version, including `0.1.7-rc.2` and a hypothetical `0.2.0` GA.

### Breaking: schedules need the optional Automation tasks bundle

DSH 0.2.0 moved automation out of the shipped Web composition. The
`time-context`, `schedule`, and `ui-schedule` rows are no longer in
`packages/bundle/web-app/cordis.patch.yml`; they are supplied by
`@deepseek-ai/dsh-experimental-schedule-bundle`, which **ships switched off**.

**If you use reminders or scheduled tasks, enable "Automation tasks" in the
DSH plugin manager.** Until you do, `welcome.capabilities.schedules` is `false`
and every schedule request returns the stable `E_UNSUPPORTED`. Nothing is lost
and no re-pairing is required — the tasks stay on the host.

### Fixed: schedules were reported unavailable even with the bundle enabled

The bridge is constructed from `ctx.inject(['sessionController', 'connection',
'typertGateway'])`, and the optional `schedule` service is deliberately not in
that list. The adapter resolved `ctx.get('schedule')` once, in its constructor,
and cached the result. On DSH 0.2.0 those three services become ready before the
Schedule service finishes its own asynchronous initialization, so the cached
value was `undefined` and `capabilities.schedules` stayed `false` for the whole
lifetime of the host.

The service is now resolved lazily on each read and kept once found. With the
bundle enabled, a live 0.2.0-rc.1 host advertises `schedules=true` and the
list / create / delivery-history / delete flow passes end to end. A profile
without the bundle still reports `false` and still degrades to `E_UNSUPPORTED`.
Covered by a new regression test.

### Added: a repeatable live smoke test

`scripts/smoke-live.mts` drives the phone protocol against a real, booted
`dsh web` profile — the seams that unit tests fake out. It covers the LAN TLS
listener, the challenge/prove handshake, session list/create/open/tail, history
paging, the model catalog and a live model switch, workspace
list/create/archive/unarchive, the pending approval/question snapshot, a real
model turn, disconnect/reconnect replay, and the schedule flow.

This run: **25 checks, 0 failures** on DSH `0.2.0-rc.1`. Re-run it after any
future DSH upgrade instead of trusting a source diff alone.

### Not changed

Protocol v2 is unchanged. Already-paired phones need no action, and no pairing
token or device registry migration is involved. The Funnel helpers, the relay
client, push, widgets, and live activities are untouched.

### Verified before publishing

303 unit tests, typecheck, build, a config-schema check against a real
`0.2.0-rc.1` CLI, Go helper tests, helper binary checksums, and the live smoke
test above.

### Known gaps

Approval and question round trips are **not** covered by the live smoke test:
the stock DSH profile auto-approves tool calls, so no `approval/request` is ever
raised. Verifying those paths needs a profile with a restrictive tool policy.

---

## 简体中文

DeepPilot 现已面向 **DSH `0.2.0-rc.1`**。`package.json` 与 `package-lock.json`
中的 DSH peer 与开发依赖固定版本从 `0.1.7-rc.2` 升到 `0.2.0-rc.1`；兼容性测试
现在会拒绝所有未经审计的宿主版本，包括 `0.1.7-rc.2` 和假设中的 `0.2.0` 正式版。

### 破坏性变更：日程功能需要启用可选的 Automation tasks bundle

DSH 0.2.0 把自动化移出了出厂 Web 组合。`time-context`、`schedule`、
`ui-schedule` 三行已不在 `packages/bundle/web-app/cordis.patch.yml` 中，改由
`@deepseek-ai/dsh-experimental-schedule-bundle` 提供，而它**默认关闭**。

**如果你在用提醒或定时任务，请在 DSH 插件管理器中启用「Automation tasks」。**
启用之前，`welcome.capabilities.schedules` 为 `false`，所有日程请求都会返回稳定的
`E_UNSUPPORTED`。任务本身不会丢失，也不需要重新配对——它们仍保存在宿主上。

### 修复：即使启用了 bundle，日程仍被报告为不可用

桥接由 `ctx.inject(['sessionController', 'connection', 'typertGateway'])` 启动，
而可选的 `schedule` 服务是**故意不在**这个列表里的。适配器此前在构造函中一次性解析
`ctx.get('schedule')` 并缓存结果。在 DSH 0.2.0 上，这三个服务就绪时 Schedule 服务
自身的异步初始化尚未完成，于是缓存到 `undefined`，`capabilities.schedules` 在宿主
的整个生命周期里都是 `false`。

现在该服务改为每次读取时惰性解析，拿到后即固定。启用 bundle 后，真实的
0.2.0-rc.1 宿主会通告 `schedules=true`，且列表 / 创建 / 投递历史 / 删除全流程
实测通过。未启用 bundle 的 profile 仍上报 `false` 并仍降级为 `E_UNSUPPORTED`。
本次修复已补回归测试。

### 新增：可重复执行的真实宿主冒烟测试

`scripts/smoke-live.mts` 针对真实启动的 `dsh web` profile 驱动手机协议——也就是
单元测试用假对象替代掉的那几处关键接缝。它覆盖 LAN TLS 监听、challenge/prove
握手、会话列表/创建/打开/尾部、历史分页、模型目录与真实模型切换、工作区
列表/创建/归档/取消归档、待办审批与问答快照、一次真实模型调用、断连重连回放，
以及日程全流程。

本次实测结果：在 DSH `0.2.0-rc.1` 上 **25 项检查、0 项失败**。以后每次 DSH 升级
都可以重跑它，而不是只依赖源码 diff。

### 未变更

协议 v2 没有变化。已配对的手机无需任何操作，也不涉及配对码或设备注册表迁移。
Funnel helper、relay 客户端、推送、桌面小组件与实时活动均未改动。

### 发布前已验证

303 个单元测试、类型检查、构建、针对真实 `0.2.0-rc.1` CLI 的配置 schema 检查、
Go helper 测试、helper 二进制校验和，以及上述真实宿主冒烟测试。

### 已知缺口

真实宿主冒烟测试**未覆盖**审批与问答往返：DSH 出厂 profile 会自动放行工具调用，
因此不会产生 `approval/request`。要验证这两条路径，需要一个配置了严格工具策略的
profile。
