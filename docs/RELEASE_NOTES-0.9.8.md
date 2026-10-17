# DeepPilot 0.9.8 — 移动端技能提示与系统指令，兼容 DSH rc.2

## 一、English

1. Support DSH `0.2.1-rc.2` as a fifth audited host. The npm `next` channel now
   points at it, while `latest` still names `0.2.0-rc.2` and `alpha` still names
   `0.2.1-alpha.5`. As before, an unaudited host refuses to activate this plugin
   visibly: DSH reads a declared `engines.dsh` alone and reports the refusal
   instead of letting the plugin misbehave quietly.
2. Both declarations name the same five releases: `engines.dsh` and all ten
   `@deepseek-ai/dsh*` peers now read `0.2.0-rc.2 || 0.2.1-alpha.3 ||
   0.2.1-alpha.4 || 0.2.1-alpha.5 || 0.2.1-rc.2`. `0.2.1-rc.1` is deliberately
   still refused: it was never audited on its own and `rc.2` superseded it about
   five hours later, so admitting it would break the rule that the list names
   exactly the releases this branch has been audited against. Older hosts do not
   know `engines.dsh` and keep evaluating the peer range, and npm reads only
   `peerDependencies` at install time, so the two must agree. The test's contrast
   sets still refuse `0.2.1-alpha.1`, `0.2.1-alpha.2`, `0.2.0`, `0.2.1-rc.1`,
   `0.2.1-rc.3`, `0.2.1`, `0.3.0`, and `1.0.0`.
3. Runtime verdict: this release changes no code the plugin calls. All ten peer
   packages ship a byte-identical `lib/` tree, 137 modules keep an identical set
   of exported symbols, and across the fifteen packages compared every one of the
   255 value differences — 245 dependency specs plus 10 `version` fields — is a
   version or a range, with zero structural difference. The only
   non-`package.json` difference is one additive entry in
   `dsh-web-app`'s `cordis.patch.yml` (+3 lines adding a
   `ui-deepseek-model-label-1017` bundle, which carries this release's
   DeepSeek-V4.1-Flash-1017 model support); the plugin's own patch anchor
   (`id: directory-picker`) is byte-identical at lines 113–114, and the plugin
   names the new package nowhere.
4. The two vendor peers still need no widening: `0.2.1-rc.2` vendors the same GA
   pair as `0.2.1-alpha.5` (`cordis 4.0.5`, `schemastery 3.18.5`), and the
   existing `~4.0.4 || ~4.0.5-alpha.1` and `~3.18.4 || ~3.18.5-alpha.1` ranges
   already admit both.
5. The audit also closed a methodology gap. Comparing only `lib/` would have
   missed `dsh-web-app/cordis.patch.yml` — the one file this plugin actually
   patches. Whole-tree comparison is now the required first step of a DSH release
   audit, recorded in `docs/DSH_RELEASE_MEMORY.md`.
6. Mobile skills: the bridge gains `c2s.session.skills` → `s2c.session.skills`
   behind the optional `skills` capability bit, invalidated by
   `s2c.skills.changed`. It sends only a skill's name, description and whether the
   model may invoke it — never skill paths or bodies — and requires
   `sessions.read`; widget connections cannot call it. A skill the model may not
   invoke stays user-invocable and is labelled that way instead of being hidden.
7. Mobile host commands: `c2s.session.commands`, `c2s.session.command`,
   `c2s.session.permissions`, `c2s.session.feedback`, and `c2s.session.export`
   behind the optional `commands` capability bit, plus `s2c.models.changed` so a
   host-side model switch reaches the phone. Six host commands are reachable, and
   the model, file, permission and feedback entries open native pickers instead
   of the web UI. Starting a command is a separate channel from sending a prompt,
   so executing one creates no user message; a name the host does not recognise
   is never sent to the model.
