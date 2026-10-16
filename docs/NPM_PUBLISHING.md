# npm 可信发布说明

## 一、发布方式

1. `.github/workflows/publish.yml` 使用 GitHub 托管的运行器，通过
   OpenID Connect（OIDC，开放身份连接）向 npm 获取临时发布凭据；无需配置
   `NPM_TOKEN` 或 `NODE_AUTH_TOKEN`。来源证明（Provenance）将关联公开仓库、
   工作流和本次运行的源码提交。
2. 工作流仅由 `workflow_dispatch`（手动触发）启动；推送提交、标签或创建
   GitHub Release（发布页）不会自动上传 npm 包。手动运行须使用对应版本标签，
   不能在 `main` 上运行后另行检出标签，否则来源证明的提交会与源码不一致。
3. 发布环境使用 Node.js 22 与固定的 npm `11.21.0`；npm 官方要求可信发布至少使用
   npm `11.5.1` 和 Node.js `22.14.0`。稳定版使用 `latest`（稳定分发标签），
   预发布版使用 `alpha`（预发布分发标签），与原有发布策略一致。

## 二、npm 网站绑定

1. 将工作流合入默认分支 `main` 后，打开
   [dsh-deeppilot 包设置](https://www.npmjs.com/package/dsh-deeppilot/access)，
   在 Trusted Publisher（可信发布者）区域选择 GitHub Actions（GitHub 工作流）。
2. 按下表配置，字段大小写必须一致：

   | npm 字段 | 含义 | 填写值 |
   | --- | --- | --- |
   | Organization or user | GitHub 组织或用户 | `Mars-Sea` |
   | Repository | 仓库名称 | `dsh-deeppilot` |
   | Workflow filename | 工作流文件名 | `publish.yml` |
   | Environment name | 部署环境名称 | 留空，本工作流未使用部署环境 |
   | Allow npm publish | 允许直接发布 | 勾选 |
   | Allow npm dist-tag | 允许独立修改分发标签 | 无需勾选，工作流通过发布命令设置标签 |

3. 工作流文件名只填 `publish.yml`，不填 `.github/workflows/` 前缀。
   新建绑定默认只允许暂存发布（`npm stage publish`），须明确允许 `npm publish`。
   npm 不在保存配置时验证绑定；首次发布成功才证明认证可用。
4. 新绑定必须在 **2 天内完成首次成功发布**。因此准备好新版本后再绑定；若过期，
   删除过期绑定并重新创建。先验证可信发布成功，再按需调整原有令牌发布权限。

## 三、每次发布

1. 按项目 `AGENTS.md` 的发布清单完成验证，同时更新 `package.json`、
   `package-lock.json` 顶层与根包条目的版本；提交并推送，等待持续集成（CI）通过。
   版本提交必须已经进入 `main`，且该提交包含 `publish.yml`。
2. 经用户授权发布该版本后，从精确的发布提交创建并推送附注标签 `v<版本>`，
   准备包含英文与简体中文说明的 GitHub 发布草稿。
3. 在对应标签上手动运行工作流。下例的 `0.9.5` 仅为示例，替换为已授权发布的版本：

   ```sh
   gh workflow run publish.yml --repo Mars-Sea/dsh-deeppilot --ref v0.9.5 \
     -f version=0.9.5 -f dist_tag=latest
   ```

   预发布示例：

   ```sh
   gh workflow run publish.yml --repo Mars-Sea/dsh-deeppilot --ref v0.9.5-alpha.1 \
     -f version=0.9.5-alpha.1 -f dist_tag=alpha
   ```

4. 工作流验证输入、标签、两处锁文件版本、包仓库与运行提交一致；拒绝轻量标签、
   尚未合入 `main` 的提交、分发标签错配和构建元数据。随后执行依赖安全检查、
   插件测试、类型检查、构建产物一致性检查、DSH 配置校验、Go 测试和辅助程序校验和。
5. 工作流检查包内容并生成压缩包，再发布该压缩包，显式要求来源证明。
   压缩包发布跳过生命周期脚本（`--ignore-scripts`）；测试、类型检查和构建已在前序
   步骤执行，打包仍执行 `prepack`（打包前构建）。发布后核对版本、分发标签、
   压缩包完整性和来源证明元数据。
6. 确认 npm 包可安装，在全新 DSH 配置中完成安装验证后，再公开 GitHub 发布草稿。
   工作流不自动公开发布草稿；npm 上传和发布后的核对分别记录在步骤中。

## 四、失败处理与证据边界

1. 认证失败先核对 npm 绑定中的仓库、大小写、`publish.yml` 和直接发布权限。
   `npm whoami`（当前账号查询）不能验证 OIDC 发布权限。
2. 若 npm 上传成功而后续核对失败，先检查注册表；已存在的版本不能通过重跑覆盖。
   排查来源证明或分发标签后再决定下一步，禁止把核对失败直接当作上传失败。
   发布核对会绕过元数据缓存并有限重试；人工查询使用 `npm view --prefer-online`，
   以免继续读取发布前的旧版本列表或缓存的 404 响应。
3. 本地语法检查、测试和打包不能证明 npm 绑定已生效；真实 OIDC 认证与来源证明
   需要首次获授权的新版本发布才能验证。已有旧版本的认证状态不因新增工作流改变。
4. `0.9.5` 已完成首次 OIDC 身份认证发布；npm 绑定显示 `Valid`（有效），
   来源证明签名、压缩包摘要与两个支持宿主的注册表安装核验通过。首次运行的末尾
   核对因缓存失败，其上传步骤成功；发布证据及边界见 `docs/DSH_RELEASE_MEMORY.md`。
5. `0.9.6` 复现了同一形态：OIDC 上传与来源证明步骤成功，紧随其后的核对步骤在
   12 次重试后仍抛 `读取 npm 发布信息失败（dsh-deeppilot/0.9.6，HTTP 404）`，
   整次运行结论因此为失败。事后核验 `npm view dsh-deeppilot dist-tags --prefer-online`
   得到 `latest = 0.9.6`、发布时间与该版本的来源证明均齐全，确认根因是注册表元数据
   的可见性延迟，不是上传失败。下一次发布前应放宽该步骤的重试窗口（或改为指数退避），
   避免「上传成功 + 核对延迟」在 Actions 页持续留下误导性的红色结论。

## 五、官方资料

1. [npm 可信发布配置与限制](https://docs.npmjs.com/trusted-publishers/)
2. [npm 来源证明要求](https://docs.npmjs.com/generating-provenance-statements/)
3. [GitHub 手动运行工作流](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
4. [GitHub 工作流调度接口：运行引用支持分支或标签](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
