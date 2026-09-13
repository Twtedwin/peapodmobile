/**
 * MODULE: apps/mobile/src/components/PodGate.tsx
 *
 * PURPOSE
 *   Wraps a tab's content: load the caller's pods, auto-select one, and show
 *   NoPodScreen when the list is empty. Also owns the error+retry for that
 *   first fetch so each tab does not reimplement it.
 *
 * INPUTS  : children
 * OUTPUTS : Loading | ErrorRetry | NoPodScreen | children
 * CONSUMED BY : every tab screen
 */

import type { ReactNode } from 'react';
import { useEffect } from 'react';

import { ErrorRetry } from '@/components/ErrorRetry';
import { Loading } from '@/components/Loading';
import { NoPodScreen } from '@/components/NoPodScreen';
import { usePods } from '@/hooks/usePodData';
import { useSession } from '@/store/session';

export function PodGate({ children }: { children: ReactNode }) {
  const currentPodId = useSession((s) => s.currentPodId);
  const setCurrentPodId = useSession((s) => s.setCurrentPodId);

  const query = usePods();

  useEffect(() => {
    if (!query.data?.length) return;
    if (currentPodId && query.data.some((pod) => pod.id === currentPodId)) return;
    void setCurrentPodId(query.data[0]!.id);
  }, [query.data, currentPodId, setCurrentPodId]);

  if (query.isLoading) return <Loading label="Finding your pod…" />;
  if (query.isError) {
    return (
      <ErrorRetry
        message={query.error instanceof Error ? query.error.message : undefined}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data?.length) return <NoPodScreen />;
  if (!currentPodId) return <Loading label="Opening your pod…" />;
  return <>{children}</>;
}
