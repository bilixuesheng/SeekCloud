import { useEffect } from "react";
import { pageTitle, t, tRich, useT } from "../i18n";
import { Brand } from "../Logo";
import { navigate } from "../router";
import { LICENSE_NAMES, LICENSE_URLS, MIT_TEXT, OPEN_SOURCE } from "./licenses";

/** 不用登录也能看的页面：开源声明。 */
export const LEGAL_DOCS = ["licenses"] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];

/** 文档的标题（按界面语言）。 */
export const legalTitle = (doc: LegalDoc): string => ({ licenses: t("legal.licenses") })[doc];

/** 开源声明的链接：登录页、账户菜单、设置里用。 */
export function LegalLink({ doc, newTab }: { doc: LegalDoc; newTab?: boolean }) {
  useT();
  return (
    <a
      href={`/${doc}`}
      // 账户菜单和设置里点开时新开一个标签页，原来的页面不动。
      {...(newTab
        ? { target: "_blank", rel: "noopener" }
        : {
            onClick: (e) => {
              e.preventDefault();
              navigate(`/${doc}`);
            },
          })}
    >
      {legalTitle(doc)}
    </a>
  );
}

/** 开源声明：不用登录也能看，手机上也好读。 */
export function LegalPage({ doc }: { doc: LegalDoc }) {
  useT();
  useEffect(() => {
    document.title = pageTitle(legalTitle(doc));
    window.scrollTo(0, 0);
    return () => {
      document.title = pageTitle();
    };
  }, [doc]);

  return (
    <div className="legal-page">
      <header className="legal-head">
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
      </header>
      <main className="legal-body" key={doc}>
        <h1>{legalTitle(doc)}</h1>
        <Licenses />
      </main>
      <footer className="legal-foot">{t("legal.footer")}</footer>
    </div>
  );
}

const SOURCE_URL = "https://github.com/bilixuesheng/SeekCloud";

/**
 * 附加条款规定的署名原文（NOTICE）：两种界面语言下都照原文显示，不翻译；英文界面在后面另附一句说明
 * （legal.attributionMeaning）。
 */
// 不是界面文案：附加条款规定的署名原文，不进文案目录
const ATTRIBUTION = "基于 SeekCloud";

/**
 * 开头是 SeekCloud 自己的声明：
 * - "基于 SeekCloud"这句署名是 NOTICE 里的附加条款（AGPL-3.0 第 7 条 (b) 项）要求保留的，改过的版本也不能删；
 * - 仓库地址同时是 AGPL-3.0 第 13 条要求的源代码获取方式。
 */
export function Licenses() {
  const t = useT();
  const meaning = t("legal.attributionMeaning");
  return (
    <div className="markdown">
      <p>
        <span lang="zh-CN">
          {ATTRIBUTION}（
          <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
            {SOURCE_URL}
          </a>
          ）
        </span>
        {meaning && ` ${meaning}`}
      </p>
      <p>Copyright (C) 2026 XUESHENG</p>
      <p>
        {tRich("legal.license", {
          link: (
            <a
              href="https://www.gnu.org/licenses/agpl-3.0.html"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("legal.agpl")}
            </a>
          ),
        })}
      </p>
      <p>{t("legal.thanks")}</p>
      <ul className="license-list">
        {OPEN_SOURCE.map((item) => (
          <li key={item.name} className="license-item">
            <div className="license-name">
              <a href={item.url} target="_blank" rel="noopener noreferrer">
                {item.name}
              </a>
              <a
                className="license-badge"
                href={LICENSE_URLS[item.license]}
                target="_blank"
                rel="noopener noreferrer"
              >
                {LICENSE_NAMES[item.license]}
              </a>
            </div>
            <div className="license-meta">{t(item.usage)}</div>
            <div className="license-meta">{item.copyright}</div>
          </li>
        ))}
      </ul>
      <h2>MIT License</h2>
      <p>{t("legal.mitNote")}</p>
      <pre className="license-text">{MIT_TEXT}</pre>
    </div>
  );
}
