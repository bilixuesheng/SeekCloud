import { useState } from "react";
import { CheckIcon, CopyIcon } from "./Icons";

/**
 * 复制到剪贴板，返回有没有复制成功。
 * navigator.clipboard 只在 HTTPS 和 localhost 上有；用 http://<内网地址> 打开自己部署的主站时没有，
 * 这时退回到选中一个看不见的文本框再执行复制。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 没有权限之类：接着试下面的办法
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  // 放在屏幕外，不让页面跳一下；字号 16px，iOS 才不会放大页面
  area.style.cssText = "position:fixed;top:0;left:-9999px;font-size:16px;opacity:0";
  const active = document.activeElement as HTMLElement | null;
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  // 焦点还给原来的元素（比如输入框），手机上输入法不收起
  active?.focus?.();
  return ok;
}

/** 复制 text，复制成功后的一会儿 copied 为真（按钮显示成勾）。 */
export function useCopy(text: string): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return [copied, copy];
}

export function CopyButton({
  copied,
  onCopy,
  className = "icon-button small",
}: {
  copied: boolean;
  onCopy: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={className}
      aria-label={copied ? "已复制" : "复制"}
      data-tip={copied ? "已复制" : "复制"}
      onClick={onCopy}
    >
      {copied ? <CheckIcon size={13} /> : <CopyIcon />}
    </button>
  );
}
