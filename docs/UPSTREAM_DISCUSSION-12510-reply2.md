# Reply draft — discussion #12510 (round 2, after PerryLink's comment)

> Status: **posted 2026-11-11** → https://github.com/deepseek-ai/deepseek-harness/discussions/12510#discussioncomment-19532694
> (author `Mars-Sea`, posted 2026-11-11T01:25:09Z, 3217 chars; the English body below is what was
> posted, the Chinese notes at the end were **not** posted). Replies to PerryLink's 2026-11-09
> comment. No local paths, device IDs, hostnames or tokens; generic profile names only.
>
> User decisions applied: keep the "cheap detector" paragraph in follow-up 2 (PerryLink's own comment
> cites exact line numbers, so concrete detection guidance fits the thread); do **not** attach the
> `pnpm.log` excerpts, keeping the "available on request" wording.

---

## Reply body (English)

Thanks — that matches what we measured, and we ran the three-way test you suggested with the
exact bundle before replying further.

Setup: fresh isolated `DSH_HOME`, three profiles created from `--from-default-profile web`
(`dsh-base` + `dsh-web-app`, so `directory-picker` = `-auto`), each installed as a registry spec
`dsh-deeppilot@0.9.15`, target `0.9.19` (current `latest`). Our bundle patch is unchanged from the
report: a `disabled: true` row on `directory-picker` plus an inserted
`@deepseek-ai/dsh-host-directory-picker-browse` backend and its client surface. Driven over the
authenticated phone WebSocket, so each `apply` is a real `pluginManager.updateBundle` call.

| # | Profile | HMR | Update path | Result |
|---|---|---|---|---|
| 1 | `pu-hmr` | on | `updateBundle` | **fails + rolls back.** `installBundle` → `application: 'failed'`, `stage: 'enable'`, duplicate `directoryPicker`; `restore` fails with the same error. Journal `failed`, profile stays `0.9.15` |
| 2 | `pu-nohmr` | off (`hmr` row `disabled: true`) | `updateBundle` | **succeeds via restart.** Progress `restart-required`; profile on disk `0.9.19`; after a host restart `serverVersion 0.9.19`, journal `done` |
| 3 | `pu-cli` | on, but host stopped | `dsh plugin --profile <p> add dsh-deeppilot@0.9.19` | **succeeds.** No composition window; next boot composes once, `serverVersion 0.9.19`, no activation warnings |

So to answer your framing: this is **not** "this patch cannot survive any update". Both
non-HMR paths apply the change and the `disabled` + `insert` pair survives intact — in scenario 2
and 3 `host.listDirectory` still returns a listing (`s2c.directory.listing`) after the update, i.e.
the browse backend is still the mounted one. Only the HMR `remove → install` window breaks it,
because that window is exactly the composition state where the `disabled` row is absent and `-auto`
re-activates.

Two follow-ups:

1. **Is a compose-before-remove step (or a delta apply) on the roadmap for `updateBundle`?**
   Scenario 1 is currently an update that *always* fails and rolls back for any bundle whose patch
   targets a row another plugin owns — the user sees a failure for an update that would have worked
   on the next boot. If it is not planned, please consider documenting that in the
   `plugin-manager` README next to `updateBundle`, so bundle authors know a `disabled` row makes
   the bundle "cold-update only" under HMR.
2. **If online replace is inherently unsupported for such bundles, can it return
   `restart-required` instead of `failed` + rollback?** That is actionable for a client: the update
   *did* land or *would* land on restart, and a `restart-required` result would avoid the
   remove/restore churn entirely. Our client already has a `restart-required` state (it is what
   scenario 2 reports), so this would be a clean, non-breaking improvement.

If it helps, the concrete detector for case 2 is cheap: during the install, a duplicate-service
failure from an entry that the *incoming* layer added — as opposed to the target package failing to
load at all — is the signal that this is a "needs cold compose" case rather than a broken package.
Happy to test a build that carries either change.

---

## 中文说明（供你核对，不随英文正文发布）

**复测事实（本次实测得到的硬数据）**

- 三组都用确切 bundle：`dsh-deeppilot@0.9.15`（含 `disabled` + `insert` 的原始 patch）→ 目标 `0.9.19`（当前 `latest`）。
- 场景 1（HMR 开）：`failed` + 回滚，profile 停 `0.9.15`。
- 场景 2（HMR 关）：`restart-required`，磁盘 `0.9.19`，重启后 `serverVersion 0.9.19`、journal `done`，`s2c.directory.listing` 正常。
- 场景 3（停机 CLI）：直接 `0.9.19`，启动无激活告警，目录功能正常。
- 结论：PerryLink 说的「值得测一次」已经被回答——**patch 能存活非 HMR 更新**，问题只在 HMR 在线替换窗口。

**措辞取舍**

- 开头「Thanks — that matches what we measured」：先认可对方，再给数据，避免显得对抗。
- 明确引用他的原话框架（"the difference between 'the update path is wrong' and 'this patch cannot survive any update'"），直接给出结论：属前者。
- 表格用场景编号，便于他对照 `:749` / `:756` 分支。
- 第 1 个追问用「是否在路线图上 + 至少补文档」，给出软硬两条路，不强求他承诺改代码。
- 第 2 个追问给出可行性理由（客户端已有 `restart-required` 状态，改动非破坏性）和一个廉价的检测思路，降低他接受成本。
- 未包含本机路径、设备 ID、端口、令牌；profile 名用 `pu-*` 抽象名，不暴露个人环境。
- 未提我方 0.9.17–0.9.19 的内部情况，避免把讨论引向第三方仓库细节。

**提交前需你确认**

- 已确认：保留第 2 条的「廉价检测思路」（PerryLink 回复本身引用具体行号，讨论属协作性质，可操作判据有利于被采纳）。
- 已确认：不附 `pnpm.log` 片段，维持「可按需提供」。
- 已于 2026-11-11 发布（[discussioncomment-19532694](https://github.com/deepseek-ai/deepseek-harness/discussions/12510#discussioncomment-19532694)）。
