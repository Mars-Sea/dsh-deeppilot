# DeepPilot 0.9.13 — 支持 DSH 0.2.1-rc.4 与 0.2.2-alpha.2，新增运行中排队 / 转向、Markdown 导出、实时流式输出、插件自更新与设置页重设计

## 一、English

1. **Two new DSH hosts are admitted, and the declaration now names eight exact
   releases.** `0.2.1-rc.4` (the `next` channel) and `0.2.2-alpha.2` (the
   `alpha` channel) join the whitelist. `engines.dsh` and all ten
   `@deepseek-ai/dsh*` peers enumerate the same eight exact versions —
   `0.2.0-rc.2`, `0.2.1-alpha.3`, `0.2.1-alpha.4`, `0.2.1-alpha.5`,
   `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4`, and `0.2.2-alpha.2` — with no `>=`
   range. The vendor peers append `cordis ~4.0.6-alpha.1` and
   `schemastery ~3.18.6-alpha.1` instead of replacing the GA clauses, because
   only the newest host vendors those prereleases while every earlier admitted
   host still ships `4.0.5` / `3.18.5`.
2. **The only runtime break in `0.2.2-alpha.2` is the removed
   `SessionController.inspect`, and history pagination now branches on that
   capability.** When `inspect` exists the previous whole-log window is kept;
   when it is missing, the bridge reads `page` and translates the phone's
   exclusive `beforeSeq` into the inclusive `throughSeq` (`beforeSeq - 1`, with
   `-1` as the host's empty page), unwrapping the host's
   `{type:'event',event}` records into the bridge's `{event}` contract. A
   unified `page` path was rejected because `SessionPageRequest.throughSeq` is
   mandatory and validated on seven of the eight admitted hosts, so it would
   have broken every host below `0.2.2-alpha.2`. Both new hosts were verified on
   isolated installations: each composes the plugin, starts it, and answers
   `/phone/health` with HTTP 200 (`0.2.2-alpha.2`: 32/32 checks, including the
   three optional capabilities below; `0.2.1-rc.4`: 27/27 checks).
3. **Running-turn queueing and steering (optional v2 capability
   `promptQueue`).** `c2s.session.sendPrompt` gains `mode: "queue" | "steer"`;
   the bridge pushes a whole-table `s2c.session.queue` snapshot and accepts
   `c2s.session.queue.update` under `prompt.send`, returning
   `E_STEER_UNAVAILABLE` when a queued item can no longer steer into the
   running turn. The capability is advertised only when the host provides
   `session.updateQueue` and the `inbox` projection; old phones ignore it and
   keep the previous behaviour, and subagent sessions never expose a queue.
4. **Three optional capabilities land together: Markdown export, live streaming
   deltas, and plugin self-update.**
   - **`sessionMarkdown`** — `c2s.session.export` accepts `format: "markdown"`
     and reuses the existing export chunking against the host's
     `GET /api/session.markdown`. With the capability absent, the ZIP URL,
     chunks, and receipt stay byte-for-byte unchanged; old bridges ignore the
     unknown field, so clients must read the capability bit first.
   - **`assistantStream`** — a separate `s2c.session.delta` frame
     (`stream.start` / `message.delta` / `thinking.delta` / `stream.end`)
     carries incremental output. It occupies no replay seq, is not persisted,
     and is never replayed after reconnect; the committed `message.final` links
     to it through `streamId`, and an abandoned attempt must clear its temporary
     row. Only final without deltas (old host, or a session already running when
     opened) is normal.
   - **`pluginUpdate`** — `c2s.plugin.update.check` / `apply` plus
     `s2c.plugin.update.status` / `progress`. Before accepting an update the
     bridge verifies that the target version exists on npm, is compatible with
     the running DSH, and declares the same integer protocol version; a strong
     SRI digest must agree across every candidate registry source, and partial
     updates are refused. A durable journal survives the HMR unload, and a
     reconnect distinguishes "still running" from "failed" instead of treating
     the disconnected socket as a failure.
5. **The settings page is redesigned in task order.** Header → status strip →
   pairing hero → connection → devices → collapsed troubleshooting → collapsed
   system information → diagnostics only when present. Pairing shows the QR
   code, the copyable pairing-info string, the hint, and a live countdown
   together; the two channels become full-width rows with expandable options
   (LAN port editor and TLS fingerprint; remote per-source limit plus the
   existing remote help verbatim); devices become one row each with inline
   rename and an in-page confirm; collapsed sections show their conclusion in
   the header. Every existing field and behaviour is preserved, including the
   `directory-picker` patch and the locale keys pinned by the surface snapshot
   (only four new keys, for short channel states). System information also shows
   the Tailscale version reported by the embedded helper.
6. **Compatibility surface unchanged, helper refreshed.** The bridge protocol
   stays v2; every addition above is optional and capability-gated, so older
   phones and older bridges keep working. No configuration field was added or
   removed. The Funnel helper changed: it now reports the `tailscale.com` module
   version compiled into the running binary (read from Go build info, not
   `go.mod`, because release builds pass `-buildvcs=false`), and the
   six-platform `bin/` matrix was rebuilt with matching `SHA256SUMS`.

**Verification:** `npm ci`; `npm test` 679 tests (677 pass, 1 environment-gated
skip, 1 intentional TODO, 0 fail); `typecheck`; `build` (committed `lib/`
unchanged); `check:config-schema` against the `0.2.0-rc.2` CLI; `smoke:helper`
on darwin-arm64; `go test ./...`; `bin/SHA256SUMS` verified; rebuilding the
six-platform matrix leaves `bin/` untouched; `npm pack --dry-run --json`
inspected. Not covered: no real iPhone, no Funnel end-to-end, no real npm
install through `updateBundle`/HMR rollback.

## 二、简体中文

1. **放行两个新的 DSH 宿主，声明现在精确列出八个版本。** `0.2.1-rc.4`（`next`
   通道）与 `0.2.2-alpha.2`（`alpha` 通道）加入白名单；`engines.dsh` 与全部十条
   `@deepseek-ai/dsh*` peer 枚举同样的八个精确版本——`0.2.0-rc.2`、
   `0.2.1-alpha.3`、`0.2.1-alpha.4`、`0.2.1-alpha.5`、`0.2.1-rc.2`、
   `0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.2-alpha.2`——不使用 `>=` 范围。vendor peer
   追加 `cordis ~4.0.6-alpha.1` 与 `schemastery ~3.18.6-alpha.1` 而不替换 GA
   子句：只有最新宿主 vendored 这两个预发布版，更早的已放行宿主仍用
   `4.0.5` / `3.18.5`。
2. **`0.2.2-alpha.2` 唯一的运行时破坏面是移除 `SessionController.inspect`，历史
   分页改为按能力分支。** 存在 `inspect` 时沿用原来的全量日志窗口；缺失时改用
   `page`，把手机的排他 `beforeSeq` 表达成包含式 `throughSeq`（`beforeSeq - 1`，
   `-1` 即宿主的空页），并把宿主的 `{type:'event',event}` 记录解包成桥的
   `{event}`。没有采用统一 `page` 路径：`SessionPageRequest.throughSeq` 在八个
   已放行宿主中的七个必填且运行时校验，统一路径会破坏 `0.2.2-alpha.2` 以下的
   所有版本。两个新宿主都在隔离环境实测：插件成功组合、启动，并让
   `/phone/health` 返回 HTTP 200（`0.2.2-alpha.2` 32/32 项，含下面三个可选能力；
   `0.2.1-rc.4` 27/27 项）。
3. **运行中排队与转向（可选 v2 能力 `promptQueue`）。** `c2s.session.sendPrompt`
   新增 `mode: "queue" | "steer"`；桥推送整表 `s2c.session.queue` 快照，并在
   `prompt.send` 下接受 `c2s.session.queue.update`，排队项无法再转向当前轮时返回
   `E_STEER_UNAVAILABLE`。只有宿主同时提供 `session.updateQueue` 与 `inbox`
   投影时才宣告该能力；旧手机忽略它、保持原有行为，子代理会话不提供队列。
4. **三个可选能力一并落地：Markdown 导出、实时流式增量与插件自更新。**
   - **`sessionMarkdown`** —— `c2s.session.export` 接受 `format: "markdown"`，
   复用现有导出分块，读取宿主的 `GET /api/session.markdown`。能力缺失时 ZIP 的
   URL、分块与回执逐字节不变；旧桥会忽略未知字段，所以客户端必须先读能力位。
   - **`assistantStream`** —— 独立的 `s2c.session.delta` 帧（`stream.start` /
   `message.delta` / `thinking.delta` / `stream.end`）承载增量输出。它不占重放
   序号、不持久化、断线不补发；正式 `message.final` 以 `streamId` 关联，弃置的
   尝试必须清理临时行。只有 final 没有 delta（旧宿主，或打开会话时已在运行）是
   正常情况。
   - **`pluginUpdate`** —— `c2s.plugin.update.check` / `apply` 与
   `s2c.plugin.update.status` / `progress`。接受更新前，桥核对目标版本存在于
   npm、与当前运行的 DSH 兼容、且声明的插件协议版本等于当前整数版本；每个候选
   软件源的精确包名/版本/协议与强 SRI 摘要必须一致，任一不满足即拒绝，不做部分
   更新。耐久更新日志能在 HMR 卸载后存活，重连时区分「仍在更新」与「失败」，
   不把断线直接当成失败。
5. **设置页按任务顺序重设计。** 页头 → 状态总览条 → 扫码添加 → 连接 → 设备 →
   折叠的测试与故障排查 → 折叠的系统信息 → 有内容时才出现的技术诊断。配对把
   二维码、可复制的配对信息、提示与实时倒计时放在一起；两条通道改成全宽行并
   带可展开选项（局域网端口编辑与证书指纹；远程每来源上限与完整远程帮助原文）；
   设备改为每台一行，重命名与删除确认都在页内完成；折叠区在标题栏直接给结论。
   所有原有字段与行为保留，包括 `directory-picker` 补丁与表面快照钉住的全部文案
   键（只新增四个短状态文案键）。系统信息同时显示内嵌 helper 上报的 Tailscale
   版本。
6. **兼容面不变，helper 刷新。** 桥接协议仍为 v2；上述新增全部可选且受能力位
   控制，旧手机与旧桥继续工作。没有新增或删除配置字段。Funnel helper 有改动：
   现在上报编译进运行中二进制的 `tailscale.com` 模块版本（读取 Go 构建信息，
   不用 `go.mod`，因为发布构建带 `-buildvcs=false`），并重建六平台 `bin/` 矩阵、
   刷新 `SHA256SUMS`。

**验证：** `npm ci`；`npm test` 679 项（677 通过、1 项环境门禁跳过、1 项有意
TODO、0 失败）；`typecheck`；`build`（已提交的 `lib/` 无变化）；
`check:config-schema`（针对 `0.2.0-rc.2` CLI）；`smoke:helper`（darwin-arm64）；
`go test ./...`；`bin/SHA256SUMS` 校验通过；重建六平台矩阵后 `bin/` 无漂移；
`npm pack --dry-run --json` 条目已核对。**未覆盖：** 真机、Funnel 端到端、
经 `updateBundle`/HMR 回滚的真实 npm 安装。

## 三、本地发布清单（待发布工作树）

在版本号 `0.9.13`、`tests/apply-baseline.snapshot.json`（只改 6 处版本字段）与
重新生成的 `lib/` 就绪后执行：`npm ci`、`npm test`、类型检查、构建、
`check:config-schema`（针对锁定的 `0.2.0-rc.2` CLI）、`smoke:helper`
（darwin-arm64）、`go test ./...`、`bin/SHA256SUMS` 校验、六平台 helper 重建与
`bin/` 漂移检查，以及 `npm pack --dry-run --json` 的条目核对。

**本地检查不能证明**：OIDC 可信发布、来源证明、全新 profile 从 npm 安装、
`latest` 分发标签的实际指向，以及两个新宿主上的真实业务回合。这些在发布后
核验，并记入 `docs/NPM_PUBLISHING.md` 与 `docs/DSH_RELEASE_MEMORY.md`。
