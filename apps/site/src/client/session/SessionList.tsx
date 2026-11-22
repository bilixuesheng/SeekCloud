import type { SessionState } from "@seekcloud/protocol";
import { useState } from "react";
import { MoreIcon, WarningIcon } from "../Icons";
import { listTime } from "../i18n/format";
import { navigate } from "../router";
import { PullRequestBadge } from "./PullRequestBadge";
import { SessionMenu } from "./SessionHeader";
import { type Session, statusMark, statusText } from "./types";

/** 呼吸一次的时长，和 styles.css 里 .session-pulse 的一样。 */
const PULSE_MS = 1300;

/**
 * 会话右边的状态标记（照 Claude 的 App）：运行中、排队中是一个灰点，一明一暗地呼吸；失败是警告三角；
 * 有新内容（回合结束时没开着这个会话）是一个蓝点；别的状态不标。几个会话同时在跑时一起呼吸：
 * 按页面打开以来的时间算好起点，不管哪一行什么时候出现。"等你输入"做了再加。
 */
export function StatusMark({ state, unread = false }: { state: SessionState; unread?: boolean }) {
  const label = statusText(state);
  const [delay] = useState(() => -(performance.now() % PULSE_MS));
  switch (statusMark(state, unread)) {
    case "running":
      return (
        <span
          className="session-pulse"
          style={{ animationDelay: `${delay}ms` }}
          role="img"
          aria-label={label}
          title={label}
        />
      );
    case "failed":
      return (
        <span className="session-warning" role="img" aria-label={label} title={label}>
          <WarningIcon />
        </span>
      );
    case "awaiting":
      // 一个强调色的圆圈里一个点：和"有新内容"的实心蓝点分得开
      return (
        <span className="session-awaiting" role="img" aria-label="等你输入" title="等你输入" />
      );
    case "unread":
      return <span className="session-unread" role="img" aria-label="有新内容" title="有新内容" />;
    default:
      return null;
  }
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
  flip = true,
  draggingId,
  landingId,
  onPick,
}: {
  sessions: Session[];
  loaded: boolean;
  currentId?: string;
  /** 列表是搜索的结果：一个都没有时说"未找到"，不说"暂无会话"。 */
  searching?: boolean;
  /** 换位置时平滑滑动（侧栏的 useFlip）。收在"已归档"里的不用，展开时由折叠的动画管。 */
  flip?: boolean;
  /** 正在拖的会话（#153）：原来的位置淡下去，留着空档。 */
  draggingId?: string;
  /** 刚松手、浮起的那条正滑过去的会话：列表里这一行先藏着，滑到了再露出来。 */
  landingId?: string;
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
            <li
              key={session.shortId}
              data-flip={flip ? session.shortId : undefined}
              data-session={session.shortId}
              data-archived={session.status === "archived" ? "" : undefined}
              className={
                draggingId === session.shortId
                  ? "drag-source"
                  : landingId === session.shortId
                    ? "drag-landing"
                    : undefined
              }
            >
              <a
                href={`/s/${session.shortId}`}
                className={`session-item${current ? " current" : ""}`}
                aria-current={current ? "page" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  // 手机上侧栏铺满整屏：侧栏滑走就是过渡，主区域不再淡入上浮，免得像抖了一下
                  navigate(`/s/${session.shortId}`);
                  onPick?.();
                }}
              >
                <span className="session-item-head">
                  <span className="session-item-title">{session.title}</span>
                  {pr && <PullRequestBadge pr={pr} />}
                  <StatusMark state={session} unread={session.unread && !current} />
                </span>
                <span className="session-item-meta">
                  <span className="session-item-repo">{session.repos[0]?.fullName}</span>
                  <span className="session-item-time">{listTime(session.updatedAt)}</span>
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
