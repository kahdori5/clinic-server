self.addEventListener('install', (e) => {
    console.log('[Service Worker] Install');
});
self.addEventListener('fetch', (e) => {
    // Service Worker بسيط لتمرير المتطلبات فقط والسماح بالتثبيت
});