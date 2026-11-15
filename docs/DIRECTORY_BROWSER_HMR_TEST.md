# 独立手机目录浏览：测试分支与验收记录

日期：2026-11-16（Asia/Shanghai）。分支：`fix/independent-phone-directory-browser`。本分支为验证方案，不是发布版本。

## 修改与功能边界

DeepPilot 不再在 bundle 中禁用 DSH 的 `directory-picker`，也不再插入官方 browse Host/Client 行。手机的 `c2s.directory.list` 经原有 `HostBridge → apiProxy.host.listDirectory` 调用插件内部的只读目录浏览函数，不注册全局服务。

手机协议 v2、请求/响应字段、已认证阶段及 `sessions.manage` 权限保持不变。`files.browse` 仍控制会话内项目文件资源，独立于“添加项目”的目录枚举。目录默认从主目录开始，保留隐藏标记、目录符号链接的词法路径、面包屑、排序、1000 项上限与 `truncated`。相对路径、Windows 无盘符根路径和不完整 UNC 路径被拒绝。

`c2s.directory.pick` 保留：只有用户主动操作才调用 DSH 的可选原生选择器；服务缺席/没有原生能力时返回不支持，用户取消返回 `path: null`。每次请求读取当前服务，避免持有已卸载的控制器。

有一项预期的电脑端行为变化：DSH Web/Desktop 恢复自身默认的 native/browse 选择，不再被 DeepPilot 强制改成 browse。手机目录列表不依赖电脑端选择哪种交互。

## 自动化回归

| 验证 | 结果 |
| --- | --- |
| 新增目录模块与目录 RPC 测试 | 19/19 通过 |
| 目录、适配器、权限相关定向回归 | 47/47 通过 |
| 全量回归（英文 locale、并发上限 4） | 879 项：877 通过、0 失败、1 skip、1 既有 TODO |
| TypeScript 源码与测试类型检查 | 通过 |
| Host/Client 构建、Client runtime requires 检查 | 通过；Client 构建产物无变化 |
| 配置 schema（最低支持 DSH 0.2.1-rc.5） | 通过；使用任务独立 npm cache |
| npm 打包预览 | 修复 Host、Client 与 bundle patch 均包含在内 |
| 独立源码/用户流程复核 | 未发现本次差异引入的阻断问题 |

复现全量检查：

```sh
LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 ./node_modules/.bin/tsx --test --test-concurrency=4 tests/*.test.ts
npm run typecheck
npm run build
npm run check:config-schema
```

默认 `LANG=zh_CN.UTF-8` 会让 Node 的 `navigator.language` 成为 `zh-CN`；两项既有 i18n 测试假定无 context 时一定回退英文，因而失败。已在原始 `f2a7b11` 临时 worktree 中复现同样两项失败，未修改国际化实现或这些测试。无界并发运行还曾出现一次 helper panic 测试的时间窗口失败；并发上限 4 后完整通过，未修改 helper。

目录测试覆盖真实目录和符号链接、文件过滤、隐藏项、路径校验、1001 项截断、有界排序、取消期间的 open/read/stat/close、迟到文件句柄清理。RPC 测试覆盖原生后端存在但不支持 list、完全没有 picker、原生选择成功/取消/服务重挂载、错误码和管理权限。单测对取消的验证指传入的 AbortSignal；现有目录 wire 调用仍使用 Bridge 生命周期，不能据此声称手机断连会立即终止操作。

## 真实隔离 HMR 验证

使用本机已安装的 DSH `0.2.2-rc.3` 正式 `runProfile`、`pluginManager.updateBundle` 和真实 pnpm 操作；一次性本地 registry 提供原始发布包和仅用于本机的测试版本，无需公开发布。测试身份、目录和 profile 均为合成数据。worker 内把监听地址限制为 loopback/临时端口，不改生产传输实现。

验收必须同时检查 manager 返回、磁盘安装版本、实际运行版本、真实 WSS 重新认证/目录列表/项目列表/权限拒绝，以及官方 picker 生命周期。仅有 `application: applied` 不足以判定通过。

