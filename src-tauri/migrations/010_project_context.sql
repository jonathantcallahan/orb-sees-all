-- A project's context as separate entries the user can edit, delete and add to: their own entries,
-- and the ones Demian wrote that they removed (so refreshes don't say them again).
ALTER TABLE project_focus ADD COLUMN context TEXT NOT NULL DEFAULT '[]';
ALTER TABLE project_focus ADD COLUMN removed TEXT NOT NULL DEFAULT '[]';

-- What the user had written as the focus and "not part of it" becomes their first entries.
UPDATE project_focus SET context = (
  SELECT json_group_array(t) FROM (
    SELECT focus AS t WHERE focus IS NOT NULL AND trim(focus) != ''
    UNION ALL
    SELECT 'Not part of it: ' || out_of_scope WHERE out_of_scope IS NOT NULL AND trim(out_of_scope) != ''
  )
);
