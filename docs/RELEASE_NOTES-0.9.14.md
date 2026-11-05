# DeepPilot 0.9.14 — DSH 兼容声明改为滚动区间（支持 DSH 0.2.1-rc.5 及之后），并适配 0.2.2-alpha.3 的宿主级计划任务；导出与附件改用二进制分块帧；工具行附带文件改动对比

## 一、English

1. **One rolling compatibility range replaces the eight-release closed list.**
   `engines.dsh` and all ten `@deepseek-ai/dsh*` peers now name
   `>=0.2.1-rc.5 <0.3.0-0`. The lower bound is the newest `rc` release (npm
   `latest` and `next` both point at `0.2.1-rc.5`, published 2026-10-29); every
   later `0.2.x` release activates without editing the declaration, including
   the current `alpha` channel release `0.2.2-alpha.2` and later alphas. The
   bound is written `<0.3.0-0` because DSH evaluates the range with
   `semver.satisfies(version, range, { includePrerelease: true })`, where
   `<0.3.0` would admit `0.3.0-rc.1`.
2. **`0.2.1-rc.5` is audited and admitted.** The full-tree audit against
   `0.2.1-rc.4` found **no runtime break**: 307 = 307 packages, 42,421 of 42,731
   shared files byte-identical, zero structural manifest changes (3,706
   dependency specs are mechanical `rc.4 → rc.5` replacements), the evaluator
   `dsh-app-boot/lib/index.js` byte-identical to rc.4, the
   `id: directory-picker` patch anchor byte-identical, and all 3,271 `lib/`
   modules plus 681 entry modules with unchanged export surfaces. The 15
   non-manifest files (14 changed, 1 added) live in the host's client
   chat/translation surface, a build-commit constant, and version strings —
   none is in this plugin's declaration or call surface.
   An isolated rc.5 host composes the plugin, starts it, and answers
   `/phone/health` with 200.
3. **The build baseline moves to `0.2.1-rc.5`.** The five typechecked DSH dev
   packages are pinned to the exact `0.2.1-rc.5` release, and the vendored dev
   packages move to `cordis 4.0.5` / `schemastery 3.18.5` (the pair rc.5 hosts
   vendor; keeping the older pins makes npm fail with `ERESOLVE`). The
   config-schema check now runs against the `0.2.1-rc.5` CLI.
4. **One visible behaviour change.** Hosts below the new lower bound — the seven
   releases the previous list admitted (`0.2.0-rc.2`, `0.2.1-alpha.3/4/5`,
   `0.2.1-rc.2/3/4`) — are refused by the activation gate after upgrading the
   plugin. Upgrading the host to any release inside the range restores it.
5. **The bridge protocol stays v2; two optional capabilities are added.**
   `welcome.capabilities.schedulesHost` with seven new schedule frames
   (`c2s.schedule.host.list` / `view` / `create` / `edit` / `run` /
   `deleteEnded` / `limits`),
   and `welcome.capabilities.binaryFrames` (item 8), are additive: an older App
   ignores them and keeps the per-session frames and base64 text frames, and
   the plugin's own `engines.node` stays `>=22`. No config field changed.
6. **Schedule is adapted to the DSH 0.2.2-alpha.3 host-level model.** That
   release rewrote `dsh-schedule` (no `update`/`delete`, `edit` replaces them,
   paginated `list`, `timing`/`target` request body), which broke the phone's
   schedule list/create/edit/delete while history kept working. The plugin now
   chooses one of two adapters by service shape, not by version string: the
   legacy per-session path is untouched, and the host-level path adds the
   capability and frames above while projecting the legacy frames onto
   host-level tasks, so an older App keeps schedule list, create, edit and
   delete on that host. Pulse-free details: legacy views filter to the target
   session, drop `ended`, skip `rrule` (the old kind enum has no equivalent),
   and detect conflicts by comparing the full `expected` record; new frames
   carry `expectedUpdatedAt`. `c2s.schedule.host.deleteEnded` removes every
   ended task on the host in one call (paused and active tasks stay) and
   replies with the `deletedEnded` count; the App asks for confirmation first.
   The wire contract is in `PROTOCOL.md`.
7. **Large attachments no longer drop the phone's connection.** The attachment
   read-back sent a whole image as one base64 text frame; apps before this
   release only accept frames up to 1 MiB, so an original above roughly
   768 KiB disconnected the phone and made it reconnect in a loop.
   `c2s.session.attachment` now takes an optional `maxFrameBytes` (1 MiB when
   absent). When the estimated frame exceeds `min(maxFrameBytes, 2 MiB)` the
   plugin answers the new error code `E_TOO_LARGE` instead of sending it, and it
   waits for the send buffer to drain before each image. Visible effect: an
   older App shows a placeholder for images above roughly 768 KiB instead of
   disconnecting.
