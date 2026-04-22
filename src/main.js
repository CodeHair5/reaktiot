/**
 * main.js — sovelluksen entry point
 *
 * App-luokka sitoo yhteen SceneManagerin, ChemistryEnginen ja UIManagerin.
 * Render-silmukka pyörii requestAnimationFrame-kutsulla vasta sen jälkeen,
 * kun käyttäjä on painanut "Käynnistä simulaatio" -nappia.
 *
 * Datavirta:
 *   käyttäjä klikkaa putkea
 *     → SceneManager._onClick (raycaster)
 *     → App._onTubeClick
 *       → SceneManager.spawnDroplet
 *         → Droplet._onLand
 *           → App._onDropletLand
 *             → ChemistryEngine.processAddition
 *             → SceneManager.applyReactionVisuals
 *             → UIManager.showFormula
 */

import { SceneManager }    from './SceneManager.js';
import { ChemistryEngine } from './ChemistryEngine.js';
import { UIManager }       from './UIManager.js';

/**
 * Toistaa äänitiedoston. Epäonnistuminen (esim. tiedosto puuttuu) ei kaada sovellusta.
 * @param {string} src   - Polku äänitiedostoon
 * @param {number} [volume=1] - Äänenvoimakkuus 0–1
 */
function playSound(src, volume = 1) {
    const audio = new Audio(src);
    audio.volume = Math.max(0, Math.min(1, volume));
    audio.play().catch(() => {});
}

class App {
    constructor() {
        this.sceneManager    = new SceneManager();
        this.chemistryEngine = new ChemistryEngine();
        this.uiManager       = new UIManager();

        this._rafId     = null;
        this._running   = false;

        // Callbackit ennen init-kutsua
        this.sceneManager.onTubeClick   = this._onTubeClick.bind(this);
        this.sceneManager.onDropletLand = this._onDropletLand.bind(this);
        this.sceneManager.onReady       = this._onSceneReady.bind(this);
        this.sceneManager.onMatchTest   = this._onMatchTest.bind(this);

        this.uiManager.onStartClick  = this._onStartClick.bind(this);
        this.uiManager.onReset       = this._onReset.bind(this);
        this.uiManager.onMatchLight  = this._onMatchLight.bind(this);
        this.uiManager.onMatchDismiss = this._onMatchDismiss.bind(this);
    }

    /** Käynnistää koko sovelluksen. */
    async init() {
        this.uiManager.init();
        this.chemistryEngine.init();

        this.uiManager.setLoadingStatus('Ladataan 3D-ympäristöä…');
        await this.sceneManager.init();
        // onReady-callback kutsutaan sceneManager.init():n sisältä
    }

    // ── Yksityiset callbackit ───────────────────────────────────────────────

    /** Kutsutaan kun HDR on ladattu ja skene valmis. */
    _onSceneReady() {
        this.uiManager.setLoadingStatus('Valmis!');
        this.uiManager.setReady();
    }

    /** Käyttäjä painoi "Käynnistä simulaatio". */
    _onStartClick() {
        this.uiManager.showSimulation();
        this._startLoop();
    }

    /** Käynnistää render-silmukan. */
    _startLoop() {
        if (this._running) return;
        this._running = true;

        const loop = () => {
            this._rafId = requestAnimationFrame(loop);
            this.sceneManager.update();
        };
        this._rafId = requestAnimationFrame(loop);
    }

    /** Käyttäjä klikkasi koeputkea raycasterilla. */
    _onTubeClick(tubeIdx) {
        const substance = this.uiManager.getSelectedSubstance();
        this.sceneManager.spawnDroplet(substance, tubeIdx);
    }

    /** Tippa saavutti nesteen pinnan — prosessoi reaktio. */
    _onDropletLand(tubeIdx, substance) {
        const tube   = this.sceneManager.tubes[tubeIdx];
        const result = this.chemistryEngine.processAddition(tube.state, substance);

        if (!result) return;

        if (result.blocked) {
            // Reaktio vaatii katalyytin tai muun edellytetyn aineen
            this.uiManager.setHint(result.hint);
            return;
        }

        this.sceneManager.applyReactionVisuals(tubeIdx, result);
        this.uiManager.showFormula(result.formula);

        // Ketjureaktiot jotka avautuivat taman lisayksen myota (esim. Luminol kun Fe/Cu lisataan)
        if (result.also) {
            for (const chained of result.also) {
                this.sceneManager.applyReactionVisuals(tubeIdx, chained);
            }
        }
    }

    /** Nollaa simulaatio alkutilaan. */
    _onReset() {
        // Nollaa kemiallinen tila kaikille putkille
        for (const tube of this.sceneManager.tubes) {
            this.chemistryEngine.resetTube(tube.state);
        }
        // Nollaa 3D-tila
        this.sceneManager.reset();
        // Piiloita kaava ja tulitikun poisto
        this.uiManager.showFormula(null);
        this.uiManager.showMatchDismiss(false);
        this.uiManager.setHint('Valitse aine ja klikkaa koeputkea');
    }

    /** Käyttäjä painoi tulitikkunappia. */
    _onMatchLight() {
        this.sceneManager.lightMatch();
        this.uiManager.showMatchDismiss(true);
        this.uiManager.setHint('Klikkaa koeputkea tulitikkutestiä varten');
        playSound('src/Sounds/tulitikku.mp3', 0.3);
    }

    /** Käyttäjä poistaa tulitikun. */
    _onMatchDismiss() {
        this.sceneManager.dismissMatch();
        this.uiManager.showMatchDismiss(false);
        this.uiManager.setHint('Valitse aine ja klikkaa koeputkea');
    }

    /** Tulitikku viedään putken suulle — testaa kaasu. */
    _onMatchTest(tubeIdx) {
        const tube  = this.sceneManager.tubes[tubeIdx];
        const gas   = tube.state.producesGas;
        const match = this.sceneManager.match;
        if (!match) return;

        if (gas === 'H2') {
            // Vety: paukahtava pop — liekki sammuu, kipinät + huurre + paineaalto
            // Ääni käynnistetään ensin; visuaaliset efektit viivästetään 120 ms
            // jotta selaimen ääni-I/O ehtii käynnistyä ennen räjähdysflashin.
            playSound('src/Sounds/vety.mp3');
            setTimeout(() => {
                match.triggerH2Pop();
                this.sceneManager.triggerH2PopVFX(tubeIdx);
                this.sceneManager.spikeBloom(2.8, 0.55);
            }, 120);
            this.uiManager.showFormula('H₂(g) + ½O₂ → H₂O  💥 Paukahdus!');
            this.uiManager.setHint('Vetykaasu paukahtaa!');
        } else if (gas === 'CO2') {
            // Hiilidioksidi: sammuttaa liekin hiljaisesti — tikku jää näkyviin
            match.extinguishFlame();
            this.sceneManager.triggerCO2Extinguish(tubeIdx);
            this.uiManager.showFormula('CO₂(g) — sammuttaa liekin');
            this.uiManager.setHint('Hiilidioksidi sammuttaa tulitikun!');
        } else if (gas === 'O2') {
            // Happi: jatkuva pulssimainen hehku niin kauan kuin tikku on yllä
            match.startO2Continuous();
            this.sceneManager._o2MatchTubeIdx = tubeIdx;
            this.uiManager.showFormula('O₂(g) — liekki syttyy kirkkaammin');
            this.uiManager.setHint('Happi kirkastaa liekin!');
        } else {
            this.uiManager.setHint('Ei havaittavaa kaasua tässä putkessa');
        }
    }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
const app = new App();
app.init().catch((err) => {
    console.error('[App] Alustus epäonnistui:', err);
});
