# STOCKBASE 2.0 — Product Manager

**Современная архитектура с виртуализацией и ленивой загрузкой для максимальной производительности**

## 🚀 Что изменилось

### Производительность
- **Виртуализация таблицы** - рендер только видимых строк (60fps даже при 10k+ товаров)
- **Ленивая загрузка** - подгрузка товаров при скролле (streaming по 1000 записей)
- **Пагинация API** - параллельные запросы вместо загрузки всего сразу
- **IndexedDB кэш** - stale-while-revalidate с TTL 20 минут
- **Preload при hover** - наведение на группу начинает фоновую загрузку данных

### Архитектура
- **TypeScript** - полная типизация для надёжности
- **Модульная структура** - сервисы, стор, утилиты, типы
- **State Management** - реактивное хранилище с Observer-паттерном
- **Vite** - современная сборка, hot reload, code splitting

### Безопасность
- **Environment Variables** - ключи Supabase вынесены в `.env` файл
- **XSS-защита** - все пользовательские данные проходят через `esc()` при рендере
- **Type Safety** - защита от ошибок на уровне типов

## 📁 Структура проекта

```
src/
├── modules/              # Крупные функциональные модули
│   └── OzonModule.ts    # Интеграция с Ozon Seller API
├── services/             # API сервисы
│   ├── api.ts           # Supabase REST API
│   ├── supabaseClient.ts# HTTP клиент Supabase
│   ├── idbCache.ts      # IndexedDB кэш
│   ├── ozonApi.ts       # Ozon Seller API
│   └── ozonDb.ts        # Ozon таблицы в Supabase
├── stores/               # State management
│   └── appStore.ts      # Реактивное хранилище (Observer)
├── styles/               # Стили
│   ├── main.css         # Основные CSS стили
│   └── ozon.css         # Стили Ozon-модуля
├── types/                # TypeScript типы
│   ├── index.ts         # Основные типы (Box, Product, Sheet)
│   ├── ozon.ts          # Типы Ozon API
│   └── vite-env.d.ts    # Env переменные
├── utils/                # Утилиты
│   ├── format.ts        # XSS-escape, форматирование, парсинг
│   ├── columnMapper.ts  # Маппинг Ozon ↔ локальных столбцов
│   ├── ozonAttributeNames.ts # Словарь атрибутов Ozon
│   └── debug.ts         # Debug-утилиты
├── tests/                # Модульные тесты (Vitest)
├── App.ts                # Главный класс приложения
└── main.ts              # Точка входа
```

Дополнительно:
```
migrations/               # SQL-миграции для Supabase
├── .env                  # Переменные окружения (НЕ коммитить)
├── index.html            # HTML шаблон
├── package.json          # Зависимости
├── tsconfig.json         # TypeScript конфиг
├── vite.config.ts        # Vite конфиг
└── README.md             # Этот файл
```

## 🛠️ Установка и запуск

### Требования
- Node.js 18+
- npm

### Установка зависимостей
```bash
npm install
```

### Запуск разработки
```bash
npm run dev
```
Приложение откроется на http://localhost:3000

### Сборка для production
```bash
npm run build
```
Результат в папке `dist/`

### Тесты
```bash
npm test
```

## ⚡ Ключевые оптимизации

### Виртуализация таблицы
- Рендерятся только видимые строки (метод `vtPaint` в App.ts)
- Overscan-буфер из 15 строк для плавного скролла
- Spacer-строки для сохранения правильной высоты скролла

### Streaming загрузка
- Первые 1000 товаров загружаются мгновенно
- Остальные — параллельными запросами
- Race condition protection через `loadToken`

### API оптимизации
- Параллельная пагинация на сервере (`supaFetchAll`)
- Memory cache + IndexedDB cache (stale-while-revalidate)
- Debounce поиска (280ms)

## 🎯 Использование

### Базовые операции
1. **Создание группы** - кнопка «Новая группа»
2. **Импорт товаров** - drag & drop xlsx файла (Ozon-шаблон или системный формат)
3. **Просмотр** - таблица (с виртуализацией) или карточки
4. **Поиск** - глобальный поиск по всем полям с подсветкой
5. **Фильтры** - цена, сортировка, динамические фильтры по категориям

### Ozon-интеграция
- Добавление магазинов через Client-ID и API-Key
- Синхронизация товаров, цен, статусов, остатков (FBS/FBO)
- Мультимагазин — объединение товаров по артикулу
- Массовые операции: показ/скрытие, архивирование

## 🔧 Конфигурация

### Environment Variables
```env
VITE_SUPA_URL=https://your-project.supabase.co
VITE_SUPA_KEY=your-anon-key
```

### TypeScript конфиг
- Строгая типизация
- Path aliases (`@/` → `src/`)
- ES2020+ features

## 📊 Производительность

| Метрика | Целевое значение |
|---|---|
| First Load | < 2с |
| Переключение группы | < 500мс (из кэша — мгновенно) |
| Поиск | Debounce 280мс + фильтрация в памяти |
| Скролл таблицы | 60fps (виртуализация) |

## 🚨 Важно

### Безопасность
- **Настройте RLS** (Row Level Security) в Supabase
- Используйте service role ключи только на бэкенде
- Валидируйте все входные данные

### Масштабирование
- При >50k товаров рассмотрите server-side поиск
- Для сложной фильтрации используйте индексы в БД

## 🐛 Отладка

### Инструменты
- **Browser DevTools** — Network, Performance, Application (IndexedDB)
- **Vite HMR** — мгновенное обновление при изменении кода
- **Lighthouse** — аудит производительности

## 📈 Roadmap

### v2.1
- [ ] Service Worker для offline режима
- [ ] PWA функционал
- [ ] URL routing (deep links на группы и товары)
- [ ] Декомпозиция App.ts на отдельные модули

### v2.2
- [ ] Real-time обновления (Supabase Realtime)
- [ ] Многопользовательский режим (Supabase Auth)
- [ ] Аудит логи и история изменений

### v3.0
- [ ] Интеграция с Wildberries, Яндекс.Маркет
- [ ] Мобильное приложение

---

**Версия:** 2.0.0  
**Стек:** TypeScript + Vite + Vanilla DOM + Supabase REST API  
**Последнее обновление:** 2026-05-10  
**Лицензия:** MIT
