DeepPilot 0.9.24

## 中文

- **手机目录浏览独立**：手机添加项目时由 DeepPilot 自己提供只读目录列表，不再依赖或替换电脑端的目录选择器。
- **修复热更新失败**：插件更新不再因为目录选择器重复注册而激活失败，更新后不必重新安装或回滚。
- **电脑端恢复默认**：电脑端目录选择恢复 DSH 默认的 native/browse 方式，手机浏览与电脑选择互不影响。
- **兼容性**：保持现有 DSH 兼容范围与手机协议，真实手机界面与 Windows 实机行为仍需手动验收。

## English

- **Independent phone directory browsing**: The phone's add-project flow uses DeepPilot's own read-only directory listing instead of depending on or replacing the desktop directory picker.
- **Hot updates fixed**: Plugin updates no longer fail to activate because the directory-picker service was registered twice, so an update no longer needs a reinstall or a rollback.
- **Desktop default restored**: Desktop directory selection returns to DSH's default native/browse behavior, independent of what the phone browses.
- **Compatibility**: The existing DSH compatibility range and phone protocol are unchanged; physical-phone UI and Windows filesystem behavior still need manual verification.