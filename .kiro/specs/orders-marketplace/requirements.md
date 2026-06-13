# Requirements Document

## Introduction

Добавление раздела «Заказы» в существующее веб-приложение STOCKBASE (TypeScript + Vite SPA, Supabase, Ozon API). Раздел предоставляет единую точку входа для управления заказами с маркетплейсов. На первом этапе реализуется поддержка Ozon с тремя схемами доставки: FBO, FBS и RealFBS. Текущий пункт навигации «Ozon» перемещается в иерархию «Заказы → Маркетплейсы → Ozon», сохраняя всю существующую функциональность управления товарами.

## Glossary

- **OrdersModule**: новый модуль приложения, отвечающий за отображение и управление заказами с маркетплейсов.
- **MarketplaceSection**: подраздел «Маркетплейсы» внутри «Заказов», содержащий список подключённых маркетплейсов.
- **OzonOrdersModule**: подмодуль внутри MarketplaceSection, отображающий заказы Ozon с разбивкой по схемам доставки.
- **OzonModule**: существующий модуль управления товарами Ozon (перемещается в иерархию «Заказы → Маркетплейсы → Ozon»).
- **DeliveryScheme**: схема доставки заказа. Допустимые значения: `fbo`, `fbs`, `rfbs`.
- **FBO** (Fulfillment by Ozon): хранение и доставка силами Ozon.
- **FBS** (Fulfillment by Seller): хранение у продавца, доставка Ozon.
- **RealFBS / DBS** (Delivery by Seller): хранение и доставка полностью силами продавца.
- **Posting**: отправление — единица заказа в Ozon API, идентифицируется `posting_number`.
- **OzonStore**: существующая сущность — магазин Ozon с полями `client_id` и `api_key`, хранится в Supabase.
- **App**: существующий класс главного приложения (`src/App.ts`).
- **Sidebar**: боковая панель навигации в `index.html`.
- **ozonApi**: существующий сервис (`src/services/ozonApi.ts`) для обращений к Ozon Seller API через прокси `/ozon-api`.

---

## Requirements

### Requirement 1: Навигация — раздел «Заказы»

**User Story:** Как пользователь приложения, я хочу видеть пункт «Заказы» в боковой навигации, чтобы быстро переходить к управлению заказами с маркетплейсов.

#### Acceptance Criteria

1. THE Sidebar SHALL содержать пункт навигации «Заказы» (`data-section="orders"`) после пункта «Товары» в DOM-дереве боковой панели.
2. WHEN пользователь нажимает на пункт «Заказы», THE App SHALL вызывать `navigateTo('orders')`, отображать секцию `#orders-section` и скрывать все остальные секции (`#home-section`, `#products-section`, `#ozon-section`).
3. WHEN активен раздел OrdersModule, THE Sidebar SHALL добавлять CSS-класс `active` к элементу пункта «Заказы» и удалять его со всех остальных пунктов верхнего уровня.
4. THE Sidebar SHALL содержать группу «Маркетплейсы» (`nav-group`) как дочерний элемент пункта «Заказы»; группа SHALL раскрываться (становиться видимой) при активации раздела «Заказы» и сворачиваться при переходе в другой раздел.
5. WHEN пользователь нажимает на пункт «Ozon» внутри группы «Маркетплейсы», THE App SHALL вызывать `navigateTo('ozon-orders')` и отображать OzonOrdersModule внутри `#orders-section`.

---

### Requirement 2: Перемещение существующего модуля «Ozon»

**User Story:** Как пользователь, я хочу, чтобы существующий раздел управления товарами Ozon был доступен через «Заказы → Маркетплейсы → Ozon», чтобы навигация была логически структурирована.

#### Acceptance Criteria

1. THE App SHALL удалять из DOM Sidebar элемент `<li>` с `data-section="ozon"` верхнего уровня; после изменения в Sidebar не должно существовать ни одного прямого дочернего элемента навигации с `data-section="ozon"`.
2. THE Sidebar SHALL содержать группу «Маркетплейсы» (`nav-group`) как дочерний элемент пункта «Заказы»; внутри группы SHALL присутствовать пункт «Ozon» (`data-section="ozon-orders"`).
3. WHEN пользователь переходит в «Заказы → Маркетплейсы → Ozon», THE App SHALL вызывать `ozonModule.show()` и отображать существующий `#ozon-section` без каких-либо изменений его внутренней разметки.
4. WHEN OzonModule активен, THE Sidebar SHALL добавлять CSS-класс `active` к пункту «Ozon» внутри группы «Маркетплейсы».
5. THE App SHALL сохранять работоспособность методов `OzonModule.show()`, `OzonModule.hide()`, `OzonModule.init()`, `OzonModule.syncStore()` с теми же сигнатурами и поведением, что и до рефакторинга навигации.

