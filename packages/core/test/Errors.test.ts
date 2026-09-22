import { expect, it } from "@effect/vitest"
import { Auth, AuthErrors } from "@app/core/auth"
import { Brands, BrandsErrors } from "@app/core/brands"
import { Products, ProductsErrors } from "@app/core/products"
import {
  ProductVariants,
  ProductVariantsErrors,
} from "@app/core/products/variants"
import { Retailers, RetailersErrors } from "@app/core/retailers"
import { Listings, ListingsErrors } from "@app/core/listings"
import { Pages, PagesErrors } from "@app/core/pages"
import { Scrapes, ScrapesErrors } from "@app/core/scrapes"
import { Extractions, ExtractionsErrors } from "@app/core/scrapes/extractions"
import * as Lifecycle from "@app/core/scrapes/lifecycle"
import { LifecycleErrors } from "@app/core/scrapes/lifecycle"
import { ScrapeRunner } from "@app/core/scrapes/runner"
import { AuthErrors as OwnedAuthErrors } from "../src/auth/errors"
import { BrandsErrors as OwnedBrandsErrors } from "../src/brands/errors"
import { ProductsErrors as OwnedProductsErrors } from "../src/products/errors"
import { ProductVariantsErrors as OwnedProductVariantsErrors } from "../src/products/variants/errors"
import { RetailersErrors as OwnedRetailersErrors } from "../src/retailers/errors"
import { ListingsErrors as OwnedListingsErrors } from "../src/listings/errors"
import { PagesErrors as OwnedPagesErrors } from "../src/pages/errors"
import { ScrapesErrors as OwnedScrapesErrors } from "../src/scrapes/errors"
import { ExtractionsErrors as OwnedExtractionsErrors } from "../src/scrapes/extractions/errors"
import { LifecycleErrors as OwnedLifecycleErrors } from "../src/scrapes/lifecycle/errors"
import {
  BrandId,
  ProductId,
  VariantId,
  RetailerId,
  ListingId,
  PageId,
  ScrapeId,
  ExtractionId,
} from "@app/schema/ids"
import { Schema } from "effect"
import { Scrape } from "@app/schema/scrape"

it("public capabilities expose the owning error namespace, not individual constructors", () => {
  const cases = [
    {
      capability: Auth,
      namespace: Auth.AuthErrors,
      exported: AuthErrors,
      owned: OwnedAuthErrors,
    },
    {
      capability: Brands,
      namespace: Brands.BrandsErrors,
      exported: BrandsErrors,
      owned: OwnedBrandsErrors,
    },
    {
      capability: Products,
      namespace: Products.ProductsErrors,
      exported: ProductsErrors,
      owned: OwnedProductsErrors,
    },
    {
      capability: ProductVariants,
      namespace: ProductVariants.ProductVariantsErrors,
      exported: ProductVariantsErrors,
      owned: OwnedProductVariantsErrors,
    },
    {
      capability: Retailers,
      namespace: Retailers.RetailersErrors,
      exported: RetailersErrors,
      owned: OwnedRetailersErrors,
    },
    {
      capability: Listings,
      namespace: Listings.ListingsErrors,
      exported: ListingsErrors,
      owned: OwnedListingsErrors,
    },
    {
      capability: Pages,
      namespace: Pages.PagesErrors,
      exported: PagesErrors,
      owned: OwnedPagesErrors,
    },
    {
      capability: Scrapes,
      namespace: Scrapes.ScrapesErrors,
      exported: ScrapesErrors,
      owned: OwnedScrapesErrors,
    },
    {
      capability: Extractions,
      namespace: Extractions.ExtractionsErrors,
      exported: ExtractionsErrors,
      owned: OwnedExtractionsErrors,
    },
    {
      capability: Lifecycle,
      namespace: Lifecycle.LifecycleErrors,
      exported: LifecycleErrors,
      owned: OwnedLifecycleErrors,
    },
  ]

  for (const entry of cases) {
    expect(entry.namespace).toBe(entry.owned)
    expect(entry.exported).toBe(entry.owned)

    const constructors = Object.keys(entry.owned).filter(
      (key) => !key.endsWith("Errors"),
    )

    expect(constructors.length).toBeGreaterThan(0)

    for (const constructor of constructors)
      expect(Object.hasOwn(entry.capability, constructor)).toBe(false)
  }

  expect(ScrapeRunner.LifecycleErrors).toBe(OwnedLifecycleErrors)
  expect(Object.hasOwn(ScrapeRunner, "TransitionRejected")).toBe(false)
})

