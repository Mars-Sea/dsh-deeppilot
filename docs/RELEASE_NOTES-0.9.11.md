# DeepPilot 0.9.11 — 支持 DSH 0.2.1-rc.3，更正 npm 通道描述

## 一、English

1. **DSH compatibility: `0.2.1-rc.3` is now an admitted host.** The npm `next`
   channel moved from `0.2.1-rc.2` to `0.2.1-rc.3`, and DSH evaluates a
   plugin's declared requirements before composing a profile on **every start**,
   not only at install time. A host the declaration does not name refuses to
   activate the whole plugin, which is what users on `0.2.1-rc.3` hit: the
   plugin was skipped with `skipping profile bundle "dsh-deeppilot"` and never
   loaded. `engines.dsh` and the ten `@deepseek-ai/dsh*` peers now name the same
   six exact releases — `0.2.0-rc.2`, `0.2.1-alpha.3`, `0.2.1-alpha.4`,
   `0.2.1-alpha.5`, `0.2.1-rc.2`, and `0.2.1-rc.3` — still by exact
   enumeration, with no `>=` range. `0.2.1-rc.1` remains refused: it was never
   audited as its own host.
2. **The audit behind it, at artifact level.** Nineteen packages were compared as
   whole trees between `0.2.1-rc.2` and `0.2.1-rc.3`: 3,275 of 3,302 shared files
   are byte-identical, 274 modules show no export-surface change, and the
   dependency manifests hold zero structural differences. The three
   non-`package.json` changes are additive or comment-only — a client telemetry
   schema extension this plugin neither emits nor validates, one JSDoc comment,
   and one added `ui-entry-customization` bundle in the web-app patch layer. The
   patch anchor this plugin targets, `id: directory-picker`, is byte-identical on
   both sides, and the plugin's own patch does not reference the new package.
3. **The positive path was verified, not assumed.** On an isolated `0.2.1-rc.3`
   host — its own `DSH_HOME`, the plugin linked from the working tree, no other
   plugin — the plugin composes into the tree, starts, and answers
   `/phone/health` with HTTP 200 on its own LAN listener (`protocolVersion` 2,
   data plane active). The same profile with the old declaration only printed the
   skip line, which is what makes the pair discriminative.
4. **An outdated channel description was corrected.** The npm channels have
   moved: `latest` now points at `0.2.1-rc.2` (promoted from `next`) and
   `next` at `0.2.1-rc.3`, while `alpha` stays at `0.2.1-alpha.5`. Earlier
   documents called `0.2.0-rc.2` the `latest` channel; that no longer
   holds. The admitted list is unchanged by this correction — only its wording.
5. No protocol change (bridge protocol v2), no Funnel helper change, no config
   field change; `/phone` and `/phone/health` stay compatible with the current
   iOS client.

## 二、简体中文

1. **DSH 兼容性：`0.2.1-rc.3` 已加入放行清单。** npm 的 `next` 通道从
   `0.2.1-rc.2` 改指 `0.2.1-rc.3`，而 DSH 在**每次启动**组合 profile 之前都会
   校验插件声明的兼容要求（不只是安装时）。声明里没有的宿主会拒绝激活整个插件，
   这正是 `0.2.1-rc.3` 用户遇到的情况：插件被打出
   `skipping profile bundle "dsh-deeppilot"` 并整包跳过，从未加载。
   `engines.dsh` 与 10 条 `@deepseek-ai/dsh*` peer 现在同时精确列出六个版本——
   `0.2.0-rc.2`、`0.2.1-alpha.3`、`0.2.1-alpha.4`、`0.2.1-alpha.5`、
   `0.2.1-rc.2`、`0.2.1-rc.3`——仍是精确枚举，不使用 `>=` 宽范围。
   `0.2.1-rc.1` 继续拒绝：它从未作为独立宿主被审计。
2. **支撑这次放行的构件级审计。** 把 `0.2.1-rc.2` 与 `0.2.1-rc.3` 的 19 个包按**整树**
   比对：3302 个共同文件里 3275 个逐字节相同，274 个模块的导出面零变化，依赖清单
   结构差异为 0。三处非 `package.json` 差异全部是加性扩写或注释——插件既不发送也不
   校验的客户端埋点 schema 扩展、一处 JSDoc 注释、web-app 补丁层新增的
   `ui-entry-customization` 条目。插件自身补丁锚点 `id: directory-picker` 在两侧逐字
   相同，插件补丁也没有引用新增包。
3. **正向加载是实测过的，不是推断。** 在隔离的 `0.2.1-rc.3` 宿主上（独立
   `DSH_HOME`、插件 link 到工作树、无其他插件），插件成功组合进配置树、启动，并在
   自己的局域网监听端口上让 `/phone/health` 返回 HTTP 200（`protocolVersion` 2、
   数据面已激活）。同一 profile 用旧声明只会打印 skip 行，这组对照使结论有判别力。
4. **更正了一处过期的通道描述。** npm 通道已经移动：`latest` 现指向 `0.2.1-rc.2`
   （由 `next` 转正）、`next` 指向 `0.2.1-rc.3`，`alpha` 仍是 `0.2.1-alpha.5`。此前文档
   把 `0.2.0-rc.2` 描述为 `latest` 通道，已不成立。本次只改描述，放行清单不变。
5. 协议不变（桥接协议 v2），Funnel helper 不变，配置字段不变；`/phone` 与
   `/phone/health` 继续兼容当前 iOS 客户端。

## 三、本地发布清单（待发布工作树）

在版本号 `0.9.11`、`tests/apply-baseline.snapshot.json`（只改 6 处版本字段）与重新生成
的 `lib/` 就绪后执行：`npm test`、类型检查、构建、`check:config-schema`（针对锁定的
`0.2.0-rc.2` CLI）、`smoke:helper`（darwin-arm64），以及 `npm pack --dry-run --json`
的条目核对。本轮未改 helper 源码与构建输入，故不重建 `bin/` 矩阵，也不跑
`npm ci`；CI 会重建矩阵并在 `bin/` 漂移时失败。

**本地检查不能证明**：OIDC 可信发布、来源证明、全新 profile 从 npm 安装、
`latest` 分发标签的实际指向。这些在发布后核验，并记入
`docs/NPM_PUBLISHING.md` 与 `docs/DSH_RELEASE_MEMORY.md`。
