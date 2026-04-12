import { useQuery } from "@tanstack/react-query";
import { gamePlayingKey } from "./keys";

export const useGamePlaying = (id: string) => {
  return useQuery<boolean>({
    queryKey: gamePlayingKey(id),
    queryFn: () => false,
    staleTime: Infinity,
    enabled: !!id,
  });
};
