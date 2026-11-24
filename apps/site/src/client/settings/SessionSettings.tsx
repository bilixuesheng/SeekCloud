import { useState } from "react";
import { type ApiError, api } from "../api";
import { setCached, useCached } from "../cached";
import { useT } from "../i18n";
import { errorText } from "../i18n/errors";
import { minutesParts } from "../i18n/format";
import { toast, useErrorToast } from "../ui/toast";

export const HOST_OFFLINE_GRACE = "/api/settings/host-offline-grace";

/** 和主站 settings.ts 的 HOST_OFFLINE_GRACE_CHOICES 一致。 */
const CHOICES = [60, 120, 300, 600, 1800];

/** 设置里的"会话"一类。 */
export function SessionSettings() {
  return <HostOfflineGrace />;
}

/** 宿主机断开连接多久以后，把它上面运行中的会话标为失败（#91）。 */
function HostOfflineGrace() {
  const t = useT();
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
      toast(errorText(e as ApiError), "error");
    }
  };

  return (
    <section className="settings-section settings-group">
      <h2>{t("sessionSettings.grace")}</h2>
      <fieldset className="segmented" disabled={seconds === undefined}>
        <legend className="visually-hidden">{t("sessionSettings.grace")}</legend>
        {CHOICES.map((choice) => (
          <label key={choice} className={`segment${seconds === choice ? " current" : ""}`}>
            <input
              type="radio"
              name="host-offline-grace"
              value={choice}
              checked={seconds === choice}
              onChange={() => void choose(choice)}
            />
            <MinutesLabel minutes={choice / 60} />
          </label>
        ))}
      </fieldset>
      <p className="settings-group-hint">{t("sessionSettings.graceHint")}</p>
    </section>
  );
}

/** 分段里的一个时长：数字在上、单位在下（英文的 "10 minutes" 放不进一段）；读屏读成一句。 */
function MinutesLabel({ minutes }: { minutes: number }) {
  const { value, unit } = minutesParts(minutes);
  return (
    <span className="segment-label segment-stack">
      <span className="segment-value">{value}</span> <span className="segment-unit">{unit}</span>
    </span>
  );
}
