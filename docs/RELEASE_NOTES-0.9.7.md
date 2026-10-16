# DeepPilot 0.9.7 — 兼容 DSH alpha.5

## 一、English / 英文

1. Support DSH `0.2.1-alpha.5` as a fourth audited host. The `alpha` dist-tag points at it, while `latest`/`next` still name `0.2.0-rc.2`. DSH evaluates a plugin's own `engines.dsh` range alone whenever that field is present, so an unaudited host still refuses to activate this plugin visibly instead of misbehaving quietly.
2. Both declarations name the same four releases: `engines.dsh` and all ten `@deepseek-ai/dsh*` peers now read `0.2.0-rc.2 || 0.2.1-alpha.3 || 0.2.1-alpha.4 || 0.2.1-alpha.5`. Older hosts do not know `engines.dsh` and keep evaluating the peer range, and npm reads only `peerDependencies` at install time, so both must agree. The test's contrast set still refuses `0.2.1-alpha.1`, `0.2.1-alpha.2`, `0.2.0`, `0.2.1-rc.1`, `0.2.1`, `0.3.0`, and `1.0.0`, so the widening did not become an open range.
3. Runtime verdict: no break, and no source change was needed. Nine of the ten peer packages ship a byte-identical `lib/` tree — including `dsh-api-gateway` and every Client face the resident interaction client loads, so all earlier fixes still hold. Only `dsh-api-remotes` changed, inside its `account/getUnnotifiedBonuses` result schema: one additive optional `title`, four fields relaxed from required to optional, three hunks and 36 lines in total, with identical exports (`apply`, `inject`). This plugin reads none of it.
4. The two vendor peers needed no widening even though both were promoted from prerelease to GA: alpha.5 vendors `cordis 4.0.5` and `schemastery 3.18.5`, and the existing `~4.0.4 || ~4.0.5-alpha.1` and `~3.18.4 || ~3.18.5-alpha.1` ranges already admit them.
5. Verified on a real host rather than inferred. In an isolated profile carrying the widened declaration, `--dump-config` no longer emits `skipping profile bundle`, the composed tree contains the plugin and its web-app patch, the host logs the plugin's own startup lines, and the plugin's LAN listener answers `/phone/health` with `200` and a `serverVersion` matching this package. The same profile was refused before the widening.
6. What a DSH release audit must probe is now recorded: the plugin's own LAN listener, not DSH's web port. `/phone/health` is served by a narrow listener that by design never inherits DSH's wider web/API route surface, so the web port answers 404 whether or not the plugin loaded; the earlier reading of that 404 as proof of non-activation was wrong and has been corrected in the compatibility and audit documents. The refusal evidence that did hold was the skip warning.
7. Protocol v2, pairing state, and device records are untouched by this release, so no paired phone needs to re-pair.
8. One existing TODO remains: an authenticated socket can replay its authentication proof and repeat welcome/replay delivery. This release does not claim that finding is fixed.
9. Release bookkeeping: the 0.9.6 publish workflow reported failure after its upload step succeeded — its final registry check hit a metadata-visibility delay and retried 12 times before giving up. The upload, dist-tag, and provenance were all correct. The handling is now written into `docs/NPM_PUBLISHING.md` so the next publish does not inherit a misleading red build.

## 二、简体中文

