/**
 * SceneManager.js
 *
 * Three.js-maailman hallinta:
 *   • Renderer, kamera, OrbitControls
 *   • HDR-ympäristö (glass-heijastuksia varten)
 *   • Koeputkiteline + 4 Tube-instanssia
 *   • EffectManager
 *   • Raycaster-klikkaustunnistus
 *   • Droplet-instanssien elinkaarenhallinnan
 *
 * Julkiset callbackit (App asettaa nämä):
 *   onTubeClick(tubeIdx)              — käyttäjä klikkasi putkea
 *   onDropletLand(tubeIdx, substance) — tippa saavutti nesteen pinnan
 *   onReady()                         — HDR ladattu, simulaatio valmis
 */

import * as THREE          from 'three';
import { OrbitControls }   from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { Tube }          from './objects/Tube.js';
import { Droplet }       from './objects/Droplet.js';
import { Match }         from './objects/Match.js';
import { EffectManager } from './EffectManager.js';

// ── Putkimäärittelyt (speksi §3.1) ────────────────────────────────────────────
const TUBE_DEFS = [
    { baseSolution: 'HCl',   color: 0xe8f0f6, label: 'HCl' },
    { baseSolution: 'CuSO4', color: 0x5eb8f0, label: 'CuSO₄' },
    { baseSolution: 'FeSO4', color: 0x7ec87e, label: 'FeSO₄' },
    { baseSolution: 'H2O2',  color: 0xe8f0f6, label: 'H₂O₂' },
];

const TUBE_SPACING = 2.2;
const TUBE_START_X = -((TUBE_DEFS.length - 1) * TUBE_SPACING) / 2;

// Jatkuvan poreilun spawni-todennäköisyys per frame
const BUBBLE_SPAWN_CHANCE = 0.22;
const BUBBLES_PER_SPAWN   = 2;

// Kiinteät aineet: putoavat putken pohjalle eivätkä häviä pinnalle
const SOLID_SUBSTANCES = new Set(['Fe', 'Mg', 'Cu', 'CaCO3']);

// Kiinteiden aineiden ripple: tunnistetaan pintarajan ylitys Droplet.update():ssa

// ── Luokka ────────────────────────────────────────────────────────────────────
export class SceneManager {
    constructor() {
        this.scene    = new THREE.Scene();
        this.clock    = new THREE.Clock();

        /** @type {Tube[]} */
        this.tubes    = [];

        this._renderer        = null;
        this._camera          = null;
        this._controls        = null;
        this._effects         = null;

        this._droplets        = [];          // Droplet[] (lennossa)
        this._solids          = [];          // Droplet[] (laskeutunut, jää näkyviin)
        // Yhtenäinen värianimaatiolista: { from, to, dur, elapsed, apply(THREE.Color) }
        // Kattaa sekä liuosten värimuutokset että kiinteiden kappaleiden pintavärit.
        this._colorAnims      = [];
        this._glowLights      = new Map();   // tubeIdx → { light, intensity }
        this._clickableMeshes = [];          // raycaster targets
        this._meshToTubeIdx   = new Map();   // THREE.Mesh → number

        this._raycaster       = new THREE.Raycaster();
        this._mouse           = new THREE.Vector2();

        // Esiallokoidut väliaikaisobjektit hot-path-käyttöön (ei GC-piikkejä)
        this._tmpColor = new THREE.Color();
        this._tmpVec3  = new THREE.Vector3();

        // Savun tasainen emissio: ajastinpohjainen (ei random per frame)
        this._smokeTimers = new Map();
        // Höyryn tasainen emissio: intensiteetti ohjaa tiheyttä + kokoa
        this._steamTimers = new Map();

        // Tulitikku
        this._match          = null;
        this._matchMode      = false;   // true kun tulitikku on sytytetty

        this._css2dRenderer   = null;

        // Bloom-efektin tila
        this._composer    = null;
        this._bloomPass   = null;
        this._bloomBase   = 0.20;   // hienovarainen perusloiste
        this._bloomSpike  = 0;      // väliaikainen lisäteho (reaktioissa)
        this._bloomDecay  = 0;      // lisätehon poistumisnopeus (/s)

        // Adaptiivinen laatu: FPS-mittaus ensimmäisten 3 s aikana.
        // Jos FPS jää alle 40, siirrytään kevyempään tilaan: bloom pois,
        // pikselisuhde 1× — nämä ovat suurimmat GPU-kuorman aiheuttajat.
        this._aqFrames   = 0;
        this._aqElapsed  = 0;
        this._aqLocked   = false;  // true kun mittaus valmis
        this._lowQuality = false;  // true kun huonotehoinen laite havaittu

        // O₂ jatkuvan bloom-pulssin tila
        this._o2MatchTubeIdx  = -1;   // putki jonka päällä tikku on O₂-moodissa
        this._gasDecayTimers  = new Map();   // tubeIdx → sekuntia jäljellä

        // Reaktion vaimeneminen: { delay, duration, elapsed, exhaustAfter, fadeSolid,
        //                          origBubbling, origSteam, origBoil, origRipple }
        this._windDownTimers  = new Map();   // tubeIdx → windDown-kuvaus

        this._boundOnClick    = this._onClick.bind(this);
        this._boundOnResize   = this._onResize.bind(this);

        // Viittaus juuri laskeutuvaan tiputukseen (saatavilla applyReactionVisuals-kutsun ajan)
        this._landingDroplet  = null;

        // App asettaa nämä
        this.onTubeClick    = null;
        this.onDropletLand  = null;
        this.onReady        = null;
        this.onMatchTest    = null;   // (tubeIdx) => void — tulitikkutesti putkelle
    }

