ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invitations_isolation ON invitations;
CREATE POLICY invitations_isolation ON invitations
  FOR ALL
  TO app_user
  USING      (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
