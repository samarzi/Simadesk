import { ozonApi } from '@/services/ozonApi';
import { wbApi } from '@/services/wbApi';
import { yandexApi } from '@/services/yandexApi';
import { ozonDb } from '@/services/ozonDb';
import { wbDb } from '@/services/wbDb';
import { yandexDb } from '@/services/yandexDb';
import { I } from '@/utils/icons';
import { esc } from '@/utils/format';
import { showToast } from '@/utils/toast';

type Tab = 'ozon' | 'wb' | 'yandex';

interface Supply {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  itemsCount: number;
}

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  draft:      { text: 'Черновик',  color: '#6b7280' },
  sent:       { text: 'Отправлена', color: '#f59e0b' },
  delivering: { text: 'В пути',    color: '#3b82f6' },
  delivered:  { text: 'Принята',   color: '#10b981' },
  received:   { text: 'Получена',  color: '#10b981' },
  cancelled:  { text: 'Отменена',  color: '#ef4444' },
  done:       { text: 'Завершена', color: '#10b981' },
};

function statusChip(s: string): string {
  const st = STATUS_LABEL[s] ?? { text: s, color: '#6b7280' };
  return `<span style="
    display:inline-block;padding:2px 10px;border-radius:999px;
    font-size:11px;font-weight:700;letter-spacing:.3px;
    background:${st.color}22;color:${st.color}">${st.text}</span>`;
}

export class SupplyManagementModule {
  private el: HTMLElement;
  private tab: Tab = 'ozon';
  private storeId = '';
  private stores: Array<{ id: string; name: string }> = [];
  private supplies: Supply[] = [];
  private loading = false;
  private detail: Supply | null = null;

  constructor(container: HTMLElement) {
    this.el = container;
    this.el.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden';
    this.buildShell();
    this.loadStores();
  }

  // ── Render helpers ──────────────────────────────────────────────────────────

  private buildShell(): void {
    this.el.innerHTML = `
      <div class="rpr" style="flex:1;min-height:0">

        <div class="rpr-header">
          <div class="rpr-header-left">
            <div class="rpr-logo-icon" style="background:linear-gradient(135deg,#f59e0b,#d97706)">
              ${I.truck()}
            </div>
            <span class="rpr-logo-text">Поставки</span>
            <div class="an2-tabs" id="sp-tabs">
              ${(['ozon','wb','yandex'] as Tab[]).map(t => `
                <button class="an2-tab ${t === this.tab ? 'active' : ''}" data-tab="${t}">
                  ${t === 'ozon' ? 'Ozon FBO' : t === 'wb' ? 'Wildberries' : 'Яндекс FBY'}
                </button>`).join('')}
            </div>
          </div>
          <div class="rpr-header-actions">
            <select class="form-select" id="sp-store" style="min-width:180px;height:30px;font-size:12px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:0 8px">
              <option value="">Загрузка...</option>
            </select>
            <button class="rpr-btn rpr-btn-green" id="sp-create">${I.plus()} Создать</button>
            <button class="rpr-btn rpr-btn-ghost" id="sp-refresh">${I.refresh()}</button>
          </div>
        </div>

        <div class="rpr-body" id="sp-body" style="overflow:auto">
          ${this.renderBody()}
        </div>

      </div>
    `;
    this.bindAll();
  }

  private renderBody(): string {
    if (this.detail) return this.renderDetail();
    if (this.loading) return this.renderSkeleton();
    return this.renderList();
  }

  private renderSkeleton(): string {
    return `<div style="padding:20px;display:flex;flex-direction:column;gap:10px">
      ${Array(6).fill(`<div style="height:40px;border-radius:8px;background:var(--bg3);animation:spin .9s linear infinite alternate"></div>`).join('')}
    </div>`;
  }

