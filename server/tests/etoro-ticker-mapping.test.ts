/**
 * Focused tests for eToro symbol mapping.
 *
 * The app stores tickers in Yahoo-style form (e.g. `BTC-USD`, `COP=X`),
 * but eToro's `/market-data/search` endpoint keys on its own internal
 * symbols (e.g. `BTC`, `USDCOP`). The provider must translate at the
 * boundary while preserving the original ticker for storage/quote
 * identity.
 *
 * Currency semantics for the live quote are handled by `priceContext`
 * (FX-base detection + conversion-rate multiplication); the mapping
 * helper is only responsible for turning a stored ticker into the symbol
 * eToro's search accepts.
 *
 * References:
 *   https://api-portal.etoro.com/core/guides/get-instrument-id
 *   https://api-portal.etoro.com/core/guides/market-orders
 */

import { describe, expect, it } from "vitest";
import { mapEtoroLookupSymbol } from "../src/providers/etoro.js";

describe("mapEtoroLookupSymbol", () => {
  describe("explicit provider mappings", () => {
    it("translates BTC-USD to eToro's BTC symbol", () => {
      expect(mapEtoroLookupSymbol("BTC-USD")).toEqual({
        lookupSymbol: "BTC",
        normalized: "BTC-USD",
      });
    });

    it("translates COP=X to eToro's USDCOP symbol", () => {
      expect(mapEtoroLookupSymbol("COP=X")).toEqual({
        lookupSymbol: "USDCOP",
        normalized: "COP=X",
      });
    });

    it("matches mappings case-insensitively", () => {
      const lower = mapEtoroLookupSymbol("btc-usd");
      const upper = mapEtoroLookupSymbol("BTC-USD");
      const mixed = mapEtoroLookupSymbol("Btc-Usd");
      expect(lower).toEqual(upper);
      expect(mixed).toEqual(upper);
      expect(lower.lookupSymbol).toBe("BTC");
    });

    it("trims surrounding whitespace before lookup", () => {
      const result = mapEtoroLookupSymbol("  COP=X  ");
      expect(result.lookupSymbol).toBe("USDCOP");
      expect(result.normalized).toBe("COP=X");
    });
  });

  describe("passthrough for tickers without explicit mapping", () => {
    it("uses the normalized ticker as the eToro lookup symbol", () => {
      const result = mapEtoroLookupSymbol("AAPL");
      expect(result.lookupSymbol).toBe("AAPL");
      expect(result.normalized).toBe("AAPL");
    });

    it("does not invent mappings silently", () => {
      const result = mapEtoroLookupSymbol("ETH-USD");
      expect(result.lookupSymbol).toBe("ETH-USD");
    });

    it("does not match partial prefixes", () => {
      // Slicing must be exact — `BTC` should not pick up `BTC-USD`.
      const result = mapEtoroLookupSymbol("BTC");
      expect(result.lookupSymbol).toBe("BTC");
      expect(result.normalized).toBe("BTC");
    });
  });

  describe("storage identity (regression guard)", () => {
    it("preserves the original ticker form on the normalized field", () => {
      const btc = mapEtoroLookupSymbol("BTC-USD");
      const cop = mapEtoroLookupSymbol("COP=X");
      expect(btc.normalized).toBe("BTC-USD");
      expect(cop.normalized).toBe("COP=X");
    });

    it("uses different cache keys for original vs eToro lookup symbols", () => {
      const original = mapEtoroLookupSymbol("BTC-USD");
      const plainBtc = mapEtoroLookupSymbol("BTC");
      expect(original.normalized).not.toBe(plainBtc.normalized);
      expect(original.lookupSymbol).toBe("BTC");
      expect(plainBtc.lookupSymbol).toBe("BTC");
    });
  });
});
