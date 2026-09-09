CREATE TYPE "cadence" AS ENUM('daily', 'weekly', 'fortnightly', 'monthly');--> statement-breakpoint
CREATE TYPE "extraction_status" AS ENUM('pending', 'running', 'success', 'failed');--> statement-breakpoint
CREATE TYPE "prompt_kind" AS ENUM('listing', 'page');--> statement-breakpoint
CREATE TYPE "scrape_mode" AS ENUM('basic', 'advance');--> statement-breakpoint
CREATE TYPE "scrape_status" AS ENUM('pending', 'running', 'success', 'failed');--> statement-breakpoint
CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing_variants" (
	"listing_id" uuid,
	"variant_id" uuid,
	CONSTRAINT "listing_variants_pkey" PRIMARY KEY("listing_id","variant_id")
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" uuid PRIMARY KEY,
	"product_id" uuid NOT NULL,
	"retailer_id" uuid NOT NULL,
	"url" text NOT NULL,
	"cadence" "cadence" NOT NULL,
	"last_scraped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY,
	"brand_id" uuid NOT NULL,
	"retailer_id" uuid NOT NULL,
	"url" text NOT NULL,
	"cadence" "cadence" NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"last_scraped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY,
	"brand_id" uuid NOT NULL,
	"name" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retailers" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"scrape_mode" "scrape_mode" NOT NULL,
	"scrape_country" text NOT NULL,
	"listing_extract_prompt" text NOT NULL,
	"page_extract_prompt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" uuid PRIMARY KEY,
	"product_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extractions" (
	"id" uuid PRIMARY KEY,
	"scrape_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"status" "extraction_status" NOT NULL,
	"prompt_kind" "prompt_kind" NOT NULL,
	"prompt_snapshot" text NOT NULL,
	"model" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"extracted_json" jsonb,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"total_tokens" integer,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extractions_attempt_positive" CHECK ("attempt" >= 1),
	CONSTRAINT "extractions_error_code_literal" CHECK ("error_code" IS NULL OR "error_code" IN ('provider_error', 'json_mode_unmet', 'invalid_json', 'llm_timeout', 'context_overflow', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "scrapes" (
	"id" uuid PRIMARY KEY,
	"listing_id" uuid,
	"page_id" uuid,
	"mode" "scrape_mode" NOT NULL,
	"country" text,
	"status" "scrape_status" NOT NULL,
	"root_span_id" text NOT NULL,
	"request_url" text NOT NULL,
	"request_headers" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"html_r2_key" text,
	"raw_r2_key" text,
	"final_url" text,
	"status_code" integer,
	"response_headers" jsonb,
	"cookies" jsonb,
	"inner_text" text,
	"user_agent" text,
	"ip_info" jsonb,
	"type" text,
	"session" text,
	"attempts" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scrapes_exactly_one_parent" CHECK (("listing_id" IS NULL) <> ("page_id" IS NULL)),
	CONSTRAINT "scrapes_root_span_id_hex" CHECK ("root_span_id" ~ '^[0-9a-f]{16}$'),
	CONSTRAINT "scrapes_error_code_literal" CHECK ("error_code" IS NULL OR "error_code" IN ('timeout', 'navigation_failed', 'blocked', 'provider_error', 'invalid_url', 'parent_deleted', 'unknown'))
);
--> statement-breakpoint
CREATE INDEX "listing_variants_variant_id" ON "listing_variants" ("variant_id");--> statement-breakpoint
CREATE INDEX "listings_product_id" ON "listings" ("product_id");--> statement-breakpoint
CREATE INDEX "listings_retailer_id" ON "listings" ("retailer_id");--> statement-breakpoint
CREATE INDEX "listings_last_scraped_at" ON "listings" ("last_scraped_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pages_brand_id_retailer_id" ON "pages" ("brand_id","retailer_id");--> statement-breakpoint
CREATE INDEX "pages_retailer_id" ON "pages" ("retailer_id");--> statement-breakpoint
CREATE INDEX "pages_last_scraped_at" ON "pages" ("last_scraped_at");--> statement-breakpoint
CREATE INDEX "products_brand_id" ON "products" ("brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "retailers_domain" ON "retailers" ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX "variants_product_id_name" ON "variants" ("product_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "extractions_scrape_id_attempt" ON "extractions" ("scrape_id","attempt");--> statement-breakpoint
CREATE INDEX "extractions_scrape_id_status_attempt" ON "extractions" ("scrape_id","status","attempt");--> statement-breakpoint
CREATE INDEX "extractions_status_created_at" ON "extractions" ("status","created_at");--> statement-breakpoint
CREATE INDEX "extractions_prompt_kind_status" ON "extractions" ("prompt_kind","status");--> statement-breakpoint
CREATE INDEX "scrapes_status_created_at" ON "scrapes" ("status","created_at");--> statement-breakpoint
CREATE INDEX "scrapes_listing_id_status_created_at" ON "scrapes" ("listing_id","status","created_at");--> statement-breakpoint
CREATE INDEX "scrapes_page_id_status_created_at" ON "scrapes" ("page_id","status","created_at");--> statement-breakpoint
CREATE INDEX "scrapes_created_at" ON "scrapes" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scrapes_listing_in_flight" ON "scrapes" ("listing_id") WHERE "status" IN ('pending', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "scrapes_page_in_flight" ON "scrapes" ("page_id") WHERE "status" IN ('pending', 'running');--> statement-breakpoint
ALTER TABLE "listing_variants" ADD CONSTRAINT "listing_variants_listing_id_listings_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "listing_variants" ADD CONSTRAINT "listing_variants_variant_id_variants_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "variants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_product_id_products_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_retailer_id_retailers_id_fkey" FOREIGN KEY ("retailer_id") REFERENCES "retailers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_brand_id_brands_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_retailer_id_retailers_id_fkey" FOREIGN KEY ("retailer_id") REFERENCES "retailers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_brands_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_product_id_products_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_scrape_id_scrapes_id_fkey" FOREIGN KEY ("scrape_id") REFERENCES "scrapes"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "scrapes" ADD CONSTRAINT "scrapes_listing_id_listings_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "scrapes" ADD CONSTRAINT "scrapes_page_id_pages_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE;