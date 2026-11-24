import type { ModelProtocol, ThinkingEffort } from "@seekcloud/protocol";
import { useId, useState } from "react";
import { ChevronDownIcon } from "../../Icons";
import { t, useT } from "../../i18n";
import { effortLabels } from "../../session/ModelPicker";
import {
  ADAPTIVE,
  ANTHROPIC_BUDGETS,
  defaultLevels,
  defaultValue,
  fitLevels,
  hasCustomValues,
  protocolRules,
} from "./reasoning";
import { fullTokens, parseTokens, shortTokens, tokenInputText } from "./tokens";
import type { ModelSpec, ReasoningEfforts } from "./types";

/**
 * 编辑一个模型时的几块输入：token 数（上下文窗口、最大输出）、思考档位、价格。
 * 2026-11-22 用户说上下文窗口直接填 1000000 反人类、思考档位和参数不是每个模型都一样，照这个重做。
 */

/**
 * token 数的输入框：可以写 128K、1M、12.8万、131,072；下面一排常见的值点一下就填上，
 * 再下面一行写出读到的完整数字（或者写法不对时的提示）。空着是"不填"。
 */
export function TokenField({
  label,
  value,
  onChange,
  presets,
  placeholder,
  problem,
}: {
  label: string;
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  presets: number[];
  placeholder?: string;
  /** 外面查出来的问题（比如最大输出超过了上下文窗口）。 */
  problem?: string;
}) {
  const t = useT();
  const id = useId();
  // 正在输入时保留原样（"1." 这种半截的不要被改写），离开输入框再写成规整的样子
  const [typing, setTyping] = useState<string>();
  const text = typing ?? tokenInputText(value);
  const parsed = parseTokens(text);
  const invalid = parsed !== undefined && Number.isNaN(parsed);
  const hint = invalid
    ? t("models.tokenInvalid")
    : (problem ??
      (parsed
        ? t("models.tokens", { count: fullTokens(parsed) })
        : placeholder
          ? t("models.tokenDefault", { value: placeholder })
          : ""));
  return (
    <div className="field token-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={text}
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        aria-invalid={invalid || Boolean(problem)}
        onChange={(e) => {
          setTyping(e.target.value);
          const next = parseTokens(e.target.value);
          if (next === undefined) onChange(null);
          else if (!Number.isNaN(next) && next > 0) onChange(next);
        }}
        onBlur={() => setTyping(undefined)}
      />
      <div className="token-presets">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            className={`token-preset${value === p ? " current" : ""}`}
            aria-pressed={value === p}
            onClick={() => {
              setTyping(undefined);
              onChange(p);
            }}
          >
            {shortTokens(p)}
          </button>
        ))}
      </div>
      {hint && <span className={`field-hint${invalid || problem ? " warn" : ""}`}>{hint}</span>}
    </div>
  );
}

/** 价格：输入、输出各一个，美元每百万 token；两个都空是不填。 */
export function PriceField({
  value,
  onChange,
  listed,
  note,
}: {
  value: [number, number] | null | undefined;
  onChange: (value: [number, number] | null) => void;
  /** 目录里的价格：没填时用它，写在占位里。 */
  listed?: [number, number] | null;
  note?: string;
}) {
  const t = useT();
  const [text, setText] = useState<[string, string]>(() => [
    value ? String(value[0]) : "",
    value ? String(value[1]) : "",
  ]);
  const read = (s: string) => (s.trim() === "" ? undefined : Number(s));
  const update = (next: [string, string]) => {
    setText(next);
    const [a, b] = next.map(read);
    if (a === undefined && b === undefined) onChange(null);
    else if (a !== undefined && b !== undefined && a >= 0 && b >= 0 && !Number.isNaN(a + b)) {
      onChange([a, b]);
    }
  };
  const [a, b] = text.map(read);
  const half = (a === undefined) !== (b === undefined);
  const bad = [a, b].some((n) => n !== undefined && (Number.isNaN(n) || n < 0));
  return (
    <fieldset className="price-field">
      <legend>{t("models.priceOptional")}</legend>
      <div className="price-inputs">
        {[t("models.priceInput"), t("models.priceOutput")].map((label, i) => (
          <label key={label} className="price-input">
            <span>{label}</span>
            <span className="price-box">
              <span aria-hidden="true">$</span>
              <input
                inputMode="decimal"
                value={text[i]}
                placeholder={listed ? String(listed[i]) : "0.00"}
                aria-label={t("models.priceAria", { label })}
                onChange={(e) => {
                  const next: [string, string] = [...text];
                  next[i] = e.target.value;
                  update(next);
                }}
              />
            </span>
          </label>
        ))}
        <span className="price-unit">{t("models.priceUnit")}</span>
      </div>
      <span className={`field-hint${half || bad ? " warn" : ""}`}>
        {bad
          ? t("models.priceInvalid")
          : half
            ? t("models.priceHalf")
            : (note ?? t("models.priceHint"))}
      </span>
    </fieldset>
  );
}

/**
 * 思考（只有自定义接口的模型要声明；目录里的、DeepSeek 的由目录决定）：
 * 开关"支持思考" → 选能用的档位（按协议给能选的）→ 需要时改每一档发给接口的参数值。
 */
