CREATE TYPE "public"."check_id" AS ENUM('domain_age', 'ssl_certificate', 'redirect_chain');--> statement-breakpoint
CREATE TYPE "public"."check_outcome" AS ENUM('pass', 'warn', 'fail', 'error');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('pending', 'in_progress', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."verdict" AS ENUM('clean', 'suspicious', 'malicious', 'unknown');--> statement-breakpoint
CREATE TABLE "dlq_event" (
	"id" text PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"last_error" text NOT NULL,
	"redelivery_count" integer NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replayed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "outbox_event" (
	"id" text PRIMARY KEY NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"event_type" text NOT NULL,
	"event_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scan_check" (
	"id" text PRIMARY KEY NOT NULL,
	"scan_id" text NOT NULL,
	"check_id" "check_id" NOT NULL,
	"outcome" "check_outcome" NOT NULL,
	"score" integer NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"domain" text NOT NULL,
	"status" "scan_status" DEFAULT 'pending' NOT NULL,
	"threat_score" integer,
	"verdict" "verdict",
	"error" text,
	"idempotency_key" text,
	"request_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "scan_check" ADD CONSTRAINT "scan_check_scan_id_scan_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox_event" USING btree ("id") WHERE "outbox_event"."published_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "scan_check_scan_check_uq" ON "scan_check" USING btree ("scan_id","check_id");--> statement-breakpoint
CREATE INDEX "scan_check_scan_idx" ON "scan_check" USING btree ("scan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scan_client_idempotency_key_uq" ON "scan" USING btree ("client_id","idempotency_key") WHERE "scan"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "scan_status_id_idx" ON "scan" USING btree ("status","id");--> statement-breakpoint
CREATE INDEX "scan_domain_idx" ON "scan" USING btree ("domain");