import { useCallback, useEffect, useState } from "react";
import type { Session } from "./types";

const byRecent = (a: Session, b: Session) => b.updatedAt.localeCompare(a.updatedAt);

/**
 * 会话列表，实时更新。连上（包括断线重连）时服务器先发全部，之后推送变化。
 * loaded 为 false 时还没收到第一份列表。
 */
export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loaded, setLoaded] = useState(false);

  const upsert = useCallback((session: Session) => {
    setSessions((list) =>
      [session, ...list.filter((s) => s.shortId !== session.shortId)].sort(byRecent),
    );
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/sessions/stream");
    source.addEventListener("snapshot", (e) => {
      setSessions((JSON.parse(e.data) as { sessions: Session[] }).sessions);
      setLoaded(true);
    });
    source.addEventListener("session", (e) => upsert(JSON.parse(e.data) as Session));
    return () => source.close();
  }, [upsert]);

  return { sessions, loaded, upsert };
}
