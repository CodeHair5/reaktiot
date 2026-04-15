/**
 * UIManager.js
 *
 * Hallitsee kaikki HTML-UI-elementit:
 *   • Latausruutu + käynnistysnappi
 *   • Reagenssivalikko (vasen yläkulma)
 *   • Kaavaruutu (alhaalla)
 *   • Ohjeteksti
 *
 * Ei Three.js-riippuvuuksia.
 * Kommunikoi muun sovelluksen kanssa callback-kentillä.
 */

export class UIManager {
    constructor() {
        // DOM-elementit
        this._loadingScreen  = document.getElementById('loading-screen');
        this._loadingStatus  = document.getElementById('loading-status');
        this._startBtn       = document.getElementById('start-btn');
        this._panel          = document.getElementById('reagent-panel');
        this._select         = document.getElementById('reagent-select');
        this._resetBtn       = document.getElementById('reset-btn');
        this._matchBtn       = document.getElementById('match-btn');
        this._matchDismissBtn = document.getElementById('match-dismiss-btn');
        this._formulaBox     = document.getElementById('formula-box');
        this._hint           = document.getElementById('hint');

        // Callbackit — App asettaa nämä ennen init()-kutsua
        this.onStartClick   = null;
        this.onReset        = null;
        this.onMatchLight   = null;   // () => void
        this.onMatchDismiss = null;   // () => void
    }

    /** Kiinnittää tapahtumakuuntelijat. Kutsu kerran. */
    init() {
        this._startBtn.addEventListener('click', () => {
            if (this.onStartClick) this.onStartClick();
        }, { once: true });

        this._resetBtn.addEventListener('click', () => {
            if (this.onReset) this.onReset();
        });

        if (this._matchBtn) {
            this._matchBtn.addEventListener('click', () => {
                if (this.onMatchLight) this.onMatchLight();
            });
        }
        if (this._matchDismissBtn) {
            this._matchDismissBtn.addEventListener('click', () => {
                if (this.onMatchDismiss) this.onMatchDismiss();
            });
        }
    }

    // ── Latausruutu ───────────────────────────────────────────────────────────

    /** Päivittää latausstatustekstin (esim. "Ladataan ympäristöä…"). */
    setLoadingStatus(text) {
        if (this._loadingStatus) this._loadingStatus.textContent = text;
    }

    /** Aktivoi käynnistysnapin kun ympäristö on valmis. */
    setReady() {
        this._startBtn.disabled    = false;
        this._startBtn.textContent = 'Käynnistä simulaatio';
    }

    /** Häivyttää latausruudun ja näyttää reagenssipaneelin. */
    showSimulation() {
        // Häivytys CSS:n opacity-transitiolla
        this._loadingScreen.style.opacity    = '0';
        this._loadingScreen.style.pointerEvents = 'none';
        setTimeout(() => {
            this._loadingScreen.classList.add('hidden');
        }, 650);

        this._panel.classList.remove('hidden');
        this._hint.classList.remove('hidden');
    }

    // ── Reagenssit ────────────────────────────────────────────────────────────

    /** Palauttaa tällä hetkellä valitun aineen tunnisteen. */
    getSelectedSubstance() {
        return this._select.value;
    }

    // ── Kaavaruutu ────────────────────────────────────────────────────────────

    /**
     * Näyttää reaktioyhtälön kaavaruudussa.
     * Kutsu null:lla piilottaaksesi.
     * @param {string|null} text
     */
    showFormula(text) {
        if (!text) {
            this._formulaBox.classList.add('hidden');
            return;
        }
        this._formulaBox.textContent = text;
        this._formulaBox.classList.remove('hidden');
    }

    // ── Ohjeteksti ────────────────────────────────────────────────────────────

    /** @param {string} text */
    setHint(text) {
        if (this._hint) this._hint.textContent = text;
    }

    /** Näyttää/piilottaa tulitikun poistonapin. */
    showMatchDismiss(visible) {
        if (this._matchDismissBtn) {
            this._matchDismissBtn.classList.toggle('hidden', !visible);
        }
    }
}
