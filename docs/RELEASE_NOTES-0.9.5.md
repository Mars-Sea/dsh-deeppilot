# DeepPilot 0.9.5 — 兼容 DSH alpha.3 与 npm 可信发布

## 一、English / 英文

1. Restore approval and question delivery on DSH 0.2.1-alpha.3 by naming an owner/answer Peer on every in-process stream and Fetch carrier, explicitly enabling answer interactions, and loading the Node client exports when the browser module banner is absent.
2. Support exactly the two audited hosts: DSH 0.2.0-rc.2 and 0.2.1-alpha.3. Other host versions require a new compatibility audit before activation.
3. Add manually triggered npm trusted publishing through GitHub Actions with OIDC and provenance. Validate the release tag, commit, package and lockfile versions, distribution tag, package integrity, and provenance metadata. Stable releases use latest; prereleases use alpha.
4. Add shared Node/Swift authentication vectors, abuse regression coverage, device-registry recovery guidance, and wording that covers computers across supported platforms. Protocol v2 and existing pairing records stay compatible.
5. Make the altered-challenge regression deterministic: derive every mutation from the socket under test and assert that the value actually changed. This removes a one-millisecond timestamp collision in the test fixture.
6. One existing TODO remains: an authenticated socket can replay its authentication proof and repeat welcome/replay delivery. This release does not claim that finding is fixed.
7. Local release checks passed: clean dependency install, 562 passing tests with zero failures and one existing TODO, typecheck, build, real DSH config loading, Go tests, six helper checksums, and package inspection. The corrected challenge test also passed 20 consecutive runs. Physical iPhone validation was not performed.

## 二、简体中文

1. 修复 DSH 0.2.1-alpha.3 上审批与提问无法送达：为进程内流和请求载体明确传入 owner/answer Peer（所有者与应答对端），显式启用应答交互，并在浏览器模块标记缺失时读取 Node 客户端导出。
2. 精确支持两个已审计的宿主版本：DSH 0.2.0-rc.2 与 0.2.1-alpha.3。其他版本需重新审计兼容性后再启用。
3. 新增手动触发的 npm 可信发布：GitHub Actions（GitHub 工作流）使用 OIDC 身份认证与来源证明（Provenance），校验发布标签、源码提交、包与锁文件版本、分发标签、包完整性及来源证明元数据。稳定版使用 latest（稳定分发标签），预发布版使用 alpha（预发布分发标签）。
4. 增加 Node/Swift 跨语言认证向量、异常输入回归覆盖和设备注册表恢复说明；文案统一覆盖各平台电脑。手机协议仍为 v2，既有配对记录继续兼容。
5. 修复篡改挑战回归测试的不稳定输入：从正在测试的连接生成每个篡改值，并断言值确实变化，消除测试数据中的一毫秒时间碰撞。
6. 保留一项既有待办（TODO）：已认证连接重复提交认证证明仍会触发欢迎消息与重放，本次发布不宣称修复该问题。
7. 本地发布检查通过：干净依赖安装、562 项测试通过、0 项失败与 1 项既有待办、类型检查、构建、真实 DSH 配置加载、Go 测试、六个平台辅助程序校验和及打包检查。修正后的挑战篡改测试连续 20 次通过。本次未进行 iPhone 真机验证。

## 三、验证与发布边界

1. 发布前执行项目完整清单，并核对实际 npm 压缩包内容与已提交构建产物。
2. 首次 OIDC 认证与来源证明须通过本次 GitHub 工作流的实际发布验证；发布后核对注册表和全新 DSH 配置中的安装结果，再公开 GitHub 发布草稿。
3. 本次范围是公开插件及发布流程；未进行 iPhone 真机功能验证。
