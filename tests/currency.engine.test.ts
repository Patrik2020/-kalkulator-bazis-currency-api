import { describe, expect, it } from "vitest";
import {
  CurrencyEngine,
  EcbReferenceClient,
  MnbReferenceClient,
  TradingViewDataClient,
} from "../src/currency-engine.js";
import { CurrencyProviderError } from "../src/errors.js";
import type { CurrencyProvider } from "../src/types.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("TradingViewDataClient", () => {
  it("normalizes batch market quotes and uses bid/ask midpoint", async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { symbols: string[] };
      const rows = body.symbols.map((symbol) => {
        if (symbol === "FOREXCOM:EURHUF") {
          return {
            symbol,
            data: {
              bid: 366.4,
              ask: 366.6,
              lp: 366.5,
              rtc_time: 1_799_000_000,
            },
          };
        }
        if (symbol === "FOREXCOM:EURUSD") {
          return {
            symbol,
            data: {
              bid: 1.171,
              ask: 1.173,
              lp: 1.172,
              rtc_time: 1_799_000_000,
            },
          };
        }
        return { symbol, success: false };
      });
      return jsonResponse({ success: true, data: { data: rows } });
    };

    const client = new TradingViewDataClient({
      apiKey: "test-key",
      exchanges: ["FOREXCOM"],
      fetchImpl,
      now: () => new Date("2026-10-01T04:00:00.000Z"),
    });

    const rates = await client.getRates({ base: "EUR", quotes: ["HUF", "USD"] });
    expect(rates).toHaveLength(2);
    expect(rates[0]).toMatchObject({
      base: "EUR",
      quote: "HUF",
      rate: 366.5,
      status: "live",
      provider: "LIVE",
    });
    expect(rates[1]).toMatchObject({
      base: "EUR",
      quote: "USD",
      rate: 1.172,
      status: "live",
      provider: "LIVE",
    });
  });

  it("can derive a missing pair through USD", async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { symbols: string[] };
      const rows = body.symbols.flatMap((symbol) => {
        const values: Record<string, number> = {
          "FOREXCOM:USDEUR": 0.853,
          "FOREXCOM:USDHUF": 312.5,
        };
        const rate = values[symbol];
        return rate ? [{ symbol, data: { lp: rate, rtc_time: 1_799_000_000 } }] : [];
      });
      return jsonResponse({ success: true, data: { data: rows } });
    };

    const client = new TradingViewDataClient({
      apiKey: "test-key",
      exchanges: ["FOREXCOM"],
      fetchImpl,
      now: () => new Date("2026-10-01T04:00:00.000Z"),
    });

    const rate = await client.getRate({ from: "EUR", to: "HUF" });
    expect(rate.rate).toBeCloseTo(312.5 / 0.853, 8);
    expect(rate.status).toBe("live");
  });
});

describe("MnbReferenceClient", () => {
  it("normalizes MNB unit sizes and calculates cross rates", async () => {
    const inner = '<MNBCurrentExchangeRates><Day date="2026-09-30"><Rate unit="1" curr="EUR">366,31</Rate><Rate unit="1" curr="USD">322,48</Rate><Rate unit="100" curr="JPY">205,44</Rate></Day></MNBCurrentExchangeRates>';
    const escaped = inner
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    const soap = `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetCurrentExchangeRatesResponse xmlns="http://www.mnb.hu/webservices/"><GetCurrentExchangeRatesResult>${escaped}</GetCurrentExchangeRatesResult></GetCurrentExchangeRatesResponse></soap:Body></soap:Envelope>`;
    const fetchImpl: typeof fetch = async () => new Response(soap, { status: 200 });
    const client = new MnbReferenceClient({ fetchImpl });

    const rates = await client.getRates({ base: "EUR", quotes: ["HUF", "USD", "JPY"] });
    expect(rates[0].rate).toBeCloseTo(366.31, 8);
    expect(rates[1].rate).toBeCloseTo(366.31 / 322.48, 8);
    expect(rates[2].rate).toBeCloseTo(366.31 / (205.44 / 100), 8);
    expect(rates.every((rate) => rate.provider === "MNB")).toBe(true);
  });
});

describe("EcbReferenceClient", () => {
  it("calculates cross rates from EUR-anchored official data", async () => {
    const csv = [
      "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE",
      "EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-09-30,1.1360",
      "EXR.D.HUF.EUR.SP00.A,D,HUF,EUR,SP00,A,2026-09-30,366.31",
    ].join("\n");
    const fetchImpl: typeof fetch = async () => new Response(csv, { status: 200 });
    const client = new EcbReferenceClient({ fetchImpl });

    const rate = await client.getRate({ from: "USD", to: "HUF" });
    expect(rate.rate).toBeCloseTo(366.31 / 1.136, 8);
    expect(rate.provider).toBe("ECB");
    expect(rate.status).toBe("reference");
  });
});

describe("CurrencyEngine", () => {
  it("prefers live data and falls back to official reference data", async () => {
    let liveWorks = true;
    const live: CurrencyProvider = {
      id: "LIVE",
      kind: "live",
      async getRate(input) {
        const [rate] = await this.getRates!({ base: input.from, quotes: [input.to] });
        return rate;
      },
      async getRates(input) {
        if (!liveWorks) throw new CurrencyProviderError(503, "live down");
        return input.quotes.map((quote) => ({
          date: "2026-10-01",
          base: input.base,
          quote,
          rate: 367.12,
          timestamp: "2026-10-01T04:00:00.000Z",
          status: "live" as const,
          provider: "LIVE",
        }));
      },
      async getCurrencies() { return []; },
    };
    const reference: CurrencyProvider = {
      id: "MNB",
      kind: "reference",
      async getRate(input) {
        const [rate] = await this.getRates!({ base: input.from, quotes: [input.to] });
        return rate;
      },
      async getRates(input) {
        return input.quotes.map((quote) => ({
          date: "2026-09-30",
          base: input.base,
          quote,
          rate: 366.31,
          status: "reference" as const,
          provider: "MNB",
        }));
      },
      async getCurrencies() { return []; },
    };

    const engine = new CurrencyEngine({ live, references: [reference] });
    const first = await engine.getRate({ from: "EUR", to: "HUF" });
    expect(first).toMatchObject({ rate: 367.12, status: "live", provider: "LIVE" });

    liveWorks = false;
    const cached = await engine.getRate({ from: "EUR", to: "HUF" });
    expect(cached).toMatchObject({ rate: 367.12, status: "cached", provider: "LIVE_CACHE" });
  });

  it("uses official reference data when there is no live provider", async () => {
    const reference: CurrencyProvider = {
      id: "ECB",
      kind: "reference",
      async getRate(input) {
        return { date: "2026-09-30", base: input.from, quote: input.to, rate: 366.2, status: "reference", provider: "ECB" };
      },
      async getRates(input) {
        return input.quotes.map((quote) => ({ date: "2026-09-30", base: input.base, quote, rate: 366.2, status: "reference" as const, provider: "ECB" }));
      },
      async getCurrencies() { return []; },
    };
    const engine = new CurrencyEngine({ references: [reference] });
    const rate = await engine.getRate({ from: "EUR", to: "HUF" });
    expect(rate.provider).toBe("ECB");
    expect(rate.status).toBe("reference");
  });
});
