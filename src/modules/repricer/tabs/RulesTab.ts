/** Вкладка «Правила» — список правил репрайсера, сгруппированный по артикулу. */

import { I } from '@/utils/icons';
import { MP_LABEL, RULE_LABELS } from '../types';
import type { RepricerRule, RuleType } from '../types';
import { esc, ruleProducts } from '../utils';
import { copyButton } from '@/utils/copyButton';

export interface RulesTabProps {
  rules: RepricerRule[];
  rulesSearch: string;
  rulesTypeFilter: RuleType;
  /** Рассчитанная целевая цена правила (для primary-товара) — для отображения. */
  computePrice: (r: RepricerRule) => number | null;
  /** Текущая цена товара на маркетплейсе (из каталога). */
  getCurrentPrice: (r: RepricerRule) => number | null;
  getProductImage: (r: RepricerRule) => string | null;
  applying: Set<string>;
  applyErrors: Map<string, string>;
  /** Есть ли непроверенные/требующие подтверждения изменения МРЦ — индикатор на под-вкладке. */
  mrcAlert: boolean;
  /** Контент под-вкладки «По МРЦ» (тулбар анализа + карточки + журнал). */
  renderMrcContent: () => string;
}

const RULE_TYPES = Object.keys(RULE_LABELS) as RuleType[];

/** Полная вкладка: под-вкладки по типам правил + список/контент. */
export function renderRules(p: RulesTabProps): string {
  const isMrc = p.rulesTypeFilter === 'mrc';
  return `
    <!-- ПОД-ВКЛАДКИ ПО ТИПАМ ПРАВИЛ -->
    <div class="rpr-subtabs">
      ${RULE_TYPES.map(rt => {
        const isActive = p.rulesTypeFilter === rt;
        const count = p.rules.filter(r => r.type === rt).length;
        const amber = rt === 'mrc' && p.mrcAlert;
        return `<button class="rpr-subtab${isActive ? ' active' : ''}${amber ? ' amber' : ''}"
          onclick="window.repricerModule.setRulesTypeFilter('${rt}')">
          ${RULE_LABELS[rt]}
          ${count > 0 ? `<span class="rpr-tab-badge">${count}</span>` : ''}
        </button>`;
      }).join('')}
    </div>
    ${!isMrc ? `
      <!-- ПОИСК -->
      <div style="padding:10px 16px;background:var(--bg2);border-bottom:1px solid var(--border)">
        <input type="search" placeholder="Поиск по артикулу, названию, магазину…" value="${esc(p.rulesSearch)}"
          oninput="window.repricerModule.setRulesSearch(this.value)"
          style="width:100%;padding:6px 12px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;font-size:12px">
      </div>
    ` : ''}
    <!-- СПИСОК -->
    <div id="rpr-rules-host">${renderRulesInner(p)}</div>
  `;
}

