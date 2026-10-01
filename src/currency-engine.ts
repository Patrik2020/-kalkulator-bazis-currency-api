import { CurrencyProviderError } from "./errors.js";
import type {
  CurrencyInfo,
  CurrencyProvider,
  CurrencyRate,
  RateRequest,
  RatesRequest,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_LIVE_CACHE_MS = 60_000;
const DEFAULT_LIVE_STALE_MS = 15 * 60_000;
const DEFAULT_REFERENCE_STALE_MS = 48 * 60 * 60_000;

const SUPPORTED_CURRENCIES: CurrencyInfo[] = [
  { iso_code: "EUR", iso_numeric: "978", name: "Euro", symbol: "€" },
  { iso_code: "HUF", iso_numeric: "348", name: "Hungarian Forint", symbol: "Ft" },
  { iso_code: "USD", iso_numeric: "840", name: "US Dollar", symbol: "$" },
  { iso_code: "GBP", iso_numeric: "826", name: "Pound Sterling", symbol: "£" },
  { iso_code: "CHF", iso_numeric: "756", name: "Swiss Franc", symbol: "CHF" },
  { iso_code: "JPY", iso_numeric: "392", name: "Japanese Yen", symbol: "¥" },
  { iso_code: "CZK", iso_numeric: "203", name: "Czech Koruna", symbol: "Kč" },
  { iso_code: "PLN", iso_numeric: "985", name: "Polish Zloty", symbol: "zł" },
  { iso_code: "RON", iso_numeric: "946", name: "Romanian Leu", symbol: "lei" },
  { iso_code: "SEK", iso_numeric: "752", name: "Swedish Krona", symbol: "kr" },
  { iso_code: "NOK", iso_numeric: "578", name: "Norwegian Krone", symbol: "kr" },
  { iso_code: "DKK", iso_numeric: "208", name: "Danish Krone", symbol: "kr" },
  { iso_code: "CNY", iso_numeric: "156", name: "Chinese Yuan Renminbi", symbol: "¥" },
  { iso_code: "AUD", iso_numeric: "036", name: "Australian Dollar", symbol: "A$" },
  { iso_code: "CAD", iso_numeric: "124", name: "Canadian Dollar", symbol: "C$" },
  { iso_code: "NZD", iso_numeric: "554", name: "New Zealand Dollar", symbol: "NZ$" },
  { iso_code: "SGD", iso_numeric: "702", name: "Singapore Dollar", symbol: "S$" },
  { iso_code: "HKD", iso_numeric: "344", name: "Hong Kong Dollar", symbol: "HK$" },
  { iso_code: "MXN", iso_numeric: "484", name: "Mexican Peso", symbol: "$" },
  { iso_code: "BRL", iso_numeric: "986", name: "Brazilian Real", symbol: "R$" },
  { iso_code: "INR", iso_numeric: "356", name: "Indian Rupee", symbol: "₹" },
  { iso_code: "KRW", iso_numeric: "410", name: "South Korean Won", symbol: "₩" },
  { iso_code: "TRY", iso_numeric: "949", name: "Turkish Lira", symbol: "₺" },
  { iso_code: "ZAR", iso_numeric: "710", name: "South African Rand", symbol: "R" },
  { iso_code: "THB", iso_numeric: "764", name: "Thai Baht", symbol: "฿" },
  { iso_code: "ILS", iso_numeric: "376", name: "Israeli New Shekel", symbol: "₪" },
  { iso_code: "IDR", iso_numeric: "360", name: "Indonesian Rupiah", symbol: "Rp" },
  { iso_code: "MYR", iso_numeric: "458", name: "Malaysian Ringgit", symbol: "RM" },
  { iso_code: "PHP", iso_numeric: "608", name: "Philippine Peso", symbol: "₱" },
  { iso_code: "UAH", iso_numeric: "980", name: "Ukrainian Hryvnia", symbol: "₴" },
  { iso_code: "RSD", iso_numeric: "941", name: "Serbian Dinar", symbol: "дин" },
  { iso_code: "RUB", iso_numeric: "643", name: "Russian Ruble", symbol: "₽" },
  { iso_code: "ISK", iso_numeric: "352", name: "Icelandic Krona", symbol: "kr" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(",", "."));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function normalizeCurrency(value: string): string {
  return value.trim().toUpperCase();
}

function uniqueCurrencies(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeCurrency))];
}

