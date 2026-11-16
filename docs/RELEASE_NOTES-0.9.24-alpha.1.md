DeepPilot 0.9.24-alpha.1

## 中文

- **独立目录浏览测试版**：手机添加项目时由 DeepPilot 提供只读目录列表，避免热更新时与电脑端目录选择器发生服务注册冲突。
- **保留目录选择与权限**：继续支持电脑原生选择器和既有设备权限，电脑端恢复 DSH 默认的目录选择方式。
- **手测范围**：请重点验证旧版升级、手机浏览并添加项目、重连，以及插件关闭后重新启用；本版仅发布 npm `alpha`，不创建 GitHub Release。
- **兼容性**：保持现有 DSH 兼容范围与手机协议，真实手机界面、Windows 实机和原生弹窗仍需手动验收。

## English

- **Independent directory browser preview**: DeepPilot supplies the phone's read-only project directory listing, avoiding directory-picker service registration conflicts during hot updates.
- **Directory selection and permissions preserved**: The optional native chooser and existing device permissions remain available, while the desktop uses DSH's default directory-picker behavior.
- **Manual testing scope**: Check upgrades from the previous version, phone directory browsing and project adoption, reconnection, and disabling then enabling the plugin; this build is published only to npm `alpha`, without a GitHub Release.
- **Compatibility**: Existing DSH compatibility and phone protocol remain unchanged; physical-phone UI, Windows filesystem, and native-dialog behavior still require manual verification.
