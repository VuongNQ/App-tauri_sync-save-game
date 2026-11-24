import { useT } from "../i18n";
import { formatBytes } from "../utils";
import { CARD, EYEBROW, MUTED } from "./styles";

interface Props {
  gamesCount: number;
  totalStorageBytes: number;
}

export function HeroCard({ gamesCount, totalStorageBytes }: Props) {
  const t = useT();
  return (
    <header className={`${CARD} grid gap-4.5`}>
      <p className={EYEBROW}>{t("hero.eyebrow")}</p>
      <h1 className="m-0 text-2xl font-bold">{t("app.name")}</h1>
      <p className={MUTED}>{t("hero.tagline")}</p>

      <div className="grid grid-cols-2 gap-3">
        <div className="p-4 border border-[rgba(165,185,255,0.12)] bg-[rgba(11,18,33,0.76)] rounded-[18px]">
          <span className="block text-[1.8rem] font-bold">{gamesCount}</span>
          <span className="text-[#91a0bf] text-sm">{t("hero.gamesTracked")}</span>
        </div>
        <div className="p-4 border border-[rgba(165,185,255,0.12)] bg-[rgba(11,18,33,0.76)] rounded-[18px]">
          <span className="block text-[1.8rem] font-bold">{formatBytes(totalStorageBytes)}</span>
          <span className="text-[#91a0bf] text-sm">{t("hero.driveUsage")}</span>
        </div>
      </div>
    </header>
  );
}
