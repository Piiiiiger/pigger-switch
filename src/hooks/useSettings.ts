import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { settingsApi, type AppSettings } from "@/lib/api/settings";

export const settingsKeys = {
  settings: ["settings"] as const,
  appInfo: ["settings", "app-info"] as const,
};

/**
 * 应用设置：读一次缓存起来，改动立刻写回后端（后端会规范化后返回最终值）。
 */
export function useSettings() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: settingsKeys.settings,
    queryFn: settingsApi.get,
    staleTime: Infinity,
  });

  const mutation = useMutation({
    mutationFn: (next: AppSettings) => settingsApi.save(next),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: settingsKeys.settings });
      const previous = queryClient.getQueryData<AppSettings>(
        settingsKeys.settings,
      );
      queryClient.setQueryData(settingsKeys.settings, next);
      return { previous };
    },
    onError: (_error, _next, context) => {
      if (context?.previous) {
        queryClient.setQueryData(settingsKeys.settings, context.previous);
      }
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(settingsKeys.settings, saved);
    },
  });

  const update = useCallback(
    async (patch: Partial<AppSettings>) => {
      const current = queryClient.getQueryData<AppSettings>(
        settingsKeys.settings,
      );
      if (!current) return null;
      return mutation.mutateAsync({ ...current, ...patch });
    },
    [mutation, queryClient],
  );

  return {
    settings: query.data,
    isLoading: query.isLoading,
    isSaving: mutation.isPending,
    update,
  };
}

export function useAppInfo() {
  return useQuery({
    queryKey: settingsKeys.appInfo,
    queryFn: settingsApi.getAppInfo,
  });
}
