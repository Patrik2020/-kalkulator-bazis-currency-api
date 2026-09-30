import type {
  CurrencyInfo,
  CurrencyProvider,
  CurrencyRate,
  RateRequest,
  RatesRequest,
} from "./types.js";

export class CurrencyProviderError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "CurrencyProviderError";
  }
}

type FrankfurterOptions = {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRate(value: unknown): CurrencyRate {
  if (
    !isRecord(value)
    || typeof value.date !== "string"
    || typeof value.base !== "string"
    || typeof value.quote !== "string"
    || typeof value.rate !== "number"
    || !Number.isFinite(value.rate)
    || value.rate <= 0
  ) {
    throw new CurrencyProviderError(502, "Az árfolyam-szolgáltató érvénytelen választ adott.");
  }

  return {
    date: value.date,
    base: value.base.toUpperCase(),
    quote: value.quote.toUpperCase(),
    rate: value.rate,
  };
}

function normalizeRates(value: unknown): CurrencyRate[] {
  if (!Array.isArray(value)) {
    throw new CurrencyProviderError(502, "Az árfolyam-szolgáltató érvénytelen árfolyamlistát adott.");
  }
  return value.map(normalizeRate);
}

function normalizeCurrencies(value: unknown): CurrencyInfo[] {
  if (!Array.isArray(value)) {
    throw new CurrencyProviderError(502, "Az árfolyam-szolgáltató érvénytelen devizalistát adott.");
  }

  return value.map((item) => {
    if (!isRecord(item) || typeof item.iso_code !== "string" || typeof item.name !== "string") {
      throw new CurrencyProviderError(502, "Az árfolyam-szolgáltató érvénytelen devizalistát adott.");
    }

    return {
      iso_code: item.iso_code.toUpperCase(),
      name: item.name,
      ...(typeof item.iso_numeric === "string" || item.iso_numeric === null
        ? { iso_numeric: item.iso_numeric }
        : {}),
      ...(typeof item.symbol === "string" || item.symbol === null ? { symbol: item.symbol } : {}),
      ...(typeof item.start_date === "string" || item.start_date === null
        ? { start_date: item.start_date }
        : {}),
      ...(typeof item.end_date === "string" || item.end_date === null
        ? { end_date: item.end_date }
        : {}),
    };
  });
}

export class FrankfurterClient implements CurrencyProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FrankfurterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.frankfurter.dev/v2").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getRate(input: RateRequest): Promise<CurrencyRate> {
    const from = input.from.toUpperCase();
    const to = input.to.toUpperCase();
    const params = new URLSearchParams();
    if (input.date) params.set("date", input.date);
    if (input.provider) params.set("providers", input.provider.toUpperCase());

    const query = params.size ? `?${params.toString()}` : "";
    const payload = await this.request<unknown>(
      `/rate/${encodeURIComponent(from)}/${encodeURIComponent(to)}${query}`,
    );
    return normalizeRate(payload);
  }

  async getRates(input: RatesRequest): Promise<CurrencyRate[]> {
    const base = input.base.toUpperCase();
    const quotes = [...new Set(input.quotes.map((quote) => quote.toUpperCase()))];
    const params = new URLSearchParams({
      base,
      quotes: quotes.join(","),
    });
    if (input.date) params.set("date", input.date);
    if (input.provider) params.set("providers", input.provider.toUpperCase());

    const rates = normalizeRates(await this.request<unknown>(`/rates?${params.toString()}`));
    return rates.filter((rate) => rate.base === base && quotes.includes(rate.quote));
  }

  async getCurrencies(input: { provider?: string } = {}): Promise<CurrencyInfo[]> {
    const params = new URLSearchParams();
    if (input.provider) params.set("providers", input.provider.toUpperCase());
    const query = params.size ? `?${params.toString()}` : "";
    return normalizeCurrencies(await this.request<unknown>(`/currencies${query}`));
  }

  private async request<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });

      if (!response.ok) {
        let message = `Az árfolyam-szolgáltató HTTP ${response.status} hibát adott.`;
        try {
          const body: unknown = await response.json();
          if (isRecord(body) && typeof body.message === "string" && body.message.trim()) {
            message = body.message;
          }
        } catch {
          // Keep the generic safe message when the upstream body is not JSON.
        }
        throw new CurrencyProviderError(response.status, message);
      }

      return await response.json() as T;
    } catch (error) {
      if (error instanceof CurrencyProviderError) throw error;
      if (isRecord(error) && error.name === "AbortError") {
        throw new CurrencyProviderError(504, "Az árfolyam-szolgáltató nem válaszolt időben.");
      }
      throw new CurrencyProviderError(503, "Az árfolyam-szolgáltató átmenetileg nem érhető el.");
    } finally {
      clearTimeout(timeout);
    }
  }
}
