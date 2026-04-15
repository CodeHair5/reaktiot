# Kehitysloki — Kemian Simulaattori

## Vaihe 1 — Arkkitehtuurin uudelleenrakentaminen
**31.3.2026**

### Lähtötilanne
Vanha toteutus (`kemialliset reaktiot/`): yksi `index.html` God-object + erilliset
`testTube.js`, `liquid.js`, `smokes.js`, `surfaceEffects.js`, `pour.js`.
Ongelmat: muistivuoto (geometrioita/materiaaleja ei vapautettu reseteissä),
puuttuvat cleanup-polut, arkkitehtuuri ei skaalautunut.

### Uusi rakenne

```
/
├── index.html           HTML-runko, importmap (three@0.160)
├── style.css            UI-layout
├── devlog.md            tämä tiedosto
└── src/
    ├── main.js          App-luokka, bootstrap, RAF-silmukka
    ├── SceneManager.js  Three.js-tila, renderöinti, raycaster
    ├── ChemistryEngine.js  Reaktiomatriisi, processAddition
    ├── EffectManager.js  Poolatut partikkelit (savu, höyry, kuplat)
    ├── UIManager.js     DOM-käsittely (valikko, kaava, vihje)
    ├── objects/
    │   ├── Tube.js      Koeputki-luokka (lasi + neste + meniskus)
    │   └── Droplet.js   Putoavan tipan animaatio
    └── shaders/
        └── waterVertex.js  GLSL aaltoilu + konvektio (JS-moduuli)
```

### Arkkitehtuuripäätökset

| Päätös | Perustelu |
|---|---|
| Object pool kaikissa partikkeleissa | Nolla heap-allokaatiota hot-pathissa |
| `customProgramCacheKey` per putki | Estää Three.js:n shader-ohjelman uudelleenkäytön eri putkien välillä, jotta per-putki-uniformit toimivat oikein |
| Jaettu geometria/materiaali Dropletissa | Tipat ovat lyhytikäisiä eikä useita pyöri yhtä aikaa; yksi `dispose()` ei tarvita per tippa |
| `onDropletLand` callback SceneManagerissa | Pitää kemiallisen logiikan erossa 3D-koodista |
| `ChemistryEngine.resetTube()` → mutatoi tilaa | Yksinkertainen; ei tarvita uutta data-objektia |

### Reaktiomatriisi (7 reaktiota)

| Putki | Reagenssi | Efektit |
|---|---|---|
| HCl | Mg | poreilu, höyry |
| HCl | Fe | poreilu, höyry |
| HCl | NH₃ | savu, haze |
| CuSO₄ | Fe | värinmuutos, sakka* |
| CuSO₄ | NaOH | sakka* |
| CuSO₄ | NH₃ | värinmuutos |
| H₂O₂ | Luminoli | glow* |

`*` = stub (Vaihe 4)

### Tiedossa olevat puutteet / seuraavat vaiheet

- **Vaihe 2:** Koeputkien visuaalinen hienosäätö (metallipalat, sakkapartikkelit)
- **Vaihe 3:** ChemistryEnginen laajentaminen (liuos-liuos-reaktiot, monikomponenttiset)
- **Vaihe 4:** Saostumapartikkelit (`precipitate`), `glow`-efekti (emissive/post-process)
- **Vaihe 5:** UI-parannukset (putki-labeleita, animoitu kaavaruutu)
- **Vaihe 6:** Performanssi-audit (Chromebook), Lighthouse-mittaus

---

## Vaihe 2 — Efektit & labelit
**31.3.2026**

### Saostumapartikkelit (`precipitate`)
- `EffectManager.createPrecipitate(tube, color, count)` — object pool (80 paikkaa)
- Per-slot kloonattu `MeshStandardMaterial` (väri vaihtelee reaktion mukaan), jaettu `SphereGeometry(0.018)`
- Fysiikka: kevyt gravitaatio nesteessä, asettuu pohjalle (`settled=true`) — ei palaudu pooliin ennen resettejä
- `ChemistryEngine.js`: lisätty `precipitateColor` reaktioihin  
  - CuSO₄ + Fe → `0xb87333` (kupari, punaruskea)  
  - CuSO₄ + NaOH → `0x2a5daa` (Cu(OH)₂, sininen)

