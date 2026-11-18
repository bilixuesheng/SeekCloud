import { fromHtml } from "hast-util-from-html";
import { toMdast } from "hast-util-to-mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";

/**
 * 抓来的网页转成 Markdown 给 Agent 看（#26 的网页抓取）。
 *
 * HTML 解析器（parse5）碰到很深的嵌套、或者大量没闭合又带着不同属性的格式标签（<b id=1><b id=2>…）时，
 * 花的时间是平方级的，转换又在主站的主线程上跑，一个恶意网页就能把主站卡住几秒。所以先用一遍线性的扫描
 * 估一下嵌套有多深（往多了估），超过上限就不解析，改用线性的纯文本提取。
 */

/** 估出来的嵌套深度超过这个就不解析。正常网页几十层。 */
export const MAX_HTML_DEPTH = 512;
/** 超过这么长的 HTML 只转前面这一段。 */
export const MAX_HTML_CHARS = 2_000_000;

/** 不用写结束标签的元素：不往栈里放。 */
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
/** 里面的内容按文本解析、直到对应的结束标签的元素（不在 svg、math 里的时候）。 */
const RAW_TEXT = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
]);
/** 结束标签可以省的元素：再开一个同名的，就当前一个结束了。 */
const OPTIONAL_END = new Set([
  "p",
  "li",
  "dt",
  "dd",
  "tr",
  "td",
  "th",
  "option",
  "optgroup",
  "rb",
  "rt",
  "rp",
  "thead",
  "tbody",
  "tfoot",
  "colgroup",
]);
/** 格式标签：没写结束标签时，HTML 解析器会在后面的段落里一次次重新打开它们（"活动格式元素"）。 */
const FORMATTING = new Set([
  "a",
  "b",
  "big",
  "code",
  "em",
  "font",
  "i",
  "nobr",
  "s",
  "small",
  "strike",
  "strong",
  "tt",
  "u",
]);

const TAG_NAME = /^\/?([a-z][a-z0-9-]*)/;

/**
 * 线性地估一下 HTML 解析出来会有多深：打开的元素栈加上还没关掉的格式标签。往多了估，超过 stop 就提前返回。
 * 每个标签只做常数次（最多看栈顶几项）的工作，整个是线性的。
 */
export function estimateDepth(html: string, stop = MAX_HTML_DEPTH): number {
  const s = html.toLowerCase();
  const stack: string[] = [];
  const formatting: string[] = [];
  let max = 0;
  let i = 0;
  const popTo = (name: string, within: number) => {
    for (let k = stack.length - 1; k >= Math.max(0, stack.length - within); k--) {
      if (stack[k] === name) {
        stack.length = k;
        return true;
      }
    }
    return false;
  };
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt === -1) break;
    if (s.startsWith("<!--", lt)) {
      const end = s.indexOf("-->", lt + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    const next = s.charCodeAt(lt + 1);
    const isLetter = next >= 97 && next <= 122;
    // "<" 后面不是字母、"/"、"!"、"?"：是文本里的小于号，不是标签。
    if (!isLetter && next !== 47 && next !== 33 && next !== 63) {
      i = lt + 1;
      continue;
    }
    const gt = s.indexOf(">", lt + 1);
    if (gt === -1) break;
    const inner = s.slice(lt + 1, gt);
    i = gt + 1;
    const name = TAG_NAME.exec(inner)?.[1];
    if (!name) continue;
    if (inner.startsWith("/")) {
      popTo(name, 8);
      if (FORMATTING.has(name)) {
        const k = formatting.lastIndexOf(name);
        if (k !== -1) formatting.splice(k, 1);
      }
      continue;
    }
    if (VOID.has(name) || inner.endsWith("/")) continue;
    if (RAW_TEXT.has(name) && !stack.includes("svg") && !stack.includes("math")) {
      const end = s.indexOf(`</${name}`, i);
      if (end === -1) break;
      i = end;
      continue;
    }
    if (OPTIONAL_END.has(name)) popTo(name, 4);
    stack.push(name);
    if (FORMATTING.has(name)) formatting.push(name);
    max = Math.max(max, stack.length + formatting.length);
    if (max > stop) return max;
  }
  return max;
}

