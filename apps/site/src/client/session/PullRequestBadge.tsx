import type { PullRequestRef, PullRequestState } from "@seekcloud/protocol";
import type { ReactNode } from "react";
import { ClosedPullRequestIcon, MergedIcon, PullRequestIcon } from "../Icons";
import { type PlainKey, t } from "../i18n";

const labels: Record<PullRequestState, PlainKey> = {
  open: "pr.open",
  draft: "pr.draft",
  merged: "pr.merged",
  closed: "pr.closed",
};

const icons: Record<PullRequestState, (size: number) => ReactNode> = {
  open: (size) => <PullRequestIcon size={size} />,
  draft: (size) => <PullRequestIcon size={size} />,
  merged: (size) => <MergedIcon size={size} />,
  closed: (size) => <ClosedPullRequestIcon size={size} />,
};

export const pullRequestText = (pr: PullRequestRef) =>
  t("pr.text", { number: pr.number, state: t(labels[pr.state]) });

/**
 * 会话分支上 PR 的状态图标：
 * 打开是绿色，草稿是灰色，已合并是紫色，没合并就关了是红色。
 */
export function PullRequestBadge({ pr, size = 14 }: { pr: PullRequestRef; size?: number }) {
  return (
    <span className={`pr-badge ${pr.state}`} title={pullRequestText(pr)}>
      {icons[pr.state](size)}
    </span>
  );
}