8. Log export reuses the host's shared Fetch route rather than building a chat
   archive by hand, and streams it in sequenced chunks of at most 48 KiB with
   backpressure above 256 KiB and a ten-minute timeout; a disconnect requires the
   user to start over, and chunks never enter the resume replay buffer. The phone
   verifies sequence, chunk length, final session, chunk count and total bytes
   before opening the system share sheet. Command attachments are capped at four
   and validated against the command's own declaration first.
9. A new `command` error domain separates "this command does not exist"
   (`E_NOT_FOUND`) from a host-side failure (`E_INTERNAL`), keeps the gateway's
   session rejections (agent busy, writer held, conflict) at `E_BUSY`, and reports
   a missing capability as `E_UNSUPPORTED`. Before this change the whole domain
   collapsed to `E_INTERNAL`, so the phone could not tell the user whether to
   re-pick a command, refresh the catalog, drop an attachment, or retry.
10. Both surfaces are optional and capability-gated: a bridge that does not
    declare `skills` or `commands` keeps exactly the previous behaviour. No phone
    needs to re-pair — this release does not touch protocol v2, pairing state or
    device records; every new frame is an optional v2 extension, and the client
    side adopts them on its own schedule.
11. Clients may cache the three rebuildable catalogs (skills, host commands and
    the model catalog) in memory and on disk, keyed by pairing identity, host,
    address, audience, TLS fingerprint, session and catalog kind. Credentials,
    permission values, command results, feedback, log archives and skill bodies
    never enter that cache. The cache is a client-side design recorded in
    `docs/移动端目录缓存.md`; this package only serves the catalogs it stores.
12. One existing TODO remains: an authenticated socket can replay its
    authentication proof and repeat welcome/replay delivery. This release does not
    claim that finding is fixed.

## 二、简体中文

1. 新增支持 DSH `0.2.1-rc.2` 作为第五个已审计宿主。npm 的 `next` 通道当前指向
   它，`latest` 仍是 `0.2.0-rc.2`，`alpha` 仍是 `0.2.1-alpha.5`。与既有行为一致，
   未审计宿主会「可见地拒绝激活」：DSH 只读插件声明的 `engines.dsh` 并报出拒绝
   原因，而不是让插件静默错行为。
2. 两处声明同一份五版闭集：`engines.dsh` 与全部十个 `@deepseek-ai/dsh*` peer
   现均为 `0.2.0-rc.2 || 0.2.1-alpha.3 || 0.2.1-alpha.4 || 0.2.1-alpha.5 ||
   0.2.1-rc.2`。`0.2.1-rc.1` **明确仍然拒绝**：它从未单独受审，且约五小时后就被
   `rc.2` 取代，放行它会破坏「白名单只列已审计版本」这条规则。旧宿主不认识
   `engines.dsh`，继续按 peer 范围判定；npm 安装期只读 `peerDependencies`，
   因此两者必须一致。测试的两组对照集（peer 与 `engines.dsh` 的并集）仍拒绝
   `0.2.1-alpha.1`、`0.2.1-alpha.2`、`0.2.0`、`0.2.1-rc.1`、`0.2.1-rc.3`、
   `0.2.1`、`0.3.0` 与 `1.0.0`。
3. 运行层结论：本版本不涉及插件所调用代码的任何变化。十个 peer 包的 `lib/` 逐
   字节相同，137 个模块的导出符号集合完全一致；比对的十五个包里 255 处取值差异
   （245 处依赖范围 + 10 处 `version` 字段）**全部**是版本号或范围取值，结构差异
   为零。唯一的非 `package.json` 差异是
   `dsh-web-app` 的 `cordis.patch.yml` 新增一条（+3 行，
   `ui-deepseek-model-label-1017` bundle，承载本版本的
   DeepSeek-V4.1-Flash-1017 模型适配）；本插件自己的补丁锚点
   （`id: directory-picker`）在两版都是第 113–114 行逐字相同，且插件全文没有
   提到这个新包。
