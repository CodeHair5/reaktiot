# ⚗️ Tekninen Spesifikaatio: 3D Kemian Simulaattori (three.js)

## 1. Projektin tavoite
Luoda interaktiivinen ja visuaalisesti näyttävä kemian simulaatio, joka toimii sujuvasti Chromebook-ympäristössä (selainpohjainen). Käyttäjä voi tutkia erilaisia reaktiotyyppejä (saostuminen, kaasunmuodostus, kemiluminesenssi, korvautuminen) 3D-ympäristössä.

---

## 2. Tekninen Arkkitehtuuri
- **Moottori:** three.js (R150+)
- **Renderöinti:** WebGL 2.0 (Optimointi integroiduille näytönohjaimille)
- **Efektit:** Custom GLSL Shaders (nesteen pinta, aaltoilu, hohto)
- **UI:** HTML/CSS Overlay (Ainevalikko ja dynaaminen kaavapaneeli)

---

## 3. Laboratorioasetelma
### 3.1. Koeputket (Pohjaliuokset)
Näkymässä on 4 kiinteää koeputkea telineessä:
1. **Tube 1:** Suolahappo ($HCl$) – Kirkas neste.
2. **Tube 2:** Kuparisulfaatti ($CuSO_4$) – Kirkas vaaleansininen neste.
3. **Tube 3:** Rautasulfaatti ($FeSO_4$) – Kirkas haaleanvihreä neste.
4. **Tube 4:** Vetyperoksidi ($H_2O_2$) – Kirkas neste (Luminolin pohja).

### 3.2. Valikko-reagenssit
Käyttäjä valitsee aineen valikosta ja klikkaa koeputkea:
- **Metallit (Solid):** Rauta (Fe), Magnesium (Mg), Kupari (Cu).
- **Nesteet (Liquid):** NaOH, Ammoniakki ($NH_3$), Luminoli.

---

## 4. Visuaaliset Tehosteet (Shader & Particles)

| Efekti | Tekninen Toteutus | Käyttökohde |
| :--- | :--- | :--- |
| **Contact Ripple** | Vertex Shader: Aaltoilu osumapisteestä. | Kaikki lisäykset nesteeseen. |
| **Surface Bubbling** | Fragment Shader: Noise-pohjainen poreilu pinnalla. | $Mg + HCl$ (Vetykaasu). |
| **White Smoke** | Particle System: Hitaasti nouseva tiheä sumu. | $HCl + NH_3$. |
| **Reaction Steam** | Particle System: Läpikuultava "kuuma" höyry. | $Mg + HCl$ (Eksoterminen). |
| **Glass Haze** | Material Shader: Lasin yläosan samentuminen. | $HCl + NH_3$. |
| **Precipitate** | Point Cloud / Meshes: Laskeutuvat hiukkaset. | Saostusreaktiot (NaOH). |
| **Glow Effect** | Post-processing tai Emissive Shader. | Kemiluminesenssi (Luminoli). |

---

## 5. Reaktiomatriisi ja Kaavapaneeli

| Kohdeputki | Reagenssi | Visuaalinen muutos | Näytettävä kaava |
| :--- | :--- | :--- | :--- |
| **Tube 1 (HCl)** | **Mg** | Raju poreilu, pintakuplinta, höyry. | $Mg(s) + 2HCl(aq) \rightarrow MgCl_2(aq) + H_2(g)$ |
| **Tube 1 (HCl)** | **$NH_3$** | Valkoinen savu suulla, lasin yläosa huurtuu. | $NH_3(g) + HCl(g) \rightarrow NH_4Cl(s)$ |
| **Tube 2 ($CuSO_4$)** | **Fe** | Rauta muuttuu ruskeaksi, neste $Sin \rightarrow Vihr$. | $Fe(s) + CuSO_4(aq) \rightarrow FeSO_4(aq) + Cu(s)$ |
| **Tube 2 ($CuSO_4$)** | **NaOH** | Sininen hyytelömäinen sakka. | $Cu^{2+}(aq) + 2OH^-(aq) \rightarrow Cu(OH)_2(s)$ |
| **Tube 2 ($CuSO_4$)** | **$NH_3$** | Syvänsininen kirkas neste (liika $NH_3$). | $Cu^{2+} + 4NH_3 \rightarrow [Cu(NH_3)_4]^{2+}$ |
| **Tube 4 ($H_2O_2$)** | **Luminoli+NaOH+Fe** | Sininen kemiallinen valo (Glow). | $Luminol + H_2O_2 \xrightarrow{Fe} Light$ |

---

