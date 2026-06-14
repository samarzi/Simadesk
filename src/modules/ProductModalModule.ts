import { debug } from '@/utils/debug';
import { boxes } from '../stores/appStore';
import { apiService } from '../services/api';
import { idbCache } from '../services/idbCache';
import { esc as escHtml, parsePhotoUrls } from '../utils/format';
import { costPriceDb } from '../services/costPriceDb';
import { dimensionsDb } from '../services/dimensionsDb';
import { repricerRulesDb } from '../services/repricerRulesDb';
import type { App } from '../App';
import { I } from '@/utils/icons';

/** Просмотр/редактирование/удаление товара, push изменений на Ozon (см. App.ts). */
export class ProductModalModule {
  constructor(private app: App) {}

  /** Единый метод просмотра и редактирования товара */
  viewProduct(id: string, mode: 'view' | 'edit' = 'view') {
    const p = this.app.allProducts.find(x => x.id === id) || this.app.filtered.find(x => x.id === id);
    if (!p) return;
    const d = p.data || {};
    const art  = String(d['Артикул*'] || d['Артикул'] || id);
    const name = String(d['Название товара*'] || d['Название товара'] || 'Товар');

    // ── Фото ──────────────────────────────────────────────────────────────────
    const mainPhoto = String(d['Ссылка на главное фото*'] || '');
    const extraRaw  = String(d['Ссылки на дополнительные фото'] || '');
    const allPhotos = [
      ...(mainPhoto ? [mainPhoto] : []),
      ...parsePhotoUrls(extraRaw).filter((u: string) => u.startsWith('http')),
      ...Object.entries(d)
        .filter(([k]) => /^Дополнительное фото/.test(k))
        .map(([,v]) => String(v)).filter(v => v.startsWith('http')),
    ].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).slice(0, 20);

    const galleryHtml = allPhotos.length ? `
      <div style="margin-bottom:12px">
        <img id="gallery-main-img" src="${escHtml(allPhotos[0])}" loading="lazy"
          style="width:100%;max-height:280px;object-fit:contain;border-radius:10px;cursor:pointer;background:var(--bg2)"
          onclick="window.open(this.src,'_blank')"
          onerror="this.style.opacity='.2'">
        ${allPhotos.length > 1 ? `
          <div style="display:flex;gap:5px;overflow-x:auto;padding-top:8px;scrollbar-width:thin">
            ${allPhotos.map((url, i) => `
              <img src="${escHtml(url)}" loading="lazy"
                style="width:52px;height:52px;object-fit:cover;border-radius:6px;cursor:pointer;flex-shrink:0;
                       border:2px solid ${i === 0 ? 'var(--accent)' : 'transparent'};transition:border-color .15s"
                onclick="document.getElementById('gallery-main-img').src='${escHtml(url)}';
                         document.querySelectorAll('.gthumb').forEach(t=>t.style.borderColor='transparent');
                         this.style.borderColor='var(--accent)'"
                class="gthumb" onerror="this.style.display='none'">
            `).join('')}
          </div>` : ''}
      </div>` : '';

    // ── Репрайсер ─────────────────────────────────────────────────────────────
    const repricerRules: any[] = repricerRulesDb.all();
    const matchedRules = repricerRules.filter((r: any) =>
      r.status === 'active' && (
        r.vendorCode?.toLowerCase() === art.toLowerCase() ||
        r.productId?.toLowerCase() === art.toLowerCase()
      )
    );
    const hasRepricer = matchedRules.length > 0;

    // ── FBO определение ───────────────────────────────────────────────────────
    const box = this.app.activeBoxId ? (window as any).boxes?.get().find((b: any) => b.id === this.app.activeBoxId) : null;
    const boxName = (box?.name || '').toLowerCase();
    const isFBO = boxName.includes('fbo') || boxName.includes('фбо') || boxName.includes('fby') || boxName.includes('фбу');

    // ── МП-присутствие ────────────────────────────────────────────────────────
    const mpInfo = (this.app.mpPresence as any)?.get(art.toLowerCase()) || [];
    const mpBadges = mpInfo.length ? `
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px">
        ${mpInfo.map((info: any) => `
          <div style="display:flex;align-items:center;gap:4px;padding:3px 8px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;font-size:10px">
            <span>${info.mp === 'ozon' ? I.ozon : info.mp === 'ym' || info.mp === 'yandex' ? I.yandex : I.wb}</span>
            <span style="font-weight:600">${escHtml(info.storeName || info.mp)}</span>
            ${info.fulfillment ? `<span style="opacity:.6">${info.fulfillment}</span>` : ''}
          </div>`).join('')}
      </div>` : '';

