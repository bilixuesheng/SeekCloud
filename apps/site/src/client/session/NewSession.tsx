import { fitEffort, type ThinkingEffort } from "@seekcloud/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiError, api } from "../api";
import { prefetch, useCached } from "../cached";
import { useDraft } from "../draft";
import { useSerifReady } from "../fonts";
import { GitHubConnectCard, type GitHubStatus } from "../GitHubConnectCard";
import { GitHubMark } from "../GitHubMark";
import { BoxIcon, BranchIcon, ChevronDownIcon } from "../Icons";
import { useLocale, useT } from "../i18n";
import { errorText } from "../i18n/errors";
import { Logo } from "../Logo";
import { usePresence } from "../Motion";
import { Slot } from "../registry";
import { navigate } from "../router";
import { Composer, handOffFocus } from "./Composer";
import { handOffFirstMessage } from "./first-message";
import { takeGreeting } from "./greetings";
import { ModelPicker } from "./ModelPicker";
import { OptionPicker } from "./OptionPicker";
import { localRegion } from "./region";
import { environmentLabel, type Session } from "./types";
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
  /** 没有就是不使用仓库（#191）。 */
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

/** 首页：写一句话，选仓库（可以不选，#191）、分支、环境和模型，发起会话。 */
export function NewSession({
  nickname,
  onCreated,
}: {
  /** 管理员的昵称，问候语里用；没设置时为 null。 */
  nickname: string | null;
  onCreated: (session: Session) => void;
}) {
  const t = useT();
  const [initial] = useState(remembered);
  // 问候语按界面语言挑；在首页上开着设置换了语言，回来看到的是新语言的一句
  const locale = useLocale();
  const [greeting, setGreeting] = useState(() => ({
    locale,
    text: takeGreeting(nickname, localRegion()),
  }));
  if (greeting.locale !== locale)
    setGreeting({ locale, text: takeGreeting(nickname, localRegion()) });
  const greetingReady = useSerifReady(greeting.text);
  const [github, setGitHub] = useState<GitHubStatus>();
  // GitHub 的状态回来（或者取失败）以前不能发送：免得记着的仓库还没认出来，就发成了不使用仓库的会话
  const [githubChecked, setGitHubChecked] = useState(false);
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
  // 模型没声明推理等级时只有"关闭"（由接口自己决定思考不思考）
  const effort =
    efforts.length === 0
      ? "off"
      : (fitEffort(efforts, chosenEffort ?? modelList?.defaultEffort ?? "high") ?? "high");
  const [picking, setPicking] = useState(false);
  const closePicker = useCallback(() => setPicking(false), []);
  // 关的时候先播完收起的动画再拿掉（和环境、分支的弹层一样）
  const repoPicker = usePresence(picking, 180);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api<GitHubStatus>("/api/github/status")
      .then(
        (status) => {
          setGitHub(status);
          // 先把仓库列表拉下来放着：点"选择仓库"时列表直接就在，不用打开以后再等
          if (status.connected) prefetch([REPOS]);
        },
        () => undefined,
      )
      .finally(() => setGitHubChecked(true));
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

  const pick = (next: Repo | undefined) => {
    setRepo(next);
    setBranch(next?.defaultBranch ?? "");
    setBranches(next ? [next.defaultBranch] : []);
    setPicking(false);
  };

  // GitHub 的状态回来以前先摆好问候语和输入框，下面一行等状态回来再淡入，免得整块内容突然冒出来。
  const connected = github?.connected ?? false;
  // 没关联 GitHub 时记着的仓库用不上：发起不使用仓库的会话
  const chosen = connected ? repo : undefined;

  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const session = await api<Session>("/api/sessions", {
        ...(chosen ? { repo: chosen.fullName, baseBranch: branch } : {}),
        environmentId: environmentId || undefined,
        model: model || undefined,
        effort,
        text,
      });
      remember({ repo: chosen, branch: chosen ? branch : undefined, model });
      setText("");
      onCreated(session);
      handOffFirstMessage(session.shortId, text);
      handOffFocus();
      navigate(`/s/${session.shortId}`);
    } catch (e) {
      setError(errorText(e as ApiError));
      setBusy(false);
    }
  };

  return (
    <section className="new-session">
      <div className="greeting">
        {/* 首页用原图；发起会话时它挪到会话页底部（同名的 view transition），在那里变小以后才换成会动的鲸鱼 */}
        <Logo size={64} transitionName="seekcloud-whale" />
        <h1 className={`serif-text${greetingReady ? "" : " pending"}`}>{greeting.text}</h1>
      </div>
      {/* 问候语下方（插槽，registry.tsx）："有会话在等你输入"的提示放这里 */}
      <Slot name="home-below-greeting" />
      {github && !connected && <GitHubConnectCard status={github} />}
      <div className="new-session-composer">
        <Composer
          value={text}
          onChange={setText}
          onSubmit={start}
          placeholder={t("newSession.placeholder")}
          busy={busy}
          canSubmit={githubChecked}
          submitLabel={t("newSession.submit")}
          autoFocus
          attach={{ vision: models.find((m) => m.id === model)?.vision ?? false }}
        />
        {/* 输入框下面：环境、仓库、分支一行；模型和思考强度靠右 */}
        <div className="composer-below">
          {githubChecked && (
            <div className="composer-below-options">
              {environments.length > 0 && (
                <OptionPicker
                  icon={<BoxIcon />}
                  label={t("environment.label")}
                  searchLabel={t("environment.search")}
                  value={environmentId}
                  options={environments.map((env) => ({
                    value: env.id,
                    text: environmentLabel(env.name),
                  }))}
                  onChange={setEnvironmentId}
                  onOpen={() => setPicking(false)}
                />
              )}
              {/* 没关联 GitHub 时只能不使用仓库（上面有关联 GitHub 的卡片） */}
              {connected && (
                <button
                  type="button"
                  className={`chip repo-chip${picking ? " active" : ""}`}
                  aria-expanded={picking}
                  onClick={() => setPicking(!picking)}
                >
                  <GitHubMark size={14} />
                  <span className="chip-text">{repo?.fullName ?? t("newSession.noRepo")}</span>
                  {repo && !repo.canPush && (
                    <span className="chip-badge">{t("repo.readOnly")}</span>
                  )}
                  <ChevronDownIcon />
                </button>
              )}
              {chosen && (
                <OptionPicker
                  icon={<BranchIcon />}
                  label={t("newSession.baseBranch")}
                  searchLabel={t("newSession.searchBranches")}
                  value={branch}
                  options={branches.map((b) => ({ value: b, text: b }))}
                  onChange={setBranch}
                  onOpen={() => setPicking(false)}
                  searchable
                  emptyText={t("newSession.noBranchMatch")}
                />
              )}
            </div>
          )}
          {modelList && models.length === 0 && (
            // 一个能用的模型都没有（没填 key、提供方都停用了）：先去设置里添加，照 dsh 的"选择模型"
            <button
              type="button"
              className="chip model-trigger"
              onClick={() => navigate("/settings/model")}
            >
              <span className="chip-text">{t("newSession.chooseModel")}</span>
            </button>
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
                // 照 dsh：选了模型也就成了新会话的默认模型（别的设备、下次打开都用它）
                if (m !== model) {
                  void api("/api/settings/default-model", { model: m }, "PUT").catch(
                    () => undefined,
                  );
                }
              }}
            />
          )}
          <Slot name="composer-below" />
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
  /** undefined 是不使用仓库。 */
  onPick: (repo: Repo | undefined) => void;
  onClose: () => void;
}) {
  const t = useT();
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
        (e: ApiError) => setSearchError(errorText(e)),
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  return (
    <section
      ref={root}
      className={`popover repo-picker${closing ? " closing" : ""}`}
      aria-label={t("repoPicker.title")}
    >
      <input
        ref={search}
        className="popover-search"
        type="search"
        placeholder={t("repoPicker.search")}
        aria-label={t("repoPicker.searchLabel")}
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
        <p className="popover-empty">{query ? t("repoPicker.noMatch") : t("repoPicker.empty")}</p>
      )}
      <ul className="repo-list">
        {/* 不使用仓库（#191）：沙箱里不克隆，Agent 在空的工作目录里工作 */}
        {!q && (
          <li>
            <button
              type="button"
              className={`repo${selected ? "" : " selected"}`}
              onClick={() => onPick(undefined)}
            >
              <BoxIcon />
              <span className="repo-name">{t("newSession.noRepo")}</span>
            </button>
          </li>
        )}
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
                {repo.private && <span className="badge">{t("repo.private")}</span>}
                {!repo.canPush && <span className="badge warn">{t("repo.readOnly")}</span>}
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
          {t("repoPicker.manage")}
        </a>
      </div>
    </section>
  );
}
