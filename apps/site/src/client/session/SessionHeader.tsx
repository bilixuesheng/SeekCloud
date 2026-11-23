import { MAX_GROUP_NAME } from "@seekcloud/protocol";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { type ApiError, api } from "../api";
import { copyText } from "../copy";
import { GitHubMark } from "../GitHubMark";
import {
  ArchiveIcon,
  BoxIcon,
  BranchIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DotIcon,
  ExternalIcon,
  LinkIcon,
  ListIcon,
  MenuIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  TrashIcon,
} from "../Icons";
import { useT } from "../i18n";
import { errorText } from "../i18n/errors";
import { Pages, Sheet, usePresence } from "../Motion";
import { navigate } from "../router";
import { useShell } from "../shell";
import { PullRequestBadge, pullRequestText } from "./PullRequestBadge";
import { environmentLabel, type Session, statusWithDetail } from "./types";

/** 标题菜单里的几页：菜单本身、打开方式、重命名、确认删除、移到分组、新分组。 */
type MenuPage = "menu" | "open" | "rename" | "delete" | "group" | "new-group";
const MENU_PAGES: MenuPage[] = ["menu", "open", "rename", "delete", "group", "new-group"];

/**
 * 会话页的顶栏（照 Claude Code 手机版）：侧栏按钮（只在手机上）、会话标题和 ⌄、会话信息。
 * 点标题弹出底部菜单；点会话信息往下弹一张卡片。
 * 文件、"⋯"菜单要等对应的功能做好才放（#38 等）；分享不做（2026-11-11 定的）。
 */
export function SessionHeader({
  id,
  session,
  onMenu,
}: {
  id: string;
  session: Session | undefined;
  /** 手机上打开侧栏。 */
  onMenu: () => void;
}) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);

  return (
    <header className="session-header">
      <button
        type="button"
        className="icon-button session-header-menu"
        aria-label={t("sidebar.label")}
        onClick={onMenu}
      >
        <MenuIcon />
      </button>
      <button
        type="button"
        className="session-title-button"
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        disabled={!session}
        onClick={() => setMenuOpen(true)}
      >
        <span className="session-title">{session?.title ?? ""}</span>
        <span className="session-title-chevron">
          <ChevronDownIcon />
        </span>
      </button>
      <div className="session-header-actions">
        <button
          type="button"
          className={`icon-button${infoOpen ? " active" : ""}`}
          aria-label={t("session.info")}
          aria-expanded={infoOpen}
          data-tip={t("session.info")}
          disabled={!session}
          onClick={() => setInfoOpen((v) => !v)}
        >
          <ListIcon />
        </button>
      </div>
      {session && (
        <SessionInfo session={session} open={infoOpen} onClose={() => setInfoOpen(false)} />
      )}
      {session && (
        <SessionMenu id={id} session={session} open={menuOpen} onClose={() => setMenuOpen(false)} />
      )}
    </header>
  );
}

/** 会话信息：从顶栏往下弹的卡片。上下文、连接器、提醒要等对应的功能做好再加。 */
function SessionInfo({
  session,
  open,
  onClose,
}: {
  session: Session;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const { mounted, shown } = usePresence(open, 200);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Element;
      // 点顶栏上的按钮由按钮自己处理（再点一下是收起），不在这里关
      if (card.current?.contains(target) || target.closest?.(".session-header-actions")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!mounted) return null;
  return (
    <div
      ref={card}
      className={`popover session-info${shown && open ? " shown" : ""}`}
      role="dialog"
      aria-label={t("session.info")}
    >
      <InfoRow icon={<DotIcon />} label={t("session.status")}>
        {statusWithDetail(session)}
      </InfoRow>
      <InfoRow icon={<BoxIcon />} label={t("environment.label")}>
        {session.environmentName === null
          ? t("environment.deleted")
          : environmentLabel(session.environmentName)}
      </InfoRow>
      {session.repos.length === 0 && (
        <InfoRow icon={<GitHubMark size={14} />} label={t("session.repo")}>
          {t("repo.noRepo")}
        </InfoRow>
      )}
      {session.repos.map((repo) => (
        <div key={repo.fullName} className="session-info-repo">
          <InfoRow icon={<GitHubMark size={14} />} label={t("session.repo")}>
            <a
              href={`https://github.com/${repo.fullName}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {repo.fullName}
            </a>
            {repo.access === "read" && <span className="chip-badge">{t("repo.readOnly")}</span>}
          </InfoRow>
          <InfoRow icon={<BranchIcon />} label={t("session.branch")}>
            <span className="mono">
              {repo.baseBranch} → {repo.branch}
            </span>
          </InfoRow>
          {repo.pullRequest && (
            <InfoRow
              icon={<PullRequestBadge pr={repo.pullRequest} size={14} />}
              label={t("session.changes")}
            >
              <a
                href={`https://github.com/${repo.fullName}/pull/${repo.pullRequest.number}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {pullRequestText(repo.pullRequest)}
              </a>
            </InfoRow>
          )}
        </div>
      ))}
    </div>
  );
}

function InfoRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="session-info-row">
      <span className="session-info-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="session-info-label">{label}</span>
      <span className="session-info-value">{children}</span>
    </div>
  );
}

/**
 * 标题菜单（照 Claude Code 手机版）：打开方式、重命名、复制链接、归档（已归档时是取消归档）、删除。
 * 显示方式（轨迹视图）、编辑环境要等对应的功能做好再加。
 */
/**
 * 会话的菜单（底部弹层），照 Claude：顶上是标题，下面是打开 PR、置顶、标为未读、打开方式、重命名、复制链接、归档，最后是删除。
 * 会话页的标题和侧栏里会话右边的"⋯"打开的是同一个。已归档的会话没有"置顶"（归档时自动取消置顶）。
 * "移到分组"（#153）列出已有的分组和"新分组"，在分组里时还有"移出分组"；键盘和读屏都能用它代替拖动。
 * Claude 还有分享：不做（2026-11-11 定的）。
 */
export function SessionMenu({
  id,
  session,
  open,
  onClose,
}: {
  id: string;
  session: Session;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const [page, setPage] = useState<MenuPage>("menu");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const archived = session.status === "archived";
  const { groups } = useShell();

  const close = () => {
    onClose();
  };
  // 关掉以后回到第一页，下次打开从菜单开始
  const reset = () => {
    setPage("menu");
    setError(undefined);
    setCopied(false);
  };

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      return true;
    } catch (e) {
      setError(errorText(e as ApiError));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const pinned = session.pinnedAt !== null;
  const toggleUnread = async () => {
    const ok = await run(() => api(`/api/sessions/${id}/read`, { unread: !session.unread }));
    if (ok) close();
  };
  const togglePin = async () => {
    const ok = await run(() => api(`/api/sessions/${id}/pin`, { pinned: !pinned }));
    if (ok) close();
  };

  /** 放进分组（最上面），或者移出分组回到"最近"。 */
  const moveTo = async (groupId: string | null) => {
    const ok = await run(() =>
      api(
        `/api/sessions/${id}/place`,
        groupId ? { section: "group", groupId, after: null } : { section: "recent", after: null },
      ),
    );
    if (ok) close();
  };
  const moveToNewGroup = async (name: string) => {
    const ok = await run(async () => {
      const group = await api<{ id: string }>("/api/session-groups", { name });
      await api(`/api/sessions/${id}/place`, { section: "group", groupId: group.id, after: null });
    });
    if (ok) close();
  };

  const toggleArchive = async () => {
    const ok = await run(() =>
      api(`/api/sessions/${id}/${archived ? "unarchive" : "archive"}`, {}),
    );
    if (ok) close();
  };

  const remove = async () => {
    const ok = await run(() => api(`/api/sessions/${id}/delete`, {}));
    if (!ok) return;
    close();
    // 删的是正在看的会话就回首页；在侧栏里删别的会话，留在原地
    if (location.pathname === `/s/${id}`) navigate("/");
  };
  const repo = session.repos[0];
  const pr = repo?.pullRequest;

  const copyLink = async () => {
    if (await copyText(`${location.origin}/s/${id}`)) {
      setCopied(true);
      setTimeout(close, 700);
    }
  };

  return (
    <Sheet open={open} label={t("session.menu")} onClose={close} onClosed={reset}>
      <Pages active={MENU_PAGES.indexOf(page)}>
        <div className="sheet-menu" role="menu">
          <p className="sheet-menu-title">{session.title}</p>
          {repo && pr && (
            <MenuLink
              href={`https://github.com/${repo.fullName}/pull/${pr.number}`}
              icon={<PullRequestBadge pr={pr} size={14} />}
            >
              {t("session.openPr")}
            </MenuLink>
          )}
          {!archived && (
            <MenuItem
              icon={<PinIcon filled={pinned} />}
              disabled={busy}
              onClick={() => void togglePin()}
            >
              {pinned ? t("session.unpin") : t("session.pin")}
            </MenuItem>
          )}
          {!archived && (
            <MenuItem icon={<ListIcon />} onClick={() => setPage("group")} more>
              {t("session.moveToGroup")}
            </MenuItem>
          )}
          <MenuItem icon={<DotIcon />} disabled={busy} onClick={() => void toggleUnread()}>
            {session.unread ? t("session.markRead") : t("session.markUnread")}
          </MenuItem>
          {/* 不使用仓库的会话（#191）没有会话分支和 PR，没有可打开的 */}
          {session.repos.length > 0 && (
            <MenuItem icon={<ExternalIcon />} onClick={() => setPage("open")} more>
              {t("session.openOn")}
            </MenuItem>
          )}
          <MenuItem icon={<PencilIcon />} onClick={() => setPage("rename")}>
            {t("common.rename")}
          </MenuItem>
          <MenuItem icon={<LinkIcon />} onClick={() => void copyLink()}>
            {copied ? t("session.linkCopied") : t("session.copyLink")}
          </MenuItem>
          <MenuItem icon={<ArchiveIcon />} disabled={busy} onClick={() => void toggleArchive()}>
            {archived ? t("session.unarchive") : t("session.archive")}
          </MenuItem>
          <div className="popover-divider" />
          <MenuItem icon={<TrashIcon />} danger onClick={() => setPage("delete")}>
            {t("common.delete")}
          </MenuItem>
          {error && page === "menu" && (
            <p className="alert sheet-alert" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="sheet-menu" role="menu">
          <SheetBack onClick={() => setPage("menu")}>{t("session.openOn")}</SheetBack>
          {session.repos.map((repo) => (
            <div key={repo.fullName}>
              {session.repos.length > 1 && <p className="sheet-menu-group">{repo.fullName}</p>}
              {/* 会话分支要等第一次推送以后才有；推送的结果在 #27 里接上，在那之前链接可能打不开 */}
              <MenuLink
                href={`https://github.com/${repo.fullName}/tree/${repo.branch}`}
                icon={<BranchIcon />}
                sub={repo.access === "read" ? t("session.readOnlyRepo") : undefined}
              >
                <span className="mono">{repo.branch}</span>
              </MenuLink>
              {repo.pullRequest && (
                <MenuLink
                  href={`https://github.com/${repo.fullName}/pull/${repo.pullRequest.number}`}
                  icon={<PullRequestBadge pr={repo.pullRequest} size={14} />}
                >
                  {pullRequestText(repo.pullRequest)}
                </MenuLink>
              )}
            </div>
          ))}
        </div>

        <RenameForm
          key={open ? "open" : "closed"}
          title={session.title}
          busy={busy}
          error={page === "rename" ? error : undefined}
          onBack={() => {
            setError(undefined);
            setPage("menu");
          }}
          onSubmit={async (title) => {
            const ok = await run(() => api(`/api/sessions/${id}/rename`, { title }));
            if (ok) close();
          }}
        />

        <div className="sheet-menu">
          <SheetBack onClick={() => setPage("menu")}>{t("session.delete")}</SheetBack>
          <p className="sheet-menu-text">{t("session.deleteHint")}</p>
          {error && page === "delete" && (
            <p className="alert sheet-alert" role="alert">
              {error}
            </p>
          )}
          <div className="sheet-actions">
            <button type="button" className="pill-button" onClick={() => setPage("menu")}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="pill-button danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              {t("session.deleteForever")}
            </button>
          </div>
        </div>

        <div className="sheet-menu" role="menu">
          <SheetBack onClick={() => setPage("menu")}>{t("session.moveToGroup")}</SheetBack>
          {groups.map((g) => (
            <MenuItem
              key={g.id}
              icon={g.id === session.groupId ? <CheckIcon /> : <ListIcon />}
              disabled={busy || g.id === session.groupId}
              onClick={() => void moveTo(g.id)}
            >
              {g.name}
            </MenuItem>
          ))}
          <MenuItem icon={<PlusIcon size={14} />} onClick={() => setPage("new-group")} more>
            {t("sidebar.newGroup")}
          </MenuItem>
          {session.groupId && (
            <>
              <div className="popover-divider" />
              <MenuItem icon={<DotIcon />} disabled={busy} onClick={() => void moveTo(null)}>
                {t("session.removeFromGroup")}
              </MenuItem>
            </>
          )}
          {error && page === "group" && (
            <p className="alert sheet-alert" role="alert">
              {error}
            </p>
          )}
        </div>

        <NewGroupForm
          key={open ? "open-group" : "closed-group"}
          busy={busy}
          error={page === "new-group" ? error : undefined}
          onBack={() => {
            setError(undefined);
            setPage("group");
          }}
          onSubmit={moveToNewGroup}
        />
      </Pages>
    </Sheet>
  );
}

/** 新建一个分组并把会话放进去。名字默认是"新分组"，打开时全选，直接输入就是改名。 */
function NewGroupForm({
  busy,
  error,
  onBack,
  onSubmit,
}: {
  busy: boolean;
  error?: string;
  onBack: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const t = useT();
  const [value, setValue] = useState(() => t("sidebar.newGroup"));
  const trimmed = value.trim();
  return (
    <form
      className="sheet-menu"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed) void onSubmit(trimmed);
      }}
    >
      <SheetBack onClick={onBack}>{t("sidebar.newGroup")}</SheetBack>
      <label className="field sheet-field">
        <span className="visually-hidden">{t("group.name")}</span>
        <input
          value={value}
          maxLength={MAX_GROUP_NAME}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      {error && (
        <p className="alert sheet-alert" role="alert">
          {error}
        </p>
      )}
      <div className="sheet-actions">
        <button type="button" className="pill-button" onClick={onBack}>
          {t("common.cancel")}
        </button>
        <button type="submit" className="pill-button accent" disabled={busy || !trimmed}>
          {t("session.createAndMove")}
        </button>
      </div>
    </form>
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  danger = false,
  disabled = false,
  more = false,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** 点了进下一页：右边带 ›。 */
  more?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`sheet-item${danger ? " danger" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="sheet-item-icon">{icon}</span>
      <span className="sheet-item-text">{children}</span>
      {more && (
        <span className="sheet-item-end">
          <ChevronRightIcon />
        </span>
      )}
    </button>
  );
}

function MenuLink({
  href,
  icon,
  sub,
  children,
}: {
  href: string;
  icon: ReactNode;
  sub?: string;
  children: ReactNode;
}) {
  return (
    <a role="menuitem" className="sheet-item" href={href} target="_blank" rel="noopener noreferrer">
      <span className="sheet-item-icon">{icon}</span>
      <span className="sheet-item-text">
        {children}
        {sub && <span className="sheet-item-sub">{sub}</span>}
      </span>
      <span className="sheet-item-end">
        <ExternalIcon />
      </span>
    </a>
  );
}

export function SheetBack({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  const t = useT();
  return (
    <div className="sheet-back">
      <button
        type="button"
        className="icon-button small"
        aria-label={t("common.back")}
        onClick={onClick}
      >
        <span className="flip">
          <ChevronRightIcon />
        </span>
      </button>
      <span>{children}</span>
    </div>
  );
}

export function RenameForm({
  title,
  busy,
  error,
  onBack,
  onSubmit,
  label,
  maxLength = 100,
}: {
  title: string;
  busy: boolean;
  error?: string;
  onBack: () => void;
  onSubmit: (title: string) => Promise<void>;
  /** 读屏念的输入框名字，默认"会话标题"。 */
  label?: string;
  maxLength?: number;
}) {
  const t = useT();
  const [value, setValue] = useState(title);
  const trimmed = value.trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (trimmed && trimmed !== title) void onSubmit(trimmed);
  };
  return (
    <form className="sheet-menu" onSubmit={submit}>
      <SheetBack onClick={onBack}>{t("common.rename")}</SheetBack>
      <label className="field sheet-field">
        <span className="visually-hidden">{label ?? t("session.titleLabel")}</span>
        <input value={value} maxLength={maxLength} onChange={(e) => setValue(e.target.value)} />
      </label>
      {error && (
        <p className="alert sheet-alert" role="alert">
          {error}
        </p>
      )}
      <div className="sheet-actions">
        <button type="button" className="pill-button" onClick={onBack}>
          {t("common.cancel")}
        </button>
        <button
          type="submit"
          className="pill-button accent"
          disabled={busy || !trimmed || trimmed === title}
        >
          {t("common.save")}
        </button>
      </div>
    </form>
  );
}