  private renderList(): string {
    if (!this.storeId) {
      return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;color:var(--text2)">
        <div style="font-size:40px;opacity:.3">${I.truck()}</div>
        <p style="margin:0;font-size:14px">Выберите магазин для загрузки поставок</p>
      </div>`;
    }
    if (this.supplies.length === 0) {
      return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;color:var(--text2)">
        <div style="font-size:40px;opacity:.3">${I.truck()}</div>
        <p style="margin:0;font-size:14px">Поставок нет. Нажмите <strong>«Создать»</strong>.</p>
      </div>`;
    }

    return `<table class="rpr-table" style="width:100%">
      <thead><tr>
        <th>Название</th>
        <th>Статус</th>
        <th style="text-align:center">Товаров</th>
        <th>Создана</th>
        <th></th>
      </tr></thead>
      <tbody>
        ${this.supplies.map(s => `
          <tr>
            <td style="font-weight:600">${esc(s.name)}</td>
            <td>${statusChip(s.status)}</td>
            <td style="text-align:center;font-variant-numeric:tabular-nums">${s.itemsCount}</td>
            <td style="color:var(--text2);font-size:12px">${new Date(s.createdAt).toLocaleDateString('ru-RU')}</td>
            <td>
              <button class="rpr-btn rpr-btn-ghost" style="padding:4px 10px;font-size:11px"
                data-action="open" data-id="${esc(s.id)}">${I.eye()} Открыть</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  }

