# DeepPilot 0.9.4 — DSH 0.2.1-alpha.2 compatibility fix

## English

One compatibility fix, plus the documentation correction that belongs with it.
**The phone protocol is unchanged**: no frame type was added or removed, the
protocol version stays at **2**, and already-paired phones need no re-pairing.

### Fixed: the session projection baseline was lost on DSH 0.2.1-alpha.2

DSH 0.2.1-alpha.2 made the cancellation signal mandatory for
`SessionController.projections`. The published implementation calls
`signal.throwIfAborted()` as the first statement of its `try` and reads
`signal.aborted` in its `catch`, and the published declaration marks the
parameter required — but the adapter called that method with no signal, so the
projection baseline read raised a `TypeError` that the adapter reported as an
`internal` failure.

What that looked like from a phone: opening a session still returned history, and
title, todo counts and token usage still arrived from the session list rows'
cached projections and from live `session/projection` frames, so nothing failed
outright. What never happened was the on-open refresh of those values, and the
host logged `[deeppilot] sessions.projections failed: internal` on every open.

`src/dsh-api-proxy.ts` now passes a signal, matching how `list` and `prompt`
already call the controller, and the hand-written controller mirror declares
`signal` required so the compiler keeps it that way. The regression test in
`tests/dsh-api-proxy.test.ts` reproduces the Host's new behaviour — the stub
aborts before it returns anything — and fails against the previous call form.

### Documentation: the "Automation tasks" instruction is gone

DSH 0.2.0 briefly moved automation into the optional
`@deepseek-ai/dsh-experimental-schedule-bundle`; the release after it retired
that bundle again, and `@deepseek-ai/dsh-web-app` now mounts `schedule` and
`ui-schedule` in every Web profile. `COMPATIBILITY.md`, `PROTOCOL.md`, and
`docs/DEEPPILOT_FEATURE_PLAN.md` no longer tell users to enable something that
does not exist any more. Plugin behaviour is unchanged: it still resolves the
service through `ctx.get('schedule')`, never declares `schedule` in `inject`,
and still reports `welcome.capabilities.schedules = false` with `E_UNSUPPORTED`
when a profile does not mount it.

### Not changed

Protocol v2 is unchanged and already-paired phones need no action. The Funnel
helpers, relay client, push, widgets, live activities, workspace and schedule
RPCs, and the resident approval/question client are untouched, as is the
directory-picker patch layer.

### Verified before publishing

`npm ci`, unit tests (538 passing, including the new regression test), TypeScript
typecheck, production build, the config-schema check against a real
`0.2.0-rc.2` CLI, Go helper tests, and the helper binary checksums all pass
locally; the helper binaries themselves are unchanged. `npm pack --dry-run`
reports 65 files at `0.9.4`, and `lib/` regenerates with no further diff after
the build.

The fix was confirmed on a real host as well. An isolated profile booted by the
published `0.2.1-alpha.2` CLI ran the phone-protocol checklist end to end: 25
pass, 0 fail, 3 skipped (health, TLS SPKI, pairing rejection, WSS upgrade,
challenge/prove with all six scopes, session and workspace RPCs,
archive/unarchive, the schedule create/history/delete flow, and reconnect
replay). The same checklist against the published `0.9.3` on the same host
version passed every step too — but its host log carried
`[deeppilot] sessions.projections failed: internal`, while this build's log
carried none. That is the degradation this release removes, and it is why the
bug needed the log rather than a failing request to notice.

---

## 简体中文

一个兼容性修复，外加与它配套的文档纠正。**手机协议未变**：没有新增或移除任何
帧类型，协议版本仍为 **2**，已配对的手机无需重新配对。

### 修复：在 DSH 0.2.1-alpha.2 上会话投影基线丢失

DSH 0.2.1-alpha.2 把 `SessionController.projections` 的取消信号改成了必填。发布
实现会在 `try` 的第一句调用 `signal.throwIfAborted()`、并在 `catch` 里读
`signal.aborted`，发布声明也把该参数标为必填；而适配器调用这个方法时没有传信号，
于是投影基线读取抛出 `TypeError`，被适配器归类成 `internal` 失败。

手机上看到的现象：打开会话仍能拿到历史，标题、todo 数与 token 用量也仍能从会话
列表行的缓存投影和实时 `session/projection` 帧拿到，所以不会直接报错；真正没发生
的是「打开会话时的那次刷新」，并且宿主每次打开都会记录
`[deeppilot] sessions.projections failed: internal`。

`src/dsh-api-proxy.ts` 现在会传信号，与同文件里 `list`、`prompt` 的既有写法一致；
手写的控制器镜像把 `signal` 标为必填，让编译器持续守住这一点。
`tests/dsh-api-proxy.test.ts` 里的回归测试复刻了宿主的新行为（桩在返回前先 abort），
在旧写法下会失败。

### 文档：不再让人去开「自动化任务」

DSH 0.2.0 曾把自动化移入可选 bundle
`@deepseek-ai/dsh-experimental-schedule-bundle`；紧接着的版本又把该 bundle 退役，
`@deepseek-ai/dsh-web-app` 现在在每个 Web profile 中挂载 `schedule` 与
`ui-schedule`。`COMPATIBILITY.md`、`PROTOCOL.md`、`docs/DEEPPILOT_FEATURE_PLAN.md`
不再指导用户去启用一个已经不存在的开关。插件行为未变：它仍然通过
`ctx.get('schedule')` 惰性解析服务、仍然不把 `schedule` 放进 `inject`，profile 未
挂载时依旧返回 `welcome.capabilities.schedules = false` 与 `E_UNSUPPORTED`。

### 未变更

协议 v2 没有变化，已配对的手机无需任何操作。Funnel helper、relay 客户端、推送、
桌面小组件、实时活动、工作区与定时任务 RPC、常驻审批/提问客户端均未改动，目录选择
器的补丁层也未改动。

### 发布前已验证

`npm ci`、单元测试（538 例通过，含新增回归测试）、TypeScript 类型检查、生产构建、
针对真实 `0.2.0-rc.2` CLI 的 config schema 检查、Go helper 测试与 helper 二进制
校验和，均已本地通过；helper 二进制本身没有改动。`npm pack --dry-run` 在 `0.9.4`
下报告 65 个文件，构建后 `lib/` 重新生成无进一步差异。

修复也在真实宿主上确认过：一个隔离 profile 由发布的 `0.2.1-alpha.2` CLI 启动，跑完
整套手机协议清单——25 通过 / 0 失败 / 3 跳过（健康检查、TLS SPKI、无效配对码拒绝、
WSS 升级、六项 scope 的挑战签名握手、会话与工作区 RPC、归档/恢复、日程的
创建/历史/删除、断线重连重放）。同一套清单在**同一宿主版本**上跑发布的 `0.9.3` 时
同样每一步都通过，但它的宿主日志里带着
`[deeppilot] sessions.projections failed: internal`，而本版本的日志里一条都没有。
这正是本版本消除的隐性降级，也是为什么这个缺陷必须看日志、而不是靠失败请求才能发现。
