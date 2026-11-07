import type { ThinkingEffort } from "@seekcloud/protocol";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, SparkIcon } from "../Icons";
import { usePresence } from "../Motion";

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

const effortHints: Record<ThinkingEffort, string> = {
  off: "不进行思考，直接执行。速度最快，适合目标明确的小改动。",
  low: "简要思考后执行。",
  high: "默认档位，适用于大多数任务。",
  max: "最深入的思考。速度最慢、用量最多，适合复杂问题。",
};

/** 模型名去掉"DeepSeek "前缀，放在小按钮上。 */
const shortName = (name: string) => name.replace(/^DeepSeek\s+/, "");

/** 输入框里的"模型 · 思考强度"按钮，点开选模型，用滑块调思考强度。 */
export function ModelPicker({
  models,
  model,
  effort,
  onChange,
  variant = "chip",
}: {
  models: ModelInfo[];
  model: string;
  effort: ThinkingEffort;
  onChange: (model: string, effort: ThinkingEffort) => void;
  /** chip：输入框里的小按钮；plain：输入框下面一行里的纯文字，弹层往上开。 */
  variant?: "chip" | "plain";
}) {
  const [open, setOpen] = useState(false);
  // 收起时也有动画，和弹出一样快（styles.css 的 .popover.closing）。
  const { mounted, closing } = usePresence(open, 180);
  const root = useRef<HTMLDivElement>(null);
  const current = models.find((m) => m.id === model) ?? models[0];

  // 点外面或按 Esc 收起。
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!current) return null;
  const efforts = current.efforts;
  const index = Math.max(0, efforts.indexOf(effort));

  return (
    <div className={`picker ${variant}`} ref={root}>
      <button
        type="button"
        className={`chip${open ? " active" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        <span className="chip-spark">
          <SparkIcon size={12} />
        </span>
        <span className="chip-text">
          {shortName(current.name)}
          <span className="chip-sub"> · {effortLabels[effort]}</span>
        </span>
        <ChevronDownIcon />
      </button>
      {mounted && (
        <div
          className={`popover model-popover${closing ? " closing" : ""}`}
          role="dialog"
          aria-label="模型和思考强度"
        >
          <div className="popover-label">模型</div>
          <div className="model-options">
            {models.map((m) => {
              const selected = m.id === current.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  className={`model-option${selected ? " selected" : ""}`}
                  aria-pressed={selected}
                  onClick={() => onChange(m.id, m.efforts.includes(effort) ? effort : "high")}
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
          <div className="popover-divider" />
          <div className="effort">
            <div className="effort-head">
              <span className="popover-label">思考强度</span>
              <span className="effort-value">{effortLabels[effort]}</span>
            </div>
            <input
              type="range"
              className="effort-slider"
              min={0}
              max={efforts.length - 1}
              step={1}
              value={index}
              aria-label="思考强度"
              aria-valuetext={effortLabels[effort]}
              style={{ "--fill": `${(index / (efforts.length - 1)) * 100}%` } as CSSProperties}
              onChange={(e) => onChange(current.id, efforts[Number(e.target.value)] ?? effort)}
            />
            <div className="effort-ticks">
              {efforts.map((e) => (
                <button
                  key={e}
                  type="button"
                  className={e === effort ? "current" : undefined}
                  onClick={() => onChange(current.id, e)}
                >
                  {effortLabels[e]}
                </button>
              ))}
            </div>
            <p className="effort-hint">{effortHints[effort]}</p>
          </div>
        </div>
      )}
    </div>
  );
}
