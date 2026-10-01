import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyError } from "fastify";
import { createDefaultCurrencyEngine } from "./currency-engine.js";
import { CurrencyProviderError } from "./errors.js";
import type { CurrencyProvider, CurrencyRate } from "./types.js";

const SERVICE_NAME = "kalkulator-bazis-currency-api";
const VERSION = "0.2.0";
const DEFAULT_ORIGINS = [
  "https://kalkulatorbazis.hu",
  "https://www.kalkulatorbazis.hu",
  "http://localhost:3000",
];

export type BuildAppOptions = {
  provider?: CurrencyProvider;
  corsOrigins?: readonly string[];
  rateLimitMax?: number;
  docsEnabled?: boolean;
  trustProxy?: boolean;
};

type RateQuery = {
  from: string;
  to: string;
  date?: string;
  provider?: string;
};

type RatesQuery = {
  base: string;
  quotes: string;
  date?: string;
  provider?: string;
};

type ConvertQuery = RateQuery & {
  amount: number;
};

type CurrenciesQuery = {
  provider?: string;
};

const currencyCode = {
  type: "string",
  pattern: "^[A-Za-z]{3}$",
  description: "ISO 4217 devizakód, például EUR, USD vagy HUF.",
} as const;

const date = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  description: "Opcionális historikus dátum YYYY-MM-DD formátumban.",
} as const;

const providerCode = {
  type: "string",
  pattern: "^[A-Za-z0-9_-]{2,20}$",
  description: "Opcionális forrás: AUTO, LIVE, MNB vagy ECB.",
} as const;

const rateQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to"],
  properties: {
    from: currencyCode,
    to: currencyCode,
    date,
    provider: providerCode,
  },
} as const;

const ratesQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["base", "quotes"],
  properties: {
    base: currencyCode,
    quotes: {
      type: "string",
      pattern: "^[A-Za-z]{3}(,[A-Za-z]{3}){0,49}$",
      maxLength: 199,
      description: "Vesszővel elválasztott cél-devizák, például HUF,USD,GBP.",
    },
    date,
    provider: providerCode,
  },
} as const;

const convertQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["amount", "from", "to"],
  properties: {
    amount: {
      type: "number",
      exclusiveMinimum: 0,
      maximum: 1_000_000_000_000,
      description: "Átváltandó pozitív összeg.",
    },
    from: currencyCode,
    to: currencyCode,
    date,
    provider: providerCode,
  },
} as const;

function normalizeCurrency(value: string): string {
  return value.toUpperCase();
}

function normalizeQuotes(value: string): string[] {
  return [...new Set(value.split(",").map(normalizeCurrency))];
}

function normalizeProvider(value: string | undefined): string | undefined {
  return value?.toUpperCase();
}

function rounded(value: number): number {
  return Number(value.toFixed(8));
}

function providerErrorStatus(error: CurrencyProviderError): number {
  if (error.statusCode === 404) return 404;
  if (error.statusCode === 400 || error.statusCode === 422) return 400;
  if (error.statusCode === 502) return 502;
  if (error.statusCode === 504) return 504;
  return 503;
}

function providerErrorCode(status: number): string {
  if (status === 404) return "RATE_NOT_FOUND";
  if (status === 400) return "RATE_SOURCE_REJECTED";
  if (status === 502) return "RATE_SOURCE_BAD_RESPONSE";
  if (status === 504) return "RATE_SOURCE_TIMEOUT";
  return "RATE_SOURCE_UNAVAILABLE";
}

function providerPublicMessage(status: number): string {
  if (status === 404) return "A kért árfolyam nem található.";
  if (status === 400) return "Az árfolyammotor nem tudja teljesíteni ezt a kérést.";
  if (status === 502) return "Az árfolyamforrás érvénytelen választ adott.";
  if (status === 504) return "Az árfolyamforrás nem válaszolt időben.";
  return "Az árfolyamforrás átmenetileg nem érhető el.";
}