    // ── Alustus ───────────────────────────────────────────────────────────────

    /**
     * Rakentaa rendererin, kameran, valaistuksen ja lataa HDR.
     * Palauttaa Promisen joka resolvaa kun skene on valmis.
     */
    async init() {
        this._buildRenderer();
        this._buildCamera();
        this._buildLights();

        this._buildGradientEnvironment();

        this._buildRack();
        this._buildTubes();

        this._effects = new EffectManager(this.scene);
        this._effects.init();

        // Tulitikku
        this._match = new Match(this.scene);

        // Lämmittele liekki-shader etukäteen — estää tökkimisen ensimmäisellä sytyttämisellä
        // Välitetään myös composer, jotta bloom-passin shaderit käännetään samalla.
        this._match.prewarm(this._renderer, this._camera, this._composer);

        window.addEventListener('resize', this._boundOnResize);
        this._renderer.domElement.addEventListener('click', this._boundOnClick);

        if (this.onReady) this.onReady();
    }

    // ── Pääsilmukka ───────────────────────────────────────────────────────────

    /** Advance-kutsu joka frame (requestAnimationFrame antaa). */
    update() {
        const dt   = this.clock.getDelta();
        const time = this.clock.getElapsedTime();

        // ── Adaptiivinen laatu ─────────────────────────────────────────────────
        // Mitataan FPS ensimmäisten 3 s aikana. Jos laite ei ylläpidä 40 FPS:ää,
        // kytketään bloom pois ja lasketaan pikselisuhde 1×:ään — nämä ovat
        // ylivoimaisesti suurimmat GPU-kuorman aiheuttajat.
        if (!this._aqLocked) {
            this._aqFrames++;
            this._aqElapsed += dt;
            if (this._aqElapsed >= 3.0) {
                this._aqLocked = true;
                const fps = this._aqFrames / this._aqElapsed;
                if (fps < 40) {
                    this._lowQuality = true;
                    this._renderer.setPixelRatio(1);
                    const w = window.innerWidth, h = window.innerHeight;
                    this._renderer.setSize(w, h);
                    this._composer.setSize(w, h);
                    if (this._bloomPass) this._bloomPass.enabled = false;
                }
            }
        }

        // Shader-uniformit
        for (const tube of this.tubes) tube.update(dt, time);

        // Dropletit
        for (let i = this._droplets.length - 1; i >= 0; i--) {
            const d = this._droplets[i];
            d.update(dt);
            if (d.landed) {
                if (d.isSolid) {
                    this._solids.push(d);   // kiinteät jäävät näkyviin putkessa
                } else {
                    d.dispose();
                }
                this._droplets.splice(i, 1);
            }
        }

        // Värianimaatiot — liuokset + kiinteät kappaleet samassa silmukassa
        for (let i = this._colorAnims.length - 1; i >= 0; i--) {
            const a = this._colorAnims[i];
            a.elapsed += dt;
            const t = Math.min(a.elapsed / a.dur, 1.0);
            a.apply(this._tmpColor.copy(a.from).lerp(a.to, t));
            if (t >= 1.0) this._colorAnims.splice(i, 1);
        }

        // Jatkuva poreilu aktiivisille putkille (intensiteetti riippuu reaktiosta)
        for (const tube of this.tubes) {
            if (tube.state.isBubbling &&
                Math.random() < BUBBLE_SPAWN_CHANCE * tube.state.bubblingIntensity) {
                this._effects.createBubbles(tube, BUBBLES_PER_SPAWN);
            }
            // Jatkuva kiehumisefekti — roiskeita + subsurface foam-kuplia + isot pohjakuplat
            if (tube.isBoiling) {
                const boil = tube._boilTarget;
                if (Math.random() < 0.10 * boil)
                    this._effects.createBoilSplashes(tube, 1 + (Math.random() < 0.4 ? 1 : 0));
                if (Math.random() < 0.30 * boil)
                    this._effects.createFoamBubbles(tube, 1);
                if (Math.random() < 0.04 * boil)
                    this._effects.createBigBoilBubble(tube);
            }
            // Kevyt poreilu (esim. Mg + HCl) — pienet pintakuplat + väreily
            // Kantaluku 0.25 (vs. 0.22 'bubbling'-systeemissä) — kuplat pienempiä
            // mutta tiheämmin, intensiteetti skaalaa BUBBLING_INTENSITY-tasolla.
            // Korkea intensiteetti (>= 0.5) spawna 2 kupla per laukaisu.
            if (tube.isRippling) {
                const rpl = tube._rippleTarget;
                const n   = rpl >= 0.5 ? 2 : 1;
                if (Math.random() < 0.25 * rpl)
                    this._effects.createGentleBubble(tube, n);
            }
            // Jatkuva savu (NH₃+HCl ym.) — tasaisin välein, ei random-pulssi
            if (tube.state.isSmoking) {
                const SMOKE_INTERVAL = 0.55;   // 1 partikkeli n. 1.8/s
                const prev = this._smokeTimers.get(tube.id) || 0;
                const next = prev + dt;
                if (next >= SMOKE_INTERVAL) {
                    const gp = tube.group.position;
                    this._tmpVec3.set(gp.x, gp.y + tube.liquidLevel, gp.z);
                    const tubeTopY = gp.y + tube.tubeHeight;
                    this._effects.createSmoke(this._tmpVec3, 1, tubeTopY);
                    this._smokeTimers.set(tube.id, next - SMOKE_INTERVAL);
                } else {
                    this._smokeTimers.set(tube.id, next);
                }
            }
            // Jatkuva höyry — intensiteetti ohjaa tiheyttä, kokoa ja nopeutta
            if (tube.state.steamIntensity > 0) {
                const si = tube.state.steamIntensity;
                const STEAM_INTERVAL = 1.8 / si;   // VL(2)=0.9s, M(6)=0.3s, H(10)=0.18s
                const prev = this._steamTimers.get(tube.id) || 0;
                const next = prev + dt;
                if (next >= STEAM_INTERVAL) {
                    // Spawnataan putken suuaukon kohdalta jotta höyry tulee heti näkyviin
                    const gps = tube.group.position;
                    this._tmpVec3.set(gps.x, gps.y + tube.liquidLevel, gps.z);
                    // 2-3 partikkelia per triggeri — vältyy jonosta
                    const burst = 2 + (Math.random() < 0.4 ? 1 : 0);
                    this._effects.createSteam(this._tmpVec3, burst, si);
                    this._steamTimers.set(tube.id, next - STEAM_INTERVAL);
                } else {
                    this._steamTimers.set(tube.id, next);
                }
            }
        }

        // Luminol-pistevalo: seuraa putken sisäistä hehkua täsmällisesti
        for (const [idx, ld] of this._glowLights) {
            const peak = ld.peakIntensity ?? 0;
            if (peak > 0) {
                const tubeGlow = this.tubes[idx].glowFlashIntensity; // 0–4.5
                ld.light.intensity = (tubeGlow / 4.5) * peak;
                // Nollaa huippu kun putken glow on sammunut
                if (tubeGlow <= 0) ld.peakIntensity = 0;
            }
        }

        this._effects.update(dt);
        if (this._match) this._match.update(dt);
        this._controls.update();

        // ── Reaktion vaimeneminen (windDown) ──────────────────────────────────────
        for (const [idx, wd] of this._windDownTimers) {
            wd.elapsed += dt;
            const tube = this.tubes[idx];

            if (wd.elapsed < wd.delay) {
                // Viivejakso — ei vielä vaimennusta
                continue;
            }

            const t = Math.min((wd.elapsed - wd.delay) / wd.duration, 1.0);   // 0→1
            const factor = 1 - t;   // 1→0

            // Vaimenna kuplinta/poreilu/kiehuminen suhteessa alkuperäiseen
            if (wd.origRipple > 0)   tube._rippleTarget = wd.origRipple * factor;
            if (wd.origBoil > 0)     tube._boilTarget   = wd.origBoil   * factor;
            if (wd.origBubbling > 0) tube.state.bubblingIntensity = wd.origBubbling * factor;
            if (wd.origSteam > 0)    tube.state.steamIntensity    = wd.origSteam    * factor;

            // Savu vaimenee: lopeta kokonaan viimeisellä kolmanneksella
            if (t > 0.65 && tube.state.isSmoking) {
                tube.state.isSmoking = false;
            }

            // CaCO3 (tai muu kiinteä) häivytetään pienenemällä + fadella
            if (wd.fadeSolid && t > 0.2) {
                const fadeT = Math.min((t - 0.2) / 0.8, 1.0);   // 0→1 viimeisen 80% aikana
                for (const s of this._solids) {
                    if (s.substance === wd.fadeSolid) {
                        const sc = 1 - fadeT * 0.85;   // kutistuu 15%:iin
                        s.mesh.scale.setScalar(sc);
                        const mat = s.mesh.material;
                        if (mat) {
                            mat.transparent = true;
                            mat.opacity = 1 - fadeT;
                        }
                    }
                }
            }

            // Valmis: kaikki efektit sammutettu
            if (t >= 1.0) {
                tube.state.isSmoking      = false;
                tube.state.steamIntensity = 0;
                tube.state.isBubbling     = false;
                tube.state.bubblingIntensity = 0;
                tube.setBubbling(false);
                tube.stopBoiling();
                tube.stopRippling();
                tube.state.producesGas    = null;

                // Poista häipyneet kiinteät kappaleet kokonaan
                if (wd.fadeSolid) {
                    for (let i = this._solids.length - 1; i >= 0; i--) {
                        if (this._solids[i].substance === wd.fadeSolid) {
                            this._solids[i].dispose();
                            this._solids.splice(i, 1);
                        }
                    }
                }

                if (wd.exhaustAfter) tube.state.exhausted = true;

                // Lopeta O₂-pulssi jos tikku oli tämän putken päällä
                if (this._o2MatchTubeIdx === idx && this._match) {
                    this._match.stopO2Continuous();
                    this._o2MatchTubeIdx = -1;
                }

                this._windDownTimers.delete(idx);
            }
        }

        // ── Kaasujen hajoamistimer ──────────────────────────────────────────────────────
        for (const [idx, remaining] of this._gasDecayTimers) {
            const next = remaining - dt;
            if (next <= 0) {
                this._gasDecayTimers.delete(idx);
                const tube = this.tubes[idx];
                tube.state.producesGas    = null;
                tube.state.steamIntensity = 0;
                tube.state.isSmoking      = false;
                tube.setBubbling(false);
                tube.stopBoiling();
                tube.stopRippling();
                // Lopeta O₂ jatkuva pulssi jos tikku oli tämän putken päällä
                if (this._o2MatchTubeIdx === idx && this._match) {
                    this._match.stopO2Continuous();
                    this._o2MatchTubeIdx = -1;
                }
            } else {
                this._gasDecayTimers.set(idx, next);
            }
        }

        // ── O₂ bloom kasvaa tasaisesti — ei sykkivää palloa ──────────────────────
        if (this._match && this._match.o2Continuous) {
            const level = Math.min((this._match.o2FlameT || 0) / 2.0, 1.0);
            if (this._bloomPass) this._bloomPass.strength = this._bloomBase + level * 5.5;
        } else {
            // Bloom-teho: haalistuu hitaasti perustasolle — AINA päivitetty
            if (this._bloomSpike > 0) {
                this._bloomSpike = Math.max(0, this._bloomSpike - this._bloomDecay * dt);
            }
            if (this._bloomPass) {
                this._bloomPass.strength = this._bloomBase + this._bloomSpike;
            }
        }

        // Renderöi: huonotehoisilla laitteilla ohitetaan EffectComposer (bloom)
        // ja käytetään suoraa renderöintiä — säästää useita GPU-kierroksia per frame.
        if (this._lowQuality) {
            this._renderer.render(this.scene, this._camera);
        } else {
            this._composer.render();
        }
        this._css2dRenderer.render(this.scene, this._camera);
    }

