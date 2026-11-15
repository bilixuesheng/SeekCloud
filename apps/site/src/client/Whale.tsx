import type { CSSProperties } from "react";
import base from "./brand/whale-base.webp";
import sparkle from "./brand/whale-sparkle.webp";
import tail from "./brand/whale-tail.webp";

/**
 * 会动的鲸鱼。标志（docs/brand/whale-on-cloud-source.webp）拆成三层：身体和云、尾巴、闪光，
 * 三张图一样大、叠在一起和原图一模一样（怎么拆的见 docs/brand/README.md）。
 * swimming 时尾巴摆动、闪光一闪一闪、整只轻轻上下浮动；Agent 不在工作时不动。
 * 只在会话页底部用（30 像素）；首页那只大的是原图（Logo），发起会话时原图挪到这里，挪完（0.5 秒）才开始游。
 * transitionName：换页时和首页的标志之间平滑地挪过去。
 */
export function Whale({
  size,
  swimming = false,
  transitionName,
}: {
  size: number;
  swimming?: boolean;
  transitionName?: string;
}) {
  const style: CSSProperties = { width: size, height: size };
  if (transitionName)
    (style as Record<string, string | number>).viewTransitionName = transitionName;
  return (
    <span className={`whale${swimming ? " swimming" : ""}`} style={style} aria-hidden="true">
      <span className="whale-bob">
        <img className="whale-layer" src={base} alt="" draggable={false} />
        <img className="whale-layer whale-tail" src={tail} alt="" draggable={false} />
        <img className="whale-layer whale-sparkle" src={sparkle} alt="" draggable={false} />
      </span>
    </span>
  );
}
