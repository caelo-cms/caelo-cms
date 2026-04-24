CREATE TABLE "rls_sentinel" (
	"plugin_id" text NOT NULL,
	"payload" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
