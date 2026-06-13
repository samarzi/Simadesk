/**
 * Runs in ISOLATED world — has access to chrome.runtime.id.
 * Passes extension ID to MAIN world via data attribute.
 */
document.documentElement.dataset.simadeskExtId = chrome.runtime.id;
