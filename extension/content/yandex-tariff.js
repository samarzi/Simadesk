/**
 * Яндекс Маркет — автоматизация тарифов (зоны доставки).
 * Порт tariff.py на JavaScript для Chrome Extension.
 *
 * Работает с levitan-table (DOM другой, чем в kur.py):
 *   - Строки: tr[data-e2e="levitan-table-row"]
 *   - Чекбоксы: span[data-e2e^="levitan-clickable checkbox-"]
 *   - Кнопка сохранения: data-e2e="levitan-button tariff-setting-save-button"
 */
(() => {
  'use strict';
  if (window.__SD_YA_TARIFF_RUNNING) return;
  window.__SD_YA_TARIFF_RUNNING = true;

  // ── Константы ───────────────────────────────────────────────────────────
  const AFTER_CLICK_MS = 150;
  const AFTER_SAVE_MS = 5000;

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

  // ── Утилиты ─────────────────────────────────────────────────────────────

  let stopped = false;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function log(text) {
    const ts = new Date().toLocaleTimeString('ru-RU');
    const line = `[${ts}] ${text}`;
    console.log('[SimaDesk:YaTariff]', line);
    window.dispatchEvent(new CustomEvent('sd-log', { detail: { text: line } }));
  }

  function setStatus(status, detail) {
    window.dispatchEvent(new CustomEvent('sd-status', { detail: { status, detail } }));
  }

  function sendProgress(done, total, label) {
    window.dispatchEvent(new CustomEvent('sd-progress', { detail: { done, total, label } }));
  }

  function checkStop() {
    if (window.__SD_STOP || stopped) { stopped = true; throw new Error('STOPPED'); }
  }

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
    const sel = '[data-tid="7cb56119"], div[class*="spinner"], div[class*="Spinner"]';
    const start = Date.now();
    while (document.querySelector(sel) && Date.now() - start < timeout) {
      await sleep(200);
    }
    await sleep(100);
  }

  // ── Tariff-specific: работа с levitan-table ─────────────────────────────

  function getTariffRows() {
    return [...document.querySelectorAll('tr[data-e2e="levitan-table-row"]')];
  }

  function getRowText(row) {
    // Levitan-table строки: текст в первом td
    const cells = row.querySelectorAll('td');
    if (cells.length > 0) return (cells[0].textContent || '').trim().replace(/\s+/g, ' ');
    return (row.textContent || '').trim().replace(/\s+/g, ' ');
  }

  function getRowIndent(row) {
    // Уровень вложенности через класс __use--indent_N___
    const cls = row.className || '';
    const m = cls.match(/__use--indent_(\d+)/);
    return m ? parseInt(m[1]) : 0;
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

  // ── Чекбокс ─────────────────────────────────────────────────────────────

  function getCheckbox(row) {
    return row.querySelector('span[data-e2e^="levitan-clickable checkbox-"]');
  }

  function isChecked(row) {
    const cb = getCheckbox(row);
    if (!cb) return false;
    const de = cb.getAttribute('data-e2e') || '';
    return de.includes('checked') && !de.includes('unchecked');
  }

  function clickCheckbox(row) {
    const cb = getCheckbox(row);
    if (!cb) return false;
    cb.scrollIntoView({ block: 'center', behavior: 'instant' });
    cb.click();
    return true;
  }

  // ── Раскрытие строки ────────────────────────────────────────────────────

  async function clickExpandRow(row) {
    const btn = row.querySelector("button[aria-expanded='false']");
    if (!btn) return false;
    // Скролл контейнера drawer
    const drawer = document.querySelector('[data-e2e="levitan-drawer-wrapper"]');
    if (drawer) {
      const container = drawer.querySelector('[style*="overflow"]') || drawer;
      const rowRect = row.getBoundingClientRect();
      const contRect = container.getBoundingClientRect();
      if (rowRect.top < contRect.top || rowRect.bottom > contRect.bottom) {
        container.scrollTop += (rowRect.top - contRect.top) - 100;
        await sleep(100);
      }
    }
    btn.click();
    await sleep(AFTER_CLICK_MS);
    return true;
  }

  // ── Drawer ──────────────────────────────────────────────────────────────

  function isDrawerOpen() {
    return getTariffRows().length > 3;
  }

  function lockDrawer() {
    if (window.__drawer_locked) return;
    window.__drawer_locked = true;
    document.addEventListener('click', (e) => {
      if (e.target.hasAttribute('data-vaul-overlay') || e.target.closest('[data-vaul-overlay]')) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && getTariffRows().length > 0) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    }, true);
  }

  function isInEditingMode() {
    if (document.querySelector('[data-levitan-table]')) return true;
    const nameInput = document.querySelector('[data-e2e="levitan-text-field name"] input');
    if (nameInput && nameInput.value) return true;
    if (document.querySelector('[data-e2e-i18n-key*="tariff-table.title"]')) return true;
    return false;
  }

  function drawerWrapperVisible() {
    return !!document.querySelector('[data-e2e="levitan-drawer-wrapper"]');
  }

  async function scrollToTreeSection() {
    const selectors = [
      '[data-e2e-i18n-key*="tariff-table.title"]',
      '[data-levitan-table]',
      'tr[data-e2e="levitan-table-row"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) { el.scrollIntoView({ block: 'center', behavior: 'instant' }); await sleep(500); return; }
    }
    const wrapper = document.querySelector('[data-e2e="levitan-drawer-content"]');
    if (wrapper) wrapper.scrollTop = wrapper.scrollHeight;
    await sleep(500);
  }

  async function selectTariffInDrawer(zoneName) {
    log(`→ Drawer в режиме списка. Ищем тариф «${zoneName}»...`);
    const zoneMatch = zoneName.match(/(\d+)/);
    const zoneNum = zoneMatch ? zoneMatch[1] : '';

    const togglerSel = "[data-e2e='levitan-drawer-wrapper'] [data-e2e='levitan-button tariff-menu-toggler']";
    const togglers = document.querySelectorAll(togglerSel);
    log(`→ Кнопок-меню тарифов: ${togglers.length}`);

    if (!togglers.length) {
      log('⚠️ Menu-toggler кнопки не найдены. Пробуем fallback...');
      // Fallback: ищем любую кнопку «Редактировать» или «Изменить» прямо в drawer
      const wrapper = document.querySelector('[data-e2e="levitan-drawer-wrapper"]');
      if (wrapper) {
        const editBtns = [...wrapper.querySelectorAll('button, a')].filter(b => {
          if (b.offsetParent === null) return false;
          const t = (b.textContent || '').trim().toLowerCase();
          return t.includes('редактировать') || t.includes('изменить') || t.includes('edit');
        });
        if (editBtns.length > 0) {
          log(`→ Найдена кнопка редактирования (fallback): "${editBtns[0].textContent.trim()}"`);
          editBtns[0].click();
          await sleep(2000);
          await waitForSpinner();
          return isInEditingMode();
        }
        // Ещё один fallback: кликаем первый row/link в drawer
        const links = wrapper.querySelectorAll('a[href], [role="button"], [data-e2e*="tariff"]');
        log(`→ Drawer содержит ${links.length} ссылок/кнопок`);
        const allTexts = [...wrapper.querySelectorAll('*')]
          .filter(el => el.children.length === 0 && el.textContent.trim().length > 2)
          .map(el => el.textContent.trim().substring(0, 50))
          .slice(0, 20);
        log(`→ Тексты в drawer: ${allTexts.join(' | ')}`);
      }
      return false;
    }

    let targetIdx = -1;
    if (zoneNum) {
      const pattern = new RegExp('зона\\s*' + zoneNum + '(?!\\d)', 'i');
      for (let i = 0; i < togglers.length; i++) {
        let el = togglers[i];
        for (let d = 0; d < 6; d++) {
          el = el.parentElement;
          if (!el) break;
          if (el.tagName === 'TR' || el.tagName === 'DIV') {
            if (pattern.test(el.textContent || '')) { targetIdx = i; break; }
          }
        }
        if (targetIdx >= 0) break;
      }
      if (targetIdx < 0) targetIdx = parseInt(zoneNum) - 1;
    }
    if (targetIdx < 0 || targetIdx >= togglers.length) targetIdx = 0;

    togglers[targetIdx].scrollIntoView({ block: 'center' });
    await sleep(300);
    togglers[targetIdx].click();
    log(`→ Кликнули menu-toggler #${targetIdx}`);
    await sleep(1000);

    // Кликаем "Редактировать" в выпавшем меню
    const editSelectors = [
      "[data-e2e='levitan-link tariff-edit-action']",
      "[data-e2e*='tariff-edit-action']",
      "[data-value='tariff-edit-action'] button",
      "[data-value='tariff-edit-action']",
    ];
    for (const sel of editSelectors) {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null) {
        btn.click();
        log('→ Кликнули «Редактировать»');
        await sleep(2000);
        await waitForSpinner();
        return isInEditingMode();
      }
    }
    // Fallback: ищем по тексту
    const allBtns = [...document.querySelectorAll('button')];
    const editBtn = allBtns.find(b => b.textContent.trim() === 'Редактировать' && b.offsetParent !== null);
    if (editBtn) {
      editBtn.click();
      await sleep(2000);
      await waitForSpinner();
      return isInEditingMode();
    }
    return false;
  }

  async function waitForPageReady() {
    log('→ Ожидание загрузки страницы...');
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

  async function openTariffDrawer(zoneName) {
    if (isDrawerOpen()) {
      log('✅ Drawer уже открыт');
      lockDrawer();
      return true;
    }

    log('→ Ищем кнопку «Настроить» для тарифов...');

    const selectors = [
      "[data-e2e='levitan-button tariff-setting-setup-button']",
      "button[data-e2e*='tariff-setting-setup']",
    ];

    for (let attempt = 1; attempt <= 10; attempt++) {
      checkStop();
      await sleep(2000);

      let clicked = false;
      for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (btn && btn.offsetParent !== null) {
          btn.scrollIntoView({ block: 'center' });
          await sleep(500);
          ['mousedown', 'mouseup', 'click'].forEach(type => {
            btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
          });
          clicked = true;
          log(`→ Кнопка найдена: ${sel}`);
          break;
        }
      }

      if (!clicked) {
        const buttons = [...document.querySelectorAll('button')];
        const textBtn = buttons.find(b => {
          if (b.offsetParent === null) return false;
          const t = b.textContent.trim();
          return t.includes('Настроить') && !t.includes('Показать');
        });
        if (textBtn) {
          textBtn.scrollIntoView({ block: 'center' });
          await sleep(500);
          textBtn.click();
          ['mousedown', 'mouseup', 'click'].forEach(type => {
            textBtn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
          });
          clicked = true;
          log('→ Кнопка найдена по тексту «Настроить»');
        }
      }

      if (!clicked) {
        // Логируем все видимые кнопки и data-e2e для отладки
        if (attempt <= 2) {
          const allBtnTexts = [...document.querySelectorAll('button')]
            .filter(b => b.offsetParent !== null)
            .map(b => b.textContent.trim().substring(0, 50))
            .filter(t => t.length > 0);
          log(`→ Видимые кнопки: ${allBtnTexts.slice(0, 15).join(' | ')}`);
          const e2eBtns = [...document.querySelectorAll('[data-e2e]')]
            .map(el => el.getAttribute('data-e2e'))
            .filter(Boolean);
          log(`→ data-e2e элементы: ${e2eBtns.slice(0, 15).join(' | ')}`);
        }
        continue;
      }

      // Ждём появления drawer wrapper
      for (let tick = 0; tick < 40; tick++) {
        await sleep(500);
        if (drawerWrapperVisible() || isDrawerOpen()) break;
      }

      if (!drawerWrapperVisible() && !isDrawerOpen()) {
        log('⚠️ Drawer не появился после клика');
        continue;
      }

      await waitForSpinner();
      lockDrawer();

      // Drawer может быть в режиме СПИСКА тарифов — нужно выбрать конкретный
      if (!isInEditingMode()) {
        log('→ Drawer в режиме списка тарифов');
        // Пробуем выбрать тариф — по имени зоны или первый доступный
        if (!await selectTariffInDrawer(zoneName || '')) {
          log('⚠️ Не удалось выбрать тариф автоматически');
          log('→ Ожидание ручного выбора (60 сек)...');
          for (let w = 0; w < 60; w++) {
            await sleep(1000);
            if (isInEditingMode()) break;
          }
        }
      }

      // Скроллим к дереву и ждём интерактивности
      await scrollToTreeSection();

      // Ждём кнопок раскрытия
      for (let tick = 0; tick < 30; tick++) {
        if (getTariffRows().some(r => r.querySelector('button[aria-expanded]'))) {
          log('✅ Дерево интерактивно!');
          return true;
        }
        if (tick % 5 === 4) await scrollToTreeSection();
        await sleep(500);
      }

      // Даже если дерево не полностью готово, пробуем
      if (getTariffRows().length > 0) {
        log(`⚠️ Строк: ${getTariffRows().length}, пробуем работать`);
        return true;
      }
    }

    log('❌ Не удалось открыть drawer тарифов. Откройте вручную.');
    log('⏳ Ожидание ручного открытия (2 мин)...');
    for (let i = 0; i < 240; i++) {
      await sleep(500);
      if (isDrawerOpen()) { lockDrawer(); return true; }
    }
    throw new Error('Cannot open tariff drawer');
  }

  // ── Сохранение ──────────────────────────────────────────────────────────

  async function saveTariffChanges() {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) active.blur();
    await sleep(1000);

    for (let attempt = 0; attempt < 4; attempt++) {
      checkStop();
      const btn = document.querySelector("button[data-e2e*='tariff-setting-save']");
      if (!btn) {
        // Fallback: ищем по тексту
        const buttons = [...document.querySelectorAll('button')];
        const saveBtn = buttons.find(b => b.textContent.trim() === 'Сохранить');
        if (saveBtn && !saveBtn.disabled) {
          saveBtn.click();
          log('→ Клик «Сохранить» (по тексту)');
          await sleep(AFTER_SAVE_MS);
          if (!isDrawerOpen()) { log('✅ Сохранено!'); return true; }
        }
        await sleep(2000);
        continue;
      }

      if (btn.disabled) { await sleep(2000); continue; }

      btn.scrollIntoView({ block: 'center' });
      btn.click();
      log('→ Клик «Сохранить»');

      for (let tick = 0; tick < 60; tick++) {
        await sleep(500);
        if (!isDrawerOpen()) {
          log('✅ Drawer закрыт, тарифы сохранены!');
          window.__drawer_locked = false;
          await sleep(1500);
          return true;
        }
      }
    }

    log('⚠️ Сохраните тарифы вручную.');
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      if (!isDrawerOpen()) {
        window.__drawer_locked = false;
        return true;
      }
    }
    return false;
  }

  // ── Раскрытие и отметка городов в зоне ──────────────────────────────────

  async function processDistrict(districtName, citiesDict, doneCities, totalCities, filledCount) {
    const rows = getTariffRows();
    const districtRow = rows.find(r => {
      if (!rowIsExpandable(r)) return false;
      const n = normalize(getRowText(r));
      const dn = normalize(districtName);
      return n === dn || n.includes(dn) || dn.includes(n);
    });

    if (!districtRow) {
      log(`⚠️ Округ не найден: ${districtName}`);
      return 0;
    }

    if (!rowIsExpanded(districtRow)) {
      log(`→ Раскрываем: ${districtName}`);
      await clickExpandRow(districtRow);
    }

    let filled = 0;
    const otherDistricts = FEDERAL_DISTRICTS.filter(d => d !== districtName);

    for (let iteration = 0; iteration < 80; iteration++) {
      checkStop();

      // Сканируем и отмечаем
      const currentRows = getTariffRows();
      for (const r of currentRows) {
        if (!rowIsCity(r)) continue;
        const cityNorm = normalize(getRowText(r));
        if (!citiesDict[cityNorm]) continue;
        if (doneCities.has(cityNorm)) continue;

        if (isChecked(r)) {
          doneCities.add(cityNorm);
          continue;
        }

        if (clickCheckbox(r)) {
          filled++;
          filledCount.value++;
          doneCities.add(cityNorm);
          await sleep(100);
          sendProgress(filledCount.value, totalCities, districtName);
          log(`✅ [${filledCount.value}/${totalCities}] ${citiesDict[cityNorm]} — отмечен`);
        }
      }

      // Раскрываем свёрнутые узлы
      const collapsed = [];
      const allRows = getTariffRows();
      for (let i = 0; i < allRows.length && collapsed.length < 3; i++) {
        const r = allRows[i];
        const btn = r.querySelector("button[aria-expanded='false']");
        if (!btn || btn.offsetParent === null) continue;
        const text = getRowText(r);
        const isOther = otherDistricts.some(d => text.includes(d) || d.includes(text));
        if (!isOther) collapsed.push(r);
      }

      if (!collapsed.length) break;

      for (const r of collapsed) {
        await clickExpandRow(r);
      }
    }

    return filled;
  }

  // ── MAIN ────────────────────────────────────────────────────────────────

  async function main() {
    log('🚀 Яндекс Тарифы — старт автоматизации');

    const raw = document.documentElement.dataset.sdTaskParams;
    let taskData = null;
    if (raw) {
      delete document.documentElement.dataset.sdTaskParams;
      try { taskData = JSON.parse(raw); } catch {}
    }
    if (!taskData) {
      log('❌ Параметры задачи не найдены');
      setStatus('error', 'No task params');
      return;
    }
    const params = taskData.params || {};
    const cities = params.cities || [];

    if (!cities.length) {
      log('❌ Список городов пуст');
      setStatus('error', 'Empty cities');
      return;
    }

    log(`→ Городов в списке: ${cities.length}`);

    const citiesDict = {};
    for (const city of cities) {
      citiesDict[normalize(city)] = city;
    }
    const doneCities = new Set();
    const filledCount = { value: 0 };

    // Ждём полной загрузки страницы
    await waitForPageReady();
    log(`→ Текущий URL: ${window.location.href}`);

    // Получаем имя зоны из параметров (если есть)
    const zoneName = params.zoneName || '';

    // Открываем drawer тарифов (передаём имя зоны для навигации в режиме списка)
    if (!await openTariffDrawer(zoneName)) {
      setStatus('error', 'Cannot open drawer');
      return;
    }

    // Ждём загрузки строк дерева
    async function waitForTariffRows(timeoutMs = 60000) {
      log('→ Ожидание загрузки дерева тарифов...');
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const rows = getTariffRows();
        if (rows.length > 0) {
          log(`→ Дерево загружено: ${rows.length} строк`);
          await sleep(500);
          return true;
        }
        await sleep(500);
      }
      log('❌ Дерево тарифов не загрузилось');
      return false;
    }

    // Раскрываем корень
    async function ensureRootExpanded() {
      for (let attempt = 0; attempt < 20; attempt++) {
        await scrollToTreeSection();
        await sleep(500);
        const rows = getTariffRows();
        if (rows.length === 0) {
          if (attempt === 0) log('→ Строк пока нет, ждём...');
          await sleep(1000);
          continue;
        }
        for (let i = 0; i < Math.min(5, rows.length); i++) {
          const r = rows[i];
          if (rowIsExpandable(r)) {
            if (!rowIsExpanded(r)) {
              log('→ Раскрываем корневой узел...');
              await clickExpandRow(r);
            } else {
              log(`✅ Корень уже раскрыт`);
            }
            return true;
          }
        }
        if (attempt < 5) {
          log(`→ ${rows.length} строк, но кнопок раскрытия нет. Ожидание...`);
          await sleep(1500);
        }
      }
      const rows = getTariffRows();
      log(`⚠️ ensureRootExpanded не удалось. Строк: ${rows.length}`);
      if (rows.length > 0) {
        const names = rows.slice(0, 5).map(r => `"${getRowText(r).substring(0, 50)}"`);
        log(`→ Первые строки: ${names.join(', ')}`);
      }
      return false;
    }

    if (!await waitForTariffRows()) {
      log('❌ Дерево тарифов не загрузилось');
      setStatus('error', 'Tree not loaded');
      return;
    }
    await ensureRootExpanded();

    const mode = params.mode || 'Без карты';
    const karta = window.__SD_KARTA || null;

    if (mode === 'С картой' && karta) {
      // ── Режим С картой: раскрываем ТОЛЬКО пути к нужным городам ──
      log(`→ Режим: С картой (${Object.keys(karta).length} записей)`);

      function stripCountSuffix(s) { return s.replace(/\s+\d+\s*$/, '').trim(); }
      function findTariffRowByText(target) {
        const tgt = stripCountSuffix(normalize(target));
        for (const r of getTariffRows()) {
          const txt = stripCountSuffix(normalize(getRowText(r)));
          if (txt === tgt) return r;
        }
        for (const r of getTariffRows()) {
          const txt = stripCountSuffix(normalize(getRowText(r)));
          if (txt.includes(tgt) || tgt.includes(txt)) return r;
        }
        return null;
      }

      // Группируем по округам
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
        } else { notInMap.push(city); }
      }
      if (notInMap.length) log(`⚠️ Не в карте: ${notInMap.length} городов`);

      for (const district of FEDERAL_DISTRICTS) {
        checkStop();
        const entries = citiesByDistrict[district];
        if (!entries || !entries.length) continue;
        log(`\n═══ ${district} (${entries.length} городов) ═══`);

        let dRow = getTariffRows().find(r => {
          if (!rowIsExpandable(r)) return false;
          const n = normalize(getRowText(r));
          return n.includes(normalize(district)) || normalize(district).includes(n);
        });
        if (!dRow) { log(`⚠️ Округ не найден: ${district}`); continue; }
        if (!rowIsExpanded(dRow)) {
          const rowsBefore = getTariffRows().length;
          await clickExpandRow(dRow);
          // Ждём появления дочерних строк
          for (let w = 0; w < 20; w++) {
            await sleep(300);
            if (getTariffRows().length > rowsBefore) break;
          }
        }

        for (const entry of entries) {
          checkStop();
          const { city, path } = entry;
          const cn = normalize(city);
          if (doneCities.has(cn)) continue;
          sendProgress(filledCount.value, cities.length, city);
          log(`→ [${filledCount.value + 1}/${cities.length}] ${city}`);

          let pathOk = true;
          for (let si = 0; si < path.length; si++) {
            const stepClean = stripCountSuffix(normalize(path[si]));
            if (stepClean.includes('все регионы') || stepClean.includes('все_регионы')) continue;
            let isDist = false;
            for (const fd of FEDERAL_DISTRICTS) {
              if (normalize(fd).includes(stepClean) || stepClean.includes(normalize(fd))) { isDist = true; break; }
            }
            if (isDist) continue;

            // Ищем строку с 10 попытками (как в Python)
            let found = false;
            for (let searchAttempt = 0; searchAttempt < 10; searchAttempt++) {
              const rows = getTariffRows();
              for (const r of rows) {
                const rowClean = stripCountSuffix(normalize(getRowText(r)));
                if (rowClean !== stepClean) continue;

                // Нашли
                if (si === path.length - 1) {
                  // Город → отмечаем чекбокс
                  if (!isChecked(r)) {
                    if (clickCheckbox(r)) {
                      filledCount.value++;
                      doneCities.add(cn);
                      log(`✅ [${filledCount.value}/${cities.length}] ${city} — отмечен`);
                    } else {
                      log(`⚠️ ${city} — не удалось отметить`);
                    }
                  } else {
                    doneCities.add(cn);
                    log(`⏭ ${city} — уже отмечен`);
                  }
                } else {
                  // Промежуточный шаг → раскрываем
                  if (rowIsExpandable(r) && !rowIsExpanded(r)) {
                    const rowsBefore = getTariffRows().length;
                    await clickExpandRow(r);
                    // Ждём появления дочерних строк (как в Python)
                    for (let w = 0; w < 15; w++) {
                      await sleep(300);
                      if (getTariffRows().length > rowsBefore) break;
                    }
                  }
                }
                found = true;
                break;
              }
              if (found) break;
              await sleep(500);
              if (searchAttempt === 4) log(`→ Шаг '${path[si]}' не найден (попытка 5/10)...`);
            }
            if (!found) {
              log(`⚠️ ${city} — шаг не найден: "${path[si]}"`);
              pathOk = false;
              break;
            }
          }
        }
      }

      log(`\n→ Сохранение... (отмечено: ${filledCount.value})`);
      await saveTariffChanges();

    } else {
      // ── Режим Без карты: полное раскрытие ──
      if (mode === 'С картой') log('⚠️ Карта не загружена, используем режим «Без карты»');
      log('→ Режим: Без карты (полное раскрытие дерева)');

      for (let distIdx = 0; distIdx < FEDERAL_DISTRICTS.length; distIdx++) {
        const district = FEDERAL_DISTRICTS[distIdx];
        checkStop();
        log(`\n═══ [${distIdx + 1}/8] ${district} ═══`);
        const filled = await processDistrict(district, citiesDict, doneCities, cities.length, filledCount);
        log(`→ ${district}: отмечено ${filled}`);

        if (doneCities.size >= cities.length) {
          log(`✅ Все ${cities.length} городов отмечены!`);
          log(`→ Сохранение...`);
          await saveTariffChanges();
          break;
        }
      }

      if (doneCities.size < cities.length) {
        log(`\n→ Сохранение... (отмечено: ${filledCount.value})`);
        await saveTariffChanges();
      }
    }

    // Отчёт
    const notFound = cities.filter(c => !doneCities.has(normalize(c)));
    log(`\n═══ ИТОГО ═══`);
    log(`✅ Отмечено: ${filledCount.value} из ${cities.length}`);
    if (notFound.length) {
      log(`⚠️ Не найдено: ${notFound.length}`);
      for (const c of notFound.slice(0, 20)) log(`   • ${c}`);
    }

    setStatus('completed', `Отмечено ${filledCount.value}/${cities.length}`);
    log('🏁 Готово!');
  }

  setTimeout(() => {
    main().catch(err => {
      if (err.message === 'STOPPED') {
        log('⏹ Остановлено');
        setStatus('stopped');
      } else {
        log(`❌ Ошибка: ${err.message}`);
        setStatus('error', err.message);
      }
    });
  }, 1000);
})();
