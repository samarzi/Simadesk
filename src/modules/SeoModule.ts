/**
 * SeoModule — отслеживание позиций по ключевым словам.
 * WB: автопроверка через API поиска.
 * Ozon / ЯМ: ручной ввод позиции (нет публичного поиска).
 */

import { wbDb } from '@/services/wbDb';
import { ozonDb } from '@/services/ozonDb';
import { yandexDb } from '@/services/yandexDb';
import { fetchWbSearchPosition } from '@/services/wbApi';
import { helpBtn } from '@/services/helpModal';
import { I } from '@/utils/icons';
import { copyButton } from '@/utils/copyButton';
import { WbProduct } from '@/types/wb';
import { OzonProduct } from '@/types/ozon';
import { YandexProduct } from '@/types/yandex';

type Mp = 'wb' | 'ozon' | 'yandex';

interface PositionEntry {
  date: string;        // YYYY-MM-DD
  position: number | null;
}

interface TrackedKeyword {
  id: string;
  marketplace: Mp;
  productId: string;   // nmId (wb) or offer_id (ozon/yandex)
  storeId: string;
  productTitle: string;
  keyword: string;
  addedAt: string;
  positions: PositionEntry[];
}

const MP_COLOR: Record<Mp, string> = { wb: '#cb11ab', ozon: '#005bff', yandex: '#fc3f1d' };
const MP_BG:    Record<Mp, string> = { wb: '#fdf0fb', ozon: '#eef4ff', yandex: '#fff5f3' };
const MP_LABEL: Record<Mp, string> = { wb: 'WB', ozon: 'Ozon', yandex: 'ЯМ' };

