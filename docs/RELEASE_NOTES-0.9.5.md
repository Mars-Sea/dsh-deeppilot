# DeepPilot 0.9.5 — 兼容 DSH alpha.3 与 npm 可信发布

## 一、English / 英文

1. Restore approval and question delivery on DSH 0.2.1-alpha.3 by naming an owner/answer Peer on every in-process stream and Fetch carrier, explicitly enabling answer interactions, and loading the Node client exports when the browser module banner is absent.
2. Support exactly the two audited hosts: DSH 0.2.0-rc.2 and 0.2.1-alpha.3. Other host versions require a new compatibility audit before activation.
3. Add manually triggered npm trusted publishing through GitHub Actions with OIDC and provenance. Validate the release tag, commit, package and lockfile versions, distribution tag, package integrity, and provenance metadata. Stable releases use latest; prereleases use alpha.
4. Add shared Node/Swift authentication vectors, abuse regression coverage, device-registry recovery guidance, and wording that covers computers across supported platforms. Protocol v2 and existing pairing records stay compatible.
5. Make the altered-challenge regression deterministic: derive every mutation from the socket under test and assert that the value actually changed. This removes a one-millisecond timestamp collision in the test fixture.
6. One existing TODO remains: an authenticated socket can replay its authentication proof and repeat welcome/replay delivery. This release does not claim that finding is fixed.
7. Local release checks passed: clean dependency install, 562 passing tests with zero failures and one existing TODO, typecheck, build, real DSH config loading, Go tests, six helper checksums, and package inspection. The corrected challenge test also passed 20 consecutive runs. Physical iPhone validation was not performed.
8. Published to npm through OIDC with signed provenance. The downloaded archive matches the upload digest; its provenance names tag v0.9.5, commit 6517ad7, and publish.yml. npm signature auditing and fresh registry installs on both supported DSH hosts passed.
9. An isolated alpha.3 live-host smoke run recorded 24 passes, one failure, and three skips. The failure is the nonempty model-catalog assertion in a fresh profile without model credentials; model switching, a real prompt, and model-triggered approval/question delivery remain unverified.
10. The initial publish run uploaded the package successfully, then failed its metadata check on a cached 404. Independent signature and installation checks passed afterward. The follow-up cache-refresh repair is a repository update after publication; the v0.9.5 tag and npm package remain unchanged.

## 二、简体中文

1. 修复 DSH 0.2.1-alpha.3 上审批与提问无法送达：为进程内流和请求载体明确传入 owner/answer Peer（所有者与应答对端），显式启用应答交互，并在浏览器模块标记缺失时读取 Node 客户端导出。
2. 精确支持两个已审计的宿主版本：DSH 0.2.0-rc.2 与 0.2.1-alpha.3。其他版本需重新审计兼容性后再启用。
3. 新增手动触发的 npm 可信发布：GitHub Actions（GitHub 工作流）使用 OIDC 身份认证与来源证明（Provenance），校验发布标签、源码提交、包与锁文件版本、分发标签、包完整性及来源证明元数据。稳定版使用 latest（稳定分发标签），预发布版使用 alpha（预发布分发标签）。
4. 增加 Node/Swift 跨语言认证向量、异常输入回归覆盖和设备注册表恢复说明；文案统一覆盖各平台电脑。手机协议仍为 v2，既有配对记录继续兼容。
5. 修复篡改挑战回归测试的不稳定输入：从正在测试的连接生成每个篡改值，并断言值确实变化，消除测试数据中的一毫秒时间碰撞。
6. 保留一项既有待办（TODO）：已认证连接重复提交认证证明仍会触发欢迎消息与重放，本次发布不宣称修复该问题。
7. 本地发布检查通过：干净依赖安装、562 项测试通过、0 项失败与 1 项既有待办、类型检查、构建、真实 DSH 配置加载、Go 测试、六个平台辅助程序校验和及打包检查。修正后的挑战篡改测试连续 20 次通过。本次未进行 iPhone 真机验证。
8. 已通过 OIDC 身份认证发布到 npm，并生成签名来源证明。下载包摘要与上传记录一致；来源证明对应 `v0.9.5` 标签、`6517ad7` 提交与 `publish.yml`。npm 签名审计通过，两个支持的 DSH 宿主均已在全新配置中从注册表安装验证通过。
9. 隔离的 alpha.3 真实宿主冒烟检查记录为 24 项通过、1 项失败、3 项跳过。失败项是未配置模型凭据的全新配置中，模型目录非空的断言；模型切换、真实提问和模型触发的审批问答仍未验证。
10. 首次发布运行已成功上传包，随后元数据核对因缓存的 404 失败；独立签名与安装核验通过。后续缓存刷新修正属于发布后的仓库更新，`v0.9.5` 标签与 npm 包保持原始内容。

## 三、验证与发布边界

1. 发布前执行项目完整清单，并核对实际 npm 压缩包内容与已提交构建产物。
2. 首次 OIDC 身份认证已通过实际发布验证，npm 可信发布绑定显示 `Valid`（有效）。注册表版本、`latest`（稳定分发标签）、压缩包摘要、来源证明签名及全新 DSH 配置安装均已核对。
3. 本次范围是公开插件及发布流程；未进行 iPhone 真机功能验证。
4. [首次发布运行](https://github.com/Mars-Sea/dsh-deeppilot/actions/runs/38653869533)的上传步骤成功，末尾核对命中缓存的 404 而失败。随后独立签名与安装核验通过；发布后的工作流修正刷新查询及有限重试，修正后的只读核对步骤对真实注册表执行通过。该修正属于发布后的仓库更新，`v0.9.5` 标签和已发布包保持原始内容。
