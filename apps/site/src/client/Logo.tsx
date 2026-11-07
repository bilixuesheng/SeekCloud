import { useSerifReady } from "./fonts";

/** SeekCloud 的标志：坐在云上的小鲸鱼。图是透明背景的，放在哪种底色上都行。 */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <img
      className="logo"
      src="/brand/whale.webp"
      width={size}
      height={size}
      alt=""
      draggable={false}
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
