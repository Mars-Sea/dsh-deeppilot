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
5. **2026-10-29 实测：当前绑定只允许暂存发布。** `publish.yml` 里的 `npm publish`
   不再直接公开版本，而是把它送进 staged 区（命令返回成功并提示“正在处理”，
   但注册表的版本、tarball 与来源证明持续 404）。用户决定**保留暂存流程**：
   每次发版由工作流暂存，维护者用 2FA 批准后才公开（步骤见第三节）。
   若要恢复直接发布，需在包设置的 Trusted Publisher 中勾选 `Allow npm publish`
   （账户强制 2FA 时可能不可用），并同步改本节、AGENTS.md 与第 4 步的核对逻辑。

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
6. **批准暂存版本（暂存模式下必需）。** 工作流把版本送进 staged 区后，由维护者完成
   2FA 批准：在 npmjs.com 的 **Staged Packages** 标签找到
   `dsh-deeppilot@<版本>` → Approve；或本机 `npm login` 后
   `npm stage list dsh-deeppilot` → `npm stage approve <id>`。
   批准即公开该版本，并按发布命令写入分发标签（`latest` / `alpha`）。
   工作流末尾「核对发布版本、包完整性与来源证明」在批准前必然 404 失败、整次运行标红；
   这是暂存模式的预期结果，不代表上传失败，发布证据以批准后的手工核验为准。
7. 确认 npm 包可安装，在全新 DSH 配置中完成安装验证后，再公开 GitHub 发布草稿。
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
   的可见性延迟，不是上传失败。该窗口已在 0.9.7 放宽：最多 24 次核对、间隔 5 秒
   线性递增并封顶 20 秒（约 7 分钟），仍然只读元数据、不重复上传包。这样既避免
   「上传成功 + 核对延迟」在 Actions 页留下误导性的红色结论，也不会把真正的失败
   伪装成成功——超出窗口依旧抛错。
6. `0.9.7` 是放宽窗口后的第一次发布，也是首次全绿的发布：工作流在附注标签
   `v0.9.7`（提交 `bf18755`）上运行，19 个步骤全部成功，包含此前两次失败的末尾
   核对。发布后核验：注册表 `latest = 0.9.7`、来源证明类型为
   `https://slsa.dev/provenance/v1`；在全新隔离 profile 中从 npm 安装该版本，并在
   真实 `0.2.1-alpha.5` 宿主上启动，`/phone/health` 返回 200 且 `serverVersion`
   为 `0.9.7`。公开 GitHub Release 之前先完成了这一步安装验证。
7. `0.9.8` 的本地发布清单在**待发布工作树**上执行并通过（详细数字见
   `docs/RELEASE_NOTES-0.9.8.md` 第三节）：`npm ci`、单元测试 581 项
   （580 通过、0 失败、1 项既有待办）、类型检查、构建前后 `lib/` 逐文件
   sha256 一致、`check:config-schema`（仍针对锁定的 `0.2.0-rc.2` CLI）、
   helper 的 Go 测试、`bin/SHA256SUMS` 6/6。宿主侧本轮改用
   **`0.2.1-rc.2`**：隔离 `DSH_HOME` 下改动前被拒绝激活（单键 `engines.dsh`
   要求 + `Exact-version exemption: not active`），扩围后组合树含插件与
   web-app 补丁、真实启动出现 4 条 `[deeppilot]`，插件自有端口 3098 的
   `/phone/health` 返回 200 且 `serverVersion` 为 `0.9.8`。打包为 68 个条目。
   本轮还确认了一个易漏点：升版本号必须同步重录
   `tests/apply-baseline.snapshot.json`，否则 `npm test` 会失败——已写入
   `AGENTS.md` 的发布流程第 1 步。
8. `0.9.8` 的实际发布结果（2026-10-18）：附注标签 `v0.9.8` 指向
   `f4551b61602e5e60b11565ae31ccba3257d3dc9e`，该提交的 CI 与 CodeQL 均为绿；
   `publish.yml` 在该标签上运行（运行号 `39048037503`，24 个步骤全部成功），
   注册表 `latest` 为 `0.9.8`。逐项核验：来源证明类型为
   `https://slsa.dev/provenance/v1`，其 `gitCommit` 正是该提交；压缩包 SHA1
   `8288977711e04679d077b970f863e726631fc309` 与 SHA512 与注册表一致；注册表
   条目数 68、解包 130,945,335 字节与发布前的打包核对一致，包内逐个文件与已验证
   的工作树逐字节相同。随后在全新隔离 profile 中从 npm 安装
   `dsh-deeppilot@0.9.8`，在真实 `0.2.1-rc.2` 宿主上完成组合与启动，插件自有端口
   3098 的 `/phone/health` 返回 200 且 `serverVersion` 为 `0.9.8`；GitHub Release
   在这一步通过后才公开并标记 Latest。

