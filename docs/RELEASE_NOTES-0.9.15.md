# DeepPilot 0.9.15 — 计划任务按需完成通知；设置页重排并改用 DSH 内置开关与按钮

## 一、English

1. **Scheduled runs can skip their own "task completed" notification (#35).**
   On hosts with host-level schedules (`welcome.capabilities.schedulesHost`,
   DSH `0.2.2-alpha.3` and later) the plugin registers an agent tool,
   `deeppilot_skip_completion_notice` (parameter `reason`, 1–200 characters).
   Write the rule into the task prompt, for example "check the services; if
   everything is fine, don't notify me". When a scheduled run's agent calls the
   tool and the turn ends successfully, the plugin sends neither `s2c.notify`
   nor APNs for that turn. Approvals, questions, errors and interrupted turns
   still notify; tasks whose prompt has no such rule notify every run as
   before. The timeline still records the turn and shows the tool call with
   its `reason`; Live Activity and widgets are unchanged.
2. **How a turn counts as scheduled.** The plugin reads the host inbox events
   synchronously: the turn must have started from a `next-turn` item whose
   source is `schedule`. A schedule change notice (`next-step`) does not
   count, and a user message queued after the delivery or sent mid-turn
   cancels the request. If the event shape is not recognised the plugin falls
   back to notifying, never to silence.
3. **The tool appears only in scheduled sessions.** Its visibility is sticky
   per session (a session joins on its first scheduled turn, and the set is
   rebuilt from the host task list at start-up), so it does not flip on and
   off between turns and does not repeatedly invalidate the prompt cache.
   Ordinary sessions never see it. On `0.2.1` hosts, where `tools.register`
   has no `when` option, the tool is not registered at all.
4. **Settings page reorganised.** The header shows the purpose and a refresh
   action; one connection card combines service state, live connection count
   and the master switch, followed by LAN and remote rows. The paired-device
   list shows name, App version and last seen; fingerprint, rename and delete
   moved into each row's "More actions" (delete keeps its inline
   confirmation). "Add phone" generates pairing data on demand; switching
   address keeps the panel open and issues a new code, and an expired code is
   removed. Connection options, remote help, diagnostics and system info are
   collapsed by default with native `hidden`, so they leave the focus and
   reading order while drafts are kept.
5. **Native DSH controls.** The four switches (allow connections, LAN, remote,
   debug log) use the host `Switch`, and "Add phone" uses the host `Button`
   (`outline`, `sm`) from `@deepseek-ai/dsh-client-ui-primitives`, which both
   the compatibility floor `0.2.1-rc.5` and `0.2.2-rc.1` provide. The
   production bundle keeps the host-module reference; no runtime dependency is
   added. Body text is 14px, secondary text at least 12px, icons are
   monochrome line SVGs, errors show a Chinese conclusion with the original
   code in parentheses.
6. No bridge protocol change (still v2), no config field or default change, no
   Funnel helper change; the DSH compatibility range stays
   `>=0.2.1-rc.5 <0.3.0-0`.

## 二、简体中文

1. **计划任务可以跳过本轮的「任务完成」通知（#35）。** 在支持宿主级计划任务的宿主上
   （`welcome.capabilities.schedulesHost`，DSH `0.2.2-alpha.3` 起），插件注册 Agent
   工具 `deeppilot_skip_completion_notice`（参数 `reason`，1–200 字符）。在任务
   提示词里写明规则，例如"检查服务状态；全部正常就不用提醒我"。计划任务轮次中 Agent
   调用该工具且本轮成功结束时，插件不发 `s2c.notify`，也不推 APNs。审批、提问、出错
   和中断照常提醒；提示词里没写规则的任务仍每轮提醒。时间线照常记录该轮，并显示工具
   调用及其 `reason`；Live Activity 与小组件不受影响。
2. **怎样算计划任务轮次。** 插件同步读取宿主 inbox 事件：本轮必须由来源为 `schedule`
   的 `next-turn` 条目开启。任务变更提示（`next-step`）不算；投递之后排队的用户消息
   或本轮中途插话会撤销静默。事件形状无法识别时退回照常提醒，不会误静默。
3. **工具只在计划任务会话中出现。** 可见性按会话粘性保留（会话首次出现计划任务轮次即
   加入，启动时按宿主任务列表重建），不会按轮反复出现、消失，避免反复让提示词缓存失效。
   普通会话看不到这个工具。`0.2.1` 宿主的 `tools.register` 没有 `when` 参数，
   此时不注册该工具。
4. **设置页重排。** 页头显示用途与刷新；连接卡片合并服务状态、当前连接数和总开关，
   下面是局域网与远程连接行。已配对设备列表显示名称、App 版本和最近在线；指纹、重命名
   和删除移到各行的"更多操作"，删除仍需行内二次确认。"添加手机"按需生成配对信息；切换
   地址时面板保持展开并重新生成，过期后移除二维码。连接选项、远程帮助、诊断工具和系统
   信息默认收起（原生 `hidden`），退出焦点与读屏顺序，草稿保留。
5. **改用 DSH 内置控件。** 四个开关（允许手机连接、局域网、远程连接、调试日志）使用宿主
   `Switch`，"添加手机"使用宿主 `Button`（`outline` 描边、`sm` 小号），来自
   `@deepseek-ai/dsh-client-ui-primitives`；兼容下界 `0.2.1-rc.5` 与 `0.2.2-rc.1`
   均提供。正式产物保留宿主模块引用，不新增运行依赖。正文 14px、辅助文字不小于
   12px，图标为线性单色 SVG，报错先给中文结论、原始错误码放在括号内。
6. 桥接协议不变（仍为 v2），配置字段与默认值不变，Funnel helper 不变；DSH 兼容区间
   仍为 `>=0.2.1-rc.5 <0.3.0-0`。

**验证：** `npm test` 723 项（721 通过、1 项环境门禁跳过、1 项有意 TODO、0 失败）；
`typecheck`；`build`（`lib/` 无漂移）；浏览器 E2E（端到端测试）22 项通过；
`check:config-schema`；`smoke:helper`；`go test ./...`；`bin/SHA256SUMS` 6/6；
六平台 helper 重建无漂移。DSH `0.2.2-rc.1` 隔离环境实机验证：固定模型 6/6、
`deepseek-flash` 真实模型 6/6（规则判定无需提醒时静默，有异常或未写规则时照常通知）；
设置页在真实 rc.1 宿主上核对了内置开关与按钮的样式。**未覆盖：** 真机 APNs、
其他模型对工具说明的遵循度。