    // ── Julkinen API ──────────────────────────────────────────────────────────

    /**
     * Spawna animoitu tippa putkeen.
     * @param {string} substance
     * @param {number} tubeIdx
     */
    spawnDroplet(substance, tubeIdx) {
        const tube    = this.tubes[tubeIdx];
        const gp      = tube.group.position;
        const startY  = gp.y + 7.5;
        // Kiinteät kappaleet putoavat putken pohjalle; nesteet pysähtyvät pinnalle
        const isSolid = SOLID_SUBSTANCES.has(substance);
        const liquidSurfaceY = gp.y + tube.liquidLevel;
        const targetY = isSolid ? gp.y + 0.20 : liquidSurfaceY;

        // Pintarajan ripple: laukaistaan aina kun kappale ylittää nesteenpinnan
        const onSurfaceCross = isSolid
            ? () => { tube.triggerRipple(new THREE.Vector2(0.5, 0.5), 1.4); }
            : null;

        const droplet = new Droplet(
            substance,
            new THREE.Vector3(gp.x, startY, gp.z),
            targetY,
            liquidSurfaceY,
            this.scene,
            (d) => this._handleDropletLand(d, tubeIdx),
            onSurfaceCross
        );
        this._droplets.push(droplet);
    }

    /**
     * Soveltaa reaktion visuaaliset efektit putkeen.
     * Kutsutaan App:sta ChemistryEnginen palauttaman tuloksen perusteella.
     *
     * @param {number} tubeIdx
     * @param {object} result   — ReactionResult (ChemistryEngine)
     */
    applyReactionVisuals(tubeIdx, result) {
        const tube    = this.tubes[tubeIdx];
        const surfPos = tube.group.position.clone();
        surfPos.y    += tube.liquidLevel;

        // Tallenna tuotettavan kaasun tyyppi tulitikkutestia varten
        if (result.producesGas) {
            tube.state.producesGas = result.producesGas;
            // Kaasun hajoamistimer (esim. H₂O₂ → O₂ ~20 s)
            if (result.gasDecayTime) {
                this._gasDecayTimers.set(tubeIdx, result.gasDecayTime);
            }
        }

        if (result.newColor != null) {
            if (result.colorChangeDuration) {
                // Animoitu värinmuutos (esim. Fe + HCl → vihreä FeCl₂)
                const from = new THREE.Color(tube.state.currentLiquidColor);
                const to   = new THREE.Color(result.newColor);
                this._colorAnims.push({
                    from, to, dur: result.colorChangeDuration, elapsed: 0,
                    apply: (c) => tube.updateColor(c.getHex()),
                });
            } else {
                tube.updateColor(result.newColor);
            }
        }

        for (const fx of result.visuals) {
            switch (fx) {
                case 'vigorous':
                    tube.startBoiling(result.bubblingIntensity ?? 1.0);
                    break;
                case 'gentle':
                    tube.startRippling(result.bubblingIntensity ?? 1.0);
                    // Alkupurskahdus — määrä skaalaa intensiteetillä
                    this._effects.createGentleBubble(tube,
                        Math.round(10 * (result.bubblingIntensity ?? 1.0)));
                    break;
                case 'bubbling':
                    tube.state.bubblingIntensity = result.bubblingIntensity ?? 1.0;
                    tube.setBubbling(true);
                    this._effects.createBubbles(tube, Math.round(10 * (result.bubblingIntensity ?? 1.0)));
                    break;
                case 'steam':
                    // Tallenna intensiteetti — jatkuva höyryloop hoitaa emission
                    tube.state.steamIntensity = result.steamIntensity ?? 3;
                    break;
                case 'smoke': {
                    // Ensimmäinen lisäys: käynnistää jatkuvan savuemission
                    tube.state.isSmoking = true;
                    // Alkupurskahdus — täyttää putken heti
                    const liquidPos = tube.group.position.clone();
                    liquidPos.y += tube.liquidLevel;
                    const tubeTopY = tube.group.position.y + tube.tubeHeight;
                    this._effects.createSmoke(liquidPos, 16, tubeTopY);
                    break;
                }
                case 'haze':
                    tube.setHaze(result.hazeIntensity ?? 0.50);
                    break;
                case 'colorChange':
                    // väri jo asetettu newColor:n kautta
                    break;
                case 'precipitate': {
                    // Sakkautuminen: laukaistaan aina kemiamoottorista tulleella värillä
                    const pColor = result.precipitateColor ?? 0x888888;
                    this._effects.createPrecipitate(
                        tube, pColor, 25,
                        { instant: !!result.precipitateInstant }
                    );
                    break;
                }
                case 'metalDeposit': {
                    // Värimuutos hoidetaan solidColorChange-kentän kautta
                    break;
                }
                case 'dissolve':
                    // NH₃+CuSO₄ kolmas lisäys: sakka liukenee
                    this._effects.dissolvePrecipitate(tube);
                    break;
                case 'glowFlash': {
                    // Luminol: kirkas sininen väläys — jokaisella lisäyksellä intensiteetti kasvaa
                    tube.setGlowFlash(result.glowColor ?? 0x0022ff);
                    const ld = this._glowLights.get(tubeIdx);
                    if (ld) {
                        // Säilytä viimeisin huippuintensiteetti skaalausta varten
                        ld.peakIntensity = Math.min((ld.peakIntensity ?? 0) + 9.0, 22.0);
                    }
                    break;
                }
                case 'glow':
                    // Varattu tuleville reaktioille — ei käytössä
                    tube.setGlowFlash(result.glowColor ?? 0x1133ff);
                    break;
            }
        }

        // Kiinteän aineen värianimaatio (esim. Fe → Cu-väri CuSO₄:ssä)
        if (result.solidColorChange) {
            const scc = result.solidColorChange;
            // Tarkista ensin juuri laskeutunut kappale (ei vielä _solids-listassa)
            let target = null;
            if (this._landingDroplet?.isSolid && this._landingDroplet.substance === scc.substance) {
                target = this._landingDroplet;
            } else {
                for (let i = this._solids.length - 1; i >= 0; i--) {
                    if (this._solids[i].substance === scc.substance) {
                        target = this._solids[i];
                        break;
                    }
                }
            }
            if (target) {
                const mat = target.cloneMaterial();
                this._colorAnims.push({
                    from:    new THREE.Color(mat.color.getHex()),
                    to:      new THREE.Color(scc.toColor),
                    dur:     scc.duration,
                    elapsed: 0,
                    apply:   (c) => mat.color.copy(c),
                });
            }
        }

        // Reaktion vaimeneminen: käynnistetään ajastin (korvaa edellisen jos jo pyörii)
        if (result.windDown) {
            const wd = result.windDown;
            this._windDownTimers.set(tubeIdx, {
                delay:         wd.delay    ?? 5.0,
                duration:      wd.duration ?? 8.0,
                elapsed:       0,
                exhaustAfter:  !!result.exhaustAfter,
                fadeSolid:     result.fadeSolid ?? null,
                origRipple:    tube._rippleTarget,
                origBoil:      tube._boilTarget,
                origBubbling:  tube.state.bubblingIntensity,
                origSteam:     tube.state.steamIntensity,
            });
        }
    }

