import { fitEffort, type ThinkingEffort } from "@seekcloud/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type ApiError, api } from "../api";
import { useDraft } from "../draft";
import { useSerifReady } from "../fonts";
import { GitHubConnectCard, type GitHubStatus } from "../GitHubConnectCard";
import { GitHubMark } from "../GitHubMark";
import { BoxIcon, BranchIcon, ChevronDownIcon } from "../Icons";
import { Logo } from "../Logo";
import { navigate } from "../router";
import { Composer, handOffFocus } from "./Composer";
import { pickGreeting } from "./greetings";
import { ModelPicker } from "./ModelPicker";
import type { Session } from "./types";
import { useModels } from "./useModels";

interface Repo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  canPush: boolean;
}

interface Environment {
  id: string;
  name: string;
  isDefault: boolean;
}

interface Choices {
  repo?: Repo;
  branch?: string;
  model?: string;
}

const REMEMBERED = "seekcloud:new-session";

/**
 * 上次用的仓库、分支和模型，下次自动选上。存在浏览器里，读写失败（比如无痕模式）就算了。
 * 思考强度不记：每次都从设置里的默认值开始。
 */
function remembered(): Choices {
  try {
    return JSON.parse(localStorage.getItem(REMEMBERED) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function remember(choices: Choices) {
  try {
    localStorage.setItem(REMEMBERED, JSON.stringify(choices));
  } catch {}
}

/** 首页：写一句话，选仓库、分支、环境和模型，发起会话。 */
export function NewSession({ onCreated }: { onCreated: (session: Session) => void }) {
  const [initial] = useState(remembered);
  const [greeting] = useState(() => pickGreeting());
  const greetingReady = useSerifReady(greeting);
  const [github, setGitHub] = useState<GitHubStatus>();
  // 没发出去的字记在浏览器里：去别的会话看一眼再回来、刷新页面都还在。
  const [text, setText] = useDraft("new");
  const [repo, setRepo] = useState<Repo | undefined>(initial.repo);
  const [branch, setBranch] = useState(initial.branch ?? "");
  const [branches, setBranches] = useState<string[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [environmentId, setEnvironmentId] = useState("");
  const modelList = useModels();
  const models = modelList?.models ?? [];
  const [chosenModel, setModel] = useState(initial.model ?? "");
  // 记住的模型下线了，就换回默认的。
  const model = models.some((m) => m.id === chosenModel)
    ? chosenModel
    : (modelList?.defaultModel ?? "");
  // 没动过滑块就用设置里的默认值（设置里改了，这里跟着变）；模型不支持那一档时换成最近的一档
  const [chosenEffort, setEffort] = useState<ThinkingEffort>();
  const efforts = models.find((m) => m.id === model)?.efforts ?? [];
  const effort = fitEffort(efforts, chosenEffort ?? modelList?.defaultEffort ?? "high") ?? "high";
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api<GitHubStatus>("/api/github/status").then(setGitHub, () => undefined);
    api<{ environments: Environment[] }>("/api/environments").then(
      (res) => {
        setEnvironments(res.environments);
        setEnvironmentId(res.environments.find((e) => e.isDefault)?.id ?? "");
      },
      () => undefined,
    );
  }, []);

  useEffect(() => {
    if (!repo || !github?.connected) return;
    api<{ branches: string[] }>(`/api/github/repos/${repo.fullName}/branches`).then(
      (res) => {
        // 分支很多时可能没列全，保证默认分支一定在里面。
        const list = res.branches.includes(repo.defaultBranch)
          ? res.branches
          : [repo.defaultBranch, ...res.branches];
        setBranches(list);
        setBranch((current) => (list.includes(current) ? current : repo.defaultBranch));
      },
      () => setBranches([repo.defaultBranch]),
    );
  }, [repo, github?.connected]);

  const pick = (next: Repo) => {
    setRepo(next);
    setBranch(next.defaultBranch);
    setBranches([next.defaultBranch]);
    setPicking(false);
  };

  const start = async () => {
    if (!repo) {
      setPicking(true);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const session = await api<Session>("/api/sessions", {
        repo: repo.fullName,
        baseBranch: branch,
        environmentId: environmentId || undefined,
        model: model || undefined,
        effort,
        text,
      });
      remember({ repo, branch, model });
      setText("");
      onCreated(session);
      handOffFocus();
      navigate(`/s/${session.shortId}`);
    } catch (e) {
      setError((e as ApiError).message);
      setBusy(false);
    }
  };

  // GitHub 的状态还没回来时先把问候语和输入框摆好，下面一行等状态回来再淡入，免得整块内容突然冒出来。
  const connected = github?.connected ?? false;

  return (
    <section className="new-session">
      <div className="greeting">
        <Logo size={64} />
        <h1 className={`serif-text${greetingReady ? "" : " pending"}`}>{greeting}</h1>
      </div>
      {github && !connected && <GitHubConnectCard status={github} />}
      <div className="new-session-composer">
        <Composer
          value={text}
          onChange={setText}
          onSubmit={start}
          placeholder="描述任务或提出问题"
          busy={busy}
          canSubmit={connected}
          submitLabel="发起会话"
          autoFocus
        />
        {/* 输入框下面：环境、仓库、分支一行；模型和思考强度靠右 */}
        <div className="composer-below">
          {connected && (
            <div className="composer-below-options">
              {environments.length > 0 && (
                <SelectChip
                  icon={<BoxIcon />}
                  label="环境"
                  value={environmentId}
                  options={environments.map((env) => ({ value: env.id, text: env.name }))}
                  onChange={setEnvironmentId}
                />
              )}
              <button
                type="button"
                className={`chip${picking ? " active" : ""}`}
                aria-expanded={picking}
                onClick={() => setPicking(!picking)}
              >
                <GitHubMark size={14} />
                <span className="chip-text">{repo?.fullName ?? "选择仓库"}</span>
                {repo && !repo.canPush && <span className="chip-badge">只读</span>}
                <ChevronDownIcon />
              </button>
              {repo && (
                <SelectChip
                  icon={<BranchIcon />}
                  label="基础分支"
                  value={branch}
                  options={branches.map((b) => ({ value: b, text: b }))}
                  onChange={setBranch}
                />
              )}
            </div>
          )}
          {modelList && models.length > 0 && (
            <ModelPicker
              models={models}
              model={model}
              effort={effort}
              defaultEffort={modelList.defaultEffort}
              onChange={(m, e) => {
                setModel(m);
                setEffort(e);
              }}
            />
          )}
          {github && connected && picking && (
            <RepoPicker
              status={github}
              selected={repo}
              onPick={pick}
              onClose={() => setPicking(false)}
            />
          )}
        </div>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * 输入框里的下拉选择：按钮上只显示选中的那一项，宽度正好贴合文字；
 * 透明的原生下拉框盖在上面，点开就是系统自带的选择器（手机上好用）。
 */
function SelectChip({
  icon,
  label,
  value,
  options,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  options: Array<{ value: string; text: string }>;
  onChange: (value: string) => void;
}) {
  const current = options.find((o) => o.value === value)?.text ?? value;
  return (
    <label className="chip select-chip">
      {icon}
      <span className="chip-text">{current}</span>
      <ChevronDownIcon />
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.text}
          </option>
        ))}
      </select>
    </label>
  );
}