function pairKey(base: string, quote: string): string {
  return `${normalizeCurrency(base)}:${normalizeCurrency(quote)}`;
}

function roundRate(value: number): number {
  return Number(value.toFixed(12));
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function normalizeTimestamp(value: unknown, now: () => Date): string {
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1_000;
    const parsed = new Date(milliseconds);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return now().toISOString();
}

function daysBefore(date: string, count: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  parsed.setUTCDate(parsed.getUTCDate() - count);
  return parsed.toISOString().slice(0, 10);
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function decodeXmlEntities(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    decoded = decoded
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  }
  return decoded.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (isRecord(error) && error.name === "AbortError") {
      throw new CurrencyProviderError(504, "Az árfolyamforrás nem válaszolt időben.");
    }
    throw new CurrencyProviderError(503, "Az árfolyamforrás átmenetileg nem érhető el.");
  } finally {
    clearTimeout(timeout);
  }
}

function makeSelfRate(currency: string, now: () => Date, provider: string, status: "live" | "reference" | "cached"): CurrencyRate {
  const timestamp = now().toISOString();
  return {
    date: timestamp.slice(0, 10),
    base: currency,
    quote: currency,
    rate: 1,
    timestamp,
    status,
    provider,
  };
}

type MarketQuote = {
  symbol: string;
  rate: number;
  timestamp: string;
};

