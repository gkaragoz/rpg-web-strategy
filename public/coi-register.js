/*
 * Sayfa cross-origin isolated degilse (Pages vb.) service worker'i kaydeder ve bir kez yeniden yukler.
 * Basarisiz olursa oyun sim'i ana thread'de calistirir (otomatik yedek).
 */
(function () {
  if (window.crossOriginIsolated || !('serviceWorker' in navigator)) return;
  if (!window.isSecureContext) return;
  var flag = 'rpgweb.coi.reloaded';
  try {
    if (sessionStorage.getItem(flag)) return;
  } catch (e) {
    /* depolama yok */
  }
  navigator.serviceWorker
    .register(new URL('coi-sw.js', document.currentScript.src).href)
    .then(function (reg) {
      var go = function () {
        try {
          sessionStorage.setItem(flag, '1');
        } catch (e) {
          /* yoksay */
        }
        location.reload();
      };
      if (reg.active && !navigator.serviceWorker.controller) go();
      else
        reg.addEventListener('updatefound', function () {
          var w = reg.installing;
          if (w)
            w.addEventListener('statechange', function () {
              if (w.state === 'activated') go();
            });
        });
    })
    .catch(function () {
      /* yedek: ana thread sim */
    });
})();
