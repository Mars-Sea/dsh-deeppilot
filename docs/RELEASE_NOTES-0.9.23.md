# DeepPilot 0.9.23

## 中文

- **会话资源与成果文件**：手机可以查看本轮生成的文件、带进度的文件清单和改动差异，过期或二进制内容会明确标注而不是静默省略。
- **项目文件浏览**：会话详情新增只读的项目文件浏览，可按相对路径逐层查看并搜索；该入口默认关闭，需在插件设置页手动开启。
- **继续生成与目标管理**：空会话可直接点继续而不留空消息，也能在手机上创建、暂停、恢复和清除会话目标。
- **原生控制**：长按、复制会话内容等操作改由 App 原生界面承担，结果以回执确认，未知结果不会自动重发。
- **兼容**：协议仍为 v2，新能力全部是可选追加项，旧版 App 会隐藏对应入口并照常工作，升级后无需重新配对。

## English

- **Session resources and deliverables**: the phone can now show the files a turn produced, a deliverable list with progress, and per-turn diffs, with expired or binary content labelled explicitly instead of silently omitted.
- **Project file browsing**: a read-only file browser and search in session details, walking folders by relative path. It is off by default and turned on from the plugin settings page.
- **Continue and goals**: continue an empty session without leaving an empty message, and create, pause, resume or clear a session goal from the phone.
- **Native controls**: long-press and copy actions for session content are rendered by the app's own interface, confirmed by a receipt; an unknown outcome is never resent automatically.
- **Compatibility**: still protocol v2. Every new capability is an optional addition, so older apps hide the new entries and keep working, and no re-pairing is needed after upgrading.
