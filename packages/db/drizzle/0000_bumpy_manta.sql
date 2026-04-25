CREATE TABLE `clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source_ids` text DEFAULT '{}' NOT NULL,
	`email_domains` text DEFAULT '[]' NOT NULL,
	`tier` integer,
	`cost_rate_cents` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clients_name_idx` ON `clients` (`name`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`harvest_project_id` text,
	`airtable_record_id` text,
	`status` text,
	`owner` text,
	`budget_hours` integer,
	`hours_used` integer,
	`last_status_update_at` integer,
	`last_synced_at` integer NOT NULL,
	`harvest_etag` text,
	`airtable_etag` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_harvest_idx` ON `projects` (`harvest_project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_airtable_idx` ON `projects` (`airtable_record_id`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`qbo_invoice_id` text,
	`harvest_invoice_id` text,
	`number` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`issued_at` integer,
	`due_at` integer,
	`paid_at` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`last_synced_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_qbo_idx` ON `invoices` (`qbo_invoice_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_harvest_idx` ON `invoices` (`harvest_invoice_id`);--> statement-breakpoint
CREATE INDEX `invoices_client_due_idx` ON `invoices` (`client_id`,`due_at`);--> statement-breakpoint
CREATE INDEX `invoices_status_idx` ON `invoices` (`status`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`type` text NOT NULL,
	`subject_ref` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`ingested_at` integer NOT NULL,
	`priority_score` integer NOT NULL,
	`state` text DEFAULT 'unread' NOT NULL,
	`suggested_actions` text DEFAULT '[]' NOT NULL,
	`payload` text NOT NULL,
	`thread_id` text,
	`snoozed_until` integer,
	`dedupe_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "events_state_check" CHECK("events"."state" IN ('unread', 'read', 'done', 'snoozed', 'dismissed', 'waiting')),
	CONSTRAINT "events_score_check" CHECK("events"."priority_score" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_dedupe_idx` ON `events` (`type`,`subject_ref`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `events_inbox_idx` ON `events` (`state`,`priority_score`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `events_subject_idx` ON `events` (`subject_ref`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `action_legs` (
	`id` text PRIMARY KEY NOT NULL,
	`action_id` text NOT NULL,
	`order` integer NOT NULL,
	`target` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`params` text NOT NULL,
	`status` text DEFAULT 'drafted' NOT NULL,
	`error` text,
	`executed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`action_id`) REFERENCES `actions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `action_legs_by_action` ON `action_legs` (`action_id`,`order`);--> statement-breakpoint
CREATE UNIQUE INDEX `action_legs_idem_idx` ON `action_legs` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `actions` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`params` text NOT NULL,
	`mode` text NOT NULL,
	`drafted_by` text NOT NULL,
	`status` text DEFAULT 'drafted' NOT NULL,
	`reversal_class` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`agent_confidence` text,
	`agent_rationale` text,
	`preview` text DEFAULT '' NOT NULL,
	`originating_event_id` text,
	`subject_ref` text NOT NULL,
	`executed_at` integer,
	`undo_token` text,
	`queued_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`originating_event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "actions_status_check" CHECK("actions"."status" IN ('drafted', 'approved', 'queued_30s', 'executing', 'succeeded', 'failed', 'cancelled', 'undone')),
	CONSTRAINT "actions_mode_check" CHECK("actions"."mode" IN ('manual', 'proposed')),
	CONSTRAINT "actions_reversal_check" CHECK("actions"."reversal_class" IN ('true_undo', 'compensating', 'no_undo'))
);
--> statement-breakpoint
CREATE INDEX `actions_idem_idx` ON `actions` (`idempotency_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `actions_queue_idx` ON `actions` (`status`,`queued_until`);--> statement-breakpoint
CREATE INDEX `actions_subject_idx` ON `actions` (`subject_ref`,`created_at`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`action_id` text,
	`originating_event_id` text,
	`kind` text NOT NULL,
	`idempotency_key` text,
	`subject_ref` text NOT NULL,
	`request` text,
	`response` text,
	`http_status` text,
	`transition` text,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`action_id`) REFERENCES `actions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`originating_event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_by_subject` ON `audit_events` (`subject_ref`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_by_action` ON `audit_events` (`action_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_by_kind` ON `audit_events` (`kind`,`created_at`);--> statement-breakpoint
CREATE TABLE `integration_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`external_account_id` text NOT NULL,
	`display_name` text,
	`status` text DEFAULT 'connected' NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`token_expires_at` integer,
	`metadata` text DEFAULT '{}' NOT NULL,
	`last_sync_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connections_source_account_idx` ON `integration_connections` (`source`,`external_account_id`);--> statement-breakpoint
CREATE TABLE `mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`scope` text NOT NULL,
	`external_account_id` text NOT NULL,
	`config` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mappings_scoped_idx` ON `mappings` (`source`,`scope`,`external_account_id`);--> statement-breakpoint
CREATE TABLE `gmail_body_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`gmail_message_id` text NOT NULL,
	`body_encrypted` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`evict_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gmail_body_msg_idx` ON `gmail_body_cache` (`gmail_message_id`);--> statement-breakpoint
CREATE INDEX `gmail_body_evict_idx` ON `gmail_body_cache` (`evict_at`);--> statement-breakpoint
CREATE TABLE `gmail_message_headers` (
	`id` text PRIMARY KEY NOT NULL,
	`gmail_thread_id` text NOT NULL,
	`gmail_message_id` text NOT NULL,
	`from` text,
	`to` text DEFAULT '[]' NOT NULL,
	`cc` text DEFAULT '[]' NOT NULL,
	`subject` text,
	`sent_at` integer,
	`label_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gmail_msg_idx` ON `gmail_message_headers` (`gmail_message_id`);--> statement-breakpoint
CREATE INDEX `gmail_msg_thread_idx` ON `gmail_message_headers` (`gmail_thread_id`,`sent_at`);--> statement-breakpoint
CREATE TABLE `gmail_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`gmail_thread_id` text NOT NULL,
	`scope` text DEFAULT 'in_scope' NOT NULL,
	`client_ids` text DEFAULT '[]' NOT NULL,
	`last_message_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gmail_threads_thread_idx` ON `gmail_threads` (`gmail_thread_id`);--> statement-breakpoint
CREATE INDEX `gmail_threads_last_msg_idx` ON `gmail_threads` (`last_message_at`);