type TradingViewDataOptions = {
  apiKey: string;
  baseUrl?: string;
  exchanges?: string[];
  timeoutMs?: number;
  cacheMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

/**
 * Near-real-time market quote adapter. The adapter is intentionally isolated from
 * the public API contract: it can be replaced without changing frontend calls.
 */
export class TradingViewDataClient implements CurrencyProvider {
  readonly id = "LIVE";
  readonly kind = "live" as const;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly exchanges: string[];
  private readonly timeoutMs: number;
  private readonly cacheMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly cache = new Map<string, { quote: CurrencyRate; expiresAt: number }>();

  constructor(options: TradingViewDataOptions) {
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) throw new Error("TradingViewDataClient requires an API key");
    this.baseUrl = (options.baseUrl ?? "https://api.tradingviewapi.com").replace(/\/+$/, "");
    this.exchanges = (options.exchanges?.length ? options.exchanges : ["FOREXCOM", "FX_IDC"])
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cacheMs = options.cacheMs ?? DEFAULT_LIVE_CACHE_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async getRate(input: RateRequest): Promise<CurrencyRate> {
    const [rate] = await this.getRates({
      base: input.from,
      quotes: [input.to],
      ...(input.provider ? { provider: input.provider } : {}),
    });
    if (!rate) throw new CurrencyProviderError(404, "A kért élő devizapár nem található.");
    return rate;
  }

  async getRates(input: RatesRequest): Promise<CurrencyRate[]> {
    if (input.date) {
      throw new CurrencyProviderError(400, "Az élő piaci feed historikus dátumot nem kezel ezen a végponton.");
    }

    const base = normalizeCurrency(input.base);
    const quotes = uniqueCurrencies(input.quotes);
    const output = new Map<string, CurrencyRate>();
    const unresolved: string[] = [];

    for (const quote of quotes) {
      if (quote === base) {
        output.set(quote, makeSelfRate(base, this.now, this.id, "live"));
        continue;
      }
      const cached = this.getCached(base, quote);
      if (cached) output.set(quote, cached);
      else unresolved.push(quote);
    }

    if (unresolved.length) {
      await this.resolveDirectAndInverse(base, unresolved);
      for (const quote of unresolved) {
        const resolved = this.getCached(base, quote);
        if (resolved) output.set(quote, resolved);
      }
    }

    const stillMissing = unresolved.filter((quote) => !output.has(quote));
    if (stillMissing.length) {
      await this.resolveViaUsd(base, stillMissing);
      for (const quote of stillMissing) {
        const resolved = this.getCached(base, quote);
        if (resolved) output.set(quote, resolved);
      }
    }

    const missing = quotes.filter((quote) => !output.has(quote));
    if (missing.length) {
      throw new CurrencyProviderError(404, `Nincs élő árfolyam ezekhez a devizákhoz: ${missing.join(",")}`);
    }

    return quotes.map((quote) => output.get(quote)!);
  }

  async getCurrencies(): Promise<CurrencyInfo[]> {
    return SUPPORTED_CURRENCIES;
  }

  private getCached(base: string, quote: string): CurrencyRate | undefined {
    const entry = this.cache.get(pairKey(base, quote));
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now().getTime()) {
      this.cache.delete(pairKey(base, quote));
      return undefined;
    }
    return { ...entry.quote };
  }

  private putCached(rate: CurrencyRate): void {
    const expiresAt = this.now().getTime() + this.cacheMs;
    this.cache.set(pairKey(rate.base, rate.quote), { quote: { ...rate }, expiresAt });
    if (rate.rate > 0) {
      this.cache.set(pairKey(rate.quote, rate.base), {
        quote: {
          ...rate,
          base: rate.quote,
          quote: rate.base,
          rate: roundRate(1 / rate.rate),
        },
        expiresAt,
      });
    }
  }

  private async resolveDirectAndInverse(base: string, quotes: string[]): Promise<void> {
    let pending = [...quotes];
    for (const exchange of this.exchanges) {
      if (!pending.length) break;

      const directSymbols = pending.map((quote) => `${exchange}:${base}${quote}`);
      const direct = await this.requestBatch(directSymbols);
      for (const quote of pending) {
        const symbol = `${exchange}:${base}${quote}`;
        const market = direct.get(symbol);
        if (market) this.putCached(this.marketToRate(base, quote, market));
      }
      pending = pending.filter((quote) => !this.getCached(base, quote));
      if (!pending.length) break;

      const inverseSymbols = pending.map((quote) => `${exchange}:${quote}${base}`);
      const inverse = await this.requestBatch(inverseSymbols);
      for (const quote of pending) {
        const symbol = `${exchange}:${quote}${base}`;
        const market = inverse.get(symbol);
        if (market && market.rate > 0) {
          this.putCached(this.marketToRate(base, quote, { ...market, rate: 1 / market.rate }));
        }
      }
      pending = pending.filter((quote) => !this.getCached(base, quote));
    }
  }

  private async resolveViaUsd(base: string, quotes: string[]): Promise<void> {
    if (base === "USD") return;
    const legs = uniqueCurrencies([base, ...quotes.filter((quote) => quote !== "USD")]);
    await this.resolveDirectAndInverse("USD", legs.filter((currency) => currency !== "USD"));

    const usdToBase = this.getCached("USD", base);
    if (!usdToBase) return;

    for (const quote of quotes) {
      if (quote === "USD") {
        const baseToUsd = this.getCached(base, "USD");
        if (baseToUsd) this.putCached(baseToUsd);
        continue;
      }
      const usdToQuote = this.getCached("USD", quote);
      if (!usdToQuote) continue;
      const timestamp = [usdToBase.timestamp, usdToQuote.timestamp].filter(Boolean).sort()[0]
        ?? this.now().toISOString();
      this.putCached({
        date: timestamp.slice(0, 10),
        base,
        quote,
        rate: roundRate(usdToQuote.rate / usdToBase.rate),
        timestamp,
        status: "live",
        provider: this.id,
      });
    }
  }

  private marketToRate(base: string, quote: string, market: MarketQuote): CurrencyRate {
    return {
      date: market.timestamp.slice(0, 10),
      base,
      quote,
      rate: roundRate(market.rate),
      timestamp: market.timestamp,
      status: "live",
      provider: this.id,
    };
  }

  private async requestBatch(symbols: string[]): Promise<Map<string, MarketQuote>> {
    const result = new Map<string, MarketQuote>();
    const unique = [...new Set(symbols)];

    for (let index = 0; index < unique.length; index += 10) {
      const chunk = unique.slice(index, index + 10);
      const response = await fetchWithTimeout(
        this.fetchImpl,
        `${this.baseUrl}/api/quote/batch`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({ symbols: chunk }),
        },
        this.timeoutMs,
      );

      if (!response.ok) {
        throw new CurrencyProviderError(
          response.status === 429 ? 503 : response.status,
          `Az élő piaci adatforrás HTTP ${response.status} hibát adott.`,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new CurrencyProviderError(502, "Az élő piaci adatforrás nem JSON választ adott.");
      }

      for (const item of this.extractBatchItems(payload)) {
        const quote = this.extractMarketQuote(item);
        if (quote) result.set(quote.symbol.toUpperCase(), quote);
      }
    }

    return result;
  }

  private extractBatchItems(payload: unknown): unknown[] {
    if (Array.isArray(payload)) return payload;
    if (!isRecord(payload)) return [];
    if (Array.isArray(payload.results)) return payload.results;
    if (Array.isArray(payload.data)) return payload.data;
    if (isRecord(payload.data)) {
      if (Array.isArray(payload.data.data)) return payload.data.data;
      if (Array.isArray(payload.data.results)) return payload.data.results;
      if (Array.isArray(payload.data.quotes)) return payload.data.quotes;
    }
    return [];
  }

  private extractMarketQuote(item: unknown): MarketQuote | undefined {
    if (!isRecord(item)) return undefined;
    const outerSymbol = typeof item.symbol === "string" ? item.symbol : undefined;
    let record: Record<string, unknown> = item;
    if (isRecord(record.data)) record = record.data;
    if (isRecord(record.data)) record = record.data;
    const symbol = outerSymbol ?? (typeof record.symbol === "string" ? record.symbol : undefined);
    if (!symbol) return undefined;

    const bid = positiveNumber(record.bid);
    const ask = positiveNumber(record.ask);
    const last = positiveNumber(record.lp)
      ?? positiveNumber(record.last)
      ?? positiveNumber(record.price)
      ?? positiveNumber(record.close);
    const rate = bid && ask ? (bid + ask) / 2 : last;
    if (!rate || !Number.isFinite(rate) || rate <= 0) return undefined;

    const timestamp = normalizeTimestamp(
      record.lp_time ?? record.rtc_time ?? record.timestamp ?? record.time,
      this.now,
    );
    return { symbol: symbol.toUpperCase(), rate, timestamp };
  }
}

