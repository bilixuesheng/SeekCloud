import { useCallback, useEffect, useState } from "react";
import { type ApiError, api } from "../api";
import { shortDateTime } from "../session/relative-time";

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
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** 导出数据：后台打包，打包好后出现下载按钮。 */
export function ExportData() {
  const [overview, setOverview] = useState<Overview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(() => {
    api<Overview>("/api/account/export").then(setOverview, (e: ApiError) => setError(e.message));
  }, []);
  useEffect(load, [load]);

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
      setOverview(await api<Overview>("/api/account/export", {}));
    } catch (e) {
      setError((e as ApiError).message);
      load();
    } finally {
      setBusy(false);
    }
  };

  const latest = overview?.latest;
  const downloadable =
    latest?.status === "ready" && latest.expiresAt && new Date(latest.expiresAt) > new Date();
  const next = overview?.nextAvailableAt ? new Date(overview.nextAvailableAt) : undefined;

  let sub = "将账户资料、全部对话（JSON 与 Markdown 格式）及环境配置打包为 zip 文件。";
  if (working) sub = "正在打包，通常需要几分钟。完成后可在此处下载。";
  else if (downloadable && latest?.expiresAt)
    sub = `打包已完成，可在 ${shortDateTime(new Date(latest.expiresAt))} 前下载。`;
  else if (latest?.status === "failed") sub = "上次导出失败，请重试。";

  return (
    <div className="settings-card">
      <div className="settings-row">
        <span className="settings-row-text">
          <span className="settings-row-name">导出账户数据</span>
          <span className="settings-row-sub">{sub}</span>
          {!working && !downloadable && next && (
            <span className="settings-row-sub">
              每 24 小时可导出一次，下次可导出时间：{shortDateTime(next)}。
            </span>
          )}
        </span>
        {downloadable && latest ? (
          <a className="pill-button accent" href={`/api/account/export/${latest.id}/download`}>
            下载{latest.sizeBytes ? `（${fileSize(latest.sizeBytes)}）` : ""}
          </a>
        ) : (
          <button
            type="button"
            className="pill-button"
            disabled={!overview || busy || working || Boolean(next)}
            onClick={() => void request()}
          >
            {working ? "正在准备" : "导出"}
          </button>
        )}
      </div>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
