# Implementation Plan — Analytics Fixes & Neon Redesign

## Overview

Исправление багов в модуле аналитики (`AnalyticsModule.ts`) и редизайн UI в неоновом стиле.
Охватывает: Яндекс Маркет (расчёт выручки и комиссий), Ozon (классификация услуг, delivery_charge),
светлая тема, неоновый дизайн дашборда.

---

## Tasks

### Блок 1 — Расчёт выручки Яндекс Маркет

- [x] 1.1 Исправить двойной счёт выручки в `financeSync.ts`
  - `prices[BUYER].total` — итог за ВСЕ единицы, не умножать на `count`
  - `priceForCustomer` и `costPerItem` — цена за единицу, умножать на `count`

- [x] 1.2 Добавить `calcYmRevenue()` в `AnalyticsModule.ts`
  - Пересчёт выручки из `raw_json.items` при отображении (обходит неверные старые данные в БД)
  - Используется в `buildAnalytics()` когда `store.mp === 'yandex'` и есть `raw_json.items`

- [x] 1.3 Исправить двойной счёт комиссий в `financeSync.ts`
  - Суммировать только item-level ИЛИ order-level комиссии, не оба сразу
  - `hasItemCommissions` — флаг выбора источника

### Блок 2 — Комиссии Яндекс Маркет не вычитались

- [x] 2.1 Добавить `calcYmCommissions()` в `AnalyticsModule.ts`
  - Читает `commissions[]` из `raw_json` (item-level или order-level)
  - Использует `Math.abs()` чтобы корректно обработать любой знак от API
  - Разбивает по типам: FEE/AGENCY → commission, DELIVERY/FULFILLMENT → delivery, остальное → other

- [x] 2.2 Применить `calcYmCommissions()` в `buildAnalytics()`
  - Если `sale_commission === 0` (старые данные без комиссий) → пересчёт из `raw_json`
  - Временные поля `__ymDelivery` / `__ymOther` для передачи значений в `else`-ветку

- [ ] 2.3 Проверить результат у пользователя
  - Убедиться что чистая прибыль ЯМ теперь корректна (~460к, не 1.2М)
  - Если raw_json не содержит комиссий — нужен ре-синк данных Яндекса

### Блок 3 — Ozon: классификация услуг и delivery_charge

- [x] 3.1 Исправить `classifyOzonService()`
  - Убрать `'package'` из логистики (упаковка — не логистика)
  - Добавить `'package'` / `'packaging'` в `'other'`
  - Добавить русскоязычные ключи (хранени, утилизаци, реклам, продвиж)

- [x] 3.2 Добавить обработку `delivery_charge` и `return_delivery_charge` для Ozon
  - Эти поля — отдельные top-level поля API (особенно важны для FBS/rFBS)
  - Добавлены в `buildAnalytics()` и `txBreakdown()`

- [x] 3.3 Добавить флаг `hasRawServices` в `parseOzonServices()`
  - Если `raw_json.services` недоступен — fallback на `services_total`
  - Не показывать 0 по всем категориям, если нет подробных данных

- [x] 3.4 Добавить null-check для Ozon API (`data.result`)
  - Ozon иногда возвращает 200 OK с `{ "message": "...", "result": null }`
  - Теперь выбрасывается понятная ошибка вместо краша

- [x] 3.5 Расширить `ozonServiceLabel()` новыми кодами услуг
  - `MarketplaceServiceItemStorageFBO`, `*FBOMonthly`, `*Fulfillment`, `*DeliveryFBS`, `*VDC`-варианты

### Блок 4 — Светлая тема в аналитике

- [x] 4.1 Создать палитру `N_LIGHT` и `N_DARK`
  - `N_LIGHT` использует CSS-переменные `var(--bg)`, `var(--text)` и т.д.
  - `N_DARK` — оригинальные неоновые цвета

- [x] 4.2 Добавить функцию `applyTheme()`
  - Проверяет `document.documentElement.classList.contains('light')`
  - `Object.assign(N, isLight ? N_LIGHT : N_DARK)` — меняет модульный объект N
  - Вызывается в начале каждого `render()`

- [x] 4.3 Добавить CSS-глушители неонового свечения для светлой темы
  - `html.light .an-card { box-shadow: ... !important }`
  - `html.light [style*="text-shadow"] { text-shadow: none !important }`

### Блок 5 — Неоновый редизайн UI

- [x] 5.1 Редизайн `render()` / `renderHeader()`
  - Неоновые карточки KPI (`neonCard()`), sparkline SVG, цветовая палитра `N`

- [x] 5.2 Редизайн `renderDashboard()`
  - Обзорные карточки по маркетплейсам, таймсерия, структура расходов

- [x] 5.3 Редизайн `renderProducts()`
  - Таблица топ-товаров с неоновым оформлением

- [ ] 5.4 Редизайн `renderOperations()` и `renderProductDetail()`
  - Операции по транзакциям в неоновом стиле
  - Детальная карточка товара

### Блок 6 — Деплой

- [x] 6.1 Деплой после исправления выручки (calcYmRevenue)
- [x] 6.2 Деплой после исправления комиссий (calcYmCommissions)
- [ ] 6.3 Деплой после редизайна renderOperations / renderProductDetail (когда будет готов)

---

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["2.1", "3.1", "3.2", "3.3", "3.4", "3.5"] },
    { "id": 2, "tasks": ["2.2", "4.1", "4.2", "4.3"] },
    { "id": 3, "tasks": ["2.3", "5.1", "5.2", "5.3"] },
    { "id": 4, "tasks": ["5.4", "6.1", "6.2"] },
    { "id": 5, "tasks": ["6.3"] }
  ]
}
```

## Notes

- Все изменения аналитики — в `src/modules/AnalyticsModule.ts`
- Изменения синка — в `src/services/financeSync.ts`
- Ozon API — в `src/services/ozonFinanceApi.ts`
- Деплой: `npm run build && netlify deploy --prod --dir=dist`
- Сайт: https://sabatov.netlify.app
