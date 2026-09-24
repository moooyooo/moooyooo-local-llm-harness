// Browser notifications for "turn finished" / "permission needed".
// localhost counts as a secure context, so the Notification API is available without HTTPS.

export function notificationsSupported(): boolean {
  return typeof Notification !== 'undefined';
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return notificationsSupported() ? Notification.permission : 'unsupported';
}

/** Must be called from a user gesture (click). */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

/** True when the user isn't looking at this page, so an in-page indicator alone would be missed. */
export function pageInBackground(): boolean {
  return document.hidden || !document.hasFocus();
}

/**
 * @param tag notifications with the same tag replace each other (one per tab and kind)
 * @param onClick called after the window is focused
 */
export function showNotification(title: string, body: string, tag: string, onClick: () => void) {
  if (notificationPermission() !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  } catch {
    // e.g. blocked by OS focus assist; the tab title still shows the state
  }
}