### Glow-efekti (Luminol + H₂O₂)
- `Tube.setGlow(hexColor)` / `Tube.clearGlow()` — asettaa `emissive` + `emissiveIntensity`
- Pulssaus `update()`-silmukassa: `0.35 + 0.50 × sin(time × 2.2)` — luonnollinen hengitysrytmi
- `reset()` kutsuu automaattisesti `clearGlow()`

### Putki-labelit
- `CSS2DRenderer` + `CSS2DObject` → HTML `div.tube-label` jokaisen putken yläpuolelle
- `_css2dRenderer` renderöidään jokainen frame WebGL-renderin jälkeen
- `pointer-events: none` — ei häiritse raycaster-klikkaustunnistusta
- Siivotaan `dispose()`-kutsulla

---

## Vaihe 3 — Efektijärjestelmän laajennus
**3.–4.4.2026**

### Poistettu — saostumapartikkelit putken pohjalla
- `createPrecipitate` / `prewarmPrecipitate` poistettu efektien käynnistyshaarasta
- Tipan laskeutuminen sen sijaan värjää **kiinteän kappaleen** itsensä saostuman väriseksi (animoitu `_colorAnims`-silmukkaa käyttäen)

### Kuplinnan intensiteettijärjestelmä (`BUBBLING_INTENSITY`)
- Eksportoitu vakio-objekti ChemistryEnginestä: `VERY_LOW=0.10 … VERY_VIGOROUS=1.00`
- Kaikki reaktiot käyttävät vakioita kovakoodattujen arvojen sijaan
- Kolme kuplintatyyppiä: `'bubbling'` (isBubbling-flag), `'gentle'` (ripple-shader + pienet pintakuplat), `'vigorous'` (boil-shader + foam + big bubbles + roiskeita)
- SceneManager skaalaa spawn-todennäköisyydet ja -määrät `bubblingIntensity`-arvolla

### Höyryjärjestelmä (`STEAM_INTENSITY`) — jatkuva emissio
- Eksportoitu vakio: `VERY_LOW=2 … VERY_HIGH=16`
- Reaktiot asettavat `steamIntensity`-arvon, SceneManager ylläpitää `_steamTimers`-karttaa
- Jatkuva höyryloop: `STEAM_INTERVAL = 1.8 / si` sekuntia per spawntrigger; 2–3 partikkelia per triggeri
- `'steam'`-visuaali ei enää kutsu `createSteam` suoraan vaan vain asettaa `tube.state.steamIntensity`

### Kaasujen hajoamistimer (`gasDecayTime`)
- Reaktio voi määritellä `gasDecayTime` (s) — kun laskuri nollautuu, kuplinta/höyry pysähtyy
- Esim. H₂O₂ + Yeast: 20 s → `stopRippling()`, `steamIntensity = 0`, `isSmoking = false`

### Höyrypartikkelit (`createSteam` — EffectManager)
- Oma pehmeä tekstuuri `_STEAM_TEX` (puhdas radiaali, ei tiivistä keskustaa)
- Oma päivitysmetodi `_updateSteam`: sineaalinen opacity-käyrä, kasvu alkukoosta isommaksi
- Suuri nopeus- ja kokohajonta (`vy: 0.30–0.80`, `startScale: 0.05–0.30`) → ei jonoa

### CaCO₃ + HCl
- Vaihdettu `'bubbling'` → `'gentle'` → aiheuttaa pintakuplia (CO₂ vapautuu pintaan)
- `producesGas: 'CO2'` → tulitikku sammuu

### Tulitikun O₂-efekti
- Poistettu sykkivä glow-sprite kokonaan
- Liekki kasvaa tasaisesti (`o2FlameT` laskuri × `o2Mul = 1.0–2.6`)
- Bloom rampautuu `2.0s` ajassa `+5.5` tasolle (ei pulssia)