/** Только содержимое списка — обновляется при поиске без полного ре-рендера. */
export function renderRulesInner(p: RulesTabProps): string {
  if (p.rulesTypeFilter === 'mrc') return p.renderMrcContent();

  const q = p.rulesSearch.toLowerCase().trim();
  const filtered = p.rules.filter(r => {
    if (r.type !== p.rulesTypeFilter) return false;
    if (q) {
      const hay = [r.productTitle, r.vendorCode, r.storeName,
        ...ruleProducts(r).map(prod => `${prod.vendorCode} ${prod.productTitle}`)].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (filtered.length === 0) return `
    <div class="rpr-empty">
      <div class="rpr-empty-icon">⚙</div>
      <h3>Нет правил «${RULE_LABELS[p.rulesTypeFilter]}»</h3>
      <p>Создайте правило этого типа — система будет автоматически поддерживать нужные цены</p>
      <button class="rpr-btn rpr-btn-green" onclick="window.repricerModule.openAddForm('${p.rulesTypeFilter}')" style="margin-top:6px">
        + Создать правило
      </button>
    </div>`;

  // Группируем по артикулу — один товар может иметь правила сразу на нескольких
  // маркетплейсах (WB/Ozon/ЯМ), показываем их в одной карточке, а не отдельными строками.
  const groups = new Map<string, RepricerRule[]>();
  const order: string[] = [];
  for (const r of filtered) {
    const key = r.vendorCode || r.productTitle || r.id;
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key)!.push(r);
  }

  return `
    <div style="display:flex;flex-direction:column;gap:8px;padding:10px 16px">
      ${order.map(key => renderArticleCard(groups.get(key)!, p)).join('')}
    </div>
  `;
}

/** Карточка одного артикула со всеми его правилами (по всем маркетплейсам). */
function renderArticleCard(rules: RepricerRule[], p: RulesTabProps): string {
  const first = rules[0];
  const image = rules.map(r => p.getProductImage(r)).find(Boolean) ?? null;
  const title = rules.map(r => r.productTitle).sort((a, b) => b.length - a.length)[0] || first.productTitle;

  return `
    <div class="rpr-article-card">
      <div class="rpr-article-header">
        ${image
          ? `<img src="${esc(image)}" alt="" style="width:34px;height:34px;border-radius:7px;object-fit:cover;flex-shrink:0;border:1px solid var(--border);background:var(--bg3)">`
          : `<div style="width:34px;height:34px;border-radius:7px;flex-shrink:0;border:1px solid var(--border);background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:14px;color:var(--text3)">${I.package()}</div>`}
        <div style="min-width:0;flex:1">
          <div class="rpr-article-title" title="${esc(title)}" style="display:flex;align-items:center;gap:4px;white-space:normal;overflow:visible">
            <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(title)}</span>${copyButton(title, 'Копировать название')}
          </div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:2px">
            ${first.vendorCode ? `<span class="rpr-article-code">${esc(first.vendorCode)}</span>${copyButton(first.vendorCode, 'Копировать артикул')}` : ''}
            <span style="font-size:10.5px;color:var(--text3)">${rules.length} ${rules.length === 1 ? 'правило' : 'правила'}</span>
          </div>
        </div>
      </div>
      <div>
        ${rules.map(r => renderRuleLine(r, p)).join('')}
      </div>
    </div>
  `;
}

/** Одна компактная строка-правило внутри карточки артикула. */
function renderRuleLine(r: RepricerRule, p: RulesTabProps): string {
  const price = p.computePrice(r);
  const isApplying = p.applying.has(r.id);
  const applyErr = p.applyErrors.get(r.id);
  const last = r.lastAppliedAt
    ? new Date(r.lastAppliedAt).toLocaleDateString('ru',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})
    : null;
  const mpClass = `rpr-mp rpr-mp-${r.marketplace}`;

  const displayPrice = price;
  const priceLabel   = 'цель';

  const currentPrice = p.getCurrentPrice(r);
  const matches = displayPrice != null && currentPrice != null
    ? Math.abs(currentPrice - displayPrice) <= 1
    : null;

  return `
    <div class="rpr-rule-line" style="opacity:${r.status === 'paused' ? '.55' : '1'}">
      <span class="${mpClass}">${MP_LABEL[r.marketplace]}</span>
      <span class="rpr-type">${RULE_LABELS[r.type]}</span>
      <span style="font-size:10.5px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px">${esc(r.storeName)}</span>${copyButton(r.storeName, 'Копировать название магазина')}

      <div style="margin-left:auto;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <div style="text-align:right;min-width:64px">
          ${currentPrice != null
            ? `<span style="font-size:13px;font-weight:800;color:var(--text)">${currentPrice.toLocaleString('ru')} ₽</span>`
            : `<span class="rpr-price-none">—</span>`}
          <div style="font-size:9.5px;color:var(--text3);margin-top:1px">сейчас</div>
        </div>
        <div style="text-align:right;min-width:70px">
          ${displayPrice
            ? `<span class="rpr-price" style="font-size:13px">${displayPrice.toLocaleString('ru')} ₽</span>
               ${matches === true ? ' <span title="Совпадает с текущей ценой" style="color:#22c55e">✓</span>' : ''}
               ${matches === false ? ' <span title="Не совпадает с текущей ценой — правило ещё не применено" style="color:#f59e0b">≠</span>' : ''}
               <div style="font-size:9.5px;color:var(--text3);margin-top:1px">${priceLabel}</div>`
            : `<span class="rpr-price-none">—</span>`}
        </div>
        <div style="text-align:right;min-width:60px">
          ${last
            ? `<div style="font-size:11px;color:var(--text)">${last}</div>`
            : `<span style="color:var(--text3);font-size:11px">—</span>`}
        </div>
        <button class="rpr-status ${r.status === 'active' ? 'rpr-status-active' : 'rpr-status-paused'}"
          onclick="window.repricerModule.toggleStatus('${r.id}')">
          ${r.status === 'active' ? '● Вкл' : '○ Пауза'}
        </button>
        <div style="display:flex;align-items:center;gap:5px">
          ${r.status === 'active' && displayPrice ? `
            <button onclick="window.repricerModule.applyRule('${r.id}')" ${isApplying ? 'disabled' : ''} title="Применить сейчас"
              style="padding:5px 11px;border-radius:7px;border:none;cursor:pointer;font-size:12px;font-weight:600;
                background:var(--accent);color:#0a0a0a;opacity:${isApplying ? .6 : 1}">
              ${isApplying ? '…' : '▶'}
            </button>
          ` : ''}
          <button onclick="window.repricerModule.openEditForm('${r.id}')" title="Редактировать"
            style="padding:5px 9px;border-radius:7px;border:1px solid var(--border);cursor:pointer;font-size:13px;background:var(--bg);color:var(--text)">✎</button>
          <button onclick="if(confirm('Удалить правило?'))window.repricerModule.deleteRule('${r.id}')" title="Удалить"
            style="padding:5px 9px;border-radius:7px;border:1px solid rgba(239,68,68,.3);cursor:pointer;font-size:13px;background:rgba(239,68,68,.07);color:#ef4444">✕</button>
        </div>
      </div>
      ${applyErr ? `<div style="width:100%;font-size:10px;color:#dc2626;text-align:right;margin-top:3px;line-height:1.3">${esc(applyErr)}</div>` : ''}
    </div>
  `;
}
