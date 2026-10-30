/* Language switcher: a compact select (landing, auth pages, public map) or radio items for menus. */
import { useAuth } from "../auth/AuthContext";
import { LOCALES, LOCALE_NAMES, LOCALE_SHORT, isLocale, useT } from "../i18n";
import { IconCheck, IconGlobe } from "./Icons";

export function LanguageSelect({ className, compact }: { className?: string; compact?: boolean }) {
  const { t, locale } = useT();
  const { setLanguage } = useAuth();
  return (
    <label className={`lang-select ${className ?? ""}`} title={t("common.language")}>
      <IconGlobe size={14} />
      <select
        value={locale}
        aria-label={t("common.language")}
        onChange={(e) => {
          if (isLocale(e.target.value)) void setLanguage(e.target.value);
        }}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {compact ? LOCALE_SHORT[l] : LOCALE_NAMES[l]}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Menu section (role="menuitemradio") for the account menu. */
export function LanguageMenuItems({ onDone }: { onDone?: () => void }) {
  const { t, locale } = useT();
  const { setLanguage } = useAuth();
  return (
    <>
      <div className="menu-label">{t("common.language")}</div>
      {LOCALES.map((l) => (
        <button
          key={l}
          role="menuitemradio"
          aria-checked={l === locale}
          className="menu-item"
          lang={l === "pt" ? "pt-BR" : l}
          onClick={() => {
            void setLanguage(l);
            onDone?.();
          }}
        >
          <IconGlobe />
          <span className="grow">{LOCALE_NAMES[l]}</span>
          {l === locale && <IconCheck size={14} className="ok-text" />}
        </button>
      ))}
    </>
  );
}
