// 界面里用的小图标。线条图标统一 16×16、1.6 的线宽，颜色跟着文字走。

const line = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const PlusIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 3v10M3 8h10" {...line} />
  </svg>
);

export const MenuIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M3.5 6h13M3.5 10h13M3.5 14h8" {...line} strokeWidth={1.7} />
  </svg>
);

export const BranchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="4.5" cy="3.5" r="1.6" {...line} />
    <circle cx="4.5" cy="12.5" r="1.6" {...line} />
    <circle cx="11.5" cy="5" r="1.6" {...line} />
    <path d="M4.5 5.1v5.8M11.5 6.6c0 3-7 1.6-7 4.3" {...line} />
  </svg>
);

export const BoxIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 1.8 13.6 5v6L8 14.2 2.4 11V5zM2.4 5 8 8.2 13.6 5M8 8.2v6" {...line} />
  </svg>
);

export const ArrowUpIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2" {...line} strokeWidth={1.9} />
  </svg>
);

export const ChevronDownIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="m3 4.5 3 3 3-3" {...line} strokeWidth={1.5} />
  </svg>
);

export const ChevronRightIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="m4.5 3 3 3-3 3" {...line} strokeWidth={1.5} />
  </svg>
);

export const LogoutIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M6 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H6M10.5 11l3-3-3-3M13.5 8H6" {...line} />
  </svg>
);

export const CheckIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
    <path d="m3.5 8.5 3 3 6-7" {...line} strokeWidth={1.9} />
  </svg>
);

/** 四角星形的闪光，和标志里的那颗一样。 */
export const SparkIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M8 1.5c.5 3.2 1.6 5.2 6.5 6.5-4.9 1.3-6 3.3-6.5 6.5-.5-3.2-1.6-5.2-6.5-6.5C6.4 6.7 7.5 4.7 8 1.5z"
      fill="currentColor"
    />
  </svg>
);

export const SearchIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="7" cy="7" r="4.6" {...line} />
    <path d="m10.5 10.5 3 3" {...line} />
  </svg>
);

/** 齿轮。原来画成一圈短线，像太阳，会被当成深浅色切换（2026-11-01 用户指出）。 */
export const SettingsIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M6.93 3.37L7.08 1.46L8.92 1.46L9.07 3.37A4.75 4.75 0 0 1 10.52 3.97L11.97 2.73L13.27 4.03L12.03 5.48A4.75 4.75 0 0 1 12.63 6.93L14.54 7.08L14.54 8.92L12.63 9.07A4.75 4.75 0 0 1 12.03 10.52L13.27 11.97L11.97 13.27L10.52 12.03A4.75 4.75 0 0 1 9.07 12.63L8.92 14.54L7.08 14.54L6.93 12.63A4.75 4.75 0 0 1 5.48 12.03L4.03 13.27L2.73 11.97L3.97 10.52A4.75 4.75 0 0 1 3.37 9.07L1.46 8.92L1.46 7.08L3.37 6.93A4.75 4.75 0 0 1 3.97 5.48L2.73 4.03L4.03 2.73L5.48 3.97A4.75 4.75 0 0 1 6.93 3.37Z"
      {...line}
    />
    <circle cx="8" cy="8" r="2" {...line} />
  </svg>
);

export const CopyIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" {...line} />
    <path
      d="M10.5 5.5V3.9c0-.9-.7-1.6-1.6-1.6H3.9c-.9 0-1.6.7-1.6 1.6v5c0 .9.7 1.6 1.6 1.6h1.6"
      {...line}
    />
  </svg>
);

/** 撤回并放回输入框编辑。 */
export const UndoIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3.5 6.5h6.2a3.3 3.3 0 0 1 0 6.6H6.5" {...line} />
    <path d="M6 4 3.5 6.5 6 9" {...line} />
  </svg>
);

