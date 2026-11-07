import { LEGAL_VERSION } from "@seekcloud/protocol";
import { useEffect } from "react";
import { Brand } from "../Logo";
import { LEGAL_DOCS, type LegalDoc, navigate } from "../router";
import { Markdown } from "../session/Markdown";
import { LICENSE_NAMES, LICENSE_URLS, MIT_TEXT, OPEN_SOURCE } from "./licenses";
import privacy from "./privacy.md?raw";
import terms from "./terms.md?raw";

export const LEGAL_TITLES: Record<LegalDoc, string> = {
  terms: "用户协议",
  privacy: "隐私政策",
  licenses: "开源声明",
};

/** 三份文件之间互相跳的链接，登录页、注册表单、账户菜单也用。 */
export function LegalLink({ doc, newTab }: { doc: LegalDoc; newTab?: boolean }) {
  return (
    <a
      href={`/${doc}`}
      // 注册填到一半点开协议，新开一个标签页看，填好的内容不会丢。
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

/** 用户协议、隐私政策、开源声明：不用登录也能看，手机上也好读。 */
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
        <nav className="legal-tabs" aria-label="条款和声明">
          {LEGAL_DOCS.map((item) => (
            <a
              key={item}
              href={`/${item}`}
              className={item === doc ? "current" : undefined}
              aria-current={item === doc ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate(`/${item}`);
              }}
            >
              {LEGAL_TITLES[item]}
            </a>
          ))}
        </nav>
      </header>
      <main className="legal-body" key={doc}>
        <h1>{LEGAL_TITLES[doc]}</h1>
        {doc !== "licenses" && <p className="legal-date">更新日期：{LEGAL_VERSION}</p>}
        {doc === "terms" ? (
          <Markdown text={terms} />
        ) : doc === "privacy" ? (
          <Markdown text={privacy} />
        ) : (
          <Licenses />
        )}
      </main>
      <footer className="legal-foot">SeekCloud · 内测版 · 非 DeepSeek 官方产品</footer>
    </div>
  );
}

function Licenses() {
  return (
    <div className="markdown">
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
