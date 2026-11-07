# 工单系统：GitHub Issues

本仓库的规格和工单都放在 GitHub Issues（`bilixuesheng/SeekCloud`）。

## 用什么工具

- **Claude Code 云端会话**：用 GitHub MCP 工具（`mcp__github__*`）。云端会话里没有 `gh` 命令。
- **本地**：可以用 `gh`，效果一样。

## 约定

- **规格**：一个 issue，标题以"规格："开头。
- **工单**：每张工单一个 issue，挂在所属规格下面作为子 issue（`issue_write` 创建时传 `parent_issue_number`，或者用 `sub_issue_write`）。用不了子 issue 时，在正文第一行写 `Part of #<规格编号>`。
- **阻塞关系**：优先用 GitHub 原生的 issue 依赖（blocked by）。工具不支持时，在正文开头写一行 `Blocked by: #<n>, #<n>`。一张工单的所有阻塞项都关闭后，它就可以开工。
- **读**：`issue_read`（`get`、`get_comments`、`get_sub_issues`）。
- **列**：`list_issues`，按标签和状态筛选。
- **评论**：`add_issue_comment`。评论末尾照常加 Claude Code 的署名。
- **加减标签**：`issue_write` 的 `update`，传完整的 `labels` 列表。
- **关闭**：
  - 实现工单的 PR 正文写 `Closes #<n>`，合并时自动关闭。
  - 不经过 PR 关闭的，先评论说明原因，再用 `issue_write` 把 `state` 设为 `closed`，并写上 `state_reason`。

只往本仓库提 issue，不要提到 `mattpocock/skills`。

## 把 PR 当作需求来源

**PRs as a request surface: no.**（设为 `yes` 时，`/triage` 会把外部 PR 当成需求，走同一套标签和状态。）

## 技能里说"发布到工单系统"时

新建一个 GitHub issue。

## 技能里说"取对应的工单"时

按上面"读"的方式读 issue 正文和评论。