export function ReasoningField({
  spec,
  protocol,
  onChange,
}: {
  spec: Pick<ModelSpec, "reasoningEfforts" | "compat">;
  protocol: ModelProtocol;
  onChange: (patch: Pick<ModelSpec, "reasoningEfforts" | "compat">) => void;
}) {
  const t = useT();
  const efforts = spec.reasoningEfforts ?? null;
  const adaptive = protocol === "anthropic-messages" && spec.compat?.[ADAPTIVE] === true;
  const rules = protocolRules(protocol, adaptive);
  const on = efforts !== null;
  const chosen = rules.levels.filter((l) => efforts && l in efforts);
  const [showValues, setShowValues] = useState(() => hasCustomValues(efforts));

  const setEfforts = (next: ReasoningEfforts | null) =>
    onChange({ reasoningEfforts: next, compat: spec.compat ?? null });
  const toggle = (level: ThinkingEffort) => {
    if (!efforts) return;
    const next = { ...efforts };
    if (level in next) delete next[level];
    else next[level] = defaultValue(level);
    // 档位按从低到高的顺序存
    const ordered: ReasoningEfforts = Object.fromEntries(
      rules.levels.filter((l) => l in next).map((l) => [l, next[l] ?? null]),
    );
    setEfforts(ordered);
  };
  const setAdaptive = (value: boolean) => {
    const compat = { ...(spec.compat ?? {}) };
    if (value) compat[ADAPTIVE] = true;
    else delete compat[ADAPTIVE];
    onChange({
      reasoningEfforts: fitLevels(efforts, protocol, value),
      compat: Object.keys(compat).length > 0 ? compat : null,
    });
  };
  const thinking = chosen.filter((l) => l !== "off");

  return (
    <div className="reasoning">
      <div className="reasoning-head">
        <span>
          {t("models.supportsThinking")}
          <span className="reasoning-sub">{t("models.supportsThinkingHint")}</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={t("models.supportsThinking")}
          className="switch"
          onClick={() => setEfforts(on ? null : defaultLevels(protocol, adaptive))}
        >
          <span className="switch-knob" aria-hidden="true" />
        </button>
      </div>
      {on && (
        <>
          {protocol === "anthropic-messages" && (
            <label className="reasoning-adaptive">
              <input
                type="checkbox"
                checked={adaptive}
                onChange={(e) => setAdaptive(e.target.checked)}
              />
              <span>
                {t("models.adaptive")}
                <span className="reasoning-sub">{t("models.adaptiveHint")}</span>
              </span>
            </label>
          )}
          <fieldset className="reasoning-levels">
            <legend className="visually-hidden">{t("models.levelsLegend")}</legend>
            {rules.levels.map((level) => {
              const active = chosen.includes(level);
              // 至少留一档思考
              const last = active && level !== "off" && thinking.length <= 1;
              return (
                <button
                  key={level}
                  type="button"
                  className={`reasoning-level${active ? " current" : ""}`}
                  aria-pressed={active}
                  disabled={last}
                  title={last ? t("models.keepOne") : undefined}
                  onClick={() => toggle(level)}
                >
                  {effortLabels[level]}
                  {protocol === "anthropic-messages" && !adaptive && ANTHROPIC_BUDGETS[level] && (
                    <span className="reasoning-budget">
                      {shortTokens(ANTHROPIC_BUDGETS[level] ?? 0)}
                    </span>
                  )}
                </button>
              );
            })}
          </fieldset>
          <p className="field-hint">{reasoningHint(protocol, adaptive, chosen.includes("off"))}</p>
          {rules.editableValues && (
            <div className="reasoning-values">
              <button
                type="button"
                className="disclosure"
                aria-expanded={showValues}
                onClick={() => setShowValues(!showValues)}
              >
                <span className="disclosure-chevron" aria-hidden="true">
                  <ChevronDownIcon />
                </span>
                {t("models.values")}
                {!showValues && hasCustomValues(efforts) && (
                  <span className="reasoning-sub">{t("models.modified")}</span>
                )}
              </button>
              {showValues && (
                <ul className="reasoning-rows">
                  {chosen.map((level) => (
                    <li key={level} className="reasoning-row">
                      <span className="reasoning-level-name">{effortLabels[level]}</span>
                      <input
                        aria-label={t("models.valueAria", {
                          level: effortLabels[level],
                          field: rules.field ?? "",
                        })}
                        value={efforts?.[level] ?? ""}
                        placeholder={level === "off" ? t("models.notSent") : level}
                        maxLength={40}
                        spellCheck={false}
                        onChange={(e) =>
                          setEfforts({
                            ...efforts,
                            [level]: e.target.value.trim() || defaultValue(level),
                          })
                        }
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 每种协议下，选的档位怎么发给接口（说明文字）。 */
function reasoningHint(protocol: ModelProtocol, adaptive: boolean, canOff: boolean): string {
  // 没选"关闭"时，后面再加一句"无法关闭思考"
  const withOff = (first: string) =>
    canOff ? first : t("models.twoSentences", { first, second: t("models.hintCannotOff") });
  switch (protocol) {
    case "openai-completions":
      return withOff(t("models.hintCompletions"));
    case "openai-responses":
      return withOff(t("models.hintResponses"));
    case "anthropic-messages":
      return withOff(adaptive ? t("models.hintAdaptive") : t("models.hintBudget"));
    case "google-generative-ai":
      return t("models.hintGemini");
  }
}