---

### Requirement 3: Раздел заказов Ozon — общий вид

**User Story:** Как продавец на Ozon, я хочу видеть все входящие заказы в одном месте с разбивкой по схемам доставки, чтобы эффективно управлять обработкой заказов.

#### Acceptance Criteria

1. THE OzonOrdersModule SHALL отображать три вкладки: «FBO», «FBS», «RealFBS»; при первом открытии модуля активной по умолчанию SHALL быть вкладка «FBS».
2. WHEN пользователь нажимает на вкладку, THE OzonOrdersModule SHALL активировать выбранную вкладку, отображать список отправлений соответствующей схемы доставки и сохранять выбранный магазин (OzonStore) без сброса.
3. THE OzonOrdersModule SHALL отображать список магазинов (OzonStore) в виде переключателя; WHEN пользователь выбирает магазин, THE OzonOrdersModule SHALL загружать заказы только для этого магазина и сохранять выбор при переключении между вкладками FBO/FBS/RealFBS.
4. IF при инициализации OzonOrdersModule список OzonStore пуст, THEN THE OzonOrdersModule SHALL отображать сообщение «Нет подключённых магазинов. Добавьте магазин в разделе Ozon» вместо вкладок и списка заказов.
5. THE OzonOrdersModule SHALL отображать числовой счётчик рядом с каждой вкладкой, отражающий количество загруженных отправлений для выбранного магазина; WHEN данные ещё не загружены, счётчик SHALL отображать «—».
6. WHEN загруженный список отправлений для активной вкладки пуст, THE OzonOrdersModule SHALL отображать сообщение «Заказов нет» вместо пустой таблицы.

---

### Requirement 4: Загрузка заказов FBO

**User Story:** Как продавец, я хочу видеть список FBO-отправлений, чтобы отслеживать заказы, обрабатываемые складом Ozon.

#### Acceptance Criteria

1. WHEN пользователь открывает вкладку «FBO», THE OzonOrdersModule SHALL отправлять POST-запрос к `/v3/posting/fbo/list` с телом `{ "filter": { "since": <90 дней назад ISO 8601>, "to": <текущий момент ISO 8601> }, "limit": 50, "offset": 0 }` для выбранного OzonStore.
2. WHEN ответ `/v3/posting/fbo/list` содержит ровно `limit` записей, THE OzonOrdersModule SHALL отправлять следующий запрос с `offset` увеличенным на `limit`; загрузка SHALL прекращаться, когда количество записей в ответе меньше `limit`.
3. WHEN загрузка завершена, THE OzonOrdersModule SHALL отображать список FBO-отправлений с колонками: `posting_number`, статус, дата создания (`created_at`), дата отгрузки (`in_process_at`), состав заказа (offer_id, название, количество, цена), итоговая сумма заказа.
4. WHEN ответ на запрос к `/v3/posting/fbo/list` содержит HTTP-статус из множества {429, 500, 502, 503}, THE OzonOrdersModule SHALL повторить запрос с задержкой `min(2^(n-1) * 1000, 32000)` мс, где n — номер попытки (1–5); после 5 неудачных попыток повторы SHALL прекращаться.
5. IF все 5 попыток завершились ошибкой, THEN THE OzonOrdersModule SHALL отображать сообщение об ошибке, содержащее HTTP-статус и текст тела ответа API.
6. WHEN вкладка «FBO» открыта, но ни один OzonStore не выбран, THE OzonOrdersModule SHALL отображать подсказку «Выберите магазин» без отправки запросов к API.

---

### Requirement 5: Загрузка заказов FBS

**User Story:** Как продавец, я хочу видеть список FBS-отправлений, чтобы своевременно собирать и передавать заказы курьеру Ozon.

#### Acceptance Criteria

