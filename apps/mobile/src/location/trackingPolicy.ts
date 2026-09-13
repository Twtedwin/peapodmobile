/**
 * Pure runtime policy shared by the task registrar and tests.
 */

export function trackingMode(appOwnership?: string): 'foreground-only' | 'background-capable' {
  return appOwnership === 'expo' ? 'foreground-only' : 'background-capable';
}
