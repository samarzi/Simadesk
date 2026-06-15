-- marketModelId нужен для прямой ссылки на карточку товара на Маркете:
-- https://market.yandex.ru/product/{marketModelId}?sku={marketSku}
alter table yandex_products add column if not exists market_model_id bigint;
