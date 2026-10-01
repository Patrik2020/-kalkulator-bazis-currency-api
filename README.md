# Kalkulátor Bázis Currency API

Saját, TypeScript + Fastify alapú devizaárfolyam- és devizaváltó backend a Kalkulátor Bázishoz.

## Currency Engine v2

A `0.2.0` verziótól az API már nem a Frankfurter kliensére épül. A saját `CurrencyEngine` dönti el, melyik forrást használja, normalizálja az adatokat, keresztárfolyamot számol, cache-el és fallbackel.

Forrásprioritás aktuális árfolyamhoz:

1. `LIVE` – közel valós idejű piaci quote feed, ha a szerveren van érvényes live API-kulcs.
2. `LIVE_CACHE` – utolsó jó élő ár, rövid ideig használható feed-kieséskor.
3. `MNB` – a Magyar Nemzeti Bank hivatalos napi referenciaárfolyamai.
4. `ECB` – az Európai Központi Bank hivatalos napi referenciaárfolyamai.
5. `LAST_KNOWN_GOOD` – folyamaton belüli utolsó jó referenciaadat, korlátozott ideig.

Historikus dátumnál az API hivatalos referenciaforrást használ.

A frontend kizárólag a Kalkulátor Bázis API-ját hívja. A live feed adapter később cserélhető anélkül, hogy a weboldali API-szerződés változna.

## Mit jelent itt a „saját” árfolyam-motor?

A szolgáltatás, az API-szerződés, a forrásválasztás, a cross-rate logika, a cache, a fallback, a validáció, a hibakezelés és a deploy a Kalkulátor Bázisé.

A valós piaci árfolyam maga külső market-data feedből érkezik: ilyen adatot nem lehet hitelesen „kiszámolni” külső piaci információ nélkül. A motor ezért provider-független réteget használ, és nem köti a frontendet egyetlen adatszolgáltatóhoz.

## Live market feed

A jelenlegi live adapter a TradingView Data API harmadik féltől származó szolgáltatására van felkészítve. Ez nem a TradingView, Inc. hivatalos API-ja. A provider dokumentációja szerint a saját alkalmazásban történő megjelenítés, cache-elés és továbbítás engedélyezett a szolgáltatási feltételek és az előfizetési limit keretei között; production használat előtt a licencet és az aktuális feltételeket újra ellenőrizni kell.

A live adapter legfeljebb 10 devizapárt kér egyszerre batch-ben, a quote-okat rövid ideig szerveroldalon cache-eli, bid/ask esetén középárfolyamot számol, és szükség esetén inverz vagy USD-n keresztüli keresztárfolyamot képez.

Live feed nélkül az API továbbra is működik MNB/ECB referenciaadatokkal.

## Funkciók

- aktuális devizapár-árfolyam
- több cél-deviza egyetlen kérésben
- közel valós idejű piaci árfolyam live feed esetén
- MNB + ECB hivatalos fallback
- inverz és USD-alapú cross-rate számítás
- historikus referenciaárfolyam
- konkrét összeg átváltása
- támogatott devizák listázása
- utolsó ismert jó ár rövid idejű fallbackként
- JSON Schema validáció
- szűk böngészős CORS allowlist
- kliens-IP alapú rate limit
- request ID minden válaszban
- szanitizált hibakezelés
- opcionális Swagger/OpenAPI dokumentáció
- npm audit, Dependabot, CodeQL és production smoke

## Végpontok

```http
GET /health
GET /api/v1
GET /api/v1/rate?from=EUR&to=HUF
GET /api/v1/rates?base=EUR&quotes=HUF,USD,GBP
GET /api/v1/convert?amount=100&from=EUR&to=HUF
GET /api/v1/currencies
```

Opcionális forráskényszerítés:

```http
GET /api/v1/rate?from=EUR&to=HUF&provider=LIVE
GET /api/v1/rate?from=EUR&to=HUF&provider=MNB
GET /api/v1/rate?from=EUR&to=HUF&provider=ECB
```

