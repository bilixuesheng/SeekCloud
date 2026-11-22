import { MAX_GROUP_NAME, type SessionGroup } from "@seekcloud/protocol";
import type { ReactNode } from "react";
import {
  type ComponentType,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { type ApiError, api } from "./api";
import { takeAuthResult } from "./auth-results";
import {
  ChevronRightIcon,
  CloseIcon,
  LogoutIcon,
  MenuIcon,
  MoreIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
} from "./Icons";
import { LoginPage } from "./LoginPage";
import { Brand, Logo } from "./Logo";
import { LegalLink } from "./legal/LegalPage";
import { Collapse, useFlip, usePresence } from "./Motion";
import { rememberNickname } from "./nickname";
import type { OverlayProps, PageProps } from "./registry";
import { Slot, useRegistry } from "./registry";
import { isOverlay, navigate, pathOf, type Route, setOverlayOpen, useRoute } from "./router";
import { GroupMenu, renameGroup } from "./session/GroupMenu";
import { SessionList } from "./session/SessionList";
import { sidebarSections, useCollapsed } from "./session/sidebar-sections";
import { useSessions } from "./session/useSessions";
import { type DragState, useSidebarDrag } from "./session/useSidebarDrag";
import { type Me, ShellProvider, type ShellValue } from "./shell";

export function App() {
  // undefined：还在问；null：没登录；"setup"：还没设置管理员密码。
  const [me, setMe] = useState<Me | "setup" | null>();
  const [notice] = useState(takeAuthResult);
  const route = useRoute();
  const registry = useRegistry();

  const refresh = useCallback(() => {
    api<Me>("/api/me").then(
      (res) => {
        rememberNickname(res.nickname);
        setMe(res);
      },
      (e: ApiError) => setMe(e.code === "setup_required" ? "setup" : null),
    );
  }, []);

  useEffect(refresh, [refresh]);

  // 不用登录也能看的页面（开源声明）：不等登录状态，占满整个窗口。
  const entry = registry.pageById(route.page);
  if (entry?.public) {
    const Page = entry.component as ComponentType<PageProps>;
    return <Page params={route.params} />;
  }

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
  return <Shell me={me} notice={notice} onSignedOut={refresh} onProfileChanged={refresh} />;
}

/** 侧栏左上角的标志：回首页。点了侧栏照样收起（手机上不做主区域的过渡，见 newSession）。 */
/**
 * 侧栏里能折叠的一类（置顶、每个分组，#153）：标题点了折叠或展开，记在这台设备上（useCollapsed）。
 * 分组的标题右边有"⋯"（重命名、删除）。
 */
function SidebarSection({
  id,
  name,
  collapsed,
  onToggle,
  onMore,
  active = false,
  editing = false,
  onRename,
  children,
}: {
  id: string;
  name: string;
  collapsed: boolean;
  onToggle: () => void;
  onMore?: () => void;
  /** 拖动时手指正在这一块上。 */
  active?: boolean;
  /** 刚拖到"新分组"建好的分组：名字马上可以改，回车或点别处保存，Esc 不改。 */
  editing?: boolean;
  onRename?: (name: string) => Promise<void>;
  children: ReactNode;
}) {
  return (
    <div
      className={`sidebar-group${active ? " drop-active" : ""}`}
      data-flip={`section:${id}`}
      data-drop={id}
      data-collapsed={collapsed ? "" : undefined}
    >
      <div className="sidebar-section-head">
        {editing && onRename ? (
          <GroupNameInput name={name} onDone={onRename} />
        ) : (
          <button
            type="button"
            className="sidebar-section-toggle"
            aria-expanded={!collapsed}
            onClick={onToggle}
          >
            <span className="sidebar-section-name">{name}</span>
            <span className="sidebar-section-chevron">
              <ChevronRightIcon />
            </span>
          </button>
        )}
        {onMore && (
          <button
            type="button"
            className="sidebar-section-more"
            aria-label={`分组菜单：${name}`}
            aria-haspopup="dialog"
            onClick={onMore}
          >
            <MoreIcon />
          </button>
        )}
      </div>
      <Collapse open={!collapsed}>{children}</Collapse>
    </div>
  );
}

/** 分组名的输入框（拖到"新分组"建好以后）：打开时全选，回车或点别处保存，Esc 保留原来的名字。 */
function GroupNameInput({
  name,
  onDone,
}: {
  name: string;
  onDone: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState(name);
  const done = useRef(false);
  const finish = (next: string) => {
    if (done.current) return;
    done.current = true;
    void onDone(next.trim() || name);
  };
  return (
    <input
      className="sidebar-group-name-input"
      aria-label="分组名"
      value={value}
      maxLength={MAX_GROUP_NAME}
      // biome-ignore lint/a11y/noAutofocus: 刚建好的分组，名字马上要改（照 Claude）
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(value);
        if (e.key === "Escape") finish(name);
      }}
    />
  );
}

