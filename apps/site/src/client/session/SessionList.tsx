import type { SessionState } from "@seekcloud/protocol";
import { useState } from "react";
import { MoreIcon, WarningIcon } from "../Icons";
import { navigate, sidebarOverlays } from "../router";
import { PullRequestBadge } from "./PullRequestBadge";
import { SessionMenu } from "./SessionHeader";
import { relativeTime, type Session, statusText } from "./types";

/** 呼吸一次的时长，和 styles.css 里 .session-pulse 的一样。 */
const PULSE_MS = 1300;

/**
 * 会话右边的状态标记（照 Claude 的 App）：运行中、排队中是一个灰点，一明一暗地呼吸；失败是警告三角；
 * 别的状态不标。几个会话同时在跑时一起呼吸：按页面打开以来的时间算好起点，不管哪一行什么时候出现。
 * "等你输入""有新内容"等会话状态细分做了再加。
 */
export function StatusMark({ state }: { state: SessionState }) {
  const label = statusText(state);
  const [delay] = useState(() => -(performance.now() % PULSE_MS));
  if (state.status === "running" || state.status === "queued") {
    return (
      <span
        className="session-pulse"
        style={{ animationDelay: `${delay}ms` }}
        role="img"
        aria-label={label}
        title={label}
      />
    );
  }
  if (state.status === "failed") {
    return (
      <span className="session-warning" role="img" aria-label={label} title={label}>
        <WarningIcon />
      </span>
    );
  }
  return null;
}

/**
 * 会话列表：标题、仓库、状态和最近的动静。
 * 每个会话右边有"⋯"（照 Claude：当前会话一直显示，别的会话指上去才显示），点了弹出和会话页标题一样的菜单。
 */
export function SessionList({
  sessions,
  loaded,
  currentId,
  searching = false,
  onPick,
}: {
  sessions: Session[];
  loaded: boolean;
  currentId?: string;
  /** 列表是搜索的结果：一个都没有时说"未找到"，不说"暂无会话"。 */
  searching?: boolean;
  /** 点了某个会话之后（手机上用来收起侧栏）。 */
  onPick?: () => void;
}) {
  // 菜单对着哪个会话；关的时候先只把 menuOpen 关掉，弹层播完收起的动画再拿掉
  const [menuFor, setMenuFor] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuSession = sessions.find((s) => s.shortId === menuFor);
  if (!loaded) return <p className="session-list-empty">正在加载…</p>;
  if (sessions.length === 0) {
    return (
      <p className="session-list-empty">
        {searching ? "未找到匹配的会话。" : "暂无会话，输入任务即可开始。"}
      </p>
    );
  }
  return (
    <>
      <ul className="session-list">
        {sessions.map((session) => {
          const current = session.shortId === currentId;
          const pr = session.repos[0]?.pullRequest;
          return (
            <li key={session.shortId}>
              <a
                href={`/s/${session.shortId}`}
                className={`session-item${current ? " current" : ""}`}
                aria-current={current ? "page" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  // 手机上侧栏铺满整屏：侧栏滑走就是过渡，主区域不再淡入上浮，免得像抖了一下
                  navigate(`/s/${session.shortId}`, { transition: !sidebarOverlays() });
                  onPick?.();
                }}
              >
                <span className="session-item-head">
                  <span className="session-item-title">{session.title}</span>
                  {pr && <PullRequestBadge pr={pr} />}
                  <StatusMark state={session} />
                </span>
                <span className="session-item-meta">
                  <span className="session-item-repo">{session.repos[0]?.fullName}</span>
                  <span className="session-item-time">{relativeTime(session.updatedAt)}</span>
                </span>
              </a>
              <button
                type="button"
                className="session-item-more"
                aria-label={`会话菜单：${session.title}`}
                aria-haspopup="dialog"
                onClick={() => {
                  setMenuFor(session.shortId);
                  setMenuOpen(true);
                }}
              >
                <MoreIcon />
              </button>
            </li>
          );
        })}
      </ul>
      {menuSession && (
        <SessionMenu
          id={menuSession.shortId}
          session={menuSession}
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </>
  );
}
