import type { SessionEvent } from "@seekcloud/protocol";
import { useEffect, useState } from "react";

/** 连上以后这么久没有新事件，就当历史已经补完了。 */
const HISTORY_QUIET_MS = 250;
/** 历史最多补这么久；一直有事件进来（Agent 正在飞快地调工具）时，到点也算补完。 */
const HISTORY_MAX_MS = 1500;

/**
 * 一个会话的全部事件，实时更新。断线后浏览器自动带着 Last-Event-ID 重连，只补发没收到的。
 * 刚打开时历史事件一下子涌进来，攒到下一帧一起更新，免得每条都重新渲染一次。
 * liveAfter：序号比它大的是打开会话以后才发生的（Agent 回复的字要浮现出来），不大于它的是历史；
 * 历史还没补完时是 Infinity，这时一条都不算新的。
 */
export function useSessionEvents(sessionId: string) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [broken, setBroken] = useState(false);
  const [liveAfter, setLiveAfter] = useState(Number.POSITIVE_INFINITY);

  useEffect(() => {
    setEvents([]);
    setBroken(false);
    setLiveAfter(Number.POSITIVE_INFINITY);
    let last = 0;
    let caughtUp = false;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const catchUp = () => {
      caughtUp = true;
      clearTimeout(quiet);
      clearTimeout(deadline);
      setLiveAfter(last);
    };
    const waitQuiet = () => {
      if (caughtUp) return;
      clearTimeout(quiet);
      quiet = setTimeout(catchUp, HISTORY_QUIET_MS);
    };
    let pending: SessionEvent[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const batch = pending;
      pending = [];
      setEvents((list) => [...list, ...batch]);
    };
    const source = new EventSource(`/api/sessions/${sessionId}/events`);
    source.addEventListener("session", (e) => {
      const event = JSON.parse(e.data) as SessionEvent;
      if (event.seq <= last) return;
      last = event.seq;
      pending.push(event);
      frame ||= requestAnimationFrame(flush);
      waitQuiet();
    });
    source.addEventListener("open", () => {
      setBroken(false);
      // 断线重连时补发的是断开期间的新事件，不是历史，所以只在第一次连上时等。
      if (caughtUp || deadline) return;
      deadline = setTimeout(catchUp, HISTORY_MAX_MS);
      waitQuiet();
    });
    source.addEventListener("error", () => {
      // CLOSED：服务器拒绝了（比如会话不存在），浏览器不会再重连。
      if (source.readyState === EventSource.CLOSED) setBroken(true);
    });
    return () => {
      source.close();
      cancelAnimationFrame(frame);
      clearTimeout(quiet);
      clearTimeout(deadline);
    };
  }, [sessionId]);

  return { events, broken, liveAfter };
}