1. WHEN пользователь открывает вкладку «FBS», THE OzonOrdersModule SHALL отправлять POST-запрос к `/v4/posting/fbs/list` с телом `{ "filter": { "since": <90 дней назад ISO 8601>, "to": <текущий момент ISO 8601>, "delivery_schema": ["fbs"] }, "limit": 50, "offset": 0 }` для выбранного OzonStore.
2. WHEN ответ `/v4/posting/fbs/list` содержит ровно `limit` записей, THE OzonOrdersModule SHALL отправлять следующий запрос с `offset` увеличенным на `limit`; загрузка SHALL прекращаться, когда количество записей в ответе меньше `limit`.
3. WHEN загрузка завершена, THE OzonOrdersModule SHALL отображать список FBS-отправлений с колонками: `posting_number`, статус, дата создания (`created_at`), дата отгрузки (`shipment_date`), дедлайн передачи курьеру (`delivering_date`), состав заказа (offer_id, название, количество, цена), склад отгрузки (`warehouse_id`), итоговая сумма заказа.
4. THE OzonOrdersModule SHALL дополнительно запрашивать необработанные FBS-заказы через `/v4/posting/fbs/unfulfilled/list`; WHEN отправление присутствует в ответе этого эндпоинта, THE OzonOrdersModule SHALL отображать рядом с `posting_number` бейдж с текстом «Новый» и жёлтым фоном (`background: #FFC107`).
5. WHEN ответ на запрос к FBS-эндпоинтам содержит HTTP-статус из множества {429, 500, 502, 503}, THE OzonOrdersModule SHALL повторить запрос с задержкой `min(2^(n-1) * 1000, 32000)` мс (n = 1..5); после 5 неудачных попыток повторы SHALL прекращаться.
6. IF все 5 попыток завершились ошибкой, THEN THE OzonOrdersModule SHALL отображать сообщение об ошибке, содержащее HTTP-статус и текст тела ответа API.
7. WHEN вкладка «FBS» открыта, но ни один OzonStore не выбран, THE OzonOrdersModule SHALL отображать подсказку «Выберите магазин» без отправки запросов к API.

---

### Requirement 6: Загрузка заказов RealFBS

**User Story:** Как продавец, работающий по схеме DBS, я хочу видеть список RealFBS-заказов и возвратов, чтобы самостоятельно управлять доставкой и обработкой возвратов.

#### Acceptance Criteria

1. WHEN пользователь открывает вкладку «RealFBS», THE OzonOrdersModule SHALL отправлять POST-запрос к `/v4/posting/fbs/list` с телом `{ "filter": { "since": <90 дней назад ISO 8601>, "to": <текущий момент ISO 8601>, "delivery_schema": ["rfbs"] }, "limit": 50, "offset": 0 }` для выбранного OzonStore.
2. WHEN загрузка завершена, THE OzonOrdersModule SHALL отображать список RealFBS-отправлений с колонками: `posting_number`, статус, дата создания (`created_at`), дата доставки покупателю (`shipment_date`), состав заказа (offer_id, название, количество, цена), адрес доставки (если поле `customer.address` в ответе API является непустой строкой), итоговая сумма заказа.
3. THE OzonOrdersModule SHALL загружать возвраты RealFBS через POST `/v2/returns/rfbs/list` с телом `{ "filter": {}, "limit": 50, "offset": 0 }` и отображать их в подвкладке «Возвраты» внутри вкладки «RealFBS».
4. WHEN пользователь открывает подвкладку «Возвраты», THE OzonOrdersModule SHALL отображать список возвратов с колонками: `id`, статус возврата (`status`), дата создания (`created_at`), состав (offer_id, количество), причина возврата (`reason.name`).
5. WHEN ответ на запрос к RealFBS-эндпоинтам содержит HTTP-статус из множества {429, 500, 502, 503}, THE OzonOrdersModule SHALL повторить запрос с задержкой `min(2^(n-1) * 1000, 32000)` мс (n = 1..5); после 5 неудачных попыток повторы SHALL прекращаться.
6. IF все 5 попыток завершились ошибкой, THEN THE OzonOrdersModule SHALL отображать сообщение об ошибке, содержащее HTTP-статус и текст тела ответа API.
7. WHEN вкладка «RealFBS» открыта, но ни один OzonStore не выбран, THE OzonOrdersModule SHALL отображать подсказку «Выберите магазин» без отправки запросов к API.

