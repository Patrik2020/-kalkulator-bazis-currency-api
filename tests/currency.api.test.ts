import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { CurrencyProviderError } from "../src/frankfurter.js";
import type { CurrencyProvider } from "../src/types.js";

const provider: CurrencyProvider = {
  async getRate(input) {
    return {
      date: input.date ?? "2026-09-30",
      base: input.from.toUpperCase(),
      quote: input.to.toUpperCase(),
      rate: 390.25,
    };
  },
  async getRates(input) {
    return input.quotes.map((quote, index) => ({
      date: input.date ?? "2026-09-30",
      base: input.base.toUpperCase(),
      quote: quote.toUpperCase(),
      rate: index === 0 ? 390.25 : 1.17 + index,
    }));
  },
  async getCurrencies() {
    return [
      {
        iso_code: "EUR",
        iso_numeric: "978",
        name: "Euro",
        symbol: "€",
        start_date: "1999-01-04",
        end_date: "2026-09-30",
      },
      {
        iso_code: "HUF",
        iso_numeric: "348",
        name: "Hungarian Forint",
        symbol: "Ft",
        start_date: "1999-01-04",
        end_date: "2026-09-30",
      },
    ];
  },
};

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({
    provider,
    docsEnabled: false,
    corsOrigins: ["https://kalkulatorbazis.hu"],
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("currency API", () => {
  it("reports health and request id", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBeTruthy();
    expect(response.json()).toMatchObject({
      status: "ok",
      service: "kalkulator-bazis-currency-api",
      version: "0.1.0",
    });
  });

  it("returns a normalized pair rate", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/rate?from=eur&to=huf&provider=ecb",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        date: "2026-09-30",
        base: "EUR",
        quote: "HUF",
        rate: 390.25,
      },
      meta: {
        source: "Frankfurter v2",
        provider: "ECB",
      },
    });
  });

  it("returns multiple rates in one request", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/rates?base=eur&quotes=huf,usd,gbp&provider=ecb",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.meta).toMatchObject({
      count: 3,
      source: "Frankfurter v2",
      provider: "ECB",
    });
    expect(body.data).toEqual([
      { date: "2026-09-30", base: "EUR", quote: "HUF", rate: 390.25 },
      { date: "2026-09-30", base: "EUR", quote: "USD", rate: 2.17 },
      { date: "2026-09-30", base: "EUR", quote: "GBP", rate: 3.17 },
    ]);
  });

  it("converts an amount with stable decimal rounding", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/convert?amount=10&from=EUR&to=HUF",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        amount: 10,
        from: "EUR",
        to: "HUF",
        rate: 390.25,
        convertedAmount: 3902.5,
        rateDate: "2026-09-30",
      },
      meta: {
        source: "Frankfurter v2",
        provider: "blended",
      },
    });
  });

  it("returns supported currencies", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/currencies" });
    expect(response.statusCode).toBe(200);
    expect(response.json().meta.count).toBe(2);
    expect(response.json().data[1]).toMatchObject({ iso_code: "HUF", name: "Hungarian Forint" });
  });

  it("rejects invalid currency codes", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/convert?amount=10&from=EURO&to=HUF",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });

  it("rejects malformed bulk quote lists", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/rates?base=EUR&quotes=HUF,US-D",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });

  it("rejects disallowed browser origins without leaking internals", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/rate?from=EUR&to=HUF",
      headers: { origin: "https://evil.example" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("CORS_ORIGIN_DENIED");
    expect(JSON.stringify(response.json())).not.toContain("Origin not allowed");
  });

  it("maps upstream timeouts to a traceable 504", async () => {
    const failingProvider: CurrencyProvider = {
      async getRate() {
        throw new CurrencyProviderError(504, "Az árfolyam-szolgáltató nem válaszolt időben.");
      },
      async getRates() {
        throw new CurrencyProviderError(504, "Az árfolyam-szolgáltató nem válaszolt időben.");
      },
      async getCurrencies() {
        return [];
      },
    };
    const failingApp = await buildApp({ provider: failingProvider, docsEnabled: false });
    await failingApp.ready();

    try {
      const response = await failingApp.inject({
        method: "GET",
        url: "/api/v1/rate?from=EUR&to=HUF",
      });
      expect(response.statusCode).toBe(504);
      expect(response.json().error.code).toBe("UPSTREAM_TIMEOUT");
      expect(response.json().error.requestId).toBe(response.headers["x-request-id"]);
    } finally {
      await failingApp.close();
    }
  });
});
