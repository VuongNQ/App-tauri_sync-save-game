import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getDevices, removeDevice, renameDevice } from "../services/tauri";
import type { DeviceInfo } from "../types/dashboard";
import { DEVICES_KEY } from "./keys";

export function useDevicesQuery() {
  return useQuery({
    queryKey: DEVICES_KEY,
    queryFn: getDevices,
  });
}

export function useRenameDeviceMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ deviceId, name }: { deviceId: string; name: string }) =>
      renameDevice(deviceId, name),
    onSuccess: (data: DeviceInfo[]) => queryClient.setQueryData<DeviceInfo[]>(DEVICES_KEY, data),
  });
}

export function useRemoveDeviceMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) => removeDevice(deviceId),
    onSuccess: (data: DeviceInfo[]) => queryClient.setQueryData<DeviceInfo[]>(DEVICES_KEY, data),
  });
}