const STORAGE_KEY = 'seo_keywords_v3';
function load(): TrackedKeyword[] { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'); } catch { return []; } }
function save(l: TrackedKeyword[]): void { localStorage.setItem(STORAGE_KEY, JSON.stringify(l)); }
function uid(): string { return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

export class SeoModule {
  private container: HTMLElement;
  private tracked: TrackedKeyword[] = [];
  private wbProducts:   WbProduct[]     = [];
  private ozProducts:   OzonProduct[]   = [];
  private ymProducts:   YandexProduct[] = [];
  private checking = new Set<string>();
  private filterMp: Mp | 'all' = 'all';
  private search = '';
  private addForm = false;
  private formMp: Mp = 'wb';
  private formProductId = '';
  private formKeyword = '';
  private formError = '';
  private manualId: string | null = null;
  private manualVal = '';

  constructor(container: HTMLElement) { this.container = container; }

  async show(): Promise<void> {
    this.container.style.display = 'flex';
    this.container.style.flexDirection = 'column';
    this.tracked = load();
    const [wb, oz, ym] = await Promise.all([
      wbDb.getProducts().catch((): WbProduct[] => []),
      ozonDb.getProducts().catch((): OzonProduct[] => []),
      yandexDb.getProducts().catch((): YandexProduct[] => []),
    ]);
    this.wbProducts = wb; this.ozProducts = oz; this.ymProducts = ym;
    this.render();
  }

  hide(): void { this.container.style.display = 'none'; }

  toggleAddForm(): void { this.addForm = !this.addForm; this.formError = ''; this.render(); }
  setFormMp(mp: Mp): void { this.formMp = mp; this.formProductId = ''; this.formError = ''; this.render(); }
  setFormProductId(v: string): void { this.formProductId = v; }
  setFormKeyword(v: string): void { this.formKeyword = v; }
  setSearch(v: string): void { this.search = v; this.render(); }
  setFilterMp(v: Mp | 'all'): void { this.filterMp = v; this.render(); }

  addKeyword(): void {
    const pid = this.formProductId.trim();
    const kw  = this.formKeyword.trim();
    if (!pid) { this.formError = 'Выберите товар'; this.render(); return; }
    if (!kw)  { this.formError = 'Введите ключевое слово'; this.render(); return; }
    if (this.tracked.some(t => t.marketplace === this.formMp && t.productId === pid && t.keyword.toLowerCase() === kw.toLowerCase())) {
      this.formError = 'Уже отслеживается'; this.render(); return;
    }
    let title = pid, storeId = '';
    if (this.formMp === 'wb') {
      const p = this.wbProducts.find(p => String(p.nm_id) === pid);
      if (p) { title = p.title; storeId = p.store_id; }
    } else if (this.formMp === 'ozon') {
      const p = this.ozProducts.find(p => p.offer_id === pid);
      if (p) { title = p.name; storeId = p.store_id; }
    } else {
      const p = this.ymProducts.find(p => p.offer_id === pid);
      if (p) { title = p.name; storeId = p.store_id; }
    }
    const entry: TrackedKeyword = {
      id: uid(), marketplace: this.formMp, productId: pid, storeId,
      productTitle: title, keyword: kw, addedAt: new Date().toISOString(), positions: [],
    };
    this.tracked.unshift(entry);
    save(this.tracked);
    this.formProductId = ''; this.formKeyword = ''; this.addForm = false; this.formError = '';
    this.render();
    if (this.formMp === 'wb') this.checkPosition(entry.id);
  }

  removeKeyword(id: string): void {
    this.tracked = this.tracked.filter(t => t.id !== id);
    save(this.tracked); this.render();
  }

  async checkPosition(id: string): Promise<void> {
    const t = this.tracked.find(e => e.id === id);
    if (!t || t.marketplace !== 'wb' || this.checking.has(id)) return;
    this.checking.add(id); this.render();
    try {
      const pos = await fetchWbSearchPosition(parseInt(t.productId), t.keyword);
      this.recordPosition(t, pos);
    } catch (err: any) {
      console.warn('[SeoModule] checkPosition failed:', t.keyword, err?.message);
    }
    this.checking.delete(id); this.render();
  }

  async checkAll(): Promise<void> {
    for (const t of this.tracked) {
      if (t.marketplace === 'wb' && !this.checking.has(t.id)) this.checkPosition(t.id);
    }
  }

  openManualPos(id: string): void {
    const t = this.tracked.find(e => e.id === id);
    const today = new Date().toISOString().slice(0,10);
    const ex = t?.positions.find(p => p.date === today);
    this.manualId = id;
    this.manualVal = ex?.position != null ? String(ex.position) : '';
    this.render();
    setTimeout(() => (document.getElementById(`mpos-${id}`) as HTMLInputElement)?.focus(), 60);
  }

  setManualVal(v: string): void { this.manualVal = v; }
  cancelManual(): void { this.manualId = null; this.manualVal = ''; this.render(); }

  saveManualPos(id: string): void {
    const t = this.tracked.find(e => e.id === id);
    if (!t) return;
    const pos = parseInt(this.manualVal);
    if (!pos || isNaN(pos) || pos < 1) { this.manualId = null; this.render(); return; }
    this.recordPosition(t, pos);
    this.manualId = null; this.manualVal = '';
    this.render();
  }

  private recordPosition(t: TrackedKeyword, pos: number | null): void {
    const today = new Date().toISOString().slice(0,10);
    const ex = t.positions.find(p => p.date === today);
    if (ex) ex.position = pos;
    else t.positions.push({ date: today, position: pos });
    t.positions.sort((a,b) => a.date.localeCompare(b.date));
    if (t.positions.length > 30) t.positions = t.positions.slice(-30);
    save(this.tracked);
  }

  private get filtered(): TrackedKeyword[] {
    let list = this.tracked;
    if (this.filterMp !== 'all') list = list.filter(t => t.marketplace === this.filterMp);
    if (this.search) {
      const q = this.search.toLowerCase();
      list = list.filter(t => t.keyword.toLowerCase().includes(q) || t.productTitle.toLowerCase().includes(q) || t.productId.includes(q));
    }
    return list;
  }

  private posColor(pos: number | null): string {
    if (!pos) return 'var(--text-2)';
    if (pos <= 10)  return '#16a34a';
    if (pos <= 30)  return '#2563eb';
    if (pos <= 100) return '#f97316';
    return '#dc2626';
  }

  private sparkline(positions: PositionEntry[]): string {
    const pts = positions.slice(-14);
    if (pts.length < 2) return '<span style="font-size:11px;color:var(--text-2)">нет данных</span>';
    const vals = pts.map(p => p.position ?? 0);
    const maxV = Math.max(...vals.filter(v => v > 0)) || 1;
    const W = 88, H = 26, pad = 2;
    const points = pts.map((p, i) => {
      const x = pad + (i / (pts.length - 1)) * (W - pad * 2);
      const v = p.position ?? maxV;
      const y = pad + ((v - 1) / Math.max(maxV - 1, 1)) * (H - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const lastPos = pts.at(-1)?.position;
    const color = this.posColor(lastPos ?? null);
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
      <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  private kpiCount(_mp: Mp | null, pos: number[]): string {
    const top10 = pos.filter(p => p <= 10).length;
    const top30 = pos.filter(p => p <= 30).length;
    const avg   = pos.length ? Math.round(pos.reduce((s,p)=>s+p,0)/pos.length) : null;
    return `
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <div style="text-align:center">
          <div style="font-size:20px;font-weight:800;color:#16a34a">${top10}</div>
          <div style="font-size:10px;color:var(--text-2)">Топ-10</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:20px;font-weight:800;color:#2563eb">${top30}</div>
          <div style="font-size:10px;color:var(--text-2)">Топ-30</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:20px;font-weight:800;color:${this.posColor(avg)}">${avg ?? '—'}</div>
          <div style="font-size:10px;color:var(--text-2)">Ср. позиция</div>
        </div>
      </div>
    `;
  }

  render(): void {
    const list = this.filtered;
    const anyChecking = this.checking.size > 0;
    const allPos = this.tracked
      .map(t => t.positions.at(-1)?.position)
      .filter((p): p is number => p != null);

    const countByMp = (mp: Mp) => this.tracked.filter(t => t.marketplace === mp).length;

    this.container.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;background:var(--bg-2)">

        <!-- TOP BAR -->
        <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 24px;
          background:var(--bg);border-bottom:1px solid var(--border);gap:12px;flex-shrink:0">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:32px;height:32px;border-radius:8px;background:#2563eb;display:flex;align-items:center;justify-content:center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
            </div>
            <span style="font-size:18px;font-weight:700;color:var(--text-1)">SEO — Позиции</span>
            <span style="font-size:12px;color:var(--text-2)">${this.tracked.length} ключей</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            ${helpBtn('seo')}
            <button onclick="window.seoModule.checkAll()" ${anyChecking ? 'disabled' : ''}
              style="display:flex;align-items:center;gap:6px;padding:7px 14px;border:1px solid var(--border);
                border-radius:8px;background:var(--bg);color:var(--text-1);cursor:pointer;font-size:13px;
                opacity:${anyChecking?.6:1}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>
              ${anyChecking ? 'Проверяем…' : 'Обновить'}
            </button>
            <button onclick="window.seoModule.toggleAddForm()"
              style="padding:7px 16px;border-radius:8px;border:none;
                background:${this.addForm ? '#f1f5f9' : '#2563eb'};
                color:${this.addForm ? 'var(--text-1)' : '#fff'};cursor:pointer;font-size:13px;font-weight:600">
              ${this.addForm ? '✕ Отмена' : '+ Добавить ключ'}
            </button>
          </div>
        </div>

        ${this.addForm ? this.renderAddForm() : ''}

        <!-- KPI + FILTERS -->
        ${this.tracked.length > 0 ? `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;
            padding:12px 24px;background:var(--bg);border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap">
            ${this.kpiCount(null, allPos)}
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <div style="display:flex;gap:3px;background:var(--bg-2);border-radius:8px;padding:3px">
                ${(['all','wb','ozon','yandex'] as const).map(mp => {
                  const cnt = mp === 'all' ? this.tracked.length : countByMp(mp as Mp);
                  return `
                    <button onclick="window.seoModule.setFilterMp('${mp}')"
                      style="padding:5px 11px;border-radius:6px;border:none;cursor:pointer;font-size:12px;font-weight:600;
                        background:${this.filterMp === mp ? 'var(--bg)' : 'transparent'};
                        color:${this.filterMp === mp ? (mp === 'all' ? 'var(--text-1)' : MP_COLOR[mp as Mp]) : 'var(--text-2)'};
                        box-shadow:${this.filterMp === mp ? '0 1px 3px rgba(0,0,0,.08)' : 'none'}">
                      ${mp === 'all' ? 'Все' : MP_LABEL[mp as Mp]} <span style="opacity:.6">${cnt}</span>
                    </button>
                  `;
                }).join('')}
              </div>
              <div style="position:relative">
                <svg style="position:absolute;left:9px;top:50%;transform:translateY(-50%);pointer-events:none"
                  width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-2)" stroke-width="2">
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input type="text" placeholder="Поиск…"
                  value="${this.search.replace(/"/g,'&quot;')}"
                  oninput="window.seoModule.setSearch(this.value)"
                  style="padding:7px 10px 7px 30px;border:1px solid var(--border);border-radius:8px;
                    background:var(--bg);color:var(--text-1);font-size:13px;width:180px">
              </div>
            </div>
          </div>
        ` : ''}

        <!-- TABLE -->
        <div style="flex:1;overflow:auto">
          ${this.tracked.length === 0 ? `
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;color:var(--text-2);padding:40px">
              <div style="width:56px;height:56px;border-radius:16px;background:#eff6ff;display:flex;align-items:center;justify-content:center">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="1.5">
                  <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><path d="M8 11h6M11 8v6"/>
                </svg>
              </div>
              <div style="font-size:17px;font-weight:600;color:var(--text-1)">Нет ключевых слов</div>
              <div style="font-size:13px;opacity:.65;text-align:center;max-width:360px">
                Добавьте ключевое слово для WB, Ozon или ЯМ.<br>
                WB: позиции проверяются автоматически. Ozon/ЯМ: вводите вручную.
              </div>
              <button onclick="window.seoModule.toggleAddForm()"
                style="padding:9px 20px;border-radius:9px;border:none;background:#2563eb;color:#fff;cursor:pointer;font-size:13px;font-weight:600">
                + Добавить первый ключ
              </button>
            </div>
          ` : list.length === 0 ? `
            <div style="padding:60px;text-align:center;color:var(--text-2)">Ничего не найдено</div>
          ` : `
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead>
                <tr style="background:var(--bg);position:sticky;top:0;z-index:1;border-bottom:2px solid var(--border)">
                  <th style="padding:10px 24px;text-align:left;font-size:11px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px">Товар</th>
                  <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px">Ключевое слово</th>
                  <th style="padding:10px 12px;text-align:center;font-size:11px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px">Позиция</th>
                  <th style="padding:10px 12px;text-align:center;font-size:11px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px">14 дней</th>
                  <th style="padding:10px 12px;text-align:center;font-size:11px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px">Динамика</th>
                  <th style="padding:10px 24px;text-align:right"></th>
                </tr>
              </thead>
              <tbody>
                ${list.map(t => this.renderRow(t)).join('')}
              </tbody>
            </table>
          `}
        </div>
      </div>
    `;
  }

  private renderAddForm(): string {
    const mp = this.formMp;
    const productOptions = mp === 'wb'
      ? this.wbProducts.slice(0,300).map(p =>
          `<option value="${p.nm_id}" ${this.formProductId === String(p.nm_id) ? 'selected' : ''}>${p.nm_id} — ${p.title.slice(0,50)}</option>`)
      : mp === 'ozon'
        ? this.ozProducts.slice(0,300).map(p =>
            `<option value="${p.offer_id}" ${this.formProductId === p.offer_id ? 'selected' : ''}>${p.offer_id} — ${p.name.slice(0,50)}</option>`)
        : this.ymProducts.slice(0,300).map(p =>
            `<option value="${p.offer_id}" ${this.formProductId === p.offer_id ? 'selected' : ''}>${p.offer_id} — ${p.name.slice(0,50)}</option>`);

    return `
      <div style="padding:16px 24px;background:var(--bg);border-bottom:1px solid var(--border);flex-shrink:0">
        <div style="font-weight:700;font-size:14px;margin-bottom:12px;color:var(--text-1)">Добавить ключевое слово</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
          <div>
            <div style="font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:5px;text-transform:uppercase;letter-spacing:.5px">Маркетплейс</div>
            <div style="display:flex;gap:4px">
              ${(['wb','ozon','yandex'] as Mp[]).map(m => `
                <button onclick="window.seoModule.setFormMp('${m}')"
                  style="padding:7px 12px;border-radius:7px;border:1.5px solid ${mp===m ? MP_COLOR[m] : 'var(--border)'};
                    cursor:pointer;font-size:12px;font-weight:700;
                    background:${mp===m ? MP_BG[m] : 'var(--bg)'};color:${mp===m ? MP_COLOR[m] : 'var(--text-2)'}">
                  ${MP_LABEL[m]}
                </button>
              `).join('')}
            </div>
          </div>
          <div style="flex:1;min-width:200px">
            <div style="font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:5px;text-transform:uppercase;letter-spacing:.5px">Товар</div>
            <select onchange="window.seoModule.setFormProductId(this.value)"
              style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;
                background:var(--bg);color:var(--text-1);font-size:13px">
              <option value="">— выберите товар —</option>
              ${productOptions.join('')}
            </select>
          </div>
          <div style="flex:2;min-width:220px">
            <div style="font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:5px;text-transform:uppercase;letter-spacing:.5px">Ключевое слово</div>
            <input type="text" placeholder="Например: кресло офисное черное"
              value="${this.formKeyword.replace(/"/g,'&quot;')}"
              oninput="window.seoModule.setFormKeyword(this.value)"
              onkeydown="if(event.key==='Enter') window.seoModule.addKeyword()"
              style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;
                background:var(--bg);color:var(--text-1);font-size:13px;box-sizing:border-box">
          </div>
          <button onclick="window.seoModule.addKeyword()"
            style="padding:8px 20px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer;font-size:13px;font-weight:600">
            Добавить
          </button>
        </div>
        ${this.formError ? `<div style="font-size:12px;color:#dc2626;margin-top:8px">⚠ ${this.formError}</div>` : ''}
        <div style="font-size:11px;color:var(--text-2);margin-top:8px">
          ${mp === 'wb'
            ? `${I.radio('',14)} WB: позиция проверяется автоматически через поиск.`
            : `${I.edit()} ${MP_LABEL[mp]}: позицию нужно вводить вручную — нажмите «Позиция» в строке после добавления.`}
        </div>
      </div>
    `;
  }

  private renderRow(t: TrackedKeyword): string {
    const checking = this.checking.has(t.id);
    const lastPos  = t.positions.at(-1);
    const prevPos  = t.positions.at(-2);
    const pos      = lastPos?.position;
    const prev     = prevPos?.position;
    const delta    = pos != null && prev != null ? prev - pos : null;
    const date     = lastPos?.date ? new Date(lastPos.date).toLocaleDateString('ru',{day:'2-digit',month:'short'}) : '';
    const isManual = t.marketplace !== 'wb';
    const isEditing = this.manualId === t.id;

    let deltaHtml = '';
    if (delta !== null) {
      if (delta > 0)     deltaHtml = `<span style="color:#16a34a;font-weight:700;font-size:12px">▲${delta}</span>`;
      else if (delta < 0) deltaHtml = `<span style="color:#dc2626;font-weight:700;font-size:12px">▼${Math.abs(delta)}</span>`;
      else                deltaHtml = `<span style="color:var(--text-2);font-size:12px">→</span>`;
    }

    return `
      <tr style="border-bottom:1px solid var(--border);background:var(--bg)" onmouseover="this.style.background='var(--bg-2)'" onmouseout="this.style.background='var(--bg)'">
        <td style="padding:11px 24px">
          <div style="display:flex;align-items:center;gap:7px;margin-bottom:3px">
            <span style="font-size:9px;font-weight:800;padding:2px 6px;border-radius:4px;
              background:${MP_BG[t.marketplace]};color:${MP_COLOR[t.marketplace]};letter-spacing:.3px">${MP_LABEL[t.marketplace]}</span>
            <span style="font-weight:600;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:190px;color:var(--text-1)">${t.productTitle}</span>${copyButton(t.productTitle, 'Копировать название')}
          </div>
          <div style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-2)">${t.productId}${copyButton(t.productId, 'Копировать ID')}</div>
        </td>
        <td style="padding:11px 12px">
          <span style="font-weight:600;color:var(--text-1)">${t.keyword}</span>
        </td>
        <td style="padding:11px 12px;text-align:center">
          ${checking ? `
            <span style="font-size:12px;color:var(--text-2)">…</span>
          ` : isEditing ? `
            <div style="display:flex;flex-direction:column;align-items:center;gap:5px">
              <input id="mpos-${t.id}" type="number" min="1" max="10000"
                value="${this.manualVal}"
                oninput="window.seoModule.setManualVal(this.value)"
                onkeydown="if(event.key==='Enter') window.seoModule.saveManualPos('${t.id}')"
                style="width:72px;padding:5px 8px;border:1.5px solid #2563eb;border-radius:7px;
                  text-align:center;font-size:16px;font-weight:800;background:var(--bg);color:var(--text-1)">
              <div style="display:flex;gap:4px">
                <button onclick="window.seoModule.saveManualPos('${t.id}')"
                  style="padding:3px 10px;border-radius:6px;border:none;background:#2563eb;color:#fff;cursor:pointer;font-size:11px;font-weight:700">OK</button>
                <button onclick="window.seoModule.cancelManual()"
                  style="padding:3px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text-1);cursor:pointer;font-size:11px">✕</button>
              </div>
            </div>
          ` : pos != null ? `
            <div style="font-size:22px;font-weight:900;color:${this.posColor(pos)}">${pos}</div>
            <div style="font-size:10px;color:var(--text-2)">${date}</div>
          ` : `
            <span style="font-size:12px;color:var(--text-2)">${isManual ? '—' : 'Нет данных'}</span>
          `}
        </td>
        <td style="padding:11px 12px;text-align:center">
          ${this.sparkline(t.positions)}
        </td>
        <td style="padding:11px 12px;text-align:center">${deltaHtml || '<span style="color:var(--text-2);font-size:12px">—</span>'}</td>
        <td style="padding:11px 24px">
          <div style="display:flex;gap:5px;justify-content:flex-end">
            ${isManual ? `
              <button onclick="window.seoModule.openManualPos('${t.id}')"
                style="padding:5px 12px;border-radius:7px;border:1px solid #2563eb;cursor:pointer;
                  font-size:12px;font-weight:600;color:#2563eb;background:#eff6ff">
                ✎ Позиция
              </button>
            ` : `
              <button onclick="window.seoModule.checkPosition('${t.id}')" ${checking ? 'disabled' : ''}
                style="padding:5px 12px;border-radius:7px;border:1px solid var(--border);cursor:pointer;
                  font-size:12px;background:var(--bg);color:var(--text-1);opacity:${checking?.5:1}">
                ${checking ? '…' : '↻ Проверить'}
              </button>
            `}
            <button onclick="window.seoModule.removeKeyword('${t.id}')"
              style="padding:5px 10px;border-radius:7px;border:1px solid #fecaca;cursor:pointer;
                font-size:13px;background:#fff5f5;color:#dc2626">✕</button>
          </div>
        </td>
      </tr>
    `;
  }
}
