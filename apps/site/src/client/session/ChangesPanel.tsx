import type { RepoDiff } from "@seekcloud/protocol";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type ApiError, api } from "../api";
import { ChevronRightIcon, CloseIcon } from "../Icons";
import { usePresence } from "../Motion";

const PANEL_MS = 280;

export interface PatchLine {
  kind: "hunk" | "add" | "del" | "ctx" | "note";
  text: string;
  /** 旧文件、新文件里的行号（新增的行没有旧行号，删掉的行没有新行号）。 */
  old?: number;
  new?: number;
}

/** git diff 的一个文件：去掉开头的 diff --git、index、---、+++ 这些，按 @@ 记下行号。 */
export function patchLines(patch: string): PatchLine[] {
  const lines: PatchLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      lines.push({ kind: "hunk", text: raw });
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("+")) lines.push({ kind: "add", text: raw.slice(1), new: newNo++ });
    else if (raw.startsWith("-")) lines.push({ kind: "del", text: raw.slice(1), old: oldNo++ });
    else if (raw.startsWith(" ")) {
      lines.push({ kind: "ctx", text: raw.slice(1), old: oldNo++, new: newNo++ });
    } else if (raw.startsWith("\\")) lines.push({ kind: "note", text: "文件末尾没有换行" });
  }
  return lines;
}

/**
 * 改动面板（#27）：会话分支对比基础分支的改动。宽屏从右边滑出，手机上占满屏幕。
 * 打开时从主站取最新的一份（每个回合结束时宿主机算的）；focus 是要先展开的文件。
 */
export function ChangesPanel({
  sessionId,
  open,
  focus,
  onClose,
}: {
  sessionId: string;
  open: boolean;
  focus?: string;
  onClose: () => void;
}) {
  const { mounted, shown } = usePresence(open, PANEL_MS);
  const [state, setState] = useState<{ repos?: RepoDiff[]; error?: string }>({});

  useEffect(() => {
    if (!open) return;
    let live = true;
    setState({});
    api<{ repos: RepoDiff[] }>(`/api/sessions/${sessionId}/diff`).then(
      (res) => live && setState({ repos: res.repos }),
      (error: ApiError) => live && setState({ error: error.message }),
    );
    return () => {
      live = false;
    };
  }, [open, sessionId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted) return null;
  const visible = shown && open;
  const files = state.repos?.flatMap((r) => r.files) ?? [];
  const sum = (key: "additions" | "deletions") => files.reduce((n, f) => n + f[key], 0);

  return createPortal(
    <>
      <div
        className={`panel-scrim${visible ? " shown" : ""}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={`changes-panel${visible ? " shown" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="改动"
      >
        <header className="changes-panel-head">
          <h2>改动</h2>
          {state.repos && files.length > 0 && (
            <span className="changes-counts">
              <span>{files.length} 个文件</span>
              <span className="added">+{sum("additions")}</span>
              <span className="deleted">−{sum("deletions")}</span>
            </span>
          )}
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="changes-panel-body">
          {state.error && <p className="changes-panel-empty error">{state.error}</p>}
          {!state.error && !state.repos && (
            <p className="changes-panel-empty" role="status">
              正在加载……
            </p>
          )}
          {state.repos && files.length === 0 && (
            <p className="changes-panel-empty">会话分支和基础分支相比还没有改动。</p>
          )}
          {state.repos?.map((repo) =>
            repo.files.length === 0 ? null : (
              <section key={repo.fullName} className="changes-repo-section">
                <p className="changes-repo-title">
                  {repo.fullName}
                  <span>对比 {repo.baseBranch}</span>
                </p>
                {repo.files.map((file) => (
                  <FileDiff
                    key={file.path}
                    file={file}
                    initiallyOpen={file.path === focus || repo.files.length <= 10}
                    scrollTo={file.path === focus}
                  />
                ))}
                {repo.truncated && (
                  <p className="changes-note info">
                    改动太多，后面的文件没有带上内容，可以在 GitHub 上对比分支查看。
                  </p>
                )}
              </section>
            ),
          )}
        </div>
      </aside>
    </>,
    document.body,
  );
}

function FileDiff({
  file,
  initiallyOpen,
  scrollTo,
}: {
  file: RepoDiff["files"][number];
  initiallyOpen: boolean;
  scrollTo: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollTo) root.current?.scrollIntoView({ block: "start" });
  }, [scrollTo]);
  const lines = file.patch ? patchLines(file.patch) : [];
  return (
    <div ref={root} className="file-diff">
      <button
        type="button"
        className="file-diff-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`changes-chevron right${open ? " open" : ""}`}>
          <ChevronRightIcon />
        </span>
        <span
          className="changes-path"
          title={file.from ? `${file.from} → ${file.path}` : file.path}
        >
          {file.path}
        </span>
        {file.binary ? (
          <span className="changes-counts muted">二进制</span>
        ) : (
          <span className="changes-counts">
            <span className="added">+{file.additions}</span>
            <span className="deleted">−{file.deletions}</span>
          </span>
        )}
      </button>
      {open && (
        <div className="file-diff-body">
          {file.from && <p className="file-diff-note">改名自 {file.from}</p>}
          {file.binary ? (
            <p className="file-diff-note">二进制文件，不显示内容。</p>
          ) : file.tooLarge ? (
            <p className="file-diff-note">改动太大，不显示内容。</p>
          ) : !file.patch ? (
            <p className="file-diff-note">没有带上内容。</p>
          ) : lines.length === 0 ? (
            <p className="file-diff-note">只改了文件的权限或名字，内容没变。</p>
          ) : (
            <table className="diff-lines">
              <tbody>
                {lines.map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 行的顺序固定
                  <tr key={i} className={`diff-${line.kind}`}>
                    <td className="diff-no">{line.old ?? ""}</td>
                    <td className="diff-no">{line.new ?? ""}</td>
                    <td className="diff-text">
                      {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                      {line.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
