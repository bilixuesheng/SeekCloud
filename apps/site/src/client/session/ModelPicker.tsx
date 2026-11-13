import { fitEffort, THINKING_EFFORTS, type ThinkingEffort } from "@seekcloud/protocol";
import { type CSSProperties, type RefObject, useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from "../Icons";
import { Pages, reducedMotion, usePresence } from "../Motion";

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  efforts: ThinkingEffort[];
}

export const effortLabels: Record<ThinkingEffort, string> = {
  off: "关闭",
  low: "低",
  high: "高",
  max: "最高",
};

/** 拉到"最高"时，档位名的位置换成这句话，过一会儿再换回来。 */
export const MAX_HINT = "思考时间更长，用量更多。";
const MAX_HINT_MS = 1400;

/** 滑块上从左到右的四档。模型不支持的那几档也画出来，只是不可选。 */
const STOPS = THINKING_EFFORTS;
const LAST = STOPS.length - 1;

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

/**
 * 输入框下面的"模型名 + 档位"按钮，点开是模型和思考强度合在一起的弹层（照 Codex）：
 * 顶上是档位名和模型名，点模型名整页滑到模型列表，选好以后滑回来；右边"恢复默认"回到设置里的默认思考强度。
 * 以后 Agent 模式也放进这个弹层（Agent 模式那份规格），放在滑块下面。
 */
