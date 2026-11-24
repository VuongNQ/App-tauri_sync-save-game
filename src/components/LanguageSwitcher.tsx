import { LANGUAGES, useI18n } from "../i18n";

interface Props {
  /** Small pill variant (login screen corner) instead of the settings row control. */
  compact?: boolean;
}

/** Segmented English / Tiếng Việt picker. The choice is stored per device. */
export function LanguageSwitcher({ compact = false }: Props) {
  const { language, setLanguage, t } = useI18n();

  return (
    <div
      role="radiogroup"
      aria-label={t("language.label")}
      className="flex w-fit gap-1 rounded-xl border border-[rgba(165,185,255,0.1)] bg-[rgba(255,255,255,0.05)] p-1"
    >
      {LANGUAGES.map((option) => {
        const active = option.value === language;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            lang={option.value}
            onClick={() => setLanguage(option.value)}
            className={`${compact ? "px-2.5 py-1 text-xs" : "px-4 py-1.5 text-sm"} rounded-[10px] font-medium transition-colors duration-150 focus:outline-2 focus:outline-[rgba(122,180,255,0.35)] focus:outline-offset-1 ${
              active ? "bg-[rgba(109,125,255,0.35)] text-[#d0d8ff]" : "text-[#9aa8c7] hover:text-[#c7d3f7]"
            }`}
          >
            {compact ? option.value.toUpperCase() : option.label}
          </button>
        );
      })}
    </div>
  );
}
