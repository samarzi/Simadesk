-- ═══════════════════════════════════════════════════════════════════════════
-- Миграция: tx_kind + fulfillment_model
-- Дата: 2026-06-07
-- Руслан (code review): классификация транзакций должна происходить
-- при синке, не эвристикой в аналитике; нужно знать FBO vs FBS.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Тип операции транзакции ──────────────────────────────────────────────
-- Значения: 'sale' | 'return' | 'return_svc' | 'advertising' | 'storage'
--           | 'penalty' | 'service' | 'unknown'
--
-- return     = покупатель вернул товар (влияет на totalReturns)
-- return_svc = сервисная операция связанная с возвратом (логистика назад,
--              утилизация) — это расход, НЕ возврат заказа
-- service    = прочая операция без выручки
ALTER TABLE mp_transactions ADD COLUMN IF NOT EXISTS tx_kind TEXT;

-- ── 2. Модель фулфилмента магазина ─────────────────────────────────────────
-- Ozon: 'FBO' | 'FBS' | 'rFBS'
-- WB:   'FBW' | 'FBS' | 'DBS'
-- YM:   'FBY' | 'FBS' | 'DBS'
-- NULL = не указано (смешанная или неизвестная)
ALTER TABLE ozon_stores   ADD COLUMN IF NOT EXISTS fulfillment_model TEXT;
ALTER TABLE wb_stores     ADD COLUMN IF NOT EXISTS fulfillment_model TEXT;
ALTER TABLE yandex_stores ADD COLUMN IF NOT EXISTS fulfillment_model TEXT;

-- ── 3. Бэкфилл tx_kind для существующих данных ─────────────────────────────

-- OZON: продажи (есть положительная выручка, код не возврат)
UPDATE mp_transactions SET tx_kind = 'sale'
WHERE marketplace = 'ozon'
  AND tx_kind IS NULL
  AND accruals_for_sale > 0
  AND operation_type IN (
    'RegularSale', 'DepositToSeller', 'OperationTransactionPayment', 'Sale', 'ExchangeSale'
  );

-- OZON: возвраты покупателя
UPDATE mp_transactions SET tx_kind = 'return'
WHERE marketplace = 'ozon'
  AND tx_kind IS NULL
  AND operation_type IN (
    'ReturnAgentOperation', 'ClientReturnAgentOperation',
    'OperationItemReturn', 'OperationItemReturnDO',
    'ExchangeReturn', 'OperationClaim', 'OperationItemReturnExpired',
    'OperationReturnGoodsFBSofRMS'
  );

-- OZON: отмены
UPDATE mp_transactions SET tx_kind = 'return'
WHERE marketplace = 'ozon'
  AND tx_kind IS NULL
  AND (operation_type ILIKE '%cancel%');

-- OZON: сервисные операции возврата (логистика назад — НЕ возврат заказа)
UPDATE mp_transactions SET tx_kind = 'return_svc'
WHERE marketplace = 'ozon'
  AND tx_kind IS NULL
  AND operation_type IN (
    'ReturnNotDelivery', 'ReturnNotDeliveryDO',
    'ReturnAgentDelivery', 'ClientReturnDelivery', 'ReturnScrapDisposal'
  );

-- OZON: реклама
UPDATE mp_transactions SET tx_kind = 'advertising'
WHERE marketplace = 'ozon'
  AND tx_kind IS NULL
  AND (operation_type ILIKE '%marketing%'
    OR operation_type ILIKE '%costperclick%'
    OR operation_type ILIKE '%promotion%');

-- OZON: хранение
UPDATE mp_transactions SET tx_kind = 'storage'
WHERE marketplace = 'ozon'
  AND tx_kind IS NULL
  AND (operation_type ILIKE '%storage%' OR operation_type ILIKE '%temporarystorage%');

-- OZON: штрафы
UPDATE mp_transactions SET tx_kind = 'penalty'
WHERE marketplace = 'ozon'
  AND tx_kind IS NULL
  AND (operation_type ILIKE '%penalty%' OR operation_type ILIKE '%fine%');

-- ────────────────────────────────────────────────────────────────────────────

-- WB: возвраты (по русскому названию)
UPDATE mp_transactions SET tx_kind = 'return'
WHERE marketplace = 'wb'
  AND tx_kind IS NULL
  AND (operation_type_name ILIKE '%возврат%'
    OR operation_type_name ILIKE '%невыкуп%');

-- WB: хранение
UPDATE mp_transactions SET tx_kind = 'storage'
WHERE marketplace = 'wb'
  AND tx_kind IS NULL
  AND (operation_type_name ILIKE '%хранен%' OR operation_type_name ILIKE '%storage%');

-- WB: штрафы
UPDATE mp_transactions SET tx_kind = 'penalty'
WHERE marketplace = 'wb'
  AND tx_kind IS NULL
  AND (operation_type_name ILIKE '%штраф%' OR operation_type_name ILIKE '%компенс%');

-- WB: реклама
UPDATE mp_transactions SET tx_kind = 'advertising'
WHERE marketplace = 'wb'
  AND tx_kind IS NULL
  AND (operation_type_name ILIKE '%реклам%' OR operation_type_name ILIKE '%продвиж%');

-- WB: продажи
UPDATE mp_transactions SET tx_kind = 'sale'
WHERE marketplace = 'wb'
  AND tx_kind IS NULL
  AND accruals_for_sale > 0;

-- ────────────────────────────────────────────────────────────────────────────

-- YANDEX: прямой маппинг по статусу заказа
UPDATE mp_transactions SET tx_kind = 'sale'
WHERE marketplace = 'yandex'
  AND tx_kind IS NULL
  AND operation_type IN ('DELIVERED', 'PICKUP');

UPDATE mp_transactions SET tx_kind = 'return'
WHERE marketplace = 'yandex'
  AND tx_kind IS NULL
  AND operation_type IN ('RETURNED', 'PARTIALLY_RETURNED', 'CANCELLED_IN_DELIVERY');

-- ────────────────────────────────────────────────────────────────────────────

-- FALLBACK для всего что осталось NULL
UPDATE mp_transactions SET tx_kind = 'sale'
WHERE tx_kind IS NULL AND accruals_for_sale > 0;

UPDATE mp_transactions SET tx_kind = 'return'
WHERE tx_kind IS NULL AND accruals_for_sale < 0;

UPDATE mp_transactions SET tx_kind = 'service'
WHERE tx_kind IS NULL;

-- ── 4. Индекс для быстрого фильтра по tx_kind ───────────────────────────────
CREATE INDEX IF NOT EXISTS mp_transactions_tx_kind_idx ON mp_transactions (tx_kind);

-- ── 5. Индекс по posting_number для distinct-count возвратов ────────────────
CREATE INDEX IF NOT EXISTS mp_transactions_posting_idx ON mp_transactions (posting_number)
  WHERE posting_number IS NOT NULL;
