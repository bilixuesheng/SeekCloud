import { fitEffort, type ThinkingEffort } from "@seekcloud/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiError, api } from "../api";
import { prefetch, useCached } from "../cached";
import { useDraft } from "../draft";
import { useSerifReady } from "../fonts";
import { GitHubConnectCard, type GitHubStatus } from "../GitHubConnectCard";
import { GitHubMark } from "../GitHubMark";
import { BoxIcon, BranchIcon, ChevronDownIcon } from "../Icons";
import { Logo } from "../Logo";
import { usePresence } from "../Motion";
import { navigate } from "../router";
import { Composer, handOffFocus } from "./Composer";
import { handOffFirstMessage } from "./first-message";
import { takeGreeting } from "./greetings";
import { ModelPicker } from "./ModelPicker";
import { OptionPicker } from "./OptionPicker";
import { localRegionName } from "./region";
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
export function NewSession({
  nickname,
  onCreated,
}: {
  /** 管理员的昵称，问候语里用；没设置时为 null。 */
  nickname: string | null;
  onCreated: (session: Session) => void;
}) {
  const [initial] = useState(remembered);
  const [greeting] = useState(() => takeGreeting(nickname, localRegionName()));
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
  const closePicker = useCallback(() => setPicking(false), []);
  // 关的时候先播完收起的动画再拿掉（和环境、分支的弹层一样）
  const repoPicker = usePresence(picking, 180);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api<GitHubStatus>("/api/github/status").then(
      (status) => {
        setGitHub(status);
        // 先把仓库列表拉下来放着：点"选择仓库"时列表直接就在，不用打开以后再等
        if (status.connected) prefetch([REPOS]);
      },
      () => undefined,
    );
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
      handOffFirstMessage(session.shortId, text);
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
        {/* 首页用原图；发起会话时它挪到会话页底部（同名的 view transition），在那里变小以后才换成会动的鲸鱼 */}
        <Logo size={64} transitionName="seekcloud-whale" />
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
                <OptionPicker
                  icon={<BoxIcon />}
                  label="环境"
                  value={environmentId}
                  options={environments.map((env) => ({ value: env.id, text: env.name }))}
                  onChange={setEnvironmentId}
                  onOpen={() => setPicking(false)}
                />
              )}
              <button
                type="button"
                className={`chip repo-chip${picking ? " active" : ""}`}
                aria-expanded={picking}
                onClick={() => setPicking(!picking)}
              >
                <GitHubMark size={14} />
                <span className="chip-text">{repo?.fullName ?? "选择仓库"}</span>
                {repo && !repo.canPush && <span className="chip-badge">只读</span>}
                <ChevronDownIcon />
              </button>
              {repo && (
                <OptionPicker
                  icon={<BranchIcon />}
                  label="基础分支"
                  value={branch}
                  options={branches.map((b) => ({ value: b, text: b }))}
                  onChange={setBranch}
                  onOpen={() => setPicking(false)}
                  searchable
                  emptyText="未找到匹配的分支。"
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
          {github && connected && repoPicker.mounted && (
            <RepoPicker
              status={github}
              selected={repo}
              closing={repoPicker.closing}
              onPick={pick}
              onClose={closePicker}
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

const REPOS = "/api/github/repos";

function RepoPicker({
  status,
  selected,
  closing,
  onPick,
  onClose,
}: {
  status: GitHubStatus;
  selected?: Repo;
  closing: boolean;
  onPick: (repo: Repo) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  // 不搜的时候用预先拉好的列表（打开首页时就开始拉了）；搜的时候先在这份里筛，服务器的结果（含公开仓库）回来再换上
  const all = useCached<{ repos: Repo[] }>(REPOS);
  const [found, setFound] = useState<{ q: string; repos: Repo[] }>();
  const [searchError, setSearchError] = useState<string>();
  const search = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLElement>(null);
  const q = query.trim();
  const local = all.data?.repos.filter((r) => r.fullName.toLowerCase().includes(q.toLowerCase()));
  const repos = !q ? all.data?.repos : found?.q === q ? found.repos : local;
  const error = q ? searchError : all.error;

  // 点弹层外面或按 Esc 收起；点"选择仓库"那个按钮由按钮自己开关
  useEffect(() => {
    if (closing) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Element;
      if (!root.current?.contains(target) && !target.closest?.(".repo-chip")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, closing]);

  // 电脑上打开就能直接打字；手机上不自动选中搜索框，免得输入法弹出来把列表挡住
  useEffect(() => {
    if (!window.matchMedia("(pointer: coarse)").matches) search.current?.focus();
  }, []);

  useEffect(() => {
    if (!q) return;
    const timer = setTimeout(() => {
      api<{ repos: Repo[] }>(`${REPOS}?q=${encodeURIComponent(q)}`).then(
        (res) => {
          setFound({ q, repos: res.repos });
          setSearchError(undefined);
        },
        (e: ApiError) => setSearchError(e.message),
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  return (
    <section
      ref={root}
      className={`popover repo-picker${closing ? " closing" : ""}`}
      aria-label="选择仓库"
    >
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
