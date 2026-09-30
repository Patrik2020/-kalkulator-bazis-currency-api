export type CurrencyRate = {
  date: string;
  base: string;
  quote: string;
  rate: number;
};

export type CurrencyInfo = {
  iso_code: string;
  iso_numeric?: string | null;
  name: string;
  symbol?: string | null;
  start_date?: string | null;
  end_date?: string | null;
};

export type RateRequest = {
  from: string;
  to: string;
  date?: string;
  provider?: string;
};

export type RatesRequest = {
  base: string;
  quotes: string[];
  date?: string;
  provider?: string;
};

export interface CurrencyProvider {
  getRate(input: RateRequest): Promise<CurrencyRate>;
  getRates(input: RatesRequest): Promise<CurrencyRate[]>;
  getCurrencies(input?: { provider?: string }): Promise<CurrencyInfo[]>;
}