    /**
     * H2-poksahduksen VFX: kipinäefekti putken suulle + lasin huurrutus.
     * @param {number} tubeIdx
     */
    triggerH2PopVFX(tubeIdx) {
        const tube = this.tubes[tubeIdx];
        // Kipinät spawnataan putken suuaukon kohdalle
        const pos = tube.group.position.clone();
        pos.y += tube.tubeHeight + 0.05;
        this._effects.createH2Pop(pos);
        // Lasi huurustuu (vesipisarat tiivistyvät seinämiin)
        tube.frost(3.5);
    }

    /**
     * CO₂-sammutuksen VFX: pieni savupilvi putken suulta.
     * @param {number} tubeIdx
     */
    triggerCO2Extinguish(tubeIdx) {
        const tube = this.tubes[tubeIdx];
        const pos  = tube.group.position.clone();
        pos.y += tube.tubeHeight + 0.05;
        this._effects.createExtinguishSmoke(pos, 14);
    }

    /**
     * Nostetaan bloom-tehoa väliaikaisesti (happi- ja vetyre aktioihin).
     * @param {number} extra     - lisäteho baselineen päälle
     * @param {number} duration  - kesto sekunteina (lineaarinen lasku)
     */
    spikeBloom(extra, duration) {
        if (!this._bloomPass) return;
        this._bloomSpike = extra;
        this._bloomDecay = extra / Math.max(0.01, duration);
    }

