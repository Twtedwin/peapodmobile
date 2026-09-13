/**
 * Print a LAN IPv4 address this machine can be reached at from a phone on
 * the same Wi-Fi. Expo Go on a physical device cannot use localhost.
 */
import os from 'node:os';

const nets = os.networkInterfaces();
const preferred = [];
const fallback = [];

for (const entries of Object.values(nets)) {
  if (!entries) continue;
  for (const entry of entries) {
    if (entry.family !== 'IPv4' || entry.internal) continue;
    if (entry.address.startsWith('169.254.')) continue;
    const row = { address: entry.address };
    if (
      entry.address.startsWith('192.168.') ||
      entry.address.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(entry.address)
    ) {
      preferred.push(row);
    } else {
      fallback.push(row);
    }
  }
}

const chosen = preferred[0] ?? fallback[0];
if (!chosen) {
  console.log('127.0.0.1');
  process.exit(0);
}
console.log(chosen.address);