4. 两个 vendor peer 仍无需放宽：`0.2.1-rc.2` 与 `0.2.1-alpha.5` vendored 同一对
   GA 版本（`cordis 4.0.5`、`schemastery 3.18.5`），现有
   `~4.0.4 || ~4.0.5-alpha.1` 与 `~3.18.4 || ~3.18.5-alpha.1` 已经接受它们。
5. 本次审计还补上了一个方法论缺口：只比 `lib/` 会漏掉
   `dsh-web-app/cordis.patch.yml`——而它恰是本插件真正打补丁的那个文件。整树比对
   现已定为 DSH 版本审计的必做首步，记录在 `docs/DSH_RELEASE_MEMORY.md`。
6. 移动端技能：桥接新增 `c2s.session.skills` → `s2c.session.skills`，由可选能力位
   `skills` 门控，并由 `s2c.skills.changed` 失效通知。只下发技能的**名称、说明与
   模型是否允许调用**，不下发技能路径或正文；请求需要 `sessions.read`，小组件连接
   不可调用。模型不可调用的技能仍然允许用户调用，界面按此标注，而不是被隐藏。
7. 移动端系统指令：`c2s.session.commands`、`c2s.session.command`、
   `c2s.session.permissions`、`c2s.session.feedback`、`c2s.session.export` 由可选
   能力位 `commands` 门控，另有 `s2c.models.changed` 让主机侧切换模型能推到手机。
   六个主机指令可达，模型、文件、权限与反馈入口打开原生选择器而非网页界面。起始
   指令与普通消息分通道，执行指令不会创建普通用户消息；主机不认识的名称绝不发给
   模型。
8. 日志归档复用主机已有的共享 Fetch 路由，而不是自制聊天摘要包；按序号分块下发，
   每块最多 48 KiB，输出缓冲超过 256 KiB 时等待，十分钟超时；断线需用户重新发起，
   分块不进入重放缓存。手机在核对序号、块长度、最终会话、块数与总字节之后才打开
   系统分享。指令附件最多四个，且发送前先按指令自身的声明校验。
9. 新增 `command` 错误域，把「指令不存在」（`E_NOT_FOUND`）与主机侧故障
   （`E_INTERNAL`）分开，把上游 Gateway 的会话类拒绝（智能体忙、写入占用、冲突）
   保持在 `E_BUSY`，能力缺失报 `E_UNSUPPORTED`。改动前整个域被压成 `E_INTERNAL`，
   手机无法判断该让用户重选指令、重拉目录、去掉附件，还是重试。
10. 两个面都是可选且由能力位门控：未声明 `skills` 或 `commands` 的桥接保持原有
    行为不变。手机无需重新配对——本版本未改动协议 v2、配对状态与设备记录，新增帧
    全部是 v2 的可选扩展，客户端按自己的节奏接入。
11. 客户端可把三种可重建元数据（技能、主机指令、模型目录）同时缓存在内存与磁盘，
    键包含配对身份、主机、地址、audience、TLS 指纹、会话与目录种类。凭据、权限
    当前值、指令执行结果、反馈、日志归档与技能正文**不进入**该缓存。缓存是客户端
    侧设计，记录在 `docs/移动端目录缓存.md`；本包只提供它所缓存的目录数据。
12. 保留一项既有待办（TODO）：已认证连接重复提交认证证明仍会触发欢迎消息与重放。
    本次发布不宣称修复该问题。

## 三、验证与发布边界

1. 本地发布清单在**待发布的工作树**（含本轮移动端功能与兼容放行）上执行，全部通过：
   `npm ci` 干净依赖安装退出码 0；单元测试 **581 项、580 通过、0 失败、1 项既有
   待办**（`tests/auth-hardening.test.ts` 的认证证明重放）；`npm run typecheck`
   通过；`npm run build` 通过且构建前后 `lib/` 逐文件 sha256 **完全一致**；
   `npm run check:config-schema` 针对锁定的 `0.2.0-rc.2` CLI 通过；helper 的
   `go test ./...` 通过（`go1.26.9`）；`bin/SHA256SUMS` 六个平台二进制校验和
   6/6 OK。
