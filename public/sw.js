// Zineedo push notification service worker.
// Deliberately minimal: this file's only job is to receive a push event from the browser's push
// service and turn it into a visible OS notification, then route a click on that notification back
// into the app. It does NOT do offline caching or asset precaching — Zineedo isn't an offline-first
// app, so a service worker that silently serves stale cached pages would cause more confusion
// (seeing old data) than it would ever save in load time. Scope is implicitly "/" since this file
// lives at the site root, which is required for it to receive pushes for the whole site rather than
// just one subpath.

self.addEventListener('push', (event) => {
  let data = { title: 'Zineedo', body: 'You have a new notification', url: '/' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    // Not JSON (shouldn't happen — server always sends JSON.stringify'd payloads) — fall back to
    // the defaults above rather than throwing and dropping the notification entirely.
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/assets/brand/zineedo-mark.svg',
      badge: '/assets/brand/zineedo-mark.svg',
      data: { url: data.url || '/' },
    })
  );
});

// Clicking the OS notification focuses an already-open Zineedo tab if one exists, rather than
// always opening a new one — matches how most notification-driven apps behave, and avoids a user
// ending up with five Zineedo tabs just from clicking notifications over a day.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