### Tulitikun sammutussavu (CO₂)
- `createExtinguishSmoke`: 14 partikkelia, `maxLife 3–5s`, leveämpi hajonta
- Sammuttaa liekin pehmeästi `extinguishFlame()`-animaatiolla

---

## Vaihe 4 — Koodiauditointi
**4.4.2026**

### Löydetyt ja korjatut ongelmat

| # | Tiedosto | Ongelma | Korjaus |
|---|---|---|---|
| 1 | `SceneManager` `case 'smoke'` | Ei asettanut `tube.state.isSmoking = true` → jatkuva savuloop oli kuollutta koodia | Lisätty `tube.state.isSmoking = true` |
| 2 | `SceneManager` gasDecayTimer | Ei nollannut `isSmoking` → savu olisi jatkunut ikuisesti | Lisätty `tube.state.isSmoking = false` |
| 3 | `ChemistryEngine` Mg+H₂O₂ | `continuousSmoke: true` — kenttä jota ei luettu missään | Poistettu; korvattu `steamIntensity: STEAM_INTENSITY.LOW` |
| 4 | `ChemistryEngine` H₂O₂+Fe | `bubblingIntensity: 0.18` kovakoodattu | Vaihdettu `BUBBLING_INTENSITY.LOW` |
| 5 | `SceneManager` `case 'glow'` | Yhtään reaktiota ei käytä `'glow'`-visuaalia | Lisätty kommentti "varattu tuleville reaktioille", käyttää `result.glowColor` |
| 6 | `SceneManager` `case 'glowFlash'` | Hohtoväri `0x0022ff` kovakoodattu SceneManagerissa | Luetaan `result.glowColor ?? 0x0022ff` |
| 7 | `ChemistryEngine` NH₃+HCl | `hazeIntensity` puuttui — SceneManager käytti kovakoodattua `0.50` | Lisätty `hazeIntensity: 0.50` reaktiodataan |
| 8 | `SceneManager` `case 'haze'` | `tube.setHaze(0.50)` kovakoodattu | Luetaan `result.hazeIntensity ?? 0.50` |

### Nykyinen reaktiomatriisi (täysi)

| Putki | Reagenssi | Kuplinta | Höyry | Kaasu | Muuta |
|---|---|---|---|---|---|
| HCl | Mg | `gentle` VIGOROUS | VERY_LOW | H₂ | — |
| HCl | Fe | `bubbling` VERY_LOW | — | H₂ | värimuutos 9s |
| HCl | NH₃ | — | `smoke`+jatkuva | — | haze 0.50 |
| HCl | NaOH | — | — | — | — |
| HCl | CaCO₃ | `gentle` VIGOROUS | — | CO₂ | max 3 lisäystä |
| CuSO₄ | Fe | — | — | — | väri+metallikerrostuma+solidColor |
| CuSO₄ | Mg | — | — | — | väri+metallikerrostuma+solidColor |
| CuSO₄ | NaOH | — | — | — | sakka (4 vaihetta) |
| CuSO₄ | NH₃ | — | — | — | sakka→liuos (3 vaihetta) |
| FeSO₄ | NaOH | — | — | — | sakka (3 vaihetta) |
| FeSO₄ | NH₃ | — | — | — | sakka (3 vaihetta) |
| FeSO₄ | Mg | — | — | — | väri+metallikerrostuma+solidColor |
| H₂O₂ | Fe | `bubbling` LOW | — | — | värimuutos 18s (Fenton) |
| H₂O₂ | Mg | `vigorous` VERY_VIGOROUS | LOW | O₂ | sakka (Mg(OH)₂) |
| H₂O₂ | Cu | — | — | — | katalyytti Luminolille |
| H₂O₂ | Yeast | `gentle` VIGOROUS | MEDIUM | O₂ | gasDecay 20s |
| H₂O₂ | Luminol | — | — | — | glowFlash (vaatii Fe/Cu) |

*(Lisää uudet merkinnät tähän tiedostoon vaiheittain.)*