    /** Nollaa kaikki putket ja efektit alkutilaan. */
    reset() {
        for (const d of this._droplets) d.dispose();
        this._droplets.length = 0;

        for (const s of this._solids) s.dispose();
        this._solids.length = 0;

        this._colorAnims.length = 0;
        this._smokeTimers.clear();
        this._steamTimers.clear();
        this._windDownTimers.clear();

        // Sammuta tulitikku
        if (this._match) {
            this._match.extinguish();
            this._matchMode      = false;
            this._o2MatchTubeIdx = -1;
        }

        // Nollaa bloom
        this._bloomSpike = 0;
        if (this._bloomPass) this._bloomPass.strength = this._bloomBase;
        this._gasDecayTimers.clear();

        // Sammuta Luminol-pistevalo
        for (const [, ld] of this._glowLights) {
            ld.peakIntensity  = 0;
            ld.light.intensity = 0;
        }

        for (let i = 0; i < this.tubes.length; i++) {
            this.tubes[i].reset();
        }

        this._effects.reset();
    }

    /**
     * Vapauttaa kaikki GPU-resurssit.
     * Kutsu vain sovelluksen sulkeutuessa.
     */
    dispose() {
        window.removeEventListener('resize',  this._boundOnResize);
        this._renderer.domElement.removeEventListener('click', this._boundOnClick);

        for (const d of this._droplets) d.dispose();
        for (const t of this.tubes)     t.dispose();
        if (this._match) this._match.dispose();
        this._effects.dispose();
        this._controls.dispose();
        this._renderer.dispose();
        if (this._css2dRenderer.domElement.parentNode) {
            this._css2dRenderer.domElement.parentNode.removeChild(this._css2dRenderer.domElement);
        }
    }

