-- Add FK from company_members.user_id → public.users.id
-- PostgREST resolves the users(...) join only via FK relationships
-- in the public schema. Without this, getMembers() query fails with PGRST200.
-- (The existing FK to auth.users is invisible to PostgREST.)

ALTER TABLE company_members
  ADD CONSTRAINT IF NOT EXISTS company_members_user_id_fk_public
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