/** 逆时针的箭头：重试。 */
export const RetryIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M2.8 8A5.2 5.2 0 1 0 4.32 4.32" {...line} />
    <path d="M4.32 1.92v2.4h2.4" {...line} />
  </svg>
);

/** 两个勾：消息已经送到。 */
export const DoubleCheckIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="m1.6 8.7 2.8 2.8 5.4-6.4" {...line} />
    <path d="m7.6 11.2.3.3 5.4-6.4" {...line} />
  </svg>
);

export const CloseIcon = ({ size = 15 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
    <path d="m4 4 8 8M12 4l-8 8" {...line} />
  </svg>
);

export const UserIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="5.6" r="2.7" {...line} />
    <path d="M2.8 13.6c.7-2.4 2.8-3.7 5.2-3.7s4.5 1.3 5.2 3.7" {...line} />
  </svg>
);

/** PR 打开着（和 GitHub 的图标同一个意思）。 */
export const PullRequestIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="4" cy="3.6" r="1.6" {...line} />
    <circle cx="4" cy="12.4" r="1.6" {...line} />
    <circle cx="12" cy="12.4" r="1.6" {...line} />
    <path d="M4 5.2v5.6M12 10.8V6.2c0-1-.8-1.8-1.8-1.8H7.5" {...line} />
    <path d="m9 2.9-1.5 1.5L9 5.9" {...line} />
  </svg>
);

/** PR 已合并。 */
export const MergedIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="4" cy="3.6" r="1.6" {...line} />
    <circle cx="4" cy="12.4" r="1.6" {...line} />
    <circle cx="12" cy="8.4" r="1.6" {...line} />
    <path d="M4 5.2v5.6M4.6 5c1 2.2 3 3.4 5.8 3.4" {...line} />
  </svg>
);

/** PR 没合并就关了。 */
export const ClosedPullRequestIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="4" cy="3.6" r="1.6" {...line} />
    <circle cx="4" cy="12.4" r="1.6" {...line} />
    <circle cx="12" cy="12.4" r="1.6" {...line} />
    <path d="M4 5.2v5.6M12 7.5v3.3M10.2 2.4l3.6 3.6M13.8 2.4l-3.6 3.6" {...line} />
  </svg>
);

export const MoonIcon = () => (
  <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M13.4 9.7A5.4 5.4 0 1 1 6.3 2.6a4.4 4.4 0 0 0 7.1 7.1Z" {...line} />
  </svg>
);

/** issue（和 GitHub 的图标同一个意思：圆圈里一个点）。 */
export const IssueIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r="5.6" {...line} />
    <circle cx="8" cy="8" r="1.2" fill="currentColor" />
  </svg>
);

export const ArrowDownIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 3v9.5M3.8 8.5 8 12.7l4.2-4.2" {...line} strokeWidth={1.9} />
  </svg>
);

export const ListIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <path d="M6.5 5h8M6.5 9h8M6.5 13h8" {...line} />
    <circle cx="3.6" cy="5" r="0.9" fill="currentColor" />
    <circle cx="3.6" cy="9" r="0.9" fill="currentColor" />
    <circle cx="3.6" cy="13" r="0.9" fill="currentColor" />
  </svg>
);

export const PencilIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M10.5 3 13 5.5 6 12.5H3.5V10zM9 4.5 11.5 7" {...line} />
  </svg>
);

export const LinkIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.9.9M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.9-.9"
      {...line}
    />
  </svg>
);

export const ArchiveIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M2.5 3.5h11v3h-11zM3.5 6.5v6h9v-6M6.5 9h3" {...line} />
  </svg>
);

export const TrashIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4" {...line} />
  </svg>
);

export const ExternalIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5V13H3V4.5h3.5" {...line} />
  </svg>
);

export const MoreIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="3.5" cy="8" r="1.25" fill="currentColor" />
    <circle cx="8" cy="8" r="1.25" fill="currentColor" />
    <circle cx="12.5" cy="8" r="1.25" fill="currentColor" />
  </svg>
);