    // ── Сортировка полей ──────────────────────────────────────────────────────
    const HIDDEN = new Set([
      'Ссылка на главное фото*','Ссылки на дополнительные фото','Ссылки на фото 360',
      'Артикул фото','Образец цвета','#Хештеги','Rich-контент JSON','Аннотация','Описание',
      'Ошибка','Предупреждение',
    ]);
    const READONLY_FIELDS = new Set(['Артикул*','Артикул','SKU на Маркете','ID категории ЯМ']);
    const STOCK_FIELDS = new Set<string>(); // stock columns removed from sync

    // Парсим attr meta для словарных подсказок
    let attrMeta: Record<string, any> = {};
    try { if (d['_ozon_attr_meta']) attrMeta = JSON.parse(String(d['_ozon_attr_meta'])); } catch (e) { debug.warn('[ProductModalModule] swallowed error', e); }

    const isMpSynced = !!(d['_ozon_store_id'] || d['_ym_store_id']);
    const mpLabel = d['_ozon_store_id'] ? 'Ozon' : d['_ym_store_id'] ? 'Яндекс Маркет' : '';

    const price = String(d['Цена, руб.*'] || d['Цена *'] || d['Цена, руб.'] || '');

    // Фильтруем служебные поля (начинаются с _) и технические поля из HIDDEN
    const PHOTO_FIELD_KEYS = new Set([
      'Ссылка на главное фото*','Ссылки на дополнительные фото','Ссылки на фото 360','Образец цвета',
    ]);
    const INTERNAL_PREFIXES = ['_ozon_', '_ym_', '_wb_'];
    const isInternal = (k: string) => INTERNAL_PREFIXES.some(p => k.startsWith(p));

    const visEntries = Object.entries(d).filter(([k, v]) => {
      if (isInternal(k)) return false;
      if (HIDDEN.has(k)) return false;
      if (PHOTO_FIELD_KEYS.has(k)) return false; // Фото показаны в галерее отдельно
      if (k.startsWith('Дополнительное фото')) return false; // тоже в галерее
      return v !== '' && v != null;
    });

    const descText = String(d['Описание'] || d['Аннотация'] || '');

