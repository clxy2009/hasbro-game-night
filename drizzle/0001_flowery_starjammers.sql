CREATE TABLE `metros` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`timezone` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_metros_slug` ON `metros` (`slug`);--> statement-breakpoint
INSERT INTO `metros` (`id`, `slug`, `name`, `timezone`) VALUES
	('metro-seattle', 'seattle', 'Seattle', 'America/Los_Angeles'),
	('metro-portland', 'portland', 'Portland', 'America/Los_Angeles'),
	('metro-bay-area', 'bay-area', 'Bay Area', 'America/Los_Angeles');--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`home_metro_id` text DEFAULT 'metro-seattle' NOT NULL,
	FOREIGN KEY (`home_metro_id`) REFERENCES `metros`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "users_role_check" CHECK("__new_users"."role" in ('player', 'organizer'))
);--> statement-breakpoint
INSERT INTO `__new_users` (`id`, `name`, `role`, `home_metro_id`)
SELECT `id`, `name`, `role`, 'metro-seattle' FROM `users`;--> statement-breakpoint
CREATE TABLE `__new_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organizer_id` text NOT NULL,
	`metro_id` text NOT NULL,
	`title` text NOT NULL,
	`game_type` text NOT NULL,
	`starts_at` text NOT NULL,
	`location` text NOT NULL,
	`capacity` integer NOT NULL,
	`rsvp_opens_at` text NOT NULL,
	`rsvp_closes_at` text NOT NULL,
	`cancellation_closes_at` text NOT NULL,
	`attendee_count` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organizer_id`) REFERENCES `__new_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`metro_id`) REFERENCES `metros`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "events_capacity_check" CHECK("__new_events"."capacity" between 1 and 500),
	CONSTRAINT "events_attendee_count_check" CHECK("__new_events"."attendee_count" between 0 and "__new_events"."capacity"),
	CONSTRAINT "events_rsvp_window_check" CHECK("__new_events"."rsvp_opens_at" <= "__new_events"."rsvp_closes_at" and "__new_events"."rsvp_closes_at" <= "__new_events"."starts_at"),
	CONSTRAINT "events_cancel_window_check" CHECK("__new_events"."cancellation_closes_at" <= "__new_events"."starts_at")
);--> statement-breakpoint
INSERT INTO `__new_events` (`id`, `organizer_id`, `metro_id`, `title`, `game_type`, `starts_at`, `location`, `capacity`, `rsvp_opens_at`, `rsvp_closes_at`, `cancellation_closes_at`, `attendee_count`, `version`, `created_at`)
SELECT `id`, `organizer_id`, 'metro-seattle', `title`, `game_type`, `starts_at`, `location`, `capacity`,
	`created_at`, `starts_at`, `starts_at`,
	(SELECT COUNT(*) FROM `rsvps` WHERE `rsvps`.`event_id` = `events`.`id`),
	(SELECT COUNT(*) FROM `rsvps` WHERE `rsvps`.`event_id` = `events`.`id`), `created_at`
FROM `events`;--> statement-breakpoint
CREATE TABLE `__new_rsvps` (
	`event_id` text NOT NULL,
	`player_id` text NOT NULL,
	`request_id` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`event_id`, `player_id`),
	FOREIGN KEY (`event_id`) REFERENCES `__new_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_id`) REFERENCES `__new_users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_rsvps` (`event_id`, `player_id`, `request_id`, `created_at`)
SELECT `event_id`, `player_id`, NULL, `created_at` FROM `rsvps`;--> statement-breakpoint
DROP TABLE `rsvps`;--> statement-breakpoint
DROP TABLE `events`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;--> statement-breakpoint
ALTER TABLE `__new_rsvps` RENAME TO `rsvps`;--> statement-breakpoint
CREATE INDEX `idx_events_starts_at` ON `events` (`starts_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_events_organizer_starts_at` ON `events` (`organizer_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `idx_events_metro_starts_at` ON `events` (`metro_id`,`starts_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_rsvps_player_event` ON `rsvps` (`player_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `rsvp_history` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`player_id` text NOT NULL,
	`action` text NOT NULL,
	`occurred_at` text NOT NULL,
	`request_id` text,
	`event_version` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "rsvp_history_action_check" CHECK("rsvp_history"."action" in ('reserved', 'canceled'))
);--> statement-breakpoint
CREATE INDEX `idx_rsvp_history_player_time` ON `rsvp_history` (`player_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_rsvp_history_event_time` ON `rsvp_history` (`event_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE TABLE `outbox_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`event_version` integer NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `idx_outbox_event_id` ON `outbox_events` (`event_id`,`id`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`scope` text NOT NULL,
	`window_start` integer NOT NULL,
	`hits` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `window_start`)
);--> statement-breakpoint
CREATE INDEX `idx_rate_limits_expires_at` ON `rate_limits` (`expires_at`);--> statement-breakpoint
CREATE TRIGGER `trg_rsvps_after_insert`
AFTER INSERT ON `rsvps`
BEGIN
	UPDATE `events`
	SET `attendee_count` = `attendee_count` + 1,
		`version` = `version` + 1
	WHERE `id` = NEW.`event_id`;
	INSERT INTO `rsvp_history`
		(`id`, `event_id`, `player_id`, `action`, `occurred_at`, `request_id`, `event_version`)
	SELECT lower(hex(randomblob(16))), NEW.`event_id`, NEW.`player_id`, 'reserved',
		NEW.`created_at`, NEW.`request_id`, `version`
	FROM `events` WHERE `id` = NEW.`event_id`;
	INSERT INTO `outbox_events`
		(`event_id`, `event_type`, `event_version`, `occurred_at`)
	SELECT NEW.`event_id`, 'capacity.changed', `version`, NEW.`created_at`
	FROM `events` WHERE `id` = NEW.`event_id`;
END;--> statement-breakpoint
CREATE TRIGGER `trg_rsvps_after_delete`
AFTER DELETE ON `rsvps`
BEGIN
	UPDATE `events`
	SET `attendee_count` = CASE WHEN `attendee_count` > 0 THEN `attendee_count` - 1 ELSE 0 END,
		`version` = `version` + 1
	WHERE `id` = OLD.`event_id`;
	INSERT INTO `rsvp_history`
		(`id`, `event_id`, `player_id`, `action`, `occurred_at`, `request_id`, `event_version`)
	SELECT lower(hex(randomblob(16))), OLD.`event_id`, OLD.`player_id`, 'canceled',
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, `version`
	FROM `events` WHERE `id` = OLD.`event_id`;
	INSERT INTO `outbox_events`
		(`event_id`, `event_type`, `event_version`, `occurred_at`)
	SELECT OLD.`event_id`, 'capacity.changed', `version`,
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	FROM `events` WHERE `id` = OLD.`event_id`;
END;
