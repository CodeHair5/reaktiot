/**
 * ChemistryEngine.js
 *
 * Kemiallinen logiikka: reaktiomatriisi ja tilan hallinta.
 * Ei Three.js-riippuvuuksia — puhdas datakerros.
 *
 * Spesistä (chemistry reactions.md §5) johdettu reaktiomatriisi.
 *
 * ReactionResult-objekti:
 *   formula  {string}       — reaktioyhtälö (Unicode, ei LaTeX)
 *   visuals  {string[]}     — efektitunnisteet EffectManagerille
 *   newColor {number|null}  — uusi nesteen väri (hex) tai null
 */

// ── Kuplintaintensiteetin tasot ───────────────────────────────────────────────
// Normalisoitu asteikko 0–1, käytetään reaktioiden bubblingIntensity-kentässä.
// Arvo on skaalauskerroin spawn-loopeille:
//   'bubbling'-visuaali:  käyttää arvoa suoraan (ei kattoa).
//   'gentle'-visuaali:    startRippling() kattaa arvon → max 1.0.
//   'vigorous'-visuaali:  startBoiling()  kattaa arvon → max 1.0.
export const BUBBLING_INTENSITY = {
    VERY_LOW:      0.10,   // hyvin pieni  — vain muutama kupla/sek
    LOW:           0.18,   // pieni        — harvakseltaan (esim. Fe + HCl)
    MEDIUM:        0.50,   // medium
    VIGOROUS:      0.85,   // kiivas       — (esim. Mg + HCl, Yeast + H₂O₂)
    VERY_VIGOROUS: 1.00,   // hyvin kiivas — maksimiteho (esim. Mg + H₂O₂)
};

// ── Höyryintensiteetin tasot ──────────────────────────────────────────────────
// Kokonaisluku = kerralla spawnaavien höyrypartikkelien määrä.
// Käytetään reaktion steamIntensity-kentässä ja välitetään
// EffectManager.createSteam(pos, count) -kutsulle.
export const STEAM_INTENSITY = {
    VERY_LOW:  2,    // hyvin vähän — tuskin huomattava (esim. Mg + HCl)
    LOW:       3,    // oletus (implisiittiset reaktiot)
    MEDIUM:    6,
    HIGH:      10,
    VERY_HIGH: 16,
};

