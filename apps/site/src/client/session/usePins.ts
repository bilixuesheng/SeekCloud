import type { MessagePin } from "@seekcloud/protocol";
import { useCallback, useEffect, useState } from "react";
import { type ApiError, api } from "../api";

/**
 * 会话里置顶的消息。置顶时先在本地加上（短标题为 null，显示占位的闪烁条），服务器回来再换成正式的列表；
 * 没成功就换回服务器上的样子，把错误交给 onError。
 */
export function usePins(sessionId: string, onError: (message: string) => void) {
  const [pins, setPins] = useState<MessagePin[]>([]);

  const reload = useCallback(() => {
    api<{ pins: MessagePin[] }>(`/api/sessions/${sessionId}/pins`).then(
      (res) => setPins(res.pins),
      () => undefined,
    );
  }, [sessionId]);

  useEffect(() => {
    setPins([]);
    reload();
  }, [reload]);

  const toggle = useCallback(
    async (seq: number, pinned: boolean) => {
      setPins((list) =>
        pinned
          ? [
              ...list.filter((p) => p.seq !== seq),
              { seq, title: null, createdAt: new Date().toISOString() },
            ].sort((a, b) => a.seq - b.seq)
          : list.filter((p) => p.seq !== seq),
      );
      try {
        const res = await api<{ pins: MessagePin[] }>(`/api/sessions/${sessionId}/pins`, {
          seq,
          pinned,
        });
        setPins(res.pins);
      } catch (e) {
        onError((e as ApiError).message);
        reload();
      }
    },
    [sessionId, onError, reload],
  );

  return { pins, toggle };
}
