/**
 * «Управление карточками» — массовое редактирование выбранных товаров
 * сразу во всех магазинах через API маркетплейсов.
 *
 * Строка = товар в конкретном магазине. Действие (цены, габариты, НДС,
 * себестоимость, архив) сначала показывается предпросмотром «было → станет»,
 * любую новую цену можно поправить руками, затем «Применить» отправляет всё
 * в маркетплейсы и показывает результат по каждой строке.
 *
 * Цены уходят пачкой — одним запросом на магазин; остальное — по одной
 * карточке, с проверкой ответа маркетплейса.
 */

import { esc } from '@/utils/format';
import { I } from '@/utils/icons';
import { showToast } from '@/utils/toast';
import { copyButton } from '@/utils/copyButton';
import type { BulkHost, BulkProduct, BulkEntry, CardChanges, Mp } from './bulkTypes';

type Tab = 'prices' | 'dims' | 'vat' | 'cost' | 'archive';
type PriceMode = 'set' | 'pct' | 'rub';
type Rounding = 'none' | 'int' | '10' | '9' | '90';

interface Row {
  key: string;
  p: BulkProduct;
  e: BulkEntry;
  /** Ручная правка новой цены в предпросмотре. */
  manualPrice?: number;
  skip?: boolean;
}

interface RowResult { state: 'run' | 'ok' | 'err'; text?: string }

const MP_LABEL: Record<Mp, string> = { ozon: 'OZ', wb: 'WB', yandex: 'ЯМ' };
const VAT_OZON: Array<[string, string]> = [['', 'не менять'], ['0', 'Без НДС'], ['0.05', '5%'], ['0.07', '7%'], ['0.1', '10%'], ['0.2', '20%'], ['0.22', '22%']];
const VAT_YM: Array<[string, string]> = [['', 'не менять'], ['NO_VAT', 'Без НДС'], ['VAT_0', '0%'], ['VAT_10', '10%'], ['VAT_20', '20%']];

const rub = (n: number | null | undefined) => n == null || !isFinite(n) ? '—' : `${Math.round(n).toLocaleString('ru')} ₽`;
const num = (v: string): number | null => { const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : null; };

export class BulkEditor {
  private root: HTMLElement | null = null;
  private tab: Tab = 'prices';
  private rows: Row[] = [];
  private stores = new Set<string>();
  private results = new Map<string, RowResult>();
  private running = false;

  // Формы
  private price = { mode: 'pct' as PriceMode, value: '', round: 'none' as Rounding, old: 'keep' as 'keep' | 'clear' | 'pct', oldPct: '20', min: 'keep' as 'keep' | 'pct', minPct: '10', wbDisc: '' };
  private dims = { weight_kg: '', length_cm: '', width_cm: '', height_cm: '' };
  private vat = { ozon: '', yandex: '' };
  private cost = { mode: 'set' as 'set' | 'pct', value: '' };
  private archive: 'archive' | 'unarchive' = 'archive';

  constructor(private host: BulkHost, private products: BulkProduct[]) {
    for (const p of products) for (const e of p.mp_entries) {
      this.rows.push({ key: `${p.article}|${e.store_id}`, p, e });
      this.stores.add(e.store_id);
    }
  }

  open(): void {
    this.root?.remove();
    const el = document.createElement('div');
    el.className = 'bk-bg';
    el.addEventListener('mousedown', ev => { if (ev.target === el && !this.running) this.close(); });
    document.body.appendChild(el);
    this.root = el;
    el.addEventListener('click', ev => this.onClick(ev));
    el.addEventListener('input', ev => this.onInput(ev));
    el.addEventListener('change', ev => this.onInput(ev));
    document.addEventListener('keydown', this.onKey);
    this.render();
  }

  close(): void {
    if (this.running) return;
    document.removeEventListener('keydown', this.onKey);
    this.root?.remove();
    this.root = null;
    this.host.afterBulk();
  }

