CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`organizer_id` text NOT NULL,
	`title` text NOT NULL,
	`game_type` text NOT NULL,
	`starts_at` text NOT NULL,
	`location` text NOT NULL,
	`capacity` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organizer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "events_capacity_check" CHECK("events"."capacity" between 1 and 500)
);
--> statement-breakpoint
CREATE INDEX `idx_events_starts_at` ON `events` (`starts_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_events_organizer_starts_at` ON `events` (`organizer_id`,`starts_at`);--> statement-breakpoint
CREATE TABLE `rsvps` (
	`event_id` text NOT NULL,
	`player_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`event_id`, `player_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_rsvps_player_event` ON `rsvps` (`player_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	CONSTRAINT "users_role_check" CHECK("users"."role" in ('player', 'organizer'))
);