9. `0.9.9` 的实际发布结果（2026-10-21）：附注标签 `v0.9.9` 指向
   `feee5c5854cd598af7b7827c53ddffdec3199573`，该提交的 CI 与 CodeQL 均为绿。发布
   提交的首次 CI 曾因 helper 的 `govulncheck` 报 GO-2026-6809（Go 1.26.9 的
   `crypto/x509`，调用链可达）而失败，处理方式是 helper 升到 Go 1.26.10，由
   `build-helpers` 工作流重建六个二进制并合并刷新 PR（#30），之后才打标签。
   `publish.yml` 在该标签上运行（运行号 `39612245054`）：**上传与来源证明步骤成功，
   但最后的核对步骤在 24 次重试后仍抛 `读取 npm 发布信息失败（HTTP 404）`，整次运行
   结论为失败**——与 `0.9.5`、`0.9.6` 同一形态，说明 `0.9.7` 放宽的约 7 分钟窗口并非
   总是足够，注册表元数据的可见性延迟仍会超出它。事后人工核验：
   `npm view --prefer-online` 得到 `latest = 0.9.9`；来源证明类型为
   `https://slsa.dev/provenance/v1`，`gitCommit` 正是该提交，工作流引用为
   `refs/tags/v0.9.9`；压缩包 SHA1 `bfea9ade6be9eb07f209e0e76f5ea20326dc0ddb` 与 SHA512
   同注册表和来源证明主体一致，共 68 个条目，包内每个文件与已验证的工作树逐字节相同。
   随后在全新隔离 `DSH_HOME` 中从 npm 安装 `dsh-deeppilot@0.9.9`，在真实
   `0.2.1-rc.2` 宿主上用 `dsh web --no-open --port 0` 启动，`/phone/health` 返回 200，
   `serverVersion` 为 `0.9.9`；首次启动因另一个正在运行的 DSH 占用了宿主自己的 3080
   端口而失败，属环境冲突，不是插件问题。GitHub Release 在这一步通过后才公开并标记
   Latest。是否再放宽核对窗口，留待下次发布前决定，本次未改工作流。

10. `0.9.11` 的实际发布结果（2026-10-24）：附注标签 `v0.9.11` 指向
    `a12750c84f1c2ecd579f87f3b5d60507fa3a7112`，该提交的 CI（运行号 `40055850654`，
    4 分 42 秒）与 CodeQL（运行号 `40055850739`，2 分 20 秒）均为绿。`publish.yml`
    在该标签上运行（运行号 `40056208123`），**24 个步骤全部成功**，包含最后的
    「核对发布版本、包完整性与来源证明」——这一步在 `0.9.5`～`0.9.9` 多次因注册表
    可见性延迟而失败，本次一次通过。注册表核验：`latest = 0.9.11`；tarball SHA1
    `0a3e29b32beb393c7324d741602b5be1dc495d87`、SHA512 与来源证明主体一致、共
    68 个条目、解包 131,040,038 字节（与发布前 `npm pack --dry-run` 的
    `unpackedSize` 完全一致）；来源证明类型为 `https://slsa.dev/provenance/v1`，
    `gitCommit` 正是该发布提交，工作流引用 `refs/tags/v0.9.11`。
    **注册表可见性延迟仍然存在**：发布后约 3 分钟内
    `dsh-deeppilot-0.9.11.tgz` 持续返回 `HTTP 404`（第 10 次探测才变 200），
    因此用它做安装验证必须带重试。随后在全新隔离 `DSH_HOME`
    （`npm install dsh-deeppilot@0.9.11`，不是 link）中用真实 `0.2.1-rc.3` 宿主
    启动，插件日志出现 4 条 `[deeppilot]`，自有端口
    `https://127.0.0.1:3098/phone/health` 返回 200 且 `serverVersion` 为 `0.9.11`；
    GitHub Release 在这一步通过后才公开，并标记 Latest。
    **遗留处理：** `0.9.10` 的 GitHub Release 原为 Draft，按用户决定于本轮**删除**
    （远端标签 `v0.9.10` 与 npm 上的 `0.9.10` 包均保留，未做任何版本删除或回撤）。

11. `0.9.13` 的实际发布结果（2026-10-29/30）：附注标签 `v0.9.13` 指向
    `0107efb584be4031af7279eb9f6cdf4404189081`，该提交的 CI（运行号
    `40910195877`，7 分 27 秒）与 CodeQL（运行号 `40910195831`）均绿。
    `publish.yml` 首次运行 `40911590022` 的上传与来源证明步骤成功，但末尾核对在
    24 次重试后仍抛 `读取 npm 发布信息失败（dsh-deeppilot/0.9.13，HTTP 404）`，
    整次运行标红；重跑 `40918429580` 在发布步骤报
    `E409 Cannot publish over previously staged version "0.9.13"`。由此确认
    **当前绑定只允许暂存发布**，版本进入 staged 区后需维护者 2FA 批准（见第二节
    第 5 条与第三节第 6 步）。批准后注册表 `latest = 0.9.13`；来源证明类型为
    `https://slsa.dev/provenance/v1`、`gitCommit` 为该提交、工作流引用
    `refs/tags/v0.9.13`、invocation 为 `40911590022`；tarball SHA1
    `ca2c754e3421cddd14a795c5b4d869c5ea4b3cf9` 与 SHA512 同注册表一致，共 69 个
    条目、解包 131,263,175 字节。随后在全新隔离 `DSH_HOME` 中从 npm 安装
    `dsh-deeppilot@0.9.13`（pnpm 安装，不是 link），用真实 `0.2.2-alpha.2` 宿主
    启动，插件自有端口 3098 的 `/phone/health` 返回 200，`serverVersion` 为
    `0.9.13`、`dataPlane: true`；GitHub Release 在这一步通过后才公开并标记 Latest。
    暂存流程与批准步骤已写入第二、三节与 `AGENTS.md`；工作流末尾核对在暂存模式下
    的标红问题本轮未改，留待下次发布前决定是否检测 staged 后按成功处理。

## 五、官方资料

1. [npm 可信发布配置与限制](https://docs.npmjs.com/trusted-publishers/)
2. [npm 来源证明要求](https://docs.npmjs.com/generating-provenance-statements/)
3. [GitHub 手动运行工作流](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
4. [GitHub 工作流调度接口：运行引用支持分支或标签](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
