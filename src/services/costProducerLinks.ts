/**
 * costProducerLinks — хранит мета-информацию о том, какие себестоимости
 * были заполнены автоматически из раздела «Производители → Связки».
 *
 * Хранится только в localStorage (не синхронизируется с Supabase — это мета).
 * При смене компании данные изолированы через company_id.
 */

import { companyService } from './companyService';

const KEY_PREFIX = 'cost_producer_links_v1_';

export interface ProducerCostLink {
  producerProductId: string;  // id товара производителя
  producerName: string;       // отображаемое имя для UI
  costAtLink: number;         // себестоимость на момент привязки (для «перепривязать»)
  linkedAt: string;           // ISO timestamp
}

// ── Storage helpers ───────────────────────────────────────────────────────────

function getKey(): string {
  const cid = companyService.getActiveId() ?? '_default';
  return `${KEY_PREFIX}${cid}`;
}

function load(): Record<string, ProducerCostLink> {
  try { return JSON.parse(localStorage.getItem(getKey()) || '{}'); } catch { return {}; }
}

function save(d: Record<string, ProducerCostLink>): void {
  try { localStorage.setItem(getKey(), JSON.stringify(d)); } catch {}
}

const norm = (s: string) => String(s ?? '').trim().toLowerCase();

// ── Public API ────────────────────────────────────────────────────────────────

export const costProducerLinks = {
  /** Привязать артикул к товару производителя. */
  link(vendorCode: string, producerProductId: string, producerName: string, cost: number): void {
    const d = load();
    d[norm(vendorCode)] = {
      producerProductId,
      producerName,
      costAtLink: cost,
      linkedAt: new Date().toISOString(),
    };
    save(d);
  },

  /** Снять привязку (при ручном изменении себестоимости). */
  unlink(vendorCode: string): void {
    const d = load();
    delete d[norm(vendorCode)];
    save(d);
  },

  /** Обновить costAtLink (при изменении себестоимости в карточке производителя). */
  updateCost(vendorCode: string, newCost: number): void {
    const d = load();
    const k = norm(vendorCode);
    if (d[k]) {
      d[k].costAtLink = newCost;
      d[k].linkedAt = new Date().toISOString();
      save(d);
    }
  },

  /** Получить данные привязки или null. */
  get(vendorCode: string): ProducerCostLink | null {
    return load()[norm(vendorCode)] ?? null;
  },

  /** Есть ли привязка к производителю? */
  isLinked(vendorCode: string): boolean {
    return !!load()[norm(vendorCode)];
  },

  /** Все привязки текущей компании. */
  all(): Record<string, ProducerCostLink> {
    return load();
  },

  /** Очистить при смене компании (вызывается из companyService.onChange). */
  clearCache(): void {
    // Данные не удаляем, просто ключ изменится при новом getKey().
  },
};

// При смене компании ничего делать не нужно — getKey() автоматически берёт новый cid.
