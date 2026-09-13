/**
 * Native live map for the active pod.
 *
 * The visual treatment approximates CARTO Dark Matter while keeping the
 * existing react-native-maps provider, which works in Expo Go.
 */

import { forwardRef, useImperativeHandle, useRef } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE, type MapStyleElement } from 'react-native-maps';

import { Avatar } from '@/components/Avatar';
import type { LocalFix } from '@/hooks/useLocationPings';
import { radius, spacing, themeColors } from '@/theme';
import { useSession } from '@/store/session';
import type { MapPea } from './model';
import { coordinateBounds } from './model';

const FALLBACK_REGION = {
  latitude: 1.3521,
  longitude: 103.8198,
  latitudeDelta: 0.08,
  longitudeDelta: 0.08,
};

const DARK_MAP_STYLE: MapStyleElement[] = [
  { elementType: 'geometry', stylers: [{ color: '#17211d' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#9aa9a1' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#111815' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#34433b' }] },
  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#17211d' }] },
  { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#202d27' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#1c3328' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2d3933' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3c4b43' }] },
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#26342e' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0d171b' }] },
];

export interface PodMapHandle {
  centerOnUser: (pea: MapPea) => void;
  centerOnMe: () => void;
  centerOnGroup: () => void;
}

interface Props {
  peas: MapPea[];
  myFix: LocalFix | null;
  onSelectMember: (pea: MapPea) => void;
}

export const PodMap = forwardRef<PodMapHandle, Props>(function PodMap(
  { peas, myFix, onSelectMember },
  forwardedRef,
) {
  const mapRef = useRef<MapView>(null);
  const colors = themeColors(useSession((state) => state.darkMode));
  const coordinates = coordinateBounds(peas);
  const currentPea = peas.find((pea) => pea.isMe);

  function centerOnCoordinate(latitude: number, longitude: number) {
    mapRef.current?.animateCamera(
      { center: { latitude, longitude }, zoom: 15 },
      { duration: 450 },
    );
  }

  function centerOnUser(pea: MapPea) {
    if (pea.latitude == null || pea.longitude == null) return;
    centerOnCoordinate(pea.latitude, pea.longitude);
  }

  function centerOnMe() {
    if (myFix) centerOnCoordinate(myFix.latitude, myFix.longitude);
  }

  function centerOnGroup() {
    if (coordinates.length === 0) return;
    if (coordinates.length === 1) {
      centerOnCoordinate(coordinates[0]!.latitude, coordinates[0]!.longitude);
      return;
    }
    mapRef.current?.fitToCoordinates(coordinates, {
      edgePadding: { top: 130, right: 60, bottom: 100, left: 60 },
      animated: true,
    });
  }

  useImperativeHandle(forwardedRef, () => ({ centerOnUser, centerOnMe, centerOnGroup }));

  const firstCoordinate = myFix
    ? { latitude: myFix.latitude, longitude: myFix.longitude }
    : coordinates[0];

  return (
    <View style={StyleSheet.absoluteFill}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        provider={PROVIDER_GOOGLE}
        initialRegion={
          firstCoordinate
            ? { ...firstCoordinate, latitudeDelta: 0.04, longitudeDelta: 0.04 }
            : FALLBACK_REGION
        }
        customMapStyle={DARK_MAP_STYLE}
        userInterfaceStyle="dark"
        showsMyLocationButton={false}
        toolbarEnabled={false}
        loadingEnabled
        loadingBackgroundColor="#0F1512"
      >
        {peas.map((pea) => {
          if (pea.latitude == null || pea.longitude == null) return null;
          return (
            <Marker
              key={pea.member.id}
              coordinate={{ latitude: pea.latitude, longitude: pea.longitude }}
              title={pea.member.display_name}
              description={pea.locationLabel}
              onPress={() => onSelectMember(pea)}
            >
              <View style={[styles.marker, { borderColor: pea.online ? colors.accent : colors.textMuted }]}>
                <Avatar
                  name={pea.member.display_name}
                  id={pea.member.id}
                  uri={pea.member.avatar_url}
                  size={34}
                />
                {pea.online ? <View style={[styles.onlineDot, { backgroundColor: colors.accent }]} /> : null}
              </View>
            </Marker>
          );
        })}
      </MapView>

      <View style={[styles.shareCount, { backgroundColor: colors.overlay }]}>
        <Text style={{ color: colors.cream, fontWeight: '700', fontSize: 12 }}>
          {coordinates.length} peas sharing
        </Text>
      </View>

      <View style={styles.mapControls}>
        <View style={[styles.currentUserPill, { backgroundColor: colors.overlay }]}>
          <Avatar
            name={currentPea?.member.display_name ?? 'You'}
            id={currentPea?.member.id}
            uri={currentPea?.member.avatar_url}
            size={36}
          />
          <View style={styles.currentUserText}>
            <Text style={{ color: colors.cream, fontWeight: '800' }} numberOfLines={1}>
              {currentPea?.member.display_name ?? 'You'}
            </Text>
            <Text style={{ color: colors.textMuted, fontSize: 10 }} numberOfLines={1}>
              {currentPea?.locationLabel ?? 'Waiting for your location…'}
            </Text>
          </View>
          <Pressable
            onPress={centerOnMe}
            disabled={!myFix}
            accessibilityLabel="Center on me"
            style={[styles.myLocationButton, { backgroundColor: colors.accentDim, opacity: myFix ? 1 : 0.4 }]}
          >
            <Ionicons name="locate" size={20} color={colors.accent} />
          </Pressable>
        </View>

        <Pressable
          onPress={centerOnGroup}
          disabled={coordinates.length === 0}
          accessibilityLabel="Center on group"
          style={[styles.groupControl, { backgroundColor: colors.overlay }]}
        >
          <Ionicons name="scan" size={22} color={colors.accent} />
        </Pressable>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  marker: {
    padding: 2,
    borderRadius: 22,
    borderWidth: 2,
    backgroundColor: '#0F1512',
  },
  onlineDot: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: '#0F1512',
  },
  mapControls: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    bottom: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  currentUserPill: {
    minHeight: 56,
    maxWidth: '68%',
    padding: spacing.sm,
    borderRadius: radius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  currentUserText: { flex: 1, minWidth: 76 },
  myLocationButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareCount: {
    position: 'absolute',
    alignSelf: 'center',
    bottom: 76,
    minHeight: 34,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  groupControl: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