1. 新增支持 DSH `0.2.1-alpha.5` 作为第四个已审计宿主。`alpha` 分发标签当前指向它，`latest`/`next` 仍为 `0.2.0-rc.2`。只要插件声明了 `engines.dsh`，DSH 就只按该字段判定；未审计的宿主依旧「可见地拒绝激活」，而不是静默错行为。
2. 两处声明同一份四版闭集：`engines.dsh` 与全部十个 `@deepseek-ai/dsh*` peer 现均为 `0.2.0-rc.2 || 0.2.1-alpha.3 || 0.2.1-alpha.4 || 0.2.1-alpha.5`。旧宿主不认识 `engines.dsh`，继续按 peer 范围判定；npm 安装期只读 `peerDependencies`，因此两者必须一致。测试的对照集仍拒绝 `0.2.1-alpha.1`、`0.2.1-alpha.2`、`0.2.0`、`0.2.1-rc.1`、`0.2.1`、`0.3.0` 与 `1.0.0`，本次扩围没有变成宽范围。
3. 运行层结论：无破坏，也不需要改任何源码。十个 peer 包中九个 `lib/` 逐字节相同——含 `dsh-api-gateway` 与常驻交互客户端加载的全部 Client face，此前的修复全部继续有效。唯一变化的 `dsh-api-remotes` 落在 `account/getUnnotifiedBonuses` 结果 schema 内：新增一个可选 `title`，四个字段由必填放宽为可选，共 3 个 hunk、36 行，导出符号（`apply`、`inject`）完全一致。本插件不读取其中任何内容。
4. 两个 vendor peer 无需放宽，尽管它们都从预发布转正：alpha.5 vendored `cordis 4.0.5` 与 `schemastery 3.18.5`，现有 `~4.0.4 || ~4.0.5-alpha.1` 与 `~3.18.4 || ~3.18.5-alpha.1` 已经接受它们。
5. 在真实宿主上验证，而非推断：携带扩围后声明的隔离 profile 中，`--dump-config` 不再输出 `skipping profile bundle`，组合树包含插件及其对 web-app 的补丁，宿主日志出现插件自身的启动行，插件自己的 LAN listener 对 `/phone/health` 返回 `200` 且 `serverVersion` 与本包一致。同一个 profile 在扩围前是被拒绝的。
6. 本次还把「DSH 版本审计该探测哪个点」写进了文档：应探测插件自己的 LAN listener，而不是 DSH 的 Web 端口。`/phone/health` 由一个窄 listener 提供，按设计不继承 DSH 更宽的 Web/API 路由面，因此无论插件是否加载，Web 端口都返回 404；此前把该 404 读作「插件未激活」是错的，已在兼容性文档与审计记录中更正。真正成立的拒绝证据是 skip 警告。
7. 本版本未改动手机协议 v2、配对状态与设备记录，已配对手机无需重新配对。
8. 保留一项既有待办（TODO）：已认证连接重复提交认证证明仍会触发欢迎消息与重放。本次发布不宣称修复该问题。
9. 发布账目：0.9.6 的发布工作流在上传步骤成功后整体报失败——其末步注册表核对遇到元数据可见性延迟，重试 12 次后放弃；上传、分发标签与来源证明均正确。处置办法已写入 `docs/NPM_PUBLISHING.md`，避免下一次发布继承一个误导性的红色结论。

## 三、验证与发布边界

1. 本地发布清单在**隔离发布树**中执行（`release/0.9.7` 分支，自 `12d23b6` 派生，只含本版本改动，不含同期开发中的移动端功能改动）：`npm ci` 干净依赖安装通过；单元测试 564 项、563 通过、0 失败、1 项既有待办；`npm run typecheck` 通过；`npm run build` 重新生成的 `lib/` 与提交内容**逐字节相同**；`npm run check:config-schema` 针对锁定的 `0.2.0-rc.2` CLI 通过（`/34 → $defs/config19`，volatile 字段齐全）；helper 的 `go test ./...` 通过；`bin/SHA256SUMS` 的六个平台二进制校验和全部 OK；`npm pack --dry-run --json` 产出 `dsh-deeppilot-0.9.7.tgz`（68 个文件、解包约 124.8 MB、压缩约 48.6 MB），不含源码、测试与本地决策记录。
2. 激活验证在隔离 `DSH_HOME`（profile `alpha5verify`，其中 `dsh-deeppilot` 以符号链接指向本仓库，判定读到的就是仓库当前 `package.json`）上、对已发布的 `0.2.1-alpha.5` CLI 执行：改前该 profile 被拒绝激活并打印 21 行 skip 警告；扩围后 stderr 为 0 字节，组合树含 `# == dsh-deeppilot` 与 `# == @deepseek-ai/dsh-web-app, patched by dsh-deeppilot`，运行日志出现 4 行 `[deeppilot]` 输出，插件 LAN listener（3098）的 `/phone/health` 返回 200 与 `dataPlane:true`。宿主机进程已停止，3281 与 3098 端口均已释放。
3. 本次范围是公开插件；未进行 iPhone 真机、Funnel 通道与真实模型轮次的验证。手机协议零变化属源码级结论，不是设备实测。
4. 完整审计过程、证据与局限记录在 `docs/DSH_RELEASE_MEMORY.md` 的 `2026-10-16 — audit of dsh-v0.2.1-alpha.5` 小节；策略决策记录在 `docs/决策记录.md`（章节一，条目4），该文件是本地文档，不随包发布。