type MnbOptions = {
  baseUrl?: string;
  timeoutMs?: number;
  cacheMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export class MnbReferenceClient implements CurrencyProvider {
  readonly id = "MNB";
  readonly kind = "reference" as const;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly cacheMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private snapshot?: { expiresAt: number; date: string; hufTo: Map<string, number> };

  constructor(options: MnbOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://www.mnb.hu/arfolyamok.asmx";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cacheMs = options.cacheMs ?? 15 * 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async getRate(input: RateRequest): Promise<CurrencyRate> {
    const [rate] = await this.getRates({
      base: input.from,
      quotes: [input.to],
      ...(input.date ? { date: input.date } : {}),
    });
    if (!rate) throw new CurrencyProviderError(404, "Az MNB árfolyam nem található.");
    return rate;
  }

  async getRates(input: RatesRequest): Promise<CurrencyRate[]> {
    if (input.date) {
      throw new CurrencyProviderError(400, "A historikus lekérdezést az ECB referencia-adapter kezeli.");
    }
    const base = normalizeCurrency(input.base);
    const quotes = uniqueCurrencies(input.quotes);
    const snapshot = await this.getSnapshot();
    return this.buildRates(base, quotes, snapshot.hufTo, snapshot.date);
  }

  async getCurrencies(): Promise<CurrencyInfo[]> {
    return SUPPORTED_CURRENCIES;
  }

  private async getSnapshot(): Promise<{ date: string; hufTo: Map<string, number> }> {
    if (this.snapshot && this.snapshot.expiresAt > this.now().getTime()) {
      return { date: this.snapshot.date, hufTo: new Map(this.snapshot.hufTo) };
    }

    const envelope = `<?xml version="1.0" encoding="utf-8"?>\n<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:mnb="http://www.mnb.hu/webservices/">\n  <soap:Body><mnb:GetCurrentExchangeRates /></soap:Body>\n</soap:Envelope>`;
    const response = await fetchWithTimeout(
      this.fetchImpl,
      this.baseUrl,
      {
        method: "POST",
        headers: {
          accept: "text/xml",
          "content-type": "text/xml; charset=utf-8",
          soapaction: '"http://www.mnb.hu/webservices/MNBArfolyamServiceSoap/GetCurrentExchangeRates"',
        },
        body: envelope,
      },
      this.timeoutMs,
    );

    if (!response.ok) {
      throw new CurrencyProviderError(response.status, `Az MNB HTTP ${response.status} hibát adott.`);
    }
    const text = await response.text();
    const resultMatch = text.match(/<GetCurrentExchangeRatesResult[^>]*>([\s\S]*?)<\/GetCurrentExchangeRatesResult>/i);
    const inner = decodeXmlEntities(resultMatch?.[1] ?? text);
    const dayMatch = inner.match(/<Day[^>]*date="([^"]+)"[^>]*>([\s\S]*?)<\/Day>/i);
    if (!dayMatch) throw new CurrencyProviderError(502, "Az MNB válasza nem tartalmaz napi árfolyamot.");

    const date = dayMatch[1];
    const hufTo = new Map<string, number>([["HUF", 1]]);
    const ratePattern = /<Rate[^>]*unit="([^"]+)"[^>]*curr="([^"]+)"[^>]*>([^<]+)<\/Rate>/gi;
    for (const match of dayMatch[2].matchAll(ratePattern)) {
      const unit = positiveNumber(match[1]);
      const value = positiveNumber(match[3]?.replace(/\s/g, ""));
      const currency = normalizeCurrency(match[2]);
      if (!unit || !value) continue;
      hufTo.set(currency, unit / value);
    }

    if (hufTo.size < 2) throw new CurrencyProviderError(502, "Az MNB válaszából nem olvasható árfolyam.");
    this.snapshot = {
      expiresAt: this.now().getTime() + this.cacheMs,
      date,
      hufTo: new Map(hufTo),
    };
    return { date, hufTo };
  }

  private buildRates(base: string, quotes: string[], hufTo: Map<string, number>, date: string): CurrencyRate[] {
    const baseValue = hufTo.get(base);
    if (!baseValue) throw new CurrencyProviderError(404, `Az MNB nem jegyzi a(z) ${base} devizát.`);
    return quotes.map((quote) => {
      const quoteValue = hufTo.get(quote);
      if (!quoteValue) throw new CurrencyProviderError(404, `Az MNB nem jegyzi a(z) ${quote} devizát.`);
      return {
        date,
        base,
        quote,
        rate: roundRate(quoteValue / baseValue),
        status: "reference" as const,
        provider: this.id,
      };
    });
  }
}

