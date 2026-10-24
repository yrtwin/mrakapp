CREATE TABLE "dj_tracks" (
	"id" serial PRIMARY KEY NOT NULL,
	"file_id" text NOT NULL,
	"file_unique_id" text NOT NULL,
	"title" text NOT NULL,
	"performer" text DEFAULT '' NOT NULL,
	"duration" integer DEFAULT 0 NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dj_tracks_file_unique_id_unique" UNIQUE("file_unique_id")
);
