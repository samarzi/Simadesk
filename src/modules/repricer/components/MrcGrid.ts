/**
 * Компактная сетка «товар × маркетплейс» для правила МРЦ:
 * одна строка на товар, по одной колонке на каждый встречающийся маркетплейс.
 * В каждой ячейке — переключатель вкл/выкл, цена МРЦ и (после анализа) статус.
 */

import { MP_COLOR, MP_LABEL } from '../types';
import type { Mp, MrcItem, MrcScanEntry, RepricerRule } from '../types';
import { esc, mrcItemStateKey } from '../utils';
import { copyButton } from '@/utils/copyButton';

export interface MrcGridProps {
  rule: RepricerRule;
  /** Последняя запись анализа по каждой ячейке, ключ = mrcItemStateKey(rule, item). */
  analysis: Map<string, MrcScanEntry>;
  /** Ключи ячеек (mrcItemStateKey), для которых применение сейчас выполняется. */
  applyingKeys: Set<string>;
  /** Публичная ссылка на карточку товара на маркетплейсе (для кнопки «Проверить»). */
  productLink: (item: MrcItem) => string | null;
}

const MP_ORDER: Mp[] = ['wb', 'ozon', 'yandex'];

export function renderMrcGrid(p: MrcGridProps): string {
  const items = p.rule.mrcItems ?? [];

  const addBtn = `<div style="padding:8px 12px 12px">
    <button class="rpr-btn rpr-btn-outline" style="font-size:11px"
      onclick="window.repricerModule.openEditForm('${p.rule.id}')">+ Добавить / изменить товары</button>
  </div>`;

  if (items.length === 0) return `
    <div style="padding:16px;color:var(--text2);font-size:12px">Нет товаров в правиле</div>
    ${addBtn}
  `;

  const mps = MP_ORDER.filter(mp => items.some(i => i.mp === mp));

  // Группируем по vendorCode — одна строка на товар
  const groups = new Map<string, MrcItem[]>();
  const order: string[] = [];
  for (const item of items) {
    const k = item.vendorCode;
    if (!groups.has(k)) { groups.set(k, []); order.push(k); }
    groups.get(k)!.push(item);
  }

  return `
    <table class="rpr-mrc-grid">
      <thead>
        <tr>
          <th class="rpr-mrc-th-product">Товар</th>
          ${mps.map(mp => `<th style="color:${MP_COLOR[mp]}">${MP_LABEL[mp]}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${order.map(code => renderRow(p, groups.get(code)!, mps)).join('')}
      </tbody>
    </table>
    ${addBtn}
  `;
}

function renderRow(p: MrcGridProps, rowItems: MrcItem[], mps: Mp[]): string {
  const first = rowItems[0];
  const ruleId = p.rule.id;
  const vcEsc = esc(first.vendorCode);
  return `
    <tr>
      <td class="rpr-mrc-td-product">
        <div style="display:flex;align-items:flex-start;gap:4px">
          <div style="flex:1;min-width:0">
            <div class="rpr-mrc-title" title="${esc(first.productTitle)}" style="display:flex;align-items:center;gap:4px;white-space:normal;overflow:visible">
              <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(first.productTitle)}</span>${copyButton(first.productTitle, 'Копировать название')}
            </div>
            <div class="rpr-mrc-code" style="display:flex;align-items:center;gap:4px">${vcEsc}${copyButton(first.vendorCode, 'Копировать артикул')}</div>
          </div>
          <button title="Удалить товар из правила"
            onclick="if(confirm('Удалить «${vcEsc}» из правила?'))window.repricerModule.removeMrcProduct('${ruleId}','${vcEsc}')"
            style="flex-shrink:0;padding:2px 6px;border-radius:5px;border:1px solid rgba(239,68,68,.3);background:rgba(239,68,68,.07);color:#ef4444;cursor:pointer;font-size:11px;line-height:1.4">✕</button>
        </div>
      </td>
      ${mps.map(mp => {
        const item = rowItems.find(i => i.mp === mp);
        return `<td>${item ? renderCell(p, item) : `<span class="rpr-mrc-empty">—</span>`}</td>`;
      }).join('')}
    </tr>
  `;
}

function renderCell(p: MrcGridProps, item: MrcItem): string {
  const key = mrcItemStateKey(p.rule, item);
  const entry = p.analysis.get(key);
  const isApplying = p.applyingKeys.has(key);

  return `
    <div class="rpr-mrc-cell ${item.enabled ? '' : 'rpr-mrc-cell-disabled'}">
      <div class="rpr-mrc-cell-row">
        <button class="rpr-mrc-toggle ${item.enabled ? 'on' : ''}"
          onclick="window.repricerModule.toggleMrcItem('${p.rule.id}','${item.key}')"
          title="${item.enabled ? 'Выключить' : 'Включить'}">
          <span class="rpr-mrc-toggle-dot"></span>
        </button>
        <input type="number" class="rpr-mrc-price-input" value="${item.mrcPrice || ''}" min="0" step="1" placeholder="МРЦ, ₽"
          onchange="window.repricerModule.updateMrcItemPrice('${p.rule.id}','${item.key}',+this.value)">
      </div>
      ${renderStatus(p, item, entry, isApplying)}
    </div>
  `;
}

const fmt = (n: number | undefined | null): string => n ? `${Math.round(n).toLocaleString('ru')} ₽` : '—';

function renderLink(p: MrcGridProps, item: MrcItem): string {
  const link = p.productLink(item);
  if (!link) return '';
  return `<a class="rpr-mrc-btn rpr-mrc-link" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Проверить ↗</a>`;
}

function renderExtensionError(p: MrcGridProps, item: MrcItem, entry: MrcScanEntry): string {
  if (!entry.extensionError) return '';
  return `
    <div class="rpr-mrc-status rpr-mrc-status-warn">
      ⚠ Точная цена не проверена: ${esc(entry.extensionError)}
      <button class="rpr-mrc-btn" onclick="window.repricerModule.retryMrcItem('${p.rule.id}','${item.key}')">Повторить</button>
    </div>
  `;
}

const PAUSE_REASON_LABEL: Record<string, string> = {
  no_fresh_data: 'нет свежих данных о витрине',
};

function renderPaused(p: MrcGridProps, item: MrcItem, entry: MrcScanEntry | undefined): string {
  const priceLine = entry ? `<div class="rpr-mrc-prices">ЛК: ${fmt(entry.sellerPrice)} · Витрина: ${fmt(entry.buyerPrice)} · МРЦ: ${fmt(item.mrcPrice)}</div>` : '';
  const reason = p.rule.mrcState?.[item.key]?.pausedReason;
  const reasonLabel = reason ? (PAUSE_REASON_LABEL[reason] ?? reason) : 'аномальные данные';
  const pausedAt = p.rule.mrcState?.[item.key]?.pausedAt;
  const since = pausedAt ? new Date(pausedAt).toLocaleString('ru', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  return `
    ${priceLine}
    <div class="rpr-mrc-status rpr-mrc-status-err">⏸ Требует внимания: ${esc(reasonLabel)}${since ? ` (с ${since})` : ''}</div>
    <div class="rpr-mrc-status rpr-mrc-status-muted">Сервер несколько раз подряд получил подозрительные данные и остановил автоматику для этой ячейки. Возобновится сама после нескольких нормальных проверок — или снимите паузу вручную.</div>
    <button class="rpr-mrc-btn" onclick="window.repricerModule.clearMrcPause('${p.rule.id}','${item.key}')">Снять паузу</button>
  `;
}

function renderStatus(p: MrcGridProps, item: MrcItem, entry: MrcScanEntry | undefined, isApplying: boolean): string {
  const linkBtn = renderLink(p, item);

  if (p.rule.mrcState?.[item.key]?.paused) {
    return `${renderPaused(p, item, entry)}${linkBtn ? `<div class="rpr-mrc-links">${linkBtn}</div>` : ''}`;
  }

  if (isApplying) {
    return `<div class="rpr-mrc-status rpr-mrc-status-info">⏳ применяем…</div>`;
  }
  if (!entry) {
    return `
      <div class="rpr-mrc-status rpr-mrc-status-muted">не анализировано</div>
      ${linkBtn ? `<div class="rpr-mrc-links">${linkBtn}</div>` : ''}
    `;
  }

  const priceLine = `<div class="rpr-mrc-prices">ЛК: ${fmt(entry.sellerPrice)} · Витрина: ${fmt(entry.buyerPrice)} · МРЦ: ${fmt(item.mrcPrice)}</div>`;
  const links = `<div class="rpr-mrc-links">${linkBtn}<button class="rpr-mrc-btn" onclick="window.repricerModule.retryMrcItem('${p.rule.id}','${item.key}')">Повторить</button></div>`;

  if (entry.needsConfirm) {
    return `
      ${priceLine}
      <div class="rpr-mrc-status rpr-mrc-status-warn">
        Витрина: ${fmt(entry.buyerPrice)} · возможно изменения применятся позже
      </div>
      <div class="rpr-mrc-confirm">
        <button class="rpr-mrc-btn rpr-mrc-btn-ok" onclick="window.repricerModule.confirmMrcEntry('${entry.id}',true)">Применилось</button>
        <button class="rpr-mrc-btn rpr-mrc-btn-err" onclick="window.repricerModule.confirmMrcEntry('${entry.id}',false)">Не применилось</button>
      </div>
      ${renderExtensionError(p, item, entry)}
      ${links}
    `;
  }

  switch (entry.action) {
    case 'ok':
      return `
        ${priceLine}
        <div class="rpr-mrc-status rpr-mrc-status-ok">✓ Витрина совпадает с МРЦ</div>
        ${renderExtensionError(p, item, entry)}
        ${links}
      `;
    case 'needs_update': {
      const diffPct = item.mrcPrice > 0 ? Math.round((entry.buyerPrice - item.mrcPrice) / item.mrcPrice * 100) : 0;
      const sign = diffPct > 0 ? '+' : '';
      return `
        ${priceLine}
        <div class="rpr-mrc-status rpr-mrc-status-warn">Витрина ≠ МРЦ (${sign}${diffPct}%)</div>
        ${entry.newPrice ? `<div class="rpr-mrc-status rpr-mrc-status-info">Чтобы получить МРЦ, поставьте цену в ЛК: ${fmt(entry.newPrice)}</div>` : ''}
        <button class="rpr-mrc-btn rpr-mrc-btn-apply" onclick="window.repricerModule.applyMrcEntry('${entry.id}')">Применить</button>
        ${renderExtensionError(p, item, entry)}
        ${links}
      `;
    }
    case 'adjusted':
      return `
        ${priceLine}
        <div class="rpr-mrc-status rpr-mrc-status-info">Применено: цена ЛК ${fmt(entry.newPrice)} · проверяем витрину…</div>
        ${renderExtensionError(p, item, entry)}
        ${links}
      `;
    case 'error':
      if (entry.buyerPrice > 0) {
        // ЛК недоступен, но витринная цена известна — показываем без кнопки «Применить»
        const diffPct = item.mrcPrice > 0 ? Math.round((entry.buyerPrice - item.mrcPrice) / item.mrcPrice * 100) : null;
        const sign = (diffPct ?? 0) > 0 ? '+' : '';
        return `
          <div class="rpr-mrc-prices">Витрина: ${fmt(entry.buyerPrice)} · МРЦ: ${fmt(item.mrcPrice)}</div>
          ${diffPct != null ? `<div class="rpr-mrc-status rpr-mrc-status-warn">Витрина ≠ МРЦ (${sign}${diffPct}%)</div>` : ''}
          <div class="rpr-mrc-status rpr-mrc-status-err">⚠ ${esc(entry.errorMsg ?? 'ошибка')}</div>
          ${links}
        `;
      }
      return `
        <div class="rpr-mrc-status rpr-mrc-status-err">⚠ ${esc(entry.errorMsg ?? 'ошибка')}</div>
        ${links}
      `;
    default:
      return links;
  }
}