type EcbOptions = {
  baseUrl?: string;
  timeoutMs?: number;
  cacheMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

type EcbPoint = { rate: number; date: string };

export class EcbReferenceClient implements CurrencyProvider {
  readonly id = "ECB";
  readonly kind = "reference" as const;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly cacheMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private current?: { expiresAt: number; points: Map<string, EcbPoint> };

  constructor(options: EcbOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://data-api.ecb.europa.eu/service").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cacheMs = options.cacheMs ?? 30 * 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async getRate(input: RateRequest): Promise<CurrencyRate> {
    const [rate] = await this.getRates({
      base: input.from,
      quotes: [input.to],
      ...(input.date ? { date: input.date } : {}),
    });
    if (!rate) throw new CurrencyProviderError(404, "Az ECB árfolyam nem található.");
    return rate;
  }

  async getRates(input: RatesRequest): Promise<CurrencyRate[]> {
    const base = normalizeCurrency(input.base);
    const quotes = uniqueCurrencies(input.quotes);
    const needed = uniqueCurrencies([base, ...quotes]).filter((currency) => currency !== "EUR");
    const points = input.date
      ? await this.fetchPoints(needed, input.date)
      : await this.getCurrentPoints();
    points.set("EUR", { rate: 1, date: input.date ?? this.latestDate(points) ?? isoDate(this.now()) });

    const basePoint = points.get(base);
    if (!basePoint) throw new CurrencyProviderError(404, `Az ECB nem ad árfolyamot a(z) ${base} devizára.`);

    return quotes.map((quote) => {
      const quotePoint = points.get(quote);
      if (!quotePoint) throw new CurrencyProviderError(404, `Az ECB nem ad árfolyamot a(z) ${quote} devizára.`);
      const date = [basePoint.date, quotePoint.date].sort()[0];
      return {
        date,
        base,
        quote,
        rate: roundRate(quotePoint.rate / basePoint.rate),
        status: "reference" as const,
        provider: this.id,
      };
    });
  }

  async getCurrencies(): Promise<CurrencyInfo[]> {
    return SUPPORTED_CURRENCIES;
  }

  private async getCurrentPoints(): Promise<Map<string, EcbPoint>> {
    if (this.current && this.current.expiresAt > this.now().getTime()) {
      return new Map(this.current.points);
    }
    const currencies = SUPPORTED_CURRENCIES
      .map((currency) => currency.iso_code)
      .filter((currency) => currency !== "EUR");
    const points = await this.fetchPoints(currencies);
    this.current = { expiresAt: this.now().getTime() + this.cacheMs, points: new Map(points) };
    return points;
  }

  private async fetchPoints(currencies: string[], date?: string): Promise<Map<string, EcbPoint>> {
    if (!currencies.length) return new Map();
    const key = `D.${currencies.join("+")}.EUR.SP00.A`;
    const params = new URLSearchParams({ format: "csvdata", detail: "dataonly" });
    if (date) {
      params.set("startPeriod", daysBefore(date, 7));
      params.set("endPeriod", date);
    } else {
      params.set("lastNObservations", "1");
    }
    const response = await fetchWithTimeout(
      this.fetchImpl,
      `${this.baseUrl}/data/EXR/${key}?${params.toString()}`,
      { headers: { accept: "text/csv" } },
      this.timeoutMs,
    );
    if (!response.ok) {
      throw new CurrencyProviderError(response.status, `Az ECB HTTP ${response.status} hibát adott.`);
    }
    const text = await response.text();
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) throw new CurrencyProviderError(502, "Az ECB üres választ adott.");
    const headers = parseCsvLine(lines[0]);
    const currencyIndex = headers.indexOf("CURRENCY");
    const dateIndex = headers.indexOf("TIME_PERIOD");
    const valueIndex = headers.indexOf("OBS_VALUE");
    if (currencyIndex < 0 || dateIndex < 0 || valueIndex < 0) {
      throw new CurrencyProviderError(502, "Az ECB CSV formátuma megváltozott.");
    }

    const points = new Map<string, EcbPoint>();
    for (const line of lines.slice(1)) {
      const cells = parseCsvLine(line);
      const currency = normalizeCurrency(cells[currencyIndex] ?? "");
      const pointDate = cells[dateIndex] ?? "";
      const rate = positiveNumber(cells[valueIndex]);
      if (!currency || !pointDate || !rate) continue;
      const previous = points.get(currency);
      if (!previous || previous.date < pointDate) points.set(currency, { rate, date: pointDate });
    }
    if (!points.size) throw new CurrencyProviderError(404, "Az ECB nem adott találatot a kért időszakra.");
    return points;
  }

  private latestDate(points: Map<string, EcbPoint>): string | undefined {
    return [...points.values()].map((point) => point.date).sort().at(-1);
  }
}

