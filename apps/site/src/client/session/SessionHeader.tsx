import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { type ApiError, api } from "../api";
import { copyText } from "../copy";
import { GitHubMark } from "../GitHubMark";
import {
  ArchiveIcon,
  BoxIcon,
  BranchIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalIcon,
  LinkIcon,
  ListIcon,
  MenuIcon,
  PencilIcon,
  TrashIcon,
} from "../Icons";
import { Pages, Sheet, usePresence } from "../Motion";
import { navigate } from "../router";
import { PullRequestBadge, pullRequestText } from "./PullRequestBadge";
import type { Session } from "./types";

/** 标题菜单里的几页：菜单本身、打开方式、重命名、确认删除。 */
type MenuPage = "menu" | "open" | "rename" | "delete";
const MENU_PAGES: MenuPage[] = ["menu", "open", "rename", "delete"];

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
  const [menuOpen, setMenuOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);

  return (
    <header className="session-header">
      <button
        type="button"
        className="icon-button session-header-menu"
        aria-label="会话列表"
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
          aria-label="会话信息"
          aria-expanded={infoOpen}
          data-tip="会话信息"
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
        <TitleMenu id={id} session={session} open={menuOpen} onClose={() => setMenuOpen(false)} />
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
      aria-label="会话信息"
    >
      <InfoRow icon={<BoxIcon />} label="环境">
        {session.environmentName ?? "已删除"}
      </InfoRow>
      {session.repos.map((repo) => (
        <div key={repo.fullName} className="session-info-repo">
          <InfoRow icon={<GitHubMark size={14} />} label="仓库">
            <a
              href={`https://github.com/${repo.fullName}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {repo.fullName}
            </a>
            {repo.access === "read" && <span className="chip-badge">只读</span>}
          </InfoRow>
          <InfoRow icon={<BranchIcon />} label="分支">
            <span className="mono">
              {repo.baseBranch} → {repo.branch}
            </span>
          </InfoRow>
          {repo.pullRequest && (
            <InfoRow icon={<PullRequestBadge pr={repo.pullRequest} size={14} />} label="改动">
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
function TitleMenu({
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
  const [page, setPage] = useState<MenuPage>("menu");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const archived = session.status === "archived";

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
      setError((e as ApiError).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggleArchive = async () => {
    const ok = await run(() =>
      api(`/api/sessions/${id}/${archived ? "unarchive" : "archive"}`, {}),
    );
    if (ok) close();
  };

  const remove = async () => {
    const ok = await run(() => api(`/api/sessions/${id}/delete`, {}));
    if (ok) {
      close();
      navigate("/");
    }
  };

  const copyLink = async () => {
    if (await copyText(`${location.origin}/s/${id}`)) {
      setCopied(true);
      setTimeout(close, 700);
    }
  };

  return (
    <Sheet open={open} label="会话菜单" onClose={close} onClosed={reset}>
      <Pages active={MENU_PAGES.indexOf(page)}>
        <div className="sheet-menu" role="menu">
          <p className="sheet-menu-title">{session.title}</p>
          <MenuItem icon={<ExternalIcon />} onClick={() => setPage("open")} more>
            打开方式
          </MenuItem>
          <MenuItem icon={<PencilIcon />} onClick={() => setPage("rename")}>
            重命名
          </MenuItem>
          <MenuItem icon={<LinkIcon />} onClick={() => void copyLink()}>
            {copied ? "已复制链接" : "复制链接"}
          </MenuItem>
          <MenuItem icon={<ArchiveIcon />} disabled={busy} onClick={() => void toggleArchive()}>
            {archived ? "取消归档" : "归档"}
          </MenuItem>
          <div className="popover-divider" />
          <MenuItem icon={<TrashIcon />} danger onClick={() => setPage("delete")}>
            删除
          </MenuItem>
          {error && page === "menu" && (
            <p className="alert sheet-alert" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="sheet-menu" role="menu">
          <SheetBack onClick={() => setPage("menu")}>打开方式</SheetBack>
          {session.repos.map((repo) => (
            <div key={repo.fullName}>
              {session.repos.length > 1 && <p className="sheet-menu-group">{repo.fullName}</p>}
              {/* 会话分支要等第一次推送以后才有；推送的结果在 #27 里接上，在那之前链接可能打不开 */}
              <MenuLink
                href={`https://github.com/${repo.fullName}/tree/${repo.branch}`}
                icon={<BranchIcon />}
                sub={repo.access === "read" ? "只读仓库，改动不会推送" : undefined}
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
          <SheetBack onClick={() => setPage("menu")}>删除会话</SheetBack>
          <p className="sheet-menu-text">
            对话记录将被永久删除，无法恢复。GitHub 上的分支和 PR 不受影响。
          </p>
          {error && page === "delete" && (
            <p className="alert sheet-alert" role="alert">
              {error}
            </p>
          )}
          <div className="sheet-actions">
            <button type="button" className="pill-button" onClick={() => setPage("menu")}>
              取消
            </button>
            <button
              type="button"
              className="pill-button danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              永久删除
            </button>
          </div>
        </div>
      </Pages>
    </Sheet>
  );
}

function MenuItem({
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

function SheetBack({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <div className="sheet-back">
      <button type="button" className="icon-button small" aria-label="返回" onClick={onClick}>
        <span className="flip">
          <ChevronRightIcon />
        </span>
      </button>
      <span>{children}</span>
    </div>
  );
}

function RenameForm({
  title,
  busy,
  error,
  onBack,
  onSubmit,
}: {
  title: string;
  busy: boolean;
  error?: string;
  onBack: () => void;
  onSubmit: (title: string) => Promise<void>;
}) {
  const [value, setValue] = useState(title);
  const trimmed = value.trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (trimmed && trimmed !== title) void onSubmit(trimmed);
  };
  return (
    <form className="sheet-menu" onSubmit={submit}>
      <SheetBack onClick={onBack}>重命名</SheetBack>
      <label className="field sheet-field">
        <span className="visually-hidden">会话标题</span>
        <input value={value} maxLength={100} onChange={(e) => setValue(e.target.value)} />
      </label>
      {error && (
        <p className="alert sheet-alert" role="alert">
          {error}
        </p>
      )}
      <div className="sheet-actions">
        <button type="button" className="pill-button" onClick={onBack}>
          取消
        </button>
        <button
          type="submit"
          className="pill-button accent"
          disabled={busy || !trimmed || trimmed === title}
        >
          保存
        </button>
      </div>
    </form>
  );
}
