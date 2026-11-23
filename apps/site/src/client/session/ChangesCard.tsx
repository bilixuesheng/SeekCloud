import type { FileChange } from "@seekcloud/protocol";
import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, UndoIcon } from "../Icons";
import { useT } from "../i18n";
import type { TurnChanges } from "./timeline";

/** 卡片上先列几个文件（照 Claude）。 */
const SHOWN = 3;

/**
 * 改动卡片（#27，照 Claude）：只在回合结束时出现在最后，复制和时间那一行上面；这一回合没改文件就没有。
 * 改了几个文件时列出前三个和增删行数，最后一行"查看全部 N 个文件"写合计；只改了一个文件时一行，带"撤销"
 * （撤销这个文件这一回合的改动，作为下一回合的消息交给 Agent 做）。
 */
export function ChangesCard({
  changes,
  onUndo,
  onOpen,
}: {
  changes: TurnChanges;
  /** 撤销一个文件：发一条消息给 Agent。Agent 在工作时为空（按钮是灰的）。 */
  onUndo?: (text: string) => void;
  /** 打开改动面板（对比基础分支的 diff），path 是要先展开的文件。不给时"查看全部"在卡片里展开。 */
  onOpen?: (path?: string) => void;
}) {
  const t = useT();
  const [all, setAll] = useState(false);
  const several = changes.repos.length > 1;
  const rows = changes.repos.flatMap((repo) =>
    repo.files.map((file) => ({ repo: repo.fullName, file })),
  );
  const total = rows.length + changes.repos.reduce((n, r) => n + r.omittedFiles, 0);
  const sum = (key: "additions" | "deletions") => rows.reduce((n, r) => n + r.file[key], 0);
  const shown = all ? rows : rows.slice(0, SHOWN);
  const single = total === 1 ? rows[0] : undefined;
  const notes = changes.repos.flatMap((repo) =>
    repo.push === "read_only"
      ? [{ tone: "info", text: t("changes.readOnly", { repo: repo.fullName }) }]
      : repo.push === "failed"
        ? [{ tone: "error", text: t("changes.pushFailed", { repo: repo.fullName }) }]
        : [],
  );

  return (
    <section className="changes-card" aria-label={t("changes.label")}>
      <ul className="changes-files">
        {shown.map(({ repo, file }) => (
          <li key={`${repo}:${file.path}`} className="changes-file">
            {onOpen ? (
              <button
                type="button"
                className="changes-path link"
                title={file.from ? `${file.from} → ${file.path}` : file.path}
                onClick={() => onOpen(file.path)}
              >
                {several && <span className="changes-repo">{repo.split("/")[1]}/</span>}
                {file.path}
              </button>
            ) : (
              <span
                className="changes-path"
                title={file.from ? `${file.from} → ${file.path}` : file.path}
              >
                {several && <span className="changes-repo">{repo.split("/")[1]}/</span>}
                {file.path}
              </span>
            )}
            <LineCounts file={file} />
            {single && (
              <button
                type="button"
                className="changes-undo"
                disabled={!onUndo}
                data-tip={onUndo ? t("changes.undoHint") : t("changes.cannotUndo")}
                onClick={() => onUndo?.(t("changes.undoPrompt", { path: single.file.path }))}
              >
                <UndoIcon />
                {t("changes.undo")}
              </button>
            )}
          </li>
        ))}
      </ul>
      {total > SHOWN && (
        <button
          type="button"
          className="changes-all"
          aria-expanded={onOpen ? undefined : all}
          onClick={() => (onOpen ? onOpen() : setAll((open) => !open))}
        >
          <span>{all ? t("changes.collapse") : t("changes.viewAll", { count: total })}</span>
          <span className="changes-counts">
            <span className="added">+{sum("additions")}</span>
            <span className="deleted">−{sum("deletions")}</span>
          </span>
          <span className={`changes-chevron${all ? " open" : ""}`}>
            {onOpen ? <ChevronRightIcon /> : <ChevronDownIcon />}
          </span>
        </button>
      )}
      {all && changes.repos.some((r) => r.omittedFiles > 0) && (
        <p className="changes-note info">
          {t("changes.omitted", {
            count: changes.repos.reduce((n, r) => n + r.omittedFiles, 0),
          })}
        </p>
      )}
      {notes.map((note) => (
        <p key={note.text} className={`changes-note ${note.tone}`}>
          {note.text}
        </p>
      ))}
    </section>
  );
}

function LineCounts({ file }: { file: FileChange }) {
  const t = useT();
  if (file.binary) return <span className="changes-counts muted">{t("changes.binary")}</span>;
  return (
    <span className="changes-counts">
      <span className="added">+{file.additions}</span>
      <span className="deleted">−{file.deletions}</span>
    </span>
  );
}
