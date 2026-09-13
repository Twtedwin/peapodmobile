/**
 * MODULE: apps/mobile/app/(tabs)/you.tsx
 *
 * PURPOSE
 *   Profile, dark-mode toggle, pod settings, invite code, members, leave, and
 *   sign out. Seed (admin) members can rename the pod and mint invite codes.
 *
 * INPUTS  : PATCH /auth/me, PATCH /pods/:id, POST /pods/:id/invites,
 *           DELETE /pods/:id/members/:userId
 * OUTPUTS : the You tab
 */

import { useState } from 'react';
import { Pressable, Share, Switch, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';

import { apiDelete, apiPatch, apiPost, authPatch, authPost, unwrap } from '@/services/apiClient';
import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { ErrorRetry } from '@/components/ErrorRetry';
import { Field } from '@/components/Field';
import { Loading } from '@/components/Loading';
import { PodGate } from '@/components/PodGate';
import { Screen } from '@/components/Screen';
import { useCurrentPodId, useMembers } from '@/hooks/usePodData';
import { useSession } from '@/store/session';
import { spacing, themeColors, type as typeScale } from '@/theme';

function YouInner() {
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);
  const user = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);
  const setDarkMode = useSession((s) => s.setDarkMode);
  const signOut = useSession((s) => s.signOut);
  const setCurrentPodId = useSession((s) => s.setCurrentPodId);
  const podId = useCurrentPodId();
  const membersQ = useMembers(podId);
  const queryClient = useQueryClient();

  const [name, setName] = useState(user?.display_name ?? '');
  const [podName, setPodName] = useState('');
  const [invite, setInvite] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const meMember = (membersQ.data ?? []).find((m) => m.id === user?.id);
  const isSeed = meMember?.role === 'admin';

  async function saveName() {
    setBusy('name');
    try {
      const raw = await authPatch<unknown>('/auth/me', { display_name: name.trim() });
      const next = unwrap<{ display_name?: string }>(raw, ['user']);
      if (user) await setUser({ ...user, display_name: next.display_name || name.trim() });
      setMsg('Name saved.');
    } catch (cause) {
      setMsg(cause instanceof Error ? cause.message : 'Could not save name.');
    } finally {
      setBusy(null);
    }
  }

  async function savePod() {
    if (!podId) return;
    setBusy('pod');
    try {
      await apiPatch(`/pods/${podId}`, { name: podName.trim() });
      setMsg('Pod renamed.');
    } catch (cause) {
      setMsg(cause instanceof Error ? cause.message : 'Could not rename the pod.');
    } finally {
      setBusy(null);
    }
  }

  async function mintInvite() {
    if (!podId) return;
    setBusy('invite');
    try {
      const raw = await apiPost<unknown>(`/pods/${podId}/invites`, {});
      const row = unwrap<{ code?: string }>(raw, ['invite', 'data']);
      const code = row.code || String((raw as { code?: string }).code ?? '');
      setInvite(code);
      setMsg(code ? `Code ${code} — expires in 10 minutes.` : 'Invite created.');
    } catch (cause) {
      setMsg(cause instanceof Error ? cause.message : 'Could not mint an invite.');
    } finally {
      setBusy(null);
    }
  }

  async function copyInvite() {
    if (!invite) return;
    try {
      await Share.share({ message: invite, title: 'Peapod invite' });
    } catch {
      setMsg(`Code ${invite}`);
    }
  }

  async function leave() {
    if (!podId || !user) return;
    setBusy('leave');
    try {
      await apiDelete(`/pods/${podId}/members/${user.id}`);
      await setCurrentPodId(null);
      await queryClient.invalidateQueries({ queryKey: ['pods'] });
    } catch (cause) {
      setMsg(cause instanceof Error ? cause.message : 'Could not leave the pod.');
    } finally {
      setBusy(null);
    }
  }

  async function logout() {
    try {
      const refresh = useSession.getState().refreshToken;
      if (refresh) await authPost('/auth/logout', { refresh_token: refresh }, false);
    } catch {
      // Local sign-out still happens.
    }
    await signOut();
    router.replace('/login');
  }

  if (membersQ.isLoading) return <Loading />;
  if (membersQ.isError) {
    return (
      <ErrorRetry
        message={membersQ.error instanceof Error ? membersQ.error.message : undefined}
        onRetry={() => void membersQ.refetch()}
      />
    );
  }

  return (
    <Screen scroll>
      <View style={{ alignItems: 'center', marginTop: spacing.lg }}>
        <Avatar name={user?.display_name || 'You'} id={user?.id} uri={user?.avatar_url} size={84} />
        <Text style={[typeScale.title, { color: colors.text, marginTop: spacing.md }]}>
          {user?.display_name}
        </Text>
        <Text style={{ color: colors.textMuted }}>{user?.email}</Text>
      </View>

      {msg ? <Text style={{ color: colors.accent, marginTop: spacing.lg, textAlign: 'center' }}>{msg}</Text> : null}

      <View style={{ marginTop: spacing.xl, gap: spacing.md }}>
        <Field label="Display name" value={name} onChangeText={setName} autoCapitalize="words" />
        <Button label="Save name" onPress={saveName} loading={busy === 'name'} compact />
      </View>

      <Card style={{ marginTop: spacing.xl }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={[typeScale.subtitle, { color: colors.text }]}>Dark mode</Text>
          <Switch
            value={dark}
            onValueChange={(value) => void setDarkMode(value)}
            trackColor={{ true: colors.accent, false: colors.cardBorder }}
          />
        </View>
      </Card>

      <Text style={[typeScale.overline, { color: colors.textMuted, marginTop: spacing.xl }]}>Pod</Text>
      {isSeed ? (
        <View style={{ gap: spacing.md, marginTop: spacing.sm }}>
          <Field label="Pod name" value={podName} onChangeText={setPodName} placeholder="The Pod" autoCapitalize="words" />
          <Button label="Save pod" variant="secondary" onPress={savePod} loading={busy === 'pod'} compact />
          <Button label="Generate invite code" onPress={mintInvite} loading={busy === 'invite'} compact />
          {invite ? (
            <Pressable onPress={copyInvite}>
              <Text style={{ color: colors.accent, fontWeight: '700', letterSpacing: 2 }}>{invite}  · tap to copy</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <Text style={{ color: colors.textMuted, marginTop: spacing.sm }}>
          Only a Seed can rename the pod or mint invite codes.
        </Text>
      )}

      <Text style={[typeScale.overline, { color: colors.textMuted, marginTop: spacing.xl }]}>Members</Text>
      {(membersQ.data ?? []).map((member) => (
        <Card key={member.id} style={{ marginTop: spacing.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
            <Avatar name={member.display_name} id={member.id} uri={member.avatar_url} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontWeight: '700' }}>{member.display_name}</Text>
              <Text style={{ color: colors.textMuted }}>{member.role === 'admin' ? 'Seed' : 'Pea'}</Text>
            </View>
          </View>
        </Card>
      ))}

      <View style={{ marginTop: spacing.xxl, gap: spacing.md, paddingBottom: spacing.xxxl }}>
        <Button label="Leave pod" variant="danger" onPress={leave} loading={busy === 'leave'} />
        <Button label="Sign out" variant="ghost" onPress={logout} />
      </View>
    </Screen>
  );
}

export default function YouTab() {
  return (
    <PodGate>
      <YouInner />
    </PodGate>
  );
}