// ── Reaktiomatriisi ───────────────────────────────────────────────────────────
//
// Kentät:
//   tube          {string}    — putkessa oleva liuos
//   reagent       {string}    — lisättävä aine
//   maxAdditions  {number}    — kuinka monta kertaa sallitaan (oletus 1)
//   steps         {object[]}  — vaihekohtaiset tulokset (multi-step)
//   formula       {string}    — (yksivaiheisille) reaktioyhtälö
//   visuals       {string[]}  — efektitunnisteet EffectManagerille
//   newColor      {number|null}
const REACTIONS = [
    // ── Suolahappo (HCl) ──────────────────────────────────────────────────────
    {
        tube: 'HCl', reagent: 'Mg',
        formula:           'Mg(s) + 2HCl(aq) → MgCl₂(aq) + H₂(g)',
        visuals:           ['gentle', 'steam'],
        newColor:          null,
        bubblingIntensity: BUBBLING_INTENSITY.VIGOROUS,
        steamIntensity:    STEAM_INTENSITY.VERY_LOW,
        producesGas:       'H2',
        windDown:          { delay: 6.0, duration: 8.0 },
        exhaustAfter:      true,
    },
    {
        tube: 'HCl', reagent: 'Fe',
        formula:             'Fe(s) + 2HCl(aq) → FeCl₂(aq) + H₂(g)',
        visuals:             ['bubbling'],
        newColor:            0xd2e6d5,
        colorChangeDuration: 9.0,
        bubblingIntensity:   BUBBLING_INTENSITY.VERY_LOW,
    },
    {
        tube: 'HCl', reagent: 'NH3',
        formula:      'NH₃(g) + HCl(g) → NH₄Cl(s)',
        visuals:      ['smoke', 'haze'],
        hazeIntensity: 0.50,
        newColor:     null,
        maxAdditions: 4,
        windDown:     { delay: 3.0, duration: 5.0 },
        exhaustAfter: true,
    },
    {
        tube: 'HCl', reagent: 'NaOH',
        formula:  'NaOH(aq) + HCl(aq) → NaCl(aq) + H₂O(l)',
        visuals:  [],
        newColor: null,
    },

    // CaCO₃ + HCl → pintakuplia (CO₂-kaasu vapautuu, kuplia puhkaisee pintaan)
    {
        tube: 'HCl', reagent: 'CaCO3',
        formula:           'CaCO₃(s) + 2HCl(aq) → CaCl₂(aq) + H₂O(l) + CO₂(g)',
        visuals:           ['gentle'],
        newColor:          null,
        bubblingIntensity: BUBBLING_INTENSITY.VIGOROUS,
        maxAdditions:      3,
        producesGas:       'CO2',
        windDown:          { delay: 5.0, duration: 10.0 },
        exhaustAfter:      true,
        fadeSolid:         'CaCO3',
    },

    // ── Kuparisulfaatti (CuSO₄) ───────────────────────────────────────────────
    {
        tube: 'CuSO4', reagent: 'Fe',
        formula:             'Fe(s) + CuSO₄(aq) → FeSO₄(aq) + Cu(s)',
        visuals:             ['colorChange', 'metalDeposit'],
        newColor:            0x7dba82,       // liuos hiljalleen vihreäksi (FeSO₄)
        colorChangeDuration: 12.0,
        depositColor:        0x7a3318,       // tumma metallinen kupari
        // Rautanaula muuttuu hiljalleen kuparin väriseksi
        solidColorChange: { substance: 'Fe', toColor: 0xb87333, duration: 14.0 },
    },
    {
        tube: 'CuSO4', reagent: 'Mg',
        formula:             'Mg(s) + CuSO₄(aq) → MgSO₄(aq) + Cu(s)',
        visuals:             ['colorChange', 'metalDeposit'],
        newColor:            0xe8f4f8,       // lähes väritön MgSO₄ (liuos vaalenee)
        colorChangeDuration: 12.0,
        depositColor:        0x7a3318,       // tumma metallinen kupari
        // Magnesiumin pinta saa kuparisen värin
        solidColorChange: { substance: 'Mg', toColor: 0xb87333, duration: 12.0 },
    },

    // NaOH + CuSO₄ — monivaiheinen: sakka + väri vaalenee joka lisäyksellä
    {
        tube: 'CuSO4', reagent: 'NaOH',
        maxAdditions: 4,
        steps: [
            { formula: 'Cu²⁺(aq) + 2OH⁻(aq) → Cu(OH)₂↓',
              visuals: ['precipitate'], newColor: 0x8ab8e0, colorChangeDuration: 8.0, precipitateColor: 0x2a5daa },
            { formula: 'Cu²⁺(aq) + 2OH⁻(aq) → Cu(OH)₂↓',
              visuals: ['precipitate'], newColor: 0xb8d8f0, colorChangeDuration: 8.0, precipitateColor: 0x2a5daa },
            { formula: 'Cu²⁺(aq) + 2OH⁻(aq) → Cu(OH)₂↓',
              visuals: ['precipitate'], newColor: 0xd8eeff, colorChangeDuration: 8.0, precipitateColor: 0x2a5daa },
            { formula: 'Cu²⁺(aq) + 2OH⁻(aq) → Cu(OH)₂↓',
              visuals: ['precipitate'], newColor: 0xeef6ff, colorChangeDuration: 8.0, precipitateColor: 0x2a5daa },
        ],
    },

    // NH₃ + CuSO₄ — 3-vaiheinen kompleksireaktio
    {
        tube: 'CuSO4', reagent: 'NH3',
        maxAdditions: 3,
        steps: [
            { formula:          'Cu²⁺ + 2NH₃ + 2H₂O → Cu(OH)₂↓ + 2NH₄⁺',
              visuals:          ['precipitate'],
              newColor:         null,
              precipitateColor: 0x2a5daa },   // vaaleansininen Cu(OH)₂-sakka (sama kuin NaOH+CuSO₄)
            { formula:          'Cu²⁺ + 2NH₃ + 2H₂O → Cu(OH)₂↓ + 2NH₄⁺',
              visuals:          ['precipitate'],
              newColor:         null,
              precipitateColor: 0x2a5daa },
            { formula:          'Cu(OH)₂ + 4NH₃ → [Cu(NH₃)₄]²⁺ + 2OH⁻',
              visuals:          ['colorChange', 'dissolve'],
              newColor:         0x0d3d9e,      // tumma indigonsininen kompleksi
              colorChangeDuration: 5.0 },
        ],
    },

    // ── Rautasulfaatti (FeSO₄) ───────────────────────────────────────────────
    // NaOH saostaa vihreän rauta(II)hydroksiidin
    {
        tube: 'FeSO4', reagent: 'NaOH',
        maxAdditions: 3,
        steps: [
            { formula: 'Fe²⁺(aq) + 2OH⁻(aq) → Fe(OH)₂↓',
              visuals: ['precipitate'], newColor: 0xa8c8a0, colorChangeDuration: 8.0,
              precipitateColor: 0x4a7a3d },   // tummanvihreä Fe(OH)₂
            { formula: 'Fe²⁺(aq) + 2OH⁻(aq) → Fe(OH)₂↓',
              visuals: ['precipitate'], newColor: 0xc4d8bc, colorChangeDuration: 8.0,
              precipitateColor: 0x4a7a3d },
            { formula: 'Fe²⁺(aq) + 2OH⁻(aq) → Fe(OH)₂↓',
              visuals: ['precipitate'], newColor: 0xdaead4, colorChangeDuration: 8.0,
              precipitateColor: 0x4a7a3d },
        ],
    },

    // NH₃ saostaa raudan(II)hydroksiidin — reaktiivinen ammoniakki tekee lievemän saostuman
    {
        tube: 'FeSO4', reagent: 'NH3',
        maxAdditions: 3,
        steps: [
            { formula: 'Fe²⁺(aq) + 2NH₃(aq) + 2H₂O(l) → Fe(OH)₂↓ + 2NH₄⁺(aq)',
              visuals: ['precipitate'],
              newColor: 0xb4ccb0, colorChangeDuration: 8.0,
              precipitateColor: 0x4a7a3d },   // tummanvihreä Fe(OH)₂-sakka
            { formula: 'Fe²⁺(aq) + 2NH₃(aq) + 2H₂O(l) → Fe(OH)₂↓ + 2NH₄⁺(aq)',
              visuals: ['precipitate'],
              newColor: 0xc8dcc4, colorChangeDuration: 8.0,
              precipitateColor: 0x4a7a3d },
            { formula: 'Fe²⁺(aq) + 2NH₃(aq) + 2H₂O(l) → Fe(OH)₂↓ + 2NH₄⁺(aq)',
              visuals: ['precipitate'],
              newColor: 0xdcecd8, colorChangeDuration: 8.0,
              precipitateColor: 0x4a7a3d },
        ],
    },

    // Magnesium syrjäyttää raudan FeSO₄:stä — liuos vaalenee, Mg:n pinta tummuu
    {
        tube: 'FeSO4', reagent: 'Mg',
        formula:             'Mg(s) + FeSO₄(aq) → MgSO₄(aq) + Fe(s)',
        visuals:             ['colorChange', 'metalDeposit'],
        newColor:            0xf0f4f0,       // lähes väritön MgSO₄ (vihreä FeSO₄ vaalenee)
        colorChangeDuration: 14.0,
        depositColor:        0x252220,       // tumma metallinen rauta
        // Magnesiumin pinta saa raudan tumman värin
        solidColorChange: { substance: 'Mg', toColor: 0x5a5a5a, duration: 13.0 },
    },

    // ── Vetyperoksidi (H₂O₂) + metallit ─────────────────────────────────
    // Rauta: Fenton-kemia → Fe²⁺ → Fe³⁺, liuos hiljalleen ruskehtavaksi, vähän kuplintaa (O₂)
    {
        tube: 'H2O2', reagent: 'Fe',
        formula:             '2Fe²⁺(aq) + H₂O₂ → 2Fe³⁺(aq) + 2OH⁻    (Fenton)',
        visuals:             ['bubbling'],
        newColor:            0xc4813a,       // ruosteenruskea Fe³⁺
        colorChangeDuration: 18.0,
        bubblingIntensity:   BUBBLING_INTENSITY.LOW,
    },
    // Magnesium: Mg + 2H₂O₂ → Mg(OH)₂ + O₂ — kiihkeä, paljon kuplintaa + huurua
    {
        tube: 'H2O2', reagent: 'Mg',
        formula:           'Mg(s) + 2H₂O₂(aq) → Mg(OH)₂(s) + O₂(g)',
        visuals:           ['vigorous', 'steam', 'precipitate'],
        newColor:          null,
        precipitateColor:  0xe2e2e2,        // valkoinen Mg(OH)₂-sakka
        bubblingIntensity: BUBBLING_INTENSITY.VERY_VIGOROUS,
        steamIntensity:    STEAM_INTENSITY.LOW,
        producesGas:       'O2',
        windDown:          { delay: 10.0, duration: 14.0 },
        exhaustAfter:      true,
    },
    // Kupari: passiivinen katalyytti — rekisteröi Cu addedIngredients-listaan
    // Luminol-reaktiota varten, ei näkyviä efektejä
    {
        tube: 'H2O2', reagent: 'Cu',
        formula:  'Cu(s) katalysoi H₂O₂:n hajotusta (ei näkyvää reaktiota)',
        visuals:  [],
        newColor: null,
    },

    // Kuivahiiva (katalaasi-entsyymi) hajottaa vetyperoksidin voimakkaasti
    // → tiheä kuplinta (gentle-pintakuplat) + höyry (eksoterminen)
    // gasDecayTime: H₂O₂ on käytetty ~20 sekunnissa → kuplinta loppuu
    {
        tube: 'H2O2', reagent: 'Yeast',
        formula:           '2H₂O₂(aq) →[katalaasi] 2H₂O(l) + O₂(g)',
        visuals:           ['gentle', 'steam'],
        newColor:          null,
        bubblingIntensity: BUBBLING_INTENSITY.VIGOROUS,
        steamIntensity:    STEAM_INTENSITY.MEDIUM,
        producesGas:       'O2',
        gasDecayTime:      20.0,
    },

    // ── Vetyperoksidi (H₂O₂) + Luminoli ──────────────────────────────────────
    // Vaatii raudan tai kuparin katalyyttina (Fenton/oksidatiivinen aktiivisuus)
    {
        tube: 'H2O2', reagent: 'Luminol',
        requiresAny: ['Fe', 'Cu'],
        maxAdditions: Infinity,
        steps: [{
            formula:   'Luminol + H₂O₂ → AP²⁻* → hν (λ ≈ 460 nm)',
            visuals:   ['glowFlash'],
            glowColor: 0x0022ff,
            newColor:  null,
        }],
    },
];

