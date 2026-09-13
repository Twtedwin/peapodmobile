/**
 * Transport-facing data contracts.
 *
 * UI code consumes these models rather than database rows. A future server or
 * database migration can translate its responses in services/apiClient.ts
 * without teaching screens about persistence details.
 */

export interface User {
  id: string;
  email?: string;
  display_name: string;
  avatar_url?: string | null;
}

export interface AuthenticatedUser extends User {
  email: string;
  avatar_url: string | null;
  permissions_granted: boolean;
  role: 'admin' | 'user';
}

export interface Pod {
  id: string;
  name: string;
  emoji?: string;
  group_type?: 'couple' | 'family' | 'friends';
  my_role?: 'admin' | 'member';
}

export interface PodMember extends User {
  membership_id: string;
  user_id: string;
  role?: 'admin' | 'member';
  emoji?: string;
  user?: User;
}

export interface LocationData {
  latitude: number;
  longitude: number;
  speed: number;
  accuracy: number;
  heading: number;
  recorded_at?: string;
}

export interface PhoneStatus {
  battery_level?: number;
  is_charging?: boolean;
  connection_type?: string;
  signal_bars?: number;
}

export interface Presence extends Partial<LocationData>, PhoneStatus {
  user_id: string;
  online?: boolean;
  last_seen_at?: string;
  updated_at?: string;
}

export interface Place {
  id: string;
  name: string;
  address?: string | null;
  latitude: number;
  longitude: number;
  radius_m?: number;
}

export interface Message {
  id: string;
  text: string;
  created_by_id: string;
  recipient_id: string | null;
  pod_id: string | null;
  created_at: string;
  updated_at?: string;
}
