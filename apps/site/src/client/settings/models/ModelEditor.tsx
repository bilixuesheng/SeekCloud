import { THINKING_EFFORTS, type ThinkingEffort } from "@seekcloud/protocol";
import { useMemo, useRef, useState } from "react";
import { type ApiError, api } from "../../api";
import { ChevronDownIcon, CloseIcon, MenuIcon, PlusIcon, SearchIcon } from "../../Icons";
import { effortLabels } from "../../session/ModelPicker";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  MODEL_PROVIDERS,
  type ModelInput,
  type ModelSpec,
  type ReasoningEfforts,
} from "./types";

/** 编辑中的一个模型：key 只给 React 用（ID 可能被改）。 */
export interface DraftModel extends ModelSpec {
  key: string;
}

let nextKey = 0;
export const draftOf = (spec: ModelSpec): DraftModel => ({ ...spec, key: `m${nextKey++}` });

/** 端点列出的一个模型（获取可用模型）。 */
interface Probed {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * 模型目录（照 dsh 的"自定义设置 → 模型目录"）：每个模型一行，展开是"模型选项"；
 * 拖三横线（或者聚焦后按上下方向键）调整顺序；可以手动添加，也可以"获取可用模型"。
 * probe 是问端点用的表单内容（已保存的提供方带 id，表单里填了的地址、协议、key 一起带上）。
 */
export function ModelEditor({
  models,
  onChange,
  probe,
  allowReasoning,
}: {
  models: DraftModel[];
  onChange: (models: DraftModel[]) => void;
  probe: Record<string, unknown> | undefined;
  /** 自定义接口的模型可以声明推理等级；内置的、目录里的由目录给（dsh 也是在配置文件里改）。 */
  allowReasoning: boolean;
}) {
  const [open, setOpen] = useState<string>();
  const [adding, setAdding] = useState("");
  const [probing, setProbing] = useState<{ models?: Probed[]; error?: string; busy?: boolean }>();
  const list = useRef<HTMLUListElement>(null);
  const dragging = useRef<{ key: string; pointer: number } | undefined>(undefined);

  const update = (key: string, patch: Partial<ModelSpec>) =>
    onChange(models.map((m) => (m.key === key ? { ...m, ...patch } : m)));
  const move = (key: string, to: number) => {
    const from = models.findIndex((m) => m.key === key);
    if (from < 0 || to < 0 || to >= models.length || from === to) return;
    const next = [...models];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item as DraftModel);
    onChange(next);
  };
  const add = () => {
    const id = adding.trim();
    if (!id || models.some((m) => m.id === id)) return;
    onChange([...models, draftOf({ id, input: ["text"] })]);
    setAdding("");
  };

  const runProbe = async () => {
    if (!probe) return;
    setProbing({ busy: true });
    try {
      const res = await api<{ models: Probed[] }>(`${MODEL_PROVIDERS}/probe`, probe);
      setProbing({ models: res.models });
    } catch (e) {
      setProbing({ error: (e as ApiError).message });
    }
  };

  return (
    <div className="model-editor">
      <div className="model-editor-head">
        <span>模型目录</span>
        {probe && (
          <button
            type="button"
            className="pill-button"
            disabled={probing?.busy}
            onClick={() => void runProbe()}
          >
            {probing?.busy ? "正在获取…" : "获取可用模型"}
          </button>
        )}
      </div>
      {probing?.error && (
        <p className="alert" role="alert">
          {probing.error}
        </p>
      )}
      {probing?.models && (
        <ProbePicker
          probed={probing.models}
          current={models}
          onCancel={() => setProbing(undefined)}
          onApply={(next) => {
            onChange(next);
            setProbing(undefined);
          }}
        />
      )}
      <ul className="model-rows" ref={list}>
        {models.map((m, index) => (
          <li key={m.key} className={`model-row${open === m.key ? " open" : ""}`} data-key={m.key}>
            <div className="model-row-head">
              <button
                type="button"
                className="model-row-handle"
                aria-label={`调整 ${m.id} 的顺序（上下方向键）`}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    move(m.key, index - 1);
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    move(m.key, index + 1);
                  }
                }}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  dragging.current = { key: m.key, pointer: e.pointerId };
                }}
                onPointerMove={(e) => {
                  const drag = dragging.current;
                  if (!drag || drag.pointer !== e.pointerId || !list.current) return;
                  const rows = [...list.current.querySelectorAll<HTMLElement>(".model-row")];
                  const target = rows.findIndex((row) => {
                    const rect = row.getBoundingClientRect();
                    return e.clientY < rect.top + rect.height / 2;
                  });
                  const to = target < 0 ? rows.length - 1 : target;
                  const from = models.findIndex((x) => x.key === drag.key);
                  move(drag.key, to > from ? to - 1 : to);
                }}
                onPointerUp={() => {
                  dragging.current = undefined;
                }}
                onPointerCancel={() => {
                  dragging.current = undefined;
                }}
              >
                <MenuIcon />
              </button>
              <button
                type="button"
                className="model-row-title"
                aria-expanded={open === m.key}
                onClick={() => setOpen(open === m.key ? undefined : m.key)}
              >
                <span className="model-row-name">{m.name || m.id}</span>
                {m.name && m.name !== m.id && <span className="model-row-id">{m.id}</span>}
                <span className="model-row-chevron">
                  <ChevronDownIcon />
                </span>
              </button>
              <button
                type="button"
                className="icon-button small"
                aria-label={`移除 ${m.id}`}
                onClick={() => onChange(models.filter((x) => x.key !== m.key))}
              >
                <CloseIcon size={14} />
              </button>
            </div>
            {open === m.key && (
              <ModelOptions
                model={m}
                allowReasoning={allowReasoning}
                onChange={(patch) => update(m.key, patch)}
              />
            )}
          </li>
        ))}
      </ul>
      {models.length === 0 && <p className="settings-hint">还没有模型。请添加模型 ID。</p>}
      <div className="model-add">
        <input
          aria-label="模型 ID"
          placeholder="模型 ID，例如 gpt-5"
          value={adding}
          maxLength={200}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button
          type="button"
          className="pill-button"
          disabled={!adding.trim() || models.some((m) => m.id === adding.trim())}
          onClick={add}
        >
          <PlusIcon size={14} /> 添加
        </button>
      </div>
    </div>
  );
}

