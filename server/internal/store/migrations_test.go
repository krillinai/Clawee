package store_test

import (
	"os"
	"strings"
	"testing"
)

func TestInitialMigrationDoesNotCreateBusinessSystemTables(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00001_init.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))

	if strings.Contains(migration, "customer_profiles") {
		t.Fatal("customer_profiles belongs to Demo CRM and must not be created in this project")
	}
}

func TestDingTalkIdentityLoginMigration(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00039_dingtalk_identity_login.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))
	for _, want := range []string{
		"create table if not exists account_identities",
		"primary key (provider_type, provider_key, provider_subject)",
		"unique (user_id, provider_type, provider_key)",
		"create table if not exists oauth_login_states",
		"intent in ('login', 'bind_current_user')",
		"drop table if exists oauth_login_states",
		"drop table if exists account_identities",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestClaweeDingTalkPKCELoginMigration(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00041_clawee_dingtalk_pkce_login.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))
	for _, want := range []string{
		"add column if not exists agent_id text",
		"add column if not exists pkce_challenge text",
		"intent in ('login', 'bind_current_user', 'login_clawee')",
		"create table if not exists oauth_authorization_codes",
		"code_hash text primary key",
		"references accounts(user_id) on delete cascade",
		"create index if not exists idx_oauth_authorization_codes_expires_at",
		"drop table if exists oauth_authorization_codes",
		"intent in ('login', 'bind_current_user')",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestSharedFilesMigrationCreatesOnlySpaceAndFileMetadata(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00029_shared_files.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))
	for _, want := range []string{
		"create table if not exists shared_spaces",
		"create unique index if not exists idx_shared_spaces_name_unique",
		"on shared_spaces (lower(name))",
		"create table if not exists shared_files",
		"unique (space_id, logical_path)",
		"storage_key text not null unique",
		"revision bigint not null check (revision >= 1)",
		"drop table if exists shared_files",
		"drop table if exists shared_spaces",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
	if strings.Contains(migration, "create table if not exists shared_file_versions") {
		t.Fatal("migration must not create file history")
	}
}

func TestSharedFileAdminActorMigrationAllowsMissingAgent(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00030_shared_file_admin_actor.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))
	for _, want := range []string{
		"alter column created_by_agent_id drop not null",
		"alter column updated_by_agent_id drop not null",
		"alter column created_by_agent_id set not null",
		"alter column updated_by_agent_id set not null",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestMCPLogicalEndpointMigrationAddsAuditContext(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00031_mcp_logical_endpoints.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))
	for _, want := range []string{
		"alter table mcp_list_audit_records",
		"alter table mcp_proxy_audit_records",
		"alter table mcp_gate_requests",
		"endpoint_type text not null default 'aggregate'",
		"endpoint_upstream_server_id text not null default ''",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestLegacyActionGatewayDropMigrationRemovesOldAuditTables(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00007_drop_legacy_action_gateway.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))

	for _, want := range []string{
		"drop table if exists audit_events",
		"drop table if exists agent_action_runs",
		"create table if not exists agent_action_runs",
		"create index if not exists idx_agent_action_runs_completed_at",
		"create table if not exists audit_events",
		"create index if not exists idx_audit_events_created_at",
		"create index if not exists idx_audit_events_audit_id",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestMCPGatewayProxyMigrationCreatesGovernanceTables(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00002_mcp_gateway_proxy.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))

	for _, want := range []string{
		"create table if not exists mcp_upstream_servers",
		"create table if not exists mcp_agents",
		"create table if not exists mcp_agent_tokens",
		"create table if not exists mcp_capabilities",
		"create table if not exists mcp_upstream_sync_logs",
		"create table if not exists mcp_agent_grants",
		"create table if not exists mcp_list_audit_records",
		"create table if not exists mcp_proxy_audit_records",
		"request_body jsonb",
		"response_body jsonb",
		"token_hash text",
		"fingerprint text",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}

	for _, forbidden := range []string{"crm_customers", "erp_orders", "oa_approvals"} {
		if strings.Contains(migration, forbidden) {
			t.Fatalf("migration must not create business system table %q", forbidden)
		}
	}
}

