import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyError } from "fastify";
import { CurrencyProviderError, FrankfurterClient } from "./frankfurter.js";
import type { CurrencyProvider } from "./types.js";

const SERVICE_NAME = "kalkulator-bazis-currency-api";
const VERSION = "0.1.0";
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
  description: "Opcionális Frankfurter forráskulcs, például ECB.",
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
  if (status === 400) return "UPSTREAM_REJECTED";
  if (status === 502) return "UPSTREAM_BAD_RESPONSE";
  if (status === 504) return "UPSTREAM_TIMEOUT";
  return "UPSTREAM_UNAVAILABLE";
}

export async function buildApp(options: BuildAppOptions = {}) {
  const provider = options.provider ?? new FrankfurterClient({
    baseUrl: process.env.FRANKFURTER_BASE_URL,
    timeoutMs: Number(process.env.FRANKFURTER_TIMEOUT_MS) || 5_000,
  });
  const corsOrigins = new Set(options.corsOrigins ?? (
    process.env.CORS_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean)
    || DEFAULT_ORIGINS
  ));
  const docsEnabled = options.docsEnabled ?? process.env.DOCS_ENABLED !== "false";
  const maxRequests = options.rateLimitMax ?? (Number(process.env.RATE_LIMIT_MAX) || 120);

  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    bodyLimit: 65_536,
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof CurrencyProviderError) {
      const status = providerErrorStatus(error);
      if (status >= 500) {
        request.log.warn({ requestId: request.id, status }, "Currency provider error");
      }
      return reply.status(status).send({
        error: {
          code: providerErrorCode(status),
          message: error.message,
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

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    strictPreflight: true,
    origin(origin, callback) {
      if (!origin || corsOrigins.has(origin)) callback(null, true);
      else callback(new Error("Origin not allowed"), false);
    },
  });
  await app.register(rateLimit, { max: maxRequests, timeWindow: "1 minute" });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Kalkulátor Bázis Currency API",
        version: VERSION,
        description: "Devizaárfolyam- és devizaváltó API Frankfurter v2 adatokra építve.",
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
      timestamp: new Date().toISOString(),
    }),
  );

  app.get("/api/v1", {
    schema: { tags: ["system"], summary: "API információ" },
  }, () => ({
    name: SERVICE_NAME,
    version: VERSION,
    endpoints: [
      "/api/v1/rate",
      "/api/v1/rates",
      "/api/v1/convert",
      "/api/v1/currencies",
    ],
    source: "Frankfurter v2",
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
        meta: {
          source: "Frankfurter v2",
          provider: selectedProvider ?? "blended",
          fetchedAt: new Date().toISOString(),
        },
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
            source: "Frankfurter v2",
            provider: selectedProvider ?? "blended",
            fetchedAt: new Date().toISOString(),
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
          source: "Frankfurter v2",
          provider: selectedProvider ?? "blended",
          fetchedAt: new Date().toISOString(),
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
        },
        meta: {
          source: "Frankfurter v2",
          provider: selectedProvider ?? "blended",
          fetchedAt: new Date().toISOString(),
          disclaimer: "Referenciaárfolyam-alapú tájékoztató átváltás; banki és készpénzes árfolyam eltérhet.",
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
          source: "Frankfurter v2",
          provider: selectedProvider ?? "all",
          fetchedAt: new Date().toISOString(),
        },
      };
    },
  );

  return app;
}
