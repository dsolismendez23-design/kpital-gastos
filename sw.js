// Service worker mínimo: no cachea nada, solo existe para que el navegador
// permita instalar la app en la pantalla de inicio (requisito técnico de PWA).
self.addEventListener('fetch', function (event) {
  event.respondWith(fetch(event.request));
});
