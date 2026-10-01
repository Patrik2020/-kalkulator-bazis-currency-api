import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { CurrencyProviderError } from "../src/errors.js";
import type { CurrencyProvider } from "../src/types.js";

const provider: CurrencyProvider = {
  id: "TEST",
  kind: "live",
  async getRate(input) {
    return {
      date: input.date ?? "2026-09-30",
      base: input.from.toUpperCase(),
      quote: input.to.toUpperCase(),
      rate: 390.25,
      timestamp: "2026-09-30T12:00:00.000Z",
      status: "live",
      provider: "TEST",
    };
  },
  async getRates(input) {
    return input.quotes.map((quote, index) => ({
      date: input.date ?? "2026-09-30",
      base: input.base.toUpperCase(),
      quote: quote.toUpperCase(),
      rate: index === 0 ? 390.25 : 1.17 + index,
      timestamp: "2026-09-30T12:00:00.000Z",
      status: "live" as const,
      provider: "TEST",
    }));
  },
  async getCurrencies() {
    return [
      {
        iso_code: "EUR",
        iso_numeric: "978",
        name: "Euro",
        symbol: "€",
      },
      {
        iso_code: "HUF",
        iso_numeric: "348",
        name: "Hungarian Forint",
        symbol: "Ft",
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
  it("reports Currency Engine v2 health and request id", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBeTruthy();
    expect(response.json()).toMatchObject({
      status: "ok",
      service: "kalkulator-bazis-currency-api",
      version: "0.2.0",
      engine: "currency-engine-v2",
    });
  });

  it("returns a normalized pair rate with engine metadata", async () => {
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
        status: "live",
      },
      meta: {
        source: "Kalkulátor Bázis Currency Engine",
        provider: "ECB",
        status: "live",
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
      source: "Kalkulátor Bázis Currency Engine",
      provider: "ECB",
      status: "live",
    });
    expect(body.data.map((rate: { base: string; quote: string; rate: number }) => ({
      base: rate.base,
      quote: rate.quote,
      rate: rate.rate,
    }))).toEqual([
      { base: "EUR", quote: "HUF", rate: 390.25 },
      { base: "EUR", quote: "USD", rate: 2.17 },
      { base: "EUR", quote: "GBP", rate: 3.17 },
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
        rateTimestamp: "2026-09-30T12:00:00.000Z",
      },
      meta: {
        source: "Kalkulátor Bázis Currency Engine",
        provider: "TEST",
        status: "live",
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

  it("maps rate-source timeouts to a traceable sanitized 504", async () => {
    const failingProvider: CurrencyProvider = {
      async getRate() {
        throw new CurrencyProviderError(504, "SECRET provider diagnostic that must not leak");
      },
      async getRates() {
        throw new CurrencyProviderError(504, "SECRET provider diagnostic that must not leak");
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
      expect(response.json().error.code).toBe("RATE_SOURCE_TIMEOUT");
      expect(response.json().error.requestId).toBe(response.headers["x-request-id"]);
      expect(JSON.stringify(response.json())).not.toContain("SECRET provider diagnostic");
    } finally {
      await failingApp.close();
    }
  });

  it("uses the trusted forwarded client IP for rate limiting behind Render", async () => {
    const proxyApp = await buildApp({
      provider,
      docsEnabled: false,
      trustProxy: true,
      rateLimitMax: 1,
    });
    await proxyApp.ready();

    try {
      const firstClient = await proxyApp.inject({
        method: "GET",
        url: "/api/v1/rate?from=EUR&to=HUF",
        headers: { "x-forwarded-for": "203.0.113.10" },
      });
      const secondClient = await proxyApp.inject({
        method: "GET",
        url: "/api/v1/rate?from=EUR&to=HUF",
        headers: { "x-forwarded-for": "203.0.113.11" },
      });
      const firstClientAgain = await proxyApp.inject({
        method: "GET",
        url: "/api/v1/rate?from=EUR&to=HUF",
        headers: { "x-forwarded-for": "203.0.113.10" },
      });

      expect(firstClient.statusCode).toBe(200);
      expect(secondClient.statusCode).toBe(200);
      expect(firstClientAgain.statusCode).toBe(429);
      expect(firstClientAgain.json().error.code).toBe("RATE_LIMITED");
    } finally {
      await proxyApp.close();
    }
  });

  it("does not expose Swagger UI when documentation is disabled", async () => {
    const response = await app.inject({ method: "GET", url: "/docs" });
    expect(response.statusCode).toBe(404);
  });
});
