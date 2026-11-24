import { type ModelProtocol, THINKING_EFFORTS, type ThinkingEffort } from "@seekcloud/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { type ApiError, api } from "../../api";
import { CloseIcon, MenuIcon, PencilIcon, PlusIcon, SearchIcon } from "../../Icons";
import { t, tRich, useT } from "../../i18n";
import { errorText } from "../../i18n/errors";
import { joinNames } from "../../i18n/format";
import { effortLabels } from "../../session/ModelPicker";
import { Modal } from "../../ui/modal";
import { toast } from "../../ui/toast";
import { PriceField, ReasoningField, TokenField } from "./ModelFields";
import { fitLevels, levelsFromKnown } from "./reasoning";
import { CONTEXT_PRESETS, costText, OUTPUT_PRESETS, pricePair, shortTokens } from "./tokens";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  KNOWN_MODELS,
  type KnownModel,
  MODEL_PROVIDERS,
  type ModelInput,
  type ModelSpec,
  type ModelSpecView,
  type ProbedModel,
  providerLabel,
  specOf,
} from "./types";

/**
 * 一个提供方的模型列表（2026-11-22 用户说模型页"糙"之后重做）：
 * - 每个模型一行，名字下面一行写清它的能力：上下文窗口、最大输出、能不能看图、思考档位、价格，模型之间的差别一眼看得出；
 * - 点一行打开这个模型的编辑弹窗；拖三横线（或者聚焦后按上下方向键）调整顺序；
 * - "添加模型"打开候选：目录里的提供方列它目录里的模型，自定义接口和 DeepSeek 可以去接口上获取，也能按名字搜 dsh 内置目录；
 *   认得出来的模型（dsh 内置目录里有的）上下文窗口、思考档位、价格都先填好，不用自己去查。
 */

/** 目录（或 DeepSeek 内置）给的资料：列表上显示，编辑时只读（目录里的提供方、DeepSeek 由目录决定）。 */
export interface Listed {
  name?: string;
  contextWindow: number | null;
  maxTokens: number | null;
  input: ModelInput[];
  efforts: ThinkingEffort[];
  cost: [number, number] | null;
}

/** 编辑中的一个模型：key 只给 React 用（ID 可能被改）。 */
export interface DraftModel extends ModelSpec {
  key: string;
  listed?: Listed;
}

/** 这个模型列表属于哪种提供方：决定候选从哪来、思考和价格能不能改。 */
export interface EditorContext {
  kind: "deepseek" | "catalog" | "custom";
  /** 提供方 ID（目录里的提供方按它搜目录）；新建的自定义接口还没有。 */
  providerId?: string;
  /** 自定义接口的协议（思考档位按它给）。 */
  protocol: ModelProtocol;
  /** 获取可用模型时发的内容；为空时不能获取（自定义接口还没填地址）。 */
  probe?: Record<string, unknown>;
  /** DeepSeek 的模型都是这几档思考（由 DeepSeek 决定），新加的模型照它显示。 */
  efforts?: ThinkingEffort[];
}

let nextKey = 0;
const newKey = () => `m${nextKey++}`;

/** 设置接口回来的一个模型 → 编辑中的。目录里的、DeepSeek 的带上目录给的资料。 */
export function draftOf(view: ModelSpecView, kind: EditorContext["kind"]): DraftModel {
  const spec = specOf(view);
  if (kind === "custom") return { ...spec, key: newKey() };
  return {
    ...spec,
    key: newKey(),
    listed: {
      contextWindow: view.contextWindow,
      maxTokens: view.maxTokens,
      input: view.input,
      efforts: view.efforts,
      cost: view.listedCost,
    },
  };
}

/** 保存时发给接口的形状：内置的、目录里的模型的思考档位由目录给（和 dsh 一样不在这里改）。 */
export function specOfDraft(draft: DraftModel, kind: EditorContext["kind"]): ModelSpec {
  const { key: _key, listed: _listed, ...spec } = draft;
  return kind === "custom" ? spec : { ...spec, reasoningEfforts: null };
}

/** 换了协议以后，自定义接口的模型按新协议调整思考档位（比如换成 Gemini 时去掉"关闭"）。 */
export function fitDrafts(models: DraftModel[], protocol: ModelProtocol): DraftModel[] {
  return models.map((m) => ({
    ...m,
    reasoningEfforts: fitLevels(
      m.reasoningEfforts,
      protocol,
      m.compat?.forceAdaptiveThinking === true,
    ),
  }));
}

