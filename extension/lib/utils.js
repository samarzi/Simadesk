/**
 * SimaDesk Extension — общие утилиты для content scripts.
 * Доступны глобально через window.SD_UTILS
 */
(() => {
  'use strict';

  // Не регистрируем дважды
  if (window.__SD_UTILS_LOADED) return;
  window.__SD_UTILS_LOADED = true;

  // ── Логирование → background → SimaDesk UI ──────────────────────────────

  function log(level, icon, text) {
    const ts = new Date().toLocaleTimeString('ru-RU');
    const line = `[${ts}] ${icon} ${text}`;
    console.log(`[SimaDesk] ${line}`);
    try {
      chrome.runtime.sendMessage({ type: 'log', level, text: line });
    } catch { /* extension context invalidated */ }
  }

  // ── Ожидание ────────────────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function waitForSelector(selector, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);

      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) { observer.disconnect(); clearTimeout(timer); resolve(el); }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`waitForSelector timeout: ${selector}`));
      }, timeout);
    });
  }

  function waitForSelectorGone(selector, timeout = 30000) {
    return new Promise((resolve) => {
      const check = () => !document.querySelector(selector);
      if (check()) return resolve();

      const observer = new MutationObserver(() => {
        if (check()) { observer.disconnect(); clearTimeout(timer); resolve(); }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      const timer = setTimeout(() => {
        observer.disconnect();
        resolve(); // resolve even on timeout
      }, timeout);
    });
  }

  // ── Нормализация текста ─────────────────────────────────────────────────

  function normalize(text) {
    if (!text) return '';
    let t = text.toLowerCase().trim();
    t = t.replace(/ё/g, 'е');
    t = t.replace(/[•·\t\r\n]+/g, ' ');
    t = t.replace(/\bг\.?\s*/g, '');
    t = t.replace(/\bгород\b/g, '');
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }

  // ── DOM-хелперы ─────────────────────────────────────────────────────────

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return [...(root || document).querySelectorAll(sel)]; }

  function clickEl(el) {
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click',     { bubbles: true }));
    return true;
  }

  function fillInput(input, value) {
    if (!input) return false;
    const nativeSet = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeSet.call(input, value);
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function clearInput(input) {
    if (!input) return;
    fillInput(input, '');
  }

  // ── Прогресс ────────────────────────────────────────────────────────────

  function sendProgress(data) {
    try {
      chrome.runtime.sendMessage({ type: 'progress', ...data });
    } catch { /* context invalidated */ }
  }

  function sendStatus(status, detail) {
    try {
      chrome.runtime.sendMessage({ type: 'status', status, detail });
    } catch {}
  }

  // ── Спиннер / загрузка ──────────────────────────────────────────────────

  async function waitForSpinner(timeout = 30000) {
    const spinnerSel = '[data-tid="7cb56119"], div[class*="spinner"], div[class*="Spinner"], svg[class*="spin"]';
    const spinner = document.querySelector(spinnerSel);
    if (spinner) {
      await waitForSelectorGone(spinnerSel, timeout);
      await sleep(300);
    }
  }

  // ── Публичный API ──────────────────────────────────────────────────────

  window.SD = {
    log: {
      info:  (text) => log('info',  '',  text),
      ok:    (text) => log('info',  '✅', text),
      warn:  (text) => log('warn',  '⚠️', text),
      error: (text) => log('error', '❌', text),
      step:  (text) => log('info',  '→',  text),
    },
    sleep,
    waitForSelector,
    waitForSelectorGone,
    waitForSpinner,
    normalize,
    $, $$,
    clickEl,
    fillInput,
    clearInput,
    sendProgress,
    sendStatus,
  };
})();
