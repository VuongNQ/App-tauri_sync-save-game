import { ConfirmModal } from "@/components/ConfirmModal";
import { GameSettingsForm } from "@/components/GameSettingsForm";
import { CARD, DANGER_BTN } from "@/components/styles";
import { useT } from "@/i18n";
import { useRemoveGameMutation } from "@/queries";
import { DashboardQuery } from "@/queries/dashboard";
import { SyncGameMutation } from "@/queries/sync";
import { msg } from "@/utils";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";

const TabSettings = () => {
  const { id } = useParams<{ id: string }>();
  const t = useT();

  const queryClient = useQueryClient();

  const navigate = useNavigate();

  const removeMutation = useRemoveGameMutation();

  const [showRemoveModal, setShowRemoveModal] = useState(false);

  const game = queryClient.getQueryData(DashboardQuery.queryKey)?.games.find((g) => g.id === id);

  const isSyncing =
    queryClient.isMutating({
      mutationKey: SyncGameMutation(id ?? "")?.mutationKey,
    }) > 0;

  return (
    <>
      {/* Settings form — always open in config tab */}
      <div className={CARD}>
        <GameSettingsForm isOpen={true} isSyncing={isSyncing} id={id} />
      </div>

      {/* Danger zone */}
      <div className={CARD}>
        <h3 className="m-0 mb-4 font-semibold text-[#ff9e9e]">{t("common.dangerZone")}</h3>
        <button
          className={DANGER_BTN}
          type="button"
          disabled={removeMutation.isPending || isSyncing}
          onClick={() => setShowRemoveModal(true)}
        >
          {removeMutation.isPending ? t("common.removing") : t("games.removeTitle")}
        </button>
        {removeMutation.isError && <p className="m-0 mt-3 text-sm text-[#ffd5d5]">{msg(removeMutation.error, t("detail.errorRemove"))}</p>}
      </div>

      <ConfirmModal
        open={showRemoveModal}
        title={t("games.removeTitle")}
        message={t("games.removeMessage", { name: game?.name ?? "" })}
        confirmLabel={t("common.remove")}
        onConfirm={() => {
          setShowRemoveModal(false);
          removeMutation.mutate(game?.id ?? "", {
            onSuccess: () => navigate("/", { replace: true }),
          });
        }}
        onCancel={() => setShowRemoveModal(false)}
      />
    </>
  );
};

export default TabSettings;
