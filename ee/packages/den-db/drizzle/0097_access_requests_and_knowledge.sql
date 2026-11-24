CREATE TABLE `access_request` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`requester_org_membership_id` varchar(64) NOT NULL,
	`resource_kind` enum('model','plugin','marketplace','config_object','connector_instance','mcp_connection','llm_provider','capability','knowledge_document','knowledge_chunk') NOT NULL,
	`resource_id` varchar(191) NOT NULL,
	`resource_label` varchar(300),
	`purpose` varchar(1000) NOT NULL,
	`requested_days` int,
	`status` enum('pending','approved','declined','cancelled') NOT NULL DEFAULT 'pending',
	`expires_at` timestamp(3) NOT NULL,
	`decided_by_org_membership_id` varchar(64),
	`decided_at` timestamp(3),
	`decision_note` varchar(1000),
	`granted_rule_id` varchar(64),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `access_request_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `knowledge_chunk` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`document_id` varchar(64) NOT NULL,
	`ordinal` int NOT NULL,
	`heading` varchar(300),
	`text` mediumtext NOT NULL,
	`sensitivity` enum('ordinary','sensitive','restricted') NOT NULL DEFAULT 'ordinary',
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `knowledge_chunk_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `knowledge_document` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`title` varchar(300) NOT NULL,
	`source_name` varchar(300),
	`mime_type` varchar(100) NOT NULL,
	`created_by_org_membership_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`removed_at` timestamp(3),
	CONSTRAINT `knowledge_document_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `access_policy_rule` MODIFY COLUMN `resource_kind` enum('model','plugin','marketplace','config_object','connector_instance','mcp_connection','llm_provider','capability','knowledge_document','knowledge_chunk') NOT NULL;--> statement-breakpoint
CREATE INDEX `access_request_org_status` ON `access_request` (`organization_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `access_request_requester` ON `access_request` (`organization_id`,`requester_org_membership_id`,`status`);--> statement-breakpoint
CREATE INDEX `knowledge_chunk_document` ON `knowledge_chunk` (`document_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `knowledge_document_org` ON `knowledge_document` (`organization_id`,`removed_at`);--> statement-breakpoint
CREATE FULLTEXT INDEX `knowledge_chunk_text` ON `knowledge_chunk` (`heading`,`text`);