it("moved constructors retain every public tag and payload", () => {
  const id = "00000000-0000-4000-8000-000000000404"
  const brandId = Schema.decodeUnknownSync(BrandId)(id)
  const productId = Schema.decodeUnknownSync(ProductId)(id)
  const variantId = Schema.decodeUnknownSync(VariantId)(id)
  const retailerId = Schema.decodeUnknownSync(RetailerId)(id)
  const listingId = Schema.decodeUnknownSync(ListingId)(id)
  const pageId = Schema.decodeUnknownSync(PageId)(id)
  const scrapeId = Schema.decodeUnknownSync(ScrapeId)(id)
  const extractionId = Schema.decodeUnknownSync(ExtractionId)(id)
  const parent = Scrape.Parent.members[0].make({ listingId })

  const cases = [
    {
      error: new AuthErrors.SessionLookupFailed({ cause: "lookup" }),
      tag: "SessionLookupFailed",
      fields: { cause: "lookup" },
    },
    {
      error: new BrandsErrors.NotFound({ brandId }),
      tag: "BrandNotFound",
      fields: { brandId },
    },
    {
      error: new ProductsErrors.NotFound({ productId }),
      tag: "ProductNotFound",
      fields: { productId },
    },
    {
      error: new ProductVariantsErrors.NotFound({ variantId }),
      tag: "VariantNotFound",
      fields: { variantId },
    },
    {
      error: new ProductVariantsErrors.DuplicateName({
        productId,
        name: "500 ml",
      }),
      tag: "DuplicateVariantName",
      fields: { productId, name: "500 ml" },
    },
    {
      error: new RetailersErrors.NotFound({ retailerId }),
      tag: "RetailerNotFound",
      fields: { retailerId },
    },
    {
      error: new RetailersErrors.InvalidDomain({ input: "localhost" }),
      tag: "InvalidRetailerDomain",
      fields: { input: "localhost" },
    },
    {
      error: new RetailersErrors.DomainTaken({
        domain: "example.test",
        retailerId,
      }),
      tag: "RetailerDomainTaken",
      fields: { domain: "example.test", retailerId },
    },
    {
      error: new RetailersErrors.UrlHostMismatch({
        url: "https://other.test",
        domain: "example.test",
        listingIds: [listingId],
        pageIds: [pageId],
      }),
      tag: "UrlHostMismatch",
      fields: {
        url: "https://other.test",
        domain: "example.test",
        listingIds: [listingId],
        pageIds: [pageId],
      },
    },
    {
      error: new ListingsErrors.NotFound({ listingId }),
      tag: "ListingNotFound",
      fields: { listingId },
    },
    {
      error: new ListingsErrors.VariantNotInProduct({ variantId, productId }),
      tag: "VariantNotInProduct",
      fields: { variantId, productId },
    },
    {
      error: new PagesErrors.NotFound({ pageId }),
      tag: "PageNotFound",
      fields: { pageId },
    },
    {
      error: new PagesErrors.AlreadyExists({ brandId, retailerId, pageId }),
      tag: "PageAlreadyExists",
      fields: { brandId, retailerId, pageId },
    },
    {
      error: new ScrapesErrors.NotFound({ scrapeId }),
      tag: "ScrapeNotFound",
      fields: { scrapeId },
    },
    {
      error: new ScrapesErrors.ParentInFlight({ parent, scrapeId }),
      tag: "ParentInFlight",
      fields: { parent, scrapeId },
    },
    {
      error: new ExtractionsErrors.NotFound({ extractionId }),
      tag: "ExtractionNotFound",
      fields: { extractionId },
    },
    {
      error: new ExtractionsErrors.ScrapeNotReExtractable({
        scrapeId,
        reason: "html_expired",
      }),
      tag: "ScrapeNotReExtractable",
      fields: { scrapeId, reason: "html_expired" },
    },
    {
      error: new ExtractionsErrors.InFlight({
        scrapeId,
        promptKind: "listing",
        extractionId,
      }),
      tag: "ExtractionInFlight",
      fields: { scrapeId, promptKind: "listing", extractionId },
    },
    {
      error: new ExtractionsErrors.NoSuccessfulScrape({ parent }),
      tag: "NoSuccessfulScrape",
      fields: { parent },
    },
    {
      error: new LifecycleErrors.TransitionRejected({
        kind: "scrape",
        id,
        from: "running",
        to: "success",
        observed: "failed",
      }),
      tag: "TransitionRejected",
      fields: {
        kind: "scrape",
        id,
        from: "running",
        to: "success",
        observed: "failed",
      },
    },
  ]

  for (const entry of cases) {
    expect(entry.error._tag).toBe(entry.tag)
    expect(entry.error).toMatchObject(entry.fields)
  }
})
