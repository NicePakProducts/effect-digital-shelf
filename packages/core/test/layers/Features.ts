import * as Layer from "effect/Layer"
import { Brands } from "@app/core/brands"
import { Products } from "@app/core/products"
import { ProductVariants } from "@app/core/products/variants"
import { Retailers } from "@app/core/retailers"
import { Listings } from "@app/core/listings"
import { Pages } from "@app/core/pages"
import { Cascade } from "@app/core/cascade"
import { Auth } from "@app/core/auth"
import { Scrapes } from "@app/core/scrapes"
import { Extractions } from "@app/core/scrapes/extractions"
import { Cron as CronService } from "@app/core/cron"
import { Sweeps } from "@app/core/scrapes/sweeps"
import { ScrapeRunner } from "@app/core/scrapes/runner"
import { ExtractionRunner } from "@app/core/scrapes/extractions/runner"
import { EmailSender } from "@app/core/auth/email-sender"

export const CatalogLayer = Layer.mergeAll(
  Brands.layer,
  Products.layer,
  ProductVariants.layer,
  Retailers.layer,
  Listings.layer,
  Pages.layer,
  Cascade.layer,
)

export const ScrapingLayer = Layer.mergeAll(Scrapes.layer, Extractions.layer)

export const ApiLayer = Layer.mergeAll(
  CatalogLayer,
  ScrapingLayer,
  Auth.layerNoDeps,
)

export const CronLayer = Layer.mergeAll(CronService.layer, Sweeps.layer)

export const ScrapeWorkflowLayer = ScrapeRunner.layer

export const ExtractionWorkflowLayer = ExtractionRunner.layer

export { layer as ScrapeProvidersLayer } from "@app/core/scrapes/providers"

export { BrowserRendering } from "@app/core/scrapes/providers/browser-rendering"

export { layer as LanguageModelLayer } from "@app/core/scrapes/extractions/language-model"

export { layer as TraceIdentity } from "@app/core/scrapes/trace"

export const EmailSenderLayer = EmailSender.layer
