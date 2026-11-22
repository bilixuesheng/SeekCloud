import { useState } from "react";
import { ChevronDownIcon } from "../Icons";
import { listTime } from "../i18n/format";
import { Collapse } from "../Motion";
import { navigate } from "../router";
import { useShell } from "../shell";

/**
 * 首页问候语下方的提示（#139，照 Claude）：有会话在等你输入时显示一行。一个时写会话的标题，点了跳过去；
 * 多个时写"有 N 个会话在等你输入"，点了展开列表（标题和等了多久），点一项跳到那个会话。没有时不占位置。
 * 已归档的不算。登记在插槽 home-below-greeting 上（trunk.tsx）。
 */
export function AwaitingInputHint() {
  const { sessions } = useShell();
  const [open, setOpen] = useState(false);
  const waiting = sessions
    .filter((s) => s.detail === "awaiting_input" && s.status !== "archived")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const only = waiting.length === 1 ? waiting[0] : undefined;
  return (
    <Collapse open={waiting.length > 0}>
      <div className="awaiting-hint">
        <button
          type="button"
          className="awaiting-hint-line"
          aria-expanded={only ? undefined : open}
          onClick={() => (only ? navigate(`/s/${only.shortId}`) : setOpen((o) => !o))}
        >
          <span className="session-awaiting" aria-hidden="true" />
          <span className="awaiting-hint-text">
            {only ? (
              <>
                <strong>{only.title}</strong> 正在等你输入
              </>
            ) : (
              `有 ${waiting.length} 个会话在等你输入`
            )}
          </span>
          {!only && (
            <span className={`awaiting-hint-chevron${open ? " open" : ""}`}>
              <ChevronDownIcon />
            </span>
          )}
        </button>
        {!only && (
          <Collapse open={open}>
            <ul className="awaiting-hint-list">
              {waiting.map((s) => (
                <li key={s.shortId}>
                  <button type="button" onClick={() => navigate(`/s/${s.shortId}`)}>
                    <span className="awaiting-hint-title">{s.title}</span>
                    <span className="awaiting-hint-time">{waitedFor(s.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Collapse>
        )}
      </div>
    </Collapse>
  );
}

/** 等了多久："刚刚""等了 5 分钟""等了 2 小时"……更早的写日期（会话列表的时间去掉"前"）。 */
function waitedFor(iso: string): string {
  const text = listTime(iso);
  if (text === "刚刚") return text;
  return text.endsWith("前") ? `等了 ${text.slice(0, -1)}` : text;
}
