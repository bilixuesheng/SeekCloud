import { useEffect, useState } from "react";
import { type ApiError, api } from "../api";
import { setCached, useCached } from "../cached";

const EXPORTS = "/api/account/export";

import { useT } from "../i18n";
import { errorText } from "../i18n/errors";
import { formatNumber, shortDateTime } from "../i18n/format";
import { toast, useErrorToast } from "../ui/toast";

interface ExportView {
  id: string;
  status: "pending" | "building" | "ready" | "failed" | "expired";
  createdAt: string;
  expiresAt: string | null;
  sizeBytes: number | null;
}

interface Overview {
  latest: ExportView | null;
  nextAvailableAt: string | null;
}

const fileSize = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${formatNumber(Math.max(1, Math.round(bytes / 1024)))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** 导出数据：后台打包，打包好后出现下载按钮。 */
export function ExportData() {
  const t = useT();
  const loaded = useCached<Overview>(EXPORTS);
  const overview = loaded.data;
  const load = loaded.reload;
  const [busy, setBusy] = useState(false);
  const [failed, setError] = useState<string>();
  const error = failed ?? loaded.error;
  useErrorToast(error);

  // 正在打包时每 5 秒看一次，好了就换成下载按钮。
  const working = overview?.latest?.status === "pending" || overview?.latest?.status === "building";
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [working, load]);

  const request = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setCached(EXPORTS, await api<Overview>(EXPORTS, {}));
    } catch (e) {
      toast(errorText(e as ApiError), "error");
      load();
    } finally {
      setBusy(false);
    }
  };

  const latest = overview?.latest;
  const downloadable =
    latest?.status === "ready" && latest.expiresAt && new Date(latest.expiresAt) > new Date();
  const next = overview?.nextAvailableAt ? new Date(overview.nextAvailableAt) : undefined;

  let sub = t("data.exportHint");
  if (working) sub = t("data.building");
  else if (downloadable && latest?.expiresAt)
    sub = t("data.ready", { time: shortDateTime(new Date(latest.expiresAt)) });
  else if (latest?.status === "failed") sub = t("data.failed");

  return (
    <div className="settings-card">
      <div className="settings-row">
        <span className="settings-row-text">
          <span className="settings-row-name">{t("data.export")}</span>
          <span className="settings-row-sub">{sub}</span>
          {!working && !downloadable && next && (
            <span className="settings-row-sub">
              {t("data.nextAt", { time: shortDateTime(next) })}
            </span>
          )}
        </span>
        {downloadable && latest ? (
          <a className="pill-button accent" href={`/api/account/export/${latest.id}/download`}>
            {latest.sizeBytes
              ? t("data.downloadSize", { size: fileSize(latest.sizeBytes) })
              : t("data.download")}
          </a>
        ) : (
          <button
            type="button"
            className="pill-button"
            disabled={!overview || busy || working || Boolean(next)}
            onClick={() => void request()}
          >
            {working ? t("data.preparing") : t("data.exportButton")}
          </button>
        )}
      </div>
    </div>
  );
}

/** 设置里的"数据"一类：导出数据。以后的备份和恢复也放这里。 */
export function DataSettings() {
  const t = useT();
  return (
    <section className="settings-section">
      <h2>{t("data.title")}</h2>
      <ExportData />
    </section>
  );
}
