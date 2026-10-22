# DeepPilot 0.9.10 — 通知正文纯文本化，Funnel helper 升级 Tailscale 1.104.2 与 Go 1.27.3

## 一、English

1. Fixed: a "task completed" notification could show unreadable text such as
   `code-provider/docs/%E6%8F%90…md#L7))。`. The plugin used to quote the last
   160 characters of the assistant's raw Markdown reply, which cut straight
   through a trailing file link. Notification bodies are now converted to plain
   text before either transport: links keep only their label, code blocks and
   images are dropped, heading / list / quote / emphasis markers are removed and
   leftover URL-encoded runs are decoded. `turn.completed` and `session.error`
   quote the last non-empty paragraph of the reply (falling back to the session
   title when nothing readable is left); approval and question notifications
   join their text into one line. The 120-character `body` limit is unchanged,
   and the approval `detail` field still carries the Host's original text.
   `PROTOCOL.md` §6 now states that `body` is plain text; no field changed.
2. The embedded Funnel helper is built with `tailscale.com` 1.104.2 (from
   1.102.3), Go 1.27.3 and `golang.org/x/net` v0.61.0. Tailscale 1.104 requires
   Go 1.27.1 or later, and Go 1.27.1 with `x/net` v0.59.0 left 12 reachable
   advisories (GO-2026-6809 among them); with Go 1.27.3 and `x/net` v0.61.0,
   source-mode `govulncheck` reports 0 affecting the helper. The six binaries
   were rebuilt by the `build-helpers` workflow and `bin/SHA256SUMS` updated.
3. **Funnel now requires macOS 13 Ventura or later.** Go 1.27 dropped macOS 12,
   so on macOS 12 and earlier the helper cannot start and Funnel mode is
   unavailable; trusted-LAN mode keeps working. Linux and Windows on amd64 /
   arm64 are unaffected.
4. No protocol version change and no DSH compatibility change; the declaration
   still names the same five audited releases.

## 二、简体中文

1. 修复：「任务完成」通知可能显示 `code-provider/docs/%E6%8F%90…md#L7))。` 这类
   看不懂的内容。插件原先截取助手回复原始 Markdown 的最后 160 个字符，回复以文件
   链接结尾时正好从链接地址中间切开。现在通知正文在两条传输之前统一转成纯文本：
   链接只留文字，丢弃代码块与图片，去掉标题、列表、引用、强调等标记，并解码残留
   的 URL 编码。`turn.completed`（任务完成）与 `session.error`（任务异常结束）取
   回复最后一个非空段落，清洗后为空时退回会话标题；审批与提问通知把原文合成一行。
   `body` 的 120 字符上限不变，审批的 `detail` 字段仍保留主机原文。`PROTOCOL.md`
   第 6 节写明 `body` 为纯文本，没有字段变化。
2. 内嵌的 Funnel helper 改用 `tailscale.com` 1.104.2（原 1.102.3）、Go 1.27.3 与
   `golang.org/x/net` v0.61.0 构建。Tailscale 1.104 要求 Go ≥ 1.27.1，而 Go 1.27.1
   搭配 `x/net` v0.59.0 有 12 个可达漏洞（含 GO-2026-6809）；改用 Go 1.27.3 与
   `x/net` v0.61.0 后，源码模式的 `govulncheck` 报告影响 helper 的漏洞为 0。六个
   二进制由 `build-helpers` 工作流重建并更新 `bin/SHA256SUMS`。
3. **Funnel 模式现在要求 macOS 13 Ventura 或更高版本。** Go 1.27 不再支持
   macOS 12，macOS 12 及更早版本上 helper 无法启动、Funnel 模式不可用；可信局域网
   模式不受影响。Linux 与 Windows 的 amd64 / arm64 不受影响。
4. 协议版本不变，DSH 兼容声明不变，仍是同样五个已审计版本。

## 三、本地发布清单（待发布工作树）

在版本号 `0.9.10`、`tests/apply-baseline.snapshot.json`（只改版本字段）与重新生成
的 `lib/` 就绪后执行：`npm ci`、单元测试 610 项（609 通过、0 失败、1 项既有待办）、
类型检查、构建、`check:config-schema`（针对锁定的 `0.2.0-rc.2`）、`smoke:helper`
（darwin-arm64）、helper 的 Go 测试、`bin/SHA256SUMS` 6/6；本机用 Go 1.27.3 重编
六平台 helper 后 `bin/` 无差异，六个二进制均报告 `go1.27.3` 与 `tailscale.com
v1.104.2`；`govulncheck ./...` 影响 helper 的漏洞为 0；`npm pack --dry-run` 为 68 个
条目。DSH 兼容声明未变。**本地检查不能证明**：OIDC 发布、来源证明、全新 profile
安装与 macOS 13 上的 Funnel 实际启动，这些在发布后核验并记入
`docs/DSH_RELEASE_MEMORY.md`。
