import type { PullRequestRef, PullRequestState } from "@seekcloud/protocol";
import type { ReactNode } from "react";
import { ClosedPullRequestIcon, MergedIcon, PullRequestIcon } from "../Icons";

const labels: Record<PullRequestState, string> = {
  open: "打开",
  draft: "草稿",
  merged: "已合并",
  closed: "已关闭",
};

const icons: Record<PullRequestState, (size: number) => ReactNode> = {
  open: (size) => <PullRequestIcon size={size} />,
  draft: (size) => <PullRequestIcon size={size} />,
  merged: (size) => <MergedIcon size={size} />,
  closed: (size) => <ClosedPullRequestIcon size={size} />,
};

export const pullRequestText = (pr: PullRequestRef) => `PR #${pr.number} · ${labels[pr.state]}`;

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
