import type { SessionState } from "@seekcloud/protocol";
import { useState } from "react";
import { MoreIcon } from "../Icons";
import { navigate } from "../router";
import { PullRequestBadge } from "./PullRequestBadge";
import { SessionMenu } from "./SessionHeader";
import { relativeTime, type Session, statusText } from "./types";

/** 状态的小标记：运行中是转圈，其余是不同颜色的点。 */
export function StatusDot({ state }: { state: SessionState }) {
  return (
    <span
      className={`status-dot ${state.status}${state.detail ? " detail" : ""}`}
      role="img"
      aria-label={statusText(state)}
      title={statusText(state)}
    />
  );
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
                  navigate(`/s/${session.shortId}`);
                  onPick?.();
                }}
              >
                <span className="session-item-head">
                  <span className="session-item-title">{session.title}</span>
                  {pr && <PullRequestBadge pr={pr} />}
                </span>
                <span className="session-item-meta">
                  <StatusDot state={session} />
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
