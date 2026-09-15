# SQLViz — tilanne ja jatkamispiste

> Agentti lukee tämän ENSIN kun työ jatkuu, ja **päivittää jokaisen työjakson lopussa**.
> Älä kysy käyttäjältä mitä on jo tehty — lue tämä.

## Missä mennään (varmistettu 2026-09-15)
- Polku: `/data/workspace/sqlviz` — **100 % selainpohjainen**, ei palvelinkutsuja itse työkalussa. Live: **https://sqlviz.app** (oma Hostinger-domain, MedVoima Oy; GitHub Pages, `CNAME`, `sitemap.xml`).
- Ydintuote: `CREATE TABLE` -SQL sisään → interaktiivinen ER-diagrammi (`index.html`, `app.js`, `diagram.js`, `styles.css`).
- Maksullinen osa: `pdf-tools/` → **8 PDF-työkalua: 3 ilmaista (merge/split/compress), 5 Pro**; Pro-koodi `pro.js`. Portti: **3 kokeilukertaa / IP**, sitten **Pro 5,90 €/kk** (PayPal Subscriptions API, plan `P-03332786J26292132NKUZ55Y`, peruttavissa).
- Backend (Node + MySQL): `ghostwhite-dragonfly-572429.hostingersite.com` → käyttäjätilit, PayPal-maksut, IP-kokeilulaskuri. Sähköposti `info@sqlviz.app`, SMTP `smtp.hostinger.com:465` app-salasanalla.

## Seuraavaksi
- Ei kirjattua seuraavaa askelta — kysy käyttäjältä ja kirjaa se tähän.
- Tarkistettavaa, jos maksuista tulee ongelmia: PayPal Subscriptions -tilauksen tila ja IP-laskurin toiminta backendissä.

## Keskeiset viitteet
- Taitot: `shipping-free-web-tools` / `zero-capital-web-tool-shipping` (julkaisuputki), `web-app-monetization`.
- Tilitys: PayPal (ei Stripeä).
