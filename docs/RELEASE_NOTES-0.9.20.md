# DeepPilot 0.9.20

## 中文

- **手机可打开电脑端网页**：经预览连接，手机可以直接打开电脑上的 DSH 网页端，登录地址由插件下发，令牌不写入日志。
- **设置页新增开关**：「允许手机打开电脑端网页」默认关闭，关掉后已经打开的网页通道会在下一次数据传输时断开。
- **授权更精细**：新增 `hostweb.open` 权限，旧版全量授权的设备在载入与配对时自动补上；未授权或功能关闭时会给出明确的拒绝原因。
- **兼容**：协议仍为 v2，新增内容均为向后兼容扩展；旧版 App 不受影响，使用电脑端网页需搭配新版 App。

## English

- **Open the desktop web UI from the phone**: over the preview connection the phone can open the DSH web UI running on your computer, with the sign-in address issued by the plugin and the token never written to logs.
- **New settings switch**: "Allow phone to open the desktop web UI" is off by default, and turning it off closes any open web channel on its next data transfer.
- **Finer-grained authorization**: a new `hostweb.open` permission is added automatically to fully authorized devices on load and pairing, and requests are refused with a clear reason when it is missing or the feature is off.
- **Compatibility**: still protocol v2 with all additions backward-compatible; older apps are unaffected, and using the desktop web UI requires the updated app.