/** 整块不要的元素：脚本、样式、嵌入的东西。 */
const DROPPED = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "canvas",
]);

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** 页面上看不见的：上面那些元素、注释、hidden、aria-hidden、隐藏的输入框、display:none 和 visibility:hidden。 */
function invisible(node: HastNode): boolean {
  if (node.type === "comment") return true;
  if (node.type !== "element") return false;
  if (DROPPED.has(node.tagName ?? "")) return true;
  const p = node.properties ?? {};
  if (p.hidden !== undefined && p.hidden !== null && p.hidden !== false) return true;
  if (String(p.ariaHidden ?? "").toLowerCase() === "true") return true;
  if (node.tagName === "input" && String(p.type ?? "").toLowerCase() === "hidden") return true;
  const style = String(p.style ?? "")
    .toLowerCase()
    .replace(/\s+/g, "");
  return /(^|;)display:none/.test(style) || /(^|;)visibility:(hidden|collapse)/.test(style);
}

/**
 * 去掉看不见的节点；链接和图片的地址换成绝对地址（Agent 下一步可能直接去抓它），
 * javascript: 和 data: 的地址去掉（data: 的图片能有几 MB）。
 */
function cleanTree(node: HastNode, base: URL | undefined): void {
  if (!node.children) return;
  node.children = node.children.filter((child) => !invisible(child));
  for (const child of node.children) {
    if (child.type === "element" && child.properties) {
      for (const key of ["href", "src"]) {
        const value = child.properties[key];
        if (typeof value !== "string") continue;
        const trimmed = value.trim();
        if (/^(javascript|data|vbscript):/i.test(trimmed)) {
          delete child.properties[key];
          continue;
        }
        if (!base) continue;
        try {
          child.properties[key] = new URL(trimmed, base).href;
        } catch {
          // 看不懂的地址留原样
        }
      }
    }
    cleanTree(child, base);
  }
}

/** HTML 实体：数字的，加上常见的几个有名字的。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  middot: "·",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return valid ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** 纯文本提取时换行的元素。 */
const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tr",
  "ul",
]);
/** 纯文本提取时整段跳过的元素。 */
const SKIPPED = new Set([...DROPPED, "head", "title", "textarea"]);

/** 多余的空白：每行的连续空白并成一个，连续的空行并成一个。 */
function tidy(text: string): string {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/[ \t\f\v\r ]+/g, " ").trim();
    if (line === "" && (out.length === 0 || out.at(-1) === "")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

/** 线性地把 HTML 变成纯文本：去掉标签、脚本和样式，块级元素换行，列表项前面加"- "。 */
export function htmlToText(html: string): string {
  const lower = html.toLowerCase();
  const parts: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = lower.indexOf("<", i);
    if (lt === -1) {
      parts.push(html.slice(i));
      break;
    }
    parts.push(html.slice(i, lt));
    if (lower.startsWith("<!--", lt)) {
      const end = lower.indexOf("-->", lt + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    const next = lower.charCodeAt(lt + 1);
    if (!(next >= 97 && next <= 122) && next !== 47 && next !== 33 && next !== 63) {
      parts.push("<");
      i = lt + 1;
      continue;
    }
    const gt = lower.indexOf(">", lt + 1);
    if (gt === -1) break;
    const inner = lower.slice(lt + 1, gt);
    i = gt + 1;
    const name = TAG_NAME.exec(inner)?.[1];
    if (!name) continue;
    const closing = inner.startsWith("/");
    if (!closing && SKIPPED.has(name) && !inner.endsWith("/")) {
      const end = lower.indexOf(`</${name}`, i);
      if (end === -1) break;
      const close = lower.indexOf(">", end);
      i = close === -1 ? html.length : close + 1;
      continue;
    }
    if (!closing && name === "li") parts.push("\n- ");
    else if (name === "td" || name === "th") parts.push(" ");
    else if (BLOCK.has(name)) parts.push("\n");
  }
  return tidy(decodeEntities(parts.join("")));
}

/**
 * HTML 转成 Markdown。converted 为假表示嵌套太深或者转换出错，改成了纯文本提取。
 * base 是网页自己的地址，相对链接按它换成绝对地址。
 */
export function htmlToMarkdown(
  html: string,
  base?: string,
): { markdown: string; converted: boolean } {
  const source = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  if (estimateDepth(source) > MAX_HTML_DEPTH) {
    return { markdown: htmlToText(source), converted: false };
  }
  let baseUrl: URL | undefined;
  try {
    baseUrl = base ? new URL(base) : undefined;
  } catch {
    baseUrl = undefined;
  }
  try {
    const tree = fromHtml(source);
    cleanTree(tree as unknown as HastNode, baseUrl);
    const markdown = toMarkdown(toMdast(tree), {
      extensions: [gfmToMarkdown()],
      bullet: "-",
      fences: true,
      rule: "-",
      listItemIndent: "one",
    });
    return { markdown: markdown.trim(), converted: true };
  } catch {
    return { markdown: htmlToText(source), converted: false };
  }
}
