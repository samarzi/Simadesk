-- Политика INSERT для администраторов платформы
CREATE POLICY notif_insert_admin ON user_notifications
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM platform_admins WHERE user_id = auth.uid()
    )
  );
