/** Вкладка «МРЦ» — правила поддержания витринной цены, анализ и применение. */

import { I } from '@/utils/icons';
import { MP_LABEL } from '../types';
import type { Mp, MrcScanEntry, RepricerRule } from '../types';
import { esc } from '../utils';
import { renderMrcGrid } from '../components/MrcGrid';
import { copyButton } from '@/utils/copyButton';
import type { MrcItem } from '../types';

export interface MrcTabProps {
  rules: RepricerRule[];
  analysis: Map<string, MrcScanEntry>;
  applyingKeys: Set<string>;
  /** Публичная ссылка на карточку товара на маркетплейсе (для кнопки «Проверить»). */
  productLink: (item: MrcItem) => string | null;
  scanning: boolean;
  scanLog: MrcScanEntry[];
  /** Прогресс проверки точной цены через расширение во время «Анализ». */
  scanProgress: { current: number; total: number } | null;
  /** Установлено ли расширение SimaDesk (для точной проверки цен). */
  extensionAvailable: boolean | null;
}

export function renderMrc(p: MrcTabProps): string {
  if (p.rules.length === 0) return `
    <div class="rpr-empty">
      <div class="rpr-empty-icon">${I.target()}</div>
      <h3>Нет правил МРЦ</h3>
      <p>Создайте правило типа «По МРЦ» — система будет следить за витринной ценой и подстраивать цену продавца</p>
      <button class="rpr-btn rpr-btn-green" onclick="window.repricerModule.openAddForm()" style="margin-top:6px">
        + Создать правило
      </button>
    </div>`;

  const needsUpdateCount = [...p.analysis.values()].filter(e => e.action === 'needs_update').length;

  return `
    ${renderToolbar(p, needsUpdateCount)}
    <div style="display:flex;flex-direction:column;gap:10px;padding:12px 16px">
      ${p.rules.map(rule => renderRuleCard(rule, p)).join('')}
    </div>
    ${renderJournal(p.scanLog)}
  `;
}

function renderToolbar(p: MrcTabProps, needsUpdateCount: number): string {
  const progressText = p.scanning && p.scanProgress
    ? `Проверяем цену ${p.scanProgress.current} из ${p.scanProgress.total}…`
    : null;

  return `
    <div style="display:flex;align-items:center;gap:10px;padding:10px 16px;background:var(--bg);border-bottom:1px solid var(--border);flex-wrap:wrap">
      <button class="rpr-btn rpr-btn-green" onclick="window.repricerModule.analyzeMrc()" ${p.scanning ? 'disabled' : ''}>
        ${p.scanning ? (progressText ?? 'Анализируем…') : '⟲ Анализ'}
      </button>
      ${needsUpdateCount > 0 ? `
        <button class="rpr-btn rpr-btn-outline" onclick="window.repricerModule.applyAllMrcDeviations()" ${p.scanning ? 'disabled' : ''}>
          Применить все отклонения (${needsUpdateCount})
        </button>
      ` : ''}

      ${p.extensionAvailable === false ? `
        <span style="font-size:11px;color:#f59e0b" title="Без расширения «Анализ» использует кэш цен (обновляется раз в ~20 мин)">
          ⚠ Установите расширение SimaDesk для проверки точной цены на маркетплейсе
        </span>
      ` : p.extensionAvailable === true ? `
        <span style="font-size:11px;color:#22c55e" title="Расширение SimaDesk обнаружено — «Анализ» открывает карточки товаров и считывает точную цену">
          ✓ Расширение SimaDesk подключено
        </span>
      ` : ''}

      <span style="margin-left:auto;font-size:11px;color:var(--text2)" title="Сервер сам проверяет и поддерживает МРЦ каждые ~20 минут, даже если эта вкладка закрыта. Кнопки выше — для ручной проверки прямо сейчас.">
        🛰 Автоматика работает на сервере каждые ~20 мин
      </span>
    </div>
  `;
}

function renderRuleCard(rule: RepricerRule, p: MrcTabProps): string {
  const items = rule.mrcItems ?? [];
  const uniqueProducts = new Set(items.map(i => i.vendorCode)).size;
  const title = rule.productTitle || items[0]?.productTitle || 'Без названия';

  return `
    <div class="rpr-article-card">
      <div class="rpr-article-header">
        <div style="min-width:0;flex:1">
          <div class="rpr-article-title" title="${esc(title)}" style="display:flex;align-items:center;gap:4px;white-space:normal;overflow:visible">
            <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(title)}${uniqueProducts > 1 ? ` и ещё ${uniqueProducts - 1}` : ''}</span>${copyButton(title, 'Копировать название')}
          </div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:2px">
            ${rule.vendorCode ? `<span class="rpr-article-code">${esc(rule.vendorCode)}</span>${copyButton(rule.vendorCode, 'Копировать артикул')}` : ''}
            <span style="font-size:10.5px;color:var(--text3)">${items.length} ${items.length === 1 ? 'позиция' : 'позиций'}</span>
          </div>
        </div>
        <button class="rpr-status ${rule.status === 'active' ? 'rpr-status-active' : 'rpr-status-paused'}"
          onclick="window.repricerModule.toggleStatus('${rule.id}')">
          ${rule.status === 'active' ? '● Вкл' : '○ Пауза'}
        </button>
        <button onclick="if(confirm('Удалить правило МРЦ?'))window.repricerModule.deleteRule('${rule.id}')" title="Удалить"
          style="padding:5px 9px;border-radius:7px;border:1px solid rgba(239,68,68,.3);cursor:pointer;font-size:13px;background:rgba(239,68,68,.07);color:#ef4444">✕</button>
      </div>
      ${renderMrcGrid({ rule, analysis: p.analysis, applyingKeys: p.applyingKeys, productLink: p.productLink })}
    </div>
  `;
}

const ACTION_LABEL: Record<MrcScanEntry['action'], string> = {
  ok: '✓ ок', needs_update: '≠ МРЦ', adjusted: '↻ применено', error: '⚠ ошибка',
};

function renderJournal(scanLog: MrcScanEntry[]): string {
  if (scanLog.length === 0) return '';
  return `
    <div style="margin-top:6px">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text2);margin:0 16px 8px">Журнал сканирования</div>
      <div style="display:flex;flex-direction:column;gap:4px;padding:0 16px 16px">
        ${scanLog.slice(0, 30).map(e => `
          <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;font-size:11px">
            <span style="color:var(--text3);min-width:78px;flex-shrink:0">${new Date(e.scannedAt).toLocaleString('ru', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
            <span class="rpr-mp rpr-mp-${e.mp}">${MP_LABEL[e.mp as Mp]}</span>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)">${esc(e.productTitle)}</span>${copyButton(e.productTitle, 'Копировать название')}
            <span style="color:var(--text2);flex-shrink:0">${ACTION_LABEL[e.action] ?? e.action}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}