    // ── Tulitikku ──────────────────────────────────────────────────────────────

    /** Sytyttää tulitikun. Klikkaus putkeen testaa kaasun. */
    lightMatch() {
        if (!this._match) return;
        this._match.setRestPosition(this._camera);
        this._match.light();
        this._matchMode = true;
    }

    /** Poistaa tulitikun näkyvistä ja palaa normaalimoodiin. */
    dismissMatch() {
        if (!this._match) return;
        this._match.extinguishFlame();
        this._match.hide();
        this._matchMode = false;
        if (this._o2MatchTubeIdx !== -1) {
            this._match.stopO2Continuous();
            this._o2MatchTubeIdx = -1;
        }
    }

    /** Palauttaa Match-instanssin (UI/App käyttöön). */
    get match() { return this._match; }

    /** Vie tulitikun putken suulle ja laukaisee kaasutestin. */
    _testMatchOnTube(tubeIdx) {
        const tube = this.tubes[tubeIdx];
        const tubeTopPos = tube.group.position.clone();
        tubeTopPos.y += tube.tubeHeight;
        this._match.moveToTube(tubeTopPos, tubeIdx);

        // Jos edellinen putki oli O₂-moodissa, lopeta se
        if (this._o2MatchTubeIdx !== -1 && this._o2MatchTubeIdx !== tubeIdx) {
            this._match.stopO2Continuous();
            this._o2MatchTubeIdx = -1;
        }

        // Ilmoita App:lle kaasutestistä kun tikku on saapunut putken suulle.
        // rAF-polling: tarkistaa joka frame onko liike pysähtynyt — ei kiinteää viivettä.
        const MAX_WAIT_MS = 2500;
        const startTime   = performance.now();
        const poll = () => {
            if (!this._match.isMoving || performance.now() - startTime > MAX_WAIT_MS) {
                if (this.onMatchTest) this.onMatchTest(tubeIdx);
            } else {
                requestAnimationFrame(poll);
            }
        };
        requestAnimationFrame(poll);
    }

    // ── Yksityiset rakentajat ─────────────────────────────────────────────────

