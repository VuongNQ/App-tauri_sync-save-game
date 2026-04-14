import { ConfirmModal } from "@/components/ConfirmModal";
import { GameSettingsForm } from "@/components/GameSettingsForm";
import { CARD, DANGER_BTN } from "@/components/styles";
import { useRemoveGameMutation } from "@/queries";
import { DashboardQuery } from "@/queries/dashboard";
import { SyncGameMutation } from "@/queries/sync";
import { msg } from "@/utils";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";

const TabSettings = () => {
  const { id } = useParams<{ id: string }>();

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
        <h3 className="m-0 mb-4 font-semibold text-[#ff9e9e]">Danger zone</h3>
        <button
          className={DANGER_BTN}
          type="button"
          disabled={removeMutation.isPending || isSyncing}
          onClick={() => setShowRemoveModal(true)}
        >
          {removeMutation.isPending ? "Removing…" : "Remove game"}
        </button>
        {removeMutation.isError && <p className="m-0 mt-3 text-sm text-[#ffd5d5]">{msg(removeMutation.error, "Unable to remove game.")}</p>}
      </div>

      <ConfirmModal
        open={showRemoveModal}
        title="Remove game"
        message={`Are you sure you want to remove "${game?.name}" from your library? This cannot be undone.`}
        confirmLabel="Remove"
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
