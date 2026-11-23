import { GitHubMark } from "./GitHubMark";
import { useT } from "./i18n";

export interface GitHubStatus {
  connected: boolean;
  login?: string;
  installUrl: string;
}

/** 没关联 GitHub 时显示：先授权，再把 App 装到要用的仓库上。 */
export function GitHubConnectCard({ status }: { status: GitHubStatus }) {
  const t = useT();
  return (
    <section className="card">
      <h2>{t("github.connectTitle")}</h2>
      <p className="muted">{t("github.connectHint")}</p>
      <div className="actions">
        <a className="button primary" href="/api/auth/github/start">
          <GitHubMark /> {t("github.authorize")}
        </a>
        {status.installUrl && (
          <a className="button ghost" href={status.installUrl} target="_blank" rel="noreferrer">
            {t("github.install")}
          </a>
        )}
      </div>
    </section>
  );
}