function rateMeta(rates: CurrencyRate[], selectedProvider?: string) {
  const providers = [...new Set(rates.map((rate) => rate.provider).filter((value): value is string => Boolean(value)))];
  const statuses = [...new Set(rates.map((rate) => rate.status).filter((value): value is NonNullable<CurrencyRate["status"]> => Boolean(value)))];
  const timestamps = rates
    .map((rate) => rate.timestamp)
    .filter((value): value is string => Boolean(value))
    .sort();

  return {
    source: "Kalkulátor Bázis Currency Engine",
    provider: selectedProvider ?? (providers.length === 1 ? providers[0] : providers.length ? "MIXED" : "AUTO"),
    status: statuses.length === 1 ? statuses[0] : statuses.length ? "mixed" : "unknown",
    ...(timestamps.length ? { rateTimestamp: timestamps[0] } : {}),
    fetchedAt: new Date().toISOString(),
  };
}

export async function buildApp(options: BuildAppOptions = {}) {
  const provider = options.provider ?? createDefaultCurrencyEngine();
  const corsOrigins = new Set(options.corsOrigins ?? (
    process.env.CORS_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean)
    || DEFAULT_ORIGINS
  ));
  const docsEnabled = options.docsEnabled ?? process.env.DOCS_ENABLED !== "false";
  const maxRequests = options.rateLimitMax ?? (Number(process.env.RATE_LIMIT_MAX) || 120);
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === "true";

  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    bodyLimit: 65_536,
    trustProxy,
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof CurrencyProviderError) {
      const status = providerErrorStatus(error);
      if (status >= 500) {
        request.log.warn({ requestId: request.id, status }, "Currency rate source error");
      }
      return reply.status(status).send({
        error: {
          code: providerErrorCode(status),
          message: providerPublicMessage(status),
          requestId: request.id,
        },
      });
    }

    const corsDenied = error.message === "Origin not allowed";
    const status = corsDenied ? 403 : (error.statusCode ?? 500);
    const code = corsDenied
      ? "CORS_ORIGIN_DENIED"
      : status === 429
        ? "RATE_LIMITED"
        : status >= 500
          ? "INTERNAL_ERROR"
          : "INVALID_REQUEST";

    if (status >= 500) {
      request.log.error({ err: error, requestId: request.id }, "Unhandled request error");
    }

    return reply.status(status).send({
      error: {
        code,
        message: status >= 500
          ? "Váratlan szerverhiba történt."
          : corsDenied
            ? "A kérés eredete nincs engedélyezve."
            : error.message,
        requestId: request.id,
      },
    });
  });

  await app.register(helmet, docsEnabled ? { contentSecurityPolicy: false } : {});
  await app.register(cors, {
    strictPreflight: true,
    origin(origin, callback) {
      if (!origin || corsOrigins.has(origin)) callback(null, true);
      else callback(new Error("Origin not allowed"), false);
    },
  });
  await app.register(rateLimit, {
    max: maxRequests,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.ip,
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Kalkulátor Bázis Currency API",
        version: VERSION,
        description: "Saját többforrásos devizaárfolyam-motor élő piaci, MNB és ECB fallback réteggel.",
      },
      tags: [
        { name: "system", description: "Rendszerállapot" },
        { name: "currency", description: "Devizaárfolyamok és átváltás" },
      ],
    },
  });

  if (docsEnabled) {
    await app.register(swaggerUi, { routePrefix: "/docs" });
  }

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-request-id", request.id);
    return payload;
  });

  app.get("/", async (_request, reply) => {
    if (docsEnabled) return reply.redirect("/docs");
    return reply.send({ name: SERVICE_NAME, version: VERSION });
  });

  app.get(
    "/health",
    {
      schema: {
        tags: ["system"],
        summary: "Szolgáltatás állapota",
      },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    () => ({
      status: "ok" as const,
      service: SERVICE_NAME,
      version: VERSION,
      engine: "currency-engine-v2",
      liveFeedConfigured: Boolean(process.env.TRADINGVIEW_API_KEY?.trim()),
      timestamp: new Date().toISOString(),
    }),
  );

  app.get("/api/v1", {
    schema: { tags: ["system"], summary: "API információ" },
  }, () => ({
    name: SERVICE_NAME,
    version: VERSION,
    engine: "currency-engine-v2",
    endpoints: [
      "/api/v1/rate",
      "/api/v1/rates",
      "/api/v1/convert",
      "/api/v1/currencies",
    ],
    source: "Kalkulátor Bázis Currency Engine",
    sourcePriority: ["LIVE", "MNB", "ECB", "LAST_KNOWN_GOOD"],
  }));

  app.get<{ Querystring: RateQuery }>(
    "/api/v1/rate",
    {
      schema: {
        tags: ["currency"],
        summary: "Egy devizapár árfolyama",
        querystring: rateQuerySchema,
      },
    },
    async (request) => {
      const from = normalizeCurrency(request.query.from);
      const to = normalizeCurrency(request.query.to);
      const selectedProvider = normalizeProvider(request.query.provider);
      const rate = await provider.getRate({
        from,
        to,
        ...(request.query.date ? { date: request.query.date } : {}),
        ...(selectedProvider ? { provider: selectedProvider } : {}),
      });

      return {
        data: rate,
        meta: rateMeta([rate], selectedProvider),
      };
    },
  );

  app.get<{ Querystring: RatesQuery }>(
    "/api/v1/rates",
    {
      schema: {
        tags: ["currency"],
        summary: "Több cél-deviza árfolyama egy kérésben",
        querystring: ratesQuerySchema,
      },
    },
    async (request) => {
      const base = normalizeCurrency(request.query.base);
      const quotes = normalizeQuotes(request.query.quotes).filter((quote) => quote !== base);
      const selectedProvider = normalizeProvider(request.query.provider);
      if (quotes.length === 0) {
        return {
          data: [],
          meta: {
            count: 0,
            ...rateMeta([], selectedProvider),
          },
        };
      }

      const rates = await provider.getRates({
        base,
        quotes,
        ...(request.query.date ? { date: request.query.date } : {}),
        ...(selectedProvider ? { provider: selectedProvider } : {}),
      });

      return {
        data: rates,
        meta: {
          count: rates.length,
          ...rateMeta(rates, selectedProvider),
        },
      };
    },
  );

  app.get<{ Querystring: ConvertQuery }>(
    "/api/v1/convert",
    {
      schema: {
        tags: ["currency"],
        summary: "Deviza átváltása",
        querystring: convertQuerySchema,
      },
    },
    async (request) => {
      const from = normalizeCurrency(request.query.from);
      const to = normalizeCurrency(request.query.to);
      const selectedProvider = normalizeProvider(request.query.provider);
      const rate = await provider.getRate({
        from,
        to,
        ...(request.query.date ? { date: request.query.date } : {}),
        ...(selectedProvider ? { provider: selectedProvider } : {}),
      });
      const amount = request.query.amount;

      return {
        data: {
          amount,
          from,
          to,
          rate: rate.rate,
          convertedAmount: rounded(amount * rate.rate),
          rateDate: rate.date,
          ...(rate.timestamp ? { rateTimestamp: rate.timestamp } : {}),
        },
        meta: {
          ...rateMeta([rate], selectedProvider),
          disclaimer: "Tájékoztató közép-/referenciaárfolyam; banki, készpénzes és kártyaelszámolási árfolyam eltérhet.",
        },
      };
    },
  );

  app.get<{ Querystring: CurrenciesQuery }>(
    "/api/v1/currencies",
    {
      schema: {
        tags: ["currency"],
        summary: "Támogatott devizák listája",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { provider: providerCode },
        },
      },
    },
    async (request) => {
      const selectedProvider = normalizeProvider(request.query.provider);
      const currencies = await provider.getCurrencies(
        selectedProvider ? { provider: selectedProvider } : {},
      );
      return {
        data: currencies,
        meta: {
          count: currencies.length,
          source: "Kalkulátor Bázis Currency Engine",
          provider: selectedProvider ?? "ENGINE",
          fetchedAt: new Date().toISOString(),
        },
      };
    },
  );

  return app;
}
