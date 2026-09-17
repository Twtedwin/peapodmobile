/**
 * MODULE: apps/mobile/app/(tabs)/index
 *
 * PURPOSE
 *   Live, pod-scoped social map. Floating chrome (pod pill, notifications,
 *   profile) sits over a native map that fits every pea on load. The member
 *   sheet is a 2.5-card carousel; distances use shared haversine.
 *
 * INPUTS  : pod/member/presence/place APIs, realtime events, device location
 * OUTPUTS : Home tab map, draggable member sheet, chat and notifications
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';

import { apiClient, subscribeRealtime } from '@/services/apiClient';
import { ErrorRetry } from '@/components/ErrorRetry';
import { CurrentUserPill } from '@/components/home/CurrentUserPill';
import { PodChatSheet } from '@/components/home/PodChatSheet';
import {
  COMPACT_SHEET_HEIGHT,
  PodMemberSheet,
} from '@/components/home/PodMemberSheet';
import { PodHeader, type PodHeaderAnchor } from '@/components/home/PodHeader';
import { PodMap, type PodMapHandle } from '@/components/home/PodMap';
import { PodSelector } from '@/components/home/PodSelector';
import { buildMapPeas, type MapPea } from '@/components/home/model';
import { Loading } from '@/components/Loading';
import { PodGate } from '@/components/PodGate';
import { Sheet } from '@/components/Sheet';
import { useLocationPings } from '@/hooks/useLocationPings';
import {
  useCurrentPodId,
  useMembers,
  useNotifications,
  usePlaces,
  usePods,
  usePresence,
} from '@/hooks/usePodData';
import { useSession } from '@/store/session';
import { spacing, themeColors } from '@/theme';

function HomeInner() {
  const colors = themeColors(useSession((state) => state.darkMode));
  const me = useSession((state) => state.user);
  const podId = useCurrentPodId();
  const podsQ = usePods();
  const membersQ = useMembers(podId);
  const presenceQ = usePresence(podId);
  const placesQ = usePlaces(podId);
  const notificationsQ = useNotifications(podId);
  const myFix = useLocationPings(podId);
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const mapRef = useRef<PodMapHandle>(null);

  const [podSelectorOpen, setPodSelectorOpen] = useState(false);
  const [podAnchor, setPodAnchor] = useState<PodHeaderAnchor | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [mapBottom, setMapBottom] = useState(COMPACT_SHEET_HEIGHT);

  const pods = useMemo(() => podsQ.data ?? [], [podsQ.data]);
  const members = useMemo(() => membersQ.data ?? [], [membersQ.data]);
  const presence = useMemo(() => presenceQ.data ?? [], [presenceQ.data]);
  const places = useMemo(() => placesQ.data ?? [], [placesQ.data]);
  const peas = useMemo(
    () => buildMapPeas(members, presence, places, me?.id, myFix),
    [members, presence, places, me?.id, myFix],
  );
  const activePod = pods.find((pod) => pod.id === podId);
  const currentPea = peas.find((pea) => pea.isMe);
  const notifications = notificationsQ.data ?? [];
  const unread = notifications.filter((row) => row.is_read === false).length;
  useEffect(() => {
    if (!podId) return;
    return subscribeRealtime(podId, (event) => {
      if (event.entity === 'messages') {
        void queryClient.invalidateQueries({ queryKey: ['pod', podId, 'messages'] });
      }
      if (event.entity === 'location_pings' || event.entity === 'phone_statuses') {
        void queryClient.invalidateQueries({ queryKey: ['pod', podId, 'presence'] });
      }
      if (event.entity === 'pod_memberships') {
        void queryClient.invalidateQueries({ queryKey: ['pod', podId, 'members'] });
        void queryClient.invalidateQueries({ queryKey: ['pods'] });
      }
      if (event.entity === 'notifications') {
        void queryClient.invalidateQueries({ queryKey: ['pod', podId, 'notifications'] });
      }
    });
  }, [podId, queryClient]);

  function centerOn(pea: MapPea) {
    mapRef.current?.centerOnUser(pea);
  }

  async function nudge(pea: MapPea) {
    if (!podId || pea.isMe) return;
    await apiClient.pods.nudge(podId, pea.member.id);
  }

  function openDirectMessage(pea: MapPea) {
    if (pea.isMe) return;
    router.push({
      pathname: '/direct-message/[userId]',
      params: {
        userId: pea.member.id,
        name: pea.member.display_name,
        avatar: pea.member.avatar_url ?? '',
      },
    });
  }

  if (membersQ.isLoading) return <Loading label="Finding your peas…" />;
  if (membersQ.isError) {
    return (
      <ErrorRetry
        message={membersQ.error instanceof Error ? membersQ.error.message : undefined}
        onRetry={() => void membersQ.refetch()}
      />
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={[styles.mapFrame, { bottom: mapBottom }]}>
        <PodMap
          ref={mapRef}
          peas={peas}
          myFix={myFix}
          podId={podId}
          onSelectMember={centerOn}
        />
      </View>

      <PodHeader
        pod={activePod}
        user={me}
        topInset={insets.top}
        unread={unread}
        onOpenPods={() => setPodSelectorOpen(true)}
        onOpenNotifications={() => setNotificationsOpen(true)}
        onOpenProfile={() => router.push('/you')}
        onAnchorChange={setPodAnchor}
      />

      <CurrentUserPill
        pea={currentPea}
        myFix={myFix}
        bottom={mapBottom + spacing.sm}
        onCenterMe={() => mapRef.current?.centerOnMe()}
      />

      <PodMemberSheet
        peas={peas}
        onChat={() => setChatOpen(true)}
        onCenter={centerOn}
        onNudge={nudge}
        onOpenDirect={openDirectMessage}
        onExpandedChange={(_, height) => setMapBottom(height)}
      />

      <PodSelector
        visible={podSelectorOpen}
        pods={pods}
        activePodId={podId}
        anchor={podAnchor}
        onClose={() => setPodSelectorOpen(false)}
      />

      <PodChatSheet
        podId={podId}
        pod={activePod}
        visible={chatOpen}
        onClose={() => setChatOpen(false)}
      />

      <Sheet
        visible={notificationsOpen}
        title="Notifications"
        onClose={() => setNotificationsOpen(false)}
      >
        <ScrollView style={{ maxHeight: 440 }}>
          {notifications.length === 0 ? (
            <Text style={{ color: colors.textMuted, padding: spacing.lg }}>No notifications yet.</Text>
          ) : (
            notifications.map((row) => (
              <View
                key={String(row.id)}
                style={[
                  styles.notification,
                  { borderBottomColor: colors.cardBorder },
                ]}
              >
                <Text style={{ color: colors.text, fontWeight: '700' }}>
                  {String(row.emoji ?? '🔔')} {String(row.title ?? 'Update')}
                </Text>
                {row.body ? (
                  <Text style={{ color: colors.textMuted, marginTop: 4 }}>{String(row.body)}</Text>
                ) : null}
              </View>
            ))
          )}
        </ScrollView>
      </Sheet>
    </View>
  );
}

export default function HomeTab() {
  return (
    <PodGate>
      <HomeInner />
    </PodGate>
  );
}

const styles = StyleSheet.create({
  mapFrame: { position: 'absolute', top: 0, left: 0, right: 0 },
  notification: {
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
