CREATE TABLE `brands` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`paused` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "brands_paused_boolean" CHECK("paused" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `listing_variants` (
	`listing_id` text NOT NULL,
	`variant_id` text NOT NULL,
	CONSTRAINT `listing_variants_pk` PRIMARY KEY(`listing_id`, `variant_id`),
	CONSTRAINT `fk_listing_variants_listing_id_listings_id_fk` FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_listing_variants_variant_id_variants_id_fk` FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `listings` (
	`id` text PRIMARY KEY,
	`product_id` text NOT NULL,
	`retailer_id` text NOT NULL,
	`url` text NOT NULL,
	`cadence` text NOT NULL,
	`last_scraped_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `fk_listings_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_listings_retailer_id_retailers_id_fk` FOREIGN KEY (`retailer_id`) REFERENCES `retailers`(`id`) ON DELETE CASCADE,
	CONSTRAINT "listings_cadence_literal" CHECK("cadence" IN ('daily', 'weekly', 'fortnightly', 'monthly'))
);
--> statement-breakpoint
CREATE TABLE `pages` (
	`id` text PRIMARY KEY,
	`brand_id` text NOT NULL,
	`retailer_id` text NOT NULL,
	`url` text NOT NULL,
	`cadence` text NOT NULL,
	`paused` integer NOT NULL,
	`last_scraped_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `fk_pages_brand_id_brands_id_fk` FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_pages_retailer_id_retailers_id_fk` FOREIGN KEY (`retailer_id`) REFERENCES `retailers`(`id`) ON DELETE CASCADE,
	CONSTRAINT "pages_paused_boolean" CHECK("paused" IN (0, 1)),
	CONSTRAINT "pages_cadence_literal" CHECK("cadence" IN ('daily', 'weekly', 'fortnightly', 'monthly'))
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY,
	`brand_id` text NOT NULL,
	`name` text NOT NULL,
	`paused` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `fk_products_brand_id_brands_id_fk` FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON DELETE CASCADE,
	CONSTRAINT "products_paused_boolean" CHECK("paused" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `retailers` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`domain` text NOT NULL,
	`paused` integer NOT NULL,
	`scrape_mode` text NOT NULL,
	`scrape_country` text NOT NULL,
	`listing_extract_prompt` text NOT NULL,
	`page_extract_prompt` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "retailers_paused_boolean" CHECK("paused" IN (0, 1)),
	CONSTRAINT "retailers_scrape_mode_literal" CHECK("scrape_mode" IN ('basic', 'advance'))
);
--> statement-breakpoint
CREATE TABLE `variants` (
	`id` text PRIMARY KEY,
	`product_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `fk_variants_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `extractions` (
	`id` text PRIMARY KEY,
	`scrape_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`status` text NOT NULL,
	`prompt_kind` text NOT NULL,
	`prompt_snapshot` text NOT NULL,
	`model` text NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`extracted_json` text,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`total_tokens` integer,
	`error_code` text,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `fk_extractions_scrape_id_scrapes_id_fk` FOREIGN KEY (`scrape_id`) REFERENCES `scrapes`(`id`) ON DELETE CASCADE,
	CONSTRAINT "extractions_attempt_positive" CHECK("attempt" >= 1),
	CONSTRAINT "extractions_status_literal" CHECK("status" IN ('pending', 'running', 'success', 'failed')),
	CONSTRAINT "extractions_prompt_kind_literal" CHECK("prompt_kind" IN ('listing', 'page')),
	CONSTRAINT "extractions_error_code_literal" CHECK("error_code" IS NULL OR "error_code" IN ('provider_error', 'json_mode_unmet', 'invalid_json', 'llm_timeout', 'context_overflow', 'unknown')),
	CONSTRAINT "extractions_extracted_json_json" CHECK("extracted_json" IS NULL OR json_valid("extracted_json"))
);
--> statement-breakpoint
CREATE TABLE `scrapes` (
	`id` text PRIMARY KEY,
	`listing_id` text,
	`page_id` text,
	`mode` text NOT NULL,
	`country` text,
	`status` text NOT NULL,
	`request_url` text NOT NULL,
	`request_headers` text,
	`started_at` integer,
	`finished_at` integer,
	`error_code` text,
	`error_message` text,
	`html_r2_key` text,
	`raw_r2_key` text,
	`final_url` text,
	`status_code` integer,
	`response_headers` text,
	`cookies` text,
	`inner_text` text,
	`user_agent` text,
	`ip_info` text,
	`type` text,
	`session` text,
	`attempts` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `fk_scrapes_listing_id_listings_id_fk` FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_scrapes_page_id_pages_id_fk` FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON DELETE CASCADE,
	CONSTRAINT "scrapes_exactly_one_parent" CHECK(("listing_id" IS NULL) <> ("page_id" IS NULL)),
	CONSTRAINT "scrapes_mode_literal" CHECK("mode" IN ('basic', 'advance')),
	CONSTRAINT "scrapes_status_literal" CHECK("status" IN ('pending', 'running', 'success', 'failed')),
	CONSTRAINT "scrapes_error_code_literal" CHECK("error_code" IS NULL OR "error_code" IN ('timeout', 'navigation_failed', 'blocked', 'provider_error', 'invalid_url', 'parent_deleted', 'unknown')),
	CONSTRAINT "scrapes_request_headers_json" CHECK("request_headers" IS NULL OR json_valid("request_headers")),
	CONSTRAINT "scrapes_response_headers_json" CHECK("response_headers" IS NULL OR json_valid("response_headers")),
	CONSTRAINT "scrapes_cookies_json" CHECK("cookies" IS NULL OR json_valid("cookies")),
	CONSTRAINT "scrapes_ip_info_json" CHECK("ip_info" IS NULL OR json_valid("ip_info"))
);
--> statement-breakpoint
CREATE INDEX `listing_variants_variant_id` ON `listing_variants` (`variant_id`);--> statement-breakpoint
CREATE INDEX `listings_product_id` ON `listings` (`product_id`);--> statement-breakpoint
CREATE INDEX `listings_retailer_id` ON `listings` (`retailer_id`);--> statement-breakpoint
CREATE INDEX `listings_last_scraped_at` ON `listings` (`last_scraped_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `pages_brand_id_retailer_id` ON `pages` (`brand_id`,`retailer_id`);--> statement-breakpoint
CREATE INDEX `pages_retailer_id` ON `pages` (`retailer_id`);--> statement-breakpoint
CREATE INDEX `pages_last_scraped_at` ON `pages` (`last_scraped_at`);--> statement-breakpoint
CREATE INDEX `products_brand_id` ON `products` (`brand_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `retailers_domain` ON `retailers` (`domain`);--> statement-breakpoint
CREATE UNIQUE INDEX `variants_product_id_name` ON `variants` (`product_id`,"name" COLLATE NOCASE);--> statement-breakpoint
CREATE UNIQUE INDEX `extractions_scrape_id_attempt` ON `extractions` (`scrape_id`,`attempt`);--> statement-breakpoint
CREATE INDEX `extractions_scrape_id_status_attempt` ON `extractions` (`scrape_id`,`status`,`attempt`);--> statement-breakpoint
CREATE INDEX `extractions_status_created_at` ON `extractions` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `extractions_prompt_kind_status` ON `extractions` (`prompt_kind`,`status`);--> statement-breakpoint
CREATE INDEX `scrapes_status_created_at` ON `scrapes` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `scrapes_listing_id_status_created_at` ON `scrapes` (`listing_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `scrapes_page_id_status_created_at` ON `scrapes` (`page_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `scrapes_created_at` ON `scrapes` (`created_at`);