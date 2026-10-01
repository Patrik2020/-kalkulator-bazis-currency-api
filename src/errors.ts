export class CurrencyProviderError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "CurrencyProviderError";
  }
}
