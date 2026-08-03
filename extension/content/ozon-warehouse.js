/**
 * Ozon Seller — автоматизация настройки зон складов.
 * Порт ozon_warehouse.py на JavaScript для Chrome Extension.
 *
 * Структура страницы:
 *   Карточки складов: li внутри ul
 *   Название: [data-widget="warehouse-card-title"]
 *   Зоны: div.nd4-ea6[title="..."]
 *   Карандаш: button[title="Редактировать метод"]
 *   Далее: button:has-text("Далее")
 *   Сохранить: button:has-text("Сохранить")
 *   Поиск: input[placeholder="Направление доставки"]
 *   Чекбокс: input[type="checkbox"] в строке таблицы
 */
(() => {
  'use strict';
  // Двойная защита: window (текущий контекст) + sessionStorage (между инъекциями)
  if (window.__SD_OZ_WH_RUNNING) return;
  if (sessionStorage.getItem('__sd_wh_running') === '1') return;
  window.__SD_OZ_WH_RUNNING = true;
  sessionStorage.setItem('__sd_wh_running', '1');
  // Очищаем флаг при выгрузке страницы
  window.addEventListener('beforeunload', () => sessionStorage.removeItem('__sd_wh_running'));

  // ── Константы ───────────────────────────────────────────────────────────
  const SEARCH_DEBOUNCE_MS = 800;
  const AFTER_SAVE_MS = 3000;

  // ── Утилиты ─────────────────────────────────────────────────────────────

  let stopped = false;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function log(text) {
    const ts = new Date().toLocaleTimeString('ru-RU');
    const line = `[${ts}] ${text}`;
    console.log('[SimaDesk:OzWH]', line);
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
    t = t.replace(/\bг\.?\s*/g, '');
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }

  // ── Проверка авторизации ────────────────────────────────────────────────

  async function checkAuth(timeout = 25000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const cards = document.querySelectorAll('[data-widget="warehouse-card-title"]');
      if (cards.length > 0) return true;
      if (window.location.href.includes('login') || window.location.href.includes('passport')) {
        return false;
      }
      await sleep(1000);
    }
    return false;
  }

  // ── Прокрутка страницы для подгрузки всех складов (lazy loading) ────────

  async function scrollToLoadAllWarehouses() {
    // Активируем вкладку: без этого IntersectionObserver не срабатывает в фоне
    window.dispatchEvent(new CustomEvent('sd-activate-tab'));
    await sleep(600);

    log('→ Прокрутка для подгрузки всех складов...');
    let prevCount = 0;
    let stableRuns = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      const cards = document.querySelectorAll('[data-widget="warehouse-card-title"]');
      if (cards.length === prevCount) {
        stableRuns++;
        if (stableRuns >= 4) break; // 4 итерации без изменений = все загружены
      } else {
        stableRuns = 0; // новые карточки появились — сбрасываем счётчик
      }
      prevCount = cards.length;
      // Скроллим к последней карточке И до самого низа страницы
      if (cards.length > 0) {
        cards[cards.length - 1].scrollIntoView({ block: 'end', behavior: 'smooth' });
        await sleep(300);
      }
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(1800); // больше времени на lazy-load
    }
    // Возвращаемся наверх, чтобы карточки были видны
    window.scrollTo({ top: 0, behavior: 'smooth' });
    await sleep(800);
    log(`→ Всего складов на странице: ${document.querySelectorAll('[data-widget="warehouse-card-title"]').length}`);
  }

  // ── Сканирование складов ────────────────────────────────────────────────

  function scanWarehouses() {
    const cards = document.querySelectorAll('[data-widget="warehouse-card-title"]');
    const warehouses = [];
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const name = card.textContent.trim();
      const li = card.closest('li');
      const zones = [];
      const seen = new Set();
      if (li) {
        // NO keyword filter — zone names like "Феникс 2025", "Липецк", "Курьером"
        // must all be captured. Use class-based selector with div[title] fallback.
        const zoneDivs = li.querySelectorAll('.nd4-ea6[title], [class*="ea6"][title], div[title]');
        for (const zd of zoneDivs) {
          const t = zd.getAttribute('title') || '';
          if (t && t.length > 1 && t.length < 100 && !seen.has(t)) {
            seen.add(t);
            zones.push({ name: zd.textContent.trim(), title: t });
          }
        }
      }
      warehouses.push({ name, index: i, zones });
    }
    return warehouses;
  }

  // ── Раскрытие скрытых методов ───────────────────────────────────────────

  async function expandHiddenMethods(warehouseName) {
    const normWName = normZone(warehouseName);
    for (let attempt = 0; attempt < 20; attempt++) {
      const cards = document.querySelectorAll('[data-widget="warehouse-card-title"]');
      let clicked = false;
      for (const card of cards) {
        if (normZone(card.textContent.trim()) !== normWName) continue;
        const li = card.closest('li');
        if (!li) continue;
        card.scrollIntoView({ block: 'center', behavior: 'smooth' });
        await sleep(500);
        const buttons = li.querySelectorAll('button');

        if (attempt === 0) {
          // Диагностика: список всех кнопок в карточке склада
          const btnTexts = [...buttons].map(b => b.textContent.trim()).filter(t => t.length > 0 && t.length < 60);
          log(`[DBG] expand attempt=${attempt}, кнопок в li: ${buttons.length}, тексты: ${JSON.stringify(btnTexts)}`);
        }

        for (const btn of buttons) {
          const text = btn.textContent.trim().toLowerCase();
          if (text.includes('показать ещё') || text.includes('показать еще') || text.includes('show more')) {
            btn.scrollIntoView({ block: 'center' });
            btn.click();
            clicked = true;
            log(`[DBG] expand: кликнуто «${btn.textContent.trim()}»`);
            await sleep(2000);
            break;
          }
        }
        break;
      }
      if (!clicked) {
        if (attempt === 0) log('[DBG] expand: кнопка «показать ещё» не найдена → выход');
        break;
      }
    }
    log('✅ Все методы раскрыты');
  }

  // ── Клик на кнопку редактирования зоны (карандаш) ───────────────────────
  // Карандаш на Ozon появляется только при наведении — шлём mouseover перед поиском.

  // Нормализация для нечёткого сравнения названий зон
  function normZone(s) {
    return (s || '').toLowerCase().replace(/ё/g, 'е').replace(/[.\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  async function findZoneEditButton(warehouseName, zoneTitle) {
    const normTarget = normZone(zoneTitle);
    const cards = document.querySelectorAll('[data-widget="warehouse-card-title"]');
    log(`[DBG] findZoneEditButton: ищем склад «${warehouseName}», зону «${zoneTitle}»`);
    log(`[DBG] Карточек складов на странице: ${cards.length}`);

    const normWName = normZone(warehouseName);
    for (const card of cards) {
      if (normZone(card.textContent.trim()) !== normWName) continue;
      const li = card.closest('li');
      if (!li) continue;

      // Скроллим вниз внутри карточки чтобы подгрузить скрытые зоны
      const liRect = li.getBoundingClientRect();
      for (let scrollStep = 0; scrollStep < 5; scrollStep++) {
        window.scrollBy(0, liRect.height / 4);
        await sleep(300);
      }
      li.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(600);

      const zoneDivs = li.querySelectorAll('div[title], .nd4-ea6, [class*="ea6"]');
      log(`[DBG] div[title] внутри склада: ${zoneDivs.length}`);
      const allTitles = [...zoneDivs].map(d => d.getAttribute('title') || d.textContent.trim()).filter(Boolean);
      log(`[DBG] Найденные title: ${JSON.stringify(allTitles.slice(0, 15))}`);

      for (const zd of zoneDivs) {
        const title = zd.getAttribute('title') || zd.textContent.trim();
        // Нечёткое совпадение: игнорируем точки, дефисы, регистр
        if (normZone(title) !== normTarget) continue;

        log(`[DBG] Зона найдена! Скроллим...`);
        zd.scrollIntoView({ block: 'center', behavior: 'smooth' });
        await sleep(800);

        // Шлём hover по всей цепочке от zd вверх — карандаш скрыт до наведения
        for (let el = zd; el && el !== li.parentElement; el = el.parentElement) {
          el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        }
        await sleep(700);

        // 0. Быстрый путь: closest по ряду зоны (nd4-e3a — реальный класс из DOM)
        {
          const zoneRow = zd.closest('[class*="nd4-e3a"]');
          if (zoneRow) {
            const eb = zoneRow.querySelector('button[title="Редактировать метод"]');
            if (eb) { log('[DBG] ✅ Карандаш через closest nd4-e3a'); eb.scrollIntoView({ block: 'center' }); eb.click(); return true; }
          }
        }

        // Ищем ближайший предок с кнопками (не опираемся на классы Ozon — они меняются)
        let searchRoot = null;
        for (let el = zd.parentElement; el && el !== li; el = el.parentElement) {
          if (el.tagName === 'LI' || el.querySelectorAll('button').length > 0) {
            searchRoot = el;
            break;
          }
        }
        if (!searchRoot) searchRoot = li;
        log(`[DBG] searchRoot: ${searchRoot.tagName}${searchRoot.className ? '.' + searchRoot.className.trim().split(/\s+/).join('.') : ''}, кнопок: ${searchRoot.querySelectorAll('button').length}`);

        const tryClick = (btn) => {
          if (!btn) return false;
          btn.scrollIntoView({ block: 'center' });
          btn.click();
          return true;
        };

        // 1. Точный title в найденном searchRoot
        let editBtn = searchRoot.querySelector('button[title="Редактировать метод"]');
        if (editBtn) { log(`[DBG] ✅ Карандаш по title (searchRoot)`); return tryClick(editBtn); }

        // 2. Редактировать по тексту/title в searchRoot
        for (const btn of searchRoot.querySelectorAll('button')) {
          const t = (btn.getAttribute('title') || btn.textContent || '').toLowerCase();
          if (t.includes('редактировать') || t.includes('edit')) {
            log(`[DBG] ✅ Редактировать по тексту (searchRoot)`);
            return tryClick(btn);
          }
        }

        // 3. Если searchRoot не li — пробуем весь li (ищем кнопку, ближайшую к zd по DOM)
        if (searchRoot !== li) {
          editBtn = li.querySelector('button[title="Редактировать метод"]');
          if (editBtn) { log(`[DBG] ✅ Карандаш по title (li)`); return tryClick(editBtn); }
        }

        // 4. Все кнопки "Редактировать" в li — берём ту, что DOM-позиционно ближе к zd
        const allEdit = [...li.querySelectorAll('button')].filter(b => {
          const t = (b.getAttribute('title') || b.textContent || '').toLowerCase();
          return t.includes('редактировать') || t.includes('edit');
        });
        if (allEdit.length > 0) {
          // Берём первую — после expandHiddenMethods зоны раскрыты в порядке отображения
          // и первая "Редактировать" соответствует первой видимой зоне (уже проскроллили к нужной)
          // Более надёжно: найти кнопку, ближайшую к zd по DOM-позиции
          const zdPos = zd.compareDocumentPosition.bind(zd);
          let closest = allEdit[0];
          for (const btn of allEdit) {
            const rel = zdPos(btn);
            const closestRel = zdPos(closest);
            // Предпочитаем кнопку ПОСЛЕ zd в DOM и максимально близкую
            if ((rel & Node.DOCUMENT_POSITION_FOLLOWING) && !(closestRel & Node.DOCUMENT_POSITION_FOLLOWING)) {
              closest = btn;
            }
          }
          log(`[DBG] ✅ Редактировать ближайшая к зоне (из ${allEdit.length})`);
          return tryClick(closest);
        }

        // 5. SVG карандаш (path '4.989') во всём li
        for (const btn of li.querySelectorAll('button')) {
          const svg = btn.querySelector('svg');
          if (svg && svg.innerHTML.includes('4.989')) {
            log(`[DBG] ✅ SVG карандаш найден`);
            return tryClick(btn);
          }
        }

        // Диагностика: что вообще есть
        const allBtns = [...li.querySelectorAll('button')];
        log(`[DBG] ❌ Карандаш не найден. Кнопок в li: ${allBtns.length}, titles: ${JSON.stringify(allBtns.map(b => b.getAttribute('title') || b.textContent.trim().slice(0,20)).filter(Boolean))}`);
      }
    }
    log(`[DBG] ❌ Зона «${zoneTitle}» не найдена среди div[title]`);
    return false;
  }

  // ── Навигация по шагам (Далее / Сохранить) ──────────────────────────────

  async function clickButton(text, timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const buttons = [...document.querySelectorAll('button')].filter(
        b => b.textContent.trim() === text && b.offsetParent !== null && !b.disabled
      );
      // Prefer the primary CTA button (class nd4-q7 = Ozon wizard main action button)
      const btn = buttons.find(b => b.classList.contains('nd4-q7')) || buttons[0];
      if (btn) {
        btn.scrollIntoView({ block: 'center' });
        await sleep(300);
        btn.click();
        log(`→ Клик «${text}»`);
        await sleep(1500);
        return true;
      }
      await sleep(500);
    }
    return false;
  }

  // ── Ожидание поля поиска ────────────────────────────────────────────────

  async function waitForSearchPage(timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const input = document.querySelector("input[placeholder='Направление доставки']");
      if (input && input.offsetParent !== null) {
        log('✅ Поле поиска городов готово');
        return true;
      }
      await sleep(500);
    }
    log('❌ Поле поиска не появилось');
    return false;
  }

  // ── Поиск и выбор города ────────────────────────────────────────────────
  //
  // ВАЖНО: не используем Promise.race с внешним sleep-таймером.
  // Причина: в фоновой вкладке Chrome throttle-ит ВСЕ setTimeout одинаково
  // (до 1 с, а при глубоком фоне — до 60 с). При гонке двух throttle-нутых
  // таймеров (sleep(800) внутри и sleep(20000) снаружи) внешний может
  // сработать первым, «убив» поиск до того, как DOM-проверка выполнится.
  //
  // Решение: один начальный yield → сразу проверяем DOM (Ozon уже ответил,
  // даже если спали 60 с вместо 700 мс) → используем Date.now() для реального
  // дедлайна вместо нового sleep-таймера.

  async function _typeIntoSearch(searchInput, cityName) {
    const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

    searchInput.focus();
    searchInput.click();

    // Очищаем поле — используем InputEvent (не голый Event) для React-совместимости
    nativeSet.call(searchInput, '');
    searchInput.dispatchEvent(new InputEvent('input', {
      bubbles: true, cancelable: true, inputType: 'deleteContentBackward',
    }));
    await sleep(120);

    // Вводим город — InputEvent с inputType:'insertText' гарантированно триггерит
    // React-обработчик даже если у компонента нет keyDown/keyUp листенеров.
    nativeSet.call(searchInput, cityName);
    searchInput.dispatchEvent(new InputEvent('input', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: cityName,
    }));
    searchInput.dispatchEvent(new Event('change', { bubbles: true }));

    // Дублируем через KeyboardEvent на случай если у Ozon есть onKeyDown-обработчик
    const lastChar = cityName[cityName.length - 1] || '';
    searchInput.dispatchEvent(new KeyboardEvent('keydown', {
      key: lastChar, bubbles: true, cancelable: true,
    }));
    searchInput.dispatchEvent(new KeyboardEvent('keyup', {
      key: lastChar, bubbles: true, cancelable: true,
    }));
  }

  async function _doSearchAndSelect(cityName) {
    const searchInput = document.querySelector("input[placeholder='Направление доставки']");
    if (!searchInput || searchInput.offsetParent === null) {
      log(`[DBG] Поле поиска НЕ найдено для «${cityName}»`);
      return 'failed';
    }

    const norm = normCity(cityName);

    await _typeIntoSearch(searchInput, cityName);

    const REAL_TIMEOUT_MS = 6000;
    const startTime = Date.now();

    await sleep(800);

    // Быстрая проверка: если сразу ничего нет — ещё раз и уходим
    const hasAnyResults = () => {
      const visibleCb = [...document.querySelectorAll('input[type="checkbox"]')]
        .filter(el => el.offsetParent !== null).length;
      const visibleOpts = document.querySelectorAll('[role="option"], [role="listbox"] li').length;
      return visibleCb > 0 || visibleOpts > 0;
    };
    if (!hasAnyResults()) {
      await sleep(800);
      if (!hasAnyResults()) return 'not_found';
    }

    for (let attempt = 0; attempt < 10; attempt++) {

      // ── Диагностика (только attempt=0) ───────────────────────────────
      if (attempt === 0) {
        const ak3Els = document.querySelectorAll('.nd4-ak3');
        const cbCount = document.querySelectorAll('input[type="checkbox"]').length;
        const trCount = document.querySelectorAll('tr').length;
        log(`[DBG] «${cityName}»: nd4-ak3=${ak3Els.length} tr=${trCount} cb=${cbCount}`);
        const samples = [...ak3Els].slice(0, 5).map(e => normCity(e.textContent));
        log(`[DBG] Первые nd4-ak3: ${JSON.stringify(samples)}`);
        log(`[DBG] Ищем: «${norm}»`);
      }

      // ── 1. Поиск по .nd4-ak3 (точная ячейка с названием города) ──────
      let found = null;
      for (const nameEl of document.querySelectorAll('.nd4-ak3')) {
        const cityText = normCity(nameEl.textContent);
        if (!cityExactMatch(cityText, norm)) continue;
        const row = nameEl.closest('tr') || nameEl.closest('[role="row"]') || nameEl.closest('li');
        if (!row) continue;
        const cb = row.querySelector('input[type="checkbox"]');
        if (!cb) continue;
        found = { cb, cityText };
        break;
      }

      // Fallback: если .nd4-ak3 не нашёл — берём первую ячейку <td>
      if (!found) {
        for (const row of document.querySelectorAll('tr, [role="row"], li')) {
          if (row.querySelectorAll('tr, [role="row"]').length > 0) continue;
          if (row.tagName === 'LI' && row.querySelectorAll('li').length > 0) continue;
          const firstCell = row.querySelector('td, [role="cell"], [role="gridcell"]');
          if (!firstCell) continue;
          const cellText = normCity(firstCell.textContent);
          if (!cityExactMatch(cellText, norm)) continue;
          const cb = row.querySelector('input[type="checkbox"]');
          if (!cb) continue;
          found = { cb, cityText: cellText };
          break;
        }
      }

      if (found) {
        const { cb, cityText } = found;
        if (cb.checked) return 'already';
        log(`   ↳ найден: «${cityText.slice(0, 60)}»`);
        // Надёжное нажатие: label → прямой клик → React change event
        const label = cb.closest('label');
        if (label) label.click(); else cb.click();
        await sleep(400);
        if (cb.checked) return 'checked';
        cb.click();
        await sleep(300);
        if (cb.checked) return 'checked';
        // React-совместимый fallback: меняем checked через нативный сеттер + change
        try {
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked').set;
          nativeSetter.call(cb, true);
          cb.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(300);
        } catch {}
        return 'checked';
      }

      // ── 2. Подсказки автодополнения ───────────────────────────────────
      const OPTION_SELECTORS = [
        '[role="option"]',
        '[role="listbox"] li',
        '[role="listbox"] > *',
        '[ods-popover-reference] li',
        '[ods-popover-reference] > * > *',
        '[data-testid*="option"]',
        '[data-testid*="suggest"]',
      ];
      let clickedSuggestion = false;
      suggestionLoop:
      for (const sel of OPTION_SELECTORS) {
        try {
          for (const el of document.querySelectorAll(sel)) {
            if (el.querySelectorAll('[role="option"], li').length > 1) continue;
            const rawText = el.textContent.trim();
            // Контейнер с несколькими вариантами — слишком длинный или с переводами строк
            if (rawText.length > 120 || rawText.split('\n').length > 3) continue;
            const elText = normCity(rawText);
            if (!cityExactMatch(elText, norm)) continue;
            log(`   ↳ в подсказке: «${el.textContent.trim().slice(0, 60)}»`);
            el.click();
            clickedSuggestion = true;
            await sleep(800);
            break suggestionLoop;
          }
        } catch {}
      }

      if (clickedSuggestion) {
        for (const row of document.querySelectorAll('tr, [role="row"], li')) {
          if (row.querySelectorAll('tr, [role="row"]').length > 0) continue;
          if (row.tagName === 'LI' && row.querySelectorAll('li').length > 0) continue;
          const nameEl2 = row.querySelector('.nd4-ak3') ||
                          row.querySelector('td, [role="cell"], [role="gridcell"]');
          if (!cityExactMatch(normCity(nameEl2 ? nameEl2.textContent : row.textContent), norm)) continue;
          const cb = row.querySelector('input[type="checkbox"]');
          if (!cb) continue;
          if (!cb.checked) {
            (cb.closest('label') || cb.parentElement || cb).click();
            await sleep(400);
          }
          return 'checked';
        }
        return 'checked';
      }

      if (Date.now() - startTime > REAL_TIMEOUT_MS) break;

      if (attempt === 3) {
        await _typeIntoSearch(searchInput, cityName);
        await sleep(800);
        continue;
      }

      await sleep(300);
    }

    return 'not_found';
  }

  // Нормализация для сравнения: ё→е, нижний регистр, убираем «г.» префикс, нормализуем пробелы
  function normCity(s) {
    return (s || '').toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/^г\.?\s+/, '')      // убираем «г.» / «г » только в начале строки
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Точное совпадение города: text должен НАЧИНАТЬСЯ с norm (не содержать где угодно).
  //
  // «саратов» в «саратовская область» → false (next char = 'с', буква)
  // «саратов» в «саратов, пензенская» → true  (next char = ',')
  // «кузнецк» в «кузнецк-12»          → false (next char = '-', дефис)
  // «клин»    в «клинцы»              → false (next char = 'ц', буква)
  // «клин»    в «клин клинцы»         → FALSE (next char = ' ', пробел НЕ разрешён!)
  //
  // Пробел намеренно исключён: если подсказка-контейнер содержит «Клин\nКлинцы»,
  // normCity превратит переводы строк в пробелы → «клин клинцы». Если разрешить
  // charAfter==' ', контейнер совпадёт и оба города будут выделены.
  // Озон всегда форматирует: «Клин, Московская обл.» — запятая, не пробел.
  function cityExactMatch(text, norm) {
    if (!text.startsWith(norm)) return false;
    const charAfter = text[norm.length] || '';
    return charAfter === '' || charAfter === ',' || charAfter === '(';
  }

  // Генерирует альтернативный вариант написания: заменяет е→ё или ё→е
  function altSpelling(s) {
    if (/ё/.test(s)) return s.replace(/ё/g, 'е');
    if (/е/.test(s)) return s.replace(/е/g, 'ё');
    return null;
  }

  // Обёртка: пробуем оригинальное написание, затем альтернативное е↔ё.
  // Без Promise.race — оба вызова последовательные, каждый со своим дедлайном.
  async function searchAndSelectCity(cityName) {
    const result = await _doSearchAndSelect(cityName);
    if (result === 'not_found') {
      const alt = altSpelling(cityName);
      if (alt && alt !== cityName) {
        log(`→ Пробуем альтернативное написание: «${alt}»`);
        return _doSearchAndSelect(alt);
      }
    }
    return result;
  }

  // ── Обработка одной зоны ────────────────────────────────────────────────

  function pBar(done, total, w = 16) {
    if (total === 0) return '';
    const f = Math.round((done / total) * w);
    return '[' + '█'.repeat(f) + '░'.repeat(w - f) + ']';
  }

  async function processZone(warehouseName, zoneTitle, cities, zoneNum, totalZones) {
    const report = { zone: zoneTitle, checked: [], already: [], notFound: [], failed: [] };
    const n = String(cities.length);
    const w = n.length; // ширина счётчика для выравнивания

    log('');
    log(`┌─────────────────────────────────────────`);
    log(`│  ЗОНА ${zoneNum} / ${totalZones}  •  ${zoneTitle}`);
    log(`│  Городов для обработки: ${cities.length}`);
    log(`└─────────────────────────────────────────`);

    // 1. Открываем редактор зоны
    log('→ Открываем редактор зоны...');
    if (!await findZoneEditButton(warehouseName, zoneTitle)) {
      log('   Кнопка не видна — раскрываем скрытые методы...');
      await expandHiddenMethods(warehouseName);
      await sleep(1000);
      if (!await findZoneEditButton(warehouseName, zoneTitle)) {
        log(`❌ Зона «${zoneTitle}» не найдена — пропускаем`);
        return report;
      }
    }
    await sleep(1500);

    // 2. Переход на страницу выбора городов
    log('→ Переходим к выбору городов...');
    await clickButton('Далее');
    if (!await waitForSearchPage()) {
      await sleep(3000);
      await clickButton('Далее');
      await waitForSearchPage();
    }
    log('   Страница городов загружена ✓');
    log('');

    // 3. Отмечаем города
    for (let i = 0; i < cities.length; i++) {
      checkStop();

      while (window.__SD_PAUSE) {
        checkStop();
        await sleep(2000);
      }

      if (window.__SD_SKIP_ZONE) {
        window.__SD_SKIP_ZONE = false;
        log(`⏭ Пропуск зоны (${i + 1}/${cities.length}) — переходим к сохранению`);
        break;
      }

      window.dispatchEvent(new CustomEvent('sd-activate-tab'));
      await sleep(200);

      const city = cities[i];
      const num = String(i + 1).padStart(w, ' ');

      let status;
      try {
        status = await searchAndSelectCity(city);
      } catch (err) {
        log(`❌  ${num}/${n}  ${city}  (ошибка)`);
        report.failed.push(city);
        sendProgress(i + 1, cities.length, zoneTitle);
        continue;
      }

      switch (status) {
        case 'checked':
          log(`✅  ${num}/${n}  ${city}`);
          report.checked.push(city);
          break;
        case 'already':
          log(`↩   ${num}/${n}  ${city}  — уже был отмечен`);
          report.already.push(city);
          break;
        case 'not_found':
          log(`⚠   ${num}/${n}  ${city}  — не найден`);
          report.notFound.push(city);
          break;
        default:
          log(`❌  ${num}/${n}  ${city}  — ошибка`);
          report.failed.push(city);
      }

      sendProgress(i + 1, cities.length, zoneTitle);

      // Прогресс-строка каждые 10 городов
      if ((i + 1) % 10 === 0 || i + 1 === cities.length) {
        const bar = pBar(i + 1, cities.length);
        log(`    ${bar} ${i + 1}/${cities.length} городов`);
      }
    }

    // 4. Итог перед сохранением
    log('');
    log(`    ✅ Отмечено: ${report.checked.length}   ↩ Уже были: ${report.already.length}   ⚠ Не найдено: ${report.notFound.length}`);
    log('');

    // 5. Сохранение
    log('💾 Сохраняем зону...');
    let saved = false;

    const findSaveBtn = () => {
      const all = [...document.querySelectorAll('button')].filter(
        b => b.textContent.trim() === 'Сохранить' && b.offsetParent !== null && !b.disabled
      );
      return all.find(b => b.classList.contains('nd4-q7')) || all[0];
    };

    for (let step = 0; step < 15; step++) {
      const saveBtn = findSaveBtn();
      if (saveBtn) {
        saveBtn.scrollIntoView({ block: 'center' });
        await sleep(300);
        saveBtn.click();
        saved = true;
        break;
      }
      const next = await clickButton('Далее', 5000);
      if (!next) {
        log(`⚠ Шаг ${step + 1}: кнопки «Далее» и «Сохранить» не найдены`);
        break;
      }
      log(`   Шаг ${step + 1}: переходим дальше...`);
      await sleep(1200);
    }

    if (!saved) {
      log('⚠ Не могу найти кнопку «Сохранить» — нужна помощь!');
      log('📋 РУЧНОЙ РЕЖИМ: нажмите «Сохранить» на странице, затем «Продолжить» в расширении');
      window.__SD_PAUSE = true;
      window.dispatchEvent(new CustomEvent('sd-status', { detail: { status: 'paused', detail: 'manual' } }));
      while (window.__SD_PAUSE) {
        checkStop();
        await sleep(2000);
      }
      log('▶ Продолжаем...');
      saved = true;
    }

    // Ждём закрытия редактора
    for (let i = 0; i < 30; i++) {
      const saveBtnVisible = [...document.querySelectorAll('button')].some(
        b => b.textContent.trim() === 'Сохранить' && b.offsetParent !== null
      );
      const warehouseCards = document.querySelectorAll('[data-widget="warehouse-card-title"]').length;
      if (!saveBtnVisible || warehouseCards > 0) break;
      await sleep(1000);
    }
    await sleep(1500);

    log(`✅ Зона ${zoneNum} сохранена!`);
    log('');

    return report;
  }

  // ── Маппинг зон Excel → страница ───────────────────────────────────────

  function matchZones(pageZones, excelZones) {
    const mapping = {};
    for (const excelZone of Object.keys(excelZones)) {
      const zoneMatch = excelZone.match(/(\d+)/);
      const zoneNum = zoneMatch ? zoneMatch[1] : '';

      for (const pz of pageZones) {
        if (Object.values(mapping).includes(pz.title)) continue;
        if (excelZone.toLowerCase() === pz.title.toLowerCase()) {
          mapping[excelZone] = pz.title;
          break;
        }
        if (zoneNum) {
          const pattern = new RegExp(`зона\\s*\\.?\\s*${zoneNum}(?!\\d)`, 'i');
          if (pattern.test(pz.title)) {
            mapping[excelZone] = pz.title;
            break;
          }
        }
      }
    }
    return mapping;
  }

  // ── MAIN ────────────────────────────────────────────────────────────────

  async function main() {
    log('🚀 АВТОМАТИЗАЦИЯ ОЗОН СКЛАДОВ — СТАРТ');

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

    log(`→ Городов: ${cities.length}`);

    // Проверка авторизации
    if (!await checkAuth()) {
      log('⚠️ Требуется авторизация. Войдите в аккаунт Ozon Seller.');
      log('→ Ожидание авторизации...');
      for (let i = 0; i < 120; i++) {
        await sleep(2000);
        if (await checkAuth(5000)) break;
      }
      if (!await checkAuth(5000)) {
        log('❌ Авторизация не выполнена');
        setStatus('error', 'Auth failed');
        return;
      }
    }
    log('✅ Авторизация подтверждена');

    // Прокручиваем страницу чтобы подгрузить все склады (lazy loading)
    await scrollToLoadAllWarehouses();

    // Сканируем склады
    let warehouses = scanWarehouses();
    if (!warehouses.length) {
      log('❌ Склады не найдены');
      setStatus('error', 'No warehouses');
      return;
    }

    log(`→ Найдено складов: ${warehouses.length}`);
    for (const wh of warehouses) {
      log(`   • ${wh.name} (${wh.zones.length} зон)`);
    }

    // Выбираем склад по имени из параметров (пользователь выбрал в UI)
    const warehouseName = params.ozonWarehouseName || warehouses[0].name;

    // Поиск склада: точное совпадение → нормализованное (только точки→пробел, регистр, ё→е)
    // Скобки НЕ убираем — «Склад (старый)» и «Склад» должны различаться
    function normWh(s) {
      return (s || '').toLowerCase().replace(/ё/g, 'е').replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
    }
    const targetNorm = normWh(warehouseName);
    const warehouse =
      warehouses.find(w => w.name === warehouseName) ||
      warehouses.find(w => normWh(w.name) === targetNorm);

    if (!warehouse) {
      log(`❌ Склад «${warehouseName}» не найден на странице`);
      setStatus('error', 'Warehouse not found');
      return;
    }
    const resolvedName = warehouse.name;
    if (resolvedName !== warehouseName) {
      log(`→ Склад найден по частичному совпадению: «${resolvedName}»`);
    } else {
      log(`→ Выбран склад: ${resolvedName}`);
    }

    // Раскрываем скрытые методы
    await expandHiddenMethods(resolvedName);
    await sleep(1000);

    // Пересканируем
    warehouses = scanWarehouses();
    const updatedWh =
      warehouses.find(w => w.name === resolvedName) ||
      warehouses.find(w => normWh(w.name) === normWh(resolvedName));
    if (!updatedWh) {
      log('❌ Склад не найден после обновления');
      setStatus('error', 'Warehouse lost');
      return;
    }

    const pageZones = updatedWh.zones;
    log(`→ Зон на странице: ${pageZones.length}`);

    // Строим citiesData: маппинг pageZoneTitle → список городов
    // params.ozonPageZones — выбранные пользователем зоны (titles со страницы)
    // params.zones — данные из Excel: { "Зона 1": ["Москва","Пенза",...], "Зона 2": [...] }
    let citiesData = {};
    const selectedPageZones = params.ozonPageZones || [];
    const excelZones = params.zones || {};
    const excelKeys = Object.keys(excelZones);

    if (selectedPageZones.length > 0 && excelKeys.length > 0) {
      // Маппим по порядковому номеру зоны: "Зона 1" из Excel → первая выбранная page zone
      for (const excelKey of excelKeys) {
        const zoneMatch = excelKey.match(/(\d+)/);
        const zoneNum = zoneMatch ? parseInt(zoneMatch[1]) : 0;
        // Ищем page zone с тем же номером
        let matched = false;
        for (const pzTitle of selectedPageZones) {
          const pageMatch = pzTitle.match(/(\d+)/);
          const pageNum = pageMatch ? parseInt(pageMatch[1]) : 0;
          if (zoneNum > 0 && zoneNum === pageNum) {
            citiesData[pzTitle] = excelZones[excelKey];
            matched = true;
            break;
          }
        }
        if (!matched && selectedPageZones.length === 1) {
          citiesData[selectedPageZones[0]] = excelZones[excelKey];
        }
      }
    } else if (selectedPageZones.length > 0) {
      // Нет Excel данных — все города в каждую выбранную зону
      for (const pzTitle of selectedPageZones) {
        citiesData[pzTitle] = cities;
      }
    } else if (excelKeys.length > 0) {
      // Нет выбранных page zones — используем matchZones как fallback
      const zoneMapping = matchZones(pageZones, excelZones);
      for (const [ek, pt] of Object.entries(zoneMapping)) {
        citiesData[pt] = excelZones[ek];
      }
    } else {
      if (pageZones.length > 0) {
        citiesData[pageZones[0].title] = cities;
      }
    }

    log('');
    log('Зоны для обработки:');
    const citiesEntries = Object.entries(citiesData);
    for (let i = 0; i < citiesEntries.length; i++) {
      const [zone, zc] = citiesEntries[i];
      log(`  ${i + 1}. ${zone}  — ${zc.length} городов`);
    }

    if (!citiesEntries.length) {
      log('❌ Ни одна зона не сопоставлена');
      setStatus('error', 'No zone mapping');
      return;
    }

    // Обрабатываем каждую зону
    const allReports = [];
    const totalZones = citiesEntries.filter(([, zc]) => zc.length > 0).length;
    let zoneNum = 0;
    for (const [pageZoneTitle, zoneCitiesRaw] of citiesEntries) {
      checkStop();
      // Дедупликация: убираем дубли из Excel (регистронезависимо, ё→е)
      const seenCities = new Set();
      const zoneCities = zoneCitiesRaw.filter(c => {
        const k = normCity(c);
        if (seenCities.has(k)) return false;
        seenCities.add(k);
        return true;
      });
      if (!zoneCities.length) continue;
      zoneNum++;

      const report = await processZone(resolvedName, pageZoneTitle, zoneCities, zoneNum, totalZones);
      allReports.push(report);

      // Редактор закрыт. После сохранения Ozon сбрасывает lazy-load —
      // список складов снова показывает только первые ~5. Прокручиваем заново.
      await sleep(3000); // пауза: даём странице полностью осесть после сохранения
      await scrollToLoadAllWarehouses();

      // Проверяем что наш склад виден; если нет — одна повторная попытка
      let cardsAfter = [...document.querySelectorAll('[data-widget="warehouse-card-title"]')];
      let targetCard = cardsAfter.find(c => normWh(c.textContent.trim()) === normWh(resolvedName));
      if (!targetCard) {
        log('→ Склад не найден с первой прокрутки — повторная попытка...');
        await sleep(3000);
        await scrollToLoadAllWarehouses();
        cardsAfter = [...document.querySelectorAll('[data-widget="warehouse-card-title"]')];
        targetCard = cardsAfter.find(c => normWh(c.textContent.trim()) === normWh(resolvedName));
      }
      if (!targetCard) {
        log(`⚠️ Склад «${resolvedName}» не найден после прокрутки — пропускаем остаток`);
        break;
      }

      // Раскрываем методы (могли свернуться после сохранения)
      log('→ Проверяем раскрытие зон...');
      await expandHiddenMethods(resolvedName);
      await sleep(800);
    }

    // Итоговый отчёт
    const totalChecked  = allReports.reduce((s, r) => s + r.checked.length, 0);
    const totalAlready  = allReports.reduce((s, r) => s + r.already.length, 0);
    const totalNotFound = allReports.reduce((s, r) => s + r.notFound.length, 0);
    const totalFailed   = allReports.reduce((s, r) => s + r.failed.length, 0);
    const totalCities   = totalChecked + totalAlready + totalNotFound + totalFailed;

    log('');
    log('┌─────────────────────────────────────────');
    log('│  ИТОГОВЫЙ РЕЗУЛЬТАТ');
    log('├─────────────────────────────────────────');
    log(`│  Зон обработано:    ${allReports.length}`);
    log(`│  Городов всего:     ${totalCities}`);
    log(`│  ✅ Отмечено новых: ${totalChecked}`);
    log(`│  ↩ Уже были:       ${totalAlready}`);
    log(`│  ⚠ Не найдено:     ${totalNotFound}`);
    if (totalFailed > 0) log(`│  ❌ Ошибки:         ${totalFailed}`);
    log('└─────────────────────────────────────────');
    log('');

    setStatus('completed', `Отмечено ${totalChecked}, не найдено ${totalNotFound}`);
    log('🏁 Всё готово! Отчёт сохраняется...');

    // ── Генерируем и скачиваем отчёт ────────────────────────────────────────
    try {
      const now = new Date();
      const dateStr = now.toLocaleString('ru-RU');
      const lines = [
        '╔══════════════════════════════════════════════════════╗',
        '║      SimaDesk — Отчёт автоматизации Ozon Склады      ║',
        '╚══════════════════════════════════════════════════════╝',
        `Дата:    ${dateStr}`,
        `Склад:   ${resolvedName}`,
        '',
      ];
      for (const r of allReports) {
        lines.push(`═══ ${r.zone} ═══`);
        if (r.checked.length)  lines.push(`  ✅ Отмечены    (${r.checked.length}): ${r.checked.join(', ')}`);
        if (r.already.length)  lines.push(`  ✓  Уже были   (${r.already.length}): ${r.already.join(', ')}`);
        if (r.notFound.length) lines.push(`  ⚠️  Не найдены (${r.notFound.length}): ${r.notFound.join(', ')}`);
        if (r.failed.length)   lines.push(`  ❌ Ошибки      (${r.failed.length}): ${r.failed.join(', ')}`);
        lines.push('');
      }
      lines.push('═══ ИТОГО ═══');
      lines.push(`Зон обработано:    ${allReports.length}`);
      lines.push(`Городов всего:     ${totalCities}`);
      lines.push(`✅ Отмечено:       ${totalChecked}`);
      lines.push(`✓  Уже были:      ${totalAlready}`);
      lines.push(`⚠️  Не найдено:    ${totalNotFound}`);
      if (totalFailed > 0) lines.push(`❌ Ошибки:         ${totalFailed}`);

      const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const fileDate = now.toISOString().slice(0, 10);
      a.download = `ozon-report-${fileDate}.txt`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
      log('📥 Отчёт скачан');
    } catch (e) {
      log(`⚠️ Не удалось скачать отчёт: ${e.message}`);
    }
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