func TestMCPAccountGrantTargetUniqueMigration(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00032_mcp_agent_grant_target_unique.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))
	for _, want := range []string{
		"create unique index if not exists uq_mcp_agent_grants_target",
		"on mcp_agent_grants (agent_id, capability_id, grant_type)",
		"drop index if exists uq_mcp_agent_grants_target",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestAccountKnowledgeMCPAccessMigration(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00033_account_knowledge_mcp_access.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))
	for _, want := range []string{
		"update data_resource_grants",
		"set action = 'mcp'",
		"action = 'search'",
		"update mcp_agent_grants as agent_grant",
		"set data_scope = null",
		"capability.upstream_server_id = 'knowledge-adapter'",
		"capability.upstream_name = 'search'",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestMCPUserConfirmationGateMigrationCreatesGateRequests(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00004_mcp_user_confirmation_gates.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))

	for _, want := range []string{
		"create table if not exists mcp_gate_requests",
		"confirm_required boolean not null default false",
		"confirm_template text not null default ''",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestMigrationsAccountsCreatesAccountTablesAndAgentTokenCiphertext(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00005_accounts_and_agent_token_ciphertext.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))

	expectedFragments := []string{
		"create table if not exists accounts",
		"role text not null",
		"idx_accounts_role_status",
		"create table if not exists account_sessions",
		"create table if not exists account_agents",
		"create table if not exists account_bootstrap_locks",
		"token_ciphertext bytea",
	}

	for _, want := range expectedFragments {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestP8MigrationConvertsMCPAuthorizationToAccountOwnership(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00047_mcp_account_authorization.sql")
	if err != nil {
		t.Fatal(err)
	}
	migration := strings.ToLower(string(raw))
	for _, want := range []string{
		"mcp token agent has no account owner",
		"mcp grant agent has no account owner",
		"account has conflicting mcp grants",
		"set status = 'expired'",
		"octet_length(token_ciphertext) > 0",
		"partition by user_id",
		"rename to mcp_account_tokens",
		"on mcp_account_tokens (user_id)",
		"where status = 'active'",
		"rename to mcp_account_grants",
		"on mcp_account_grants (user_id, capability_id, grant_type)",
		"p8 migration is irreversible",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestP11OwnershipMigrationAddsRequiredConstraintsAndSnapshots(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00017_account_agent_collector_ownership.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))
	for _, want := range []string{
		"-- +goose statementbegin\ndo $$",
		"end $$;\n-- +goose statementend",
		"having count(distinct user_id) > 1",
		"having count(*) > 1",
		"create unique index if not exists uq_account_agents_agent_id",
		"add column if not exists user_id text references accounts(user_id)",
		"create unique index if not exists uq_office_collector_tokens_token_hash",
		"set revoked_at = coalesce(revoked_at, now())",
		"add column if not exists user_id text not null default ''",
		"alter table mcp_gate_requests\n    add column if not exists user_id text not null default ''",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestAgentGovernanceLinkMigrationAddsOptionalOneToOneRelation(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00018_office_agent_mcp_link.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))
	for _, want := range []string{
		"add column if not exists mcp_agent_id text",
		"references mcp_agents(agent_id)",
		"on delete set null",
		"create unique index if not exists uq_office_agents_mcp_agent_id",
		"where mcp_agent_id is not null",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
	if strings.Contains(migration, "create table") {
		t.Fatal("agent governance link migration must not create another agent or binding table")
	}
}

func TestRBACMigrationCreatesOnlyDesignedTablesAndMigratesAdmins(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00019_rbac.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))
	for _, want := range []string{
		"create table if not exists rbac_roles",
		"create table if not exists account_roles",
		"create table if not exists role_permissions",
		"create table if not exists rbac_operation_audits",
		"values ('role_admin', 'admin', '系统管理员', true",
		"select user_id, 'role_admin'",
		"where role = 'admin'",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
	for _, forbidden := range []string{
		"create table if not exists rbac_permissions",
		"resource_grants",
		"permission_scope",
		"role_inheritance",
	} {
		if strings.Contains(migration, forbidden) {
			t.Fatalf("migration contains out-of-scope model %q", forbidden)
		}
	}
}

func TestDropLegacyAccountRoleMigrationRemovesLegacyColumnAfterRBACBackfill(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00020_drop_legacy_account_role.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))

	for _, want := range []string{
		"drop index if exists idx_accounts_role_status",
		"create index if not exists idx_accounts_status",
		"drop column if exists role",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestClaweeAgentSessionBindingMigrationAddsOwnershipConstraint(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00021_clawee_agent_session_binding.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))

	for _, want := range []string{
		"add column if not exists agent_id text",
		"foreign key (user_id, agent_id)",
		"references account_agents (user_id, agent_id)",
		"on delete cascade",
		"create index if not exists idx_account_sessions_agent_owner",
		"where agent_id is not null",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestAgentCreationSourceMigrationAddsAndBackfillsSource(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00028_agent_creation_source.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))

	for _, want := range []string{
		"add column if not exists creation_source",
		"t.issuer = 'claw-collector'",
		"set creation_source = 'clawee_login'",
		"drop column if exists creation_source",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestCollectorAgentDefaultNameMigrationNormalizesLegacyDefaults(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00034_collector_agent_default_name.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))

	for _, want := range []string{
		"a.creation_source = 'collector'",
		"'codex local'",
		"'codex windows'",
		"join accounts owner",
		"owner.user_id) || '的codex'",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestMCPUpstreamServerSoftDeleteMigrationAddsDeletedAt(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00006_mcp_upstream_server_soft_delete.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))

	for _, want := range []string{
		"alter table mcp_upstream_servers",
		"add column if not exists deleted_at timestamptz",
		"idx_mcp_upstream_servers_deleted_at",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestMCPUpstreamServerEnvironmentRemovalMigrationDropsColumn(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00013_drop_mcp_upstream_server_environment.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))

	for _, want := range []string{
		"alter table mcp_upstream_servers",
		"drop column if exists environment",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestMCPUpstreamServerTokenMigrationAddsCiphertext(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00014_mcp_upstream_server_token.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))
	for _, want := range []string{
		"alter table mcp_upstream_servers",
		"add column if not exists token_ciphertext bytea",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestMCPUpstreamServerRoutingDescriptionMigrationAddsColumn(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00036_mcp_upstream_server_routing_description.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))
	for _, want := range []string{
		"alter table mcp_upstream_servers",
		"add column if not exists routing_description text not null default ''",
		"drop column if exists routing_description",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestMCPUpstreamServerCollectorPullMigrationAddsColumn(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00037_mcp_upstream_server_collector_pull.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))
	for _, want := range []string{
		"alter table mcp_upstream_servers",
		"add column if not exists collector_id text not null default ''",
		"drop column if exists collector_id",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestBusinessDataCollectionMigrationContract(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00040_business_data_collection.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))
	for _, want := range []string{
		"create table if not exists business_data_sources",
		"create table if not exists business_sync_runs",
		"create table if not exists business_contents",
		"create table if not exists business_content_daily_metrics",
		"create table if not exists business_account_daily_metrics",
		"create table if not exists business_campaigns",
		"create table if not exists business_campaign_daily_metrics",
		"unique (provider, external_account_id)",
		"where status in ('queued', 'running')",
		"foreign key (source_id, external_content_id)",
		"foreign key (source_id, external_campaign_id)",
		"drop table if exists business_data_sources",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestBilibiliBusinessDataMigrationContract(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00044_bilibili_business_data.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))
	for _, want := range []string{
		"'bilibili'", "create table business_data_source_credentials", "access_token_ciphertext bytea not null",
		"create table business_data_oauth_states", "state_hash bytea primary key", "create table bilibili_account_metric_snapshots",
		"primary key (source_id, snapshot_date)", "create table bilibili_content_metric_snapshots",
		"primary key (source_id, external_content_id, snapshot_date)", "foreign key (source_id, external_content_id)",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestOfficeCollectorStateMigrationCreatesOnlyPrefixedCollectorStateTables(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00008_office_collector_state.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))

	for _, want := range []string{
		"create table if not exists office_collector_tokens",
		"create table if not exists office_collector_devices",
		"create table if not exists office_agents",
		"create table if not exists office_agent_sessions",
		"create table if not exists office_agent_turns",
		"create table if not exists office_agent_sub_agents",
		"create table if not exists office_agent_activities",
		"create table if not exists office_agent_source_events",
		"source_event_id text not null",
		"standard_event_type text not null",
		"current_turn_id text not null default ''",
		"parent_turn_id text not null default ''",
		"spawn_tool_call_id text not null default ''",
		"tool_call_id text not null default ''",
		"create index if not exists idx_office_agent_source_events_scope",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}

	for _, forbidden := range []string{
		"create table if not exists collector_tokens",
		"create table if not exists collector_devices",
		"create table if not exists agents",
		"create table if not exists agent_sessions",
		"create table if not exists agent_turns",
		"create table if not exists agent_sub_agents",
		"create table if not exists agent_activities",
		"create table if not exists agent_source_events",
		"create table if not exists customers",
		"create table if not exists orders",
		"create table if not exists crm_accounts",
		"create table if not exists erp_records",
	} {
		if strings.Contains(migration, forbidden) {
			t.Fatalf("migration must not create %q", forbidden)
		}
	}
}

