# DeepPilot 0.9.17

## 中文

- **@ 引用文件或会话**：在主机提供引用服务时，输入框 @ 后可补全当前工作目录的文件路径与其他会话，选中的文件只写进提示词、不附带文件内容。
- **工具操作对象不再丢失**：工作过程里工具完成后仍显示读的是哪个文件、执行了什么命令、搜了什么词或访问了哪个网址，不再只剩结果正文片段。
- **更多文件改动可对比**：此前只有部分编辑工具能看到改动对比，现在常用的字符串替换与整文件写入也会显示改了哪些内容。
- **权限档位多端同步**：在网页端或另一台设备改了当前会话的权限档位，手机输入框会及时刷新，不再停留在旧档位。
- **历史图片不再一直转圈**：适配新版宿主的图片读取接口，历史会话里的图片可以正常读回；搭配新版 App 时读回失败会显示原因并支持重试。
- **更新失败不再误报**：一键更新失败且宿主已自动装回旧版时，手机如实显示已恢复旧版，不再提示恢复未完成、需到电脑端检查。
- **兼容**：协议仍为 v2，新增内容均为可选，旧版 App 行为不变；上述新体验需搭配新版 App 才能完整生效。

## English

- **@ references for files and sessions**: on hosts that provide reference services, typing @ in the composer completes file paths in the working directory and other sessions; a picked file is inserted into the prompt as text only, never its contents.
- **Tool targets stay visible**: after a tool finishes, the work log still shows which file was read, which command ran, or which term or URL was used, instead of leaving only a snippet of the result.
- **Diffs for more edits**: the common string-replace and whole-file-write tools now also show what changed in the work log, where previously only some editing tools did.
- **Permission level stays in sync**: when the current session's permission level is changed on the web or another device, the phone's composer refreshes instead of keeping the stale level.
- **Images in history load again**: the plugin now speaks the host's current image-read API, so pictures in existing sessions no longer spin forever; with the new app, a failed read shows the reason and offers a retry.
- **Update failures are reported correctly**: when an update fails but the host has already restored the previous version, the phone now reports that the old version is back instead of claiming recovery is incomplete.
- **Compatibility**: still protocol v2 with every addition optional, so older apps behave as before; the new experiences above need the new app to take full effect.