// ── Luokka ────────────────────────────────────────────────────────────────────
export class ChemistryEngine {

    /** Alustaa moottorin. Kaikki data on synkronista. */
    init() { /* ei tarvita */ }

    /**
     * Hakee reaktion putken pohjaliuoksen, aineen ja lisäyskerran perusteella.
     * Multi-step-reaktioissa palauttaa oikean vaiheen.
     *
     * @param {string} baseSolution
     * @param {string} substance
     * @param {number} [count=0]  — montako kertaa aine on jo lisätty
     * @returns {object|null}
     */
    getReaction(baseSolution, substance, count = 0) {
        const rxn = REACTIONS.find(
            r => r.tube === baseSolution && r.reagent === substance
        );
        if (!rxn) return null;
        if (rxn.steps) {
            // Viimeinen step toistuu jos count ylittää taulukon pituuden
            const stepIdx = Math.min(count, rxn.steps.length - 1);
            return rxn.steps[stepIdx];
        }
        const max = rxn.maxAdditions ?? 1;
        return count < max ? rxn : null;
    }

    /**
     * Lisää aineen putken tilaan ja palauttaa reaktio-objektin.
     * Tukee monivaiheisia reaktioita (NH₃+CuSO₄, NaOH+CuSO₄, Luminol).
     *
     * MUTOI tubeState.addedIngredients ja additionCounts.
     *
     * @param {object} tubeState
     * @param {string} substance
     * @returns {object|null}
     */
    processAddition(tubeState, substance) {
        // Putki on käytetty loppuun — ei uusia reaktioita
        if (tubeState.exhausted) return null;

        const rxn = REACTIONS.find(
            r => r.tube === tubeState.baseSolution && r.reagent === substance
        );
        if (!rxn) return null;

        // Tarkista katalyytti- tai muut ainesvaatimukset
        if (rxn.requiresAny) {
            const satisfied = rxn.requiresAny.some(
                r => tubeState.addedIngredients.includes(r)
            );
            if (!satisfied) {
                // Merkitaan odottavaksi — laukeaa kun katalyytti lisataan myohemmin
                if (!tubeState.pendingIngredients.includes(substance))
                    tubeState.pendingIngredients.push(substance);
                return {
                    blocked: true,
                    hint: `Lisää ensin ${rxn.requiresAny.join(' tai ')} katalyyttina!`,
                };
            }
        }

        const count = tubeState.additionCounts[substance] ?? 0;
        const max   = rxn.maxAdditions ?? 1;
        if (count >= max) return null;

        tubeState.additionCounts[substance] = count + 1;
        if (!tubeState.addedIngredients.includes(substance))
            tubeState.addedIngredients.push(substance);

        const mainResult = this.getReaction(tubeState.baseSolution, substance, count);

        // Liitä ylätason reaktio-ohjeet tulokseen (windDown, exhaustAfter, fadeSolid)
        // Nämä siirtyvät SceneManagerille visuaalisen winddown-logiikan käyttöön.
        const enriched = { ...mainResult };
        if (rxn.windDown)     enriched.windDown     = rxn.windDown;
        if (rxn.exhaustAfter) enriched.exhaustAfter  = true;
        if (rxn.fadeSolid)    enriched.fadeSolid     = rxn.fadeSolid;

        // Tarkista avatutuiko odottavia reaktioita taman lisayksen myota
        const unlocked = this._processUnlocked(tubeState);
        if (unlocked.length > 0) return { ...enriched, also: unlocked };
        return enriched;
    }

