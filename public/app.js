// Minimal progressive enhancement — the site works fully without it.
(function () {
  'use strict';
  var year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());
})();