    // ── VIEW MODE ─────────────────────────────────────────────────────────────
    if (mode === 'view') {
      const costVal = costPriceDb.get(art);
      const repricerSection = `
        <div style="padding:10px 14px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;margin-bottom:10px">
          <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">${I.dollarSign} Репрайсер</div>
          <div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start">
            <div>
              <div style="font-size:10px;color:var(--muted);margin-bottom:2px">Себестоимость</div>
              <div style="font-size:17px;font-weight:800;color:${costVal != null ? 'var(--text)' : 'var(--muted)'};font-family:'Syne',sans-serif">
                ${costVal != null ? costVal.toLocaleString('ru') + ' ₽' : '— не задана'}
              </div>
            </div>
            ${costVal != null && price ? `
              <div>
                <div style="font-size:10px;color:var(--muted);margin-bottom:2px">Наценка</div>
                <div style="font-size:17px;font-weight:800;color:var(--text);font-family:'Syne',sans-serif">
                  ×${(Number(price) / costVal).toFixed(2)}
                  <span style="font-size:11px;font-weight:500;color:var(--muted);margin-left:3px">
                    (+${Math.round(Number(price) - costVal).toLocaleString('ru')} ₽)
                  </span>
                </div>
              </div>` : ''}
            <div>
              <div style="font-size:10px;color:var(--muted);margin-bottom:2px">Правила</div>
              ${hasRepricer
                ? `<div style="font-size:12px;font-weight:600;color:#16a34a">✓ ${matchedRules.map((r:any)=>escHtml(r.storeName||r.marketplace)).join(', ')}</div>`
                : `<div style="font-size:12px;color:var(--muted)">не настроен</div>`}
            </div>
          </div>
          ${costVal == null ? `<div style="font-size:11px;color:#f59e0b;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">⚠ Себестоимость не задана — репрайсер не сможет рассчитать цену</div>` : ''}
        </div>`;

      const fboBanner = isFBO ? `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;margin-bottom:10px;font-size:11px;color:var(--muted)">
          <span>${I.server}</span> FBO — остатки управляются маркетплейсом
        </div>` : '';

      // Разбиваем на секции для лучшей читаемости
      const MAIN_VIEW = new Set(['Артикул*','Артикул','Название товара*','Название товара','Цена, руб.*','Цена, руб.','Цена *','Старая цена, руб.','Штрихкод','Бренд','Бренд*','Предмет','Категория','NM ID']);
      const mainViewEntries = visEntries.filter(([k]) => MAIN_VIEW.has(k));
      const extraViewEntries = visEntries.filter(([k]) => !MAIN_VIEW.has(k) && k !== 'Описание' && k !== 'Аннотация');

      const renderSection = (entries: Array<[string, any]>) => entries.map(([k, v]) => `
        <div class="detail-item">
          <div class="dk">${escHtml(k.replace('*',''))}</div>
          <div class="dv" style="user-select:text">${escHtml(String(v))}</div>
        </div>`).join('');

      const dims = dimensionsDb.get(art);
      const fmtG = (g: number|null) => g != null ? `${g} г · ${(g/1000).toFixed(3).replace(/\.?0+$/,'')} кг` : '—';
      const fmtMm = (mm: number|null) => mm != null ? `${mm} мм` : '—';
      const fmtCm = (mm: number|null) => mm != null ? `${(mm/10).toFixed(1).replace('.0','')} см` : '—';
      const dimsSection = dims && (dims.weight_g != null || dims.length_mm != null) ? `
        <div style="padding:10px 14px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;margin-bottom:10px">
          <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">${I.package} Габариты и вес</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:6px">
            <div>
              <div style="font-size:10px;color:var(--muted);margin-bottom:2px">Вес</div>
              <div style="font-size:14px;font-weight:700;color:var(--text)">${fmtG(dims.weight_g)}</div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--muted);margin-bottom:2px">Размеры Д×Ш×В</div>
              <div style="font-size:14px;font-weight:700;color:var(--text)">${fmtMm(dims.length_mm)} × ${fmtMm(dims.width_mm)} × ${fmtMm(dims.height_mm)}</div>
            </div>
          </div>
          <div style="font-size:10px;color:var(--muted);padding-top:6px;border-top:1px solid var(--border)">
            WB / ЯМ (см + кг): ${fmtCm(dims.length_mm)} × ${fmtCm(dims.width_mm)} × ${fmtCm(dims.height_mm)} · ${dims.weight_g != null ? (dims.weight_g/1000).toFixed(3).replace(/\.?0+$/,'') + ' кг' : '—'}
          </div>
        </div>
      ` : `
        <div style="padding:10px 14px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;margin-bottom:10px">
          <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">${I.package} Габариты и вес</div>
          <div style="font-size:12px;color:var(--muted)">Не задано — нажми «Редактировать» чтобы указать вес и размеры</div>
        </div>
      `;
      const body = `
        ${repricerSection}${dimsSection}${fboBanner}${galleryHtml}${mpBadges}
        ${price ? `<div style="font-size:24px;font-weight:700;color:${hasRepricer ? '#16a34a' : 'var(--accent)'};margin-bottom:12px;font-family:'Syne',sans-serif">
          ${Number(price).toLocaleString('ru')} ₽
          ${hasRepricer ? `<span style="font-size:11px;font-weight:500;opacity:.7;margin-left:6px">репрайсер</span>` : ''}
        </div>` : ''}
        ${mainViewEntries.length ? `<div class="detail-grid">${renderSection(mainViewEntries)}</div>` : ''}
        ${extraViewEntries.length ? `
          <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin:12px 0 6px">Характеристики</div>
          <div class="detail-grid">${renderSection(extraViewEntries)}</div>` : ''}
        ${descText ? `<div class="divider" style="margin:12px 0"></div>
          <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:6px">Описание</div>
          <div style="font-size:12.5px;color:var(--text2);line-height:1.6;user-select:text">${escHtml(descText)}</div>` : ''}
        ${visEntries.length === 0 && !descText ? '<div style="color:var(--muted);font-size:13px;padding:8px 0">Нет данных</div>' : ''}
      `;

      this.app.openModalLg(name,
        `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <code style="font-size:12px;background:var(--bg2);padding:2px 6px;border-radius:4px">${escHtml(art)}</code>
          <button class="copy-btn" onclick="window.app.copyToClipboard('${escHtml(art)}')">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1"/><path d="M3.5 10.5V3.5h7"/></svg>
          </button>
        </div>`,
        body,
        `<button class="btn" onclick="window.app.closeModal()">Закрыть</button>
         <button class="btn" onclick="window.app.exportSingleProduct('${id}')">↓ xlsx</button>
         <button class="btn btn-danger" onclick="window.app.confirmDeleteProduct('${id}','${escHtml(art)}')">✕</button>
         <button class="btn btn-primary" onclick="window.app.viewProduct('${id}','edit')" style="margin-left:auto">✎ Редактировать</button>`
      );
      return;
    }

