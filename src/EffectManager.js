/**
 * EffectManager.js
 *
 * GPU-kiihdytetyt partikkelisysteemit: savu (smoke), höyry (steam),
 * kuplat (bubbles) ja pintakuplat (surface bubbles).
 *
 * Kaikki käyttävät OBJECT POOL -mallia: Three.js-objektit luodaan kerran
 * init()-kutsussa. Hot-pathissa (update) ei tapahdu yhtään heap-allokaatiota.
 *
 * Muistivuodon esto:
 *   • pool-arrayt palauttavat objektit aina takaisin pooliin (splice+push).
 *   • dispose() kutsuu .dispose() jokaiselle geometrialle ja materiaalille.
 */

import * as THREE from 'three';
import { WISP_VERTEX, WISP_FRAGMENT } from './shaders/smokeWispShader.js';

// ── Pool-koot ─────────────────────────────────────────────────────────────────
const MAX_SMOKE        = 120;
const MAX_WISPS        = 6;    // kapea sammutussavuvana (1–2 aktiivista kerrallaan)
const MAX_STEAM        = 80;
const MAX_BUBBLES      = 250;
const MAX_SURF_BUBBLES = 12;
const MAX_SETTLE        = 60;
const MAX_SPARKS        = 35;
const MAX_SPLASHES      = 60;   // vesiroiskeita kiehumisesta
const MAX_FOAM          = 30;   // pinnan alaisia kuplia kiehumisessa
const MAX_BIG_BUBBLES   = 16;   // isot nopeat kuplat putken pohjasta
const MAX_GENTLE        = 60;   // pienet pintakuplat kevyelle poreilulle

// ── Apufunktiot ───────────────────────────────────────────────────────────────

/**
 * Luo pyöreän, pehmeäreunaisen partikkelitekstuuri canvaksesta.
 * Ilman tätä THREE.Sprite renderöi neliön.
 * @param {number} [size=64]
 * @returns {THREE.CanvasTexture}
 */
function makeParticleTexture(size = 64) {
    const canvas = document.createElement('canvas');
    canvas.width  = size;
    canvas.height = size;
    const ctx  = canvas.getContext('2d');
    const half = size / 2;
    const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0.0,  'rgba(255,255,255,1.0)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.7)');
    grad.addColorStop(0.70, 'rgba(255,255,255,0.2)');
    grad.addColorStop(1.0,  'rgba(255,255,255,0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(canvas);
}

// Höyrytekstuuri — pelkästään pehmeä radiaalihäivytys, ei tiivistä keskustaa
function makeSteamTexture(size = 64) {
    const canvas = document.createElement('canvas');
    canvas.width  = size;
    canvas.height = size;
    const ctx  = canvas.getContext('2d');
    const half = size / 2;
    const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0.0, 'rgba(255,255,255,1.0)');
    grad.addColorStop(1.0, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(canvas);
}

// Jaetut tekstuurit — luodaan kerran, ei per-sprite (muistivuodon esto)
const _PARTICLE_TEX = makeParticleTexture(64);
const _STEAM_TEX    = makeSteamTexture(64);

