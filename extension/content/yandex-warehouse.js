/**
 * Яндекс Маркет — автоматизация настройки доставки (склады).
 * Порт я_склады.py на JavaScript для Chrome Extension.
 *
 * Инжектится в MAIN world → полный доступ к DOM страницы.
 * Связь с background через CustomEvent → sd-log / sd-status / sd-progress.
 *
 * ВАЖНО: НЕ используем window.location.reload() — это убивает скрипт.
 * Вместо этого: после сохранения (drawer закрывается) → открываем drawer снова.
 */
(() => {
  'use strict';
  if (window.__SD_YA_WH_RUNNING) return;
  window.__SD_YA_WH_RUNNING = true;

  // ── Константы ───────────────────────────────────────────────────────────
  const INPUT_VALUE = '20';
  const AFTER_CLICK_MS = 250;
  const AFTER_SPINNER_MS = 150;

  const FEDERAL_DISTRICTS = [
    'Центральный федеральный округ',
    'Северо-Западный федеральный округ',
    'Южный федеральный округ',
    'Северо-Кавказский федеральный округ',
    'Приволжский федеральный округ',
    'Уральский федеральный округ',
    'Сибирский федеральный округ',
    'Дальневосточный федеральный округ',
  ];

  // ── Утилиты логирования (MAIN world → ISOLATED world) ──────────────────

  let stopped = false;

  function log(text) {
    const ts = new Date().toLocaleTimeString('ru-RU');
    const line = `[${ts}] ${text}`;
    console.log('[SimaDesk:YaWH]', line);
    window.dispatchEvent(new CustomEvent('sd-log', { detail: { text: line } }));
  }

  function setStatus(status, detail) {
    window.dispatchEvent(new CustomEvent('sd-status', { detail: { status, detail } }));
  }

  function sendProgress(done, total, label) {
    window.dispatchEvent(new CustomEvent('sd-progress', { detail: { done, total, label } }));
  }

  function checkStop() {
    if (window.__SD_STOP || stopped) {
      stopped = true;
      throw new Error('STOPPED');
    }
  }

  // ── DOM утилиты ─────────────────────────────────────────────────────────

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

  // ── Спиннер ─────────────────────────────────────────────────────────────

  async function waitForSpinner(timeout = 30000) {
    const sel = '[data-tid="7cb56119"], div[class*="spinner"], div[class*="Spinner"], svg[class*="spin"]';
    try {
      // Ждём появления спиннера (не более 1.5с)
      const start = Date.now();
      let found = false;
      while (Date.now() - start < 1500) {
        if (document.querySelector(sel)) { found = true; break; }
        await sleep(100);
      }
      if (!found) return;
      // Ждём исчезновения
      while (document.querySelector(sel) && Date.now() - start < timeout) {
        await sleep(200);
      }
      await sleep(AFTER_SPINNER_MS);
    } catch {}
  }

  // Быстрая проверка спиннера (макс 5 сек, для промежуточных шагов пути)
  async function waitForSpinnerFast() {
    const sel = '[data-tid="7cb56119"], div[class*="spinner"], div[class*="Spinner"], svg[class*="spin"]';
    const start = Date.now();
    // Ждём появления спиннера макс 500мс
    let found = false;
    while (Date.now() - start < 500) {
      if (document.querySelector(sel)) { found = true; break; }
      await sleep(100);
    }
    if (!found) return;
    // Ждём исчезновения макс 5 сек
    while (document.querySelector(sel) && Date.now() - start < 5000) {
      await sleep(150);
    }
    await sleep(150);
  }

  // ── Drawer ──────────────────────────────────────────────────────────────

  function isDrawerOpen() {
    // Проверяем наличие кнопок раскрытия дерева (основной признак)
    if (document.querySelectorAll('tr[data-e2e="levitan-table-row"] button[aria-expanded]').length > 0) return true;
    // Много строк = дерево загружено
    if (document.querySelectorAll('tr[data-e2e="levitan-table-row"]').length > 5) return true;
    // Альтернативные признаки: drawer wrapper + строки таблицы любого типа
    const wrapper = document.querySelector('[data-e2e="levitan-drawer-wrapper"]');
    if (wrapper) {
      const rows = wrapper.querySelectorAll('tr');
      if (rows.length > 3) return true;
      // Или кнопки aria-expanded где угодно внутри wrapper
      if (wrapper.querySelectorAll('button[aria-expanded]').length > 0) return true;
    }
    // Ещё один fallback: кнопка «Сохранить» = drawer открыт
    if (document.querySelector("button[data-e2e='DeliverySettingsByCouriersDrawer_submit']")) return true;
    return false;
  }

  function lockDrawer() {
    if (window.__drawer_locked) return;
    window.__drawer_locked = true;
    // Блокируем клики на overlay
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (t.hasAttribute('data-vaul-overlay') || t.closest('[data-vaul-overlay]') ||
          (t.getAttribute && t.getAttribute('data-state') === 'open' &&
           !t.closest('tr[data-e2e="levitan-table-row"]') && !t.closest('button') && !t.closest('input'))) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    }, true);
    // Блокируем Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.querySelectorAll('tr[data-e2e="levitan-table-row"]').length > 0) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    }, true);
    // Pointer events на overlay
    const style = document.createElement('style');
    style.id = '__drawer_lock_style';
    style.textContent = '[data-vaul-overlay] { pointer-events: none !important; }';
    document.head.appendChild(style);
    log('→ Drawer lock установлен');
  }

  function dismissOverlays() {
    const sels = ['[class*="overlay"]', '[data-tid="a018d5b9"]', '[class*="___content___4Arvd"]'];
    for (const sel of sels) {
      document.querySelectorAll(sel).forEach(el => {
        if (el.style) el.style.pointerEvents = 'none';
      });
    }
  }

  async function waitForPageReady() {
    log('→ Ожидание загрузки страницы...');
    // Ждём появления любых кнопок на странице (React рендер)
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const btns = document.querySelectorAll('button');
      if (btns.length > 3) {
        log(`→ Страница загружена (${btns.length} кнопок)`);
        return;
      }
    }
    log('⚠️ Таймаут ожидания загрузки страницы');
  }

  async function openDrawer() {
    if (isDrawerOpen()) {
      log('✅ Drawer уже открыт');
      lockDrawer();
      return true;
    }

    log('→ Ищем кнопку «Настроить»...');
    dismissOverlays();

    const selectors = [
      "button[data-e2e='couriers-delivery-regions-drawer']",
      "button[data-e2e*='delivery'][data-e2e*='drawer']",
      "button[data-e2e*='courier']",
    ];

    for (let attempt = 1; attempt <= 10; attempt++) {
      checkStop();
      log(`→ Попытка ${attempt}/10`);

      // Ждём стабилизации DOM — как в Python (networkidle аналог)
      await sleep(2000);
      dismissOverlays();
      let clicked = false;

      // По data-e2e селекторам
      for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (btn && btn.offsetParent !== null) {
          const actualE2e = btn.getAttribute('data-e2e') || '';
          const btnText = btn.textContent.trim().substring(0, 60);
          log(`→ Найдена кнопка: ${sel} (data-e2e="${actualE2e}", text="${btnText}")`);
          btn.scrollIntoView({ block: 'center' });
          await sleep(500);
          dismissOverlays();
          // Пробуем обычный клик
          try { btn.click(); } catch {}
          // Fallback JS клик
          ['mousedown', 'mouseup', 'click'].forEach(type => {
            btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
          });
          clicked = true;
          break;
        }
      }

      // Fallback по тексту — ищем все кнопки с текстом «Настроить»
      if (!clicked) {
        log('→ Кнопка не найдена по data-e2e, ищем по тексту...');
        const buttons = [...document.querySelectorAll('button')];
        // Ищем последнюю видимую кнопку с текстом «Настроить»
        const textBtn = buttons.reverse().find(b => {
          if (b.offsetParent === null) return false;
          const t = b.textContent.trim().toLowerCase();
          return (t.includes('настроить')) && !t.includes('показать');
        });
        if (textBtn) {
          log('→ Найдена кнопка по тексту «Настроить»');
          textBtn.scrollIntoView({ block: 'center' });
          await sleep(500);
          dismissOverlays();
          textBtn.click();
          ['mousedown', 'mouseup', 'click'].forEach(type => {
            textBtn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
          });
          clicked = true;
        }
      }

      // Fallback по aria-label / title
      if (!clicked) {
        const allBtns = [...document.querySelectorAll('button, [role="button"], a[href*="delivery"]')];
        const regionBtn = allBtns.find(b => {
          if (b.offsetParent === null) return false;
          const text = (b.textContent + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).toLowerCase();
          return text.includes('регион') || text.includes('доставк') || text.includes('курьер');
        });
        if (regionBtn) {
          log('→ Найдена кнопка по ключевым словам (регион/доставка/курьер)');
          regionBtn.scrollIntoView({ block: 'center' });
          await sleep(500);
          regionBtn.click();
          clicked = true;
        }
      }

      if (clicked) {
        log('→ Клик выполнен, ждём открытия drawer...');
        // Ждём появления строк дерева до 30 сек
        for (let tick = 0; tick < 60; tick++) {
          await sleep(500);
          if (isDrawerOpen()) {
            log('✅ Drawer открыт!');
            await waitForSpinner();
            lockDrawer();
            return true;
          }
          // Диагностика каждые 5 сек
          if (tick % 10 === 9) {
            const diag = {
              'tr[data-e2e="levitan-table-row"]': document.querySelectorAll('tr[data-e2e="levitan-table-row"]').length,
              'tr (all)': document.querySelectorAll('tr').length,
              'aria-expanded': document.querySelectorAll('button[aria-expanded]').length,
              'drawer-wrapper': !!document.querySelector('[data-e2e="levitan-drawer-wrapper"]'),
              'save-btn': !!document.querySelector("button[data-e2e='DeliverySettingsByCouriersDrawer_submit']"),
              'levitan-row': document.querySelectorAll('tr[data-e2e="levitan-table-row"]').length,
              'vaul-drawer': !!document.querySelector('[data-vaul-drawer]'),
              'dialog/sheet': document.querySelectorAll('[role="dialog"], [data-state="open"]').length,
            };
            log(`→ Диагностика DOM: ${JSON.stringify(diag)}`);
          }
        }
        log('⚠️ Drawer не открылся после клика (30 сек)');
      } else {
        log('⚠️ Кнопка «Настроить» не найдена на странице');
        // Логируем все кнопки для отладки
        if (attempt <= 2) {
          const allBtnTexts = [...document.querySelectorAll('button')]
            .filter(b => b.offsetParent !== null)
            .map(b => b.textContent.trim().substring(0, 50))
            .filter(t => t.length > 0);
          log(`→ Видимые кнопки: ${allBtnTexts.slice(0, 15).join(' | ')}`);
          // Логируем data-e2e атрибуты
          const e2eBtns = [...document.querySelectorAll('[data-e2e]')]
            .map(el => el.getAttribute('data-e2e'))
            .filter(Boolean);
          log(`→ data-e2e элементы: ${e2eBtns.slice(0, 15).join(' | ')}`);
        }
      }

      dismissOverlays();
      await sleep(3000);
      if (isDrawerOpen()) { lockDrawer(); return true; }
    }

    log('❌ Не удалось открыть drawer автоматически');
    // Ждём ручного открытия до 120 сек
    log('⏳ Ожидание ручного открытия (2 мин)...');
    for (let i = 0; i < 240; i++) {
      await sleep(500);
      if (isDrawerOpen()) {
        log('✅ Drawer открыт вручную');
        lockDrawer();
        return true;
      }
    }
    throw new Error('Не удалось открыть drawer');
  }

  // ── Работа со строками дерева ───────────────────────────────────────────

  function getRowText(row) {
    const td = row.querySelector('td');
    const text = (td ? td.textContent : row.textContent) || '';
    return text.trim().replace(/\s+/g, ' ');
  }

  function rowIsExpandable(row) {
    return !!row.querySelector('button[aria-expanded]');
  }

  function rowIsExpanded(row) {
    const btn = row.querySelector('button[aria-expanded]');
    return btn ? btn.getAttribute('aria-expanded') === 'true' : false;
  }

  function rowIsCity(row) {
    return !rowIsExpandable(row);
  }

  function scrollToRowInDrawer(row) {
    const drawer = document.querySelector('[data-e2e="levitan-drawer-wrapper"]');
    if (!drawer) return;
    const container = drawer.querySelector('[style*="overflow"]') || drawer;
    const rowRect = row.getBoundingClientRect();
    const contRect = container.getBoundingClientRect();
    if (rowRect.top < contRect.top || rowRect.bottom > contRect.bottom) {
      container.scrollTop += (rowRect.top - contRect.top) - 100;
    }
  }

  function scrollDrawerGently() {
    const drawer = document.querySelector('[data-e2e="levitan-drawer-wrapper"]');
    if (!drawer) return;
    const container = drawer.querySelector('[style*="overflow"]') || drawer;
    const old = container.scrollTop;
    container.scrollTop += 50;
    setTimeout(() => { container.scrollTop = old; }, 100);
  }

  async function clickExpandRow(row) {
    const btn = row.querySelector("button[aria-expanded='false']");
    if (!btn) return false;
    scrollToRowInDrawer(row);
    await sleep(150);
    btn.click();
    await sleep(AFTER_CLICK_MS);
    await waitForSpinner();
    return true;
  }

  function findDistrictRow(districtName) {
    const norm = normalize(districtName);
    const rows = [...document.querySelectorAll('tr[data-e2e="levitan-table-row"]')];

    // Точное совпадение
    for (const r of rows) {
      if (!rowIsExpandable(r)) continue;
      if (normalize(getRowText(r)) === norm) return r;
    }
    // Частичное
    for (const r of rows) {
      if (!rowIsExpandable(r)) continue;
      const txt = normalize(getRowText(r));
      if (norm.includes(txt) || txt.includes(norm)) return r;
    }
    return null;
  }

  async function waitForTreeRows(timeoutMs = 60000) {
    log('→ Ожидание загрузки дерева регионов...');
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const rows = document.querySelectorAll('tr[data-e2e="levitan-table-row"]');
      if (rows.length > 0) {
        log(`→ Дерево загружено: ${rows.length} строк`);
        await sleep(500); // дать DOM стабилизироваться
        return true;
      }
      await sleep(500);
    }
    // Fallback: проверяем другие селекторы
    const wrapper = document.querySelector('[data-e2e="levitan-drawer-wrapper"]');
    if (wrapper) {
      const anyRows = wrapper.querySelectorAll('tr');
      log(`⚠️ tr[data-e2e="levitan-table-row"]: 0, но tr в drawer: ${anyRows.length}`);
      if (anyRows.length > 0) {
        // Логируем атрибуты первых строк для диагностики
        const attrs = [...anyRows].slice(0, 5).map(r => {
          const attrList = [...r.attributes].map(a => `${a.name}="${a.value}"`).join(' ');
          return `<tr ${attrList}> text="${r.textContent.trim().substring(0, 40)}"`;
        });
        log(`→ Строки в drawer: ${attrs.join(' | ')}`);
        return true;
      }
    }
    log('❌ Дерево не загрузилось за 60 сек');
    return false;
  }

  async function ensureRootExpanded() {
    // Ждём появления строк с кнопками раскрытия
    for (let attempt = 0; attempt < 20; attempt++) {
      const rows = document.querySelectorAll('tr[data-e2e="levitan-table-row"]');
      if (rows.length === 0) {
        if (attempt === 0) log('→ Строк tr[data-e2e="levitan-table-row"] пока нет, ждём...');
        await sleep(1000);
        continue;
      }
      for (let i = 0; i < Math.min(10, rows.length); i++) {
        const r = rows[i];
        if (rowIsExpandable(r)) {
          if (rowIsExpanded(r)) {
            log(`✅ Корень раскрыт: "${getRowText(r)}"`);
            return true;
          }
          log(`→ Раскрываем корень: "${getRowText(r)}"`);
          return clickExpandRow(r);
        }
      }
      // Строки есть, но без кнопок раскрытия
      if (attempt < 5) {
        log(`→ ${rows.length} строк, но кнопок раскрытия нет. Ожидание...`);
        await sleep(1500);
      }
    }
    // Диагностика
    const rows = document.querySelectorAll('tr[data-e2e="levitan-table-row"]');
    log(`⚠️ ensureRootExpanded не удалось. Строк: ${rows.length}`);
    if (rows.length > 0) {
      const first5 = [...rows].slice(0, 5).map(r => `"${getRowText(r).substring(0, 50)}" expandable=${rowIsExpandable(r)} expanded=${rowIsExpanded(r)}`);
      log(`→ Первые строки: ${first5.join(' | ')}`);
    }
    return false;
  }

  // ── Заполнение значения в поле ввода строки ─────────────────────────────

  function setValueInRow(row, value = INPUT_VALUE) {
    const inputs = row.querySelectorAll(
      "input[type='text'], input[type='number'], input[inputmode='text'], input[inputmode='numeric']"
    );
    if (!inputs.length) return false;

    let target = null;
    for (const inp of inputs) {
      if (inp.offsetParent === null) continue;
      if (inp.readOnly || inp.disabled) continue;
      const ph = (inp.placeholder || '').toLowerCase();
      const val = (inp.value || '').toLowerCase();
      if (ph.includes('единые') || val.includes('единые')) continue;
      if (inp.value === value) return true; // уже заполнено
      if (ph.includes('разное')) { target = inp; break; }
      if (!target) target = inp;
    }
    if (!target) return false;

    // Множественные стратегии заполнения (как в Python)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        target.focus();
        target.click();

        // Стратегия 1: нативный setter для React
        const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSet.call(target, value);
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        target.blur();
        if (target.value === value) return true;

        // Стратегия 2: select all + type
        target.focus();
        target.select();
        document.execCommand('selectAll');
        document.execCommand('insertText', false, value);
        target.blur();
        if (target.value === value) return true;

        // Стратегия 3: прямое присвоение + dispatch
        target.value = value;
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        target.blur();
        if (target.value === value) return true;
      } catch {}
    }

    return target.value === value;
  }

  // ── Сохранение ──────────────────────────────────────────────────────────

  function blurActiveInput() {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
      active.blur();
    }
  }

  async function savePageChanges() {
    blurActiveInput();
    await sleep(1000);

    for (let attempt = 0; attempt < 4; attempt++) {
      checkStop();
      log(`→ Ищем кнопку «Сохранить» (попытка ${attempt + 1})...`);

      const btn = document.querySelector(
        "button[data-e2e='DeliverySettingsByCouriersDrawer_submit']"
      );
      if (!btn) {
        log('⚠️ Кнопка «Сохранить» не найдена');
        await sleep(2000);
        continue;
      }
      if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
        log('⚠️ Кнопка disabled, ждём активации...');
        await sleep(2500);
        continue;
      }

      btn.scrollIntoView({ block: 'center', behavior: 'instant' });
      await sleep(300);
      // Множественные события для надёжности
      ['mousedown', 'mouseup', 'click'].forEach(type => {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
      });

      log('→ Клик по «Сохранить» выполнен, ждём закрытия drawer...');

      // Ждём закрытия drawer — до 30 секунд
      for (let tick = 0; tick < 60; tick++) {
        await sleep(500);
        const saveBtn = document.querySelector(
          "button[data-e2e='DeliverySettingsByCouriersDrawer_submit']"
        );
        const nastroit = document.querySelector(
          "button[data-e2e='couriers-delivery-regions-drawer']"
        );
        const rows = document.querySelectorAll('tr[data-e2e="levitan-table-row"]').length;

        // Drawer закрыт если: кнопка «Настроить» видна И (строк нет ИЛИ кнопки «Сохранить» нет)
        if (nastroit?.offsetParent !== null && (rows === 0 || !saveBtn)) {
          log('✅ Drawer закрыт, изменения сохранены!');
          // Сбрасываем lock чтобы при переоткрытии заработал заново
          window.__drawer_locked = false;
          const lockStyle = document.getElementById('__drawer_lock_style');
          if (lockStyle) lockStyle.remove();
          await sleep(1500);
          return true;
        }
      }
      log(`⚠️ Drawer не закрылся за 30 сек (попытка ${attempt + 1})`);
    }

    log('⚠️ Автосохранение не сработало');
    // Ждём ручного сохранения до 60 сек
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      if (!isDrawerOpen()) {
        window.__drawer_locked = false;
        return true;
      }
    }
    return false;
  }

  // ── Получение свёрнутых узлов (пакетами) ────────────────────────────────

  function getCollapsedBatch(otherDistricts, batch = 3) {
    const rows = [...document.querySelectorAll('tr[data-e2e="levitan-table-row"]')];
    const result = [];
    for (let i = 0; i < rows.length && result.length < batch; i++) {
      const btn = rows[i].querySelector("button[aria-expanded='false']");
      if (!btn || btn.offsetParent === null) continue;
      const text = (rows[i].querySelector('td')?.textContent || '').trim();
      const isOther = otherDistricts.some(d => text.includes(d) || d.includes(text));
      if (!isOther) result.push({ idx: i, text });
    }
    return result;
  }

  // ── Основной алгоритм: раскрытие округа + заполнение городов ────────────

  async function expandAndFillDistrict(districtName, citiesDict, doneCities, totalCities, filledCount) {
    const allRows = [...document.querySelectorAll('tr[data-e2e="levitan-table-row"]')];
    const expandableRows = allRows.filter(r => rowIsExpandable(r));
    log(`→ Поиск округа: "${districtName}" среди ${allRows.length} строк (${expandableRows.length} раскрываемых)`);
    if (expandableRows.length > 0 && expandableRows.length <= 15) {
      const names = expandableRows.map(r => `"${getRowText(r).substring(0, 50)}"`);
      log(`→ Раскрываемые строки: ${names.join(', ')}`);
    }

    const districtRow = findDistrictRow(districtName);
    if (!districtRow) {
      log(`⚠️ Округ не найден: ${districtName}`);
      return { expanded: 0, filled: 0 };
    }

    if (!rowIsExpanded(districtRow)) {
      log(`→ Раскрываем: ${districtName}`);
      await clickExpandRow(districtRow);
    } else {
      log(`→ Уже раскрыт: ${districtName}`);
    }

    let totalExpanded = 1;
    let districtFilled = 0;
    let roundsNoChange = 0;
    const otherDistricts = FEDERAL_DISTRICTS.filter(d => d !== districtName);

    function scanAndFill() {
      const rows = document.querySelectorAll('tr[data-e2e="levitan-table-row"]');
      for (const r of rows) {
        if (!rowIsCity(r)) continue;
        const cityNorm = normalize(getRowText(r));
        if (!citiesDict[cityNorm]) continue;
        if (doneCities.has(cityNorm)) continue;

        if (setValueInRow(r)) {
          districtFilled++;
          filledCount.value++;
          doneCities.add(cityNorm);
          sendProgress(filledCount.value, totalCities, districtName);
          log(`✅ [${filledCount.value}/${totalCities}] ${citiesDict[cityNorm]} — заполнено`);
        }
      }
    }

    for (let iteration = 0; iteration < 100; iteration++) {
      checkStop();

      // Проверяем что drawer не закрылся
      if (!isDrawerOpen()) {
        log('⚠️ Drawer закрылся! Переоткрываем...');
        await sleep(2000);
        dismissOverlays();
        if (!await openDrawer()) {
          log('❌ Не удалось переоткрыть drawer');
          break;
        }
        await ensureRootExpanded();
        const row = findDistrictRow(districtName);
        if (row && !rowIsExpanded(row)) await clickExpandRow(row);
      }

      scanAndFill();

      // Периодически мягко скроллим для подгрузки виртуализации
      if (iteration % 5 === 0) scrollDrawerGently();

      const batch = getCollapsedBatch(otherDistricts, 3);
      if (!batch.length) {
        roundsNoChange++;
        if (roundsNoChange >= 2) {
          // Проверяем, есть ли ещё свёрнутые узлы нашего округа
          const still = [...document.querySelectorAll("button[aria-expanded='false']")].some(btn => {
            if (btn.offsetParent === null) return false;
            const row = btn.closest('tr[data-e2e="levitan-table-row"]');
            const text = row?.querySelector('td')?.textContent?.trim() || '';
            return !otherDistricts.some(d => text.includes(d) || d.includes(text));
          });
          if (!still) {
            log(`✅ Все узлы округа раскрыты. Заполнено: ${districtFilled}`);
            break;
          }
          roundsNoChange = 0;
          scrollDrawerGently();
          await sleep(400);
        }
        continue;
      }

      roundsNoChange = 0;
      for (const item of batch) {
        const rows = document.querySelectorAll('tr[data-e2e="levitan-table-row"]');
        if (item.idx < rows.length) {
          if (await clickExpandRow(rows[item.idx])) {
            totalExpanded++;
          }
        }
      }

      if (totalExpanded % 15 === 0) {
        log(`→ Раскрыто: ${totalExpanded} узлов, заполнено: ${districtFilled} городов`);
      }
    }

    // Финальный проход
    scanAndFill();
    return { expanded: totalExpanded, filled: districtFilled };
  }

  // ── Режим С КАРТОЙ: раскрытие по пути из karta.json ────────────────────

  function stripCountSuffix(s) {
    return s.replace(/\s+\d+\s*$/, '').trim();
  }

  function findRowByText(targetText) {
    const target = stripCountSuffix(normalize(targetText));
    const rows = [...document.querySelectorAll('tr[data-e2e="levitan-table-row"]')];
    for (const r of rows) {
      const rowText = stripCountSuffix(normalize(getRowText(r)));
      if (rowText === target) return r;
    }
    // Partial match
    for (const r of rows) {
      const rowText = stripCountSuffix(normalize(getRowText(r)));
      if (rowText.includes(target) || target.includes(rowText)) return r;
    }
    return null;
  }

  async function modeWithMap(cities, karta) {
    log(`→ Режим: С картой (${Object.keys(karta).length} записей в карте)`);

    // Группируем города по округам (как в Python)
    const citiesByDistrict = {};
    const notInMap = [];
    for (const city of cities) {
      const cn = normalize(city);
      const entry = karta[cn];
      if (!entry) { notInMap.push(city); continue; }
      const path = entry.path_original || [];
      let district = '';
      for (const p of path) {
        const pn = normalize(p);
        for (const fd of FEDERAL_DISTRICTS) {
          if (normalize(fd).includes(pn) || pn.includes(normalize(fd))) { district = fd; break; }
        }
        if (district) break;
      }
      if (district) {
        if (!citiesByDistrict[district]) citiesByDistrict[district] = [];
        citiesByDistrict[district].push({ city, path });
      } else {
        notInMap.push(city);
      }
    }

    if (notInMap.length) log(`⚠️ Не в карте: ${notInMap.length} городов`);

    const doneCities = new Set();
    const filledCount = { value: 0 };

    await ensureRootExpanded();

    for (const district of FEDERAL_DISTRICTS) {
      checkStop();
      const entries = citiesByDistrict[district];
      if (!entries || !entries.length) continue;

      // Фильтруем уже сделанные
      const toProcess = entries.filter(e => !doneCities.has(normalize(e.city)));
      if (!toProcess.length) {
        log(`⏩ Все города уже заполнены: ${district}`);
        continue;
      }

      log(`\n═══ ${district} (${toProcess.length} городов) ═══`);

      // Раскрываем округ с повторными попытками (как в Python)
      let districtRow = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        districtRow = findDistrictRow(district);
        if (districtRow) break;
        log(`⏳ Повторная попытка ${attempt + 1} найти округ '${district}'...`);
        await sleep(1500);
        scrollDrawerGently();
      }
      if (!districtRow) {
        log(`❌ Округ не найден после 3 попыток: ${district}`);
        continue;
      }
      if (!rowIsExpanded(districtRow)) {
        scrollToRowInDrawer(districtRow);
        const btn = districtRow.querySelector("button[aria-expanded='false']");
        if (btn) {
          btn.click();
          await sleep(AFTER_CLICK_MS);
          await sleep(500);
        }
      }

      let distFilled = 0;

      for (const entry of toProcess) {
        checkStop();
        const { city, path } = entry;
        const cn = normalize(city);

        sendProgress(filledCount.value, cities.length, city);

        // Проверяем что drawer ещё открыт (как в Python)
        if (!isDrawerOpen()) {
          log('⚠️ Drawer закрылся! Переоткрываем...');
          if (!await openDrawer()) break;
          await waitForTreeRows();
          await ensureRootExpanded();
          districtRow = findDistrictRow(district);
          if (districtRow && !rowIsExpanded(districtRow)) {
            const btn2 = districtRow.querySelector("button[aria-expanded='false']");
            if (btn2) { btn2.click(); await sleep(500); }
          }
        }

        log(`→ [${filledCount.value + 1}/${cities.length}] ${city}`);

        // Идём по шагам пути (пропускаем "Все регионы" и округ — уже раскрыты)
        let pathOk = true;
        for (let stepIdx = 0; stepIdx < path.length; stepIdx++) {
          const stepName = path[stepIdx];
          const stepClean = stripCountSuffix(normalize(stepName));

          // Пропускаем "Все регионы" и федеральный округ (как в Python tariff.py)
          if (stepClean.includes('все регионы') || stepClean.includes('все_регионы')) continue;
          let isDistrictStep = false;
          for (const fd of FEDERAL_DISTRICTS) {
            if (normalize(fd).includes(stepClean) || stepClean.includes(normalize(fd))) { isDistrictStep = true; break; }
          }
          if (isDistrictStep) continue;

          // Ищем строку с повторами (10 попыток, как в Python)
          let foundStep = false;
          for (let searchAttempt = 0; searchAttempt < 10; searchAttempt++) {
            const rows = document.querySelectorAll('tr[data-e2e="levitan-table-row"]');

            for (const r of rows) {
              const rowClean = stripCountSuffix(normalize(getRowText(r)));
              if (rowClean !== stepClean) continue;

              // Нашли нужную строку
              if (stepIdx === path.length - 1) {
                // Последний шаг — город → заполняем
                if (rowIsCity(r)) {
                  if (setValueInRow(r)) {
                    distFilled++;
                    filledCount.value++;
                    doneCities.add(cn);
                    log(`✅ [${filledCount.value}/${cities.length}] ${city} — заполнено`);
                  } else {
                    const inp = r.querySelector("input[type='text'], input[type='number'], input[inputmode='text'], input[inputmode='numeric']");
                    if (inp && inp.value && inp.value !== '' && inp.value !== '0') {
                      doneCities.add(cn);
                      log(`⏭ [${filledCount.value}/${cities.length}] ${city} — уже (${inp.value})`);
                    } else {
                      log(`⚠️ ${city} — не удалось заполнить`);
                    }
                  }
                } else {
                  log(`⚠️ ${city} — строка не город`);
                }
              } else {
                // Промежуточный шаг → раскрываем если свёрнут
                if (rowIsExpandable(r) && !rowIsExpanded(r)) {
                  scrollToRowInDrawer(r);
                  const rowsBefore = document.querySelectorAll('tr[data-e2e="levitan-table-row"]').length;
                  const btn = r.querySelector("button[aria-expanded='false']");
                  if (btn) {
                    btn.click();
                    await sleep(AFTER_CLICK_MS);
                    // Ждём появления дочерних строк (как в Python)
                    for (let w = 0; w < 15; w++) {
                      await sleep(300);
                      if (document.querySelectorAll('tr[data-e2e="levitan-table-row"]').length > rowsBefore) break;
                    }
                  }
                }
              }
              foundStep = true;
              break;
            }

            if (foundStep) break;
            // Не нашли — ждём и пробуем снова
            await sleep(500);
            if (searchAttempt === 4) {
              log(`→ Шаг '${stepName}' не найден (попытка 5/10), ждём...`);
            }
          }

          if (!foundStep) {
            log(`⚠️ ${city} — шаг не найден: "${stepName}"`);
            pathOk = false;
            break;
          }
        }
      }

      log(`→ ${district}: заполнено ${distFilled} городов`);

      // Сохраняем после каждого округа
      log(`→ Сохранение... (всего: ${filledCount.value})`);
      await savePageChanges();

      if (doneCities.size >= cities.length) break;

      // Переоткрываем drawer для следующего округа
      log('→ Переоткрываем drawer...');
      await sleep(2000);
      dismissOverlays();
      if (!await openDrawer()) break;
      await waitForTreeRows();
      await ensureRootExpanded();
    }

    return { doneCities, filledCount, notInMap };
  }

  // ── MAIN ────────────────────────────────────────────────────────────────

  async function main() {
    log('🚀 Яндекс Склады — старт автоматизации');

    const taskData = getTaskParams();
    if (!taskData) {
      log('❌ Параметры задачи не найдены');
      setStatus('error', 'No task params');
      return;
    }
    const { params } = taskData;
    const cities = params.cities || [];
    const mode = params.mode || 'Без карты';

    if (!cities.length) {
      log('❌ Список городов пуст');
      setStatus('error', 'Empty cities list');
      return;
    }

    log(`→ Городов в списке: ${cities.length}`);
    log(`→ Режим: ${mode}`);

    // Ждём полной загрузки страницы (React рендер)
    await waitForPageReady();
    log(`→ Текущий URL: ${window.location.href}`);

    // Открываем drawer
    if (!await openDrawer()) {
      log('❌ Не удалось открыть drawer');
      setStatus('error', 'Cannot open drawer');
      return;
    }

    // Ждём загрузки дерева регионов в drawer
    if (!await waitForTreeRows()) {
      log('❌ Дерево регионов не загрузилось');
      setStatus('error', 'Tree not loaded');
      return;
    }

    await ensureRootExpanded();

    let doneCities, filledCount, notInMap = [];

    if (mode === 'С картой' && window.__SD_KARTA) {
      // ── Режим С картой ──
      const result = await modeWithMap(cities, window.__SD_KARTA);
      doneCities = result.doneCities;
      filledCount = result.filledCount;
      notInMap = result.notInMap || [];
    } else {
      // ── Режим Без карты (пошаговый обход) ──
      if (mode === 'С картой') log('⚠️ Карта не загружена, используем режим «Без карты»');

      const citiesDict = {};
      for (const city of cities) {
        citiesDict[normalize(city)] = city;
      }
      doneCities = new Set();
      filledCount = { value: 0 };

      for (let distIdx = 0; distIdx < FEDERAL_DISTRICTS.length; distIdx++) {
        const district = FEDERAL_DISTRICTS[distIdx];
        checkStop();
        log(`\n═══ [${distIdx + 1}/8] ${district} ═══`);

        const result = await expandAndFillDistrict(
          district, citiesDict, doneCities, cities.length, filledCount
        );
        log(`→ ${district}: раскрыто ${result.expanded} узлов, заполнено ${result.filled} городов`);

        if (result.expanded === 0) continue;

        log(`→ Сохранение после ${district}... (всего заполнено: ${filledCount.value})`);
        await savePageChanges();

        if (doneCities.size >= cities.length) break;

        if (distIdx < FEDERAL_DISTRICTS.length - 1) {
          log('→ Открываем drawer для следующего округа...');
          await sleep(2000);
          dismissOverlays();
          if (!await openDrawer()) break;
          await waitForTreeRows();
          await ensureRootExpanded();
        }
      }
    }

    // Итоговый отчёт
    const notFound = cities.filter(c => !doneCities.has(normalize(c)));
    const filled = cities.filter(c => doneCities.has(normalize(c)));

    log(`\n═══ ИТОГО ═══`);
    log(`✅ Заполнено: ${filledCount.value} из ${cities.length}`);
    if (notInMap.length) {
      log(`⚠️ Не в карте: ${notInMap.length}`);
      for (const c of notInMap.slice(0, 10)) log(`   • ${c}`);
    }
    if (notFound.length) {
      log(`⚠️ Не найдено: ${notFound.length}`);
      for (const c of notFound.slice(0, 30)) log(`   • ${c}`);
      if (notFound.length > 30) log(`   ... и ещё ${notFound.length - 30}`);
    }

    window.dispatchEvent(new CustomEvent('sd-report', { detail: {
      total: cities.length, filled: filled.length,
      notFound, filledCities: filled,
      completedAt: new Date().toISOString(),
    } }));

    setStatus('completed', `Заполнено ${filledCount.value}/${cities.length}`);
    log('🏁 Готово!');
  }

  function getTaskParams() {
    const raw = document.documentElement.dataset.sdTaskParams;
    if (raw) {
      delete document.documentElement.dataset.sdTaskParams;
      try { return JSON.parse(raw); } catch {}
    }
    return null;
  }

  // Запуск с задержкой
  setTimeout(() => {
    main().catch(err => {
      if (err.message === 'STOPPED') {
        log('⏹ Остановлено');
        setStatus('stopped');
      } else {
        log(`❌ Критическая ошибка: ${err.message}`);
        setStatus('error', err.message);
      }
    });
  }, 1000);
})();
