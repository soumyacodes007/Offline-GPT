CREATE TABLE `access_policy_rule` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`resource_kind` enum('model','plugin','marketplace','config_object','connector_instance','mcp_connection','llm_provider','capability') NOT NULL,
	`resource_id` varchar(191) NOT NULL,
	`principal_kind` enum('member','team','role','org') NOT NULL,
	`principal_id` varchar(191) NOT NULL,
	`effect` enum('allow','deny') NOT NULL,
	`expires_at` timestamp(3),
	`reason` varchar(1000),
	`created_by_org_membership_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`removed_at` timestamp(3),
	`removed_by_org_membership_id` varchar(64),
	CONSTRAINT `access_policy_rule_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `access_policy_rule_org_resource` ON `access_policy_rule` (`organization_id`,`resource_kind`,`resource_id`);--> statement-breakpoint
CREATE INDEX `access_policy_rule_org_principal` ON `access_policy_rule` (`organization_id`,`principal_kind`,`principal_id`);