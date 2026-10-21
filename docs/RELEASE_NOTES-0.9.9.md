# DeepPilot 0.9.9 — 连接失败可观测，实时通知新增异常结束与审批详情

## 一、English

1. Connection failures are now observable. Admission refusals, TLS handshake
   failures, close codes 4401/4402/4500 and pairing failures used to leave no
   trace, so a phone could only report "cannot connect". The plugin now records
   structured failure events (throttled to one per 60 seconds per cause, a
   256-entry ring, daily files kept for seven days up to 5 MB), with a
   "Connection diagnostics" group and copy action on the settings page.
   `/phone/health` only gains fields. The wire still answers with a single close
   code; only the local record distinguishes the causes.
2. An optional per-attempt identifier (WebSocket query `at`, HTTP header
   `X-DeepPilot-Attempt`) is accepted and logged so a user can quote one short
   id to find the same attempt on both sides. It is never validated and changes
   no frame, response, or trust decision (`PROTOCOL.md` §2.0).
3. Fixed: the LAN failure log reported port 0, and the status badge stayed on
   "reading status" when both transports were off.
4. Live Activity gains a terminal `failed` phase. A session whose status is
   `error` is projected as `failed` (sent as an `end` event) instead of
   `unavailable`. **Deploy the Relay first, then this plugin:** an older Relay
   rejects `failed`, so only that final update is lost. An App that predates
   `failed` shows an untranslated label and must treat the phase as
   `unavailable`.
5. Approval notifications carry two optional fields, `toolName` (at most 80
   characters) and `detail` (at most 600, the Host's own reason or summary),
   on both `s2c.notify` and the APNs / Relay projection, so the App can show an
   expanded notification view. They are never attached to other categories, and
   `push.contentMode: generic` removes them before either transport. The 120/200
   character `body` limits are unchanged.
6. APNs alert pushes now set `aps.mutable-content: 1` so the App's notification
   service extension can attach a phase thumbnail, and `session.error` uses
   `interruption-level: time-sensitive` like approval and question
   notifications.
7. No protocol version change; all additions are optional and older clients ignore
   them. Run this release against a Relay that already accepts `failed` and the
   new fields.
8. Security: the embedded tunnel helper is rebuilt with Go 1.26.10 for all six
   platforms. Go 1.26.9 is affected by GO-2026-6809 (`crypto/x509` trusting
   compromised intermediate certificates); `govulncheck` showed the helper
   reached it through `http.Server.Serve` → `x509.Certificate.Verify`. The six
   binaries were refreshed by the `build-helpers` workflow and `bin/SHA256SUMS`
   updated; all six report `go1.26.10`. Ten advisories remain in `x/net`,
   `x/crypto` and `x/text` modules the helper requires, which source-mode
   `govulncheck` reports as not called.

## 二、简体中文

1. 连接失败变得可观测。准入拒绝、TLS 握手失败、关闭码 4401 / 4402 / 4500、
   配对失败此前都不留痕迹，手机端只能报「连不上」。现在插件会记录结构化的失败事件
   （同一原因每 60 秒最多记一次，内存环形 256 条，按天落盘保留 7 天、总量上限
   5 MB），设置页新增「连接诊断」分组与复制入口。`/phone/health` 只增加字段；
   线上仍只回一个关闭码，只有本机记录会区分原因。
2. 接收并记录可选的单次尝试标识（WebSocket 的 query `at`、HTTP 头
   `X-DeepPilot-Attempt`），用户只需报一个短号，两端即可对齐同一次尝试。它只记录
   不校验，不改变任何帧、响应或信任判定（见 `PROTOCOL.md` 第 2.0 节）。
3. 修复：局域网失败日志的端口恒为 0；两个传输都关闭时状态徽章卡在「正在读取状态」。
4. 实时活动新增终态 `failed`。会话状态为 `error` 时投影为 `failed`（以 `end` 事件
   下发），而不再是 `unavailable`。**请先更新 Relay，再更新本插件：** 旧 Relay 会
   拒收 `failed`，只会丢失这一条最终更新；不认识 `failed` 的旧 App 会显示未翻译
   文案，应把它当作 `unavailable` 处理。
5. 审批通知新增两个可选字段：`toolName`（最多 80 字符）与 `detail`（最多 600 字符，
   即主机给出的原因或摘要），同时出现在 `s2c.notify` 与 APNs / Relay 投影中，
   供 App 的长按展开页使用。其他类别不会带这两个字段，`push.contentMode: generic`
   会在两条传输之前把它们剔除；`body` 的 120 / 200 字符上限不变。
6. APNs 提醒推送带上 `aps.mutable-content: 1`，让 App 的通知服务扩展可以附阶段
   缩略图；`session.error` 与待批准、待回答一样使用 `interruption-level:
   time-sensitive`。
7. 协议版本不变，所有新增均为可选字段，旧客户端会忽略。请在已支持 `failed` 与新增
   字段的 Relay 上运行本版本。
8. 安全：内嵌的隧道 helper 在六个平台上都用 Go 1.26.10 重新构建。Go 1.26.9 受
   GO-2026-6809（`crypto/x509` 信任被攻破的中间证书）影响，`govulncheck` 显示
   helper 经 `http.Server.Serve` → `x509.Certificate.Verify` 可到达该问题。六个
   二进制由 `build-helpers` 工作流刷新并更新 `bin/SHA256SUMS`，六个均报告
   `go1.26.10`。helper 所需的 `x/net`、`x/crypto`、`x/text` 模块里仍有 10 条公告，
   源码模式的 `govulncheck` 判定代码并不调用。

## 三、本地发布清单（待发布工作树）

在版本号 `0.9.9`、`tests/apply-baseline.snapshot.json`（只改版本字段）与重新生成
的 `lib/` 就绪后执行：`npm ci`、单元测试 600 项（599 通过、0 失败、1 项既有待办）、
类型检查、构建、`check:config-schema`（针对锁定的 `0.2.0-rc.2`）、helper 的 Go 测试、
`bin/SHA256SUMS` 6/6；`npm pack --dry-run` 为 68 个条目。helper 升到 Go 1.26.10 并由
CI 重建六个二进制后，`go test`、`govulncheck ./...`（0 个受影响）与 `SHA256SUMS`
6/6 在刷新后的树上重新通过，发布提交上的 CI 与 CodeQL 均为绿。DSH 兼容声明未变，仍是五个
已审计版本。**本地检查不能证明**：OIDC 发布、来源证明与全新 profile 安装，这些在发布
后核验并记入 `docs/DSH_RELEASE_MEMORY.md`。
