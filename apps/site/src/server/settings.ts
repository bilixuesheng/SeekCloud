import { z } from "@hono/zod-openapi";
import {
  type AiLabels,
  DEFAULT_AI_LABELS,
  THINKING_EFFORTS,
  type ThinkingEffort,
} from "@seekcloud/protocol";
import { eq } from "drizzle-orm";
import type { AppDeps } from "./app";
import { settings } from "./db/schema";
import type { SettingsActor, SettingsPolicy } from "./ports";

/** 新会话默认的思考强度（模型没有这一档时换成最近的一档）。 */
export const DEFAULT_EFFORT: ThinkingEffort = "high";

/**
 * 全站设置。每一项有固定的键、形状和默认值；库里没有这一行，或者存的值不符合现在的形状
 * （比如旧版本写的），都按默认值算。默认值和能不能改由扩展点 SettingsPolicy 定（ports.ts）。
 */
export const AiLabelsValue = z.object({ signature: z.boolean(), commitTrailer: z.boolean() });

export const EffortValue = z.enum(THINKING_EFFORTS);

/** 宿主机断线多久以后，把它上面运行中的会话标为失败。单位是秒。 */
export const HOST_OFFLINE_GRACE_CHOICES = [60, 120, 300, 600, 1800] as const;
export const HostOfflineGraceValue = z
  .number()
  .int()
  .refine((v) => (HOST_OFFLINE_GRACE_CHOICES as readonly number[]).includes(v), {
    error: "不支持这个时长",
  });

/** 界面语言：跟随浏览器、简体中文、英文（和浏览器端 i18n/catalog.ts 的 LANGUAGE_SETTINGS 一致）。 */
export const LanguageValue = z.enum(["auto", "zh-CN", "en"]);

/** 所有的设置项：键、形状、主干的默认值。加一项设置就在这里加一行。 */
export const SETTINGS = {
  /** AI 标识的两个开关，默认都开。 */
  ai_labels: { shape: AiLabelsValue, fallback: DEFAULT_AI_LABELS as AiLabels },
  /** 新会话默认的思考强度，默认是高档。已有的会话不跟着变。 */
  default_effort: { shape: EffortValue, fallback: DEFAULT_EFFORT as ThinkingEffort },
  /**
   * 宿主机断线多久以后把它上面运行中的会话标为失败，默认 2 分钟（#91 的 2026-11-15 评论）。断线期间沙箱里的
   * 运行器还在跑，重连以后事件按序号补上，回合可以接着走；网络不稳的部署可以放长一点。
   */
  host_offline_grace: { shape: HostOfflineGraceValue, fallback: 120 as number },
  /**
   * 平台自己发起的模型调用（判断是否在等输入这些，#140）用哪个模型。"auto" 是自动：用模型列表里最省的那个。
   */
  platform_model: { shape: z.string().max(300), fallback: "auto" as string },
  /**
   * 新会话默认用的模型（"提供方/模型"），在模型选择器里选了就记下（照 dsh：选模型也设为新会话的默认值）。
   * 空的、或者那个模型不能用了，用第一个能用的模型。
   */
  default_model: { shape: z.string().max(300), fallback: "" as string },
  /**
   * 界面语言（#135）：auto 是跟随浏览器（中文浏览器用中文，别的用英文）。跟着管理员存在主站，换一台设备登录也记得；
   * 浏览器里另存一份，免得刷新时先闪一下别的语言。
   */
  language: { shape: LanguageValue, fallback: "auto" as z.infer<typeof LanguageValue> },
  /**
   * 模型提供方（设置的"模型"：提供方、key、模型列表，#113）。内容存在 model_providers、provider_models 两张表里，
   * 不在这一项；这一项只用来问规则能不能改（SettingsPolicy.canWrite），下游可以不让普通用户改。
   */
  model_providers: { shape: z.null(), fallback: null },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]["shape"]>;

/** 主干的规则：默认值照上面写的，管理员都能改。 */
export const adminSettings: SettingsPolicy = {
  defaultValue: <K extends SettingKey>(key: K) => SETTINGS[key].fallback as SettingValue<K>,
  canWrite: () => true,
};

type ReadDeps = Pick<AppDeps, "db" | "settingsPolicy">;
type WriteDeps = Pick<AppDeps, "db" | "clock" | "settingsPolicy">;

/** 读一项设置。actor 是在读的人：后台替某个会话读时，是会话的主人。 */
export async function readSetting<K extends SettingKey>(
  deps: ReadDeps,
  key: K,
  actor: SettingsActor,
): Promise<SettingValue<K>> {
  const [row] = await deps.db.select().from(settings).where(eq(settings.key, key));
  const parsed = (SETTINGS[key].shape as unknown as z.ZodType<SettingValue<K>>).safeParse(
    row?.value,
  );
  return parsed.success ? parsed.data : await deps.settingsPolicy.defaultValue(key, actor);
}

/** 改一项设置。这个人不能改时什么都不做，返回 false。 */
export async function writeSetting<K extends SettingKey>(
  deps: WriteDeps,
  key: K,
  actor: SettingsActor,
  value: SettingValue<K>,
): Promise<boolean> {
  if (!(await deps.settingsPolicy.canWrite(key, actor))) return false;
  const updatedAt = deps.clock.now();
  await deps.db
    .insert(settings)
    .values({ key, value, updatedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } });
  return true;
}