    _buildRenderer() {
        const r = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        r.setSize(window.innerWidth, window.innerHeight);
        r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        r.toneMapping         = THREE.ACESFilmicToneMapping;
        r.toneMappingExposure = 1.2;
        r.localClippingEnabled = true;
        document.body.appendChild(r.domElement);
        this._renderer = r;

        // Bloom-jälkikäsittely
        const res = new THREE.Vector2(window.innerWidth, window.innerHeight);
        this._composer = new EffectComposer(r);
        this._composer.addPass(new RenderPass(this.scene, null));  // kamera asetetaan _buildCamera:ssa
        this._bloomPass = new UnrealBloomPass(res, this._bloomBase, 0.45, 0.82);
        this._composer.addPass(this._bloomPass);

        // CSS2D-rendereri HTML-labeleja varten
        const css2d = new CSS2DRenderer();
        css2d.setSize(window.innerWidth, window.innerHeight);
        css2d.domElement.style.position     = 'absolute';
        css2d.domElement.style.top          = '0';
        css2d.domElement.style.pointerEvents = 'none';
        document.body.appendChild(css2d.domElement);
        this._css2dRenderer = css2d;
    }

    _buildCamera() {
        this._camera = new THREE.PerspectiveCamera(
            50, window.innerWidth / window.innerHeight, 0.1, 200
        );
        this._camera.position.set(0, 3, 14);

        this._controls = new OrbitControls(this._camera, this._renderer.domElement);
        this._controls.target.set(0, 1.5, 0);
        this._controls.enableDamping   = true;
        this._controls.dampingFactor   = 0.08;
        this._controls.minDistance     = 4;
        this._controls.maxDistance     = 30;

        // Aseta kamera RenderPass-kohteeseen (rakennettu ennen kameraa)
        this._composer.passes[0].camera = this._camera;
    }