function RepoPicker({
  status,
  selected,
  onPick,
  onClose,
}: {
  status: GitHubStatus;
  selected?: Repo;
  onPick: (repo: Repo) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [repos, setRepos] = useState<Repo[]>();
  const [error, setError] = useState<string>();
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    search.current?.focus();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      const q = query.trim();
      api<{ repos: Repo[] }>(`/api/github/repos${q ? `?q=${encodeURIComponent(q)}` : ""}`).then(
        (res) => {
          setRepos(res.repos);
          setError(undefined);
        },
        (e) => setError(e.message),
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <section className="popover repo-picker" aria-label="选择仓库">
      <input
        ref={search}
        className="popover-search"
        type="search"
        placeholder="搜索仓库（含公开仓库）"
        aria-label="搜索仓库"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      />
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {repos && repos.length === 0 && (
        <p className="popover-empty">
          {query ? "未找到匹配的仓库。" : "暂无已安装 GitHub App 的仓库。"}
        </p>
      )}
      <ul className="repo-list">
        {repos?.map((repo) => (
          <li key={repo.fullName}>
            <button
              type="button"
              className={`repo${selected?.fullName === repo.fullName ? " selected" : ""}`}
              onClick={() => onPick(repo)}
            >
              <GitHubMark size={14} />
              <span className="repo-name">{repo.fullName}</span>
              <span className="badges">
                {repo.private && <span className="badge">私有</span>}
                {!repo.canPush && <span className="badge warn">只读</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="popover-foot">
        <span>
          <GitHubMark size={12} /> {status.login}
        </span>
        <a href={status.installUrl} target="_blank" rel="noreferrer">
          管理仓库权限
        </a>
      </div>
    </section>
  );
}
