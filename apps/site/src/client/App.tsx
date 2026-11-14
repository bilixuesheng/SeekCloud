import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiError, api } from "./api";
import { takeAuthResult } from "./auth-results";
import {
  ChevronRightIcon,
  CloseIcon,
  LogoutIcon,
  MenuIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
} from "./Icons";
import { LoginPage } from "./LoginPage";
import { Brand, Logo } from "./Logo";
import { LegalLink, LegalPage } from "./legal/LegalPage";
import { Collapse } from "./Motion";
import { navigate, pathOf, type Route, useRoute } from "./router";
import { NewSession } from "./session/NewSession";
import { SessionList } from "./session/SessionList";
import { SessionPage } from "./session/SessionPage";
import { useSessions } from "./session/useSessions";
import { SettingsDialog } from "./settings/SettingsDialog";

interface Me {
  id: string;
  /** 关联的 GitHub 用户名；没关联时为 null。 */
  githubLogin: string | null;
  /** 昵称，首页的问候语里用；加上昵称之前就设置好的部署是 null。 */
  nickname: string | null;
}

export function App() {
  // undefined：还在问；null：没登录；"setup"：还没设置管理员密码。
  const [me, setMe] = useState<Me | "setup" | null>();
  const [notice] = useState(takeAuthResult);
  const route = useRoute();

  const refresh = useCallback(() => {
    api<Me>("/api/me").then(setMe, (e: ApiError) =>
      setMe(e.code === "setup_required" ? "setup" : null),
    );
  }, []);

  useEffect(refresh, [refresh]);

  // 开源声明：登没登录都能看。
  if (route.page === "legal") return <LegalPage doc={route.doc} />;

  // 等登录状态的时候先空着；超过一小会儿还没回来，才淡入一个标志（见 .splash），快的时候什么都不闪。
  if (me === undefined) {
    return (
      <div className="splash" aria-hidden="true">
        <Logo size={56} />
      </div>
    );
  }
  if (me === null || me === "setup") {
    return <LoginPage setup={me === "setup"} onSignedIn={refresh} notice={notice} />;
  }
  return <Shell me={me} notice={notice} onSignedOut={refresh} onGitHubChanged={refresh} />;
}

function HomeLink() {
  return (
    <a
      href="/"
      className="home-link"
      onClick={(e) => {
        e.preventDefault();
        navigate("/");
      }}
    >
      <Brand size={28} />
    </a>
  );
}