/** 认得出来的模型（dsh 内置目录）→ 编辑中的。自定义接口照目录填好上下文、思考、价格；目录里的提供方由目录给。 */
function draftFromKnown(
  id: string,
  known: KnownModel | undefined,
  context: EditorContext,
  probed?: ProbedModel,
): DraftModel {
  const contextWindow = probed?.contextWindow ?? known?.contextWindow ?? null;
  const maxTokens = probed?.maxTokens ?? known?.maxTokens ?? null;
  const input: ModelInput[] = known?.input ?? ["text"];
  if (context.kind === "custom") {
    return {
      key: newKey(),
      id,
      name: probed?.name ?? known?.name ?? null,
      contextWindow,
      maxTokens,
      input,
      reasoningEfforts: known ? levelsFromKnown(known, context.protocol) : null,
      cost: known?.cost ?? null,
    };
  }
  return {
    key: newKey(),
    id,
    name: null,
    contextWindow,
    maxTokens,
    input,
    listed: {
      name: probed?.name ?? known?.name,
      contextWindow,
      maxTokens,
      input,
      efforts: known?.efforts ?? context.efforts ?? [],
      cost: known?.cost ?? null,
    },
  };
}

/** 一个模型能做什么，列表上名字下面那一行。 */
export function modelFacts(
  m: DraftModel,
  kind: EditorContext["kind"],
): Array<{ text: string; warn?: boolean }> {
  const facts: Array<{ text: string; warn?: boolean }> = [];
  const context = m.contextWindow ?? m.listed?.contextWindow;
  facts.push(
    context
      ? { text: t("models.factContext", { size: shortTokens(context) }) }
      : { text: t("models.factNoContext"), warn: true },
  );
  const output = m.maxTokens ?? m.listed?.maxTokens;
  if (output) facts.push({ text: t("models.factOutput", { size: shortTokens(output) }) });
  if (m.input.includes("image")) facts.push({ text: t("models.factImage") });
  const levels =
    kind === "custom"
      ? // 按从低到高排（库里存的 JSON 不保证键的顺序）
        THINKING_EFFORTS.filter((l) => l in (m.reasoningEfforts ?? {}))
      : (m.listed?.efforts ?? []);
  const thinking = levels.filter((l) => l !== "off");
  if (thinking.length === 0) facts.push({ text: t("models.factNoThinking") });
  else {
    const range =
      thinking.length === 1
        ? effortLabels[thinking[0] as ThinkingEffort]
        : `${effortLabels[thinking[0] as ThinkingEffort]}–${effortLabels[thinking.at(-1) as ThinkingEffort]}`;
    facts.push({
      text: levels.includes("off")
        ? t("models.factThinking", { range })
        : t("models.factThinkingForced", { range }),
    });
  }
  const cost = m.cost ?? m.listed?.cost;
  if (cost) facts.push({ text: pricePair(cost).join(" / ") });
  return facts;
}

/** 模型多的时候（目录里的提供方动辄几十上百个）显示搜索框。 */
const SEARCH_FROM = 8;