8. **Export and attachments can use binary chunked frames.** The plugin
   declares `welcome.capabilities.binaryFrames` (a plugin capability, not a
   Host one). A request carrying `binary: true` gets binary frames —
   `[format u8 = 1][header length u32 BE][header JSON][raw bytes]`, see
   `PROTOCOL.md` §1.1 — with no base64 overhead: `c2s.session.export` sends
   256 KiB blocks (text frames stay 48 KiB) with the same final receipt, and
   `c2s.session.attachment` streams `s2c.session.attachment.chunk` frames
   followed by a `{ mediaType?, chunks, bytes }` receipt, up to 12 MiB per
   image (larger originals get `E_TOO_LARGE`). Requests without `binary` are
   byte-for-byte unchanged; a non-boolean `binary` is `E_PROTOCOL`. The Funnel
   helper passes binary WebSocket frames through unchanged.
9. **Tool rows carry the file change.** For the host `str_replace_editor`
   `str_replace` / `create` / `insert` calls, the plugin normalizes the
   arguments into an optional `tool.edit`
   (`{path, operation, oldText?, newText?, insertLine?, truncated?}`) on both
   live `tool.start` events and history pages, so the App can show a line diff
   in the conversation. Either side above 16 KiB (UTF-8) sends only the path,
   operation and `truncated: true`. The field is additive with no capability
   bit; older Apps ignore it and `tool.summary` is unchanged.

10. **Phones paired before 0.8.3 can use automations.** Their stored scopes
   predate `schedule.manage`, and reconnecting never adds new scopes, so every
   automation request failed with `E_FORBIDDEN` (`scope schedule.manage
   required`). On load, the plugin now adds `schedule.manage` to any
   non-revoked device whose scopes are exactly the five pre-0.8.3 defaults and
   writes the registry back; any other set is left as stored. No re-pairing
   needed.

**Verification:** `npm test` 706 tests (704 pass, 1 environment-gated skip, 1
intentional TODO, 0 fail); `typecheck`; `build` (regenerated `lib/`); the
config-schema check against the `0.2.1-rc.5` CLI; `smoke:helper` on
darwin-arm64; `go test ./...`; `bin/SHA256SUMS` 6/6; an isolated `0.2.1-rc.5`
host that composes, starts, and answers `/phone/health` with 200. Not covered:
real iPhone pairing, Funnel end-to-end, and model turns.

## 二、简体中文

1. **八版精确枚举改为一条滚动区间。** `engines.dsh` 与全部十条
   `@deepseek-ai/dsh*` peer 现在统一为 `>=0.2.1-rc.5 <0.3.0-0`。下界是当前
   最新的 `rc` 版本（npm `latest` 与 `next` 均指向 `0.2.1-rc.5`，2026-10-29
   发布）；其后的所有 `0.2.x` 版本无需改动声明即可激活，包括当前 `alpha` 通道的
   `0.2.2-alpha.2` 及之后的 alpha。上界写成 `<0.3.0-0` 是因为 DSH 用
   `semver.satisfies(version, range, { includePrerelease: true })` 评估，
   `<0.3.0` 会放行 `0.3.0-rc.1`。
2. **`0.2.1-rc.5` 已审计并放行。** 与 `0.2.1-rc.4` 的整树审计结论是
   **运行层无破坏**：307 = 307 个包，42,731 个共同文件中 42,421 个逐字节相同，
   manifest 结构变化为 0（3,706 处依赖 spec 只是 `rc.4 → rc.5` 的机械替换），
   判定器 `dsh-app-boot/lib/index.js` 与 rc.4 逐字节相同，`id: directory-picker`
   补丁锚点逐字节相同，全树 3,271 个 `lib/` 模块与 681 个入口模块导出面零变化。
   15 个非清单差异文件（14 个改动 + 1 个新增）落在宿主的客户端对话/翻译面、
   构建提交号与版本串上，都不在本插件的声明面或调用面。隔离的 rc.5 宿主已实测：
   插件可组合、可启动，`/phone/health` 返回 200。
3. **构建基线升到 `0.2.1-rc.5`。** 五个参与类型检查的 DSH 开发包精确钉到
   `0.2.1-rc.5`，vendor 开发包同步升到 `cordis 4.0.5` / `schemastery 3.18.5`
   （rc.5 宿主 vendored 的正是这一对；沿用旧版本会让 npm 报 `ERESOLVE`）。
   config schema 检查改用 `0.2.1-rc.5` CLI。
4. **一处用户可见的行为变化。** 低于新下界的宿主——上一份名单放行的七版
   （`0.2.0-rc.2`、`0.2.1-alpha.3/4/5`、`0.2.1-rc.2/3/4`）——在升级插件后会被
   激活门拒绝；把宿主升到区间内的任意版本即可恢复。
5. **桥接协议仍为 v2，新增两个可选能力位。** `welcome.capabilities.schedulesHost`
   及七个新帧（`c2s.schedule.host.list` / `view` / `create` / `edit` / `run` /
   `deleteEnded` / `limits`），以及 `welcome.capabilities.binaryFrames`（见第 8 条），都是追加式
   扩展：旧 App 忽略它们，继续用会话级帧和 base64 文本帧；插件自身的
   `engines.node` 仍是 `>=22`，配置字段没有改动。
