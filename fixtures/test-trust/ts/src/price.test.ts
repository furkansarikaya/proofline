import { describe, expect, it } from "vitest";
import { applyDiscount, formatPrice, parseAmount, settings } from "./shop";

describe("formatPrice", () => {
  it("formats cents in the default currency", () => {
    expect(formatPrice(1250)).toBe("12.50 USD");
  });

  it("formats cents in euros", () => {
    settings.currency = "EUR";
    expect(formatPrice(1250)).toBe("12.50 EUR");
  });
});

describe("applyDiscount", () => {
  it.each([
    [9999, 9999],
    [10000, 9000],
    [20000, 18000],
    [0, 0],
  ])("applyDiscount(%i) = %i", (input, expected) => {
    expect(applyDiscount(input)).toBe(expected);
  });
});

describe("parseAmount", () => {
  it("parses valid amounts", () => {
    expect(parseAmount("12.50")).toBe(1250);
    expect(parseAmount("3")).toBe(300);
    expect(parseAmount(" 0.05 ")).toBe(5);
  });

  it("rejects invalid amounts", () => {
    for (const input of ["abc", "1.234", "-1", "1.x0", "1.5", ""]) {
      expect(() => parseAmount(input)).toThrow();
    }
  });
});
