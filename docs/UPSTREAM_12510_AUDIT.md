# Discussion #12510 — 完整审核记录（2026-11-11）

## 结论

前一版 issue 材料不宜按原文发布。核心问题有记录支持，但报告混合了不同轮次证据，并把激活失败的特征升级成了“可安全待重启”的判据。本轮已重写 [完整材料](UPSTREAM_ISSUE-DRAFT-updateBundle-hmr.md) 和 [补码回复](UPSTREAM_DISCUSSION-12510-reply3.md)，保留实际观测，撤回过强推断。审核时两份均为未发布草稿；用户随后授权按推荐执行，精简回复已于 2026-11-11 发布（[discussioncomment-19543727](https://github.com/deepseek-ai/deepseek-harness/discussions/12510#discussioncomment-19543727)），完整材料仍留本地。

## 审核覆盖与依据

本轮包含主审和一次独立只读复审。独立复审没有修改文件或向上游发消息，最终问题清单与主审交叉核对。

- 重新读取 [原始报告](UPSTREAM_DISCUSSION-plugin-update-hmr.md)、[已发布的三组复测回复](UPSTREAM_DISCUSSION-12510-reply2.md)、[发布记忆](DSH_RELEASE_MEMORY.md) 2026-11-07 与 2026-11-11 的验证记录。
- 通过 GitHub 只读 API 重新获取 [Discussion #12510](https://github.com/deepseek-ai/deepseek-harness/discussions/12510) 的正文、三个评论与嵌套回复；截至本轮查询，仍为三个顶层评论，没有嵌套回复，上游 Issues 关闭。
- 固定源码提交为 [`e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`](https://github.com/deepseek-ai/deepseek-harness/commit/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb)，不依赖浮动 master 行号。检查 plugin-manager、HMR、app-boot 重组合与错误构造、auto picker 的动态挂载/卸载，以及 CLI profile-copy 语法。Context7 文档仅辅助定位，以该提交源码为准。
- 重新下载 npm 的 `dsh-deeppilot@0.9.15`、`0.9.16`、`0.9.19` tarball，在内存中读取 bundle patch。三版 patch 的 SHA-256 均为 `8dfa5c56c668b9a6996303b8615e584d25127188ad7e5982c1b42e8d5e5818c1`，`dsh.bundle.patch` 均为 `./cordis.patch.yml`，宿主范围均为 `>=0.2.1-rc.5 <0.3.0-0`。
- 本轮没有重新运行更新、启动隔离宿主或验证新版本运行状态。工作区中找不到此前完整返回和运行日志，不能把现存摘要当作仍可提供的原始附件。

## 发现与修正

| 优先级 | 原稿问题 | 本轮处理 |
|---|---|---|
| P1 | 将 `operation-error` + `enable` + 重复服务文本称为可靠待重启判据。永久双 provider 配置也可能同样报错；汇总 diagnostic 里的子串还可能来自不同条目。 | 改为“观测到的激活碰撞特征”，明确不能证明临时性、条目归属或冷启动安全，撤回已发布回复中的 cheap detector 建议。 |
| P1 | 把返回 `restart-required` 排为最便宜修法，认为已有 `stage` 足够。实际返回 caller 前宿主可能已移除目标并重装旧版。 | 要求设计先明确目标落盘/选择状态、运行剩余状态及重启有效性；不把更改状态等同于实现更新。删除成本排序与“无需新信号”断言。 |
| P1 | 以 JSON 拼装 `0.9.19` 的目标字段和 `0.9.16` 轮次记录的错误，且 restore diagnostic 是省略占位，却称“完整返回”。 | 删除重构 JSON，使用可追溯的 `0.9.16` 错误字段表和归一化 diagnostic 摘录；`0.9.19` 三组矩阵单列。 |
| P1 | `X@<old>` / `X@<new>` 及 `name: X` 未提供实际包、入口和两版本，不能按原文复现。 | 改回实测的 `dsh-deeppilot@0.9.15` → `0.9.16`，原 patch 与真实 service 调用；说明该调用要求已注入的服务，本稿没有独立测试 harness。补 macOS / native picker 环境前提与 profile 初始化语法。 |
| P1 | 把磁盘旧版恢复、宿主恢复激活、客户端 `rolled-back` 标签混为一谈；一面保证可用，一面又断言运行态没有恢复。 | 两种绝对断言均删除。只记录旧版回到磁盘且 restore 报激活失败；完整运行健康未验收。只有对照场景 2/3 有重启后的目录功能记录。 |
| P1 | 说 `incompatible-version` 必定在任何 pnpm 之前抛出。 | 更正：registry update 预检在 destructive remove / `pnpm add` 之前可返回该码，但它先使用 `pnpm view`；安装后也有该码校验路径。不能由 code 单独推断阶段。 |
| P1 | 从单个 picker 案例推到所有覆盖其他行的 bundle 都只能冷更新。 | 全文限定测试包、版本和 profile；没有断言其他 picker 环境、未来目标或所有 `disabled` 覆盖都失败。 |
| P2 | 将静态 compose 当作可检测动态 service 注册碰撞的预检；称窗口会丢数据。 | 删除未经证明的自动检测实现与 data-losing 表述；保留“最终组合和动态生命周期需核实”的设计方向。无用户数据损失证据。 |
| P2 | 前一轮引用、自审记录自身仍有错：`:794` 分支实际在 `:793`；“修正5处”列6项；同一旧判据未同步到回复稿。 | 用固定提交 permalink 和完整调用链替换含糊行号。删除累积的自我表扬/修订史，重写两份文本。 |
| P2 | 将“未承诺产品规划”解释成“上游当前不修”，又要求 PerryLink 指定渠道；用“对我们有利”“pointless”等争辩表述。 | 未承诺不等于决定不修。补码回复只给事实、主动纠正建议，不再追问该参与者路线图/渠道。建议继续现有讨论。 |

## 核实后的调用链

固定提交中的 [plugin-manager](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/boot/plugin-manager/src/index.ts)：

1. `updateBundle` 的 `:768-770` 无 HMR 分支直接安装；HMR 分支 `:786` 移除旧 bundle，`:789` 安装目标；目标失败时 `:793` 按 enable 阶段移除目标，`:796-799` 尝试装回旧版。
2. `installBundle` 在 `:1101` 写入 enable 阶段，再选择 bundle、调用 `publishAndReload`。阶段值说明尝试到哪里，不说明错误必然来自哪里。
3. `publishAndReload` / `reload` 在 `:1339-1358` 委派给 [hmr.reconcileProfile](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/boot/hmr/src/index.ts#L930-L974)，后者调用 `recomposeProfile`。
4. [app-boot](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/boot/app-boot/src/index.ts#L415-L426) 判断新增/必需激活失败，并在 `:426` 把 `activationDiagnostic` 抛为异常。它虽然呈现 `warning` 文案，在这里并非无害 warning。
5. plugin-manager `change` 捕获异常，设 `application: failed`，由 `managementError` 转成普通错误对应的 `operation-error`。该映射另有 `UnsupportedBundlePlatformError` 与 `ManagementFailure` 特判。

动态 auto picker 挂载与销毁的源码支持“组合中间态与生命周期相关”的解释，但本轮没有 tracing 精确证明每个时间点哪个实例尚未释放；不把假设写成完整时序证明。

## 证据状态与发布建议

| 项目 | 当前证据等级 |
|---|---|
| rc.1 下错误码、激活碰撞、restore 同错 | 历史记录，且原帖可追溯；本轮没有原始完整返回附件。 |
| rc.1 三组对照及场景 2/3 的版本和目录功能 | 历史验证记录及已发布跟进评论；本轮没有新复测。 |
| `e8f7b93a` 的代码路径 | 本轮直接读固定提交的源码核验；不代表该提交真实运行验收。 |
| 三版发布包 patch 相同 | 本轮直接下载并核对 SHA-256。 |
| 通用自动冷更新检测、目标在任意重启后可用 | 未建立，报告中不作保证。 |

用户审核后授权按推荐执行，已在现有 #12510 发布精简错误码回复（[discussioncomment-19543727](https://github.com/deepseek-ai/deepseek-harness/discussions/12510#discussioncomment-19543727)，2026-11-11T14:33:05Z），并核对线上正文与本地一致。完整材料保留本地，没有另开帖子或上传完整材料。

本轮仅修改文档，按仓库约定校验链接、示例与 `git diff --check`，不重复运行与这次改稿无关的测试，也不修改协议、构建产物或兼容范围。