    // ── EDIT MODE ─────────────────────────────────────────────────────────────
    // Скрытые служебные поля сохраняем как hidden inputs
    const hiddenInputs = Object.entries(d)
      .filter(([k]) => k.startsWith('_ozon_') || k.startsWith('_ym_') || k.startsWith('_wb_'))
      .map(([k,v]) => `<input type="hidden" class="edit-inp" data-key="${escHtml(k)}" value="${escHtml(String(v??''))}">`)
      .join('');

    // Категоризация полей
    const MAIN_FIELDS  = ['Артикул*','Артикул','Название товара*','Название товара',
      'Цена, руб.*','Цена *','Цена, руб.','Старая цена, руб.','Мин. цена, руб.',
      'Штрихкод','Бренд','Бренд*','Предмет','Категория','НДС, %'];
    const PHOTO_KEYS   = new Set(['Ссылка на главное фото*','Ссылки на дополнительные фото',
      'Ссылки на фото 360','Образец цвета']);
    const DESC_KEYS    = new Set(['Описание','Аннотация','Rich-контент JSON']);
    const STOCK_KEYS   = new Set(['NM ID','SKU на Маркете','ID категории ЯМ']);

    const mainEntries  = visEntries.filter(([k]) => MAIN_FIELDS.includes(k) || STOCK_KEYS.has(k));
    const descEntries  = visEntries.filter(([k]) => DESC_KEYS.has(k));
    const extraEntries = visEntries.filter(([k]) =>
      !MAIN_FIELDS.includes(k) && !PHOTO_KEYS.has(k) && !k.startsWith('Дополнительное фото') &&
      !DESC_KEYS.has(k) && !STOCK_KEYS.has(k) && !(k.includes('фото') && !MAIN_FIELDS.includes(k))
    );

    const renderField = (k: string, v: any): string => {
      const isReadonly      = READONLY_FIELDS.has(k);
      const isStockField    = STOCK_FIELDS.has(k);
      const isPriceField    = k.toLowerCase().includes('цена');
      const isRepricerLocked = isPriceField && hasRepricer;
      const isFboLocked     = isStockField && isFBO;
      const locked          = isReadonly || isRepricerLocked || isFboLocked;
      const isDictAttr      = attrMeta[k]?.dictionary_value_id !== undefined;
      const isDesc          = DESC_KEYS.has(k);

      let inputHtml: string;
      if (locked) {
        const reason = isRepricerLocked ? `${I.heart} репрайсер` : isFboLocked ? `${I.server} FBO` : 'только чтение';
        inputHtml = `<div style="display:flex;align-items:center;gap:6px">
          <div style="flex:1;padding:5px 8px;background:${isRepricerLocked ? '#16a34a10' : 'var(--bg3)'};border-radius:6px;border:1px solid ${isRepricerLocked ? '#16a34a30' : 'var(--border)'};font-size:12px;color:var(--text2)">${escHtml(String(v??''))}</div>
          <span style="font-size:10px;color:var(--muted)">${reason}</span>
        </div><input type="hidden" class="edit-inp" data-key="${escHtml(k)}" value="${escHtml(String(v??''))}">`;
      } else if (isDesc) {
        inputHtml = `<textarea class="edit-inp" data-key="${escHtml(k)}" rows="4"
          style="width:100%;resize:vertical;font-size:12px;padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text)"
          >${escHtml(String(v??''))}</textarea>`;
      } else {
        inputHtml = `<input class="edit-inp" data-key="${escHtml(k)}" value="${escHtml(String(v??''))}"
          style="width:100%;font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text)"
          ${isDictAttr ? 'title="Словарный атрибут маркетплейса — вводите точное значение"' : ''}>`;
      }

      const syncDot  = isMpSynced && !locked ? `<span style="width:5px;height:5px;border-radius:50%;background:#005bff;display:inline-block;margin-left:4px" title="Синхронизируется с ${mpLabel}"></span>` : '';
      const dictBadge = isDictAttr && !locked ? `<span style="font-size:9px;padding:1px 3px;border-radius:3px;background:var(--bg3);color:var(--muted);margin-left:3px">dict</span>` : '';

      return `<div style="display:grid;grid-template-columns:140px 1fr;gap:8px;align-items:start;padding:4px 0;border-bottom:1px solid var(--border)">
        <div style="font-size:11px;color:var(--text2);padding-top:7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(k)}">
          ${escHtml(k.replace('*',''))}${syncDot}${dictBadge}
        </div>
        <div>${inputHtml}</div>
      </div>`;
    };