---

### Requirement 7: Детальная карточка отправления

**User Story:** Как продавец, я хочу открыть детальную информацию по конкретному отправлению, чтобы видеть полный состав заказа, статусы и сроки.

#### Acceptance Criteria

1. WHEN пользователь нажимает на строку отправления в списке, THE OzonOrdersModule SHALL открывать модальное окно и отображать индикатор загрузки внутри него.
2. WHEN схема доставки отправления равна `fbo`, THE OzonOrdersModule SHALL отправлять POST-запрос к `/v2/posting/fbo/get` с телом `{ "posting_number": "<значение>" }` и отображать полученные данные в модальном окне.
3. WHEN схема доставки отправления равна `fbs` или `rfbs`, THE OzonOrdersModule SHALL отправлять POST-запрос к `/v3/posting/fbs/get` с телом `{ "posting_number": "<значение>" }` и отображать полученные данные в модальном окне.
4. WHEN данные отправления получены успешно, THE OzonOrdersModule SHALL отображать в модальном окне: `posting_number`, схему доставки, статус, временны́е метки (`created_at`, `in_process_at`, `shipment_date`, `delivering_date` — каждая скрывается если равна `null`), полный состав заказа (offer_id, название, количество, цена за единицу, итого по позиции), регион/город покупателя (скрывается если отсутствует), склад, трекинг-номер (скрывается если отсутствует).
5. IF запрос к API завершился ошибкой, THEN THE OzonOrdersModule SHALL скрывать индикатор загрузки и отображать сообщение об ошибке внутри модального окна, не закрывая его.
6. IF детали отправления с данным `posting_number` уже были успешно загружены в текущей сессии (от загрузки страницы до её перезагрузки или закрытия вкладки), THEN THE OzonOrdersModule SHALL использовать кешированные данные без повторного запроса к API.

---

### Requirement 8: Фильтрация и поиск заказов

**User Story:** Как продавец, я хочу фильтровать и искать заказы по статусу, дате и номеру отправления, чтобы быстро находить нужные заказы.

#### Acceptance Criteria

1. THE OzonOrdersModule SHALL отображать выпадающий список фильтра по статусу; допустимые значения для FBO: `awaiting_packaging`, `awaiting_deliver`, `delivering`, `delivered`, `cancelled`; для FBS: `awaiting_packaging`, `awaiting_deliver`, `delivering`, `delivered`, `cancelled`, `arbitration`; для RealFBS: `awaiting_packaging`, `awaiting_deliver`, `delivering`, `delivered`, `cancelled`.
2. THE OzonOrdersModule SHALL отображать два поля ввода дат («С» и «По») для фильтрации по полю `created_at` отправлений; оба поля SHALL принимать значения в формате `YYYY-MM-DD`.
3. THE OzonOrdersModule SHALL отображать текстовое поле поиска; WHEN пользователь вводит текст, THE OzonOrdersModule SHALL фильтровать отображаемые отправления, оставляя только те, у которых `posting_number` содержит введённую строку (без учёта регистра) ИЛИ хотя бы один `offer_id` в составе заказа содержит введённую строку.
4. WHEN пользователь изменяет значение любого фильтра или поля поиска, THE OzonOrdersModule SHALL немедленно применять все активные фильтры к уже загруженным данным без отправки новых запросов к API.
5. THE OzonOrdersModule SHALL отображать кнопку «Сбросить фильтры»; кнопка SHALL быть активной (не disabled) тогда и только тогда, когда хотя бы одно из полей фильтра статуса, дат или поиска содержит непустое значение.
6. WHEN пользователь нажимает «Сбросить фильтры», THE OzonOrdersModule SHALL очищать поля фильтра статуса, обоих полей дат и поля поиска, после чего отображать полный список загруженных отправлений.
7. WHEN применённые фильтры не соответствуют ни одному отправлению, THE OzonOrdersModule SHALL отображать сообщение «Нет заказов, соответствующих фильтрам» вместо пустой таблицы.

---

### Requirement 9: Обновление данных

**User Story:** Как продавец, я хочу обновлять список заказов вручную, чтобы видеть актуальные данные без перезагрузки страницы.

#### Acceptance Criteria

