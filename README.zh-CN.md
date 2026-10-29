# dsh-deeppilot

[English](./README.md) | **简体中文**

[![npm](https://img.shields.io/npm/v/dsh-deeppilot?style=flat-square)](https://www.npmjs.com/package/dsh-deeppilot)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4D6BFE?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![CI](https://github.com/Mars-Sea/dsh-deeppilot/actions/workflows/ci.yml/badge.svg)](https://github.com/Mars-Sea/dsh-deeppilot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**DeepPilot** 的开源 DSH 配套插件。DeepPilot 是一款原生 iPhone 客户端，
可远程使用 DeepSeek Harness；插件让 App 直接连接用户自己电脑上的 DSH Host，
不会替换或修改 DSH Web UI。

> DeepPilot 目前正在等待 TestFlight 审核。Apple 审核通过后，邀请链接即可加入测试。

[加入 DeepPilot TestFlight](https://testflight.apple.com/join/JHb4j5DV)

## 功能

- 在 iPhone 查看项目、会话、历史记录和 Agent 实时输出；
- 打开会话时实时显示助手正文与思考，断线后以正式历史恢复，不把半截输出当成完整答复；
- 导出完整 ZIP 日志归档；宿主提供相应能力时，也可分享 Markdown 对话正文；
- 在 App 检查插件更新，明确确认后安装兼容版本。宿主负责热替换和失败回滚；
  未启用热重载时，App 明确提示需要重启 DSH；
- 发送提示词、切换模型、创建会话，并处理审批与提问；
- 使用 5 分钟有效的单次配对码与设备级 P-256 密钥；iPhone 真机私钥保存在
  Secure Enclave；
- 局域网连接全程 TLS：插件自签证书，App 按配对二维码中的指纹固定信任；
  也可选用内嵌 Tailscale Funnel 远程连接；
- 接收在线通知，以及可选的离线 APNs 推送；
- 更新提示：设置页底部显示当前插件版本，并在有新版本时附加一个指向
  对应 GitHub Release 的链接（后台静默检查，仅比较稳定版，不引入第
  三方依赖）。

## 从 npm 安装

当前源码面向 Node.js 22+ 与带 `web` profile 的**八个已审计 DSH 版本**：
`0.2.0-rc.2`、`alpha` 通道的 `0.2.1-alpha.3`、
`0.2.1-alpha.4`、`0.2.1-alpha.5` 与 `0.2.2-alpha.2`，以及先后三版 `next` 通道的
`0.2.1-rc.2`、`0.2.1-rc.3` 与 `0.2.1-rc.4`（npm 通道会移动：`latest` 现指向由 `next` 转正的
`0.2.1-rc.2`，`next` 指向 `0.2.1-rc.4`，`alpha` 指向 `0.2.2-alpha.2`）。
DSH 在组合 profile 前会校验插件声明的
兼容要求，且**每次启动都会校验**（不只是安装时），因此其他宿主版本会拒绝
激活本插件。从 DSH `0.2.1-alpha.4` 起，该校验只读 `engines.dsh` 并忽略
`peerDependencies`；更早的宿主只认 peer 范围，因此两处列出同一组八个版本。
npm 包内置 macOS、Linux、Windows 的 amd64/arm64 Funnel helper；可信局域网
模式不依赖 helper。helper 用 Go 1.27 编译，要求 **macOS 13 Ventura 或更高版本**：
macOS 12 及更早版本无法启动 Funnel 模式，可信局域网模式不受影响。

当前工作树的 `engines.dsh` 与 `peerDependencies` 精确列出这六个版本，构建与
类型检查针对 `0.2.0-rc.2`。从此工作树发布新版本前，已发布的旧插件包仍可能
带有各自旧的兼容声明。

```sh
dsh plugin --profile web add dsh-deeppilot
dsh web
```

DSH 重启后，打开 **设置 → DeepPilot**，启用连接并显示配对二维码，然后在
DeepPilot App 中扫码。二维码下方同时显示一段可复制的「配对信息」（含地址、一次性配对码
与证书指纹），在 App 里粘贴一次即可完成配对，适合模拟器或相机不可用时使用；在「内网 /
公网」之间切换会立即为所选地址生成新的二维码与配对信息，面板保持展开。

局域网连接默认使用插件独立的 TCP `3098` 端口，且只提供 TLS。插件首次启动时生成
自签证书（私钥位于 `$DSH_HOME/deeppilot/lan-tls/`），配对二维码携带其公钥指纹，
App 只信任与该指纹一致的主机。DSH 可以继续只监听 `127.0.0.1:3080`；插件不再在
DSH Web 服务上注册任何 `/phone` 路由。启用系统防火墙时，请仅在你使用的网络放行
入站 TCP `3098`；端口可在 DeepPilot 设置页里修改（具体分区随 DSH 版本可能调整，
以设置页实际布局为准）。

从仍在局域网提供明文 `ws://` 的旧版本插件升级：通过局域网配对的设备需要重新扫码
配对，以接收证书指纹；经 Funnel 配对的设备不受影响。

npm 包：[npmjs.com/package/dsh-deeppilot](https://www.npmjs.com/package/dsh-deeppilot)

## 更新或卸载

```sh
dsh plugin --profile web update dsh-deeppilot
dsh plugin --profile web remove dsh-deeppilot
```

更新后请重启 DSH。卸载 npm 包不会删除 `$DSH_HOME/deeppilot/` 下的本地数据。

## 发布说明（维护者）

采用可信发布（Trusted Publishing）：GitHub Actions（GitHub 工作流）通过 OIDC
身份认证发布，并生成来源证明（Provenance），无需长期 npm 发布令牌。

1. 同步包版本与锁文件版本，按 `AGENTS.md` 完成发布验证；提交、推送并等待
   持续集成（CI）通过。
2. 从已合入 `main` 的发布提交创建附注标签 `v<版本>`，准备英文与简体中文的
   GitHub Release（发布页）草稿。
3. 经用户授权后，在该版本标签上手动运行 `publish.yml`。稳定版使用
   `latest`（稳定分发标签），预发布版使用 `alpha`（预发布分发标签）。
4. 核对 npm 版本、分发标签、包完整性与来源证明，并在全新 DSH 配置中安装验证，
   然后公开 GitHub 发布草稿。

工作流不会因推送标签自动发布。npm 网站绑定、手动命令及首次发布的验证边界见
[npm 可信发布说明](./docs/NPM_PUBLISHING.md)。


## 连接与隐私

完整会话流量由 iPhone 直接连接用户自己的 DSH Host，且始终加密：独立 `3098`
端口的局域网监听器使用自签证书提供 TLS，指纹在配对时下发给 App；Funnel 模式
使用 Tailscale 签发的证书。App 拒绝明文 `ws://`。局域网监听器和可选 Funnel
模式都只暴露经过认证的 DeepPilot 连接、单次配对与健康检查端点，不会暴露完整
DSH Web UI。

DeepPilot 设置页提供“每个公网来源的连接上限”，默认 `8`，可设置为 `1`–`16`
（具体分区随 DSH 版本可能调整，以设置页实际布局为准）。修改后 Funnel helper
会短暂重启，已连接的远程客户端会自动重连一次。设备列表支持为每台已配对设备设置
自定义名称；名称会保存在主机设备注册表中，即使 iPhone 重连或上报了新的系统名称
也不会被覆盖。留空保存可恢复 iPhone 上报的默认名称。

设置页的“测试与故障排查”分组下有一个 `debug` 开关，打开后会在 DSH host 的
终端输出里打印逐帧与推送等诊断信息（例如 `s2c.welcome` 里实际发出的能力位），
不会打印配对令牌、APNs token 或消息内容。该开关按连接快照，已建立的连接需要
重连一次才按新值工作。

**连不上时不需要打开这个开关**：插件会无条件记录准入拒绝、认证失败（4401 会区分
设备不存在、已撤销、签名错、挑战过期、时钟偏差等原因）、TLS 握手失败与配对失败，
在终端输出为 `[deeppilot] <时间> WARN <事件> <原因> src=<来源哈希> attempt=<尝试 ID>`，
并落盘到插件数据目录的 `diagnostics/`（保留 7 天、上限 5 MB）。设置页“连接诊断”
分组可查看最近失败并一键复制；`/phone/health` 额外返回本地传输相位与端口、数据面
相位、是否重建过 TLS 身份、启动时间与最近一次失败，手机端在连不上时也能据此定位。
记录只含来源哈希，不含原始 IP、配对码、密钥、APNs token 或消息内容。

手机端每次连接尝试会带一个随机的 `attemptId`（WebSocket 升级的 `?at=` 查询参数，
或配对/健康检查的 `X-DeepPilot-Attempt` 请求头）。插件把它写进上面的日志与诊断
事件；用户反馈时报告这个 ID，就能在主机日志里定位到同一次尝试。

离线推送是可选功能。中继模式只发送目标 APNs 设备 Token 和有限的通知内容；
完整会话历史与实时输出不会经过中继。启用远程访问或推送前，请阅读
[PRIVACY.md](./PRIVACY.md) 与 [SECURITY.md](./SECURITY.md)。协议 v2 的实现状态与
剩余发布验证记录在 [docs/SECURITY_ROADMAP.zh-CN.md](./docs/SECURITY_ROADMAP.zh-CN.md)。

## App 截图

| 首页 | 侧边栏 | 聊天 | 设置 |
| --- | --- | --- | --- |
| <img src="./assets/screenshots/home.png" alt="DeepPilot 首页" width="220"> | <img src="./assets/screenshots/sidebar.png" alt="DeepPilot 侧边栏" width="220"> | <img src="./assets/screenshots/chat.png" alt="DeepPilot 聊天界面" width="220"> | <img src="./assets/screenshots/settings.png" alt="DeepPilot 设置界面" width="220"> |

## 兼容性

已验证的基线与当前限制见 [COMPATIBILITY.md](./COMPATIBILITY.md)。DSH 仍在快速
迭代；提交问题时请附上准确的 DSH 与插件版本。

## 协议

[PROTOCOL.md](./PROTOCOL.md) 是 DeepPilot 桥接协议的规范性文档。任何 wire
变更都必须同步更新该文档与 `src/protocol.ts`，并与私有 iOS 客户端协调。
协议 v2 是唯一支持的 wire version；从 v1 升级必须重新配对。

## 开发

```sh
npm ci
npm test
npm run typecheck
npm run build
cd helper && go test ./...
```

## 社区与反馈

- [GitHub Issues](https://github.com/Mars-Sea/dsh-deeppilot/issues)
- [GitHub Releases](https://github.com/Mars-Sea/dsh-deeppilot/releases)
- [npm 包](https://www.npmjs.com/package/dsh-deeppilot)
- [Linux.do 社区](https://linux.do/)

DeepPilot 是独立社区项目，与 DeepSeek 官方无隶属或背书关系。

## 许可证

MIT — 见 [LICENSE](./LICENSE)。
