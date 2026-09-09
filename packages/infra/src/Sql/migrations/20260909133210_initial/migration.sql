CREATE TYPE "cadence" AS ENUM('daily', 'weekly', 'fortnightly', 'monthly');--> statement-breakpoint
CREATE TYPE "extraction_status" AS ENUM('pending', 'running', 'success', 'failed');--> statement-breakpoint
CREATE TYPE "prompt_kind" AS ENUM('listing', 'page');--> statement-breakpoint
CREATE TYPE "scrape_mode" AS ENUM('basic', 'advance');--> statement-breakpoint
CREATE TYPE "scrape_status" AS ENUM('pending', 'running', 'success', 'failed');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jwks" (
	"id" text PRIMARY KEY,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"alg" text,
	"crv" text
);
--> statement-breakpoint
CREATE TABLE "oauth_access_token" (
	"id" text PRIMARY KEY,
	"token" text NOT NULL UNIQUE,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"refresh_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"revoked" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client" (
	"id" text PRIMARY KEY,
	"client_id" text NOT NULL UNIQUE,
	"client_secret" text,
	"client_discovery_id" text,
	"disabled" boolean DEFAULT false,
	"skip_consent" boolean,
	"enable_end_session" boolean,
	"subject_type" text,
	"scopes" text[],
	"client_credentials_scopes" text[] DEFAULT '{}'::text[],
	"user_id" text,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text[],
	"tos" text,
	"policy" text,
	"software_id" text,
	"software_version" text,
	"software_statement" text,
	"redirect_uris" text[] NOT NULL,
	"post_logout_redirect_uris" text[],
	"backchannel_logout_uri" text,
	"backchannel_logout_session_required" boolean,
	"token_endpoint_auth_method" text,
	"application_type" text,
	"jwks" text,
	"jwks_uri" text,
	"grant_types" text[],
	"response_types" text[],
	"require_pkce" boolean,
	"dpop_bound_access_tokens" boolean DEFAULT false,
	"reference_id" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "oauth_client_assertion" (
	"id" text PRIMARY KEY,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client_resource" (
	"id" text PRIMARY KEY,
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_consent" (
	"id" text PRIMARY KEY,
	"client_id" text NOT NULL,
	"user_id" text,
	"reference_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_token" (
	"id" text PRIMARY KEY,
	"token" text NOT NULL UNIQUE,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text NOT NULL,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"revoked" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"rotation_replay_response" text,
	"rotation_replay_expires_at" timestamp with time zone,
	"auth_time" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_resource" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"access_token_ttl" integer,
	"refresh_token_ttl" integer,
	"signing_algorithm" text,
	"signing_key_id" text,
	"allowed_scopes" text[],
	"custom_claims" jsonb,
	"dpop_bound_access_tokens_required" boolean DEFAULT false,
	"disabled" boolean DEFAULT false,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"policy_version" integer DEFAULT 1,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL UNIQUE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE INDEX "account_userId_idx" ON "account" ("user_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_clientId_idx" ON "oauth_access_token" ("client_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_sessionId_idx" ON "oauth_access_token" ("session_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_userId_idx" ON "oauth_access_token" ("user_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" ON "oauth_access_token" ("authorization_code_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_refreshId_idx" ON "oauth_access_token" ("refresh_id");--> statement-breakpoint
CREATE INDEX "oauthClient_userId_idx" ON "oauth_client" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauthClientResource_clientId_resourceId_uidx" ON "oauth_client_resource" ("client_id","resource_id");--> statement-breakpoint
CREATE INDEX "oauthClientResource_clientId_idx" ON "oauth_client_resource" ("client_id");--> statement-breakpoint
CREATE INDEX "oauthClientResource_resourceId_idx" ON "oauth_client_resource" ("resource_id");--> statement-breakpoint
CREATE INDEX "oauthConsent_clientId_idx" ON "oauth_consent" ("client_id");--> statement-breakpoint
CREATE INDEX "oauthConsent_userId_idx" ON "oauth_consent" ("user_id");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_clientId_idx" ON "oauth_refresh_token" ("client_id");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_sessionId_idx" ON "oauth_refresh_token" ("session_id");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_userId_idx" ON "oauth_refresh_token" ("user_id");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" ON "oauth_refresh_token" ("authorization_code_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");--> statement-breakpoint
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
CREATE UNIQUE INDEX "extractions_scrape_in_flight" ON "extractions" ("scrape_id") WHERE "status" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "scrapes_status_created_at" ON "scrapes" ("status","created_at");--> statement-breakpoint
CREATE INDEX "scrapes_listing_id_status_created_at" ON "scrapes" ("listing_id","status","created_at");--> statement-breakpoint
CREATE INDEX "scrapes_page_id_status_created_at" ON "scrapes" ("page_id","status","created_at");--> statement-breakpoint
CREATE INDEX "scrapes_created_at" ON "scrapes" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scrapes_listing_in_flight" ON "scrapes" ("listing_id") WHERE "status" IN ('pending', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "scrapes_page_in_flight" ON "scrapes" ("page_id") WHERE "status" IN ('pending', 'running');--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_refresh_id_oauth_refresh_token_id_fkey" FOREIGN KEY ("refresh_id") REFERENCES "oauth_refresh_token"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_dn2L1gs9Dolm_fkey" FOREIGN KEY ("resource_id") REFERENCES "oauth_resource"("identifier") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
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