Alapértelmezésben `AUTO` módban a motor választ.

Példa válasz:

```json
{
  "data": {
    "date": "2026-10-01",
    "base": "EUR",
    "quote": "HUF",
    "rate": 367.21,
    "timestamp": "2026-10-01T04:15:22.000Z",
    "status": "live",
    "provider": "LIVE"
  },
  "meta": {
    "source": "Kalkulátor Bázis Currency Engine",
    "provider": "LIVE",
    "status": "live",
    "rateTimestamp": "2026-10-01T04:15:22.000Z",
    "fetchedAt": "2026-10-01T04:15:24.000Z"
  }
}
```

## Környezeti változók

| Változó | Alapérték | Leírás |
| --- | --- | --- |
| `TRADINGVIEW_API_KEY` | nincs | Opcionális live market-data API-kulcs |
| `TRADINGVIEW_BASE_URL` | `https://api.tradingviewapi.com` | Live adapter API címe |
| `TRADINGVIEW_FX_EXCHANGES` | `FOREXCOM,FX_IDC` | Sorban próbált FX venue-k |
| `TRADINGVIEW_TIMEOUT_MS` | `5000` | Live feed timeout |
| `LIVE_RATE_CACHE_MS` | `60000` | Élő quote cache ideje |
| `LIVE_STALE_MAX_MS` | `900000` | Legfeljebb meddig használható korábbi élő quote feed-kieséskor |
| `MNB_BASE_URL` | `https://www.mnb.hu/arfolyamok.asmx` | MNB SOAP webservice |
| `MNB_TIMEOUT_MS` | `5000` | MNB timeout |
| `ECB_BASE_URL` | `https://data-api.ecb.europa.eu/service` | ECB Data API |
| `ECB_TIMEOUT_MS` | `5000` | ECB timeout |
| `REFERENCE_STALE_MAX_MS` | `172800000` | Utolsó jó referenciaadat maximális kora |
| `CORS_ORIGINS` | Kalkulátor Bázis + localhost | Böngészős allowlist |
| `RATE_LIMIT_MAX` | `120` | Kérések percenként/IP |
| `DOCS_ENABLED` | `true` | Swagger UI |
| `TRUST_PROXY` | `false` | Reverse proxy mögötti kliens-IP használata |

## Helyi futtatás

```bash
npm ci
cp .env.example .env
npm run dev
```

## Build és ellenőrzés

```bash
npm ci
npm audit --audit-level=high
npm run typecheck
npm test
npm run build
```

## Production

Javasolt Render beállítások:

```text
NODE_ENV=production
NODE_VERSION=22.23.3
DOCS_ENABLED=false
TRUST_PROXY=true
CORS_ORIGINS=https://kalkulatorbazis.hu,https://www.kalkulatorbazis.hu
```

Live aktiváláskor ezen felül a `TRADINGVIEW_API_KEY` szükséges. A kulcs kizárólag szerveroldali secret legyen; frontend JavaScriptbe nem kerülhet.

## Biztonság

Az API read-only. A dependency-fa lockolt, a CI `npm ci`-t és `npm audit --audit-level=high` ellenőrzést futtat, a CodeQL statikus elemzést végez, a GitHub Actions actionök immutable SHA-ra vannak pinelve, a production smoke pedig ellenőrzi az éles health, árfolyam, CORS, security header és `/docs` állapotot.

## Pontosság

A `live` státusz piaci quote-ból képzett tájékoztató középárfolyamot jelent. A `reference` státusz MNB/ECB hivatalos napi referenciaárfolyamot jelent. Egyik sem garantálja egy bank, pénzváltó vagy kártyatársaság tényleges vételi/eladási/elszámolási árfolyamát.

## Verzió

Aktuális API-verzió: `0.2.0`.
