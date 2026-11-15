import type { MessagePin, ModelProgress, ThinkingEffort, TodoItem } from "@seekcloud/protocol";
import {
  createContext,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type ApiError, api } from "../api";
import { CopyButton, useCopy } from "../copy";
import { useDraft } from "../draft";
import {
  ArrowDownIcon,
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  DoubleCheckIcon,
  PinIcon,
  RetryIcon,
  UndoIcon,
} from "../Icons";
import { BlurText, Collapse, usePresence } from "../Motion";
import { Whale } from "../Whale";
import { catchUpBubble } from "./bubble-in";
import { Composer } from "./Composer";
import { firstMessageOf } from "./first-message";
import { contentKey, ScrollFollower } from "./follow-scroll";
import { LiveMarkdown, SessionLinks } from "./Markdown";
import { effortLabels, ModelPicker } from "./ModelPicker";
import { usePacedText } from "./paced-text";
import { fullTime, relativeTime } from "./relative-time";
import { SessionHeader } from "./SessionHeader";
import {
  buildTimeline,
  summarizeTools,
  type TimelineItem,
  type ToolCall,
  toolLabel,
  toolSummary,
} from "./timeline";
import type { Session } from "./types";
import { useModels } from "./useModels";
import { usePins } from "./usePins";
import { useSessionEvents } from "./useSessionEvents";

// 空闲时提示可以用命令；Agent 在工作时照样能发，发出去先排队。
const placeholders = {
  queued: "排队一条消息",
  running: "排队一条消息",
  waiting: "输入 / 使用命令",
  dormant: "输入 / 使用命令",
  archived: "会话已归档",
  failed: "会话出错，发送消息即可重试",
} as const;

