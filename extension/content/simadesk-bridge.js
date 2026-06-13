/**
 * Bridge: runs in MAIN world, sets extension ID on window.
 * Extension ID is passed via DOM element to avoid CSP issues.
 */
window.__SIMADESK_EXTENSION_ID = document.documentElement.dataset.simadeskExtId;
delete document.documentElement.dataset.simadeskExtId;
