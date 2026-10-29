-- Tasks have a status instead of a done checkbox, and can be planned for a day.
ALTER TABLE task_state ADD COLUMN status TEXT;
ALTER TABLE task_state ADD COLUMN today_on TEXT;
UPDATE task_state SET status = CASE WHEN done = 1 THEN 'done' ELSE 'todo' END;