/** 会话页：消息、思考、工具调用、待办清单，底下是输入框。 */
export function SessionPage({
  id,
  listed,
  onMenu,
}: {
  id: string;
  listed?: Session;
  /** 手机上打开侧栏。 */
  onMenu: () => void;
}) {
  const [fetched, setFetched] = useState<Session>();
  const [missing, setMissing] = useState(false);
  const session = listed ?? fetched;
  const { events, broken, liveAfter, progress, draft, adopted } = useSessionEvents(id);
  const timeline = useMemo(() => buildTimeline(events), [events]);
  const state = timeline.state ?? session;
  const status = state?.status;
  // 没发出去的字记在浏览器里，换个会话再回来、刷新页面都还在。
  const [reply, setReply] = useDraft(id);
  // 刚发出去、服务器还没回推的消息：先显示出来，不让人等一个来回。
  // after：发的时候已经有几条用户消息和排队消息，服务器回推一条（开始回合或者排队）就换成正式的。
  // 首页发起会话时的第一条消息也是这样（first-message.ts）。
  const [pending, setPending] = useState<{ text: string; after: number; at: string } | undefined>(
    () => {
      const first = firstMessageOf(id);
      return first && { ...first, after: 0 };
    },
  );
  const sentCount = useMemo(
    () => events.filter((e) => e.type === "user.message" || e.type === "message.queued").length,
    [events],
  );
  const showPending = pending !== undefined && sentCount <= pending.after;
  // 选的模型和思考强度，没动过就跟着会话走；发消息时一起带上，从下一个回合起生效。
  const [choice, setChoice] = useState<{ model: string; effort: ThinkingEffort }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // 置顶的消息（照 Claude）：回复下面的图钉，上方的短标题，左上角的置顶列表
  const { pins, toggle: togglePin } = usePins(id, setError);
  const models = useModels();
  const scroller = useRef<HTMLDivElement>(null);

  // 会话列表里还没有（比如很久以前的会话）时，单独取一次。
  useEffect(() => {
    if (listed) return;
    api<Session>(`/api/sessions/${id}`).then(setFetched, (e: ApiError) => {
      if (e.code === "session_not_found") setMissing(true);
    });
  }, [id, listed]);

  useEffect(() => {
    if (session) document.title = `${session.title} · SeekCloud`;
    return () => {
      document.title = "SeekCloud";
    };
  }, [session]);

  const follow = useFollowScroll(
    scroller,
    id,
    contentKey(timeline, showPending ? `pending:${pending.text}` : ""),
  );

  // 消息下面的"刚刚""5 分钟前"：每半分钟刷新一次。
  const now = useNow(30_000);

  /** 发一条消息。fromComposer：从输入框发的，发出去清空输入框，没发出去把字还回去；重试不动输入框。 */
  const send = async (text: string, fromComposer: boolean) => {
    setBusy(true);
    setError(undefined);
    setPending({ text, after: sentCount, at: new Date().toISOString() });
    if (fromComposer) setReply("");
    follow.toBottom();
    try {
      await api(`/api/sessions/${id}/messages`, { text, ...choice });
      setChoice(undefined);
    } catch (e) {
      // 没发出去：气泡收回，字还给输入框。
      setPending(undefined);
      if (fromComposer) setReply(text);
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  if (missing || (broken && !session)) {
    return (
      <div className="session-page">
        <div className="session-missing">
          <h1>未找到该会话</h1>
          <p>该会话可能已被删除，或链接有误。</p>
        </div>
      </div>
    );
  }

  const repo = session?.repos[0];
  // 只有归档的会话不能发消息；失败的会话发消息就重新准备沙箱（2026-11-15 用户定的）
  const closed = status === "archived";
  // Agent 在工作（或者排队等位置）时重试是灰的；会话关了也不能重试。
  const canRetry = !busy && !closed && status !== "running" && status !== "queued";
  const nameOf = (model: string) => models?.models.find((m) => m.id === model)?.name ?? model;
  const picked = choice ?? (session && { model: session.model, effort: session.effort });
  const working = status === "running" || status === "queued";

  return (
    <div className="session-page">
      <SessionHeader id={id} session={session} onMenu={onMenu} />
      {pins.length > 0 && <PinNav pins={pins} scroller={scroller} />}

      <div className="timeline" ref={scroller} {...follow.handlers}>
        <SessionLinks.Provider
          value={{ repo: repo?.fullName, pullRequest: repo?.pullRequest ?? undefined }}
        >
          <GrowContext.Provider value={follow.grew}>
            <div className="timeline-inner">
              {/* 宿主机推来的增量先画成一条临时回复，放在同一个列表里：完整的消息到了用同一个 key 接过去 */}
              {[
                ...timeline.items,
                ...(draft?.text
                  ? [
                      {
                        kind: "assistant" as const,
                        key: draft.key,
                        text: draft.text,
                        thinking: draft.thinking || undefined,
                      },
                    ]
                  : []),
              ].map((item) => (
                <TimelineEntry
                  key={adopted.get(item.key) ?? item.key}
                  item={item}
                  nameOf={nameOf}
                  live={item.key < 0 || item.key > liveAfter}
                  // 服务器回推的正是刚才先显示的那条：不从头再播出现的动画，免得闪一下；刚才没播完的接着播，✓✓ 淡入。
                  pendingAt={
                    item.kind === "user" && item.text === pending?.text ? pending.at : undefined
                  }
                  now={now}
                  pin={pins.find((p) => p.seq === item.key)}
                  onPin={
                    item.kind === "assistant" && item.turnEnd
                      ? (pinned) => void togglePin(item.key, pinned)
                      : undefined
                  }
                  onRetry={canRetry ? (text) => void send(text, false) : undefined}
                />
              ))}
              {timeline.queued.map((item, index) => (
                <QueuedMessage
                  key={item.id}
                  first={index === 0}
                  sessionId={id}
                  id={item.id}
                  text={item.text}
                  pendingAt={item.text === pending?.text ? pending.at : undefined}
                  onRestore={(text) =>
                    setReply((current) => (current ? `${text}\n${current}` : text))
                  }
                  onError={setError}
                />
              ))}
              {showPending && (
                <SentMessage
                  text={pending.text}
                  at={pending.at}
                  motion="bubble-in"
                  now={now}
                  sending
                />
              )}
              {/* 计划：回合进行中始终在对话最下面，回合结束或停止以后就不显示（照 Claude） */}
              {working && timeline.plan && (
                <TodoCard items={timeline.plan.items} stale={timeline.plan.stale} />
              )}
              {/* 对话最后一行：鲸鱼（照 Claude 的星形标志）。Agent 在工作时它游动、旁边写在做什么；
                停下来以后不动，最后一条回复下面提示一句 */}
              {status === "queued" ? (
                <Working text="排队中，等待空闲资源" since={timeline.since} />
              ) : status === "running" ? (
                <Working
                  text={
                    state?.detail === "preparing_sandbox"
                      ? "正在准备沙箱"
                      : (timeline.activity ?? "深度求索中")
                  }
                  since={timeline.since}
                  // 有工具在跑时写它在做什么（不加省略号），不显示 token 数（timeline.ts 的 activity）
                  ellipsis={
                    timeline.activity === undefined || state?.detail === "preparing_sandbox"
                  }
                  progress={timeline.activity === undefined ? progress : undefined}
                />
              ) : (
                <p className="timeline-tail">
                  <Whale size={WHALE_SIZE} transitionName="seekcloud-whale" />
                  {timeline.items.some((item) => item.kind === "assistant") && (
                    <span className="ai-notice">DeepSeek 是 AI 并且可能会犯错。</span>
                  )}
                </p>
              )}
            </div>
          </GrowContext.Provider>
        </SessionLinks.Provider>
      </div>

      <footer className="session-footer">
        <ToBottom away={follow.away} working={working} onClick={follow.toBottom} />
        <div className="session-footer-inner">
          {status === "archived" && <ArchivedNote id={id} onError={setError} />}
          {broken && (
            <p className="alert" role="alert">
              与服务器的连接已断开，请刷新页面。
            </p>
          )}
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
          <Composer
            value={reply}
            onChange={setReply}
            onSubmit={() => void send(reply, true)}
            placeholder={placeholders[status ?? "queued"]}
            disabled={closed}
            busy={busy}
            submitLabel="发送"
          />
          {/* 输入框下面一行：模型和思考强度（以后还有权限模式） */}
          {models && picked && (
            <div className="composer-below">
              <ModelPicker
                models={models.models}
                model={picked.model}
                effort={picked.effort}
                defaultEffort={models.defaultEffort}
                onChange={(model, effort) => setChoice({ model, effort })}
              />
            </div>
          )}
        </div>
      </footer>
    </div>
  );
}

/** 已归档的会话：输入框上面一行说明，可以直接取消归档（之后发消息就唤醒）。 */
function ArchivedNote({ id, onError }: { id: string; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const unarchive = async () => {
    setBusy(true);
    try {
      await api(`/api/sessions/${id}/unarchive`, {});
    } catch (e) {
      onError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <p className="archived-note">
      会话已归档，无法发送消息。
      <button
        type="button"
        className="pill-button"
        disabled={busy}
        onClick={() => void unarchive()}
      >
        取消归档
      </button>
    </p>
  );
}

/**
 * 排队的消息：像已经发出去一样显示在对话末尾，下面一行操作：
 * 复制、撤回并放回输入框、删除、立即发送（Agent 在当前回合的下一步读到）。
 */
function QueuedMessage({
  sessionId,
  id,
  first,
  text,
  pendingAt,
  onRestore,
  onError,
}: {
  sessionId: string;
  id: string;
  /** 排在最前面的一条：只有它有"立即发送"，后面的只写"排队中"（照 Claude，多条排队时不每条都放一个按钮）。 */
  first: boolean;
  text: string;
  pendingAt?: string;
  onRestore: (text: string) => void;
  onError: (message: string) => void;
}) {
  // 正在提交的操作：网络慢、还没回来时，点的那个按钮换成转圈（照 Claude）
  const [doing, setDoing] = useState<"restore" | "delete" | "send-now">();
  const busy = doing !== undefined;
  const [copied, copy] = useCopy(text);
  const catchUp = useCatchUp(pendingAt);

  const act = async (action: "withdraw" | "send-now", restore = false) => {
    setDoing(action === "send-now" ? "send-now" : restore ? "restore" : "delete");
    try {
      const result = await api<{ text?: string }>(
        `/api/sessions/${sessionId}/queue/${id}/${action}`,
        {},
      );
      if (restore && result.text) onRestore(result.text);
    } catch (e) {
      onError((e as ApiError).message);
      setDoing(undefined);
    }
  };
  const spinner = <span className="spinner small" aria-hidden="true" />;

  return (
    <div
      className={`queued${pendingAt === undefined ? " fresh" : ""}${catchUp ? ` ${catchUp.className}` : ""}${busy ? " busy" : ""}`}
      style={catchUp?.style}
    >
      <div className="user-message">{text}</div>
      <div className="queued-actions">
        {!first && <span className="queued-label">排队中</span>}
        <CopyButton copied={copied} onCopy={copy} />
        <button
          type="button"
          className="icon-button small"
          aria-label="撤回并编辑"
          data-tip="撤回并编辑"
          disabled={busy}
          onClick={() => void act("withdraw", true)}
        >
          {doing === "restore" ? spinner : <UndoIcon />}
        </button>
        <button
          type="button"
          className="icon-button small"
          aria-label="删除"
          data-tip="删除"
          disabled={busy}
          onClick={() => void act("withdraw")}
        >
          {doing === "delete" ? spinner : <CloseIcon />}
        </button>
        {first && (
          <button
            type="button"
            className="send-now"
            aria-busy={doing === "send-now"}
            disabled={busy}
            onClick={() => void act("send-now")}
          >
            {doing === "send-now" ? spinner : "立即发送"}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 换上来的气泡接着播出现的动画（bubble-in.ts）。只在换上来的那一刻算一次，之后重新渲染也不变：
 * 延迟一改，正在播的动画会跳。
 */
function useCatchUp(pendingAt: string | undefined) {
  const [catchUp] = useState(() =>
    pendingAt === undefined ? undefined : catchUpBubble(pendingAt, Date.now()),
  );
  return catchUp;
}

/** 打开会话后这么久之内，卡片量出高度、内容长高了也贴着底部。 */
const SETTLE_OPEN_MS = 800;

/**
 * 会话页的滚动跟随（规则在 follow-scroll.ts）。key 是"有没有新内容"的指纹，变了才跟着往下滚；
 * sessionId 换了就是重新打开，停在最底下。
 */
function useFollowScroll(ref: RefObject<HTMLDivElement | null>, sessionId: string, key: string) {
  const [away, setAway] = useState(false);
  const follower = useRef<ScrollFollower>(undefined);
  const touchY = useRef<number>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 换了会话就是重新打开，重新贴底
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const f = new ScrollFollower(el, setAway);
    follower.current = f;
    setAway(false);
    f.toBottom();
    // 卡片的高度要挂上以后才量得出来，所以刚打开的一小段时间里，内容长高了也贴着底部。
    const inner = el.firstElementChild;
    const observer = new ResizeObserver(() => f.contentAdded());
    if (inner) observer.observe(inner);
    const timer = setTimeout(() => observer.disconnect(), SETTLE_OPEN_MS);
    // 有的浏览器在输入法弹出时让整个页面变矮：滚动区域跟着变矮而 scrollTop 不变，最后几行就被输入框盖住了。
    // 在回调里直接贴底：回调在画出来之前，不会先露出来再跳，也就用不着平滑滚动。
    const box = new ResizeObserver(() => f.resized());
    box.observe(el);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      box.disconnect();
    };
  }, [ref, sessionId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在有新内容时跟随
  useLayoutEffect(() => {
    follower.current?.contentAdded();
  }, [key]);

  // 回复一个个字显示出来时页面在长高，贴着底部的话跟着往下（paced-text.ts）
  const grew = useCallback(() => follower.current?.contentAdded(), []);

  return {
    away,
    grew,
    toBottom: () => follower.current?.toBottom(),
    handlers: {
      onScroll: () => follower.current?.scrolled(),
      onWheel: (e: ReactWheelEvent) => follower.current?.wheeled(e.deltaY),
      onTouchStart: (e: ReactTouchEvent) => {
        touchY.current = e.touches[0]?.clientY;
      },
      onTouchMove: (e: ReactTouchEvent) => {
        const y = e.touches[0]?.clientY;
        if (y === undefined || touchY.current === undefined) return;
        follower.current?.dragged(y - touchY.current);
        touchY.current = y;
      },
    },
  };
}

/** 往上翻时，底部中间浮出的圆形按钮：Agent 在工作时是跳动的点，否则是向下的箭头，点了回到底部。 */
function ToBottom({
  away,
  working,
  onClick,
}: {
  away: boolean;
  working: boolean;
  onClick: () => void;
}) {
  const { mounted, closing } = usePresence(away, 180);
  if (!mounted) return null;
  return (
    <button
      type="button"
      className={`to-bottom${closing ? " closing" : ""}`}
      aria-label="回到底部"
      onClick={onClick}
    >
      {working ? (
        <span className="bounce-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      ) : (
        <ArrowDownIcon />
      )}
    </button>
  );
}

/** 每隔一段时间换一次的当前时间。 */
function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * 发出去的消息：下面一行是 ✓✓、时间、复制、重试。
 * ✓✓ 在消息交给 Agent 时出现（回合开始或立即发送；排队中、准备沙箱时不显示），提示"DeepSeek 已读取"。
 * 重试就是把这句话再发一次；Agent 在工作时是灰的（onRetry 为空）。
 * 提示用 data-tip（样式见 styles.css 的 [data-tip]）。✓✓ 和时间是只用来看提示的按钮（meta-info），手机上点一下也能看到。
 * motion：fresh 是时间线统一的轻轻浮上来；bubble-in 是刚发的消息从输入框的方向进来（和下面那一行一起）；
 * delivered 是服务器回推了刚才先显示的那条；pendingAt 是那条的发送时间，出现的动画没播完就接着播。
 * sending：刚发出去、服务器还没确认，没有 ✓✓，不能重试。
 */
function SentMessage({
  text,
  at,
  motion = "",
  pendingAt,
  now,
  sending = false,
  delivered = false,
  onRetry,
}: {
  text: string;
  at: string;
  motion?: "fresh" | "bubble-in" | "delivered" | "";
  pendingAt?: string;
  now: Date;
  sending?: boolean;
  /** 已经交给 Agent：显示 ✓✓。排队、准备沙箱时还没有。 */
  delivered?: boolean;
  onRetry?: (text: string) => void;
}) {
  const [copied, copy] = useCopy(text);
  const catchUp = useCatchUp(pendingAt);
  const time = new Date(at);
  return (
    <div
      className={`sent ${motion}${catchUp ? ` ${catchUp.className}` : ""}${sending ? " sending" : ""}`}
      style={catchUp?.style}
    >
      <div className="user-message">{text}</div>
      <div className="message-meta">
        {/* 还没发到服务器（网络慢）时转圈；很快就到的话不出现（.sending-spinner 晚一点才显示） */}
        {sending && (
          <span className="spinner small sending-spinner" role="status" aria-label="正在发送" />
        )}
        {!sending && delivered && (
          <MetaInfo className="message-delivered" tip="DeepSeek 已读取">
            <DoubleCheckIcon />
          </MetaInfo>
        )}
        <MetaInfo className="message-time" tip={fullTime(time)}>
          <time dateTime={at}>{relativeTime(time, now)}</time>
        </MetaInfo>
        <span className="message-meta-dot" aria-hidden="true">
          ·
        </span>
        <CopyButton copied={copied} onCopy={copy} />
        <button
          type="button"
          className="icon-button small"
          aria-label="重试"
          data-tip={onRetry ? "重新发送此消息" : sending ? "正在发送" : "DeepSeek 运行期间无法重试"}
          disabled={!onRetry}
          onClick={() => onRetry?.(text)}
        >
          <RetryIcon />
        </button>
      </div>
    </div>
  );
}

/** 回合结束后，最后一条回复下面的一行：复制这个回合的全部回复（Markdown 原文），和结束的时间。 */
function ReplyMeta({
  reply,
  at,
  now,
  pinned,
  onPin,
}: {
  reply: string;
  at: string;
  now: Date;
  pinned: boolean;
  onPin?: (pinned: boolean) => void;
}) {
  const [copied, copy] = useCopy(reply);
  const time = new Date(at);
  return (
    <div className="message-meta reply-meta">
      <CopyButton copied={copied} onCopy={copy} />
      {onPin && (
        <button
          type="button"
          className={`icon-button small pin-button${pinned ? " pinned" : ""}`}
          aria-label={pinned ? "取消置顶" : "置顶"}
          aria-pressed={pinned}
          data-tip={pinned ? "取消置顶" : "置顶"}
          onClick={() => onPin(!pinned)}
        >
          <PinIcon filled={pinned} size={14} />
        </button>
      )}
      <MetaInfo className="message-time" tip={fullTime(time)}>
        <time dateTime={at}>{relativeTime(time, now)}</time>
      </MetaInfo>
    </div>
  );
}

/**
 * 只用来看提示的按钮（✓✓、时间）。电脑上指上去看；手机没有悬停，点一下显示，点别处收起。
 * 不靠 :focus，因为 iPhone 的 Safari 点按钮时不会让它获得焦点。
 */
function MetaInfo({
  tip,
  className,
  children,
}: {
  tip: string;
  className: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <button
      ref={ref}
      type="button"
      className={`meta-info ${className}`}
      data-tip={tip}
      data-open={open || undefined}
      aria-label={tip}
      onClick={() => setOpen((v) => !v)}
    >
      {children}
    </button>
  );
}

/** 每秒刷新一次的"已经过了多久"。 */
function useElapsed(since: string | undefined): string | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  if (!since) return undefined;
  const seconds = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/** Agent 在干活时的提示：跳动的四个点、一行流光文字和已经过了多久。 */
/** 对话最后一行鲸鱼的大小。 */
const WHALE_SIZE = 30;

/** token 数的写法：1234 → "1.2k"。 */
export function formatTokens(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`;
}

/**
 * token 数变了不直接跳过去，在约半秒里一个个数上去（照 Claude）：宿主机隔一会儿报一次，
 * 看起来就是数字连贯地涨一阵、停一下、再涨一阵。变小（新的回合）时直接换；减少动效时也直接换。
 */
function useCountUp(target: number | undefined): number | undefined {
  const [shown, setShown] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    const from = current.current;
    const set = (value: number | undefined) => {
      current.current = value;
      setShown(value);
    };
    if (
      target === undefined ||
      from === undefined ||
      target <= from ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      set(target);
      return;
    }
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const p = Math.min(1, (now - start) / COUNT_UP_MS);
      set(Math.round(from + (target - from) * (1 - (1 - p) ** 3)));
      if (p < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return shown;
}

const COUNT_UP_MS = 600;

/**
 * 对话最后一行在工作时：鲸鱼游动，写着在做什么，后面是用时（照 Claude Code）。
 * 有工具在跑时写它（"运行 pnpm test"）；模型在思考、写回复时写"深度求索中"，用时后面跟着这个回合
 * 到现在输出的 token 数，跨工具调用累加，下一个回合从 0 数起。
 */
function Working({
  text,
  since,
  progress,
  ellipsis = true,
}: {
  text: string;
  since?: string;
  progress?: ModelProgress;
  ellipsis?: boolean;
}) {
  const elapsed = useElapsed(since);
  const tokens = useCountUp(progress && progress.tokens > 0 ? progress.tokens : undefined);
  return (
    <p className="timeline-tail working" role="status">
      <Whale size={WHALE_SIZE} swimming transitionName="seekcloud-whale" />
      <span className="working-text">
        {text}
        {ellipsis && "…"}
      </span>
      {elapsed && (
        <span className="working-time">
          {elapsed}
          {tokens !== undefined && (
            <span className="working-tokens"> · ↓ {formatTokens(tokens)} tokens</span>
          )}
        </span>
      )}
    </p>
  );
}

/**
 * 时间线上的一条。刚出现时轻轻浮上来（.fresh 的动画只在元素第一次挂上时播一次，
 * 之后内容更新不会再播；打开会话时历史一起浮上来，就是进场效果）。
 * live：打开会话以后才收到的。这时 Agent 回复的字一段段浮现，整条不再浮上来；别处发的用户消息照刚发的气泡进来。
 * pendingAt：服务器回推的是刚才先显示的那条消息时，那条的发送时间。
 */
function TimelineEntry({
  item,
  nameOf,
  live,
  pendingAt,
  now,
  pin,
  onPin,
  onRetry,
}: {
  item: TimelineItem;
  nameOf: (model: string) => string;
  live: boolean;
  pendingAt?: string;
  now: Date;
  /** 这条回复置顶了：上方显示短标题。 */
  pin?: MessagePin;
  /** 能置顶（一个回合最后的那条回复）：下面那一行有图钉。 */
  onPin?: (pinned: boolean) => void;
  onRetry?: (text: string) => void;
}) {
  const motion = " fresh";
  switch (item.kind) {
    case "user":
      return (
        <SentMessage
          text={item.text}
          at={item.at}
          motion={pendingAt ? "delivered" : live ? "bubble-in" : "fresh"}
          pendingAt={pendingAt}
          now={now}
          delivered={item.delivered}
          onRetry={onRetry}
        />
      );
    case "assistant":
      return (
        <div className={`assistant-message${live ? "" : motion}`} data-seq={item.key}>
          <PinTitle pin={pin} />
          {item.thinking && (
            <details className="thinking">
              <summary>
                <ChevronRightIcon />
                思考过程
              </summary>
              <div className="thinking-body">{item.thinking}</div>
            </details>
          )}
          <PacedReply text={item.text} live={live}>
            {item.turnEnd && (
              <ReplyMeta
                reply={item.turnEnd.reply}
                at={item.turnEnd.at}
                now={now}
                pinned={pin !== undefined}
                onPin={onPin}
              />
            )}
          </PacedReply>
        </div>
      );
    case "tools":
      return <Tools calls={item.calls} motion={motion} />;
    case "model":
      return (
        <p className={`timeline-notice${motion}`}>
          已切换到 {nameOf(item.model)} · 思考{effortLabels[item.effort]}
        </p>
      );
    case "notice":
      return <p className={`timeline-notice ${item.tone}${motion}`}>{item.text}</p>;
  }
}

/**
 * 置顶回复上方的短标题，展开、收起都是平滑的高度变化。标题还没回来时是一条占位的闪烁条
 * （Claude 这时会闪一下上一条回复的内容，是它的毛病，不照搬）。取消置顶时留着原来的字，收起来再拿掉。
 */
function PinTitle({ pin }: { pin?: MessagePin }) {
  const last = useRef<string | null>(null);
  if (pin) last.current = pin.title;
  const title = pin ? pin.title : last.current;
  return (
    <Collapse open={pin !== undefined}>
      <p className="pin-title">
        <PinIcon filled size={13} />
        {title ? (
          <BlurText text={title} />
        ) : (
          <span className="pin-title-loading" role="status" aria-label="正在生成标题" />
        )}
      </p>
    </Collapse>
  );
}

/**
 * 左上角的置顶列表（照 Claude）：几道短横，点开是"会话开头"和每条置顶的标题，点哪个就平滑地滚到哪条。
 */
function PinNav({
  pins,
  scroller,
}: {
  pins: MessagePin[];
  scroller: RefObject<HTMLDivElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const { mounted, closing } = usePresence(open, 180);
  const root = useRef<HTMLDivElement>(null);
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
  const go = (seq?: number) => {
    setOpen(false);
    const box = scroller.current;
    if (!box) return;
    if (seq === undefined) {
      box.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    box
      .querySelector(`[data-seq="${seq}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <div className="pin-nav-anchor">
      <div className="pin-nav" ref={root}>
        <button
          type="button"
          className={`pin-nav-button${open ? " active" : ""}`}
          aria-label={`置顶的消息（${pins.length} 条）`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {[undefined, ...pins.slice(0, 5)].map((p) => (
            <span key={p?.seq ?? "start"} className={p ? "" : "start"} />
          ))}
        </button>
        {mounted && (
          <div className={`popover pin-nav-menu${closing ? " closing" : ""}`} role="menu">
            <button
              type="button"
              role="menuitem"
              className="pin-nav-item start"
              onClick={() => go()}
            >
              <span className="pin-nav-dash" />
              <BlurText text="会话开头" />
            </button>
            {pins.map((p) => (
              <button
                key={p.seq}
                type="button"
                role="menuitem"
                className="pin-nav-item"
                onClick={() => go(p.seq)}
              >
                <span className="pin-nav-dash" />
                {p.title ? <BlurText text={p.title} /> : <span className="pin-title-loading" />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 页面长高了（回复多显示了几个字），贴着底部时跟着往下。 */
const GrowContext = createContext<(() => void) | undefined>(undefined);

/** 回复按舒服的速度一个个字显示出来（paced-text.ts）；显示完了才出现下面的复制和时间。 */
function PacedReply({
  text,
  live,
  children,
}: {
  text: string;
  live: boolean;
  children?: ReactNode;
}) {
  const { shown, done } = usePacedText(text, live, useContext(GrowContext));
  return (
    <>
      <LiveMarkdown text={shown} live={live} />
      {done && children}
    </>
  );
}

const callState = (call: ToolCall) =>
  !call.result ? "running" : call.result.isError ? "error" : "done";

/**
 * 连续的工具调用。只有一次时就是一行"读取 src/app.ts"；两次以上合成一行"运行了 3 条命令，改了 2 个文件"，点开看每一次。
 * 两种样子用同一个 details 元素：第二次调用来的时候原地更新，不会整行重新出现、闪一下。
 */
function Tools({ calls, motion }: { calls: ToolCall[]; motion: string }) {
  const only = calls.length === 1 ? (calls[0] as ToolCall) : undefined;
  const running = calls.find((c) => !c.result);
  // 中途出过错、后来又成功了，算成功；点开能看到出错的那一次。
  const failed = calls.at(-1)?.result?.isError;
  const state = only ? callState(only) : running ? "running" : failed ? "error" : "done";
  return (
    <details className={`tool${only ? "" : " tool-group"} ${state}${motion}`}>
      <summary>
        <span className="tool-dot" aria-hidden="true" />
        {only ? (
          <ToolHead call={only} />
        ) : (
          <>
            <span className="tool-group-text">
              {running ? `正在${toolLabel(running.name)}` : summarizeTools(calls)}
            </span>
            {running && <span className="tool-summary">{toolSummary(running.input)}</span>}
          </>
        )}
        <span className="tool-chevron" aria-hidden="true">
          <ChevronRightIcon />
        </span>
      </summary>
      {only ? (
        <ToolBody call={only} />
      ) : (
        <div className="tool-group-body">
          {calls.map((call) => (
            <ToolRow key={call.key} call={call} />
          ))}
        </div>
      )}
    </details>
  );
}

function ToolHead({ call }: { call: ToolCall }) {
  const summary = toolSummary(call.input);
  return (
    <>
      <span className="tool-name">{toolLabel(call.name)}</span>
      {summary && <span className="tool-summary">{summary}</span>}
    </>
  );
}

/** 组里的一次工具调用：一行摘要，点开看输入和结果。 */
function ToolRow({ call }: { call: ToolCall }) {
  return (
    <details className={`tool ${callState(call)}`}>
      <summary>
        <span className="tool-dot" aria-hidden="true" />
        <ToolHead call={call} />
        <span className="tool-chevron" aria-hidden="true">
          <ChevronRightIcon />
        </span>
      </summary>
      <ToolBody call={call} />
    </details>
  );
}

function ToolBody({ call }: { call: ToolCall }) {
  return (
    <div className="tool-body">
      <div className="tool-section">输入</div>
      <pre>{typeof call.input === "string" ? call.input : JSON.stringify(call.input, null, 2)}</pre>
      {call.result && (
        <>
          <div className="tool-section">{call.result.isError ? "错误" : "结果"}</div>
          <pre>{call.result.output || "（无输出）"}</pre>
        </>
      )}
    </div>
  );
}

/** 待办清单：只显示最新的一份，放在它最后一次更新的位置。 */
function TodoCard({ items, stale }: { items: TodoItem[]; stale: boolean }) {
  const done = items.filter((i) => i.status === "completed").length;
  return (
    <section className="todo-card fresh" aria-label="计划">
      <div className="todo-head">
        <span>{stale ? "你上一条消息之前的计划" : "计划"}</span>
        <span className="todo-progress">
          {done}/{items.length}
        </span>
      </div>
      <ul>
        {items.map((todo, i) => (
          // 待办清单每次都是整表快照，内容可能重复，用位置当 key。
          // biome-ignore lint/suspicious/noArrayIndexKey: 见上
          <li key={i} className={todo.status}>
            <span className="todo-mark" aria-hidden="true">
              {todo.status === "completed" && <CheckIcon size={11} />}
            </span>
            <span className="todo-text">{todo.content}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