6. **计划任务适配 DSH 0.2.2-alpha.3 的宿主级模型。** 该版本重写了 `dsh-schedule`
   （没有 `update`/`delete`，由 `edit` 取代；`list` 改为分页对象；请求体改为
   `timing` / `target`），导致手机端计划任务的列表/新建/编辑/删除失效、历史仍可用。
   插件现在按**服务形状**（有 `edit`、无 `update`）而不是版本号选择适配器：旧宿主
   路径逐字节不变；宿主级路径新增上述能力位与新帧，并把旧帧映射到宿主级任务，
   使旧 App 在该宿主上仍能列表/新建/编辑/删除。旧视图过滤当前会话目标、丢弃
   `ended`、跳过 `rrule`（旧 kind 枚举没有对应值），冲突保护用完整 `expected` 记录
   逐字段比较；新帧用 `expectedUpdatedAt`。`c2s.schedule.host.deleteEnded` 一次删除宿主上
   全部已结束任务（暂停与运行中的不受影响），回执带删除条数 `deletedEnded`；App 先二次
   确认再发送。线上契约见 `PROTOCOL.md`。
7. **大图附件不再导致手机断线。** 附件回读原来把整张图 base64 后放进一个文本帧；
   本版之前的 App 只收 1 MiB 以内的帧，原图超过约 768 KiB 就会断线并反复重连。
   `c2s.session.attachment` 新增可选字段 `maxFrameBytes`（缺省按 1 MiB）；估算帧
   超过 `min(maxFrameBytes, 2 MiB)` 时回新错误码 `E_TOO_LARGE` 而不下发，每张图
   发送前等发送缓冲排空。用户可见：旧 App 遇到约 768 KiB 以上的图片显示占位图，
   不再断线。
8. **导出与附件支持二进制分块帧。** 插件在 `welcome.capabilities` 声明
   `binaryFrames`（插件自身能力，不依赖宿主）。请求带 `binary: true` 时改发二进制帧——
   `[格式 u8 = 1][头部长度 u32 大端][头部 JSON][原始字节]`，见 `PROTOCOL.md` §1.1——
   省去 base64 开销：`c2s.session.export` 每块 256 KiB（文本帧仍为 48 KiB），最终
   回执不变；`c2s.session.attachment` 连续下发 `s2c.session.attachment.chunk`，最后
   回执 `{ mediaType?, chunks, bytes }`，单张原图上限 12 MiB（超过回 `E_TOO_LARGE`）。
   不带 `binary` 的请求逐字节不变；`binary` 非布尔回 `E_PROTOCOL`。Funnel helper
   原样转发二进制 WebSocket 帧。
9. **工具行附带文件改动。** 对宿主 `str_replace_editor` 的 `str_replace` / `create` /
   `insert` 调用，插件把参数归一化为可选字段 `tool.edit`
   （`{path, operation, oldText?, newText?, insertLine?, truncated?}`），实时 `tool.start`
   与历史分页都带，App 据此在会话里显示行级对比。任一侧正文超过 16 KiB（UTF-8）时只发
   路径、操作与 `truncated: true`。追加式扩展、不设能力位，旧 App 忽略，`tool.summary` 不变。

10. **0.8.3 之前配对的手机可以用自动化任务了。** 这些设备存的权限早于 `schedule.manage`，
   重连也不会补新权限，所以自动化任务的请求一律回 `E_FORBIDDEN`（`scope schedule.manage
   required`）。插件载入设备注册表时，对权限恰好等于 0.8.3 之前五项默认的未撤销设备补上
   `schedule.manage` 并写回；其他组合原样保留。无需重新配对。

**验证：** `npm test` 706 项（704 通过、1 项环境门禁跳过、1 项有意 TODO、
0 失败）；`typecheck`；`build`（重新生成 `lib/`）；config schema 检查（针对
`0.2.1-rc.5` CLI）；`smoke:helper`（darwin-arm64）；`go test ./...`；
`bin/SHA256SUMS` 6/6；隔离 `0.2.1-rc.5` 宿主上插件成功组合、启动，
`/phone/health` 返回 200。**未覆盖：** 真机配对、Funnel 端到端、模型回合。

## 三、本地发布清单（待发布工作树）

在版本号 `0.9.14`、`tests/apply-baseline.snapshot.json`（只改 6 处版本字段）、
`package-lock.json` 根条目与重新生成的 `lib/` 就绪后执行：`npm ci`、
`npm test`、类型检查、构建、`check:config-schema`（针对锁定的 `0.2.1-rc.5`
CLI）、`smoke:helper`（darwin-arm64）、`go test ./...`、`bin/SHA256SUMS` 校验、
六平台 helper 重建与 `bin/` 漂移检查，以及 `npm pack --dry-run --json` 的条目
核对。

**本地检查不能证明**：OIDC 可信发布、来源证明、全新 profile 从 npm 安装、
`latest` 分发标签的实际指向，以及 rc.5 宿主上的真实业务回合。这些在发布后核验，
并记入 `docs/NPM_PUBLISHING.md` 与 `docs/DSH_RELEASE_MEMORY.md`。
