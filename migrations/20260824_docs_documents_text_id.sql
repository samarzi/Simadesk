-- Идентификатор документа: UUID → TEXT.
--
-- Редактор генерирует id вида «d_mt6fwcjgy1ev» (DocsModule.newId), а колонка
-- была UUID. Postgres отклонял такой ключ, поэтому КАЖДЫЙ upsert и delete
-- документа возвращал 400 — синхронизация с сервером не работала ни разу,
-- и localStorage оставался единственным местом, где жили документы.
--
-- Переводим колонку в TEXT: это принимает и уже существующие идентификаторы
-- редактора, и обычные UUID, поэтому миграция данных не требуется.

ALTER TABLE docs_documents ALTER COLUMN id DROP DEFAULT;
ALTER TABLE docs_documents ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE docs_documents ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
