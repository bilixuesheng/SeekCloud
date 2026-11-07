import type { PullRequestRef } from "@seekcloud/protocol";
import { createContext, memo, useContext, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { IssueIcon, PullRequestIcon } from "../Icons";
import { type LiveChunk, rehypeLiveChunks, useLiveChunks } from "./live-text";
import { PullRequestBadge } from "./PullRequestBadge";

// Agent 的输出只渲染这些元素。原始 HTML 当成普通文字显示。
const ALLOWED = [
  "p",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "em",
  "del",
  "a",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "input", // 任务列表的勾选框
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "img",
  "span", // 正在浮现的字（live-text.ts）。Markdown 语法本身不会产生 span，原始 HTML 已经当成文字了
];

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

/** 把 Markdown 里的原始 HTML 变成普通文字：不渲染，但也不吞掉（比如正文里写的 <Button>）。 */
function htmlAsText() {
  const walk = (node: MdNode) => {
    if (node.type === "html") node.type = "text";
    node.children?.forEach(walk);
  };
  return walk;
}

const isWebUrl = (url: string) => /^https?:\/\//i.test(url);

/**
 * Agent 发的图片直接加载（2026-11-01 用户要求，原来是点了才加载）。不带 Referer。
 * 加载失败时显示成链接，让用户知道这里本来有张图、从哪来。
 */
function AgentImage({ src, alt }: { src?: unknown; alt?: string }) {
  const [failed, setFailed] = useState(false);
  if (typeof src !== "string" || !isWebUrl(src)) return <span>{alt}</span>;
  if (failed) {
    return (
      <a className="image-failed" href={src} target="_blank" rel="noopener noreferrer nofollow">
        <span aria-hidden="true">🖼</span> {alt || "图片"}（加载失败，点击查看）
      </a>
    );
  }
  return (
    <img
      src={src}
      alt={alt ?? ""}
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

export interface GitHubRef {
  repo: string;
  kind: "pull" | "issue";
  number: number;
}

/** GitHub 上 PR 或 issue 的地址，比如 https://github.com/octo/app/pull/42。 */
export function githubRef(href: string): GitHubRef | undefined {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/(\d+)(?:[/?#].*)?$/i.exec(
    href,
  );
  if (!m) return undefined;
  return { repo: m[1] as string, kind: m[2] === "pull" ? "pull" : "issue", number: Number(m[3]) };
}

/** 会话的主仓库和它的 PR：回复里的链接指的是它们时，胶囊上显示真实状态。 */
export const SessionLinks = createContext<{ repo?: string; pullRequest?: PullRequestRef }>({});

/** 节点里的全部文字（正在浮现的字被拆成了一个个 span，也照样拼回来）。 */
const textOf = (node: MdNode | undefined): string =>
  node?.type === "text" ? (node.value ?? "") : (node?.children ?? []).map(textOf).join("");

/** 链接文字就是地址本身，或者只是"#42"这类编号：这样的链接显示成胶囊不会丢掉信息。 */
const plainLabel = (text: string, href: string, ref: GitHubRef) =>
  text === href || new RegExp(`^(?:[\\w.-]+/[\\w.-]+)?#${ref.number}$`).test(text.trim());

/**
 * PR 和 issue 的链接显示成小胶囊，不显示网址：状态图标加编号，点了打开 GitHub。
 * 状态只知道会话自己的 PR 的；别的 PR 和 issue 用不带颜色的图标，不猜它开着还是关了。
 */
function GitHubChip({ href, target }: { href: string; target: GitHubRef }) {
  const session = useContext(SessionLinks);
  const sameRepo = session.repo?.toLowerCase() === target.repo.toLowerCase();
  const pr = target.kind === "pull" && sameRepo && session.pullRequest?.number === target.number;
  const label = `${sameRepo ? "" : target.repo}#${target.number}`;
  return (
    <a className="link-chip" href={href} target="_blank" rel="noopener noreferrer nofollow">
      {pr && session.pullRequest ? (
        <PullRequestBadge pr={session.pullRequest} size={13} />
      ) : (
        <span className="pr-badge">
          {target.kind === "pull" ? <PullRequestIcon size={13} /> : <IssueIcon size={13} />}
        </span>
      )}
      {label}
    </a>
  );
}

const components: Components = {
  a: ({ href, children, node }) => {
    if (!href || !/^(https?:|mailto:)/i.test(href)) return <span>{children}</span>;
    const ref = githubRef(href);
    if (ref && plainLabel(textOf(node as MdNode | undefined), href, ref))
      return <GitHubChip href={href} target={ref} />;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    );
  },
  img: ({ src, alt }) => <AgentImage src={src} alt={alt} />,
};

/**
 * 解析 Markdown 不便宜：新事件到来、整条时间线重新渲染时，内容没变的消息直接用上次的结果。
 * chunks：正在浮现的几段新文字（见 live-text.ts）。
 */
export const Markdown = memo(function Markdown({
  text,
  chunks = NO_CHUNKS,
}: {
  text: string;
  chunks?: LiveChunk[];
}) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, htmlAsText]}
        rehypePlugins={[[rehypeLiveChunks, { source: text, chunks }]]}
        allowedElements={ALLOWED}
        unwrapDisallowed
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

const NO_CHUNKS: LiveChunk[] = [];

/** Agent 的回复：live 为真（打开会话以后才收到的）时，新来的字浮现出来。 */
export function LiveMarkdown({ text, live }: { text: string; live: boolean }) {
  return <Markdown text={text} chunks={useLiveChunks(text, live)} />;
}
