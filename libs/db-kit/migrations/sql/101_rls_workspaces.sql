ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspaces_isolation ON workspaces;
CREATE POLICY workspaces_isolation ON workspaces
  FOR ALL
  TO app_user
  USING      (id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
