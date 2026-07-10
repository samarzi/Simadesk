# Migrations — порядок запуска

Заходи в **Supabase Dashboard → SQL Editor → New query**, вставляй и жми **Run**.

## Порядок запуска (если ещё не запускал)

### 1. Основная миграция (таблицы + старые RLS)
```
Файл: multiuser.sql
```
Создаёт: `users`, `companies`, `company_members`, `company_invitations`,
добавляет `company_id` в `boxes`/`sheets`, включает RLS.

### 2. ОБЯЗАТЕЛЬНО — исправление рекурсии RLS  
```
Файл: rls_fix.sql
```
⚠️ Без этого будет ошибка **"infinite recursion detected in policy"**.
Пересоздаёт все политики через `SECURITY DEFINER` функцию — убирает рекурсию.

### 3. Юридическое название компании (если таблица уже создана)
```
Файл: companies_legal_name.sql
```
Добавляет колонку `legal_name` в `companies`.

### 4. display_name для пользователя (если users уже создана)
```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT DEFAULT NULL;
```

---

## Если начинаешь с нуля (таблиц ещё нет)

Запусти только **`multiuser.sql`** (он уже содержит `legal_name`),
затем **`rls_fix.sql`**.

---

## Проверка что всё работает

```sql
-- Должна вернуть пустой массив (не ошибку)
SELECT * FROM companies LIMIT 1;
SELECT * FROM company_members LIMIT 1;
SELECT user_company_ids();
```