func TestOfficeCollectorRegistrationMigrationCreatesOnlyPrefixedRegistrationTables(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00009_office_collector_registration.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))

	for _, want := range []string{
		"create table if not exists office_collector_registration_codes",
		"create table if not exists office_collector_registrations",
		"registration_code text not null default ''",
		"create index if not exists idx_office_collector_registrations_collector_id",
		"create index if not exists idx_office_collector_registration_codes_expires_at",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}

	for _, forbidden := range []string{
		"create table if not exists collector_registration_codes",
		"create table if not exists collector_registrations",
		"create table if not exists customers",
		"create table if not exists orders",
		"create table if not exists crm_accounts",
		"create table if not exists erp_records",
	} {
		if strings.Contains(migration, forbidden) {
			t.Fatalf("migration must not create %q", forbidden)
		}
	}
}

func TestOfficeAgentStandardModelMigrationCreatesOnlyPrefixedStandardModelTables(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00010_office_agent_standard_model.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))

	for _, want := range []string{
		"create table if not exists office_agent_tool_calls",
		"source_event_start_id text not null default ''",
		"source_event_end_id text not null default ''",
		"create index if not exists idx_office_agent_tool_calls_turn",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}

	for _, forbidden := range []string{
		"create table if not exists agent_tool_calls",
		"create table if not exists customers",
		"create table if not exists orders",
		"create table if not exists crm_accounts",
		"create table if not exists erp_records",
	} {
		if strings.Contains(migration, forbidden) {
			t.Fatalf("migration must not create %q", forbidden)
		}
	}
}