/** 登录后的页面：左边是会话列表（手机上收进抽屉），右边是首页或会话页。 */
function Shell({
  me,
  notice,
  onSignedOut,
  onGitHubChanged,
}: {
  me: Me;
  /** 关联 GitHub 跳回来时出的问题。 */
  notice?: string;
  onSignedOut: () => void;
  onGitHubChanged: () => void;
}) {
  const route = useRoute();
  // 设置是盖在原来页面上的弹窗：记住打开设置之前在哪一页，底下照常显示它，关掉时回去。
  const lastPage = useRef<Route>({ page: "home" });
  if (route.page !== "settings") lastPage.current = route;
  const page = route.page === "settings" ? lastPage.current : route;
  const closeSettings = useCallback(() => navigate(pathOf(lastPage.current)), []);
  const settingsOpen = route.page === "settings";
  const { sessions, loaded, upsert } = useSessions();
  const [drawer, setDrawer] = useState(false);
  const [search, setSearch] = useState("");
  const currentId = page.page === "session" ? page.id : undefined;
  const current = sessions.find((s) => s.shortId === currentId);
  const query = search.trim().toLowerCase();
  const shown = query
    ? sessions.filter(
        (s) =>
          s.title.toLowerCase().includes(query) ||
          s.repos.some((r) => r.fullName.toLowerCase().includes(query)),
      )
    : sessions;
  // 已归档的会话收在列表最下面的一组里；搜索时一起搜
  const archived = query ? [] : shown.filter((s) => s.status === "archived");
  const listed = query ? shown : shown.filter((s) => s.status !== "archived");
  const [showArchived, setShowArchived] = useState(false);
  const newSession = () => {
    navigate("/");
    setDrawer(false);
  };

  return (
    <div className="shell">
      {/* 设置窗口打开时，底下的页面不能用 Tab 或读屏摸到 */}
      <aside
        className={`sidebar${drawer ? " open" : ""}`}
        aria-label="会话列表"
        inert={settingsOpen}
      >
        <div className="sidebar-head">
          {/* 手机上侧栏铺满整屏（照 Claude），左上角是收起按钮 */}
          <button
            type="button"
            className="icon-button sidebar-close"
            aria-label="收起会话列表"
            onClick={() => setDrawer(false)}
          >
            <CloseIcon size={18} />
          </button>
          <HomeLink />
        </div>
        <button type="button" className="new-session-button" onClick={newSession}>
          <span className="new-session-icon">
            <PlusIcon size={14} />
          </span>
          新会话
        </button>
        <label className="sidebar-search">
          <SearchIcon />
          <input
            type="search"
            placeholder="搜索会话"
            aria-label="搜索会话"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="sidebar-section">最近</div>
        <div className="sidebar-list">
          <SessionList
            sessions={listed}
            loaded={loaded}
            currentId={currentId}
            searching={query !== ""}
            onPick={() => setDrawer(false)}
          />
          {archived.length > 0 && (
            <div className="sidebar-archived">
              <button
                type="button"
                className={`sidebar-archived-toggle${showArchived ? " open" : ""}`}
                aria-expanded={showArchived}
                onClick={() => setShowArchived((v) => !v)}
              >
                <span className="sidebar-archived-chevron">
                  <ChevronRightIcon />
                </span>
                已归档
                <span className="sidebar-archived-count">{archived.length}</span>
              </button>
              <Collapse open={showArchived}>
                <SessionList
                  sessions={archived}
                  loaded
                  currentId={currentId}
                  onPick={() => setDrawer(false)}
                />
              </Collapse>
            </div>
          )}
        </div>
        <AccountFoot
          name={me.nickname ?? me.githubLogin ?? "管理员"}
          onSettings={() => {
            navigate("/settings/general");
            setDrawer(false);
          }}
          onSignedOut={onSignedOut}
        />
      </aside>
      {/* 遮罩一直在，开关时淡入淡出；收起时不挡点击，也不进 Tab 顺序 */}
      <button
        type="button"
        className={`scrim${drawer ? " open" : ""}`}
        aria-label="收起会话列表"
        aria-hidden={!drawer}
        tabIndex={drawer ? 0 : -1}
        onClick={() => setDrawer(false)}
      />

      <div className="main" inert={settingsOpen}>
        {/* 会话页有自己的顶栏（会话标题和菜单），这条只在首页用 */}
        <header className={`mobile-bar${page.page === "session" ? " hidden" : ""}`}>
          <button
            type="button"
            className="icon-button"
            aria-label="会话列表"
            aria-expanded={drawer}
            onClick={() => setDrawer(true)}
          >
            <MenuIcon />
          </button>
          <span className="mobile-title">新会话</span>
          <button type="button" className="icon-button" aria-label="新会话" onClick={newSession}>
            <PlusIcon size={20} />
          </button>
        </header>

        {page.page === "session" ? (
          <SessionPage key={page.id} id={page.id} listed={current} onMenu={() => setDrawer(true)} />
        ) : (
          <main className="home">
            <div className="home-inner">
              {notice && route.page !== "settings" && (
                <p className="alert" role="alert">
                  {notice}
                </p>
              )}
              <NewSession nickname={me.nickname} onCreated={upsert} />
            </div>
          </main>
        )}
      </div>
      {route.page === "settings" && (
        <SettingsDialog
          section={route.section}
          notice={notice}
          onClose={closeSettings}
          onSignedOut={onSignedOut}
          onGitHubChanged={onGitHubChanged}
          onProfileChanged={onGitHubChanged}
        />
      )}
    </div>
  );
}

/**
 * 侧边栏底部的账户：点一下弹出菜单（设置、退出登录）；右边的齿轮直接打开设置。
 */
function AccountFoot({
  name,
  onSettings,
  onSignedOut,
}: {
  /** 关联了 GitHub 时是 GitHub 用户名，否则是"管理员"。 */
  name: string;
  onSettings: () => void;
  onSignedOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="sidebar-foot" ref={root}>
      {open && (
        <div className="popover account-menu" role="menu">
          <div className="account-menu-name">{name}</div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSettings();
            }}
          >
            <SettingsIcon />
            设置
          </button>
          <div className="popover-divider" />
          <button
            type="button"
            role="menuitem"
            onClick={() => api("/api/auth/logout", {}).then(onSignedOut)}
          >
            <LogoutIcon />
            退出登录
          </button>
          <div className="account-menu-legal">
            <LegalLink doc="licenses" newTab />
          </div>
        </div>
      )}
      <button
        type="button"
        className={`account-button${open ? " active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="avatar" aria-hidden="true">
          {name[0]?.toUpperCase()}
        </span>
        <span className="account-name" title={name}>
          {name}
        </span>
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="设置"
        title="设置"
        onClick={onSettings}
      >
        <SettingsIcon />
      </button>
    </div>
  );
}
