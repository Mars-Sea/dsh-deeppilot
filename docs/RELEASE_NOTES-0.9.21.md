# DeepPilot 0.9.21

## 中文

- **手机端目标视图与完成通知**：会话摘要携带 Host 的目标投影，手机可以查看当前目标；目标达成时单独推送一次完成通知，并注册目标专属的实时活动，与单轮完成区分开。
- **会话摘要显示上下文窗口占用**：会话摘要新增可选的上下文占用字段，手机可据此显示已用比例与构成；数值缺失时保持未知，不显示为 0。
- **目录浏览要求会话管理权限**：`c2s.directory.list` 与 `c2s.directory.pick` 改为要求 `sessions.manage`，仅部分授权的设备不能再浏览电脑目录。
- **连接与预览通道更稳**：未认证连接最多占用 16 个名额中的 8 个，并发打开预览不再能超过 32 条上限；设备改名写盘失败时撤回内存改动并报错。
- **身份与注册表不再被误重建**：LAN TLS 私钥或设备注册表存在但读不出来时中止加载，不再覆盖原文件；注册表满时淘汰最早撤销的设备，已撤销设备重新配对不再被误拒。
- **本机预览端口完整匹配**：核对会话消息时要求端口完整出现，提到 `8080` 不再授权 `80`。
- **兼容**：协议仍为 v2，新增字段与能力位均为可选向后兼容扩展；旧版 App 不受影响，目标视图与上下文占用需搭配新版 App 显示。

## English

- **Goal view and completion notifications on the phone**: session summaries now carry the host's goal projection so the phone can show the current goal; reaching it sends a separate completion notification and registers a goal-specific Live Activity, distinct from a single turn finishing.
- **Context window usage in session summaries**: summaries gain optional context usage fields so the phone can show how full the window is and what fills it; missing values stay unknown instead of reading as zero.
- **Directory browsing requires session management**: `c2s.directory.list` and `c2s.directory.pick` now require `sessions.manage`, so partially authorized devices can no longer browse the computer's directories.
- **Steadier connections and preview channels**: unauthenticated connections may hold at most 8 of the 16 slots, concurrent preview opens can no longer exceed the 32-channel cap, and a failed device rename now rolls back the in-memory change and reports the error.
- **Identity and registry are no longer rebuilt by mistake**: an unreadable LAN TLS key or device registry now aborts loading instead of overwriting the file, and a full registry evicts the earliest revoked device so a revoked device can pair again.
- **Local preview matches the full port**: checking a session's messages now requires the whole port, so mentioning `8080` no longer authorizes `80`.
- **Compatibility**: still protocol v2 with every new field and capability bit optional and backward-compatible; older apps are unaffected, and the goal view and context usage need the updated app.
