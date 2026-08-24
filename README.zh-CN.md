# dsh-deeppilot

[English](./README.md) | **简体中文**

[![npm](https://img.shields.io/npm/v/dsh-deeppilot?style=flat-square)](https://www.npmjs.com/package/dsh-deeppilot)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4D6BFE?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![CI](https://github.com/Mars-Sea/dsh-deeppilot/actions/workflows/ci.yml/badge.svg)](https://github.com/Mars-Sea/dsh-deeppilot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**DeepPilot** 的开源 DSH 配套插件。DeepPilot 是一款原生 iPhone 客户端，
可远程使用 DeepSeek Harness；插件让 App 直接连接用户自己 Mac 上的 DSH Host，
不会替换或修改 DSH Web UI。

> DeepPilot 目前正在等待 TestFlight 审核。Apple 审核通过后，邀请链接即可加入测试。

[加入 DeepPilot TestFlight](https://testflight.apple.com/join/JHb4j5DV)

## 功能

- 在 iPhone 查看项目、会话、历史记录和 Agent 实时输出；
- 发送提示词、切换模型、创建会话，并处理审批与提问；
- 扫描二维码配对，密钥保存在 Mac 与 iOS Keychain；
- 使用可信局域网，或可选的内嵌 Tailscale Funnel 远程连接；
- 接收在线通知，以及可选的离线 APNs 推送。

## 从 npm 安装

需要 Node.js 22+、DSH `web` profile 与 macOS。内嵌 Funnel helper 目前支持
Apple silicon；可信局域网模式不依赖 helper。

```sh
dsh plugin --profile web add dsh-deeppilot
dsh web
```

DSH 重启后，打开 **设置 → DeepPilot**，启用连接并显示配对二维码，然后在
DeepPilot App 中扫码。

npm 包：[npmjs.com/package/dsh-deeppilot](https://www.npmjs.com/package/dsh-deeppilot)

## 更新或卸载

```sh
dsh plugin --profile web update dsh-deeppilot
dsh plugin --profile web remove dsh-deeppilot
```

更新后请重启 DSH。卸载 npm 包不会删除 `$DSH_HOME/deeppilot/` 下的本地数据。

## 连接与隐私

完整会话流量由 iPhone 直接连接用户自己的 DSH Host。可信局域网中的 `ws://`
是明文流量，只应在可信网络使用。可选 Funnel 模式只暴露经过认证的 DeepPilot
连接与健康检查端点，不会暴露完整 DSH Web UI。

离线推送是可选功能。中继模式只发送目标 APNs 设备 Token 和有限的通知内容；
完整会话历史与实时输出不会经过中继。启用远程访问或推送前，请阅读
[PRIVACY.md](./PRIVACY.md) 与 [SECURITY.md](./SECURITY.md)。

## App 截图

| 首页 | 侧边栏 | 聊天 | 设置 |
| --- | --- | --- | --- |
| <img src="./assets/screenshots/home.png" alt="DeepPilot 首页" width="220"> | <img src="./assets/screenshots/sidebar.png" alt="DeepPilot 侧边栏" width="220"> | <img src="./assets/screenshots/chat.png" alt="DeepPilot 聊天界面" width="220"> | <img src="./assets/screenshots/settings.png" alt="DeepPilot 设置界面" width="220"> |

## 兼容性

已验证的基线与当前限制见 [COMPATIBILITY.md](./COMPATIBILITY.md)。DSH 仍在快速
迭代；提交问题时请附上准确的 DSH 与插件版本。

## 协议

[PROTOCOL.md](./PROTOCOL.md) 是 DeepPilot 桥接协议的规范性文档。任何 wire
变更都必须同步更新该文档与 `src/protocol.ts`，保持协议 v1 向后兼容，并与
私有 iOS 客户端协调。

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

DeepPilot 是独立社区项目，与 DeepSeek 官方无隶属或背书关系。

## 许可证

MIT — 见 [LICENSE](./LICENSE)。
