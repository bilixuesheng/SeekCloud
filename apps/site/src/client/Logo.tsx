import type { CSSProperties } from "react";
import { useSerifReady } from "./fonts";

/** SeekCloud 的标志：坐在云上的小鲸鱼。图是透明背景的，放在哪种底色上都行。 */
export function Logo({ size = 32, transitionName }: { size?: number; transitionName?: string }) {
  return (
    <img
      className="logo"
      src="/brand/whale.webp"
      width={size}
      height={size}
      alt=""
      draggable={false}
      // 换页时和同名的元素之间平滑地挪过去（首页的标志 → 会话页底部的鲸鱼）
      style={transitionName ? ({ viewTransitionName: transitionName } as CSSProperties) : undefined}
    />
  );
}

/** 标志加中文名。 */
export function Brand({ size = 28 }: { size?: number }) {
  const ready = useSerifReady("SeekCloud");
  return (
    <span className="brand">
      <Logo size={size} />
      <span className={`wordmark serif-text${ready ? "" : " pending"}`}>SeekCloud</span>
    </span>
  );
}
