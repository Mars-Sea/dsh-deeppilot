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
- 使用 5 分钟有效的单次配对码与设备级 P-256 密钥；iPhone 真机私钥保存在
  Secure Enclave；
- 使用可信局域网，或可选的内嵌 Tailscale Funnel 远程连接；
- 接收在线通知，以及可选的离线 APNs 推送；
- 更新提示：设置页底部显示当前插件版本，并在有新版本时附加一个指向
  对应 GitHub Release 的链接（后台静默检查，仅比较稳定版，不引入第
  三方依赖）。

## 从 npm 安装

需要 Node.js 22+、带 `web` profile 的 DSH，以及 macOS。内嵌 Funnel helper
目前支持 Apple silicon；可信局域网模式不依赖 helper。

| 插件版本 | 所需 DSH | 安装命令 |
|---|---|---|
| `0.6.0-alpha.x`（新版，`alpha` tag） | DSH `0.1.2-alpha.3` 或更高 | `dsh plugin --profile web add dsh-deeppilot@alpha` |
| `0.5.x`（旧版稳定版，`latest`） | DSH `0.1.1-rc.2`–`0.1.2-alpha.1` | `dsh plugin --profile web add dsh-deeppilot` |

`0.6.0` alpha 系列基于 DSH
[0.1.2-alpha.3](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.1.2-alpha.3)
的 Host 与 client 包族构建，因此要求 DSH `0.1.2-alpha.3` 或更高版本（对应
npm `alpha` dist-tag）。alpha.3 Gateway 提供多 Client Remote Events 路由，
使 Web 与 DeepPilot 能独立接收并处理同一交互。更早版本没有这项路由契约；
需要更早 DSH 版本的用户请继续使用 `0.5.x` 插件。

DSH `0.1.2-alpha.4` 也已验证，交互路由契约保持不变；测试证据和会话历史兼容性
说明见 [COMPATIBILITY.md](./COMPATIBILITY.md)。

```sh
# DSH 0.1.2-alpha.3 或更高（推荐）：
dsh plugin --profile web add dsh-deeppilot@alpha
# DSH 0.1.1-rc.2 至 0.1.2-alpha.1（旧版稳定）：
dsh plugin --profile web add dsh-deeppilot
dsh web
```

DSH 重启后，打开 **设置 → DeepPilot**，启用连接并显示配对二维码，然后在
DeepPilot App 中扫码。同一面板也会显示可复制的配对码，供模拟器或手动输入使用。

npm 包：[npmjs.com/package/dsh-deeppilot](https://www.npmjs.com/package/dsh-deeppilot)

## 更新或卸载

```sh
dsh plugin --profile web update dsh-deeppilot
dsh plugin --profile web remove dsh-deeppilot
```

更新后请重启 DSH。卸载 npm 包不会删除 `$DSH_HOME/deeppilot/` 下的本地数据。

## 发布说明（维护者）

`0.6.0-alpha.x` 面向 DSH `0.1.2-alpha.3`+；`0.5.x` 保持兼容 DSH
`0.1.1-rc.2`–`0.1.2-alpha.1`，两个版本线都要保持发布：

1. 同步修改 `package.json` 与 `package-lock.json` 根 `""` 条目中的
   `version`，然后运行 `npm test && npm run typecheck && npm run build`，
   并检查 `npm pack --dry-run --json`（`tests/compatibility-metadata.test.ts`
   会强制校验 `^0.1.2-alpha.3` 的 peer 范围）。
2. 提交发布并推送。`npm publish` 会自动执行 `prepack`（构建）与
   `prepublishOnly`（测试 + 类型检查）。
3. 发布 alpha 版本线，不要动 `latest`：

   ```sh
   npm publish --tag alpha
   ```

   发布成功后，`npm view dsh-deeppilot dist-tags --json` 应显示
   `"latest": "0.5.x"` 与 `"alpha": "0.6.0-alpha.x"`。向用户推荐前，请先在
   DSH `0.1.2-alpha.3` profile 中安装验证发布的包。
4. 为发布提交打 `v0.6.0-alpha.x` tag，并准备包含英文与简体中文说明的
   GitHub Release，链接本 README 的发布说明。
5. alpha 转正时升级到 `0.6.0`，用 `npm publish --tag latest` 发布，使
   `latest` 切换到新版线。稳定版绝不使用 `--tag alpha` 发布。

绝不要从仍是旧 `0.5.x` 版本的副本执行 `npm publish`。


## 连接与隐私

完整会话流量由 iPhone 直接连接用户自己的 DSH Host。可信局域网中的 `ws://`
是明文流量，只应在可信网络使用。可选 Funnel 模式只暴露经过认证的 DeepPilot
连接、单次配对与健康检查端点，不会暴露完整 DSH Web UI。

DeepPilot 设置页在默认折叠的“高级设置”中提供“每个公网来源的连接上限”，默认
`8`，可设置为 `1`–`16`。修改后 Funnel helper 会短暂重启，已连接的远程客户端
会自动重连一次。

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
