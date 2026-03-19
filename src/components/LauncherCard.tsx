import type { LauncherStatus } from "../types/dashboard";
import { BADGE_OFFLINE, BADGE_ONLINE, CARD, MUTED, SEC_HDR } from "./styles";

interface Props {
  launchers: LauncherStatus[];
}

export function LauncherCard({ launchers }: Props) {
  return (
    <section className={CARD}>
      <div className={SEC_HDR}>
        <h2 className="m-0 text-lg font-semibold">Launcher scan</h2>
        <span className="text-[0.85rem]">{launchers.length} sources</span>
      </div>

      <div className="grid gap-[14px]">
        {launchers.map((l) => (
          <article
            key={l.id}
            className="flex justify-between gap-4 p-4 border border-[rgba(165,185,255,0.1)] bg-[rgba(9,14,26,0.7)] rounded-[18px]"
          >
            <div>
              <strong>{l.name}</strong>
              <p className={`${MUTED} m-0`}>{l.details ?? "No details yet"}</p>
            </div>
            <span className={l.detected ? BADGE_ONLINE : BADGE_OFFLINE}>
              {l.detected ? `${l.gameCount} found` : "Not found"}
            </span>
          </article>
        ))}
      </div>
    </section>
  );
}
