# Reply 3 — error-code follow-up for Discussion #12510

> Status: **posted 2026-11-11** → [discussioncomment-19543727](https://github.com/deepseek-ai/deepseek-harness/discussions/12510#discussioncomment-19543727), author `Mars-Sea`, `2026-11-11T14:33:05Z` (22:33:05 Asia/Shanghai). Published in the existing Discussion, following [PerryLink's 2026-11-11 comment](https://github.com/deepseek-ai/deepseek-harness/discussions/12510#discussioncomment-19540895). Only the English body below was posted; the Chinese notes were not. The online body was verified against the local body, allowing only terminal-newline normalization.
>
> Reviewed against the recorded DSH `0.2.2-rc.1` tests and pinned upstream source. This review did not rerun the update on a newer host.

## Reply body (English)

Thanks for checking the code path. The error code in our recorded DSH `0.2.2-rc.1` test was **`operation-error`**, at `result.stage: 'enable'`; it was not `incompatible-version`.

The original `dsh-deeppilot@0.9.15` → `0.9.16` report already includes that error-code excerpt. Both `result.error.code` and `restore.error.code` were `operation-error`, and the diagnostics named this collision (excerpt below, with line wrapping normalized):

```text
dsh: warning: 1 entry did not activate
deeppilot-directory-picker-browse (@deepseek-ai/dsh-host-directory-picker-browse):
Error: service "directoryPicker" has been registered at <NativeDirectoryPicker>
```

The target installation reached the enable stage after the package operation succeeded. Reinstalling the previous version also reported the collision. The profile returned to `0.9.15` on disk, which establishes disk restoration but does not establish that all runtime services recovered.

The later `0.9.15` → `0.9.19` three-way test is the separate follow-up summarized above: HMR enablement failed, whereas the no-HMR and stopped-host paths reached `0.9.19` and directory listing worked after restart. These are recorded `0.2.2-rc.1` results; we have not runtime-tested your referenced `e8f7b93a` commit.

I also need to correct my earlier “cheap detector” suggestion. [`managementError()` at e8f7b93a](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/boot/plugin-manager/src/index.ts#L110-L114) maps ordinary errors to `operation-error`. Combined with the enable stage and duplicate-service diagnostic, this identifies an activation collision, but it does not establish that the collision is temporary or that the target would start successfully after a restart. A safe `restart-required` fallback would need stronger checks and a defined policy for retaining the target on disk; changing the result status alone would not be sufficient.

I have consolidated the tested package, recorded results and source references into an issue-style draft, with those limits stated explicitly. Happy to test a candidate fix.

## 中文核对说明（不发布）

- 本轮直接回答错误码，使用最早 `0.9.15` → `0.9.16` 记录中可追溯的摘录；不把它与 `0.9.19` 复测拼成完整 JSON。
- 明确区分磁盘恢复、运行激活、客户端 journal 状态；不再声称“回滚后一定正常”或“客户端重试绝对无效”。
- 主动纠正上一轮已经发出的“廉价检测”建议：碰撞报错不等于冷启动有效的证明，不能据此直接把失败改为待重启。
- 不再向 PerryLink 追问路线图或渠道；他已明确不代表项目。本地完整材料建议留在现有讨论下，避免重复新开帖子。
- 完整报告见 [issue 形态草稿](UPSTREAM_ISSUE-DRAFT-updateBundle-hmr.md)，审核依据与剩余缺口见 [完整审核记录](UPSTREAM_12510_AUDIT.md)。
- 原始运行日志与完整返回文件当前不可用，因此没有承诺提供原始附件，也没有声称本轮重新运行了宿主。