1. THE OzonOrdersModule SHALL отображать кнопку «Обновить» на панели инструментов каждой вкладки (FBO, FBS, RealFBS).
2. WHEN пользователь нажимает «Обновить», THE OzonOrdersModule SHALL повторно загружать данные с API для активной вкладки и выбранного магазина, заменяя ранее загруженные данные новыми.
3. WHILE идёт загрузка данных, THE OzonOrdersModule SHALL отображать спиннер-индикатор загрузки и устанавливать атрибут `disabled` на кнопке «Обновить».
4. WHEN загрузка завершена успешно, THE OzonOrdersModule SHALL отображать метку «Обновлено: ДД.ММ ЧЧ:ММ» рядом с кнопкой «Обновить».
5. WHILE идёт загрузка данных, THE OzonOrdersModule SHALL отображать кнопку «Стоп».
6. WHEN пользователь нажимает «Стоп», THE OzonOrdersModule SHALL прерывать все незавершённые запросы к API для текущей загрузки, отображать уже полученные отправления и скрывать кнопку «Стоп»; метка времени последнего обновления SHALL оставаться без изменений.
7. IF загрузка завершилась ошибкой (после всех retry-попыток), THEN THE OzonOrdersModule SHALL отображать сообщение об ошибке, снимать `disabled` с кнопки «Обновить» и скрывать кнопку «Стоп».

---

### Requirement 10: Использование существующих учётных данных Ozon

**User Story:** Как пользователь, я хочу, чтобы раздел «Заказы» использовал уже настроенные магазины Ozon, чтобы не вводить ключи API повторно.

#### Acceptance Criteria

1. WHEN OzonOrdersModule инициализируется, THE OzonOrdersModule SHALL вызывать `ozonDb.getStores()` для получения актуального списка OzonStore.
2. THE OzonOrdersModule SHALL использовать поля `client_id` и `api_key` из OzonStore в качестве заголовков `Client-Id` и `Api-Key` для всех запросов к Ozon Seller API.
3. THE OzonOrdersModule SHALL направлять все запросы к Ozon Seller API через прокси `/ozon-api`, используя тот же механизм, что и существующий `ozonApi`-сервис.
4. WHEN пользователь открывает раздел «Заказы», THE OzonOrdersModule SHALL вызывать `ozonDb.getStores()` заново, чтобы отразить магазины, добавленные или удалённые в OzonModule с момента последнего открытия.
5. IF вызов `ozonDb.getStores()` завершается ошибкой, THEN THE OzonOrdersModule SHALL отображать сообщение «Не удалось загрузить список магазинов» и кнопку «Повторить», при нажатии на которую SHALL повторно вызывать `ozonDb.getStores()`.

---

### Requirement 11: Типы данных и сериализация

**User Story:** Как разработчик, я хочу иметь строго типизированные интерфейсы для заказов Ozon, чтобы обеспечить корректность данных и упростить поддержку кода.

#### Acceptance Criteria

1. THE App SHALL определять TypeScript-интерфейс `OzonPosting` с обязательными полями: `posting_number: string`, `status: OzonPostingStatus`, `delivery_scheme: DeliveryScheme`, `created_at: string`, `shipment_date: string | null`, `products: OzonPostingProduct[]`, `store_id: string`.
2. THE App SHALL определять TypeScript-интерфейс `OzonPostingProduct` с обязательными полями: `offer_id: string`, `name: string`, `quantity: number`, `price: string`, `currency_code: string`.
3. THE App SHALL определять TypeScript-тип `DeliveryScheme` как `'fbo' | 'fbs' | 'rfbs'`.
4. THE App SHALL определять TypeScript-тип `OzonPostingStatus` как объединение строковых литералов: `'awaiting_packaging' | 'awaiting_deliver' | 'delivering' | 'delivered' | 'cancelled' | 'arbitration' | 'not_accepted' | 'sent_by_seller'`.
5. WHEN объект типа `OzonPosting` сериализуется через `JSON.stringify` и десериализуется через `JSON.parse`, THE App SHALL получать объект, у которого значения всех полей, перечисленных в критерии 1, строго равны (`===`) значениям исходного объекта.
6. THE App SHALL определять TypeScript-интерфейс `OzonReturn` с обязательными полями: `id: number`, `status: string`, `posting_number: string`, `created_at: string`, `products: OzonPostingProduct[]`.