/** 一个模型的选项：显示名称、上下文窗口、最大输出、输入类型、推理等级。 */
function ModelOptions({
  model,
  allowReasoning,
  onChange,
}: {
  model: DraftModel;
  allowReasoning: boolean;
  onChange: (patch: Partial<ModelSpec>) => void;
}) {
  const efforts = model.reasoningEfforts ?? null;
  const toggleInput = (input: ModelInput) => {
    const has = model.input.includes(input);
    const next = has ? model.input.filter((i) => i !== input) : [...model.input, input];
    // 至少留一种
    if (next.length > 0)
      onChange({ input: (["text", "image"] as const).filter((i) => next.includes(i)) });
  };
  const number = (value: string) => {
    const n = Number(value);
    return value.trim() && Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  return (
    <div className="model-options">
      <label className="field">
        <span>模型 ID</span>
        <input
          value={model.id}
          maxLength={200}
          onChange={(e) => onChange({ id: e.target.value.trim() })}
        />
      </label>
      <label className="field">
        <span>显示名称</span>
        <input
          value={model.name ?? ""}
          maxLength={100}
          placeholder={model.id}
          onChange={(e) => onChange({ name: e.target.value || null })}
        />
      </label>
      <div className="model-options-pair">
        <label className="field">
          <span>上下文窗口</span>
          <input
            inputMode="numeric"
            value={model.contextWindow ?? ""}
            placeholder={String(DEFAULT_CONTEXT_WINDOW)}
            onChange={(e) => onChange({ contextWindow: number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>最大输出 token 数</span>
          <input
            inputMode="numeric"
            value={model.maxTokens ?? ""}
            placeholder={String(DEFAULT_MAX_TOKENS)}
            onChange={(e) => onChange({ maxTokens: number(e.target.value) })}
          />
        </label>
      </div>
      <fieldset className="model-inputs">
        <legend>输入类型</legend>
        {(["text", "image"] as const).map((input) => (
          <label key={input} className="checkbox">
            <input
              type="checkbox"
              checked={model.input.includes(input)}
              disabled={model.input.length === 1 && model.input.includes(input)}
              onChange={() => toggleInput(input)}
            />
            {input === "text" ? "文本" : "图片"}
          </label>
        ))}
      </fieldset>
      {allowReasoning && (
        <ReasoningRows
          efforts={efforts}
          onChange={(next) => onChange({ reasoningEfforts: next })}
        />
      )}
    </div>
  );
}

const DEFAULT_LEVELS: ReasoningEfforts = { off: null, low: "low", medium: "medium", high: "high" };

/**
 * 推理等级（照 dsh）：打开开关默认 off、low、medium、high 四行，参数值默认等于档位名；
 * 只有 off 能留空（不传参数）；至少留一个 off 以外的档位。关掉开关就删掉这个声明。
 */
function ReasoningRows({
  efforts,
  onChange,
}: {
  efforts: ReasoningEfforts | null;
  onChange: (efforts: ReasoningEfforts | null) => void;
}) {
  const on = efforts !== null;
  const levels = on ? THINKING_EFFORTS.filter((l) => l in efforts) : [];
  const unused = THINKING_EFFORTS.filter((l) => !levels.includes(l));
  const set = (level: ThinkingEffort, value: string | null) =>
    onChange({ ...efforts, [level]: value });
  const remove = (level: ThinkingEffort) => {
    const next = { ...efforts };
    delete next[level];
    if (Object.keys(next).some((l) => l !== "off")) onChange(next);
  };
  return (
    <div className="reasoning">
      <div className="reasoning-head">
        <span>推理等级</span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="推理等级"
          className="switch"
          onClick={() => onChange(on ? null : { ...DEFAULT_LEVELS })}
        >
          <span className="switch-knob" aria-hidden="true" />
        </button>
      </div>
      {on && (
        <>
          <ul className="reasoning-rows">
            {levels.map((level) => (
              <li key={level} className="reasoning-row">
                <span className="reasoning-level">{effortLabels[level]}</span>
                <input
                  aria-label={`${effortLabels[level]}的参数值`}
                  value={efforts?.[level] ?? ""}
                  placeholder={level === "off" ? "不传参数" : level}
                  maxLength={40}
                  onChange={(e) =>
                    set(level, e.target.value.trim() || (level === "off" ? null : level))
                  }
                />
                <button
                  type="button"
                  className="icon-button small"
                  aria-label={`删除${effortLabels[level]}`}
                  disabled={level !== "off" && levels.filter((l) => l !== "off").length <= 1}
                  onClick={() => remove(level)}
                >
                  <CloseIcon size={12} />
                </button>
              </li>
            ))}
          </ul>
          {unused.length > 0 && (
            <select
              className="settings-select small"
              aria-label="添加档位"
              value=""
              onChange={(e) => {
                const level = e.target.value as ThinkingEffort;
                if (level) set(level, level === "off" ? null : level);
              }}
            >
              <option value="">添加档位…</option>
              {unused.map((l) => (
                <option key={l} value={l}>
                  {effortLabels[l]}（{l}）
                </option>
              ))}
            </select>
          )}
          <p className="settings-hint">
            参数值是发给接口的写法，默认和档位名相同；只有接口文档写法不同时才需要修改。
          </p>
        </>
      )}
    </div>
  );
}

/**
 * 获取可用模型的结果：可搜索的选择框，列表里已有的默认勾选；勾上的加进来、取消的从列表里去掉，
 * 端点没列出的已配置模型不动。点"更新列表"才改，取消什么都不变。
 */
function ProbePicker({
  probed,
  current,
  onApply,
  onCancel,
}: {
  probed: Probed[];
  current: DraftModel[];
  onApply: (models: DraftModel[]) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState(
    () => new Set(probed.filter((p) => current.some((m) => m.id === p.id)).map((p) => p.id)),
  );
  const shown = useMemo(
    () =>
      probed.filter(
        (p) =>
          !query ||
          p.id.toLowerCase().includes(query.toLowerCase()) ||
          p.name?.toLowerCase().includes(query.toLowerCase()),
      ),
    [probed, query],
  );
  const apply = () => {
    const listed = new Set(probed.map((p) => p.id));
    const kept = current.filter((m) => !listed.has(m.id) || checked.has(m.id));
    const added = probed
      .filter((p) => checked.has(p.id) && !current.some((m) => m.id === p.id))
      .map((p) =>
        draftOf({
          id: p.id,
          name: p.name ?? null,
          contextWindow: p.contextWindow ?? null,
          maxTokens: p.maxTokens ?? null,
          input: ["text"],
        }),
      );
    onApply([...kept, ...added]);
  };
  if (probed.length === 0) {
    return (
      <div className="probe-picker">
        <p className="settings-hint">端点没有列出模型，请手动添加模型 ID。</p>
        <div className="settings-form-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            关闭
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="probe-picker">
      <span className="probe-search">
        <SearchIcon />
        <input
          aria-label="搜索模型"
          placeholder={`搜索 ${probed.length} 个模型`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </span>
      <ul className="probe-list">
        {shown.map((p) => (
          <li key={p.id} className="probe-row">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={checked.has(p.id)}
                onChange={() => {
                  const next = new Set(checked);
                  if (next.has(p.id)) next.delete(p.id);
                  else next.add(p.id);
                  setChecked(next);
                }}
              />
              <span className="probe-name">{p.name ?? p.id}</span>
              {p.name && <span className="probe-id">{p.id}</span>}
            </label>
          </li>
        ))}
      </ul>
      <div className="settings-form-actions">
        <button type="button" className="secondary" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="primary" onClick={apply}>
          更新列表
        </button>
      </div>
    </div>
  );
}
