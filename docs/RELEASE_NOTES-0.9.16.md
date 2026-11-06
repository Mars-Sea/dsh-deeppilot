# DeepPilot 0.9.16 — 同一 Wi-Fi 自动走局域网；远程连接更省流量、更快恢复

## 一、English

1. **The LAN listener is always on, and the phone picks the route itself.**
   The LAN switch is gone from the settings page; an old `local.enabled: false`
   setting no longer has any effect, and the port can still be changed. After
   each connection the plugin tells the app its current LAN addresses (private
   RFC1918 addresses only, physical interfaces first) with the certificate
   fingerprint, and the public Funnel address when Funnel is online
   (`welcome.routes`, capability `routeHints`). With the updated app, a phone
   on the same Wi-Fi connects over the LAN and falls back to Funnel elsewhere,
   without pairing again. Measured on the same Wi-Fi: about 0.33 s from
   connecting to usable over the LAN, versus 4.2 s through Funnel. A phone
   paired over the LAN also learns the public address, and a new LAN
   certificate fingerprint reaches it over an authenticated public connection,
   so it no longer needs to pair again. Widget connections do not receive
   routes.
2. **Session events go only to the sessions a phone is looking at.** A client
   that lists `watchSessions` on `c2s.auth.prove` (up to 16), or later sends
   `c2s.session.watch`, receives `s2c.session.event` / `s2c.session.queue` only
   for sessions it opened or watches, live and on reconnect replay
   (capability `sessionInterest`). Before, every session's events went to
   every phone: after 47 minutes offline a reconnect replayed about 450 frames
   and blocked list and pending requests for 37 s. Clients that do not declare
   a watch set keep receiving everything.
3. **A large replay becomes a resync.** When the replay window a connection
   would receive exceeds 512 KB, the plugin sends `s2c.resync` instead of
   replaying frame by frame. This applies to every client; existing apps
   already handle resync.
4. **Large frames are compressed.** A client that lists
   `acceptEncoding: ["deflate-raw"]` receives downlink frames over 8 KB as
   binary format 2 (`[2][raw DEFLATE of the envelope JSON]`, level 1;
   capability `compressedFrames`, PROTOCOL.md §1.2). The session list shrank
   from 78 KB to 12.4 KB in testing. Smaller frames and frames before
   authentication stay text.
5. **Reopening a session sends only what changed.** `c2s.session.open` accepts
   `sinceSeq`; the plugin answers with an incremental tail (`incremental:
   true`) holding rows changed after that sequence, including earlier tool
   calls whose result arrived later, or with a full tail when it cannot prove
   the delta complete (capability `incrementalTail`). Reopening a session that
   had not changed took 203 bytes instead of 44 KB.
6. **Session list pushes are de-duplicated and throttled.** An
   `s2c.sessions.delta` identical to the last one sent for a session is
   dropped; a change that touches only `stats` is sent at most once every
   5 seconds per session, with the latest values. Status, title, todos,
   pending flags and activity still go out immediately, carrying the latest
   stats.
7. Compatibility: still protocol v2; every addition is an optional capability,
   so older apps behave as before. No Funnel helper change. The DSH
   compatibility range stays `>=0.2.1-rc.5 <0.3.0-0`. If a firewall is on,
   allow inbound TCP on the LAN port (default `3098`).

## 二、简体中文

1. **局域网连接常开，手机自己选线路。** 设置页去掉了局域网开关，旧配置里的
   `local.enabled: false` 不再生效，端口仍可修改。每次连上后，插件把当前的局域网地址
   （只给 RFC1918 私有地址，物理网卡优先）连同证书指纹，以及 Funnel 在线时的公网地址
   告诉 App（`welcome.routes`，能力位 `routeHints`）。配合新版 App，同一 Wi-Fi 下手机
   自动走局域网，在外自动改走 Funnel，不需要重新配对。同一 Wi-Fi 实测：走局域网从开始
   连接到可用约 0.33 秒，经 Funnel 约 4.2 秒。通过局域网配对的手机也会拿到公网地址；
   局域网证书重建后的新指纹经已认证的公网连接下发，不再需要重新配对。小组件连接不带线路。
2. **会话事件只发给手机正在看的会话。** 客户端在 `c2s.auth.prove` 带上
   `watchSessions`（最多 16 个），或之后发 `c2s.session.watch`，就只会收到已打开或关注中
   的会话的 `s2c.session.event` / `s2c.session.queue`，实时推送和断线补发同一规则
   （能力位 `sessionInterest`）。此前每个会话的事件都发给所有手机：离线 47 分钟后重连，
   补发约 450 帧，会话列表与待处理请求被堵 37 秒。没有声明关注集合的客户端照旧全收。
3. **补发太大时改为重新同步。** 某个连接要补发的数据超过 512 KB 时，插件改发
   `s2c.resync`，不再逐帧补发。对所有客户端生效，现有 App 已支持重新同步。
4. **大帧压缩。** 客户端声明 `acceptEncoding: ["deflate-raw"]` 后，超过 8 KB 的下行帧
   改为二进制格式 2（`[2][整个信封 JSON 的 raw DEFLATE]`，level 1；能力位
   `compressedFrames`，见 PROTOCOL.md §1.2）。实测会话列表从 78 KB 降到 12.4 KB。
   小帧和认证前的帧仍是文本帧。
5. **重新进入会话只补改动过的消息。** `c2s.session.open` 可带 `sinceSeq`，插件回增量
   tail（`incremental: true`），只含该序号之后改动过的行，包括之后才收到结果的早先工具
   调用；无法证明增量完整时回全量（能力位 `incrementalTail`）。重开一个没有变化的会话
   实测只传 203 字节，此前为 44 KB。
6. **会话列表推送去重与节流。** 与上次推出内容完全相同的 `s2c.sessions.delta` 不再发送；
   只改了 `stats` 的变化，同一会话 5 秒内最多推一次，推出的是最新值。状态、标题、任务
   清单、待处理标记、活动描述的变化仍立即推送，并带上最新统计。
7. 兼容性：协议仍为 v2，新增内容都是可选能力位，旧版 App 行为不变。Funnel helper 未改。
   DSH 兼容范围仍为 `>=0.2.1-rc.5 <0.3.0-0`。启用防火墙时请放行局域网端口（默认 `3098`）
   的入站 TCP。
