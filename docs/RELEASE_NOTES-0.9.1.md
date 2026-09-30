# DeepPilot 0.9.1 — DSH 0.2.0-rc.2, forked sessions, and a debug toggle

## English

DeepPilot now targets **DSH `0.2.0-rc.2`**, fixes forked sessions disappearing
from the phone, and adds a working debug toggle to the settings page.

### Fixed: the plugin failed to install on DSH `0.2.0-rc.2`

DSH's own compatibility gate (`evaluatePluginCompatibility` in
`@deepseek-ai/dsh-app-boot`) checks every `@deepseek-ai/dsh*` peer range in a
plugin's `package.json` against the running host version and refuses to
activate the plugin when it does not match. Every previous release pinned
that range to the exact audited version (for example `"0.2.0-rc.1"`), so any
later host — `0.2.0-rc.2` included — failed the check on install, even though
nothing in the DSH APIs this plugin calls had actually changed.

### Changed: the DSH peer range now trusts the whole audited `0.2.x` line

`package.json`'s `peerDependencies` for all ten DSH packages moved from an
exact pin to `>=0.2.0-rc.2 <0.3.0-0`. Concretely:

- `0.2.0-rc.2` (the new floor), any later `0.2.x` release candidate, and the
  eventual `0.2.0` GA install without a plugin update.
- `0.2.0-rc.1` and every `0.1.x` release remain unsupported, same as before.
- `0.3.0` and its prereleases remain unsupported until a dedicated audit
  widens the range again — a `0.x` minor bump is allowed to contain breaking
  changes under semver, so it gets the same audit-first treatment the
  `0.1.x → 0.2.x` move got.

This is a deliberate policy change, not just a version bump: a clean DSH
release audit no longer has to be followed by a `package.json` edit before
users can install on it. The audit obligation itself is unchanged — every new
DSH release is still source-diffed against the last audited tag and recorded
in `docs/DSH_RELEASE_MEMORY.md`.

The development dependencies this branch builds and typechecks against stay
an exact pin (`0.2.0-rc.2`), since a range there would leave the build unable
to resolve one concrete set of type definitions.

### Fixed: sessions forked from the Web UI were invisible on the phone

A session created by forking another one (`c2s.session.fork`) carries
`parentSessionId` as fork lineage. The phone bridge treated *any* row with a
parent link as a subagent worker and filtered it out, so forked sessions never
appeared in the phone's session list — and their `turn/end` events were
silenced too, so completion notifications never arrived either. The bridge now
trusts only the host's explicit `origin === 'subagent'` marker, matching the
rule the live event stream already used.

### Added: a debug toggle that actually reaches the settings page

Verbose diagnostics (handshake and push logging) were controlled by a `debug`
config field that had no UI control, so it could only be turned on by editing
the config file by hand. It is now a switch under **Testing & troubleshooting**
on the DeepPilot settings page, stored as `diagnostics.debug`. It takes effect
immediately, needs no DSH restart, and still never prints pairing tokens, APNs
tokens, or message content.

**Upgrading note:** the old top-level `debug` field is gone. If you had set it
manually in the config file, that value no longer has any effect — turn the new
switch on instead. The setting page's switch is the only supported way to
enable verbose logging from this version on.

### Audit outcome: no breaking change

A source-level diff of `dsh-v0.2.0-rc.1...dsh-v0.2.0-rc.2` (187 commits) found
9 of the 10 peer packages source-identical to rc.1, one unrelated additive
remote mount in `dsh-api-remotes`, one additive method
(`TypertGatewayService.hasLiveClient()`) in `api/gateway` with the
`wireStream.open` argument order unchanged, and one internal string change in
`schedule/schedule`'s reminder-framing text with no exported signature
change. Full finding-by-finding detail is in
[`docs/DSH_RELEASE_MEMORY.md`](./DSH_RELEASE_MEMORY.md).

### Not changed

Protocol v2 is unchanged. Already-paired phones need no action. The Funnel
helpers, the relay client, push, widgets, and live activities are untouched.

### Verified before publishing

`npm ci`, unit tests (304 passing, including the rewritten compatibility-range
assertions and a new forked-session regression test), TypeScript typecheck,
production build, and the config-schema check against a real `0.2.0-rc.2` CLI
all pass locally. Go helper tests and the helper checksums also pass; the
helper binaries themselves are unchanged in this release. A live
`scripts/smoke-live.mts` run against a real `0.2.0-rc.2` host is the one
remaining release-only step, pending separate authorization before this
version ships.

---

## 简体中文

DeepPilot 现已面向 **DSH `0.2.0-rc.2`**，修复了分支会话在手机上不可见的问题，
并给设置页加上了真正可用的调试开关。