  private renderDetail(): string {
    const s = this.detail!;
    const isDraft = s.status === 'draft';
    return `
      <div style="max-width:680px;padding:24px;display:flex;flex-direction:column;gap:20px">

        <div style="display:flex;align-items:center;gap:12px">
          <button class="rpr-btn rpr-btn-ghost" id="sp-back">← Назад</button>
          <h3 style="margin:0;font-size:16px;font-weight:800">${esc(s.name)}</h3>
          ${statusChip(s.status)}
        </div>

        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
          ${[
            ['ID', `<code style="font-size:11px">${esc(s.id)}</code>`],
            ['Товаров', `<strong>${s.itemsCount}</strong>`],
            ['Создана', new Date(s.createdAt).toLocaleDateString('ru-RU')],
          ].map(([label, val]) => `
            <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px 14px">
              <div style="font-size:11px;color:var(--text2);margin-bottom:4px">${label}</div>
              <div style="font-size:13px;color:var(--text)">${val}</div>
            </div>`).join('')}
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="rpr-btn rpr-btn-green" id="sp-send" ${isDraft ? '' : 'disabled'}>
            ${I.send()} Отправить поставку
          </button>
          <button class="rpr-btn rpr-btn-ghost" id="sp-barcodes">
            ${I.download()} Штрихкоды PDF
          </button>
          <button class="rpr-btn rpr-btn-ghost" id="sp-add-items" ${isDraft ? '' : 'disabled'}>
            ${I.plus()} Добавить товары
          </button>
          <button class="rpr-btn" style="background:#ef444422;color:#ef4444;border:1px solid #ef444444"
            id="sp-cancel" ${isDraft ? '' : 'disabled'}>
            ${I.trash()} Отменить
          </button>
        </div>

        <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:16px;color:var(--text2);font-size:13px">
          ${I.info()} Для добавления товаров в поставку используйте личный кабинет маркетплейса или API addProductsToSupply.
        </div>
      </div>`;
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  private bindAll(): void {
    this.el.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!btn) return;

      const tabVal = btn.dataset.tab as Tab | undefined;
      if (tabVal) {
        this.tab = tabVal;
        this.storeId = '';
        this.supplies = [];
        this.detail = null;
        this.el.querySelectorAll('.an2-tab').forEach(t => {
          t.classList.toggle('active', (t as HTMLElement).dataset.tab === tabVal);
        });
        this.flush();
        this.loadStores();
        return;
      }

      switch (btn.id) {
        case 'sp-create':  this.createSupply(); break;
        case 'sp-refresh': this.loadSupplies(); break;
        case 'sp-back':    this.detail = null; this.flush(); break;
        case 'sp-send':    this.sendSupply(); break;
        case 'sp-barcodes': this.downloadBarcodes(); break;
        case 'sp-cancel':  this.cancelSupply(); break;
        case 'sp-add-items':
          showToast('Добавление товаров: используйте метод ozonApi.addProductsToSupply', 'info');
          break;
      }

      if (btn.dataset.action === 'open') {
        const found = this.supplies.find(s => s.id === btn.dataset.id);
        if (found) { this.detail = found; this.flush(); }
      }
    });

    this.el.addEventListener('change', (e) => {
      const sel = e.target as HTMLSelectElement;
      if (sel.id === 'sp-store') {
        this.storeId = sel.value;
        this.supplies = [];
        this.detail = null;
        if (this.storeId) this.loadSupplies();
        else this.flush();
      }
    });
  }

  private flush(): void {
    const body = this.el.querySelector('#sp-body');
    if (body) body.innerHTML = this.renderBody();
  }

  // ── Data ────────────────────────────────────────────────────────────────────

  private async loadStores(): Promise<void> {
    const sel = this.el.querySelector('#sp-store') as HTMLSelectElement | null;
    if (!sel) return;
    this.stores = [];
    try {
      if (this.tab === 'ozon')   this.stores = await ozonDb.getStores();
      else if (this.tab === 'wb') this.stores = await wbDb.getStores();
      else                        this.stores = await yandexDb.getStores();
    } catch { /* ignore */ }

    if (!this.stores.length) {
      sel.innerHTML = '<option value="">Нет магазинов</option>';
      this.storeId = '';
      this.flush();
      return;
    }
    sel.innerHTML = '<option value="">— Магазин —</option>' +
      this.stores.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');

    if (this.stores.length === 1) {
      this.storeId = this.stores[0].id;
      sel.value = this.storeId;
      this.loadSupplies();
    } else {
      this.flush();
    }
  }

  private async loadSupplies(): Promise<void> {
    if (!this.storeId) return;
    this.loading = true;
    this.flush();

    try {
      this.supplies = [];

      if (this.tab === 'ozon') {
        const store = this.stores.find(s => s.id === this.storeId) as any;
        if (!store) throw new Error('Магазин не найден');
        const creds = { client_id: store.client_id, api_key: store.api_key };
        let list: any[] = [];
        try {
          list = await ozonApi.getSupplies(creds);
        } catch (err: any) {
          if (err.message?.includes('404') || err.status === 404) {
            showToast('FBO поставки недоступны — у этого магазина нет FBO-склада', 'info');
          } else {
            throw err;
          }
        }
        for (const s of list) {
          this.supplies.push({
            id: s.supply_order_id ?? s.id ?? '',
            name: s.name ?? `Поставка ${s.supply_order_id}`,
            status: s.status ?? 'draft',
            createdAt: s.created_at ?? new Date().toISOString(),
            itemsCount: s.items?.length ?? 0,
          });
        }

      } else if (this.tab === 'wb') {
        const store = this.stores.find(s => s.id === this.storeId) as any;
        if (!store) throw new Error('Магазин не найден');
        const list = await wbApi.getWbSupplies(store.api_key);
        for (const s of list) {
          this.supplies.push({
            id: s.id,
            name: s.name ?? `Поставка ${s.id}`,
            status: s.done ? 'done' : 'draft',
            createdAt: s.createdAt ?? new Date().toISOString(),
            itemsCount: s.orderCount ?? 0,
          });
        }

      } else {
        showToast('Отгрузки Яндекс Маркет управляются в ЯМ → Логистика', 'info');
      }

    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    } finally {
      this.loading = false;
      this.flush();
    }
  }

  private async createSupply(): Promise<void> {
    if (!this.storeId) { showToast('Выберите магазин', 'warning'); return; }
    const name = prompt(`Название новой поставки (${this.tab.toUpperCase()}):`);
    if (!name?.trim()) return;

    const btn = this.el.querySelector('#sp-create') as HTMLButtonElement;
    btn.disabled = true;
    btn.innerHTML = `${I.loader()} Создание...`;

    try {
      const store = this.stores.find(s => s.id === this.storeId) as any;
      if (this.tab === 'ozon') {
        const creds = { client_id: store.client_id, api_key: store.api_key };
        const wh = await ozonApi.getWarehouses(creds);
        if (!wh.length) throw new Error('Нет складов Ozon FBO');
        await ozonApi.createSupply(creds, wh[0].warehouse_id, name.trim());
      } else if (this.tab === 'wb') {
        await wbApi.createWbSupply(store.api_key, name.trim());
      } else {
        if (!store.campaign_id) throw new Error('Нет campaign_id');
        const d1 = new Date(Date.now() + 86_400_000);
        const d7 = new Date(Date.now() + 7 * 86_400_000);
        const fmt = (d: Date) => d.toISOString().slice(0, 10);
        await yandexApi.createShipment(store.api_key, store.campaign_id,
          { planIntervalFrom: fmt(d1), planIntervalTo: fmt(d7) });
      }
      showToast('Поставка создана', 'success');
      await this.loadSupplies();
    } catch (err: any) {
      showToast(`Ошибка: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `${I.plus()} Создать`;
    }
  }

  private async sendSupply(): Promise<void> {
    if (!this.detail || !confirm('Отправить поставку? После отправки изменения невозможны.')) return;
    try {
      const store = this.stores.find(s => s.id === this.storeId) as any;
      if (this.tab === 'ozon')
        await ozonApi.sendSupply({ client_id: store.client_id, api_key: store.api_key }, this.detail.id);
      else if (this.tab === 'wb')
        await wbApi.deliverSupply(store.api_key, this.detail.id);
      else
        await yandexApi.confirmShipment(store.api_key, store.campaign_id, Number(this.detail.id));

      showToast('Поставка отправлена', 'success');
      this.detail.status = 'sent';
      this.flush();
    } catch (err: any) { showToast(`Ошибка: ${err.message}`, 'error'); }
  }

  private async downloadBarcodes(): Promise<void> {
    if (!this.detail) return;
    try {
      let blob: Blob;
      const store = this.stores.find(s => s.id === this.storeId) as any;
      if (this.tab === 'ozon')
        blob = await ozonApi.getSupplyBarcodes({ client_id: store.client_id, api_key: store.api_key }, this.detail.id);
      else if (this.tab === 'wb')
        blob = await wbApi.getSupplyBarcodePdf(store.api_key, this.detail.id);
      else {
        showToast('Штрихкоды ЯМ: скачайте через Яндекс Маркет → Отгрузки', 'info');
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), {
        href: url, download: `supply_${this.detail.id}_barcodes.pdf` });
      a.click();
      URL.revokeObjectURL(url);
      showToast('Штрихкоды скачаны', 'success');
    } catch (err: any) { showToast(`Ошибка: ${err.message}`, 'error'); }
  }

  private async cancelSupply(): Promise<void> {
    if (!this.detail || !confirm('Отменить поставку?')) return;
    try {
      if (this.tab !== 'ozon') { showToast('Отмена доступна только для Ozon', 'info'); return; }
      const store = this.stores.find(s => s.id === this.storeId) as any;
      await ozonApi.cancelSupply({ client_id: store.client_id, api_key: store.api_key }, this.detail.id);
      showToast('Поставка отменена', 'success');
      this.detail = null;
      await this.loadSupplies();
    } catch (err: any) { showToast(`Ошибка: ${err.message}`, 'error'); }
  }

  show(): void { this.el.style.display = 'flex'; }
  hide(): void { this.el.style.display = 'none'; }
}
