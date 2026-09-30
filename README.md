# Kalkulátor Bázis Currency API

Önálló, TypeScript + Fastify alapú devizaárfolyam- és devizaváltó API a Kalkulátor Bázishoz.

Az upstream adatforrás a **Frankfurter v2** API. Alapértelmezésben a Frankfurter összesített (blended) referenciaárfolyamát használja, de a `provider` paraméterrel egy konkrét adatforrás – például `ECB` – is kérhető.

## Funkciók

- aktuális devizapár-árfolyam
- historikus árfolyam dátum alapján
- konkrét összeg átváltása
- támogatott devizák listázása
- opcionális Frankfurter provider-szűrés
- JSON Schema validáció
- CORS-védelem
- globális rate limit
- request ID minden válaszban
- biztonságos upstream timeout és hibakezelés
- Swagger/OpenAPI dokumentáció
- automatizált API-tesztek és GitHub Actions CI

## Végpontok

### Állapot

```http
GET /health
```

### API információ

```http
GET /api/v1
```

### Devizapár árfolyama

```http
GET /api/v1/rate?from=EUR&to=HUF
```

Historikus árfolyam:

```http
GET /api/v1/rate?from=EUR&to=HUF&date=2026-09-01
```

Konkrét forrás, például ECB:

```http
GET /api/v1/rate?from=EUR&to=HUF&provider=ECB
```

### Deviza átváltása

```http
GET /api/v1/convert?amount=100&from=EUR&to=HUF
```

Példa válasz:

```json
{
  "data": {
    "amount": 100,
    "from": "EUR",
    "to": "HUF",
    "rate": 390.25,
    "convertedAmount": 39025,
    "rateDate": "2026-09-30"
  },
  "meta": {
    "source": "Frankfurter v2",
    "provider": "blended",
    "fetchedAt": "2026-09-30T14:30:00.000Z",
    "disclaimer": "Referenciaárfolyam-alapú tájékoztató átváltás; banki és készpénzes árfolyam eltérhet."
  }
}
```

### Támogatott devizák

```http
GET /api/v1/currencies
```

Providerre szűrve:

```http
GET /api/v1/currencies?provider=ECB
```

## Swagger

Fejlesztői környezetben alapértelmezés szerint:

```text
/docs
```

A `DOCS_ENABLED=false` környezeti változóval kikapcsolható.

## Helyi futtatás

Node.js 22 vagy újabb szükséges.

```bash
npm install
cp .env.example .env
npm run dev
```

Alapértelmezett cím:

```text
http://localhost:3000
```

## Build és ellenőrzés

```bash
npm run typecheck
npm test
npm run build
npm start
```

## Környezeti változók

| Változó | Alapérték | Leírás |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Listen host |
| `CORS_ORIGINS` | Kalkulátor Bázis + localhost | Engedélyezett origin lista, vesszővel elválasztva |
| `FRANKFURTER_BASE_URL` | `https://api.frankfurter.dev/v2` | Upstream API |
| `FRANKFURTER_TIMEOUT_MS` | `5000` | Upstream timeout ms |
| `RATE_LIMIT_MAX` | `120` | Maximális kérésszám percenként/IP |
| `DOCS_ENABLED` | `true` | Swagger UI engedélyezése |

## Adatforrás és pontosság

A Frankfurter v2 különböző jegybanki és hivatalos forrásokból származó referenciaárfolyamokat tesz elérhetővé. Provider megadása nélkül összesített árfolyamot ad; `provider=ECB` esetén az ECB-adatokra lehet szűrni.

Az API eredménye tájékoztató jellegű. Nem banki vételi/eladási, nem készpénzes és nem kártyatársasági elszámolási árfolyam.

## Verzió

Első API-verzió: `0.1.0`.