运行器和 profile 均放在开发仓库之外：如果临时 profile 位于名为 `dsh-deeppilot` 的开发包内部，HMR 的模块解析可能回退到父目录的包自引用，造成安装版与加载版不一致。服务实例比较读取 Cordis 代理背后的 `Symbol.for('cordis.original')` target，不能直接比较每次 `ctx.get()` 生成的 trace proxy。前两轮测试发现并纠正了这两个验收工具问题，没有据此修改生产版本读取逻辑，也没有把失败断言改记为成功；最终矩阵使用新的独立目录重跑。

最终使用 Desktop 携带的 pnpm `11.28.5` 完成两个正向用例；测试版本只存在于一次性 registry，没有公开发布。

| 场景 | manager 与实际运行结果 | 验收 |
| --- | --- | --- |
| 原始 `0.9.23` → 保留旧 picker patch 的控制包 | 目标 enable 为 `failed / operation-error`，restore 同样失败，诊断明确为重复 `directoryPicker` | 原缺陷复现；不是可用的恢复状态 |
| 原始 `0.9.23` → 修复 `.1` | `applied`、无 restore；health 运行版本变为 `0.9.24-hmrtest.1` | 19/19 通过 |
| 修复 `.1` → 修复 `.2` | `applied`、无 restore；health 运行版本变为 `.2`，重新启用后仍为 `.2` | 36/36 通过 |

正向用例覆盖真实 WSS P-256 鉴权/重连、目录枚举、隐藏目录和文件过滤、采用目录为工作区、重复创建幂等、列表含新工作区、只读设备拒绝目录枚举及 OS picker。修复包更新、关闭、重新启用、移除期间，官方 picker/controller 的原始服务对象均保持同实例；移除后 phone transport 释放。所有测试 worker 与 registry 已结束，没有遗留本任务进程。

**证据保存边界：**最终 managed job `bash-c6e3177449d64ef9` 已由验证 agent 收集，退出码 0；两个用例分别为 19/19 和 36/36。会话暂停后，系统临时目录和历史 job 记录已清理，最终原始 summary/evidence JSON 不再可用，也没有另存原始副本。[恢复摘要](verification/directory-hmr-2026-11-16.json) 明确依据已收集工具输出整理，保存测试版本 SHA256、用例结果、计数与限制；它不是重构的“原始完整返回”。首轮工作区内保留的控制日志能直接核对重复服务及失败 restore，但该轮的正向结果受到开发包自引用污染，不能替代最终正向证据。

[真实验证脚本](../scripts/smoke-directory-hmr.mjs) 保留在分支中，可以重新取得完整原始证据。先完成构建，指定已安装的准确 DSH `0.2.2-rc.3` 与要对照的 pnpm CLI 文件：

```sh
npm run build
node scripts/smoke-directory-hmr.mjs --run --artifacts-ready \
  --dsh-install /absolute/path/to/installed/dsh \
  --pnpm-cli /absolute/path/to/pnpm/bin/pnpm.cjs \
  --cases old-to-fixed,fixed-next
```

默认会在系统临时区创建独立目录；需要长期保留原始证据时，用 `--scratch` 指向工作区中、插件仓库之外的全新空目录，并及时归档结果。显式非空目录和未知 `--cases` 会在任何 profile 写入前拒绝。单独运行 `--cases old-control` 可以重新观察旧缺陷；它会如实记录恢复后目录功能失败，退出非零不代表修复包失败。

## 未覆盖与已有问题

- 未做真实 iPhone/Android 界面操作、Windows 文件系统实机、OS 原生目录弹窗、Funnel 或 APNs 验收。没有修改移动端、helper 或公开发布状态。
- iOS 既有目录采用错误反馈：列表加载成功后 `workspace.create` 失败只更新 `errorText`，当前显示列表的分支没有呈现该错误。该问题在原有界面中存在，本分支未修改 iOS。
- 当前旧版曾出现“磁盘恢复旧版但重新激活也失败”；不能以旧版文件已装回代替运行健康检查。旧版迁移和修复版之间的后续更新应分别报告。
