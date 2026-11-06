-- +goose Up
ALTER TABLE approval_requests ADD COLUMN scoring_standard_version TEXT;
ALTER TABLE approval_request_approvers
    ADD COLUMN scenario_value SMALLINT CHECK (scenario_value BETWEEN 1 AND 5),
    ADD COLUMN result_effectiveness SMALLINT CHECK (result_effectiveness BETWEEN 1 AND 5),
    ADD COLUMN ease_of_use SMALLINT CHECK (ease_of_use BETWEEN 1 AND 5),
    ADD COLUMN reuse_value SMALLINT CHECK (reuse_value BETWEEN 1 AND 5);

-- +goose Down
ALTER TABLE approval_request_approvers
    DROP COLUMN reuse_value,
    DROP COLUMN ease_of_use,
    DROP COLUMN result_effectiveness,
    DROP COLUMN scenario_value;
ALTER TABLE approval_requests DROP COLUMN scoring_standard_version;
