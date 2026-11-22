import { THINKING_EFFORTS, type ThinkingEffort } from "@seekcloud/protocol";
import { useState } from "react";
import { flushSync } from "react-dom";
import { type ApiError, api } from "../api";
import { setCached, useCached } from "../cached";
import {
  LANGUAGE_SETTINGS,
  type LanguageSetting,
  LOCALE_NAMES,
  setLanguage,
  t,
  useT,
} from "../i18n";
import { errorText } from "../i18n/errors";
import { effortLabels } from "../session/ModelPicker";
import { reloadModels, useModels } from "../session/useModels";
import { currentTheme, setTheme, type Theme } from "../theme";
import { Select } from "../ui/select";
import { toast, useErrorToast } from "../ui/toast";

/** 设置窗口里"通用"一类用到的接口。 */
export const DEFAULT_EFFORT = "/api/settings/default-effort";
export const LANGUAGE = "/api/settings/language";

/** 通用：外观、界面语言、默认思考强度。文案都在文案目录里（#135）。 */
export function GeneralSettings() {
  useT();
  return (
    <>
      <ThemeSettings />
      <LanguageSettings />
      <DefaultEffortSettings />
    </>
  );
}

const THEMES: Theme[] = ["light", "dark", "system"];
const themeName = (theme: Theme) =>
  theme === "light"
    ? t("general.theme.light")
    : theme === "dark"
      ? t("general.theme.dark")
      : t("general.theme.system");

/** 外观：三个缩略图就是单选项；缩略图里画一个小窗口，颜色写死，不跟着当前外观变。 */
function ThemeSettings() {
  const [theme, setThemeState] = useState(currentTheme);
  return (
    <section className="settings-section settings-group">
      <h2>{t("general.appearance")}</h2>
      <fieldset className="theme-tiles">
        <legend className="visually-hidden">{t("general.appearance")}</legend>
        {THEMES.map((id) => (
          <label key={id} className={`theme-tile ${id}${theme === id ? " current" : ""}`}>
            <input
              type="radio"
              name="theme"
              value={id}
              checked={theme === id}
              onChange={() => setTheme(id, () => flushSync(() => setThemeState(id)))}
            />
            <span className="theme-thumb" aria-hidden="true">
              <span className="theme-window">
                <i />
                <i />
                <b />
              </span>
            </span>
            <span className="theme-name">{themeName(id)}</span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}

/**
 * 界面语言（#135）：跟随浏览器、简体中文、English。存在主站（跟着管理员，换一台设备登录也记得），
 * 同时记在浏览器里；改了马上换，不用刷新。语言名用它自己的文字写，看不懂当前语言的人也找得到。
 */
function LanguageSettings() {
  const loaded = useCached<{ language: LanguageSetting }>(LANGUAGE);
  const value = loaded.data?.language;
  useErrorToast(loaded.error);

  const choose = async (next: LanguageSetting) => {
    if (!value || next === value) return;
    setCached(LANGUAGE, { language: next });
    try {
      await api(LANGUAGE, { language: next }, "PUT");
      setLanguage(next, "settings");
    } catch (e) {
      setCached(LANGUAGE, { language: value });
      toast(errorText(e as ApiError), "error");
    }
  };

  return (
    <section className="settings-section settings-group">
      <h2>{t("general.language")}</h2>
      <Select
        label={t("general.language")}
        value={value ?? "auto"}
        disabled={!value}
        options={LANGUAGE_SETTINGS.map((setting) => ({
          value: setting,
          label: setting === "auto" ? t("language.auto") : LOCALE_NAMES[setting],
        }))}
        onChange={(next) => void choose(next as LanguageSetting)}
      />
      <p className="settings-group-hint">{t("general.languageHint")}</p>
    </section>
  );
}

/**
 * 新会话默认的思考强度：能用的模型支持的档位一排，点了当场保存，没存上就拨回去并说明原因。
 * 存好以后重新取模型列表，首页的弹层和"恢复默认"跟着用新的值。
 */
function DefaultEffortSettings() {
  const loaded = useCached<{ effort: ThinkingEffort }>(DEFAULT_EFFORT);
  const effort = loaded.data?.effort;
  const models = useModels()?.models;
  const offered = THINKING_EFFORTS.filter(
    (e) => e === effort || (models ?? []).some((m) => m.efforts.includes(e)),
  );
  useErrorToast(loaded.error);

  const choose = async (next: ThinkingEffort) => {
    if (!effort || next === effort) return;
    const before = effort;
    setCached(DEFAULT_EFFORT, { effort: next });
    try {
      await api(DEFAULT_EFFORT, { effort: next }, "PUT");
      reloadModels();
    } catch (e) {
      setCached(DEFAULT_EFFORT, { effort: before });
      toast(errorText(e as ApiError), "error");
    }
  };

  return (
    <section className="settings-section settings-group">
      <h2>{t("general.effort")}</h2>
      <fieldset className="segmented" disabled={!effort}>
        <legend className="visually-hidden">{t("general.effort")}</legend>
        {(offered.length > 0 ? offered : THINKING_EFFORTS).map((e) => (
          <label key={e} className={`segment ${e}${effort === e ? " current" : ""}`}>
            <input
              type="radio"
              name="default-effort"
              value={e}
              checked={effort === e}
              onChange={() => void choose(e)}
            />
            <span className="segment-label">{effortLabels[e]}</span>
          </label>
        ))}
      </fieldset>
      <p className="settings-group-hint">{t("general.effortHint")}</p>
    </section>
  );
}