    // Фото-секция с загрузкой с ПК
    const photoSection = (() => {
      // Собираем фото: главное + доп. (из единого поля «Ссылки на дополнительные фото»)
      const photoFields: Array<{key: string; url: string; slot: number}> = [];
      const mainPh = String(d['Ссылка на главное фото*'] || '');
      photoFields.push({ key: 'Ссылка на главное фото*', url: mainPh, slot: 0 });

      const extraRawForEdit = String(d['Ссылки на дополнительные фото'] || '');
      const extraUrls = extraRawForEdit.split(/[\n;]+/).map(s => s.trim()).filter(Boolean);
      // Показываем существующие + 3 пустых слота для добавления
      const totalExtra = Math.max(extraUrls.length + 3, 5);
      for (let i = 0; i < totalExtra; i++) {
        photoFields.push({
          key: `_extra_photo_${i}`,
          url: extraUrls[i] || '',
          slot: i + 1,
        });
      }

      return `
        <div style="margin-bottom:14px">
          <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;display:flex;align-items:center;gap:8px">
            Фото
            <span style="font-size:10px;font-weight:400;color:var(--muted)">(загрузить с ПК или вставить URL)</span>
          </div>
          <div id="edit-photos-grid" style="display:flex;flex-direction:column;gap:6px">
            ${photoFields.map((pf, idx) => `
              <div class="edit-photo-row" style="display:flex;align-items:center;gap:8px" data-photo-idx="${idx}">
                <div style="width:44px;height:44px;border-radius:6px;background:var(--bg3);flex-shrink:0;overflow:hidden;border:1px solid var(--border)">
                  ${pf.url ? `<img src="${escHtml(pf.url)}" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none'">` : `<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:16px;color:var(--muted)">${idx === 0 ? I.image : '+'}</div>`}
                </div>
                <input class="edit-photo-inp" data-photo-slot="${idx}" value="${escHtml(pf.url)}"
                  placeholder="${idx === 0 ? 'Главное фото — URL' : `Доп. фото ${idx} — URL`}"
                  style="flex:1;font-size:11px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text)"
                  oninput="window.app.onPhotoUrlInput(this, ${idx})">
                <label style="cursor:pointer;flex-shrink:0" title="Загрузить с ПК">
                  <input type="file" accept="image/*" style="display:none" onchange="window.app.onPhotoFileChosen(this, '${idx === 0 ? 'Ссылка на главное фото*' : 'Ссылки на дополнительные фото'}', '${id}', ${idx})">
                  <div class="btn" style="padding:5px 8px;font-size:11px;gap:4px;pointer-events:none">
                    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" style="width:12px;height:12px"><path d="M7 1v8M4 5l3-4 3 4"/><path d="M2 11h10"/></svg>
                    с ПК
                  </div>
                </label>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    })();

    const syncBanner = isMpSynced ? `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:color-mix(in srgb,#005bff 8%,transparent);border:1px solid color-mix(in srgb,#005bff 25%,transparent);border-radius:8px;margin-bottom:12px;font-size:12px">
        <svg viewBox="0 0 14 14" fill="none" stroke="#005bff" stroke-width="1.4" stroke-linecap="round" style="width:13px;height:13px;flex-shrink:0"><path d="M12 7A5 5 0 1 1 7 2"/><polyline points="12 2 12 5.5 8.5 5.5"/></svg>
        <span style="color:#005bff;font-weight:600">Синхр. с ${mpLabel}</span>
        <span style="color:var(--muted);font-size:11px">— изменения отправятся на маркетплейс</span>
      </div>` : '';

    const section = (title: string, fields: Array<[string, any]>, icon: string) => {
      if (!fields.length) return '';
      return `
        <div style="margin-bottom:14px">
          <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">${icon} ${title}</div>
          ${fields.map(([k,v]) => renderField(k, v)).join('')}
        </div>`;
    };

    const addFieldSection = `
      <div style="margin-top:10px;padding:8px 0">
        <div id="edit-add-field" style="display:none;gap:8px;align-items:flex-end;margin-bottom:8px">
          <div style="flex:1">
            <div style="font-size:10px;color:var(--muted);margin-bottom:2px">Название поля</div>
            <input id="new-field-name" class="form-input" style="font-size:12px" placeholder="Например: Состав, Страна производства...">
          </div>
          <div style="width:100px">
            <div style="font-size:10px;color:var(--muted);margin-bottom:2px">Значение</div>
            <input id="new-field-value" class="form-input" style="font-size:12px" placeholder="Значение">
          </div>
          <button class="btn btn-primary" style="font-size:12px;padding:5px 10px;white-space:nowrap"
            onclick="window.app.addNewFieldToEdit()">✓ Добавить</button>
          <button class="btn" style="font-size:12px;padding:5px 8px"
            onclick="document.getElementById('edit-add-field').style.display='none'">✕</button>
        </div>
        <div id="extra-fields-container"></div>
        <button class="btn" style="font-size:11px;gap:4px;color:var(--accent);border-color:var(--accent)"
          onclick="const el=document.getElementById('edit-add-field');el.style.display=el.style.display==='none'?'flex':'none';document.getElementById('new-field-name')?.focus()">
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" style="width:11px;height:11px"><path d="M7 1v12M1 7h12"/></svg>
          Добавить новое поле
        </button>
      </div>`;

