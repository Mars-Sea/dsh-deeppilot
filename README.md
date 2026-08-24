# DeepPilot for DSH

[![Public Beta](https://img.shields.io/badge/status-public_beta-f59e0b)](https://github.com/Mars-Sea/dsh-deeppilot/releases)
[![CI](https://github.com/Mars-Sea/dsh-deeppilot/actions/workflows/ci.yml/badge.svg)](https://github.com/Mars-Sea/dsh-deeppilot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Use DeepSeek Harness from a native iPhone app.** `dsh-deeppilot` is the
open-source companion plugin for DeepPilot. It connects the iOS app directly
to the DSH Host running on your own Mac, without modifying the DSH Web UI.

Simplified Chinese documentation is available [below](#中文说明).

> Public beta: the plugin is ready for source-based testing. A public
> TestFlight/App Store link for DeepPilot will be added here when distribution
> opens.

## What it does

- View projects, sessions, conversation history, and live agent output.
- Send prompts, switch models, and manage sessions from iPhone.
- Approve or reject tool requests and answer agent questions remotely.
- Reconnect with per-device replay instead of silently dropping events.
- Pair with a versioned QR code; secrets stay on the Mac and in iOS Keychain.
- Connect over a trusted LAN or the optional embedded Tailscale Funnel helper.
- Receive local notifications while connected and optional APNs notifications
  while the app is suspended.

## Install from GitHub

Requirements:

- Node.js 22 or newer
- a DSH `web` profile
- macOS on Apple silicon for the bundled remote Funnel helper

```bash
npx @deepseek-ai/dsh plugin --profile web add github:Mars-Sea/dsh-deeppilot
```

Restart DSH after installation:

```bash
npx @deepseek-ai/dsh web
```

Open **DeepPilot** in the DSH settings sidebar, enable the connection, then
display the pairing QR code. Scan it from the DeepPilot iOS app.

To update or remove the GitHub installation:

```bash
npx @deepseek-ai/dsh plugin --profile web update dsh-deeppilot
npx @deepseek-ai/dsh plugin --profile web remove dsh-deeppilot
```

The npm name `dsh-deeppilot` is reserved for a later release. No npm package
is required for this public-beta installation.

## Connection modes

### Trusted LAN

The plugin reuses the DSH web server and adds only `/phone` and
`/phone/health`. It does not open another LAN port. Your DSH host must already
be reachable from the iPhone, and LAN `ws://` traffic is unencrypted; use it
only on a network you trust.

### Tailscale Funnel

Remote mode is off by default. When enabled, the bundled `tsnet` helper exposes
only `/phone` and `/phone/health` over HTTPS/WSS. It does not expose the full
DSH Web UI and does not require a tailnet API key. The first setup requires a
one-time authorization on Tailscale's official page.

The public beta currently bundles only `darwin-arm64/dsh-pocket-tunnel`.
Intel macOS is not yet supported by the embedded helper. LAN mode remains
available when the helper is missing or remote mode is disabled.

## Notifications and data flow

Normal conversation traffic goes directly between the iPhone and the user's
own DSH Host. It is not proxied through a DeepPilot application server.

Offline push has two optional modes:

- `apns`: the user's Mac signs and sends notifications directly to Apple using
  credentials supplied by that user.
- `relay`: for the distributed DeepPilot app, the plugin sends the target APNs
  device token plus a limited notification projection to the operator's relay.
  That projection can include category, session identifier, title, and a short
  notification body. Full conversation history and live traffic do not pass
  through the relay.

See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md) before enabling
remote access or push notifications.

## Compatibility

See [COMPATIBILITY.md](COMPATIBILITY.md) for the tested baseline and evidence
limits. DSH is currently a developer preview and can introduce breaking
changes; pin a working DSH/plugin combination before relying on it.

## Development

```bash
npm ci
npm test
npm run typecheck
npm run build
```

The optional tunnel helper is built separately:

```bash
npm run build:helper
cd helper && go test ./...
```

`lib/` is generated and committed so GitHub installs do not need to execute a
package lifecycle script. CI rebuilds it and rejects stale generated output.
The prebuilt helper checksum is in `bin/SHA256SUMS`.

## Status and support

This is an independent third-party project and is not affiliated with or
endorsed by DeepSeek. Report reproducible plugin issues in
[GitHub Issues](https://github.com/Mars-Sea/dsh-deeppilot/issues).

---

## 中文说明

`dsh-deeppilot` 是 DeepPilot iOS App 的开源配套插件，让 iPhone 直接连接运行在
用户自己 Mac 上的 DeepSeek Harness。它不会修改 DSH Web UI，也不会把完整会话
流量转发到 DeepPilot 的应用服务器。

目前为 Public Beta。DeepPilot 的公开 TestFlight/App Store 下载地址开放后会添加
到本页。

### 功能

- 在 iPhone 查看项目、会话历史和实时输出；
- 发送消息、切换模型、创建及管理会话；
- 处理工具审批和 Agent 提问；
- 按设备断线重放；
- 通过局域网或可选的内嵌 Tailscale Funnel 远程连接；
- 在线本地通知，以及可选的离线 APNs 推送。

### 从 GitHub 安装

```bash
npx @deepseek-ai/dsh plugin --profile web add github:Mars-Sea/dsh-deeppilot
npx @deepseek-ai/dsh web
```

重启后在 DSH 左侧设置中打开 **DeepPilot**，开启连接并显示二维码，然后使用
DeepPilot iOS App 扫码配对。

远程模式默认关闭。目前内嵌的 Funnel helper 只支持 Apple silicon Mac；Intel
Mac 暂时只能使用局域网模式或自行指定兼容 helper。局域网 `ws://` 是明文连接，
只应在可信网络中使用。

通知中继只用于 App Store/TestFlight 分发版的离线推送。中继会看到目标设备
Token、通知类别、会话标识、标题和经过截断的通知正文；完整会话历史与实时输出
仍然由 iPhone 直接连接用户自己的 Mac。详细边界见 [PRIVACY.md](PRIVACY.md)。

本项目是 DeepSeek Harness 的独立第三方插件，与 DeepSeek 官方无隶属或背书关系。