type EngineOptions = {
  live?: CurrencyProvider;
  references?: CurrencyProvider[];
  liveStaleMs?: number;
  referenceStaleMs?: number;
  now?: () => Date;
};

type StoredRate = { rate: CurrencyRate; storedAt: number };

export class CurrencyEngine implements CurrencyProvider {
  readonly id = "ENGINE";

  private readonly live?: CurrencyProvider;
  private readonly references: CurrencyProvider[];
  private readonly liveStaleMs: number;
  private readonly referenceStaleMs: number;
  private readonly now: () => Date;
  private readonly lastKnownGood = new Map<string, StoredRate>();

  constructor(options: EngineOptions = {}) {
    this.live = options.live;
    this.references = options.references ?? [new MnbReferenceClient(), new EcbReferenceClient()];
    this.liveStaleMs = options.liveStaleMs ?? DEFAULT_LIVE_STALE_MS;
    this.referenceStaleMs = options.referenceStaleMs ?? DEFAULT_REFERENCE_STALE_MS;
    this.now = options.now ?? (() => new Date());
  }

  async getRate(input: RateRequest): Promise<CurrencyRate> {
    const [rate] = await this.getRates({
      base: input.from,
      quotes: [input.to],
      ...(input.date ? { date: input.date } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
    });
    if (!rate) throw new CurrencyProviderError(404, "A kért árfolyam nem található.");
    return rate;
  }

  async getRates(input: RatesRequest): Promise<CurrencyRate[]> {
    const base = normalizeCurrency(input.base);
    const quotes = uniqueCurrencies(input.quotes);
    if (!quotes.length) return [];
    const requestedProvider = input.provider?.toUpperCase();

    if (requestedProvider && requestedProvider !== "AUTO" && requestedProvider !== "ENGINE") {
      const selected = this.findProvider(requestedProvider);
      if (!selected) throw new CurrencyProviderError(400, `Ismeretlen árfolyamforrás: ${requestedProvider}`);
      const rates = await selected.getRates({ base, quotes, ...(input.date ? { date: input.date } : {}) });
      this.remember(rates);
      return rates;
    }

    let lastError: unknown;

    if (!input.date && this.live) {
      try {
        const liveRates = await this.live.getRates({ base, quotes });
        this.remember(liveRates);
        return liveRates;
      } catch (error) {
        lastError = error;
        const cachedLive = this.readCached(base, quotes, this.liveStaleMs, true);
        if (cachedLive) return cachedLive;
      }
    }

    const references = input.date
      ? this.references.filter((provider) => provider.id !== "MNB")
      : this.references;

    for (const reference of references) {
      try {
        const rates = await reference.getRates({
          base,
          quotes,
          ...(input.date ? { date: input.date } : {}),
        });
        this.remember(rates);
        return rates;
      } catch (error) {
        lastError = error;
      }
    }

    const cachedReference = this.readCached(base, quotes, this.referenceStaleMs, false);
    if (cachedReference) return cachedReference;

    if (lastError instanceof CurrencyProviderError) throw lastError;
    throw new CurrencyProviderError(503, "Egyik árfolyamforrás sem érhető el.");
  }

  async getCurrencies(): Promise<CurrencyInfo[]> {
    return SUPPORTED_CURRENCIES;
  }

  private findProvider(id: string): CurrencyProvider | undefined {
    if (id === "LIVE") return this.live;
    return this.references.find((provider) => provider.id?.toUpperCase() === id);
  }

  private remember(rates: CurrencyRate[]): void {
    const storedAt = this.now().getTime();
    for (const rate of rates) {
      this.lastKnownGood.set(pairKey(rate.base, rate.quote), { rate: { ...rate }, storedAt });
      if (rate.rate > 0) {
        this.lastKnownGood.set(pairKey(rate.quote, rate.base), {
          rate: {
            ...rate,
            base: rate.quote,
            quote: rate.base,
            rate: roundRate(1 / rate.rate),
          },
          storedAt,
        });
      }
    }
  }

  private readCached(base: string, quotes: string[], maxAgeMs: number, liveOnly: boolean): CurrencyRate[] | undefined {
    const now = this.now().getTime();
    const rates: CurrencyRate[] = [];
    for (const quote of quotes) {
      if (base === quote) {
        rates.push(makeSelfRate(base, this.now, "CACHE", "cached"));
        continue;
      }
      const entry = this.lastKnownGood.get(pairKey(base, quote));
      if (!entry || now - entry.storedAt > maxAgeMs) return undefined;
      if (liveOnly && entry.rate.status !== "live") return undefined;
      rates.push({
        ...entry.rate,
        status: "cached",
        provider: entry.rate.provider ? `${entry.rate.provider}_CACHE` : "CACHE",
      });
    }
    return rates;
  }
}

export function createDefaultCurrencyEngine(): CurrencyEngine {
  const liveApiKey = process.env.TRADINGVIEW_API_KEY?.trim();
  const live = liveApiKey
    ? new TradingViewDataClient({
        apiKey: liveApiKey,
        baseUrl: process.env.TRADINGVIEW_BASE_URL,
        exchanges: process.env.TRADINGVIEW_FX_EXCHANGES?.split(",").map((value) => value.trim()).filter(Boolean),
        timeoutMs: Number(process.env.TRADINGVIEW_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
        cacheMs: Number(process.env.LIVE_RATE_CACHE_MS) || DEFAULT_LIVE_CACHE_MS,
      })
    : undefined;

  return new CurrencyEngine({
    live,
    references: [
      new MnbReferenceClient({
        baseUrl: process.env.MNB_BASE_URL,
        timeoutMs: Number(process.env.MNB_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
      }),
      new EcbReferenceClient({
        baseUrl: process.env.ECB_BASE_URL,
        timeoutMs: Number(process.env.ECB_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
      }),
    ],
    liveStaleMs: Number(process.env.LIVE_STALE_MAX_MS) || DEFAULT_LIVE_STALE_MS,
    referenceStaleMs: Number(process.env.REFERENCE_STALE_MAX_MS) || DEFAULT_REFERENCE_STALE_MS,
  });
}

export { SUPPORTED_CURRENCIES };
