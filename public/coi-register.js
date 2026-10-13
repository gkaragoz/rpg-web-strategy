/*
 * If the page is not cross-origin isolated (Pages etc.), registers the service worker and reloads once.
 * If that fails, the game runs the sim on the main thread (automatic fallback).
 */
(function () {
  if (window.crossOriginIsolated || !('serviceWorker' in navigator)) return;
  if (!window.isSecureContext) return;
  var flag = 'rpgweb.coi.reloaded';
  try {
    if (sessionStorage.getItem(flag)) return;
  } catch (e) {
    /* no storage available */
  }
  navigator.serviceWorker
    .register(new URL('coi-sw.js', document.currentScript.src).href)
    .then(function (reg) {
      var go = function () {
        try {
          sessionStorage.setItem(flag, '1');
        } catch (e) {
          /* ignore */
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
      /* fallback: sim on the main thread */
    });
})();