func TestKnowledgeBaseMigrationCreatesMappingsAndResolvedAuditScope(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00012_enterprise_knowledge_base.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))

	for _, want := range []string{
		"create table if not exists knowledge_bases",
		"create table if not exists knowledge_documents",
		"external_knowledge_base_id",
		"external_document_id",
		"resolved_data_scope jsonb",
		"where deleted_at is null",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestSkillHubMigrationCreatesImmutableVersionsAndCurrentVersionConstraint(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00015_skillhub.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))

	for _, want := range []string{
		"create table if not exists skills",
		"create table if not exists skill_versions",
		"unique (skill_id, version)",
		"unique (skill_id, version_id)",
		"foreign key (skill_id, current_version_id)",
		"references skill_versions (skill_id, version_id)",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestOfficeTurnTitleUTF8RepairMigrationIsScopedToRecoverableTitles(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00016_repair_office_turn_titles.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))

	for _, want := range []string{
		"update office_agent_turns",
		"left(user_prompt, 160)",
		"right(title, 1) = chr(65533)",
		"starts_with(user_prompt, rtrim(title, chr(65533)))",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestRemoveSalesCRMIndustryPermissionMigrationDeletesOnlyRetiredPermission(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00022_drop_sales_crm_industry_permission.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))
	for _, want := range []string{
		"delete from role_permissions",
		"where permission_code = 'console:industry:read'",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
	for _, forbidden := range []string{"delete from rbac_roles", "rbac_operation_audits", "truncate"} {
		if strings.Contains(migration, forbidden) {
			t.Fatalf("migration must not contain %q", forbidden)
		}
	}
}