    /**
     * Kay lapi odottavat aineet ja laukaisee reaktiot joiden vaatimukset tayttyivat.
     * @param {object} tubeState
     * @returns {object[]}  — vapautuneiden reaktioiden tulokset
     */
    _processUnlocked(tubeState) {
        const results = [];
        const pending = tubeState.pendingIngredients;
        for (let i = pending.length - 1; i >= 0; i--) {
            const sub = pending[i];
            const rxn = REACTIONS.find(
                r => r.tube === tubeState.baseSolution && r.reagent === sub
            );
            if (!rxn?.requiresAny) continue;
            const satisfied = rxn.requiresAny.some(
                r => tubeState.addedIngredients.includes(r)
            );
            if (!satisfied) continue;
            // Vaatimukset tayttyivat — laukaise reaktio
            const count = tubeState.additionCounts[sub] ?? 0;
            const max   = rxn.maxAdditions ?? 1;
            if (count < max) {
                tubeState.additionCounts[sub] = count + 1;
                if (!tubeState.addedIngredients.includes(sub))
                    tubeState.addedIngredients.push(sub);
                const r = this.getReaction(tubeState.baseSolution, sub, count);
                if (r) results.push(r);
            }
            pending.splice(i, 1);
        }
        return results;
    }

    /**
     * Nollaa putken tilan alkuperaiseksi.
     * @param {object} tubeState
     */
    resetTube(tubeState) {
        tubeState.addedIngredients.length  = 0;
        tubeState.pendingIngredients.length = 0;
        tubeState.additionCounts           = {};
        tubeState.isBubbling      = false;
        tubeState.isSmoking       = false;
        tubeState.steamIntensity  = 0;
        tubeState.hasHaze         = false;
        tubeState.producesGas     = null;
        tubeState.exhausted       = false;
    }
}
