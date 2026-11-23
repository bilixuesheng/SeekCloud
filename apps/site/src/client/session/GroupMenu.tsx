import { MAX_GROUP_NAME, type SessionGroup } from "@seekcloud/protocol";
import { useState } from "react";
import { type ApiError, api } from "../api";
import { PencilIcon, TrashIcon } from "../Icons";
import { useT } from "../i18n";
import { errorText } from "../i18n/errors";
import { Pages, Sheet } from "../Motion";
import { MenuItem, RenameForm, SheetBack } from "./SessionHeader";

type GroupPage = "menu" | "rename" | "delete";
const GROUP_PAGES: GroupPage[] = ["menu", "rename", "delete"];

/** 改分组名。 */
export async function renameGroup(id: string, name: string): Promise<void> {
  await api(`/api/session-groups/${id}`, { name }, "PATCH");
}

/**
 * 侧栏里分组标题右边的"⋯"（#153）：重命名、删除分组。删除时里面的会话回到"最近"。
 * 分组的变化经会话列表的事件流推回来，这里不改本地的列表。
 */
export function GroupMenu({
  group,
  open,
  onClose,
}: {
  group: SessionGroup;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const [page, setPage] = useState<GroupPage>("menu");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      onClose();
    } catch (e) {
      setError(errorText(e as ApiError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      label={t("group.menu")}
      onClose={onClose}
      onClosed={() => {
        setPage("menu");
        setError(undefined);
      }}
    >
      <Pages active={GROUP_PAGES.indexOf(page)}>
        <div className="sheet-menu" role="menu">
          <p className="sheet-menu-title">{group.name}</p>
          <MenuItem icon={<PencilIcon />} onClick={() => setPage("rename")}>
            {t("common.rename")}
          </MenuItem>
          <div className="popover-divider" />
          <MenuItem icon={<TrashIcon />} danger onClick={() => setPage("delete")}>
            {t("group.delete")}
          </MenuItem>
          {error && page === "menu" && (
            <p className="alert sheet-alert" role="alert">
              {error}
            </p>
          )}
        </div>

        <RenameForm
          key={open ? "open" : "closed"}
          title={group.name}
          label={t("group.name")}
          maxLength={MAX_GROUP_NAME}
          busy={busy}
          error={page === "rename" ? error : undefined}
          onBack={() => {
            setError(undefined);
            setPage("menu");
          }}
          onSubmit={(name) => run(() => renameGroup(group.id, name))}
        />

        <div className="sheet-menu">
          <SheetBack onClick={() => setPage("menu")}>{t("group.delete")}</SheetBack>
          <p className="sheet-menu-text">{t("group.deleteHint")}</p>
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
              onClick={() => void run(() => api(`/api/session-groups/${group.id}`, {}, "DELETE"))}
            >
              {t("common.delete")}
            </button>
          </div>
        </div>
      </Pages>
    </Sheet>
  );
}
