import type { SessionState } from "@seekcloud/protocol";
import { navigate } from "../router";
import { PullRequestBadge } from "./PullRequestBadge";
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

/** 会话列表：标题、仓库、状态和最近的动静。 */
export function SessionList({
  sessions,
  loaded,
  currentId,
  onPick,
}: {
  sessions: Session[];
  loaded: boolean;
  currentId?: string;
  /** 点了某个会话之后（手机上用来收起侧栏）。 */
  onPick?: () => void;
}) {
  if (!loaded) return <p className="session-list-empty">正在加载…</p>;
  if (sessions.length === 0) {
    return <p className="session-list-empty">暂无会话，输入任务即可开始。</p>;
  }
  return (
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
          </li>
        );
      })}
    </ul>
  );
}