## 6. Toteutusohjeita (Development Notes)
1. **Putoamislogiikka:** Kun putkea klikataan, spawnataan reagenssi (pallo/kappale) ylös ja annetaan sille `gravity`. Pinnan `y`-tason ylittyessä triggeröidään `onCollision()`.
2. **Chromebook-optimointi:** Käytä `BufferGeometry` kaikissa malleissa. Rajoita partikkelimäärä max 500 per efekti.
3. **Shader-integraatio:** Nesteen pinta on `PlaneGeometry`. Käytä `uTime`-uniformia shaderin animointiin poreilussa.
4. **Formula Box:** HTML-elementti `position: absolute; bottom: 20px;`, joka päivittyy `ReactionManagerin` mukaan.













EHDOTUS TIEDOSTORAKENTEEKSI
/project-root
│
├── index.html              # Sovelluksen runko ja UI-overlayt
├── style.css               # UI-asettelu ja Formula Boxin tyylit
│
├── /src
│   ├── main.js             # Entry point: App-init ja renderöintisilmukka
│   ├── SceneManager.js     # Three.js skene, kamera ja valaistus
│   ├── ChemistryEngine.js  # Kemiallinen logiikka ja reaktiomatriisi
│   ├── EffectManager.js    # Partikkelisysteemit (savu, höyry, poreilu)
│   ├── UIManager.js        # Valikkojen ja kaavapaneelin hallinta
│   │
│   ├── /objects            # 3D-objektit ja luokat
│   │   ├── Tube.js         # Koeputki-luokka (lasimateriaali + sisältö)
│   │   ├── Droplet.js      # Tippuvan aineen logiikka
│   │
│   └── /shaders            # GLSL-shaderit
│       ├── waterVertex.glsl    # Aaltoiluefekti
│       └── bubbleFragment.glsl # Poreiluefekti


classDiagram
    class App {
        +sceneManager: SceneManager
        +chemistryEngine: ChemistryEngine
        +uiManager: UIManager
        +init()
        +animate()
    }

    class SceneManager {
        +scene: THREE.Scene
        +renderer: THREE.WebGLRenderer
        +tubes: Tube[]
        +addDroplet(type, tubeTarget)
        +updateShaders(time)
    }

    class ChemistryEngine {
        +reactions: Object (JSON)
        +getReaction(ingredients: Array) : ReactionResult
        +processAddition(tubeId, newIngredient)
    }

    class Tube {
        +mesh: THREE.Group
        +liquidMesh: THREE.Mesh
        +contents: Array
        +updateColor(color)
        +setHaze(intensity)
        +setBubbling(active)
    }

    class EffectManager {
        +smokeSystem: THREE.Points
        +steamSystem: THREE.Points
        +triggerSmoke(position)
        +triggerSteam(position)
    }

    App --> SceneManager
    App --> ChemistryEngine
    App --> UIManager
    SceneManager --> Tube
    SceneManager --> EffectManager

3. Keskeiset Rajapinnat ja Funktiot

3.1. ChemistryEngine.js

Vastaa siitä, mitä kemiaa tapahtuu.

    processAddition(tubeId, substance): Lisää aineen putken tilaan ja palauttaa reaktio-objektin.

    ReactionResult: Objekti, joka sisältää:

        formula: Merkkijono (LaTeX).

        visuals: Lista efekteistä (esim. ['smoke', 'colorChange', 'haze']).

        newColor: Uusi nesteen väri (Hex).

3.2. SceneManager.js (Three.js logiikka)

Vastaa 3D-maailman visualisoinnista.

    handleTubeClick(tubeId): Raycasterilla tunnistettu klikkaus. Triggeröi Droplet-instanssin.

    onDropletCollision(tubeId, substance): Kutsutaan, kun tippa saavuttaa pinnan.

        Triggeröi RippleShaderin.

        Kysyy ChemistryEngineltä reaktion seuraukset.

        Kutsuu EffectManageria.

3.3. EffectManager.js

Vastaa GPU-kiihdytetyistä efekteistä.

    createSmoke(x, y, z): Spawnattavat THREE.Points -partikkelit, joilla on ylöspäin nouseva velocity ja pienenevä opacity.

    createSteam(x, y, z): Nopeammat, harmahtavat partikkelit.

4. Tilan hallinta (State Management)

Jokaisella koeputkella on oma tila-objekti:
JavaScript

{
  id: 1,
  baseSolution: "HCl",
  addedIngredients: ["NH3"],
  isBubbling: false,
  hasHaze: true,
  currentLiquidColor: 0xffffff
}