    const costForEdit = costPriceDb.get(art);
    const repricerEditSection = `
      <div style="margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">${I.dollarSign} Репрайсер</div>
        <div style="display:grid;grid-template-columns:140px 1fr;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
          <div style="font-size:11px;color:var(--text2);padding-top:2px">Себестоимость</div>
          <div style="display:flex;align-items:center;gap:6px">
            <input id="edit-cost-price" data-article="${escHtml(art)}" type="number" min="0" step="0.01"
              value="${costForEdit ?? ''}" placeholder="Не задана"
              style="width:130px;font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text)">
            <span style="font-size:11px;color:var(--muted)">₽</span>
          </div>
        </div>
        <div style="padding:6px 0;font-size:11px;color:${hasRepricer ? '#16a34a' : 'var(--muted)'}">
          ${hasRepricer
            ? `✓ Репрайсер активен: <b>${matchedRules.map((r:any)=>escHtml(r.storeName||r.marketplace)).join(', ')}</b>`
            : `Репрайсер не настроен · <a href="#" onclick="event.preventDefault();window.app.closeModal();window.app.navigateTo('repricer')" style="color:var(--accent)">настроить →</a>`}
        </div>
      </div>`;

    const dimsForEdit = dimensionsDb.get(art);
    const dimsEditSection = `
      <div style="margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">${I.package} Габариты и вес (Ozon: мм + г)</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div>
            <div style="font-size:10px;color:var(--muted);margin-bottom:3px">Вес, г</div>
            <input id="dim-weight" type="number" min="0" step="1" value="${dimsForEdit?.weight_g ?? ''}" placeholder="напр. 350"
              style="width:100%;font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text)">
          </div>
          <div>
            <div style="font-size:10px;color:var(--muted);margin-bottom:3px">Длина, мм</div>
            <input id="dim-length" type="number" min="0" step="1" value="${dimsForEdit?.length_mm ?? ''}" placeholder="напр. 250"
              style="width:100%;font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text)">
          </div>
          <div>
            <div style="font-size:10px;color:var(--muted);margin-bottom:3px">Ширина, мм</div>
            <input id="dim-width" type="number" min="0" step="1" value="${dimsForEdit?.width_mm ?? ''}" placeholder="напр. 180"
              style="width:100%;font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text)">
          </div>
          <div>
            <div style="font-size:10px;color:var(--muted);margin-bottom:3px">Высота, мм</div>
            <input id="dim-height" type="number" min="0" step="1" value="${dimsForEdit?.height_mm ?? ''}" placeholder="напр. 80"
              style="width:100%;font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text)">
          </div>
        </div>
        <div style="font-size:10px;color:var(--muted);margin-top:6px">
          WB и ЯМ используют см + кг — конвертация автоматическая при синхронизации.
        </div>
      </div>
    `;
    const editBody = `
      ${syncBanner}${hiddenInputs}
      ${photoSection}
      ${repricerEditSection}
      ${dimsEditSection}
      ${section('Основные данные', mainEntries, I.clipboard('', 16))}
      ${section('Характеристики', extraEntries, I.tag('', 16))}
      ${section('Описание', descEntries, I.type('', 16))}
      ${addFieldSection}
    `;