    _buildLights() {
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));

        const key = new THREE.DirectionalLight(0xffffff, 1.4);
        key.position.set(5, 10, 6);
        this.scene.add(key);

        const fill = new THREE.DirectionalLight(0xd0e8ff, 0.4);
        fill.position.set(-5, 3, -4);
        this.scene.add(fill);
    }

    _buildGradientEnvironment() {
        const canvas = document.createElement('canvas');
        canvas.width = 1024;
        canvas.height = 512;
        const ctx = canvas.getContext('2d');

        const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
        grad.addColorStop(0.00, '#f6f0db');
        grad.addColorStop(0.35, '#dcecff');
        grad.addColorStop(0.70, '#b7d9f8');
        grad.addColorStop(1.00, '#86b7df');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const tex = new THREE.CanvasTexture(canvas);
        tex.mapping = THREE.EquirectangularReflectionMapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        this.scene.environment = tex;
    }

    _buildRack() {
        const woodMat  = new THREE.MeshStandardMaterial({ color: 0x8b6340, roughness: 0.85 });
        const metalMat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 0.25, metalness: 0.85 });
        const ringMat  = new THREE.MeshStandardMaterial({ color: 0x666666, roughness: 0.35, metalness: 0.80 });

        const totalW = TUBE_SPACING * (TUBE_DEFS.length - 1) + 2.0;
        const halfW  = totalW / 2;

        // Renkaat 3/4-korkeudella: putket (korkeus 4.0) kulkevat renkaiden läpi ✓
        const RING_Y = 3.4;

        // ── Puinen alusta ────────────────────────────────────────────────────
        const base = new THREE.Mesh(new THREE.BoxGeometry(totalW, 0.22, 0.9), woodMat);
        base.position.set(0, -0.11, 0);
        this.scene.add(base);

        // ── Puiset pystytolpat (maasta renkaiden tasolle) ────────────────────
        for (const xSign of [-1, 1]) {
            const post = new THREE.Mesh(
                new THREE.BoxGeometry(0.18, RING_Y, 0.18),
                woodMat
            );
            post.position.set(xSign * (halfW - 0.09), RING_Y / 2, 0);
            this.scene.add(post);
        }

        // ── Metallipoikkipalkki segmentteinä (tolppa→rengas, rengas→rengas, rengas→tolppa) ──
        //
        // Palkkisegmentit ulottuvat renkaan sisäreunaan asti (RING_HALF = R - r = 0.525)
        // jolloin renkaan torusgeometria peittää suoran päätypinnan — liitos näyttää
        // sulautuneelta eikä irralliselta. Lisäksi jokaiseen liitoskohtaan lisätään
        // pieni liitoslevy (flange) joka toimii silmämääräisenä kiinnikkeenä.
        const RING_R     = 0.58;           // toruksen keskisäde
        const RING_r     = 0.055;          // toruksen putkisäde
        // Palkki ulottuu renkaan sisäreunaan: R - r - pieni välykstä
        const RING_HALF  = RING_R - RING_r - 0.01;   // ≈ 0.515
        const POST_HALF  = 0.09;           // puolitettu tolpan leveys (BoxGeometry 0.18)
        const BAR_Z      = 0;
        const BAR_H      = 0.13;
        const BAR_D      = 0.13;

        // Ankuripisteet: [vasemman tolpan sisäreuna, rengas0 vasen, rengas0 oikea, ...]
        const barAnchors = [-(halfW - POST_HALF)];
        for (let i = 0; i < TUBE_DEFS.length; i++) {
            const rx = TUBE_START_X + i * TUBE_SPACING;
            barAnchors.push(rx - RING_HALF);
            barAnchors.push(rx + RING_HALF);
        }
        barAnchors.push(halfW - POST_HALF);

        // Parilliset indeksiparit [0→1], [2→3], ... muodostavat kunkin segmentin
        for (let s = 0; s < barAnchors.length - 1; s += 2) {
            const x0 = barAnchors[s];
            const x1 = barAnchors[s + 1];
            const w  = x1 - x0;
            if (w < 0.01) continue;
            const seg = new THREE.Mesh(
                new THREE.BoxGeometry(w, BAR_H, BAR_D),
                metalMat
            );
            seg.position.set((x0 + x1) / 2, RING_Y, BAR_Z);
            this.scene.add(seg);
        }

        // ── Metallirenkaat (putket kulkevat niiden läpi) ─────────────────────
        for (let i = 0; i < TUBE_DEFS.length; i++) {
            const rx   = TUBE_START_X + i * TUBE_SPACING;
            const ring = new THREE.Mesh(
                new THREE.TorusGeometry(RING_R, RING_r, 10, 32),
                ringMat
            );
            ring.rotation.x = Math.PI / 2;
            ring.position.set(rx, RING_Y, 0);
            this.scene.add(ring);

            // ── Liitoslevyt (flange) molemmille puolille rengasta ────────────
            // Sijoitetaan renkaan toruksen keskiviivalle (x = rx ± RING_R) ja
            // tehdään niistä palkista hieman leveämpiä/korkeampia jotta liitos
            // näyttää vahvistetulta kiinnikkeeltä.
            for (const side of [-1, 1]) {
                // Ohita flange jos se osuisi puutolpan päälle
                const fx = rx + side * RING_R;
                if (Math.abs(fx) > halfW - POST_HALF * 2) continue;

                const flange = new THREE.Mesh(
                    new THREE.BoxGeometry(BAR_D + 0.02, BAR_H + 0.08, BAR_D + 0.06),
                    metalMat
                );
                flange.position.set(fx, RING_Y, 0);
                this.scene.add(flange);
            }
        }
    }

    _buildTubes() {
        for (let i = 0; i < TUBE_DEFS.length; i++) {
            const def  = TUBE_DEFS[i];
            const x    = TUBE_START_X + i * TUBE_SPACING;
            const tube = new Tube(i, new THREE.Vector3(x, 0, 0), def.baseSolution, def.color);

            this.scene.add(tube.build());
            this.tubes.push(tube);

            this._clickableMeshes.push(tube.glassMesh);
            this._meshToTubeIdx.set(tube.glassMesh, i);

            // Luminol-pistevalo luodaan etukäteen intensity=0:lla —
            // vältetään shader-uudelleenkompilointia ja tökkimistä
            // Suuri etäisyys (16) jotta valo osuu kaikkiin läheisiin koeputkiin
            const glow = new THREE.PointLight(0x0022ff, 0, 16);
            glow.position.set(
                TUBE_START_X + i * TUBE_SPACING,
                tube.liquidLevel + 1.0,
                0
            );
            this.scene.add(glow);
            this._glowLights.set(i, { light: glow, intensity: 0 });

            // Putki-label CSS2DObjectina
            const div = document.createElement('div');
            div.className   = 'tube-label';
            div.textContent = def.label;
            const label = new CSS2DObject(div);
            label.position.set(0, 4.55, 0);   // putken yläpuolelle
            tube.group.add(label);
        }
    }

    // ── Yksityiset tapahtumankäsittelijät ────────────────────────────────────

    _handleDropletLand(droplet, tubeIdx) {
        const tube = this.tubes[tubeIdx];
        // Ripple laukaistaan aina pudottaessa — niin kiinteille (onSurfaceCross) kuin nesteille
        if (!droplet.isSolid) {
            tube.triggerRipple(new THREE.Vector2(0.5, 0.5));
        }
        this._landingDroplet = droplet;
        if (this.onDropletLand) {
            this.onDropletLand(tubeIdx, droplet.substance);
        }
        this._landingDroplet = null;
    }

    _onClick(event) {
        const el  = this._renderer.domElement;
        const rect = el.getBoundingClientRect();
        this._mouse.set(
            ((event.clientX - rect.left) / rect.width)  * 2 - 1,
            -((event.clientY - rect.top)  / rect.height) * 2 + 1
        );
        this._raycaster.setFromCamera(this._mouse, this._camera);
        const hits = this._raycaster.intersectObjects(this._clickableMeshes);
        if (hits.length > 0) {
            const idx = this._meshToTubeIdx.get(hits[0].object);
            if (idx != null) {
                if (this._matchMode && this._match && this._match.isLit) {
                    this._testMatchOnTube(idx);
                } else if (this.onTubeClick) {
                    this.onTubeClick(idx);
                }
            }
        }
    }

    _onResize() {
        const w = window.innerWidth, h = window.innerHeight;
        this._camera.aspect = w / h;
        this._camera.updateProjectionMatrix();
        this._renderer.setSize(w, h);
        this._composer.setSize(w, h);
        this._css2dRenderer.setSize(w, h);
        // Säilytä low-quality-tila resize:n jälkeenkin
        if (this._lowQuality) this._renderer.setPixelRatio(1);
    }
}
