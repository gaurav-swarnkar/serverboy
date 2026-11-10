// This device: the installable app (service worker), push notifications and "Install app".
import { api } from './ui.js';

let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  window.dispatchEvent(new Event('sb:installable'));
});

export const swSupported = () => 'serviceWorker' in navigator;
export const pushSupported = () => swSupported() && 'PushManager' in window && 'Notification' in window;
export const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const canInstall = () => Boolean(installEvent);

export async function registerServiceWorker() {
  if (!swSupported() || !window.isSecureContext) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    // A tapped notification on browsers without client.navigate().
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'open' && e.data.url) location.href = e.data.url;
    });
    return reg;
  } catch {
    return null;
  }
}

export async function install() {
  if (!installEvent) return false;
  installEvent.prompt();
  const { outcome } = await installEvent.userChoice;
  installEvent = null;
  return outcome === 'accepted';
}

const keyBytes = (b64) => {
  const raw = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

// Why push cannot work here, in plain words (or null when it can).
export function pushBlocker() {
  if (!window.isSecureContext) return 'Notifications need Serverboy to be opened over https.';
  if (isIOS() && !isStandalone()) return 'On iPhone and iPad: tap Share → Add to Home Screen, open Serverboy from the Home Screen, then turn notifications on there.';
  if (!pushSupported()) return 'This browser does not support notifications.';
  if (Notification.permission === 'denied') return 'Notifications are blocked for Serverboy in this browser. Allow them in the site settings (the lock icon next to the address), then try again.';
  return null;
}

export async function enablePush() {
  const blocked = pushBlocker();
  if (blocked) throw new Error(blocked);
  const reg = (await navigator.serviceWorker.getRegistration('/')) || (await registerServiceWorker());
  if (!reg) throw new Error('The Serverboy app could not start in this browser.');
  await navigator.serviceWorker.ready;
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications were not allowed.');
  const { publicKey } = await api('/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  return api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}
