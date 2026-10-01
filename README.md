# Kalkulátor Bázis Currency API

Önálló, TypeScript + Fastify alapú devizaárfolyam- és devizaváltó backend a Kalkulátor Bázishoz.

## Mit jelent itt az, hogy önálló?

Az API **önálló szolgáltatás**: saját domain/URL, saját végpontok, saját validáció, rate limit, hibakezelés, tesztek és deploy tartozik hozzá. A weboldal a Kalkulátor Bázis API-szerződéséhez kapcsolódik, ezért az alatta lévő árfolyamforrás később cserélhető anélkül, hogy a frontend API-hívásait újra kellene tervezni.

Az API ugyanakkor **nem saját maga állít elő piaci vagy jegybanki árfolyamot**. A jelenlegi upstream adatforrás a Frankfurter v2 API. Alapértelmezésben annak összesített referenciaárfolyamát használja, a `provider` paraméterrel pedig konkrét forrás – például `ECB` – kérhető. Az upstream választ az API validálja és normalizálja; nem vakon továbbítja.

## Funkciók

- aktuális devizapár-árfolyam
- több cél-deviza egyetlen kérésben
- historikus árfolyam dátum alapján
- konkrét összeg átváltása
- támogatott devizák listázása
- opcionális provider-szűrés
- JSON Schema validáció
- szűk böngészős CORS allowlist
- kliens-IP alapú rate limit
- request ID minden válaszban
- upstream timeout, válaszvalidáció és szanitizált hibakezelés
- opcionális Swagger/OpenAPI dokumentáció
- automatizált API-tesztek, npm audit, Dependabot és CodeQL

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

### Több árfolyam egy kérésben

```http
GET /api/v1/rates?base=EUR&quotes=HUF,USD,GBP
```

Legfeljebb 50 cél-deviza kérhető egy hívásban.

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
    "source": "external reference rates",
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

Fejlesztői környezetben használható:

```text
/docs
```

Productionben ajánlott:

```text
DOCS_ENABLED=false
```

Ilyenkor a Swagger UI nincs publikusan kiszolgálva, és a Helmet alapértelmezett CSP-je is aktív marad.

## Helyi futtatás

Node.js 22 vagy újabb szükséges.

```bash
npm ci
cp .env.example .env
npm run dev
```

Alapértelmezett cím:

```text
http://localhost:3000
```

## Build és ellenőrzés

```bash
npm ci
npm audit --audit-level=high
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
| `CORS_ORIGINS` | Kalkulátor Bázis + localhost | Engedélyezett böngészős origin lista, vesszővel elválasztva |
| `FRANKFURTER_BASE_URL` | `https://api.frankfurter.dev/v2` | Jelenlegi upstream API |
| `FRANKFURTER_TIMEOUT_MS` | `5000` | Upstream timeout ms |
| `RATE_LIMIT_MAX` | `120` | Maximális kérésszám percenként/IP |
| `DOCS_ENABLED` | `true` | Swagger UI engedélyezése |
| `TRUST_PROXY` | `false` | Megbízható reverse proxy mögött a továbbított kliens-IP használata |

### Render production javaslat

```text
NODE_ENV=production
DOCS_ENABLED=false
TRUST_PROXY=true
CORS_ORIGINS=https://kalkulatorbazis.hu,https://www.kalkulatorbazis.hu
```

A `TRUST_PROXY=true` értéket csak olyan környezetben szabad használni, ahol a szolgáltatás közvetlenül nem kerülhető meg, és a reverse proxy által beállított forwarded headerek megbízhatók.

## Biztonsági modell

Az API szándékosan **publikus és read-only**. A CORS böngészőbiztonsági szabály, nem hitelesítés: curlből, szerverről vagy más nem böngészős kliensből az API címe közvetlenül hívható. Ezt rate limit és bemenetvalidáció védi.

Ha később fizetős vagy ügyfelenként kvótázott API készül, külön API-key/auth réteg és ügyfelenkénti usage-mérés szükséges. A weboldal JavaScriptjébe tett API-kulcs nem lenne titok, ezért az nem megfelelő védelem.

A dependency-fa `package-lock.json` fájlban rögzített. A CI `npm ci`-t használ, high vagy critical npm audit találatnál hibával leáll. A Dependabot és a CodeQL további automatikus ellenőrzést ad.

Lásd még: [`SECURITY.md`](SECURITY.md).

## Adatforrás és pontosság

A jelenlegi upstream a Frankfurter v2, amely különböző jegybanki és hivatalos forrásokból származó referenciaárfolyamokat tesz elérhetővé. Provider megadása nélkül összesített árfolyamot ad; `provider=ECB` esetén az ECB-adatokra lehet szűrni.

Az API eredménye tájékoztató jellegű. Nem banki vételi/eladási, nem készpénzes és nem kártyatársasági elszámolási árfolyam.

## Verzió

Első API-verzió: `0.1.0`.