  private readonly onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.close(); };

  // ─── Расчёт предпросмотра ───────────────────────────────────────

  private visibleRows(): Row[] {
    return this.rows.filter(r => this.stores.has(r.e.store_id));
  }

  /** Базовая цена строки: для WB — цена до скидки (её и отправляем). */
  private basePrice(r: Row): number | null {
    const raw = this.host.rawProd(r.e.mp, r.e.store_id, r.p.article);
    if (r.e.mp === 'wb') return raw?.price ?? r.e.old_price ?? r.e.price;
    if (r.e.mp === 'yandex') return raw?.basic_price ?? r.e.price;
    return raw?.price ?? r.e.price;
  }

  private round(v: number): number {
    switch (this.price.round) {
      case 'int': return Math.round(v);
      case '10': return Math.round(v / 10) * 10;
      case '9': return Math.max(9, Math.round((v + 1) / 10) * 10 - 1);
      case '90': return Math.max(90, Math.round((v + 10) / 100) * 100 - 10);
      default: return Math.round(v * 100) / 100;
    }
  }

  private newPrice(r: Row): number | null {
    if (r.manualPrice != null) return r.manualPrice;
    const cur = this.basePrice(r);
    const v = num(this.price.value);
    if (v == null) return null;
    let next: number | null = null;
    if (this.price.mode === 'set') next = v;
    else if (cur != null) next = this.price.mode === 'pct' ? cur * (1 + v / 100) : cur + v;
    if (next == null) return null;
    next = this.round(next);
    return r.e.mp === 'wb' ? Math.round(next) : next;
  }

  /** Что уйдёт в магазин по ценам для строки (или причина пропуска). */
  private priceChange(r: Row): { price?: number; old_price?: number | null; min_price?: number | null; discount?: number; skip?: string } | null {
    if (this.host.isPriceLocked(r.p.article, r.e.mp)) return { skip: 'цену ведёт репрайсер' };
    let price = this.newPrice(r) ?? undefined;
    const out: { price?: number; old_price?: number | null; min_price?: number | null; discount?: number } = {};
    const touchOld = r.e.mp === 'ozon' && this.price.old !== 'keep';
    const touchMin = r.e.mp === 'ozon' && this.price.min !== 'keep';
    const disc = r.e.mp === 'wb' && this.price.wbDisc !== '' ? num(this.price.wbDisc) : null;
    if (price == null && !touchOld && !touchMin && disc == null) return null;
    if (price == null) price = this.basePrice(r) ?? undefined;
    if (price == null) return { skip: 'у товара нет текущей цены' };
    out.price = price;
    if (touchOld) out.old_price = this.price.old === 'clear' ? 0 : Math.round(price * (1 + (num(this.price.oldPct) ?? 0) / 100));
    if (touchMin) out.min_price = Math.round(price * (1 - (num(this.price.minPct) ?? 0) / 100));
    if (disc != null) out.discount = Math.round(disc);
    return out;
  }

  private dimsChange(): CardChanges | null {
    const ch: CardChanges = {};
    for (const k of ['weight_kg', 'length_cm', 'width_cm', 'height_cm'] as const) {
      const v = num(this.dims[k]);
      if (v != null) ch[k] = v;
    }
    return Object.keys(ch).length ? ch : null;
  }

  // ─── Отрисовка ──────────────────────────────────────────────────

  private render(): void {
    if (!this.root) return;
    const rows = this.visibleRows();
    const storeList = [...new Map(this.rows.map(r => [r.e.store_id, r.e])).values()];
    const tab = (id: Tab, label: string) => `<button class="bk-tab${this.tab === id ? ' on' : ''}" data-bk="tab" data-v="${id}" ${this.running ? 'disabled' : ''}>${label}</button>`;
    const done = [...this.results.values()];
    const okN = done.filter(r => r.state === 'ok').length, errN = done.filter(r => r.state === 'err').length;
    const scroll = this.root.querySelector('.bk-table-wrap')?.scrollTop ?? 0;

    this.root.innerHTML = `
      <div class="bk" role="dialog" aria-label="Управление карточками">
        <header class="bk-head">
          <div>
            <h2>Управление карточками</h2>
            <div class="bk-sub">${this.products.length} ${plural(this.products.length, ['товар', 'товара', 'товаров'])} · ${rows.length} ${plural(rows.length, ['карточка', 'карточки', 'карточек'])} в магазинах · изменения уходят в маркетплейсы через API</div>
          </div>
          <button class="bk-x" data-bk="close" title="Закрыть (Esc)" ${this.running ? 'disabled' : ''}>✕</button>
        </header>
        <div class="bk-stores">
          <span class="bk-label">Магазины:</span>
          ${storeList.map(e => `<button class="bk-chip${this.stores.has(e.store_id) ? ' on' : ''}" data-bk="store" data-v="${esc(e.store_id)}" ${this.running ? 'disabled' : ''}>
            <span class="pc-mp pc-mp-${e.mp}">${MP_LABEL[e.mp]}</span>${esc(e.store_name)}</button>`).join('')}
        </div>
        <nav class="bk-tabs">
          ${tab('prices', 'Цены')}${tab('dims', 'Вес и габариты')}${tab('vat', 'НДС')}${tab('cost', 'Себестоимость')}${tab('archive', 'Архив')}
        </nav>
        <section class="bk-form">${this.tplForm()}</section>
        <div class="bk-table-wrap">${this.tplTable(rows)}</div>
        <footer class="bk-foot">
          <span class="bk-summary">${this.running ? `${I.loader('', 14)} Отправляю… ${okN + errN} из ${this.results.size}` : this.results.size ? `<b class="ok">${okN} готово</b>${errN ? ` · <b class="err">${errN} с ошибкой</b>` : ''}` : this.tplSummary(rows)}</span>
          <span class="bk-grow"></span>
          ${!this.running && errN ? `<button class="pc-btn" data-bk="retry">Повторить ошибки</button>` : ''}
          <button class="pc-btn" data-bk="close" ${this.running ? 'disabled' : ''}>${this.results.size && !this.running ? 'Готово' : 'Отмена'}</button>
          <button class="pc-btn primary" data-bk="apply" ${this.running || !this.countChanges(rows) ? 'disabled' : ''}>${this.running ? 'Отправляю…' : `Применить${this.countChanges(rows) ? ` к ${this.countChanges(rows)}` : ''}`}</button>
        </footer>
      </div>`;
    const wrap = this.root.querySelector('.bk-table-wrap');
    if (wrap) wrap.scrollTop = scroll;
  }

  private tplSummary(rows: Row[]): string {
    const n = this.countChanges(rows);
    return n ? `Будет изменено: ${n} ${plural(n, ['карточка', 'карточки', 'карточек'])}` : 'Задайте изменение — ниже появится предпросмотр';
  }

  private countChanges(rows: Row[]): number {
    return rows.filter(r => { if (r.skip) return false; const c = this.rowChange(r); return !!c && c.skip === undefined; }).length;
  }

  /** Изменение строки на текущей вкладке (или null — строка не меняется). */
  private rowChange(r: Row): { skip?: string } | null {
    // Уже отправлено успешно — повторно не применяем, пока не поменяют условия
    if (this.results.get(r.key)?.state === 'ok') return { skip: '' };
    switch (this.tab) {
      case 'prices': return this.priceChange(r);
      case 'dims': return this.dimsChange() ? {} : null;
      case 'vat': {
        if (r.e.mp === 'wb') return this.vat.ozon || this.vat.yandex ? { skip: 'НДС на WB задаётся в кабинете' } : null;
        const v = r.e.mp === 'ozon' ? this.vat.ozon : this.vat.yandex;
        return v ? {} : null;
      }
      case 'cost': return num(this.cost.value) != null ? {} : null;
      case 'archive': return r.e.mp === 'wb' ? { skip: 'у WB нет архива через API' } : {};
    }
  }

  private select(name: string, value: string, opts: Array<[string, string]>): string {
    return `<select class="bk-in" data-bk-f="${name}" ${this.running ? 'disabled' : ''}>${opts.map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  }

  private input(name: string, value: string, ph = '', suffix = '', w = 110): string {
    return `<span class="bk-input" style="width:${w}px"><input class="bk-in" data-bk-f="${name}" value="${esc(value)}" placeholder="${esc(ph)}" inputmode="decimal" ${this.running ? 'disabled' : ''}>${suffix ? `<i>${suffix}</i>` : ''}</span>`;
  }

  private tplForm(): string {
    const hasMp = (mp: Mp) => this.visibleRows().some(r => r.e.mp === mp);
    switch (this.tab) {
      case 'prices': return `
        <div class="bk-line">
          <span class="bk-label">Цена</span>
          ${this.select('price.mode', this.price.mode, [['pct', 'изменить на %'], ['rub', 'изменить на ₽'], ['set', 'установить']])}
          ${this.input('price.value', this.price.value, this.price.mode === 'set' ? '1990' : this.price.mode === 'pct' ? '+10 или −5' : '+100 или −50', this.price.mode === 'pct' ? '%' : '₽')}
          <span class="bk-label">округлить</span>
          ${this.select('price.round', this.price.round, [['none', 'не округлять'], ['int', 'до рубля'], ['10', 'до 10 ₽'], ['9', 'на …9 (1 299)'], ['90', 'на …90 (1 290)']])}
        </div>
        ${hasMp('ozon') ? `<div class="bk-line">
          <span class="bk-label"><span class="pc-mp pc-mp-ozon">OZ</span> Зачёркнутая</span>
          ${this.select('price.old', this.price.old, [['keep', 'не менять'], ['pct', 'цена + %'], ['clear', 'убрать']])}
          ${this.price.old === 'pct' ? this.input('price.oldPct', this.price.oldPct, '20', '%', 80) : ''}
          <span class="bk-label">Мин. цена</span>
          ${this.select('price.min', this.price.min, [['keep', 'не менять'], ['pct', 'цена − %']])}
          ${this.price.min === 'pct' ? this.input('price.minPct', this.price.minPct, '10', '%', 80) : ''}
        </div>` : ''}
        ${hasMp('wb') ? `<div class="bk-line">
          <span class="bk-label"><span class="pc-mp pc-mp-wb">WB</span> Скидка продавца</span>
          ${this.input('price.wbDisc', this.price.wbDisc, 'не менять', '%', 110)}
          <span class="bk-hint">для WB «цена» — до скидки; покупатель видит цену со скидкой</span>
        </div>` : ''}
        <div class="bk-hint">Новую цену любой строки можно поправить вручную в таблице.</div>`;
      case 'dims': return `
        <div class="bk-line">
          <span class="bk-label">Вес</span>${this.input('dims.weight_kg', this.dims.weight_kg, 'не менять', 'кг', 120)}
          <span class="bk-label">Длина</span>${this.input('dims.length_cm', this.dims.length_cm, 'не менять', 'см', 120)}
          <span class="bk-label">Ширина</span>${this.input('dims.width_cm', this.dims.width_cm, 'не менять', 'см', 120)}
          <span class="bk-label">Высота</span>${this.input('dims.height_cm', this.dims.height_cm, 'не менять', 'см', 120)}
        </div>
        <div class="bk-hint">Заполните только то, что меняете, — остальные размеры останутся как есть. Размеры — в упаковке.</div>`;
      case 'vat': return `
        <div class="bk-line">
          ${hasMp('ozon') ? `<span class="bk-label"><span class="pc-mp pc-mp-ozon">OZ</span> НДС</span>${this.select('vat.ozon', this.vat.ozon, VAT_OZON)}` : ''}
          ${hasMp('yandex') ? `<span class="bk-label"><span class="pc-mp pc-mp-yandex">ЯМ</span> НДС</span>${this.select('vat.yandex', this.vat.yandex, VAT_YM)}` : ''}
          ${!hasMp('ozon') && !hasMp('yandex') ? '<span class="bk-hint">НДС через API меняется только на Ozon и Яндекс Маркете</span>' : ''}
        </div>`;
      case 'cost': return `
        <div class="bk-line">
          <span class="bk-label">Себестоимость за шт</span>
          ${this.select('cost.mode', this.cost.mode, [['set', 'установить'], ['pct', 'изменить на %']])}
          ${this.input('cost.value', this.cost.value, this.cost.mode === 'set' ? '450' : '+5', this.cost.mode === 'set' ? '₽' : '%')}
        </div>
        <div class="bk-hint">Хранится в SimaDesk и сразу пересчитывает прибыль в «Товарах» и «Аналитике». В маркетплейсы не отправляется.</div>`;
      case 'archive': return `
        <div class="bk-line">
          ${this.select('archive', this.archive, [['archive', 'убрать в архив'], ['unarchive', 'вернуть из архива']])}
          <span class="bk-hint">Товар в архиве не продаётся и не виден покупателям. Ozon и Яндекс Маркет — через API; у WB архива в API нет.</span>
        </div>`;
    }
  }

  private tplTable(rows: Row[]): string {
    if (!rows.length) return '<div class="bk-empty">Выберите хотя бы один магазин</div>';
    const head = this.tab === 'prices' ? '<th class="num">Сейчас</th><th class="num">Станет</th><th>Детали</th>'
      : this.tab === 'dims' ? '<th>Сейчас</th><th>Станет</th>'
      : this.tab === 'vat' ? '<th>Сейчас</th><th>Станет</th>'
      : this.tab === 'cost' ? '<th class="num">Сейчас</th><th class="num">Станет</th>'
      : '<th>Статус</th><th>Действие</th>';
    return `<table class="bk-table">
      <thead><tr><th class="bk-c-check"></th><th>Товар</th><th>Магазин</th>${head}<th>Результат</th></tr></thead>
      <tbody>${rows.map(r => this.tplRow(r)).join('')}</tbody>
    </table>`;
  }

  private tplRow(r: Row): string {
    const ch = this.rowChange(r);
    const res = this.results.get(r.key);
    const done = res?.state === 'ok';
    const skipReason = done ? '' : ch?.skip;
    const cls = done ? 'done' : r.skip || skipReason ? 'off' : ch ? 'on' : '';
    let cells = '';
    if (this.tab === 'prices') {
      const cur = this.basePrice(r);
      const pc = done ? null : this.priceChange(r);
      const next = pc && !pc.skip ? pc.price : undefined;
      const delta = next != null && cur ? (next - cur) / cur * 100 : null;
      const details: string[] = [];
      if (pc && !pc.skip) {
        if (pc.old_price !== undefined) details.push(pc.old_price ? `зачёркнутая ${rub(pc.old_price)}` : 'без зачёркнутой');
        if (pc.min_price != null) details.push(`мин. ${rub(pc.min_price)}`);
        if (pc.discount !== undefined && next != null) details.push(`скидка ${pc.discount}% → ${rub(Math.round(next * (1 - pc.discount / 100)))}`);
      }
      cells = `<td class="num">${rub(cur)}</td>
        <td class="num"><span class="bk-input sm"><input class="bk-in bk-price${r.manualPrice != null ? ' manual' : ''}" data-bk-row="${esc(r.key)}" value="${next != null ? next : ''}" placeholder="${cur ?? ''}" inputmode="decimal" ${this.running || skipReason || done ? 'disabled' : ''}><i>₽</i></span>
          ${delta != null && isFinite(delta) && Math.abs(delta) > 0.001 ? `<em class="${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '+' : ''}${delta.toFixed(1).replace('.', ',')}%</em>` : ''}</td>
        <td class="bk-det">${skipReason ? `<span class="bk-warn">${esc(skipReason)}</span>` : esc(details.join(' · '))}</td>`;
    } else if (this.tab === 'dims') {
      const raw = this.host.rawProd(r.e.mp, r.e.store_id, r.p.article) ?? {};
      const fmt = (o: any) => `${o.weight_kg ?? '—'} кг · ${o.length_cm ?? '—'}×${o.width_cm ?? '—'}×${o.height_cm ?? '—'} см`;
      const d = this.dimsChange();
      cells = `<td>${fmt(raw)}</td><td>${d ? fmt({ ...raw, ...d }) : '—'}</td>`;
    } else if (this.tab === 'vat') {
      const raw = this.host.rawProd(r.e.mp, r.e.store_id, r.p.article) ?? {};
      const next = r.e.mp === 'ozon' ? this.vat.ozon : r.e.mp === 'yandex' ? this.vat.yandex : '';
      const label = (mp: Mp, v: string) => (mp === 'ozon' ? VAT_OZON : VAT_YM).find(([k]) => k === v)?.[1] ?? (v || '—');
      cells = `<td>${r.e.mp === 'wb' ? '—' : esc(label(r.e.mp, String(raw.vat ?? r.e.vat ?? '')))}</td><td>${skipReason ? `<span class="bk-warn">${esc(skipReason)}</span>` : next ? esc(label(r.e.mp, next)) : '—'}</td>`;
    } else if (this.tab === 'cost') {
      const cur = r.p.cost_price;
      const v = num(this.cost.value);
      const next = v == null ? null : this.cost.mode === 'set' ? v : cur != null ? Math.round(cur * (1 + v / 100) * 100) / 100 : null;
      cells = `<td class="num">${rub(cur)}</td><td class="num">${next != null ? rub(next) : this.cost.mode === 'pct' && v != null ? '<span class="bk-warn">не задана</span>' : '—'}</td>`;
    } else {
      cells = `<td>${esc(r.e.status ?? '—')}</td><td>${skipReason ? `<span class="bk-warn">${esc(skipReason)}</span>` : this.archive === 'archive' ? 'в архив' : 'из архива'}</td>`;
    }
    const resHtml = !res ? '' : res.state === 'run' ? `<span class="bk-res run">${I.loader('', 12)}</span>`
      : res.state === 'ok' ? `<span class="bk-res ok" title="${esc(res.text ?? '')}">${I.check('', 12)} ${esc(res.text || 'готово')}</span>`
      : `<span class="bk-res err">${I.alertTriangle('', 12)} ${esc(res.text ?? 'ошибка')}</span>`;
    return `<tr class="${cls}">
      <td class="bk-c-check"><input type="checkbox" data-bk="skip" data-v="${esc(r.key)}" ${r.skip ? '' : 'checked'} ${this.running ? 'disabled' : ''} title="Включить строку"></td>
      <td class="bk-prod"><div class="bk-name" title="${esc(r.p.name)}">${esc(r.p.name || 'Без названия')}</div><div class="bk-art"><span>${esc(r.p.article)}</span>${copyButton(r.p.article, 'Копировать артикул')}</div></td>
      <td class="bk-store"><span class="pc-mp pc-mp-${r.e.mp}">${MP_LABEL[r.e.mp]}</span> ${esc(r.e.store_name)}</td>
      ${cells}
      <td class="bk-c-res">${resHtml}</td>
    </tr>`;
  }

  // ─── События ────────────────────────────────────────────────────

  private onInput(ev: Event): void {
    const t = ev.target as HTMLInputElement;
    const f = t.getAttribute('data-bk-f');
    if (f) {
      const [grp, key] = f.split('.');
      if (grp === 'archive') this.archive = t.value as 'archive' | 'unarchive';
      else (this as any)[grp][key] = t.value;
      if (f === 'price.mode' || f === 'price.value' || f === 'price.round') for (const r of this.rows) r.manualPrice = undefined;
      this.results.clear();
      // Текстовые поля — без полной перерисовки, чтобы не терять курсор
      if (ev.type === 'input' && t.tagName === 'INPUT') { this.refreshTable(); return; }
      this.render();
      return;
    }
    const rk = t.getAttribute('data-bk-row');
    if (rk && ev.type === 'change') {
      const r = this.rows.find(x => x.key === rk);
      if (r) { const v = num(t.value); r.manualPrice = v != null && v > 0 ? v : undefined; this.results.delete(rk); this.refreshTable(); }
    }
  }

  /** Перерисовать таблицу и итог, не трогая форму (сохраняем фокус ввода). */
  private refreshTable(): void {
    if (!this.root) return;
    const rows = this.visibleRows();
    const wrap = this.root.querySelector<HTMLElement>('.bk-table-wrap');
    if (wrap) { const top = wrap.scrollTop; wrap.innerHTML = this.tplTable(rows); wrap.scrollTop = top; }
    const sum = this.root.querySelector<HTMLElement>('.bk-summary');
    if (sum) sum.innerHTML = this.tplSummary(rows);
    const btn = this.root.querySelector<HTMLButtonElement>('[data-bk="apply"]');
    if (btn) { const n = this.countChanges(rows); btn.disabled = !n; btn.textContent = `Применить${n ? ` к ${n}` : ''}`; }
  }

  private onClick(ev: Event): void {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-bk]');
    if (!el || this.running) return;
    const v = el.getAttribute('data-v') ?? '';
    switch (el.getAttribute('data-bk')) {
      case 'close': this.close(); return;
      case 'tab': this.tab = v as Tab; this.results.clear(); break;
      case 'store':
        if (this.stores.has(v)) { if (this.stores.size > 1) this.stores.delete(v); } else this.stores.add(v);
        break;
      case 'skip': { const r = this.rows.find(x => x.key === v); if (r) r.skip = !(el as HTMLInputElement).checked; this.refreshTable(); return; }
      case 'apply': this.apply(false); return;
      case 'retry': this.apply(true); return;
      default: return;
    }
    this.render();
  }

  // ─── Применение ─────────────────────────────────────────────────

  private async apply(onlyFailed: boolean): Promise<void> {
    const rows = this.visibleRows().filter(r => !r.skip && (!onlyFailed || this.results.get(r.key)?.state === 'err'));
    const work = rows.filter(r => { const c = this.rowChange(r); return !!c && c.skip === undefined; });
    if (!work.length) return;
    if (!onlyFailed && work.length >= 20 && !confirm(`Изменить ${work.length} карточек в маркетплейсах?`)) return;
    this.running = true;
    for (const r of work) this.results.set(r.key, { state: 'run' });
    this.render();
    const set = (r: Row, err: string | null, okText = '') => { this.results.set(r.key, err ? { state: 'err', text: err } : { state: 'ok', text: okText }); this.refreshProgress(r); };

    try {
      if (this.tab === 'cost') {
        // Себестоимость общая для артикула — считаем и пишем один раз на артикул
        const v = num(this.cost.value)!;
        const byArt = new Map<string, Row[]>();
        for (const r of work) { const l = byArt.get(r.p.article) ?? []; l.push(r); byArt.set(r.p.article, l); }
        for (const [article, list] of byArt) {
          const cur = list[0].p.cost_price;
          const next = this.cost.mode === 'set' ? v : cur != null ? Math.round(cur * (1 + v / 100) * 100) / 100 : null;
          let err: string | null = null;
          if (next == null) err = 'себестоимость не задана — нечего менять на %';
          else if (next < 0) err = 'себестоимость не может быть отрицательной';
          else { try { await this.host.setCostValue(article, next); } catch (e) { err = e instanceof Error ? e.message : String(e); } }
          for (const r of list) set(r, err, next != null ? rub(next) : '');
        }
        return;
      }
      // По магазинам параллельно, внутри магазина — по очереди (лимиты API)
      const byStore = new Map<string, Row[]>();
      for (const r of work) { const l = byStore.get(r.e.store_id) ?? []; l.push(r); byStore.set(r.e.store_id, l); }
      await Promise.all([...byStore.entries()].map(async ([storeId, list]) => {
        const mp = list[0].e.mp;
        if (this.tab === 'prices') {
          const res = await this.host.pushPricesBatch(storeId, mp, list.map(r => ({ article: r.p.article, ...(this.priceChange(r) as any) })));
          for (const r of list) set(r, res.get(r.p.article) ?? null, mp === 'ozon' ? 'цена обновлена' : 'отправлено');
        } else if (this.tab === 'archive') {
          const res = await this.host.pushArchive(storeId, mp, list.map(r => r.p.article), this.archive === 'archive');
          for (const r of list) set(r, res.get(r.p.article) ?? null);
        } else {
          for (const r of list) {
            const ch: CardChanges = this.tab === 'dims' ? this.dimsChange()! : { vat: mp === 'ozon' ? this.vat.ozon : this.vat.yandex };
            try { const note = await this.host.pushCardChanges(r.p.article, storeId, mp, ch); set(r, null, note ? 'принято, обрабатывается' : 'готово'); }
            catch (e) { set(r, e instanceof Error ? e.message : String(e)); }
          }
        }
      }));
    } finally {
      this.running = false;
      this.render();
      const vals = [...this.results.values()];
      const ok = vals.filter(x => x.state === 'ok').length, err = vals.filter(x => x.state === 'err').length;
      showToast(err ? `Готово: ${ok}, с ошибкой: ${err}` : `Готово: ${ok} ${plural(ok, ['карточка', 'карточки', 'карточек'])}`, err ? 'warning' : 'success');
    }
  }

  /** Обновить одну строку результата во время отправки. */
  private refreshProgress(r: Row): void {
    const tr = this.root?.querySelector<HTMLElement>(`input[data-bk="skip"][data-v="${CSS.escape(r.key)}"]`)?.closest('tr');
    if (tr) tr.outerHTML = this.tplRow(r);
    const vals = [...this.results.values()];
    const sum = this.root?.querySelector<HTMLElement>('.bk-summary');
    if (sum) sum.innerHTML = `${I.loader('', 14)} Отправляю… ${vals.filter(x => x.state !== 'run').length} из ${vals.length}`;
  }
}

function plural(n: number, f: [string, string, string]): string {
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? f[2] : b > 1 && b < 5 ? f[1] : b === 1 ? f[0] : f[2];
}