2. 版本推进同时重录了 `tests/apply-baseline.snapshot.json`（`RECORD=1 npx tsx
   --test tests/apply-baseline.test.ts`），差异只有六处
   `serverVersion`/`pluginVersion`，无任何其他字段或行为漂移。该文件是版本号载体
   之一，发布流程已补记这一步，避免下次再漏。
3. 激活验证在隔离 `DSH_HOME` 上、对已发布的 `0.2.1-rc.2` CLI 执行。**改动前**该
   profile 被拒绝激活：stderr 含 `incompatible with dsh 0.2.1-rc.2: requirements
   {"engines.dsh":…}` 与 `Exact-version exemption: not active.`，组合树 1229 行里
   没有任何 `deeppilot` 行，`--dump-config` 退出码 0。**扩围后**：`--dump-config`
   stderr 为空、组合树 1240 行，含 `# == dsh-deeppilot`（第 1233 行）与
   `# == @deepseek-ai/dsh-web-app, patched by dsh-deeppilot`（第 449 行）；真实
   启动无 skip 警告、日志出现 4 条 `[deeppilot]`，插件自有监听端口 3098 的
   `/phone/health` 返回 200，`serverVersion` 为 `0.9.8`、`protocolVersion` 为 2。
4. 判据校准（控制组）：同一个隔离 home、同一棵插件树，只把 CLI 换成
   `0.2.1-alpha.5`，插件正常加载且 3098 应答 200。该控制组最初运行在 0.9.7 版本树
   上，因此当时读到 `serverVersion` 为 `0.9.7`；在最终树上重跑同一控制组读到
   `serverVersion` 为 `0.9.8`。两次都证明拒绝确实来自兼容性判定，而不是插件损坏，
   负向探针有判别力。`/phone/health` 打在 DSH web 端口返回 404 **无判别力**，
   本版本不作为证据。
5. 篡改对照：在临时副本上删掉 `engines.dsh` 里的 `0.2.1-rc.2` 后，rc.2 重新被拒
   且只报单个 `engines.dsh` 要求（`exempted: false`）；恢复后重新被接受。工作区
   内 `package.json` 改动前后哈希一致，临时改动没有留在工作区。
6. `npm pack --dry-run --json`：68 个条目、解包 130,945,335 字节、压缩包
   50,968,023 字节；不含源码、测试、`.rc2-verify/`、`.dsh-home-*`、夹具与任何
   凭据文件，压缩包内 `lib/` 与工作区逐字节一致。与 0.9.7 相比条目数同为 68，
   解包体积增加 74,466 字节、压缩包增加 21,156 字节（增量来自 `lib/` 三件产物、
   `COMPATIBILITY.md`、`docs/DSH_RELEASE_MEMORY.md`、`docs/NPM_PUBLISHING.md`、
   两个 README 与 `package.json`；本发布说明不在 `files` 白名单内，不进包）。
   四份客户端对接文档不进包，属 `files` 白名单既有设计。
7. 本次范围是公开插件与桥接协议；**未**进行 iPhone/Android 真机、Funnel 端到端
   与真实模型轮次验证。客户端侧的技能目录缓存、原生选择器与系统分享属客户端实现，
   本包只提供目录数据；「协议 v2 未变」是源码级结论，不等于设备实测。与调用面
   无关的约七十个上游包未逐文件比对。
8. 完整审计过程、证据与局限记录在 `docs/DSH_RELEASE_MEMORY.md` 的 rc.2 审计小节；
   策略决策记录在 `docs/决策记录.md`（章节一，条目5），该文件是本地文档，不随包
   发布。发布动作本身（推送、标签、GitHub Release、npm OIDC 发布与注册表核对）
   的结论在本文件之外另行记录。
