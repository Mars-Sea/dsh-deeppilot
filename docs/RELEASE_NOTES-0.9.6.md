# DeepPilot 0.9.6 — 兼容 DSH alpha.4

## 一、English / 英文

1. Support DSH 0.2.1-alpha.4 as a third audited host. That release evaluates a plugin's own `engines.dsh` range alone and ignores `peerDependencies` entirely whenever the field is present; this plugin declared none, so its exact two-version peer list refused to activate it there. An unaudited host still fails visibly rather than misbehaving quietly.
2. Name the same closed host list in both declarations: `engines.dsh` and all ten `@deepseek-ai/dsh*` peers now read `0.2.0-rc.2 || 0.2.1-alpha.3 || 0.2.1-alpha.4`. Older hosts do not know `engines.dsh` and keep evaluating the peer range, and npm reads only `peerDependencies` at install time, so both must agree. The two vendor peers need no widening: both hosts still vendor cordis 4.0.5-alpha.2 and schemastery 3.18.5-alpha.2.
3. No code changed and `lib/` needs no regeneration. Eight of the ten peer packages ship a byte-identical `lib/` tree, including `dsh-api-gateway` and every Client face the resident interaction client loads, so all 0.9.5 fixes still hold unchanged. The release's only code changes anywhere are one additive Remote Events entry (`plugin-market/changed`) and the rename of `IncompatiblePlugin.peers` to `requirements`, a field this plugin never reads.
4. Record two packages that first appear in this release: `dsh-plugin-market` and `dsh-experimental-plugin-market-bundle`, behind its custom plugin index sources. Neither is a dependency of this plugin and neither appears in its `inject`.
5. Local release checks passed. See the section below for the exact commands and results.
6. Protocol v2, pairing state, and device records are untouched by this release, so no paired phone needs to re-pair.
7. One existing TODO remains: an authenticated socket can replay its authentication proof and repeat welcome/replay delivery. This release does not claim that finding is fixed.

## 二、简体中文

1. 新增支持 DSH 0.2.1-alpha.4 作为第三个已审计宿主。该版本只要插件声明了 `engines.dsh`，就只按它判定并完全忽略 `peerDependencies`；本插件此前未声明该字段，因此仍走 peer 校验，其精确两版列表在该宿主上拒绝激活。未审计的宿主依旧「可见地失败」，而不是静默错行为。
2. 两处声明同一份闭集：`engines.dsh` 与全部十个 `@deepseek-ai/dsh*` peer 现均为 `0.2.0-rc.2 || 0.2.1-alpha.3 || 0.2.1-alpha.4`。旧宿主不认识 `engines.dsh`，继续按 peer 范围判定；npm 安装期也只读 `peerDependencies`，因此两者必须一致。两个 vendor peer 无需放宽：两个宿主仍 vendored cordis 4.0.5-alpha.2 与 schemastery 3.18.5-alpha.2。
3. 未改动任何代码，`lib/` 无需重新生成。十个 peer 包中八个的 `lib/` 目录逐字节相同（含 `dsh-api-gateway` 与常驻交互客户端加载的全部 Client face），0.9.5 的修复全部继续有效。本版本仅有的代码变更是新增一条 Remote Events 条目（`plugin-market/changed`），以及 `IncompatiblePlugin.peers` 改名为 `requirements`，本插件从不读取该字段。
4. 审计记录新增两个在本版本首次出现的包：`dsh-plugin-market` 与 `dsh-experimental-plugin-market-bundle`，服务于自定义插件索引源。二者都不是本插件的依赖，也未出现在其 `inject` 中。
5. 本地发布检查通过，确切命令与结果见下节。
6. 手机协议 v2、配对状态与设备记录均未被本版本改动，已配对手机无需重新配对。
7. 保留一项既有待办（TODO）：已认证连接重复提交认证证明仍会触发欢迎消息与重放，本次发布不宣称修复该问题。

## 三、验证与发布边界

1. 本地发布清单在**基于本次适配提交的隔离工作树**中执行（不包含同期的移动端功能改动），结果：单元测试 564 项、563 通过、0 失败、1 项既有待办；`npm run typecheck` 通过；`npm run build` 通过且重新生成的 `lib/` 与提交内容零差异；`npm run check:config-schema` 针对锁定的 `0.2.0-rc.2` CLI 通过（`/34 → $defs/config19`，volatile 字段齐全）；`helper` 的 `go test ./...` 通过；`bin/SHA256SUMS` 的六个平台二进制校验和全部 OK；`npm pack --dry-run` 产出 `dsh-deeppilot-0.9.6.tgz`（68 个文件、约 49.7 MB），不含移动端功能文件与本地决策记录。
2. 版本号变更同步重建了 `tests/apply-baseline.snapshot.json`：该基线快照把 `serverVersion` 与 `pluginVersion` 记为字面量，重建后的 diff 仅为这六处版本号，没有其它可观测面变化。
3. 本次审计先比对**已发布产物**再读源码：把十个 `@deepseek-ai/dsh*` peer 包在 `0.2.1-alpha.3` 与 `0.2.1-alpha.4` 两个版本上从 npm 取下、解包并逐文件比对，再对唯一的大 diff 做归一化重比（去掉 `TYPERT_REMOTE$N` 编号位移与 `sourceLocation` 行列漂移），以免机械噪声掩盖契约变更。
4. 兼容性判定使用两个宿主各自**已发布**的 `evaluatePluginCompatibility` 复现，而非推断：改动前两个宿主都放行 `0.2.0-rc.2` 与 `0.2.1-alpha.3` 并拒绝 `0.2.1-alpha.4`（列出全部十个 peer 未满足）；改动后三个已审计版本全部放行，`0.2.1-alpha.2`、`0.2.1-alpha.5`、`0.2.1` 与 `0.3.0` 仍被拒绝。
5. 在已发布的 alpha.4 CLI 上做安装 A/B：未改动的包被拒（`installation rejected ... requirements {...}`，退出码 1，未安装任何内容），修复后的包安装成功并链接进 profile；组合树从 153 行变为 162 行，插件三行就位；Web 模板 profile 真实启动，插件数据面与本地传输均正常，且未出现 alpha.3 那次的交互客户端诊断。
6. 本次范围是公开插件；未进行 iPhone 真机、Funnel 通道与真实模型轮次的验证。手机协议零变化属源码级结论，不是设备实测。
7. 完整审计过程、证据与局限记录在 `docs/DSH_RELEASE_MEMORY.md` 的 `2026-10-15 — audit of dsh-v0.2.1-alpha.4` 小节；策略决策记录在 `docs/决策记录.md`（章节一，条目3）。
