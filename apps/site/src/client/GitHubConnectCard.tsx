import { GitHubMark } from "./GitHubMark";

export interface GitHubStatus {
  connected: boolean;
  login?: string;
  installUrl: string;
}

/** 没关联 GitHub 时显示：先授权，再把 App 装到要用的仓库上。 */
export function GitHubConnectCard({ status }: { status: GitHubStatus }) {
  return (
    <section className="card">
      <h2>关联 GitHub</h2>
      <p className="muted">
        授权 GitHub，并在需要使用的仓库上安装 GitHub App，Agent 即可读写这些仓库。
      </p>
      <div className="actions">
        <a className="button primary" href="/api/auth/github/start">
          <GitHubMark /> 授权 GitHub
        </a>
        {status.installUrl && (
          <a className="button ghost" href={status.installUrl} target="_blank" rel="noreferrer">
            安装 GitHub App
          </a>
        )}
      </div>
    </section>
  );
}
