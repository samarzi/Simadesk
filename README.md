# SimaDesk — Рабочее место продавца маркетплейсов

SaaS-платформа для управления бизнесом на Ozon, Wildberries и Яндекс Маркет.  
Одно рабочее пространство: товары, заказы, аналитика, репрайсер, документы, витрина, AI-ассистент.

**Сайт:** https://simadesk.ru  
**Стек:** TypeScript + Vite + Supabase + Docker Compose (VPS)  
**Версия:** 2.0.0

---

## Возможности

### Маркетплейсы
- **Ozon** — товары, заказы, возвраты, отзывы, остатки FBS/FBO, реклама, аналитика
- **Wildberries** — товары, заказы, возвраты, отзывы, аналитика финансов
- **Яндекс Маркет** — товары, заказы, аналитика
- Мультимагазин — несколько аккаунтов на одном маркетплейсе в одном интерфейсе

### AI-ассистент «Сима»
- Чат с историей сессий (до 10 сохранённых чатов)
- Голосовые ответы (TTS через edge-функцию)
- Автоматическое выполнение задач в документах (замена текста, форматирование)
- Отчёт об изменениях после каждой задачи
- Дневные квоты токенов с boost-пакетами

### Документы (DocsModule)
- Редактор Word-документов (.docx) прямо в браузере
- Импорт/экспорт стилей (жирный, курсив, цвет, размер шрифта, зачёркивание)
- Массовые замены через AI или вручную
- Мультидокументное редактирование

### Репрайсер
- Автоматическое изменение цен по правилам
- Мониторинг цен конкурентов (Ozon, WB)
- Логирование изменений цен

### Аналитика
- Заказы, выручка, прибыль по периодам
- Себестоимость товаров (cost price)
- Финансовые транзакции маркетплейсов
- Кэш аналитики для быстрой загрузки

### Витрина (SimaStore)
- Публичный каталог товаров компании на `/s/:slug`
- Кастомный логотип, баннеры, телефон
- Фильтры по категориям и производителям
- Отображение остатков

### Биллинг
- Подписки (trial / платные планы)
- Промокоды
- Оплата через YooKassa
- Boost-пакеты токенов AI

### Chrome-расширение
- Автоматизация Ozon: настройка складов, тарифов зон доставки
- Автоматизация Яндекс Маркет: склады, тарифы
- Мониторинг цен на Ozon.ru, Wildberries, Яндекс Маркет (страницы товаров)
- Мост для связи с SimaDesk-сайтом

### Прочее
- Менеджер задач с roadmap
- Поддержка (live-чат с набором текста в реальном времени)
- Telegram-уведомления
- Мультипользователь (приглашения по ссылке)
- Шифрование ключей маркетплейсов

---

## Структура проекта

```
src/
├── modules/              # Функциональные модули (один файл = один раздел UI)
│   ├── AdminModule.ts    # Панель администратора
│   ├── AssistantModule.ts# AI-ассистент Сима
│   ├── BillingModule.ts  # Биллинг и подписки
│   ├── DocsModule.ts     # Редактор документов
│   ├── OzonModule.ts     # Интеграция Ozon
│   ├── WbModule.ts       # Интеграция Wildberries
│   ├── YandexModule.ts   # Интеграция Яндекс Маркет
│   ├── RepricerModule.ts # Репрайсер
│   ├── AnalyticsModule.ts# Аналитика
│   ├── SimaStoreModule.ts# Витрина
│   └── ...               # ещё ~30 модулей
├── services/             # Сервисы (API, БД, кэш, синхронизация)
│   ├── ozonApi.ts        # Ozon Seller API
│   ├── wbApi.ts          # Wildberries API
│   ├── yandexApi.ts      # Яндекс Маркет API
│   ├── billingService.ts # Биллинг
│   ├── aiTokenQuota.ts   # Квоты AI-токенов
│   ├── aiPageCapabilities.ts # AI-действия над страницей
│   └── ...
├── styles/               # CSS
│   ├── main.css          # Основные стили
│   ├── assistant.css     # Стили панели Симы
│   └── admin.css         # Стили админки
├── types/                # TypeScript типы
└── App.ts / main.ts      # Точка входа

extension/                # Chrome-расширение (MV3)
├── manifest.json         # v1.4.0
├── background.js         # Service Worker
└── content/              # Content scripts
    ├── ozon-warehouse.js # Автоматизация складов Ozon
    ├── ozon-common.js    # Общий код Ozon
    ├── yandex-warehouse.js
    ├── yandex-tariff.js
    ├── wb-price-main.js
    └── ...

backend/
└── functions/            # Supabase Edge Functions
    ├── telegram-auth/    # Авторизация через Telegram
    ├── yandex-auth/      # Авторизация Яндекс
    ├── tts-edge/         # Синтез речи для Симы
    ├── yookassa-pay/     # Платежи YooKassa
    ├── ozon-price-bridge/# Мониторинг цен Ozon
    ├── wb-price-bridge/  # Мониторинг цен WB
    └── marketplace-webhooks/

migrations/               # SQL-миграции Supabase
```

---

## Установка и запуск

### Требования
- Node.js 18+
- Доступ к Supabase-инстансу (self-hosted или cloud)

### Локальная разработка
```bash
npm install
npm run dev        # http://localhost:3000
```

### Сборка
```bash
npm run build      # результат в dist/
npm test           # Vitest unit-тесты
npx tsc --noEmit   # проверка типов
```

### Деплой на VPS
```bash
bash scripts/deploy.sh
```
Скрипт: rsync кода → Docker build на VPS → перезапуск frontend → SQL-миграции.

---

## Конфигурация

### .env (не коммитить)
```env
VITE_API_URL=https://simadesk.ru
VITE_API_KEY=<supabase-anon-key>
VITE_TG_BOT_USERNAME=<telegram-bot>
VITE_YANDEX_CLIENT_ID=<yandex-oauth-id>
VITE_DEV_AUTH=false
```

### VPS: /opt/simadesk/.env
Содержит все секреты: `POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, `YOOKASSA_*` и др.

---

## Chrome-расширение

Папка: `extension/` (v1.4.0, Manifest V3)

Загрузка в Chrome:
1. `chrome://extensions` → включить режим разработчика
2. «Загрузить распакованное» → выбрать папку `extension/`

Работает с: `seller.ozon.ru`, `partner.market.yandex.ru`, `ozon.ru/product/*`, `wildberries.ru/catalog/*`

---

## Инфраструктура

| Сервис | Описание |
|---|---|
| nginx | SSL-терминация + проксирование |
| frontend | Nginx + Vite SPA |
| rest | PostgREST (Supabase REST API) |
| auth | GoTrue (авторизация) |
| functions | Edge Runtime (Edge Functions) |
| db | PostgreSQL 15 |
| realtime | Supabase Realtime |
| storage | Supabase Storage |

---

**Последнее обновление:** 2026-08-03
