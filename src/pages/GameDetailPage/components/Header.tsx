import { CARD, EYEBROW, SOFT_BADGE, SOURCE_BADGE } from "@/components/styles";
import { DashboardQuery } from "@/queries/dashboard";
import { formatBytes, formatLocalTime, toImgSrc } from "@/utils";
import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router";

const Header = ({ setActiveTab }: { setActiveTab: (tab: "status" | "config") => void }) => {
  const { id } = useParams<{ id: string }>();

  const queryClient = useQueryClient();

  const game = queryClient.getQueryData(DashboardQuery.queryKey)?.games.find((g) => g.id === id);

  
  const sourceBadge = game ? SOURCE_BADGE[game.source] : SOFT_BADGE;

  if (!game) return null;

  return (
    <div className={CARD}>
      <div className="flex items-start gap-5 mb-5">
        {/* Thumbnail */}
        <div className="w-24 h-24 shrink-0 rounded-2xl border border-[rgba(165,185,255,0.1)] bg-[rgba(9,14,28,0.75)] overflow-hidden">
          {game.thumbnail ? (
            <img
              src={toImgSrc(game.thumbnail)}
              alt={game.name}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="grid place-items-center w-full h-full text-[#9aa8c7] text-3xl">
              🎮
            </div>
          )}
        </div>

        <div className="grid gap-2">
          <p className={EYEBROW}>Game details</p>
          <h2 className="m-0">{game.name}</h2>
          <span className={sourceBadge}>{game.source}</span>
          {game.description && (
            <p className="m-0 text-sm text-[#9aa8c7] max-w-120 whitespace-pre-wrap">
              {game.description}
            </p>
          )}
        </div>
      </div>

      {/* Metadata grid */}
      <dl className="grid gap-3.5 grid-cols-2 m-0 max-[720px]:grid-cols-1">
        {[
          { label: "Save folder", value: game.savePath ?? "Not set" },
          {
            label: "Google Drive folder",
            value: game.gdriveFolderId ?? "Not synced",
          },
          {
            label: "Last cloud save",
            value: formatLocalTime(game.lastCloudModified),
          },
          {
            label: "Drive storage used",
            value:
              game.cloudStorageBytes != null
                ? formatBytes(game.cloudStorageBytes)
                : "Never synced",
          },
        ].map(({ label, value }) => (
          <div
            key={label}
            className="p-4.5 rounded-[18px] bg-[rgba(9,14,28,0.75)] border border-[rgba(165,185,255,0.08)]"
          >
            <dt className="mb-2 text-[#c7d3f7] text-[0.92rem]">{label}</dt>
            <dd className="m-0 wrap-break-word text-[#9aa8c7]">{value}</dd>
          </div>
        ))}
      </dl>

      {/* No-exe warning */}
      {game.trackChanges && !game.exeName && (
        <div className="mt-4 px-4 py-3 rounded-2xl border border-[rgba(255,200,80,0.3)] bg-[rgba(62,45,12,0.55)] text-[#ffd5a0] text-sm flex items-center gap-2">
          <span>⚠</span>
          <span>
            <strong>Process tracking is on but no executable is set.</strong>{" "}
            Switch to the{" "}
            <button
              type="button"
              className="underline text-[#ffd5a0] bg-transparent border-0 p-0 cursor-pointer"
              onClick={() => setActiveTab("config")}
            >
              Configuration
            </button>{" "}
            tab and enter the game&apos;s .exe name to activate tracking.
          </span>
        </div>
      )}
    </div>
  );
};

export default Header;