function makeSpriteMat(color, additive = false) {
    return new THREE.SpriteMaterial({
        map:         _PARTICLE_TEX,
        color,
        transparent: true,
        opacity:     0,
        depthWrite:  false,
        blending:    additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
}

// ── Luokka ────────────────────────────────────────────────────────────────────
export class EffectManager {
    /** @param {THREE.Scene} scene */
    constructor(scene) {
        this._scene = scene;

        // Poolit
        this._smokePool       = [];
        this._steamPool       = [];
        this._bubblePool      = [];
        this._surfBubPool     = [];

        // Aktiiviset listat
        this._activeSmoke          = [];
        this._activeSteam          = [];
        this._activeBubble         = [];
        this._activeSurfBub        = [];

        // Laskeumispartikkelit (sakka vajoaa hitaasti nesteessä)
        this._settlePool   = [];
        this._activeSettle = [];

        // H2-poksahdussipinjät
        this._sparkPool    = [];
        this._activeSparks = [];

        // Kiehuminen: pintaroiskeita + pinnan alaisia kuplia + isot pohjakuplat
        this._splashPool     = [];
        this._activeSplash   = [];
        this._foamPool       = [];
        this._activeFoam     = [];
        this._bigBubPool     = [];
        this._activeBigBub   = [];

        // Kevyt poreilu: pienet pintakuplat
        this._gentlePool     = [];
        this._activeGentle   = [];

        // Savuvana-wispit (tulitikun sammutus)
        this._wispPool   = [];
        this._activeWisps = [];

        // Saostumakerros per putki
        this._precipLayers = new Map();   // Tube → { domeMesh, cylMesh, capMesh, clipPlane, currentH, targetH }

        // Metallikerrostuma per putki (syrjäytysreaktiot: Fe+CuSO₄, Mg+CuSO₄, Mg+FeSO₄)
        this._metalDepositMap = new Map(); // Tube → { particles: [{mesh, targetScale, elapsed, growTime}], mat }
    }

    // ── Alustus ───────────────────────────────────────────────────────────────

    /** Rakentaa GPU-objektit ja täyttää poolit. Kutsutaan kerran init-vaiheessa. */
    init() {
        const scene = this._scene;

        // Savu-spritet (NH₃ + muut)
        const smokeMat = makeSpriteMat(0xffffff, false);
        for (let i = 0; i < MAX_SMOKE; i++) {
            const s = new THREE.Sprite(smokeMat.clone());
            s.renderOrder = 7;
            s.visible     = false;
            s.userData    = { vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1, tubeTopY: -Infinity };
            scene.add(s);
            this._smokePool.push(s);
        }

        // Höyry-spritet (Mg, eksoterminen) — käyttää pehmeää höyrytekstuuria
        const steamMat = new THREE.SpriteMaterial({
            map: _STEAM_TEX, color: 0xeeeeee, transparent: true, opacity: 0,
            depthWrite: false, blending: THREE.NormalBlending,
        });
        for (let i = 0; i < MAX_STEAM; i++) {
            const s = new THREE.Sprite(steamMat.clone());
            s.renderOrder = 6;
            s.visible     = false;
            s.userData    = { vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1 };
            scene.add(s);
            this._steamPool.push(s);
        }

        // Nousevat kuplat (pienehköt pallot)
        const bubGeom = new THREE.SphereGeometry(0.013, 7, 7);
        const bubMat  = new THREE.MeshBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0.80, depthWrite: false,
        });
        for (let i = 0; i < MAX_BUBBLES; i++) {
            const b = new THREE.Mesh(bubGeom, bubMat);
            b.renderOrder = 4;
            b.visible     = false;
            b.userData    = { vx: 0, vz: 0, vy: 0, targetY: 0 };
            scene.add(b);
            this._bubblePool.push(b);
        }

        // Pintakuplat (puolipallomainen kupla nesteen pinnalla)
        const surfGeom = new THREE.SphereGeometry(
            0.022, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2
        );
        const surfMat  = new THREE.MeshBasicMaterial({
            color: 0xddf4ff, transparent: true, opacity: 0,
            side: THREE.DoubleSide, depthWrite: false,
        });
        for (let i = 0; i < MAX_SURF_BUBBLES; i++) {
            const b = new THREE.Mesh(surfGeom, surfMat.clone());
            b.renderOrder = 3;
            b.visible     = false;
            b.userData    = {
                vx: 0, vz: 0,
                life: 0, maxLife: 1,
                targetScale: 1, growDur: 0.07, popDur: 0.09,
                wobblePhase: 0, wobbleFreq: 6,
                surfY: 0,
            };
            scene.add(b);
            this._surfBubPool.push(b);
        }

        // Laskeumispartikkelit — pienet valkoiset spritet vajoavat nesteessä
        const settleMat = makeSpriteMat(0xdddddd, false);
        for (let i = 0; i < MAX_SETTLE; i++) {
            const s = new THREE.Sprite(settleMat.clone());
            s.renderOrder = 4;
            s.visible     = false;
            s.userData    = { velY: 0, bottomY: 0 };
            scene.add(s);
            this._settlePool.push(s);
        }

        // H2-poksahdussipinjät (keltainen, additive)
        const sparkMat = makeSpriteMat(0xffcc40, true);
        for (let i = 0; i < MAX_SPARKS; i++) {
            const s = new THREE.Sprite(sparkMat.clone());
            s.renderOrder = 9;
            s.visible     = false;
            s.userData    = { vx: 0, vy: 0, vz: 0, life: 0, maxLife: 0.4 };
            scene.add(s);
            this._sparkPool.push(s);
        }

        // Pintaroiskeita (kiehuminen) — pienet kirkkaat pisarat, additive
        const splashMat = makeSpriteMat(0xc8e8ff, true);
        for (let i = 0; i < MAX_SPLASHES; i++) {
            const s = new THREE.Sprite(splashMat.clone());
            s.renderOrder = 8;
            s.visible     = false;
            s.userData    = { vx: 0, vy: 0, vz: 0, surfY: 0, life: 0, maxLife: 0.8 };
            scene.add(s);
            this._splashPool.push(s);
        }

        // Subsurface foam-kuplat (kiehuminen) — pienet puoliläpinäkyvät kuplat nesteen sisällä
        const foamGeom = new THREE.SphereGeometry(1, 6, 5);   // skaalataan per kupla
        const foamMat  = new THREE.MeshBasicMaterial({
            color: 0xdaf0ff, transparent: true, opacity: 0, depthWrite: false,
        });
        for (let i = 0; i < MAX_FOAM; i++) {
            const b = new THREE.Mesh(foamGeom, foamMat.clone());
            b.renderOrder = 3;
            b.visible     = false;
            b.userData    = { vy: 0, vx: 0, vz: 0, targetY: 0, popOffset: 0, tube: null, size: 0.02 };
            scene.add(b);
            this._foamPool.push(b);
        }

        // Isot nopeat kuplat putken pohjasta (kiehuminen)
        const bigGeom = new THREE.SphereGeometry(1, 8, 6);   // skaalataan per kupla
        const bigMat  = new THREE.MeshBasicMaterial({
            color: 0xe8f6ff, transparent: true, opacity: 0, depthWrite: false,
        });
        for (let i = 0; i < MAX_BIG_BUBBLES; i++) {
            const b = new THREE.Mesh(bigGeom, bigMat.clone());
            b.renderOrder = 3;
            b.visible     = false;
            b.userData    = { vy: 0, vy0: 0, vx: 0, vz: 0, targetY: 0, popOffset: 0, tube: null, size: 0.05 };
            scene.add(b);
            this._bigBubPool.push(b);
        }

        // Kevyen poreilun pintakuplat (pienet, lyhyt matka, pop pinnassa)
        const gentleGeom = new THREE.SphereGeometry(1, 6, 5);   // skaalataan per kupla
        const gentleMat  = new THREE.MeshBasicMaterial({
            color: 0xdaf6ff, transparent: true, opacity: 0, depthWrite: false,
        });
        for (let i = 0; i < MAX_GENTLE; i++) {
            const b = new THREE.Mesh(gentleGeom, gentleMat.clone());
            b.renderOrder = 3;
            b.visible     = false;
            b.userData    = { vy: 0, vx: 0, vz: 0, targetY: 0, tube: null, size: 0.01 };
            scene.add(b);
            this._gentlePool.push(b);
        }

        // Jaettu yksikköpallomalli metallikerrostumille — skaalataan per hiukkanen
        this._depositGeom = new THREE.SphereGeometry(1, 7, 5);

        // ── Sammutussavuvanat (wispit) ────────────────────────────────────────
        // Kaksi ristiin asetettua PlaneGeometrya → näkyy joka kulmasta
        const wispH = 5.0;
        const wispW = 0.28;
        const pA = new THREE.PlaneGeometry(wispW, wispH, 1, 50);
        const pB = new THREE.PlaneGeometry(wispW, wispH, 1, 50);
        pB.rotateY(Math.PI / 2);
        // Yhdistä molemmat tasot yhteen geometriaan
        const mergedPos = new Float32Array(pA.attributes.position.count * 3 + pB.attributes.position.count * 3);
        mergedPos.set(pA.attributes.position.array, 0);
        mergedPos.set(pB.attributes.position.array, pA.attributes.position.count * 3);
        const mergedUV = new Float32Array(pA.attributes.uv.count * 2 + pB.attributes.uv.count * 2);
        mergedUV.set(pA.attributes.uv.array, 0);
        mergedUV.set(pB.attributes.uv.array, pA.attributes.uv.count * 2);
        // Index
        const idxA = pA.index.array;
        const idxB = pB.index.array;
        const offset = pA.attributes.position.count;
        const mergedIdx = new Uint16Array(idxA.length + idxB.length);
        mergedIdx.set(idxA, 0);
        for (let j = 0; j < idxB.length; j++) mergedIdx[idxA.length + j] = idxB[j] + offset;
        const wispGeom = new THREE.BufferGeometry();
        wispGeom.setAttribute('position', new THREE.BufferAttribute(mergedPos, 3));
        wispGeom.setAttribute('uv', new THREE.BufferAttribute(mergedUV, 2));
        wispGeom.setIndex(new THREE.BufferAttribute(mergedIdx, 1));
        // Siirretään origo pohjaan: PlaneGeometry on -h/2…+h/2 → siirretään y += h/2
        wispGeom.translate(0, wispH / 2, 0);
        pA.dispose();
        pB.dispose();
        this._wispGeom = wispGeom;

        for (let i = 0; i < MAX_WISPS; i++) {
            const uniforms = {
                uTime:    { value: 0 },
                uBirth:   { value: -100 },
                uLifeDur: { value: 3.0 },
                uSeed:    { value: Math.random() },
                uHeight:  { value: wispH },
                uOpacity: { value: 0.55 },
            };
            const mat = new THREE.ShaderMaterial({
                vertexShader:   WISP_VERTEX,
                fragmentShader: WISP_FRAGMENT,
                uniforms,
                transparent: true,
                depthWrite:  false,
                side:        THREE.DoubleSide,
            });
            const mesh = new THREE.Mesh(wispGeom, mat);
            mesh.renderOrder = 8;
            mesh.visible = false;
            mesh.frustumCulled = false;
            mesh.userData = { uniforms, birth: -100, lifeDur: 3.0 };
            scene.add(mesh);
            this._wispPool.push(mesh);
        }
    }

    // ── Julkinen API ──────────────────────────────────────────────────────────

    /**
     * Spawna / kasvata saostumakerros putken pohjalle.
     * Vaihe 1: puolipallomainen kupoli kasvaa putken pyöreää pohjaa seuraten.
     * Vaihe 2: litteä lieriökerros nousee kupolista ylöspäin.
     * @param {import('./objects/Tube.js').Tube} tube
     * @param {number} color    - hex-väri
     * @param {number} count
     */
    createPrecipitate(tube, color = 0x2a5daa, count = 25, { instant = false } = {}) {
        const gp        = tube.group.position;
        const radius    = tube.liquidRadius * 0.88;
        const BOTTOM_Y  = gp.y + 0.07;
        const LIQUID_H  = tube.liquidLevel - 0.07;
        const DOME_R    = radius;
        const CYL_START = BOTTOM_Y + DOME_R;
        const MAX_CYL_H = Math.max(0.05, LIQUID_H * 0.75 - DOME_R);

        let layer = this._precipLayers.get(tube);
        if (!layer) {
            // ── Kupoli (alapuolipallo) — napapiste alaspäin, tasainen pinta ylöspäin ──
            // thetaStart=PI/2, thetaLength=PI/2: päiväntasaajasta etelännapaan (alapallo)
            // Leikkaustaso kasvaa BOTTOM_Y → CYL_START; ei Y-skaalausta (säilyy oikeana pallona).
            const domeGeom = new THREE.SphereGeometry(
                radius, 28, 14, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2
            );
            const domeClipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), BOTTOM_Y);
            const domeMat = new THREE.MeshStandardMaterial({
                color,
                roughness:      0.88,
                metalness:      0.02,
                transparent:    true,
                opacity:        0.82,
                depthWrite:     false,
                depthTest:      false,
                clippingPlanes: [domeClipPlane],
            });
            const domeMesh = new THREE.Mesh(domeGeom, domeMat);
            // Mesh pysyy CYL_STARTissa pysyvästi = pallon ekvaattori world-y:ssä.
            // Leikkaustaso avautuu BOTTOM_Y:stä CYL_STARTiin partikkelien laskeutuessa.
            domeMesh.position.set(gp.x, CYL_START, gp.z);
            domeMesh.renderOrder = 2;
            this._scene.add(domeMesh);

            // ── Lieriö kupolista ylöspäin (leikkaustaso piilottaa alkutilan) ──────
            const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), CYL_START);
            const cylGeom = new THREE.CylinderGeometry(radius, radius, MAX_CYL_H, 28, 1, true);
            cylGeom.translate(0, MAX_CYL_H / 2, 0);   // pohja local y=0
            const cylMat = new THREE.MeshStandardMaterial({
                color,
                roughness:      0.88,
                metalness:      0.02,
                clippingPlanes: [clipPlane],
                transparent:    true,
                opacity:        0.82,
                depthWrite:     false,
                depthTest:      false,
            });
            const cylMesh = new THREE.Mesh(cylGeom, cylMat);
            cylMesh.position.set(gp.x, CYL_START, gp.z);
            cylMesh.visible    = false;
            cylMesh.renderOrder = 2;
            this._scene.add(cylMesh);

            // ── Pyöreä kansiympyrä kerroksen näkyvälle pinnalle ───────────────────
            const capGeom = new THREE.CircleGeometry(radius, 28);
            capGeom.rotateX(-Math.PI / 2);
            const capMat = new THREE.MeshStandardMaterial({
                color,
                roughness:   0.88,
                metalness:   0.02,
                transparent: true,
                opacity:     0.80,
                depthWrite:  false,
                depthTest:   false,
            });
            const capMesh = new THREE.Mesh(capGeom, capMat);
            capMesh.renderOrder = 3;
            capMesh.visible = false;
            this._scene.add(capMesh);

            layer = {
                domeMesh, cylMesh, capMesh, clipPlane, domeClipPlane,
                currentH:   0.001,
                targetH:    0.001,
                domeR:      DOME_R,
                bottomY:    BOTTOM_Y,
                domePeakY:  CYL_START,
                maxH:       LIQUID_H * 0.75,
                dissolving: false,
            };
            this._precipLayers.set(tube, layer);
        }

        // Nollaa tila vain jos kerros on vasta alustettu (prewarm/tuore) tai se liukenee
        const freshLayer = layer.currentH <= 0.002 && layer.targetH <= 0.002;
        if (freshLayer || layer.dissolving) {
            layer.currentH = 0.001;
            layer.targetH  = 0.001;
            layer.dissolving = false;
            layer.domeMesh.visible = false;
            layer.cylMesh.visible  = false;
            layer.capMesh.visible  = false;
            layer.domeClipPlane.constant = layer.bottomY;
            layer.clipPlane.constant     = layer.domePeakY;
            layer.domeMesh.material.opacity = 0.82;
            layer.cylMesh.material.opacity  = 0.82;
            layer.capMesh.material.opacity  = 0.80;
        }

        // Päivitä väri (eri reaktiot voivat vaihtaa sitä)
        layer.domeMesh.material.color.setHex(color);
        layer.cylMesh.material.color.setHex(color);
        layer.capMesh.material.color.setHex(color);

        if (instant) {
            // Välitön sakka pinnassa — ei vajoavia partikkeleita (esim. Mg)
            // currentH on juuri alle targetH jötta _updatePrecipLayers asettaa
            // meshit näkyviksi jo ensimmäisellä framella (diff > 0 pakottaa kasvu-logiikan).
            layer.targetH  = layer.maxH * 0.35;
            layer.currentH = layer.maxH * 0.35 - 0.001;
        } else {
            // Spawna laskeumispartikkelit — jokainen kantaa oman kasvuosuutensa
            const spawnCount = Math.min(count, 14);
            this._spawnSettleParticles(tube, spawnCount, color, count * 0.008);
        }
    }

    /**
     * Spawna savupartikkeleita (NH₃-reaktio).
     * @param {THREE.Vector3} pos       - spawn-piste (nestepinta tai putken suu)
     * @param {number}        count
     * @param {number}        [tubeTopY=-Infinity]  - putken suuaukon world-Y;
     *   jos annettu, partikkelit spawnautuvat nestepinnalta ja ovat näkymättömiä
     *   kunnes ylittävät tubeTopY (nousevat putken sisällä ylös).
     */
    createSmoke(pos, count = 10, tubeTopY = -Infinity) {
        const inside = tubeTopY > -Infinity;
        for (let i = 0; i < count; i++) {
            if (this._smokePool.length === 0) break;
            const s  = this._smokePool.pop();
            const ud = s.userData;
            // Sisäiset partikkelit pysyvät putken säteen sisällä (0.45),
            // ulkoiset saavat leveämmän hajonnan
            const sp = inside ? 0.38 : 0.18;
            s.position.set(
                pos.x + (Math.random() - 0.5) * sp,
                pos.y + Math.random() * 0.06,
                pos.z + (Math.random() - 0.5) * sp
            );
            ud.vx      = (Math.random() - 0.5) * (inside ? 0.012 : 0.035);
            // Sisäiset nousevat nopeasti (1.2–1.7 u/s) jotta poistuvat ~1.5 s aikana
            ud.vy      = inside ? (1.2 + Math.random() * 0.5) : (0.09 + Math.random() * 0.07);
            ud.vz      = (Math.random() - 0.5) * (inside ? 0.012 : 0.035);
            ud.maxLife = inside ? (2.2 + Math.random() * 0.7) : (3.5 + Math.random() * 2.0);
            ud.life    = ud.maxLife;
            ud.tubeTopY = tubeTopY;
            s.scale.setScalar(0.13 + Math.random() * 0.07);
            s.material.opacity = 0;
            s.visible = true;
            this._activeSmoke.push(s);
        }
    }

    /**
     * Spawna höyrypartikkeleita (Mg-reaktio, eksoterminen).
     * @param {THREE.Vector3} pos
     * @param {number}        count
     */
    /**
     * Spawna kapea ylöspäin kohoava sammutusviiru (CO₂-sammutus).
     * Kynttilän sammutusta muistuttava ohut, nouseva savuviiri.
     * @param {THREE.Vector3} pos
     * @param {number}        count
     */
    createExtinguishSmoke(pos, _count) {
        // Luo 2–3 savuvanaa (wispeä) — realistisempi sammutusefekti
        const n = 2 + (Math.random() > 0.5 ? 1 : 0);
        const now = performance.now() * 0.001;
        for (let i = 0; i < n; i++) {
            if (this._wispPool.length === 0) break;
            const w  = this._wispPool.pop();
            const ud = w.userData;
            const u  = ud.uniforms;
            u.uBirth.value   = now;
            u.uLifeDur.value = 4.5 + Math.random() * 1.5;
            u.uSeed.value    = Math.random();
            u.uOpacity.value = 0.50 + Math.random() * 0.15;
            ud.birth   = now;
            ud.lifeDur = u.uLifeDur.value;
            w.position.set(
                pos.x + (Math.random() - 0.5) * 0.04,
                pos.y,
                pos.z + (Math.random() - 0.5) * 0.04
            );
            w.visible = true;
            this._activeWisps.push(w);
        }
    }

    /**
     * @param {THREE.Vector3} pos
     * @param {number}        count
     * @param {number}        intensity - STEAM_INTENSITY-arvo; ohjaa nopeutta, kokoa ja leveyttä
     */
    createSteam(pos, count = 5, intensity = 3) {
        for (let i = 0; i < count; i++) {
            if (this._steamPool.length === 0) break;
            const s  = this._steamPool.pop();
            const ud = s.userData;
            // Laaja hajonta: partikkelit lähtevät eri kohdista putken suun läheltä
            const sp = 0.18 + intensity * 0.015;
            s.position.set(
                pos.x + (Math.random() - 0.5) * sp,
                pos.y + Math.random() * 0.15,
                pos.z + (Math.random() - 0.5) * sp
            );
            // Paljon hajontaa nopeuteen — eri partikkelit nousevat eri tahtiin
            const drift = 0.05 + intensity * 0.008 + Math.random() * 0.06;
            ud.vx      = (Math.random() - 0.5) * drift;
            ud.vy      = (0.30 + Math.random() * 0.50) + intensity * 0.015;
            ud.vz      = (Math.random() - 0.5) * drift;
            ud.maxLife = 2.0 + intensity * 0.12 + Math.random() * 1.8;
            ud.life    = ud.maxLife;
            // Eri alkukoot — isoista pieniin vaihtelee, kasvavat silti nousun myotä
            ud.startScale = 0.05 + Math.random() * 0.25;
            s.scale.setScalar(ud.startScale);
            s.material.opacity = 0;
            s.visible = true;
            this._activeSteam.push(s);
        }
    }

    /**
     * Spawna nousevia kuplia putkessa.
     * @param {import('./objects/Tube.js').Tube} tube
     * @param {number}                           count
     */
    createBubbles(tube, count = 3) {
        const gp  = tube.group.position;
        const r   = tube.liquidRadius * 0.70;
        const top = gp.y + tube.liquidLevel;

        for (let i = 0; i < count; i++) {
            if (this._bubblePool.length === 0) break;
            const b  = this._bubblePool.pop();
            const ud = b.userData;
            b.position.set(
                gp.x + (Math.random() - 0.5) * r * 2,
                gp.y + 0.15 + Math.random() * 0.6,
                gp.z + (Math.random() - 0.5) * r * 2
            );
            ud.vx      = (Math.random() - 0.5) * 0.04;
            ud.vz      = (Math.random() - 0.5) * 0.04;
            ud.vy      = 0.35 + Math.random() * 0.30;
            ud.targetY = top;
            b.visible           = true;
            b.material.opacity  = 0.80;  // palauta jaetun materiaalin opacity (bugi: _recycleAll nollaa sen)
            this._activeBubble.push(b);
        }
    }

    /**
     * Spawna pintakupla nousevan kuplan popatessa.
     * Voit kutsua tätä SceneManagerista bubble.targetY-perusteisesti.
     * @param {THREE.Vector3} pos    - kuplan pinnan positio
     * @param {number}        surfY  - nesteen pinnan Y
     */
    createSurfaceBubble(pos, surfY) {
        if (this._surfBubPool.length === 0) return;
        const b  = this._surfBubPool.pop();
        const ud = b.userData;
        const angle = Math.random() * Math.PI * 2;
        const spd   = 0.018 + Math.random() * 0.025;

        b.position.set(pos.x, surfY, pos.z);
        b.scale.set(0.001, 1, 0.001);
        b.material.opacity = 0;

        ud.vx          = Math.cos(angle) * spd;
        ud.vz          = Math.sin(angle) * spd;
        ud.life        = 0.45 + Math.random() * 0.5;
        ud.maxLife     = ud.life;
        ud.targetScale = 0.9 + Math.random() * 1.4;
        ud.growDur     = 0.07;
        ud.popDur      = 0.09;
        ud.wobblePhase = Math.random() * Math.PI * 2;
        ud.wobbleFreq  = 5 + Math.random() * 5;
        ud.surfY       = surfY;

        b.visible = true;
        this._activeSurfBub.push(b);
    }

    /**
     * Spawna metallikerrostuma putken pohjalle (syrjäytysreaktiot).
     * Pienet tummat partikkelit kasvavat hitaasti pohjaan staggeroituina.
     * @param {import('./objects/Tube.js').Tube} tube
     * @param {number} color  - hex-väri (tumma kupari tai rauta)
     */
    createMetalDeposit(tube, color) {
        this._clearMetalDeposit(tube);   // poista edellinen jos on

        const gp       = tube.group.position;
        const LIQUID_R = tube.liquidRadius;
        // DOME_R vastaa saostumakerroksen kupolisädettä — käytetään Y-rajoitukseen
        const DOME_R   = LIQUID_R * 0.88;
        // Maksimi XZ-etäisyys: hieman DOME_R:ää pienempi jotta reuna ei osu seinään
        const r        = LIQUID_R * 0.80;
        const BOTTOM_Y = gp.y + 0.07;
        const COUNT    = 15;

        const mat = new THREE.MeshStandardMaterial({
            color,
            roughness:   0.78,
            metalness:   0.32,
            transparent: true,
            opacity:     0.72,
            depthWrite:  false,
        });

        const particles = [];
        for (let i = 0; i < COUNT; i++) {
            const mesh = new THREE.Mesh(this._depositGeom, mat);
            const angle = Math.random() * Math.PI * 2;
            const dist  = Math.sqrt(Math.random()) * r;   // sqrt = tasainen jakauma ympyrällä
            const targetScale = 0.007 + Math.random() * 0.013;

            // Laske pienin turvallinen Y: pisteen on oltava kupolin pinnan yläpuolella.
            // Kupolin yhtälö: dist² + (DOME_R - localY)² = DOME_R²
            // → minLocalY = DOME_R - sqrt(DOME_R² - dist²)
            const minLocalY = DOME_R - Math.sqrt(Math.max(0, DOME_R * DOME_R - dist * dist));
            const localY    = minLocalY + Math.random() * 0.04;

            mesh.position.set(
                gp.x + Math.cos(angle) * dist,
                BOTTOM_Y + localY,
                gp.z + Math.sin(angle) * dist
            );
            mesh.scale.setScalar(0.0001);
            mesh.renderOrder = 3;
            this._scene.add(mesh);
            particles.push({
                mesh,
                targetScale,
                elapsed:  -(Math.random() * 7.0),   // negatiivinen arvo = viiveaika ennen kasvua
                growTime: 5.0 + Math.random() * 5.0,
            });
        }
        this._metalDepositMap.set(tube, { particles, mat });
    }

    /**
     * Häivyttää putken saostumakerroksen hiljalleen (NH₃+CuSO₄ kolmas lisäys).
     * @param {import('./objects/Tube.js').Tube} tube
     */
    dissolvePrecipitate(tube) {
        const layer = this._precipLayers.get(tube);
        if (layer) layer.dissolving = true;

        // Merkitse kaikki tämän putken in-flight partikkelit per-partikkeli-lipulla.
        // Näin ne jäävät häivytystilaan vaikka layer.dissolving resetoituu myöhemmin.
        for (const s of this._activeSettle) {
            if (s.userData.tube === tube) {
                s.userData.fadingOut  = true;
                s.userData.growContrib = 0;   // ei enää kasvata sakkaa
            }
        }
    }

    /**
     * Spawna pintaroiskeita kiehumisesta — pienet pisarat lentävät ylös ja putoavat.
     * @param {import('./objects/Tube.js').Tube} tube
     * @param {number} count
     */
    createBoilSplashes(tube, count = 3) {
        const gp   = tube.group.position;
        const r    = tube.liquidRadius * 0.72;
        const surfY = gp.y + tube.liquidLevel;

        for (let i = 0; i < count; i++) {
            if (this._splashPool.length === 0) break;
            const s  = this._splashPool.pop();
            const ud = s.userData;
            const angle = Math.random() * Math.PI * 2;
            const dist  = Math.random() * r;
            s.position.set(
                gp.x + Math.cos(angle) * dist,
                surfY + 0.02,
                gp.z + Math.sin(angle) * dist
            );
            // Nopeus: voimakas ylös-suunta + pieni sivuttaiskomponentti
            const hspd  = 0.15 + Math.random() * 0.35;
            const vspd  = 0.9  + Math.random() * 2.1;
            ud.vx      = Math.cos(angle + Math.PI / 2) * hspd * (Math.random() < 0.5 ? 1 : -1);
            ud.vy      = vspd;
            ud.vz      = Math.sin(angle + Math.PI / 2) * hspd * (Math.random() < 0.5 ? 1 : -1);
            ud.surfY   = surfY;
            ud.maxLife = 0.35 + Math.random() * 0.55;
            ud.life    = ud.maxLife;
            s.scale.setScalar(0.025 + Math.random() * 0.035);
            s.material.opacity = 0.5 + Math.random() * 0.35;
            s.visible = true;
            this._activeSplash.push(s);
        }
    }

    /**
     * Spawna subsurface foam-kuplia nesteen sisälle — nousevat pintaan ja popping.
     * @param {import('./objects/Tube.js').Tube} tube
     * @param {number} count
     */
    createFoamBubbles(tube, count = 2) {
        const gp    = tube.group.position;
        const r     = tube.liquidRadius * 0.70;
        const surfY = gp.y + tube.liquidLevel;

        for (let i = 0; i < count; i++) {
            if (this._foamPool.length === 0) break;
            const b  = this._foamPool.pop();
            const ud = b.userData;
            const size = 0.012 + Math.random() * 0.030;
            const angle = Math.random() * Math.PI * 2;
            const dist  = Math.random() * r;
            const startDepth = 0.10 + Math.random() * 0.70;
            // Pop below surface so bubbles collapse inside the liquid
            const popOffset = 0.03 + Math.random() * 0.12;
            b.position.set(
                gp.x + Math.cos(angle) * dist,
                surfY - startDepth,
                gp.z + Math.sin(angle) * dist
            );
            b.scale.setScalar(size);
            ud.vy        = 0.70 + Math.random() * 1.00;
            ud.vx        = (Math.random() - 0.5) * 0.04;
            ud.vz        = (Math.random() - 0.5) * 0.04;
            ud.targetY   = surfY - popOffset;
            ud.popOffset = popOffset;
            ud.tube      = tube;
            ud.size      = size;
            // More translucent: 0.15–0.35
            b.material.opacity = 0.15 + Math.random() * 0.20;
            b.visible = true;
            this._activeFoam.push(b);
        }
    }

    /**
     * Spawna ison kupla putken pohjasta — nousee nopeasti pintaan.
     * @param {import('./objects/Tube.js').Tube} tube
     */
    createBigBoilBubble(tube) {
        if (this._bigBubPool.length === 0) return;
        const gp    = tube.group.position;
        const r     = tube.liquidRadius * 0.60;
        const surfY = gp.y + tube.liquidLevel;
        const botY  = gp.y + 0.12;

        const b  = this._bigBubPool.pop();
        const ud = b.userData;
        const size = 0.045 + Math.random() * 0.065;
        const angle = Math.random() * Math.PI * 2;
        b.position.set(
            gp.x + Math.cos(angle) * r * Math.random(),
            botY + Math.random() * 0.18,
            gp.z + Math.sin(angle) * r * Math.random()
        );
        b.scale.setScalar(size);
        const speed = 3.2 + Math.random() * 2.2;
        ud.vy        = speed;
        ud.vy0       = speed;
        ud.vx        = (Math.random() - 0.5) * 0.06;
        ud.vz        = (Math.random() - 0.5) * 0.06;
        // Pop slightly below surface
        ud.targetY   = surfY - 0.02 - Math.random() * 0.06;
        ud.popOffset = surfY - ud.targetY;
        ud.tube      = tube;
        ud.size      = size;
        b.material.opacity = 0.12 + Math.random() * 0.18;
        b.visible = true;
        this._activeBigBub.push(b);
    }

    /**
     * Spawna pintaosainen kupla kiehumisen vaahtokupolina.
     * @param {THREE.Vector3} pos
     * @param {number} surfY
     */
    createBoilDomeBubble(pos, surfY) {
        this.createSurfaceBubble(pos, surfY);
    }

    /**
     * Spawna pieni pintakupla kevyelle poreilulle (esim. Mg + HCl).
     * Nousee lyhyen matkan pinnasta ja popatessaan luo pieniä pintakuplia.
     * @param {import('./objects/Tube.js').Tube} tube
     * @param {number} [count=1]
     */
    createGentleBubble(tube, count = 1) {
        const gp    = tube.group.position;
        const r     = tube.liquidRadius * 0.62;
        const surfY = gp.y + tube.liquidLevel;
        const botY  = gp.y + 0.14;   // putken pohja — kuplat nousevat täältä pintaan

        for (let i = 0; i < count; i++) {
            if (this._gentlePool.length === 0) break;
            const b  = this._gentlePool.pop();
            const ud = b.userData;
            const size = 0.006 + Math.random() * 0.010;
            const angle = Math.random() * Math.PI * 2;
            const dist  = Math.random() * r;
            // Aloita satunnaisesta korkeudesta pohjan ja pinnan väliltä
            const startY = botY + Math.random() * (surfY - botY - 0.05);
            b.position.set(
                gp.x + Math.cos(angle) * dist,
                startY,
                gp.z + Math.sin(angle) * dist
            );
            b.scale.setScalar(size);
            ud.vy      = 0.42 + Math.random() * 0.40;   // nopeampi, pidempi matka
            ud.vx      = (Math.random() - 0.5) * 0.018;
            ud.vz      = (Math.random() - 0.5) * 0.018;
            // Pop very close to surface — just at or 1-2mm below
            ud.targetY = surfY - 0.005 - Math.random() * 0.015;
            ud.tube    = tube;
            ud.size    = size;
            b.material.opacity = 0.25 + Math.random() * 0.30;
            b.visible = true;
            this._activeGentle.push(b);
        }
    }

    /**
     * Vedyn poksahdus: kipinasade putken suulta.
     * @param {THREE.Vector3} pos  putken suun maailmakoordinaatit
     */
    createH2Pop(pos) {
        const count = Math.min(12, this._sparkPool.length);
        for (let i = 0; i < count; i++) {
            const s  = this._sparkPool.pop();
            const ud = s.userData;
            const angle = Math.random() * Math.PI * 2;
            const tilt  = Math.random() * Math.PI * 0.55;   // sivusuunta
            const speed = 1.2 + Math.random() * 2.2;
            s.position.set(pos.x, pos.y, pos.z);
            ud.vx      = Math.cos(angle) * Math.sin(tilt) * speed;
            ud.vy      = Math.abs(Math.cos(tilt)) * speed * 0.8 + 0.6;
            ud.vz      = Math.sin(angle) * Math.sin(tilt) * speed;
            ud.maxLife = 0.18 + Math.random() * 0.22;
            ud.life    = ud.maxLife;
            s.scale.setScalar(0.04 + Math.random() * 0.08);
            s.material.opacity = 1.0;
            s.visible = true;
            this._activeSparks.push(s);
        }
    }

    /**
     * Esilämmittää saostumakerros-shaderit kaikille putkille.
     * Luo kerrosmeshit valmiiksi (piilotettuina) jotta MeshStandardMaterial
     * käännetään heti — ei tökkimistä ensimmäisellä reaktiolla.
     * @param {import('./objects/Tube.js').Tube[]} tubes
     */
    prewarmPrecipitate(tubes) {
        for (const tube of tubes) {
            this.createPrecipitate(tube, 0x888888, 0);
        }
    }

    /**
     * Päivittää kaikki aktiiviset partikkelit. Kutsu joka frame.
     * @param {number} dt  - delta-aika
     */
    update(dt) {
        this._updateSprites(this._activeSmoke,           this._smokePool,  dt, 0.40, 0.60);
        this._updateSmokeWisps(dt);
        this._updateSteam(dt);
        this._updateBubbles(dt);
        this._updateSurfBubbles(dt);
        this._updateSettleParticles(dt);
        this._updatePrecipLayers(dt);
        this._updateSparks(dt);
        this._updateSplashes(dt);
        this._updateFoam(dt);
        this._updateBigBubbles(dt);
        this._updateGentleBubbles(dt);
        this._updateMetalDeposits(dt);
    }

    /** Palauttaa kaikki aktiiviset partikkelit pooleihin (reset). */
    reset() {
        this._recycleAll(this._activeSmoke,           this._smokePool);
        // Wispit: palauta pooliin
        for (const w of this._activeWisps) {
            w.visible = false;
            this._wispPool.push(w);
        }
        this._activeWisps.length = 0;
        this._recycleAll(this._activeSteam,            this._steamPool);
        this._recycleAll(this._activeBubble,  this._bubblePool);
        this._recycleAll(this._activeSurfBub, this._surfBubPool);
        this._recycleAll(this._activeSettle,  this._settlePool);
        this._recycleAll(this._activeSparks,  this._sparkPool);
        this._recycleAll(this._activeSplash,  this._splashPool);
        this._recycleAll(this._activeFoam,    this._foamPool);
        this._recycleAll(this._activeBigBub,  this._bigBubPool);
        this._recycleAll(this._activeGentle,  this._gentlePool);
        // Saostumakerrokset: piilota mutta säilytä (ei disposen) —
        // shader pysyy käännettynä eikä töki seuraavalla reaktiolla.
        for (const [, layer] of this._precipLayers) {
            layer.domeMesh.visible = false;
            layer.cylMesh.visible  = false;
            layer.capMesh.visible  = false;
            layer.currentH         = 0.001;
            layer.targetH          = 0.001;
            layer.dissolving       = false;
            layer.domeMesh.material.opacity = 0.82;
            layer.cylMesh.material.opacity  = 0.82;
            layer.capMesh.material.opacity  = 0.80;
            layer.domeClipPlane.constant    = layer.bottomY;
            layer.clipPlane.constant        = layer.domePeakY;
        }
        // Ei tyhjennetä _precipLayers — kerrokset säilytetään uudelleenkäyttöä varten

        // Metallikerrostumat poistetaan resetissä (reaktio on nollattu)
        for (const tube of [...this._metalDepositMap.keys()]) {
            this._clearMetalDeposit(tube);
        }
    }

    /** Vapauttaa kaikki GPU-resurssit (sovelluksen lopetus). */
    dispose() {
        // Savu + höyry: geometria on Three.js:n Sprite-sisäinen, material explicit
        // Tekstuuri on jaettu (_PARTICLE_TEX) — ei disposen per material
        const sprites = [
            ...this._smokePool,  ...this._activeSmoke,
            ...this._steamPool,  ...this._activeSteam,
        ];
        for (const s of sprites) {
            this._scene.remove(s);
            s.material.dispose();   // ei vapauta jaettua tekstuuria
        }
        _PARTICLE_TEX.dispose();
        _STEAM_TEX.dispose();    // vapautetaan kerran tässä

        // Saostumakerrokset
        for (const [, layer] of this._precipLayers) {
            this._scene.remove(layer.domeMesh);
            this._scene.remove(layer.cylMesh);
            this._scene.remove(layer.capMesh);
            layer.domeMesh.geometry.dispose(); layer.domeMesh.material.dispose();
            layer.cylMesh.geometry.dispose();  layer.cylMesh.material.dispose();
            layer.capMesh.geometry.dispose();  layer.capMesh.material.dispose();
        }
        this._precipLayers.clear();

        // Metallikerrostumat
        for (const tube of [...this._metalDepositMap.keys()]) {
            this._clearMetalDeposit(tube);
        }
        if (this._depositGeom) { this._depositGeom.dispose(); this._depositGeom = null; }

        // Savuvanat (wispit): jaettu geometria, per-materiaali
        const allWisps = [...this._wispPool, ...this._activeWisps];
        for (const w of allWisps) {
            this._scene.remove(w);
            w.material.dispose();
        }
        if (this._wispGeom) { this._wispGeom.dispose(); this._wispGeom = null; }

        // Laskeumispartikkelit (spritet, per-materiaali)
        const allSettle = [...this._settlePool, ...this._activeSettle];
        for (const s of allSettle) {
            this._scene.remove(s);
            s.material.dispose();
        }

        // H2-kipinät (spritet, per-materiaali)
        const allSparks = [...this._sparkPool, ...this._activeSparks];
        for (const s of allSparks) {
            this._scene.remove(s);
            s.material.dispose();
        }

        // Kuplat: jaettu geometria + material — vain yksi dispose riittää
        const allBubbles = [...this._bubblePool, ...this._activeBubble];
        if (allBubbles.length > 0) {
            allBubbles[0].geometry.dispose();
            allBubbles[0].material.dispose();
            for (const b of allBubbles) this._scene.remove(b);
        }

        // Pintakuplat
        const allSurf = [...this._surfBubPool, ...this._activeSurfBub];
        if (allSurf.length > 0) {
            allSurf[0].geometry.dispose();
            for (const b of allSurf) {
                b.material.dispose();
                this._scene.remove(b);
            }
        }

        // Pintaroiskeita (spritet, per-materiaali)
        const allSplash = [...this._splashPool, ...this._activeSplash];
        for (const s of allSplash) {
            this._scene.remove(s);
            s.material.dispose();
        }

        // Foam-kuplat (jaettu geometria, per-materiaali)
        const allFoam = [...this._foamPool, ...this._activeFoam];
        if (allFoam.length > 0) {
            allFoam[0].geometry.dispose();
            for (const b of allFoam) {
                b.material.dispose();
                this._scene.remove(b);
            }
        }

        // Isot pohjankuplat (jaettu geometria, per-materiaali)
        const allBig = [...this._bigBubPool, ...this._activeBigBub];
        if (allBig.length > 0) {
            allBig[0].geometry.dispose();
            for (const b of allBig) {
                b.material.dispose();
                this._scene.remove(b);
            }
        }

        // Kevyen poreilun pintakuplat (jaettu geometria, per-materiaali)
        const allGentle = [...this._gentlePool, ...this._activeGentle];
        if (allGentle.length > 0) {
            allGentle[0].geometry.dispose();
            for (const b of allGentle) {
                b.material.dispose();
                this._scene.remove(b);
            }
        }
    }

    // ── Yksityiset päivitykset ────────────────────────────────────────────────

    /** Päivittää savuvana-wispit — shader-uniformit + elinkaari */
    _updateSmokeWisps(dt) {
        const now = performance.now() * 0.001;
        for (let i = this._activeWisps.length - 1; i >= 0; i--) {
            const w  = this._activeWisps[i];
            const ud = w.userData;
            const age = now - ud.birth;
            if (age >= ud.lifeDur) {
                w.visible = false;
                this._wispPool.push(w);
                this._activeWisps.splice(i, 1);
                continue;
            }
            ud.uniforms.uTime.value = now;
        }
    }

    // Höyrypartikkelien päivitys — sineaalinen häivytys, ei ilmanvastusta, skaala kasvaa eliniän myötä
    _updateSteam(dt) {
        const active = this._activeSteam;
        const pool   = this._steamPool;
        for (let i = active.length - 1; i >= 0; i--) {
            const s  = active[i];
            const ud = s.userData;
            ud.life -= dt;
            if (ud.life <= 0) {
                s.visible          = false;
                s.material.opacity = 0;
                pool.push(s);
                active.splice(i, 1);
                continue;
            }
            const r = ud.life / ud.maxLife;   // 1→0
            s.position.x += ud.vx * dt;
            s.position.y += ud.vy * dt;
            s.position.z += ud.vz * dt;
            // Kasvaa alkukoosta isommaksi nousun myötä — erikokoisia pilviä
            const base = ud.startScale ?? 0.10;
            s.scale.setScalar(base + (1 - r) * (0.30 + base * 1.2));
            // Sineaalinen häivytys: läpinäkyvä alussa ja lopussa, max 22 % — höyrymäinen
            s.material.opacity = Math.sin((1 - r) * Math.PI) * 0.22;
        }
    }

    _updateSprites(active, pool, dt, growPerSec, maxOpacity) {
        for (let i = active.length - 1; i >= 0; i--) {
            const s  = active[i];
            const ud = s.userData;
            ud.life -= dt;

            if (ud.life <= 0) {
                s.visible          = false;
                s.material.opacity = 0;
                pool.push(s);
                active.splice(i, 1);
                continue;
            }

            const t = 1 - ud.life / ud.maxLife;   // 0=alku, 1=loppu

            s.position.x += ud.vx * dt;
            s.position.y += ud.vy * dt;
            s.position.z += ud.vz * dt;
            ud.vy        *= (1 - 0.45 * dt);       // ilmanvastus
            s.scale.addScalar(growPerSec * dt);

            // Häivytys: nousu 0→1 ensimmäisen 15% aikana, 1→0 viimeisen 30% aikana
            let opacity;
            if      (t < 0.15) opacity = t / 0.15;
            else if (t > 0.70) opacity = (1 - t) / 0.30;
            else               opacity = 1;
            s.material.opacity = opacity * maxOpacity;

            // Savu nousee putken sisällä näkyvänä nestepinnalta ylöspäin.
        }
    }

    _updateBubbles(dt) {
        const active = this._activeBubble;
        const pool   = this._bubblePool;

        for (let i = active.length - 1; i >= 0; i--) {
            const b  = active[i];
            const ud = b.userData;

            b.position.y += ud.vy * dt;
            b.position.x += ud.vx * dt;
            b.position.z += ud.vz * dt;

            if (b.position.y >= ud.targetY) {
                b.visible = false;
                pool.push(b);
                active.splice(i, 1);
            }
        }
    }

    _updateSurfBubbles(dt) {
        const active = this._activeSurfBub;
        const pool   = this._surfBubPool;

        for (let i = active.length - 1; i >= 0; i--) {
            const b  = active[i];
            const ud = b.userData;
            ud.life -= dt;

            if (ud.life <= 0) {
                b.visible          = false;
                b.material.opacity = 0;
                b.scale.set(0.001, 1, 0.001);
                pool.push(b);
                active.splice(i, 1);
                continue;
            }

            const elapsed = ud.maxLife - ud.life;
            const t       = 1 - ud.life / ud.maxLife;

            // drift
            b.position.x += ud.vx * dt;
            b.position.z += ud.vz * dt;
            b.position.y  = ud.surfY;

            // scale grow → pop
            if (elapsed < ud.growDur) {
                const st = elapsed / ud.growDur;
                b.scale.set(st * ud.targetScale, 1, st * ud.targetScale);
            } else if (ud.life < ud.popDur) {
                const st = ud.life / ud.popDur;
                b.scale.set(st * ud.targetScale, 1, st * ud.targetScale);
            }

            // wobble (nopea, luonnollinen)
            const wobble = 1 + 0.08 * Math.sin(
                elapsed * ud.wobbleFreq * Math.PI * 2 + ud.wobblePhase
            );
            b.scale.x *= wobble;
            b.scale.z /= wobble;

            // opacity häivytys
            b.material.opacity = t < 0.10 ? t / 0.10 : (1 - t) / 0.30;
            b.material.opacity = Math.max(0, Math.min(0.62, b.material.opacity));
        }
    }

    _recycleAll(active, pool) {
        for (const obj of active) {
            obj.visible = false;
            if (obj.material) obj.material.opacity = 0;
            pool.push(obj);
        }
        active.length = 0;
    }

    _updatePrecipLayers(dt) {
        for (const [, layer] of this._precipLayers) {
            // Häivytysanimaatio (dissolve)
            if (layer.dissolving) {
                // Hidas asteittainen häivytys ~4 s — vastaa Cu-kompleksin värinvaihdon kestoa
                const fade   = dt * 0.22;   // opacity-hajoaminen ~3.7 s (0.82 → 0)
                const shrink = dt * 0.26;   // korkeuden supistuminen samassa tahdissa
                layer.domeMesh.material.opacity = Math.max(0, layer.domeMesh.material.opacity - fade);
                layer.cylMesh.material.opacity  = Math.max(0, layer.cylMesh.material.opacity  - fade);
                layer.capMesh.material.opacity  = Math.max(0, layer.capMesh.material.opacity  - fade);
                // Sakkakerros supistuu ylhäältä alas — käänteinen kasvuanimaatio
                layer.currentH = Math.max(0, layer.currentH - shrink);
                layer.targetH  = Math.max(0, layer.targetH  - shrink);
                if (layer.domeMesh.material.opacity <= 0 || layer.currentH <= 0) {
                    // Piilota mutta älä poista — shader pysyy käännettyinä
                    layer.domeMesh.visible = false;
                    layer.cylMesh.visible  = false;
                    layer.capMesh.visible  = false;
                    layer.currentH         = 0.001;
                    layer.targetH          = 0.001;
                    layer.dissolving       = false;
                    layer.domeMesh.material.opacity = 0.82;
                    layer.cylMesh.material.opacity  = 0.82;
                    layer.capMesh.material.opacity  = 0.80;
                    layer.domeClipPlane.constant    = layer.bottomY;
                    layer.clipPlane.constant        = layer.domePeakY;
                    continue;
                }
                // Ei continue — päivitetään clip-tasot alla (käänteinen kasvu)
            } else {
                // Kasvuanimaatio kohti targetH — targetH kasvaa partikkelien laskeutuessa
                const diff = layer.targetH - layer.currentH;
                if (Math.abs(diff) < 0.0005) continue;

                layer.currentH += diff * Math.min(dt * 0.8, 1.0);
            }

            const h     = layer.currentH;
            const domeR = layer.domeR;

            if (h <= domeR) {
                // ── Vaihe 1: Kupoli — leikkaustaso h:n mukaan ────────────────────
                // Kasvussa: nousee BOTTOM_Y → CYL_START. Liukenemisessa: laskee takaisin.
                const clipH = layer.bottomY + h;
                layer.domeClipPlane.constant = clipH;
                layer.domeMesh.visible = true;
                layer.cylMesh.visible  = false;
                // Cap: todellinen pallokapin halkaisija leikkauskorkeudella clipH.
                // r = sqrt(R² − (clipH − center)²)  missä center = domePeakY
                // Kun clipH=bottomY: r=0 (piste) — kun clipH=domePeakY: r=R ✓
                const dR   = layer.domeR;
                const dy   = clipH - layer.domePeakY;   // negatiivinen (clipH ≤ domePeakY)
                const capR = Math.sqrt(Math.max(0, dR * dR - dy * dy));
                const capS = dR > 0 ? capR / dR : 0;
                layer.capMesh.visible = capS > 0.001;
                layer.capMesh.scale.set(capS, 1, capS);
                layer.capMesh.position.set(
                    layer.domeMesh.position.x,
                    clipH,
                    layer.domeMesh.position.z
                );
            } else {
                // ── Vaihe 2: Kupoli täysi + litteä kerros ────────────────────────
                layer.domeClipPlane.constant = layer.domePeakY;   // näytä koko kupoli
                layer.domeMesh.visible = true;
                const cylH = h - domeR;
                layer.clipPlane.constant = layer.domePeakY + cylH;
                layer.cylMesh.visible = true;
                layer.capMesh.visible = true;
                layer.capMesh.scale.set(1, 1, 1);   // vaihe 2: kansi aina täysi leveys
                layer.capMesh.position.set(
                    layer.cylMesh.position.x,
                    layer.domePeakY + cylH,
                    layer.cylMesh.position.z
                );
            }
        }
        // toDelete ei enää tarvita — kerrokset pysyvät mapissa uudelleenkäyttöä varten
    }

    /**
     * Spawna laskeumispartikkelit sakkautumisreaktion alussa.
     * Pienet valkoiset spritet vajoavat hitaasti nesteen läpi pohjalle.
     * @param {import('./objects/Tube.js').Tube} tube
     * @param {number} count
     */
    _spawnSettleParticles(tube, count = 12, color = 0xffffff, totalGrowth = 0) {
        // Ei spawnailla partikkeleita jos sakka on jo liukenemistilassa
        const existingLayer = this._precipLayers.get(tube);
        if (existingLayer?.dissolving) return;

        const gp          = tube.group.position;
        const r           = tube.liquidRadius * 0.65;
        const topY        = gp.y + tube.liquidLevel * 0.88;
        const botY        = gp.y + 0.18;
        const perParticle = totalGrowth / Math.max(count, 1);

        for (let i = 0; i < count; i++) {
            if (this._settlePool.length === 0) break;
            const s  = this._settlePool.pop();
            const ud = s.userData;
            s.position.set(
                gp.x + (Math.random() - 0.5) * r * 2,
                topY  - Math.random() * tube.liquidLevel * 0.4,
                gp.z  + (Math.random() - 0.5) * r * 2
            );
            ud.velY        = -(0.06 + Math.random() * 0.09);
            ud.bottomY     = botY;
            ud.tube        = tube;        // pysäytyskorkeuden dynaaminen laskenta
            ud.growContrib = perParticle; // sakon kasvuosuus tällä partikkelilla
            ud.fadingOut   = false;       // nollataan poolin kierrätyksestä
            s.material.color.setHex(color);
            s.scale.setScalar(0.09 + Math.random() * 0.05);
            s.material.opacity = 0.40 + Math.random() * 0.25;
            s.visible = true;
            this._activeSettle.push(s);
        }
    }

    _updateSettleParticles(dt) {
        const active = this._activeSettle;
        const pool   = this._settlePool;
        for (let i = active.length - 1; i >= 0; i--) {
            const s  = active[i];
            const ud = s.userData;

            // Per-partikkeli häivytystila: aktivoituu dissolvePrecipitate():ssa, pysyy päällä
            // vaikka layer.dissolving resetoituisi (dissolve-animaatio valmistuu ~3.7 s).
            if (ud.fadingOut) {
                // Vajoaa alaspäin samalla kun häipyy — käänteinen laskeumisefekti
                s.position.y += ud.velY * dt;
                s.material.opacity -= dt * 0.8;   // häipyy ~1 s (hitaampi jotta ehditään nähdä lasku)
                if (s.material.opacity <= 0 || s.position.y <= ud.bottomY - 0.15) {
                    s.material.opacity = 0;
                    s.visible          = false;
                    pool.push(s);
                    active.splice(i, 1);
                }
                continue;   // ei pohjaan pysäytystä eikä kasvua
            }

            s.position.y += ud.velY * dt;

            // Pysäytä partikkeli sakan nykyiseen pintaan (kasvaa dynaamisesti)
            let stopY = ud.bottomY;
            if (ud.tube) {
                const layer = this._precipLayers.get(ud.tube);
                if (layer && layer.currentH > 0.002) {
                    stopY = Math.max(ud.bottomY, layer.bottomY + layer.currentH);
                }
            }

            if (s.position.y <= stopY) {
                // Partikkeli saapui pohjaan — laukaise sakan kasvu juuri nyt
                if (ud.tube && ud.growContrib > 0) {
                    const lyr = this._precipLayers.get(ud.tube);
                    if (lyr && !lyr.dissolving) {
                        lyr.targetH = Math.min(lyr.targetH + ud.growContrib, lyr.maxH);
                    }
                }
                s.material.opacity = 0;
                s.visible          = false;
                pool.push(s);
                active.splice(i, 1);
            }
        }
    }

    _updateSparks(dt) {
        const active = this._activeSparks;
        const pool   = this._sparkPool;
        for (let i = active.length - 1; i >= 0; i--) {
            const s  = active[i];
            const ud = s.userData;
            ud.life -= dt;
            if (ud.life <= 0) {
                s.visible = false;
                pool.push(s);
                active.splice(i, 1);
                continue;
            }
            // Gravity + liike
            ud.vy -= 3.5 * dt;
            s.position.x += ud.vx * dt;
            s.position.y += ud.vy * dt;
            s.position.z += ud.vz * dt;
            // Haalistuu loppua kohden
            const t = ud.life / ud.maxLife;
            s.material.opacity = t * t;
            // Kutistuu myös
            const sc = s.scale.x;
            s.scale.setScalar(sc * Math.pow(0.02, dt));
        }
    }

    _updateSplashes(dt) {
        const GRAVITY = 5.8;
        const active  = this._activeSplash;
        const pool    = this._splashPool;
        for (let i = active.length - 1; i >= 0; i--) {
            const s  = active[i];
            const ud = s.userData;
            ud.life -= dt;

            // Poista kun aika loppuu tai pisara putoaa pinnan alle
            if (ud.life <= 0 || s.position.y < ud.surfY - 0.05) {
                s.visible          = false;
                s.material.opacity = 0;
                pool.push(s);
                active.splice(i, 1);
                continue;
            }

            ud.vy -= GRAVITY * dt;
            s.position.x += ud.vx * dt;
            s.position.y += ud.vy * dt;
            s.position.z += ud.vz * dt;

            // Haalistuu elinajan lopussa tai kun putoaa alas
            const t = ud.life / ud.maxLife;
            const heightFade = Math.min(1, (s.position.y - ud.surfY + 0.05) / 0.08);
            s.material.opacity *= (t > 0.25 ? 1 : t / 0.25) * Math.max(0.1, heightFade);
        }
    }

    _updateFoam(dt) {
        const active = this._activeFoam;
        const pool   = this._foamPool;
        for (let i = active.length - 1; i >= 0; i--) {
            const b  = active[i];
            const ud = b.userData;

            b.position.y += ud.vy * dt;
            b.position.x += ud.vx * dt;
            b.position.z += ud.vz * dt;

            if (b.position.y >= ud.targetY) {
                // Spawn surface dome half-bubble occasionally
                if (ud.tube && Math.random() < 0.45) {
                    const surfY = ud.targetY + ud.popOffset;
                    this.createSurfaceBubble(b.position, surfY);
                }
                b.visible          = false;
                b.material.opacity = 0;
                pool.push(b);
                active.splice(i, 1);
            }
        }
    }

    _updateBigBubbles(dt) {
        const active = this._activeBigBub;
        const pool   = this._bigBubPool;
        for (let i = active.length - 1; i >= 0; i--) {
            const b  = active[i];
            const ud = b.userData;

            b.position.y += ud.vy * dt;
            b.position.x += ud.vx * dt;
            b.position.z += ud.vz * dt;

            // Slight wobble in size as bubble rises
            const wobble = 1.0 + 0.06 * Math.sin(b.position.y * 18 + ud.vy0 * 3);
            b.scale.set(ud.size * wobble, ud.size, ud.size * wobble);

            if (b.position.y >= ud.targetY) {
                // Splash + large surface dome
                if (ud.tube) {
                    const surfY = ud.targetY + ud.popOffset;
                    this.createSurfaceBubble(b.position, surfY);
                    // Extra splash for the bigger pop
                    this.createBoilSplashes(ud.tube, 2 + (Math.random() < 0.5 ? 1 : 0));
                }
                b.visible          = false;
                b.material.opacity = 0;
                pool.push(b);
                active.splice(i, 1);
            }
        }
    }

    _updateGentleBubbles(dt) {
        const active = this._activeGentle;
        const pool   = this._gentlePool;
        for (let i = active.length - 1; i >= 0; i--) {
            const b  = active[i];
            const ud = b.userData;

            b.position.y += ud.vy * dt;
            b.position.x += ud.vx * dt;
            b.position.z += ud.vz * dt;

            if (b.position.y >= ud.targetY) {
                // 35% chance: tiny surface dome bubble
                if (ud.tube && Math.random() < 0.35) {
                    const surfY = ud.tube.group.position.y + ud.tube.liquidLevel;
                    this.createSurfaceBubble(b.position, surfY);
                }
                b.visible          = false;
                b.material.opacity = 0;
                pool.push(b);
                active.splice(i, 1);
            }
        }
    }

    // ── Metallikerrostuma ─────────────────────────────────────────────────────

    /**
     * Poistaa putken metallikerrostuman skenestä ja vapauttaa muistin.
     * @param {import('./objects/Tube.js').Tube} tube
     */
    _clearMetalDeposit(tube) {
        const entry = this._metalDepositMap.get(tube);
        if (!entry) return;
        for (const p of entry.particles) {
            this._scene.remove(p.mesh);
        }
        entry.mat.dispose();
        this._metalDepositMap.delete(tube);
    }

    /**
     * Kasvattaa metallikerrostuma-partikkeleiden skaalausta hitaasti.
     * Jokainen hiukkanen kasvaa itsenäisesti oman viive- ja kasvuaikansa mukaan.
     * @param {number} dt
     */
    _updateMetalDeposits(dt) {
        for (const [, entry] of this._metalDepositMap) {
            for (const p of entry.particles) {
                p.elapsed += dt;
                if (p.elapsed <= 0) continue;   // odottaa viivettä
                const growElapsed = p.elapsed;
                if (growElapsed >= p.growTime) {
                    p.mesh.scale.setScalar(p.targetScale);
                } else {
                    const t     = growElapsed / p.growTime;
                    const eased = t * t * (3 - 2 * t);   // smoothstep
                    p.mesh.scale.setScalar(p.targetScale * eased);
                }
            }
        }
    }
}