func TestCreatedByNameSnapshotMigration(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00023_created_by_name_snapshot.sql")
	if err != nil {
		t.Fatal(err)
	}
	migration := strings.ToLower(string(raw))
	for _, want := range []string{
		"-- +goose statementbegin",
		"-- +goose statementend",
		"having count(*) > 1",
		"create unique index uq_accounts_name_ci",
		"lower(btrim(name))",
		"where btrim(name) <> ''",
		"update skills",
		"update knowledge_bases",
		"update mcp_agent_grants",
		"update office_collector_registration_codes",
		"coalesce(nullif(btrim(account.name), ''), nullif(btrim(account.email), ''), account.user_id)",
		"drop index if exists uq_accounts_name_ci",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestAllowDuplicateAccountNamesMigration(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00043_allow_duplicate_account_names.sql")
	if err != nil {
		t.Fatal(err)
	}
	migration := strings.ToLower(string(raw))
	for _, want := range []string{
		"-- +goose up",
		"drop index if exists uq_accounts_name_ci",
		"-- +goose down",
		"create unique index uq_accounts_name_ci",
		"lower(btrim(name))",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
}

func TestCollectorAgentIdentityMigration(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00045_collector_agent_identity.sql")
	if err != nil {
		t.Fatal(err)
	}
	migration := strings.ToLower(string(raw))
	for _, want := range []string{
		"-- +goose up",
		"add column if not exists agent_id text",
		"create unique index if not exists uq_office_collector_tokens_agent",
		"where agent_id is not null",
		"-- +goose down",
		"drop index if exists uq_office_collector_tokens_agent",
		"drop column if exists agent_id",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
	if strings.Contains(migration, "update office_collector_tokens") {
		t.Fatal("collector agent identity migration must not backfill existing rows")
	}
}

func TestClaweeDirectActivitySourceMigration(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00046_clawee_direct_activity_source.sql")
	if err != nil {
		t.Fatal(err)
	}
	migration := strings.ToLower(string(raw))
	for _, want := range []string{
		"-- +goose up",
		"add column if not exists source_type text not null default 'collector'",
		"-- +goose down",
		"drop column if exists source_type",
	} {
		if !strings.Contains(migration, want) {
			t.Fatalf("migration missing %q", want)
		}
	}
	for _, forbidden := range []string{
		"drop column if exists agent_id",
		"drop index if exists uq_office_collector_tokens_agent",
	} {
		if strings.Contains(migration, forbidden) {
			t.Fatalf("migration must not contain %q", forbidden)
		}
	}
}

func TestGitHubSkillSourceSyncMigration(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00024_github_skill_source_sync.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}

	for _, fragment := range []string{
		"create table if not exists skill_sources",
		"provider text not null check (provider = 'github')",
		"unique (repository_owner, repository_name)",
		"create table if not exists skill_source_items",
		"unique (source_id, skill_path)",
		"create unique index uq_skill_source_items_bound_skill",
		"where skill_id is not null",
		"create table if not exists skill_source_sync_runs",
		"create unique index uq_skill_source_active_run",
		"where status in ('queued', 'running')",
		"add column if not exists source_commit_sha text",
		"constraint ck_skill_versions_source_evidence",
		"source_id is not null and source_path is not null and source_commit_sha is not null and source_content_sha256 is not null",
		"create unique index uq_skill_versions_source_commit",
	} {
		if !strings.Contains(strings.ToLower(string(raw)), fragment) {
			t.Fatalf("migration missing %q", fragment)
		}
	}
}

func TestGitHubSkillSourceSyncRevisionMigration(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00025_github_skill_source_sync_revision.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))
	for _, fragment := range []string{
		"alter table skill_sources",
		"add column sync_revision bigint not null default 1",
		"alter table skill_source_sync_runs",
		"add column source_revision bigint not null default 0",
		"drop column if exists source_revision",
		"drop column if exists sync_revision",
	} {
		if !strings.Contains(migration, fragment) {
			t.Fatalf("migration missing %q", fragment)
		}
	}
}

func TestGitHubSkillSourceLocalScanMigration(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00027_skill_source_local_scan.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))
	for _, fragment := range []string{
		"alter table skill_source_sync_runs",
		"add column repository_mode text not null default 'remote'",
		"check (repository_mode in ('remote', 'local'))",
		"drop column if exists repository_mode",
	} {
		if !strings.Contains(migration, fragment) {
			t.Fatalf("migration missing %q", fragment)
		}
	}
}

func TestDataResourceGrantsMigration(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00026_data_resource_grants.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))
	for _, fragment := range []string{
		"create table if not exists data_resource_grants",
		"user_id text not null references accounts(user_id) on delete cascade",
		"resource_type text not null",
		"resource_id text not null",
		"action text not null",
		"unique (user_id, resource_type, resource_id, action)",
		"on data_resource_grants (user_id, resource_type, action)",
		"on data_resource_grants (resource_type, resource_id, action)",
		"drop table if exists data_resource_grants",
	} {
		if !strings.Contains(migration, fragment) {
			t.Fatalf("migration missing %q", fragment)
		}
	}
}

func TestSkillSpacesMigrationAddsOwnershipAndBackfillsDefaultSpace(t *testing.T) {
	raw, err := os.ReadFile("../../db/migrations/00035_skill_spaces.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	migration := strings.ToLower(string(raw))
	for _, fragment := range []string{
		"create table if not exists skill_spaces",
		"alter table skills add column space_id text references skill_spaces(space_id)",
		"update skills set space_id='skillspace_default' where space_id is null",
		"alter table skill_sources add column space_id text references skill_spaces(space_id)",
		"update skill_sources set space_id='skillspace_default' where space_id is null",
		"alter table skill_versions add column uploaded_by_user_id text, add column uploaded_by_agent_id text",
		"'skill_space','skillspace_default','read'",
		"'skill_space','skillspace_default','write'",
		"permission_code='console:skill:manage'",
		"delete from data_resource_grants where resource_type='skill_space'",
		"alter table skill_versions drop column if exists uploaded_by_agent_id, drop column if exists uploaded_by_user_id",
		"alter table skill_sources drop column if exists space_id",
		"alter table skills drop column if exists space_id",
		"drop table if exists skill_spaces",
	} {
		if !strings.Contains(migration, fragment) {
			t.Fatalf("migration missing %q", fragment)
		}
	}
}
