import { MAX_GROUP_NAME, type SessionGroup } from "@seekcloud/protocol";
import { useState } from "react";
import { type ApiError, api } from "../api";
import { PencilIcon, TrashIcon } from "../Icons";
import { Pages, Sheet } from "../Motion";
import { MenuItem, RenameForm, SheetBack } from "./SessionHeader";

type GroupPage = "menu" | "rename" | "delete";
const GROUP_PAGES: GroupPage[] = ["menu", "rename", "delete"];

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** 改分组名、删除分组。接口没有 PATCH 的封装（client/api.ts 只有 POST、PUT、DELETE），这里自己发。 */
export async function renameGroup(id: string, name: string): Promise<void> {
  const res = await fetch(`/api/session-groups/${id}`, jsonInit("PATCH", { name }));
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as { error?: ApiError } | undefined;
    throw body?.error ?? { code: "network", message: "网络异常，请稍后重试" };
  }
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
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      label="分组菜单"
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
            重命名
          </MenuItem>
          <div className="popover-divider" />
          <MenuItem icon={<TrashIcon />} danger onClick={() => setPage("delete")}>
            删除分组
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
          label="分组名"
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
          <SheetBack onClick={() => setPage("menu")}>删除分组</SheetBack>
          <p className="sheet-menu-text">分组中的会话将回到“最近”，会话本身不受影响。</p>
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
              onClick={() => void run(() => api(`/api/session-groups/${group.id}`, {}, "DELETE"))}
            >
              删除
            </button>
          </div>
        </div>
      </Pages>
    </Sheet>
  );
}