    this.app.openModalLg(name,
      `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <code style="font-size:12px;background:var(--bg2);padding:2px 6px;border-radius:4px">${escHtml(art)}</code>
        <span style="font-size:11px;color:#005bff;font-weight:600">— редактирование</span>
      </div>`,
      editBody,
      `<button class="btn" onclick="window.app.viewProduct('${id}','view')">✗ Отмена</button>
       <button class="btn btn-primary" onclick="window.app.saveProduct('${id}')" style="margin-left:auto">${I.save} Сохранить</button>`
    );
  }

  /** Обновить превью фото при изменении URL */
  onPhotoUrlInput(inp: HTMLInputElement, idx: number) {
    const row = inp.closest('.edit-photo-row');
    if (!row) return;
    const imgWrap = row.querySelector('div');
    if (!imgWrap) return;
    const url = inp.value.trim();
    imgWrap.innerHTML = url
      ? `<img src="${escHtml(url)}" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none'">`
      : `<div style="display:flex;align-items:center;justify-content:height:100%;font-size:16px;color:var(--muted)">${idx === 0 ? I.image : '+'}</div>`;
  }

  /** Загрузка фото с ПК */
  async onPhotoFileChosen(input: HTMLInputElement, _fieldKey: string, productId: string, _idx: number) {
    const file = input.files?.[0];
    if (!file) return;
    const row = input.closest('.edit-photo-row') as HTMLElement;
    if (row) row.style.opacity = '0.5';
    try {
      const { uploadPhoto } = await import('../services/photoUpload');
      const url = await uploadPhoto(file, productId);
      // Обновляем поле URL
      const urlInput = row?.querySelector<HTMLInputElement>('.edit-inp[data-key]');
      if (urlInput) {
        urlInput.value = url;
        urlInput.dispatchEvent(new Event('input'));
      }
      // Обновляем превью
      const imgWrap = row?.querySelector('div');
      if (imgWrap) {
        imgWrap.innerHTML = `<img src="${escHtml(url)}" style="width:100%;height:100%;object-fit:cover">`;
      }
      if (url.startsWith('data:')) {
        this.app.toast('⚠ Storage недоступен — фото сохранено локально. Для синхронизации с МП нужен URL.', 'info', 5000);
      } else {
        this.app.toast(`${I.checkCircle('', 16)} Фото загружено`, 'success', 2000);
      }
    } catch (e: any) {
      this.app.toast('Ошибка загрузки фото: ' + e.message, 'error');
    } finally {
      if (row) row.style.opacity = '1';
    }
  }

  /** Добавить новое кастомное поле из редактора */
  addNewFieldToEdit() {
    const nameEl  = document.getElementById('new-field-name')  as HTMLInputElement;
    const valueEl = document.getElementById('new-field-value') as HTMLInputElement;
    const name  = nameEl?.value?.trim();
    const value = valueEl?.value?.trim() ?? '';
    if (!name) { nameEl?.focus(); return; }

    const container = document.getElementById('extra-fields-container');
    if (!container) return;

    const div = document.createElement('div');
    div.style.cssText = 'display:grid;grid-template-columns:140px 1fr 28px;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid var(--border)';
    div.innerHTML = `
      <div style="font-size:11px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(name)}</div>
      <input class="edit-inp" data-key="${escHtml(name)}" value="${escHtml(value)}"
        style="font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text)">
      <button onclick="this.closest('div').remove()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:14px">✕</button>
    `;
    container.appendChild(div);

    nameEl.value  = '';
    valueEl.value = '';
    nameEl.focus();
  }

  /** @deprecated — используй viewProduct(id, 'edit') */
  openEditProduct(id: string) { this.viewProduct(id, 'edit'); }

  async saveProduct(id: string) {
    const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('.edit-inp, .edit-sel');
    const data: Record<string, string> = {};
    inputs.forEach(inp => { if (inp.dataset.key) data[inp.dataset.key] = inp.value; });

    // Сохраняем предыдущие данные ДО обновления (нужны для diff при push на МП)
    const p = this.app.allProducts.find(x => x.id === id);
    const prevData: Record<string, any> = { ...(p?.data || {}) };

    // Сохраняем себестоимость если поле заполнено
    const costInp = document.getElementById('edit-cost-price') as HTMLInputElement | null;
    if (costInp) {
      const costArt = costInp.dataset.article ?? '';
      const rawVal = costInp.value.trim();
      if (costArt) {
        if (rawVal === '') {
          costPriceDb.remove(costArt);
        } else {
          const num = parseFloat(rawVal);
          if (!isNaN(num) && num >= 0) costPriceDb.set(costArt, num);
        }
      }
    }

    // Сохраняем габариты
    const dimW  = +(document.getElementById('dim-weight') as HTMLInputElement)?.value || 0;
    const dimL  = +(document.getElementById('dim-length') as HTMLInputElement)?.value || 0;
    const dimWd = +(document.getElementById('dim-width')  as HTMLInputElement)?.value || 0;
    const dimH  = +(document.getElementById('dim-height') as HTMLInputElement)?.value || 0;
    const artKey = String(data['Артикул*'] || data['Артикул'] || p?.data?.['Артикул*'] || p?.data?.['Артикул'] || '');
    if (artKey) {
      const hasDims = dimW > 0 || dimL > 0 || dimWd > 0 || dimH > 0;
      if (hasDims) {
        dimensionsDb.set(artKey, {
          weight_g: dimW > 0 ? Math.round(dimW) : null,
          length_mm: dimL > 0 ? Math.round(dimL) : null,
          width_mm: dimWd > 0 ? Math.round(dimWd) : null,
          height_mm: dimH > 0 ? Math.round(dimH) : null,
        });
      } else {
        dimensionsDb.remove(artKey);
      }
    }

    try {
      await apiService.updateProduct(id, { data });
      if (p) p.data = data;
      this.app.toast('Сохранено', 'success');
      this.app.closeModal();
      this.app.applyFilters();

      // ── Push на маркетплейс ─────────────────────────────────────────────
      const box = boxes.get().find(b => b.id === this.app.activeBoxId);
      const isMpSynced = !!(data['_ozon_store_id'] || data['_ym_store_id']);

      if (isMpSynced) {
        // Новые авто-синхронизированные группы — полный push всех атрибутов
        this.app.toast(`${I.hourglass('', 16)} Отправляем изменения на маркетплейс...`, 'info', 2000);
        import('../services/mpProductPush').then(async ({ pushProductChanges }) => {
          try {
            const res = await pushProductChanges(data, prevData);
            if (!res) return;
            if (res.ok) {
              this.app.toast(`${I.checkCircle('', 16)} Изменения сохранены на ${res.mp === 'ozon' ? 'Ozon' : 'Яндекс Маркет'}`, 'success', 4000);
            } else {
              const errMsg = res.errors.slice(0, 2).join(' | ');
              this.app.toast(`⚠ МП: ${errMsg}`, 'error', 6000);
            }
          } catch (e: any) {
            this.app.toast(`⚠ Ошибка push на МП: ${e.message?.slice(0, 80)}`, 'error', 6000);
          }
        });
      } else if (box?.ozon_store_id) {
        // Старые группы с ручной привязкой Ozon — только цена+название
        this.pushProductToOzon(id, data, box).catch((e) => debug.warn('[ProductModalModule] swallowed error', e));
      }
    } catch (e: any) { this.app.toast('Ошибка: ' + e.message, 'error'); }
  }

  /**
   * Push a single product's changes to Ozon API.
   * Called automatically after saveProduct() if the box is linked to Ozon.
   */
  async pushProductToOzon(
    _productId: string,
    data: Record<string, string>,
    box: import('../types').Box,
  ): Promise<void> {
    const ozonModule = (window as any).ozonModule;
    const store = ozonModule?.stores?.find((s: any) => s.id === box.ozon_store_id);
    if (!store) return;

    const skuField = box.ozon_sku_field || 'Артикул*';
    const offerId = String(data[skuField] || '').trim();
    if (!offerId) return;

    const price    = data['Цена, руб.*'];
    const oldPrice = data['Цена до скидки, руб.'];
    const name     = data['Название товара'];

    // Обновляем цену если изменилась
    if (price) {
      try {
        const { ozonApi } = await import('../services/ozonApi');
        await ozonApi.updatePrices(store, [{
          offer_id: offerId,
          price,
          old_price: oldPrice || undefined,
        }]);
        this.app.toast(`Цена обновлена в Ozon (${offerId})`, 'success', 2500);
      } catch (e: any) {
        this.app.toast(`Ozon: не удалось обновить цену — ${e.message.slice(0, 60)}`, 'error');
      }
    }

    // Обновляем название если изменилось
    if (name) {
      try {
        const { ozonApi } = await import('../services/ozonApi');
        const fullInfo = await ozonApi.getFullProductInfo(offerId, null, store);
        if (fullInfo) {
          await ozonApi.updateProduct(store, {
            ...fullInfo,
            name,
            offer_id: offerId,
            price: price || String(fullInfo.price || '0'),
          });
        }
      } catch {
        // название — некритично, продолжаем
      }
    }
  }

  confirmDeleteProduct(id: string, art: string) {
    this.app.openModal('Удалить товар?', `Артикул: ${art}`,
      `<p style="color:var(--text2);font-size:13.5px">Это действие нельзя отменить.</p>`,
      `<button class="btn" onclick="window.app.viewProduct('${id}')">Отмена</button>
       <button class="btn btn-danger" onclick="window.app.deleteProduct('${id}')">Удалить</button>`
    );
  }

  async deleteProduct(id: string) {
    try {
      await apiService.deleteProduct(id);
      this.app.allProducts = this.app.allProducts.filter(p => p.id !== id);
      if (this.app.activeBoxId) {
        this.app.cache.set(this.app.activeBoxId, this.app.allProducts);
        idbCache.set(this.app.activeBoxId, this.app.allProducts).catch((e) => debug.warn('[ProductModalModule] swallowed error', e));
      }
      this.app.toast('Товар удалён', 'success');
      this.app.closeModal();
      this.app.buildColumns();
      this.app.applyFilters();
      if (this.app.activeBoxId) this.app.loadBoxCount(this.app.activeBoxId);
    } catch (e: any) { this.app.toast('Ошибка: ' + e.message, 'error'); }
  }
}
