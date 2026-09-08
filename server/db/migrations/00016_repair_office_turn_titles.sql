-- +goose Up
UPDATE office_agent_turns
SET title = LEFT(user_prompt, 160)
WHERE user_prompt <> ''
  AND RIGHT(title, 1) = CHR(65533)
  AND RTRIM(title, CHR(65533)) <> ''
  AND STARTS_WITH(user_prompt, RTRIM(title, CHR(65533)));

-- +goose Down
SELECT 1;