### 修复：插件此前在 DSH `0.2.0-rc.2` 上无法安装

DSH 自身的兼容性门禁（`@deepseek-ai/dsh-app-boot` 中的
`evaluatePluginCompatibility`）会拿插件 `package.json` 里每一个
`@deepseek-ai/dsh*` peer 的版本范围去比对正在运行的宿主版本，比对不上就拒绝激活。
此前每个版本都把这个范围精确锁定在审计过的那一个版本（例如 `"0.2.0-rc.1"`），
所以只要宿主换了更新的版本——包括 `0.2.0-rc.2`——安装时就会被拒绝，即便插件
实际调用的 DSH 接口根本没有变化。

### 变更：DSH peer 版本范围现在信任整条已审计的 `0.2.x` 线

`package.json` 里全部十个 DSH 包的 `peerDependencies` 从精确锁定改为
`>=0.2.0-rc.2 <0.3.0-0`。具体来说：

- `0.2.0-rc.2`（新的下限）、之后任意更新的 `0.2.x` 候选版本，以及未来的
  `0.2.0` 正式版，都无需更新插件即可安装；
- `0.2.0-rc.1` 及所有 `0.1.x` 版本仍然不受支持，与此前一致；
- `0.3.0` 及其候选版本仍然不受支持，需要专门的审计后才会再次放宽范围——
  按 semver 规则，`0.x` 的次版本号跳动允许包含破坏性变更，因此和当初
  `0.1.x → 0.2.x` 迁移一样，采取先审计、再放宽的做法。

这是一次刻意的策略调整，不只是版本号更新：以后 DSH 发新版本、审计结果干净
的情况下，不必再改 `package.json` 用户才能装上插件。审计义务本身没有变化——
每个新的 DSH 版本仍然会与上一个审计过的 tag 做源码级 diff，并记录在
`docs/DSH_RELEASE_MEMORY.md` 中。

本分支用于构建和类型检查的开发依赖仍然精确锁定在 `0.2.0-rc.2`，因为这里如果
改成范围，构建时就无法确定唯一一套具体的类型定义。

### 修复：Web 端创建的会话分支在手机上完全不可见

由另一个会话分支出来的会话（`c2s.session.fork`）会带上 `parentSessionId`
作为分支血缘。桥接层此前把**任何**带父会话链接的行都当成子代理（subagent）
工作会话过滤掉，导致分支会话永远不出现在手机端的会话列表里——而且它们的
`turn/end` 事件也被一并静音，连完成通知都收不到。现在桥接层只信任宿主显式给出的
`origin === 'subagent'` 标记，与实时事件流早已采用的判定规则保持一致。

### 新增：设置页上真正可用的调试开关

详细诊断日志（握手、推送等）此前由 `debug` 配置字段控制，但该字段没有任何
界面入口，只能手工改配置文件才能打开。现在它是 DeepPilot 设置页
**测试与故障排查** 分组下的一个开关，存储为 `diagnostics.debug`。改动立即生效，
不需要重启 DSH，且仍然不会打印配对令牌、APNs token 或消息内容。

**升级提醒：** 旧的顶层 `debug` 字段已被移除。如果你此前手工在配置文件里设置过
它，该取值不再有任何效果——请改用新的开关。从本版本起，设置页的开关是开启
详细日志的唯一受支持方式。

### 审计结论：无破坏性变更

对 `dsh-v0.2.0-rc.1...dsh-v0.2.0-rc.2`（187 个提交）做了源码级 diff：十个
peer 包里有九个与 rc.1 源码完全一致；`dsh-api-remotes` 新增了一个与本插件无关
的 remote 挂载；`api/gateway` 新增了一个纯增量方法
`TypertGatewayService.hasLiveClient()`，`wireStream.open` 的参数顺序未变；
`schedule/schedule` 里提醒任务的模型措辞文案有内部改动，但没有改变任何导出
签名。逐条发现详见 [`docs/DSH_RELEASE_MEMORY.md`](./DSH_RELEASE_MEMORY.md)。

### 未变更

协议 v2 没有变化，已配对的手机无需任何操作。Funnel helper、relay 客户端、
推送、桌面小组件与实时活动均未改动。

### 发布前已验证

`npm ci`、单元测试（304 例全部通过，含重写后的兼容性范围断言与新增的分支会话
回归用例）、TypeScript 类型检查、生产构建，以及针对真实 `0.2.0-rc.2` CLI 的
config schema 检查，均已本地通过。Go helper 测试与 helper 校验和同样通过；
本版本没有改动 helper 二进制本身。唯一剩余的发布类步骤是在真实
`0.2.0-rc.2` 宿主上跑一次 `scripts/smoke-live.mts`，需要单独授权后才会执行。
