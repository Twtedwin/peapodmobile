/**
 * MODULE: apps/mobile/src/components/Field.tsx
 *
 * PURPOSE
 *   Labelled text input used on auth and create-plan forms. One component
 *   so keyboard type, placeholder colour, and height stay consistent.
 *
 * INPUTS  : label, value, onChangeText, secure, keyboardType, autoCapitalize
 * OUTPUTS : a View wrapping TextInput
 * CONSUMED BY : login, register, forgot/reset password, You, trip wizard
 */

import { StyleSheet, Text, TextInput, View, type KeyboardTypeOptions } from 'react-native';

import { useSession } from '@/store/session';
import { radius, spacing, themeColors } from '@/theme';

interface Props {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  secure?: boolean;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: 'none' | 'words' | 'sentences' | 'characters';
  autoFocus?: boolean;
  editable?: boolean;
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  secure,
  keyboardType,
  autoCapitalize = 'none',
  autoFocus,
  editable = true,
}: Props) {
  const dark = useSession((s) => s.darkMode);
  const colors = themeColors(dark);

  return (
    <View style={{ gap: spacing.xs }}>
      <Text style={{ color: colors.textMuted, fontSize: 13, fontWeight: '600' }}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        secureTextEntry={secure}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        autoFocus={autoFocus}
        editable={editable}
        style={[
          styles.input,
          {
            color: colors.text,
            backgroundColor: colors.card,
            borderColor: colors.cardBorder,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    fontSize: 16,
  },
});
