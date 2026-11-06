# DeepPilot 0.9.16

## 中文

- **同一 Wi-Fi 自动走局域网**：局域网连接改为常开，设置页不再有开关；配合新版 App，在家自动直连（实测约 0.33 秒连上，经 Funnel 约 4.2 秒），出门自动改走 Funnel，无需重新配对。
- **只推送正在看的会话**：手机只收已打开或关注中会话的事件；断线后要补发的数据超过 512 KB 时改为整体重新同步，不再逐帧补发。
- **大消息压缩**：超过 8 KB 的消息压缩后发送，会话列表从 78 KB 降到 12.4 KB。
- **重进会话只补改动**：没有变化的会话重新打开只传约 200 字节，此前为 44 KB。
- **列表推送去重节流**：重复的列表更新不再发送，只改了统计数字的更新同一会话 5 秒最多一次。
- **安全修复**：Funnel helper 的依赖 `klauspost/compress` 升到 v1.20.2（GO-2026-6865）。
- **兼容**：协议仍为 v2，新增内容均为可选，旧版 App 行为不变，DSH 兼容范围不变；启用防火墙时请放行局域网端口（默认 3098）。

## English

- **Same Wi-Fi goes over the LAN**: the LAN listener is now always on and its switch is gone from settings; with the new app the phone connects directly at home (about 0.33 s versus 4.2 s through Funnel) and falls back to Funnel elsewhere, without pairing again.
- **Only the sessions you are looking at**: the phone receives events only for sessions it opened or watches; a reconnect replay larger than 512 KB becomes a full resync instead of a frame-by-frame replay.
- **Large messages are compressed**: messages over 8 KB are sent compressed, shrinking the session list from 78 KB to 12.4 KB.
- **Reopening a session sends only what changed**: reopening an unchanged session takes about 200 bytes instead of 44 KB.
- **Fewer session list pushes**: identical list updates are dropped, and updates that change only stats go out at most once every 5 seconds per session.
- **Security fix**: the Funnel helper's `klauspost/compress` dependency moves to v1.20.2 (GO-2026-6865).
- **Compatibility**: still protocol v2 with every addition optional, so older apps behave as before, and the DSH compatibility range is unchanged; with a firewall on, allow the LAN port (default 3098).