export function ModelPicker({
  models,
  model,
  effort,
  defaultEffort,
  onChange,
}: {
  models: ModelInfo[];
  model: string;
  effort: ThinkingEffort;
  /** 设置里的默认思考强度，"恢复默认"用。 */
  defaultEffort: ThinkingEffort;
  onChange: (model: string, effort: ThinkingEffort) => void;
}) {
  const [open, setOpen] = useState(false);
  // 收起时也有动画，和弹出一样快（styles.css 的 .popover.closing）。
  const { mounted, closing } = usePresence(open, 180);
  const root = useRef<HTMLDivElement>(null);
  const current = models.find((m) => m.id === model) ?? models[0];

  // 点外面收起。Esc 在弹层里处理（模型列表那页先回到上一页）。
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  if (!current) return null;

  return (
    <div className="picker" ref={root}>
      <button
        type="button"
        className={`chip model-trigger${open ? " active" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        <span className="chip-text">
          {current.name} <span className={`trigger-effort ${effort}`}>{effortLabels[effort]}</span>
        </span>
        <ChevronDownIcon />
      </button>
      {mounted && (
        <ModelEffortMenu
          models={models}
          current={current}
          effort={effort}
          defaultEffort={fitEffort(current.efforts, defaultEffort) ?? effort}
          closing={closing}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function ModelEffortMenu({
  models,
  current,
  effort,
  defaultEffort,
  closing,
  onChange,
  onClose,
}: {
  models: ModelInfo[];
  current: ModelInfo;
  effort: ThinkingEffort;
  defaultEffort: ThinkingEffort;
  closing: boolean;
  onChange: (model: string, effort: ThinkingEffort) => void;
  onClose: () => void;
}) {
  const [page, setPage] = useState(0);
  // 拖动中的档位：松手之前档位名就跟着变，松手才真正选上
  const [dragging, setDragging] = useState<ThinkingEffort | null>(null);
  const live = dragging ?? effort;
  const hint = useMaxHint(live);
  const thumb = useRef<HTMLSpanElement>(null);
  const unsupported = STOPS.filter((e) => !current.efforts.includes(e));

  // 打开时焦点放在滑块上，方向键直接能换档
  useEffect(() => {
    thumb.current?.focus({ preventScroll: true });
  }, []);

  // Esc：在模型列表那页先回到上一页，再按一次收起
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (page === 1) setPage(0);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [page, onClose]);

  const pickModel = (next: ModelInfo) => {
    onChange(next.id, fitEffort(next.efforts, effort) ?? effort);
    setPage(0);
    thumb.current?.focus({ preventScroll: true });
  };

  return (
    <div
      className={`popover model-popover${closing ? " closing" : ""}`}
      role="dialog"
      aria-label="模型和思考强度"
    >
      <Pages active={page}>
        <div className="effort-page">
          <div className="effort-head">
            <span aria-hidden="true" />
            <button
              type="button"
              className="effort-title"
              aria-label={`选择模型，当前为 ${current.name}`}
              onClick={() => setPage(1)}
            >
              <span className={`effort-title-main${hint ? " out" : ""}`}>
                <span className={`effort-name ${live}`}>{effortLabels[live]}</span>
                <span className="effort-model">
                  <span className="effort-model-name">{current.name}</span>
                  <ChevronRightIcon />
                </span>
              </span>
              <span className={`effort-hint-max${hint ? " in" : ""}`} aria-hidden="true">
                {MAX_HINT}
              </span>
            </button>
            <button
              type="button"
              className="icon-button small"
              aria-label="恢复默认"
              title="恢复默认"
              disabled={effort === defaultEffort}
              onClick={() => onChange(current.id, defaultEffort)}
            >
              <ResetIcon />
            </button>
          </div>
          <EffortSlider
            thumbRef={thumb}
            efforts={current.efforts}
            value={effort}
            onChange={(e) => onChange(current.id, e)}
            onDrag={setDragging}
            describedBy={unsupported.length > 0 ? "effort-unsupported" : undefined}
          />
          {unsupported.length > 0 && (
            <p className="effort-note" id="effort-unsupported">
              {current.name} 不支持{unsupported.map((e) => `"${effortLabels[e]}"`).join("、")}档。
            </p>
          )}
          {/* 读屏软件：到"最高"时读出提示 */}
          <span className="visually-hidden" aria-live="polite">
            {hint ? MAX_HINT : ""}
          </span>
        </div>
        <div className="model-page">
          <div className="model-page-head">
            <button
              type="button"
              className="icon-button small"
              aria-label="返回"
              onClick={() => setPage(0)}
            >
              <span className="flip">
                <ChevronRightIcon />
              </span>
            </button>
            <span>模型</span>
          </div>
          {models.map((m) => {
            const selected = m.id === current.id;
            return (
              <button
                key={m.id}
                type="button"
                className={`model-option${selected ? " selected" : ""}`}
                aria-pressed={selected}
                onClick={() => pickModel(m)}
              >
                <span className="model-option-text">
                  <span className="model-name">{m.name}</span>
                  <span className="model-desc">{m.description}</span>
                </span>
                {selected && <CheckIcon />}
              </button>
            );
          })}
        </div>
      </Pages>
    </div>
  );
}

/** 到了"最高"才提示，显示一会儿就换回档位名；打开弹层时本来就在"最高"不提示。 */
function useMaxHint(live: ThinkingEffort): boolean {
  const [hint, setHint] = useState(false);
  const prev = useRef(live);
  useEffect(() => {
    const was = prev.current;
    prev.current = live;
    if (live !== "max") {
      setHint(false);
      return;
    }
    if (was === "max") return;
    setHint(true);
    const timer = setTimeout(() => setHint(false), MAX_HINT_MS);
    return () => clearTimeout(timer);
  }, [live]);
  return hint;
}

/** 滑块上离 r（0 到 1）最近的、模型支持的一档。 */
export function nearest(efforts: readonly ThinkingEffort[], r: number): ThinkingEffort {
  const at = r * LAST;
  let best = efforts[0] ?? "high";
  for (const e of efforts) {
    if (Math.abs(STOPS.indexOf(e) - at) < Math.abs(STOPS.indexOf(best) - at)) best = e;
  }
  return best;
}

/** 往左（-1）或往右（1）的下一个支持的档位；到头了就不动。 */
export function step(efforts: readonly ThinkingEffort[], from: ThinkingEffort, dir: 1 | -1) {
  for (let i = STOPS.indexOf(from) + dir; i >= 0 && i <= LAST; i += dir) {
    const e = STOPS[i];
    if (e && efforts.includes(e)) return e;
  }
  return from;
}

/**
 * 思考强度的滑块（照 Codex）：一条粗胶囊，白色圆点在胶囊里，每一档有一个小点，填充拖过去就盖住。
 * 填充平时是蓝色，往"最高"拉时蓝紫渐变渐渐显出来，圆点微微发光；粒子只在填充里，越接近"最高"越多、越快。
 * 位置是注册过的 CSS 变量 --r（styles.css），能连续拖；松手吸到最近一档，点某一档也平滑过去。
 */
function EffortSlider({
  thumbRef,
  efforts,
  value,
  onChange,
  onDrag,
  describedBy,
}: {
  thumbRef: RefObject<HTMLSpanElement | null>;
  efforts: readonly ThinkingEffort[];
  value: ThinkingEffort;
  onChange: (effort: ThinkingEffort) => void;
  onDrag: (effort: ThinkingEffort | null) => void;
  describedBy?: string;
}) {
  const index = STOPS.indexOf(value);
  const [drag, setDrag] = useState<number | null>(null);
  const [moving, setMoving] = useState(false);
  const startX = useRef(0);
  const track = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const ratio = drag ?? index / LAST;

  useParticles(canvas, track);

  const at = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect) return 0;
    return clamp((clientX - rect.left - 16) / (rect.width - 32));
  };
  const end = () => {
    setDrag(null);
    setMoving(false);
    onDrag(null);
  };
  const keyStep = (key: string): ThinkingEffort | undefined => {
    if (key === "ArrowRight" || key === "ArrowUp" || key === "PageUp") {
      return step(efforts, value, 1);
    }
    if (key === "ArrowLeft" || key === "ArrowDown" || key === "PageDown") {
      return step(efforts, value, -1);
    }
    if (key === "Home") return STOPS.find((e) => efforts.includes(e)) ?? value;
    if (key === "End") return STOPS.findLast((e) => efforts.includes(e)) ?? value;
    return undefined;
  };

  return (
    <div
      ref={track}
      className={`effort-track${moving ? " dragging" : ""}`}
      style={{ "--r": ratio } as CSSProperties}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        startX.current = e.clientX;
        const r = at(e.clientX);
        setDrag(r);
        onDrag(nearest(efforts, r));
      }}
      onPointerMove={(e) => {
        if (drag === null) return;
        // 按下以后真的拖动了才跟手，只是点一下就让圆点平滑地滑过去
        if (!moving && Math.abs(e.clientX - startX.current) > 3) setMoving(true);
        const r = at(e.clientX);
        setDrag(r);
        onDrag(nearest(efforts, r));
      }}
      onPointerUp={(e) => {
        if (drag === null) return;
        const picked = nearest(efforts, at(e.clientX));
        end();
        onChange(picked);
        thumbRef.current?.focus({ preventScroll: true });
      }}
      onPointerCancel={end}
    >
      {STOPS.map((e, i) => (
        <span
          key={e}
          className={`effort-stop${efforts.includes(e) ? "" : " unsupported"}`}
          style={{ "--i": i / LAST } as CSSProperties}
        />
      ))}
      <span className="effort-fill">
        <span className="effort-fill-max" />
      </span>
      <canvas ref={canvas} className="effort-particles" />
      <span
        ref={thumbRef}
        className="effort-thumb"
        role="slider"
        tabIndex={0}
        aria-label="思考强度"
        aria-valuemin={0}
        aria-valuemax={LAST}
        aria-valuenow={index}
        aria-valuetext={effortLabels[value]}
        aria-describedby={describedBy}
        onKeyDown={(e) => {
          const next = keyStep(e.key);
          if (!next) return;
          e.preventDefault();
          if (next !== value) onChange(next);
        }}
      />
    </div>
  );
}

/**
 * 填充里的粒子：从右往左流，填充越长出现得越多，越接近"最高"越多、越快、越闪。
 * 每帧读正在过渡中的 --r，松手吸附时粒子和圆点、填充一起动。减少动效时只画一帧，不动。
 */
function useParticles(
  canvas: RefObject<HTMLCanvasElement | null>,
  track: RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    const c = canvas.current;
    const tr = track.current;
    const ctx = c?.getContext("2d");
    if (!c || !tr || !ctx) return;
    const dpr = devicePixelRatio || 1;
    let w = 0;
    let h = 0;
    const resize = () => {
      w = c.clientWidth;
      h = c.clientHeight;
      c.width = w * dpr;
      c.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    // u 是粒子"在填充里的比例"（0 在最左，1 在圆点那里）：填充变长时整片跟着铺开，不留空当；
    // k 决定填充多长时它才出现，让疏密保持差不多；后 40 个只在往"最高"去时才出现
    const parts = Array.from({ length: 90 }, (_, i) => ({
      u: Math.random(),
      y: Math.random(),
      r: 0.5 + Math.random() * 1.2,
      v: 10 + Math.random() * 24,
      a: 0.45 + Math.random() * 0.55,
      ph: Math.random() * 6.28,
      k: Math.random(),
      px: -1,
      age: 1,
      extra: i >= 50,
    }));
    const still = reducedMotion();
    let last = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const dt = still ? 0 : Math.max(0.001, Math.min(0.05, (now - last) / 1000));
      last = now;
      const r = Number.parseFloat(getComputedStyle(tr).getPropertyValue("--r")) || 0;
      const p = clamp((r - 2 / 3) * 3);
      const fillX = (w - 32) * r + 32;
      const span = Math.max(8, fillX - 8);
      const fillAlpha = clamp(r * 8);
      const density = fillX / Math.max(1, w);
      ctx.clearRect(0, 0, w, h);
      for (const q of parts) {
        // 往左流的速度按像素算，填充长短不影响快慢
        q.u -= (q.v * (1 + 2.4 * p) * dt) / span;
        q.age += dt;
        if (q.u < 0) {
          q.u += 1;
          q.y = Math.random();
          q.age = 0;
          q.px = -1;
        }
        const x = q.u * span;
        const moved = q.px < 0 ? 0 : x - q.px;
        q.px = x;
        // 靠近右端淡出，新出来的淡入
        const edge = clamp((span - x) / 14);
        const born = clamp(q.age / 0.4);
        const keep = clamp((density - q.k) * 6 + 0.5);
        let a = q.a * edge * fillAlpha * born * keep;
        if (q.extra) a *= p;
        if (a < 0.02) continue;
        const twinkle = still ? 1 : 1 - 0.45 * p + 0.45 * p * Math.sin(now / 160 + q.ph);
        const y = 6 + q.y * (h - 12);
        ctx.globalAlpha = a * twinkle;
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = "#ffffff";
        // 被带着往右走时只拉出一点点拖尾（最多 3 像素）
        const tail = Math.min(3, Math.max(0, moved - 1) * 0.6);
        ctx.beginPath();
        if (tail > 0.5) {
          ctx.lineWidth = q.r * 2;
          ctx.lineCap = "round";
          ctx.moveTo(x, y);
          ctx.lineTo(x - tail, y);
          ctx.stroke();
        } else {
          ctx.arc(x, y, q.r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const observer = new ResizeObserver(resize);
    observer.observe(c);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [canvas, track]);
}

const ResetIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4 10a6 6 0 1 0 1.8-4.3M4 3.5v3h3" />
  </svg>
);
