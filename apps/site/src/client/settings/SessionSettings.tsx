import { useState } from "react";
import { type ApiError, api } from "../api";
import { setCached, useCached } from "../cached";
import { toast, useErrorToast } from "../ui/toast";

export const HOST_OFFLINE_GRACE = "/api/settings/host-offline-grace";

/** 和主站 settings.ts 的 HOST_OFFLINE_GRACE_CHOICES 一致。 */
const CHOICES = [
  { seconds: 60, label: "1 分钟" },
  { seconds: 120, label: "2 分钟" },
  { seconds: 300, label: "5 分钟" },
  { seconds: 600, label: "10 分钟" },
  { seconds: 1800, label: "30 分钟" },
];

/** 设置里的"会话"一类。 */
export function SessionSettings() {
  return <HostOfflineGrace />;
}

/** 宿主机断开连接多久以后，把它上面运行中的会话标为失败（#91）。 */
function HostOfflineGrace() {
  const loaded = useCached<{ seconds: number }>(HOST_OFFLINE_GRACE);
  const seconds = loaded.data?.seconds;
  const [failed, setError] = useState<string>();
  const error = failed ?? loaded.error;
  useErrorToast(error);

  const choose = async (next: number) => {
    if (seconds === undefined || next === seconds) return;
    const before = seconds;
    setCached(HOST_OFFLINE_GRACE, { seconds: next });
    setError(undefined);
    try {
      await api(HOST_OFFLINE_GRACE, { seconds: next }, "PUT");
    } catch (e) {
      setCached(HOST_OFFLINE_GRACE, { seconds: before });
      toast((e as ApiError).message, "error");
    }
  };

  return (
    <section className="settings-section settings-group">
      <h2>宿主机断开后等待</h2>
      <fieldset className="segmented" disabled={seconds === undefined}>
        <legend className="visually-hidden">宿主机断开后等待</legend>
        {CHOICES.map((c) => (
          <label key={c.seconds} className={`segment${seconds === c.seconds ? " current" : ""}`}>
            <input
              type="radio"
              name="host-offline-grace"
              value={c.seconds}
              checked={seconds === c.seconds}
              onChange={() => void choose(c.seconds)}
            />
            <span className="segment-label">{c.label}</span>
          </label>
        ))}
      </fieldset>
      <p className="settings-group-hint">
        宿主机与主站的连接断开超过此时长，宿主机上正在运行的会话将标记为失败。连接断开期间沙箱中的
        Agent 仍在运行，在此时长内重新连接，会话将照常继续。网络不稳定时可适当延长。
      </p>
    </section>
  );
}
