# Issue 跟踪器：GitHub

本仓库的 issue 与需求规格都放在 GitHub Issues（`Mars-Sea/dsh-deeppilot`，**公开仓库**）。所有操作统一用 `gh` CLI。

公开 issue 任何人可见：不得写入私有 iOS 仓库的路径、代码、未公开计划，以及 `docs/adr/` 里的私有决策内容。纯 iOS 端的问题放私有 iOS 仓库（在 `../app-private` 里操作）。

## 约定

- **新建 issue**：`gh issue create --title "..." --body "..."`。多行正文用 heredoc。
- **读取 issue**：`gh issue view <number> --json number,title,body,labels,comments`。
- **列出 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需加 `--label` 与 `--state` 过滤。
- **挂为父 issue 的子 issue**：`gh issue create --parent <parent> ...`，或事后 `gh issue edit <parent> --add-sub-issue <child>`（`gh` 2.94+）。旧版 `gh`：`gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`（数据库 id，见下文 **阻塞关系**）。不支持子 issue 时，在子 issue 正文顶部写 `Part of #<parent>`。
- **评论**：`gh issue comment <number> --body "..."`
- **加 / 去标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

仓库由 `git remote -v` 推断；在本仓库目录内运行时 `gh` 会自动识别。

## Pull request 作为需求入口

**PRs as a request surface: no.**（若本仓库把外部 PR 当作功能请求处理，改为 `yes`；`/triage` 读取这个开关。）

设为 `yes` 时，PR 与 issue 走同一套标签和状态，用对应的 `gh pr` 命令：

- **读取 PR**：`gh pr view <number> --comments`，差异用 `gh pr diff <number>`。
- **列出待分诊的外部 PR**：`gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`。
- **评论 / 标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label` / `--remove-label`、`gh pr close`。

GitHub 的 issue 与 PR 共用一套编号，单独的 `#42` 可能是两者之一：先 `gh pr view 42`，失败再 `gh issue view 42`。

## 当技能要求「发布到 issue 跟踪器」

新建一个 GitHub issue。

## 当技能要求「读取相关工单」

按上文 **读取 issue** 的方式读取。

## Wayfinding 操作

供 `/wayfinder` 使用。**地图（map）** 是一个 issue，下挂若干 **子工单（child）** issue。

- **地图**：一个带 `wayfinder:map` 标签的 issue，正文包含 Notes / Decisions-so-far / Fog 三段。`gh issue create --label wayfinder:map`。
- **子工单**：以 GitHub 子 issue 方式挂到地图下（见 **挂为父 issue 的子 issue**）。不支持子 issue 时，把子工单加进地图正文的任务列表，并在子工单正文顶部写 `Part of #<map>`。标签：`wayfinder:<type>`（`research` / `prototype` / `grilling` / `task`）。认领后指派给当前推进的开发者。
- **阻塞关系**：使用 GitHub **原生 issue 依赖**，这是界面上可见的标准表示。加一条边：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是阻塞方的数字 **数据库 id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，不是 `#number`，也不是 `node_id`）。GitHub 通过 `issue_dependencies_summary.blocked_by` 报告仍未关闭的阻塞方（即实时门禁）。不支持依赖时，退回在子工单正文顶部写一行 `Blocked by: #<n>, #<n>`。所有阻塞方关闭后，该工单即解除阻塞。
- **前沿查询**：列出地图下未关闭的子工单（`gh issue list --state open`，限定在地图的子 issue / 任务列表内），剔除仍有未关闭阻塞方（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行里有未关闭 issue）或已有指派人的；按地图中的顺序取第一个。
- **认领**：`gh issue edit <n> --add-assignee @me`，作为本次会话的第一个写操作。
- **结案**：`gh issue comment <n> --body "<answer>"`，再 `gh issue close <n>`，然后在地图的 Decisions-so-far 段追加一条上下文指针（要点 + 链接）。
