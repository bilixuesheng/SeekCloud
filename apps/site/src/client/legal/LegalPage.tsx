import { useEffect } from "react";
import { Brand } from "../Logo";
import { type LegalDoc, navigate } from "../router";
import { LICENSE_NAMES, LICENSE_URLS, MIT_TEXT, OPEN_SOURCE } from "./licenses";

export const LEGAL_TITLES: Record<LegalDoc, string> = { licenses: "开源声明" };

/** 开源声明的链接：登录页、账户菜单、设置里用。 */
export function LegalLink({ doc, newTab }: { doc: LegalDoc; newTab?: boolean }) {
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
      {LEGAL_TITLES[doc]}
    </a>
  );
}

/** 开源声明：不用登录也能看，手机上也好读。 */
export function LegalPage({ doc }: { doc: LegalDoc }) {
  useEffect(() => {
    document.title = `${LEGAL_TITLES[doc]} · SeekCloud`;
    window.scrollTo(0, 0);
    return () => {
      document.title = "SeekCloud";
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
        <h1>{LEGAL_TITLES[doc]}</h1>
        <Licenses />
      </main>
      <footer className="legal-foot">SeekCloud · 非 DeepSeek 官方产品</footer>
    </div>
  );
}

const SOURCE_URL = "https://github.com/bilixuesheng/SeekCloud";

/**
 * 开头是 SeekCloud 自己的声明：
 * - "基于 SeekCloud"这句署名是 NOTICE 里的附加条款（AGPL-3.0 第 7 条 (b) 项）要求保留的，改过的版本也不能删；
 * - 仓库地址同时是 AGPL-3.0 第 13 条要求的源代码获取方式。
 */
export function Licenses() {
  return (
    <div className="markdown">
      <p>
        基于 SeekCloud（
        <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
          {SOURCE_URL}
        </a>
        ）
      </p>
      <p>Copyright (C) 2026 XUESHENG</p>
      <p>
        SeekCloud 依据{" "}
        <a
          href="https://www.gnu.org/licenses/agpl-3.0.html"
          target="_blank"
          rel="noopener noreferrer"
        >
          GNU Affero 通用公共许可证第 3 版
        </a>
        （AGPL-3.0）授权，不提供任何担保。你可以依据该许可证的条款再分发和修改
        SeekCloud，源代码可从上述地址获取。
      </p>
      <p>SeekCloud 使用了以下开源软件，谨向各项目的作者致谢。</p>
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
            <div className="license-meta">{item.usage}</div>
            <div className="license-meta">{item.copyright}</div>
          </li>
        ))}
      </ul>
      <h2>MIT License</h2>
      <p>以上标注 MIT License 的软件均依据下列条款授权，版权声明见各条目。</p>
      <pre className="license-text">{MIT_TEXT}</pre>
    </div>
  );
}
