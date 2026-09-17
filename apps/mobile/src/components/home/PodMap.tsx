/**
 * Native live map for the active pod.
 *
 * Android always uses Google Maps (`PROVIDER_GOOGLE`) and needs a Maps SDK
 * key in the native manifest. iOS omits the provider so Apple Maps is used
 * unless a Google iOS key is later added.
 *
 * Camera: after the native map is ready, and when the set of members who have
 * a fix changes (pod switch or someone starts/stops sharing), the camera fits
 * every pea including the current user. Continuous GPS ticks do not re-fit,
 * so a pan is not stolen.
 */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE, type MapStyleElement } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import type { LocalFix } from '@/hooks/useLocationPings';
import { themeColors } from '@/theme';
import { useSession } from '@/store/session';
import { MAP_FIT_PADDING, coordinateBounds, type MapPea } from './model';

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
  podId: string | null;
  onSelectMember: (pea: MapPea) => void;
}

export const PodMap = forwardRef<PodMapHandle, Props>(function PodMap(
  { peas, myFix, podId, onSelectMember },
  forwardedRef,
) {
  const mapRef = useRef<MapView>(null);
  const colors = themeColors(useSession((state) => state.darkMode));
  const insets = useSafeAreaInsets();
  const coordinates = coordinateBounds(peas);
  const [mapReady, setMapReady] = useState(false);

  const sharingKey = useMemo(
    () =>
      peas
        .filter((pea) => pea.latitude != null && pea.longitude != null)
        .map((pea) => pea.member.id)
        .sort()
        .join(','),
    [peas],
  );

  const edgePadding = {
    top: insets.top + MAP_FIT_PADDING.top,
    right: MAP_FIT_PADDING.right,
    bottom: MAP_FIT_PADDING.bottom,
    left: MAP_FIT_PADDING.left,
  };

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
      mapRef.current?.animateCamera(
        { center: coordinates[0]!, zoom: 14 },
        { duration: 450 },
      );
      return;
    }
    mapRef.current?.fitToCoordinates(coordinates, {
      edgePadding,
      animated: true,
    });
  }

  useImperativeHandle(forwardedRef, () => ({ centerOnUser, centerOnMe, centerOnGroup }));

  useEffect(() => {
    if (!mapReady) return;
    centerOnGroup();
    // Why: re-fitting on every GPS sample steals pans. podId + sharingKey
    // change only when the pod or the set of located members changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment
  }, [mapReady, podId, sharingKey]);

  const firstCoordinate = myFix
    ? { latitude: myFix.latitude, longitude: myFix.longitude }
    : coordinates[0];

  return (
    <View style={StyleSheet.absoluteFill}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
        initialRegion={
          firstCoordinate
            ? { ...firstCoordinate, latitudeDelta: 0.04, longitudeDelta: 0.04 }
            : FALLBACK_REGION
        }
        customMapStyle={DARK_MAP_STYLE}
        userInterfaceStyle="dark"
        showsMyLocationButton={false}
        toolbarEnabled={false}
        zoomControlEnabled={false}
        showsCompass={false}
        showsScale={false}
        showsIndoors={false}
        showsIndoorLevelPicker={false}
        showsTraffic={false}
        loadingEnabled
        loadingBackgroundColor="#0F1512"
        onMapReady={() => setMapReady(true)}
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
});