export function ModelEditor({
  models,
  onChange,
  context,
}: {
  models: DraftModel[];
  onChange: (models: DraftModel[]) => void;
  context: EditorContext;
}) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{
    draft: DraftModel;
    isNew: boolean;
    known?: KnownModel;
  }>();
  // 关的时候编辑弹窗还要画着刚才那个模型，播完收起的动画
  const lastEditing = useRef(editing);
  if (editing) lastEditing.current = editing;
  const shownEditing = editing ?? lastEditing.current;
  const [query, setQuery] = useState("");
  const list = useRef<HTMLUListElement>(null);
  const dragging = useRef<{ key: string; pointer: number } | undefined>(undefined);
  const filtering = query.trim() !== "";
  const shown = filtering
    ? models.filter((m) =>
        `${m.id} ${m.name ?? ""} ${m.listed?.name ?? ""}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
    : models;

  const move = (key: string, to: number) => {
    const from = models.findIndex((m) => m.key === key);
    if (from < 0 || to < 0 || to >= models.length || from === to) return;
    const next = [...models];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item as DraftModel);
    onChange(next);
  };
  const apply = (draft: DraftModel) => {
    const exists = models.some((m) => m.key === draft.key);
    onChange(exists ? models.map((m) => (m.key === draft.key ? draft : m)) : [...models, draft]);
  };

  return (
    <div className="model-editor">
      {models.length > SEARCH_FROM && (
        <span className="probe-search">
          <SearchIcon />
          <input
            aria-label={t("models.searchList")}
            placeholder={t("models.searchListPlaceholder", { count: models.length })}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </span>
      )}
      {shown.length > 0 && (
        <ul className="model-rows" ref={list}>
          {shown.map((m) => {
            const index = models.indexOf(m);
            return (
              <li key={m.key} className="model-row" data-key={m.key}>
                {!filtering && (
                  <button
                    type="button"
                    className="model-row-handle"
                    aria-label={t("models.reorder", { id: m.id })}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                        e.preventDefault();
                        move(m.key, index + (e.key === "ArrowUp" ? -1 : 1));
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
                )}
                <button
                  type="button"
                  className="model-row-main"
                  onClick={() => setEditing({ draft: m, isNew: false })}
                >
                  <span className="model-row-title">
                    <span className="model-row-name">{m.name || m.listed?.name || m.id}</span>
                    {(m.name || m.listed?.name) && <span className="model-row-id">{m.id}</span>}
                  </span>
                  <span className="model-facts">
                    {modelFacts(m, context.kind).map((f) => (
                      <span key={f.text} className={f.warn ? "warn" : undefined}>
                        {f.text}
                      </span>
                    ))}
                  </span>
                </button>
                <span className="model-row-edit" aria-hidden="true">
                  <PencilIcon />
                </span>
                <button
                  type="button"
                  className="icon-button small"
                  aria-label={t("models.remove", { id: m.id })}
                  onClick={() => onChange(models.filter((x) => x.key !== m.key))}
                >
                  <CloseIcon size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {models.length === 0 && <p className="settings-hint model-empty">{t("models.empty")}</p>}
      {filtering && shown.length === 0 && models.length > 0 && (
        <p className="settings-hint model-empty">{t("models.noMatch")}</p>
      )}
      <button type="button" className="add-model-button" onClick={() => setAdding(true)}>
        <PlusIcon size={14} /> {t("models.addModel")}
      </button>

      <AddModels
        open={adding}
        context={context}
        models={models}
        onClose={() => setAdding(false)}
        onAdd={(draft) => onChange([...models, draft])}
        onRemove={(id) => onChange(models.filter((m) => m.id !== id))}
        onCustom={(id, known) =>
          setEditing({
            draft: draftFromKnown(id, known, context),
            isNew: true,
            known,
          })
        }
      />
      <ModelDialog
        key={shownEditing?.draft.key}
        open={editing !== undefined}
        initial={shownEditing?.draft}
        isNew={shownEditing?.isNew ?? false}
        known={shownEditing?.known}
        context={context}
        takenIds={models.filter((m) => m.key !== shownEditing?.draft.key).map((m) => m.id)}
        onClose={() => setEditing(undefined)}
        onApply={(draft) => {
          apply(draft);
          setEditing(undefined);
          if (editing?.isNew) {
            toast(t("models.added", { name: draft.name || draft.listed?.name || draft.id }));
          }
        }}
      />
    </div>
  );
}

/**
 * 添加模型（弹窗）：
 * - 目录里的提供方：列出它目录里的全部模型，点一下加进列表、再点一下移出；
 * - 自定义接口、DeepSeek：可以去接口上获取列出的模型（认得出来的带着资料），也一样点一下加入；
 * - 自定义接口还能按名字搜 dsh 内置目录（网关上的 ID 可能和目录不一样，所以选了先打开编辑弹窗核对）；
 * - 搜索框里的文字不在候选里时，可以直接用它作为模型 ID 添加。
 */
function AddModels({
  open,
  context,
  models,
  onClose,
  onAdd,
  onRemove,
  onCustom,
}: {
  open: boolean;
  context: EditorContext;
  models: DraftModel[];
  onClose: () => void;
  onAdd: (draft: DraftModel) => void;
  onRemove: (id: string) => void;
  onCustom: (id: string, known?: KnownModel) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<KnownModel[]>();
  const [probed, setProbed] = useState<ProbedModel[]>();
  const [probing, setProbing] = useState(false);
  const [found, setFound] = useState<KnownModel[]>([]);
  const q = query.trim();
  const has = (id: string) => models.some((m) => m.id === id);

  // 目录里的提供方：打开时取一次它目录里的全部模型
  useEffect(() => {
    if (!open || context.kind !== "catalog" || catalog || !context.providerId) return;
    api<{ models: KnownModel[] }>(
      `${KNOWN_MODELS}?provider=${encodeURIComponent(context.providerId)}&limit=500`,
    ).then(
      (res) => setCatalog(res.models),
      (e) => toast(errorText(e as ApiError), "error"),
    );
  }, [open, context.kind, context.providerId, catalog]);

  // 自定义接口：按输入的文字搜 dsh 内置目录（停下 200 毫秒再搜）
  useEffect(() => {
    if (!open || context.kind !== "custom" || !q) {
      setFound([]);
      return;
    }
    const timer = setTimeout(() => {
      api<{ models: KnownModel[] }>(`${KNOWN_MODELS}?q=${encodeURIComponent(q)}&limit=12`).then(
        (res) => setFound(res.models),
        () => setFound([]),
      );
    }, 200);
    return () => clearTimeout(timer);
  }, [open, context.kind, q]);

  // 关了再打开时从头来（搜索词清空；获取到的列表留着，免得再问一次接口）
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const probe = async () => {
    if (!context.probe) return;
    setProbing(true);
    try {
      const res = await api<{ models: ProbedModel[] }>(`${MODEL_PROVIDERS}/probe`, context.probe);
      setProbed(res.models);
      if (res.models.length === 0) toast(t("models.probeEmpty"), "info");
    } catch (e) {
      toast(errorText(e as ApiError), "error");
    } finally {
      setProbing(false);
    }
  };

  const match = (id: string, name?: string) =>
    !q || `${id} ${name ?? ""}`.toLowerCase().includes(q.toLowerCase());
  const catalogShown = (catalog ?? []).filter((m) => match(m.id, m.name));
  const probedShown = (probed ?? []).filter((m) => match(m.id, m.name ?? m.known?.name));
  const exact =
    catalogShown.some((m) => m.id === q) || probedShown.some((m) => m.id === q) || has(q);
  // 模型 ID 里没有空格：带空格的是在搜名字，不提供"以它为 ID 添加"
  const offerId = q !== "" && !exact && !/\s/.test(q);

  const toggle = (id: string, make: () => DraftModel) => {
    if (has(id)) onRemove(id);
    else onAdd(make());
  };

  const canProbe = context.kind !== "catalog";
  return (
    <Modal
      open={open}
      wide
      title={t("models.addModel")}
      subtitle={
        context.kind === "catalog" ? t("models.addSubtitleCatalog") : t("models.addSubtitle")
      }
      onClose={onClose}
    >
      <div className="add-models">
        <div className="add-models-search">
          <span className="probe-search">
            <SearchIcon />
            <input
              aria-label={t("models.searchOrId")}
              placeholder={
                context.kind === "catalog"
                  ? t("models.searchModels")
                  : t("models.searchOrIdPlaceholder")
              }
              value={query}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (offerId)
                    onCustom(
                      q,
                      found.find((k) => sameModel(k.id, q)),
                    );
                }
              }}
            />
          </span>
          {canProbe && (
            <button
              type="button"
              className="pill-button"
              disabled={!context.probe || probing}
              title={context.probe ? undefined : t("models.needBaseUrl")}
              onClick={() => void probe()}
            >
              {probing ? t("models.probing") : probed ? t("models.reprobe") : t("models.probe")}
            </button>
          )}
        </div>

        {offerId && (
          <button
            type="button"
            className="candidate custom-id"
            onClick={() =>
              onCustom(
                q,
                found.find((k) => sameModel(k.id, q)),
              )
            }
          >
            <PlusIcon size={14} />
            <span>{tRich("models.addById", { id: <code>{q}</code> })}</span>
          </button>
        )}

        {context.kind === "catalog" && (
          <CandidateList
            title={
              catalog
                ? t("models.catalogModels", { count: catalogShown.length })
                : t("models.readingCatalog")
            }
            items={catalogShown.map((k) => ({
              id: k.id,
              name: k.name,
              facts: knownFacts(k),
              chosen: has(k.id),
              onClick: () => toggle(k.id, () => draftFromKnown(k.id, k, context)),
            }))}
          />
        )}
        {probed && (probedShown.length > 0 || !q) && (
          <CandidateList
            title={t("models.probedModels", { count: probedShown.length })}
            items={probedShown.map((p) => ({
              id: p.id,
              name: p.name ?? p.known?.name,
              facts: p.known
                ? knownFacts(p.known, p)
                : p.contextWindow
                  ? [{ text: t("models.factContext", { size: shortTokens(p.contextWindow) }) }]
                  : [{ text: t("models.unknownSpecs"), warn: true }],
              chosen: has(p.id),
              onClick: () => toggle(p.id, () => draftFromKnown(p.id, p.known, context, p)),
            }))}
          />
        )}
        {context.kind === "custom" && found.length > 0 && (
          <CandidateList
            title={t("models.dshCatalog")}
            note={t("models.dshCatalogNote")}
            items={found.map((k) => ({
              id: k.id,
              name: k.name,
              facts: [...knownFacts(k), { text: providerLabel(k.provider, k.providerName) }],
              chosen: has(k.id),
              onClick: () => (has(k.id) ? onRemove(k.id) : onCustom(k.id, k)),
            }))}
          />
        )}
        {context.kind !== "catalog" && !probed && !q && (
          <p className="settings-hint">
            {context.probe ? t("models.probeHint") : t("models.probeHintNoUrl")}
          </p>
        )}
      </div>
      <div className="settings-form-actions">
        <button type="button" className="primary" onClick={onClose}>
          {t("models.done")}
        </button>
      </div>
    </Modal>
  );
}

/** 两个模型 ID 是不是同一个（大小写、点和连字符、路径前缀不计）。和主站的 normalizeModelId 一样。 */
function sameModel(a: string, b: string): boolean {
  const norm = (id: string) =>
    id
      .trim()
      .toLowerCase()
      .replace(/^.*\//, "")
      .replace(/:.*$/, "")
      .replace(/[._\s]+/g, "-");
  return norm(a) === norm(b);
}

/** 认得出来的模型的资料，候选列表上写在名字下面。 */
function knownFacts(k: KnownModel, probed?: ProbedModel): Array<{ text: string; warn?: boolean }> {
  const facts: Array<{ text: string; warn?: boolean }> = [];
  const context = probed?.contextWindow ?? k.contextWindow;
  if (context) facts.push({ text: t("models.factContext", { size: shortTokens(context) }) });
  if (k.input.includes("image")) facts.push({ text: t("models.factImage") });
  const thinking = k.efforts.filter((l) => l !== "off");
  facts.push({
    text:
      thinking.length === 0
        ? t("models.factNoThinking")
        : k.efforts.includes("off")
          ? t("models.factThinks")
          : t("models.factThinksForced"),
  });
  if (k.cost) facts.push({ text: costText(k.cost) });
  return facts;
}

interface Candidate {
  id: string;
  name?: string;
  facts: Array<{ text: string; warn?: boolean }>;
  chosen: boolean;
  onClick: () => void;
}

function CandidateList({
  title,
  note,
  items,
}: {
  title: string;
  note?: string;
  items: Candidate[];
}) {
  return (
    <section className="candidates">
      <h3>
        {title}
        {note && <span className="candidates-note">{note}</span>}
      </h3>
      {items.length > 0 && (
        <ul>
          {items.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={`candidate${c.chosen ? " chosen" : ""}`}
                aria-pressed={c.chosen}
                onClick={c.onClick}
              >
                <span className="candidate-check" aria-hidden="true" />
                <span className="candidate-text">
                  <span className="model-row-title">
                    <span className="model-row-name">{c.name ?? c.id}</span>
                    {c.name && c.name !== c.id && <span className="model-row-id">{c.id}</span>}
                  </span>
                  <span className="model-facts">
                    {c.facts.map((f) => (
                      <span key={f.text} className={f.warn ? "warn" : undefined}>
                        {f.text}
                      </span>
                    ))}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * 一个模型的编辑弹窗（叠在模型列表的弹窗上）：ID 和名称、上下文窗口、最大输出、能不能看图，
 * 自定义接口还有思考档位和价格；目录里的提供方、DeepSeek 的思考档位和价格由目录决定，这里只显示。
 * "确定"只改列表，外面的"保存"才存到主站。
 */
function ModelDialog({
  open,
  initial,
  isNew,
  known,
  context,
  takenIds,
  onClose,
  onApply,
}: {
  open: boolean;
  initial: DraftModel | undefined;
  isNew: boolean;
  known?: KnownModel;
  context: EditorContext;
  takenIds: string[];
  onClose: () => void;
  onApply: (draft: DraftModel) => void;
}) {
  const t = useT();
  const [m, setDraft] = useState<DraftModel | undefined>(initial);
  const custom = context.kind === "custom";
  const listed = m?.listed;
  const problems = useMemo(() => {
    if (!m) return {};
    const id = m.id.trim();
    const contextWindow = m.contextWindow ?? listed?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const output = m.maxTokens ?? listed?.maxTokens;
    return {
      id: !id ? t("models.idRequired") : takenIds.includes(id) ? t("models.idTaken") : undefined,
      output: output && output > contextWindow ? t("models.outputTooLarge") : undefined,
    };
  }, [m, listed, takenIds, t]);
  if (!m) return null;
  const set = (patch: Partial<DraftModel>) => setDraft({ ...m, ...patch });
  const ok = !problems.id && !problems.output;
  const title = isNew ? t("models.addModel") : m.name || listed?.name || m.id;

  return (
    <Modal open={open} wide title={title} subtitle={isNew ? undefined : m.id} onClose={onClose}>
      <form
        className="settings-form model-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onApply({ ...m, id: m.id.trim(), name: m.name?.trim() || null });
        }}
      >
        {custom && known && (
          <p className="model-known">
            {known.cost
              ? t("models.knownFilledPrice", {
                  provider: providerLabel(known.provider, known.providerName),
                })
              : t("models.knownFilled", {
                  provider: providerLabel(known.provider, known.providerName),
                })}
          </p>
        )}
        <label className="field">
          <span>{t("models.modelId")}</span>
          <input
            value={m.id}
            maxLength={200}
            spellCheck={false}
            autoComplete="off"
            readOnly={!custom && !isNew}
            aria-invalid={Boolean(problems.id)}
            onChange={(e) => set({ id: e.target.value })}
          />
          {problems.id ? (
            <span className="field-hint warn">{problems.id}</span>
          ) : custom ? (
            <span className="field-hint">{t("models.modelIdHint")}</span>
          ) : null}
        </label>
        <label className="field">
          <span>{t("models.displayName")}</span>
          <input
            value={m.name ?? ""}
            maxLength={100}
            placeholder={listed?.name || m.id || t("models.nameFallback")}
            onChange={(e) => set({ name: e.target.value || null })}
          />
        </label>
        <div className="model-options-pair">
          <TokenField
            label={t("models.contextWindow")}
            value={m.contextWindow}
            presets={CONTEXT_PRESETS}
            placeholder={shortTokens(listed?.contextWindow ?? DEFAULT_CONTEXT_WINDOW)}
            problem={custom && !m.contextWindow ? t("models.contextDefault") : undefined}
            onChange={(contextWindow) => set({ contextWindow })}
          />
          <TokenField
            label={t("models.maxOutput")}
            value={m.maxTokens}
            presets={OUTPUT_PRESETS}
            placeholder={shortTokens(listed?.maxTokens ?? DEFAULT_MAX_TOKENS)}
            problem={problems.output}
            onChange={(maxTokens) => set({ maxTokens })}
          />
        </div>
        <div className="reasoning-head">
          <span>
            {t("models.images")}
            <span className="reasoning-sub">{t("models.imagesHint")}</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={m.input.includes("image")}
            aria-label={t("models.images")}
            className="switch"
            onClick={() => set({ input: m.input.includes("image") ? ["text"] : ["text", "image"] })}
          >
            <span className="switch-knob" aria-hidden="true" />
          </button>
        </div>
        {custom ? (
          <>
            <ReasoningField spec={m} protocol={context.protocol} onChange={(patch) => set(patch)} />
            <PriceField
              value={m.cost}
              onChange={(cost) => set({ cost })}
              note={known?.cost ? t("models.officialPriceNote") : undefined}
            />
          </>
        ) : (
          <dl className="model-listed">
            <dt>{t("models.levels")}</dt>
            <dd>
              {(listed?.efforts ?? []).filter((l) => l !== "off").length === 0
                ? t("models.factNoThinking")
                : joinNames((listed?.efforts ?? []).map((l) => effortLabels[l]))}
            </dd>
            <dt>{t("models.price")}</dt>
            <dd>
              {listed?.cost
                ? t("models.priceWithUnit", { cost: costText(listed.cost) })
                : t("models.noCatalogPrice")}
            </dd>
            <dd className="model-listed-note">
              {context.kind === "deepseek" ? t("models.fixedDeepseek") : t("models.fixedCatalog")}
            </dd>
          </dl>
        )}
        <div className="settings-form-actions">
          <button type="button" className="secondary" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="primary" disabled={!ok}>
            {isNew ? t("models.add") : t("common.ok")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