/** 拖动时浮起来的会话、插入线和"松手取消置顶"的提示。都不接指针事件。 */
function DragOverlay({ drag, list }: { drag: DragState; list: HTMLElement | null }) {
  const rect = list?.getBoundingClientRect();
  const left = (rect?.left ?? 0) + 8;
  const width = (rect?.width ?? 280) - 16;
  const target = drag.target;
  return (
    <>
      {target && target.zone !== "new-group" && (
        <div className="drop-line" style={{ top: target.lineY - 1, left, width }} />
      )}
      <div className="drag-ghost" style={{ top: drag.y - 26, left, width }} aria-hidden="true">
        <span className="session-item-title">{drag.title}</span>
        <span className="session-item-repo">{drag.repo}</span>
      </div>
      {drag.fromPinned && target && target.zone !== "pinned" && (
        <div className="drag-unpin" style={{ top: drag.y + 30, left: Math.max(8, drag.x - 60) }}>
          松手取消置顶
        </div>
      )}
    </>
  );
}

/** 媒体查询现在成不成立，变了跟着变。 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const onChange = () => setMatches(list.matches);
    list.addEventListener("change", onChange);
    onChange();
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

function HomeLink({ onClick }: { onClick: () => void }) {
  return (
    <a
      href="/"
      className="home-link"
      onClick={(e) => {
        e.preventDefault();
        onClick();
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
  onProfileChanged,
}: {
  me: Me;
  /** 关联 GitHub 跳回来时出的问题。 */
  notice?: string;
  onSignedOut: () => void;
  onProfileChanged: () => void;
}) {
  const route = useRoute();
  const registry = useRegistry();
  // 设置这类弹窗盖在原来的页面上：记住打开之前在哪一页，底下照常显示它，关掉时回去。
  const lastPage = useRef<Route>({ page: "home", params: {} });
  const overlayRoute = isOverlay(route);
  if (!overlayRoute) lastPage.current = route;
  const page = overlayRoute ? lastPage.current : route;
  const closeOverlay = useCallback(() => navigate(pathOf(lastPage.current)), []);
  // 关弹窗时先播完收起的动画再拿掉；这段时间里还画着关之前的那个分类
  const overlay = usePresence(overlayRoute, 200);
  const lastOverlay = useRef<Route>(route);
  if (overlayRoute) lastOverlay.current = route;
  const { sessions, groups, loaded, upsert } = useSessions();
  const [drawer, setDrawer] = useState(false);
  const [search, setSearch] = useState("");
  const currentId = page.page === "session" ? page.params.id : undefined;
  const query = search.trim().toLowerCase();
  // 侧栏从上到下：置顶、各个分组、最近，已归档的收在最下面（#153）；搜索时不分类，一起搜
  const sections = sidebarSections(sessions, groups, query);
  const { pinned, archived, recent: listed } = sections;
  const [showArchived, setShowArchived] = useState(false);
  const [collapsed, toggleCollapsed] = useCollapsed();
  const [groupMenu, setGroupMenu] = useState<SessionGroup>();
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  // 侧栏开着时换页（回首页、删掉正在看的会话）不做主区域的过渡：侧栏自己滑走就是过渡（router.ts）
  useLayoutEffect(() => setOverlayOpen(drawer), [drawer]);
  // 置顶、取消置顶、会话换位置时平滑地滑过去（Motion.tsx 的 useFlip）
  const sidebarList = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  useFlip(sidebarList);
  // 拖动（#153）：手机上先横着走才算拖；全屏的侧栏往左滑能拖回去
  const narrow = useMediaQuery("(max-width: 899px)");
  const [editingGroup, setEditingGroup] = useState<string>();
  const [dragError, setDragError] = useState<string>();
  useEffect(() => {
    if (!dragError) return;
    const timer = setTimeout(() => setDragError(undefined), 4000);
    return () => clearTimeout(timer);
  }, [dragError]);
  const drag = useSidebarDrag({
    list: sidebarList,
    sidebar: sidebarRef,
    sessions,
    fullScreen: drawer && narrow,
    onClose: () => setDrawer(false),
    upsert,
    onGroupCreated: setEditingGroup,
    onError: setDragError,
  });
  const dragging = drag !== undefined && query === "";
  const dropZone = drag?.target?.zone;
  const newSession = () => {
    navigate("/");
    setDrawer(false);
  };
  const shell: ShellValue = {
    me,
    notice,
    sessions,
    groups,
    upsert,
    openDrawer: () => setDrawer(true),
    overlayOpen: overlayRoute,
    onSignedOut,
    onProfileChanged,
  };
  const pageEntry = registry.pageById(page.page);
  const Page = pageEntry?.component as ComponentType<PageProps> | undefined;
  const overlayEntry = registry.pageById(lastOverlay.current.page);
  const Overlay = overlayEntry?.component as ComponentType<OverlayProps> | undefined;

  return (
    <ShellProvider value={shell}>
      <div className="shell">
        {/* 设置窗口打开时，底下的页面不能用 Tab 或读屏摸到 */}
        <aside
          ref={sidebarRef}
          className={`sidebar${drawer ? " open" : ""}${dragging ? " dragging" : ""}`}
          aria-label="会话列表"
          inert={overlayRoute}
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
            <HomeLink onClick={newSession} />
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
          {dragError && (
            <p className="alert sidebar-alert" role="alert">
              {dragError}
            </p>
          )}
          <div className="sidebar-list" ref={sidebarList}>
            {/* 拖动一开始顶上就有置顶区；还没有置顶的会话时显示"拖到这里" */}
            {dragging && pinned.length === 0 && (
              <div
                className={`sidebar-drop-zone${dropZone === "pinned" ? " active" : ""}`}
                data-drop="pinned"
              >
                拖到这里置顶
              </div>
            )}
            {pinned.length > 0 && (
              <SidebarSection
                id="pinned"
                name="已置顶"
                collapsed={collapsed.has("pinned")}
                onToggle={() => toggleCollapsed("pinned")}
                active={dropZone === "pinned"}
              >
                <SessionList
                  sessions={pinned}
                  draggingId={drag?.shortId}
                  loaded
                  currentId={currentId}
                  onPick={() => setDrawer(false)}
                />
              </SidebarSection>
            )}
            {sections.groups.map(({ group, sessions: inGroup }) => (
              <SidebarSection
                key={group.id}
                id={`group:${group.id}`}
                name={group.name}
                collapsed={collapsed.has(`group:${group.id}`)}
                onToggle={() => toggleCollapsed(`group:${group.id}`)}
                active={dropZone === `group:${group.id}`}
                editing={editingGroup === group.id}
                onRename={async (name) => {
                  setEditingGroup(undefined);
                  if (name === group.name) return;
                  await renameGroup(group.id, name).catch((e: ApiError) => setDragError(e.message));
                }}
                onMore={() => {
                  setGroupMenu(group);
                  setGroupMenuOpen(true);
                }}
              >
                {inGroup.length > 0 ? (
                  <SessionList
                    sessions={inGroup}
                    draggingId={drag?.shortId}
                    loaded
                    currentId={currentId}
                    onPick={() => setDrawer(false)}
                  />
                ) : (
                  <p className="session-list-empty">分组中暂无会话。</p>
                )}
              </SidebarSection>
            ))}
            {/* 会话都置顶了或都在分组里时不显示空的"最近" */}
            {(listed.length > 0 || (pinned.length === 0 && sections.groups.length === 0)) && (
              <div
                className={`sidebar-group${dropZone === "recent" ? " drop-active" : ""}`}
                data-drop="recent"
              >
                <div className="sidebar-section" data-flip="section:recent">
                  最近
                </div>
                <SessionList
                  sessions={listed}
                  loaded={loaded}
                  currentId={currentId}
                  searching={query !== ""}
                  draggingId={drag?.shortId}
                  onPick={() => setDrawer(false)}
                />
              </div>
            )}
            {archived.length > 0 && (
              <div className="sidebar-archived" data-flip="section:archived">
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
                    flip={false}
                    currentId={currentId}
                    onPick={() => setDrawer(false)}
                  />
                </Collapse>
              </div>
            )}
          </div>
          {/* 拖动时底部浮出"新分组"：拖上去松手就新建一个分组、把会话放进去 */}
          {dragging && (
            <div
              className={`sidebar-new-group${dropZone === "new-group" ? " active" : ""}`}
              data-drop="new-group"
              data-floating
            >
              <PlusIcon size={14} />
              新分组
            </div>
          )}
          {dragging && drag && <DragOverlay drag={drag} list={sidebarList.current} />}
          {groupMenu && (
            <GroupMenu
              group={groups.find((g) => g.id === groupMenu.id) ?? groupMenu}
              open={groupMenuOpen}
              onClose={() => setGroupMenuOpen(false)}
            />
          )}
          <Slot name="sidebar-foot" />
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

        <div className="main" inert={overlayRoute}>
          {/* 会话页有自己的顶栏（会话标题和菜单），这条只在首页用 */}
          <header className={`mobile-bar${pageEntry?.ownHeader ? " hidden" : ""}`}>
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

          {Page && <Page key={pathOf(page)} params={page.params} />}
        </div>
        {overlay.mounted && Overlay && (
          <Overlay
            params={lastOverlay.current.params}
            closing={overlay.closing}
            onClose={closeOverlay}
          />
        )}
      </div>
    </ShellProvider>
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
  // 收起时也有动画，和弹出一样快（.popover.closing）
  const menu = usePresence(open, 180);
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
      {menu.mounted && (
        <div className={`popover account-menu${menu.closing ? " closing" : ""}`} role="menu">
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
