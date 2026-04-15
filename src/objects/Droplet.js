/**
 * Droplet.js
 *
 * Putoavan reagenssipartikkelin animaatio.
 * Periytyminen: ei — luokka on tietoisesti yksinkertainen.
 *
 * Muistivuodon esto:
 *   • Geometria ja materiaali jaettu staattisissa kartoissa (yksi per
 *     ainetyyppi), ei uusia GPU-objekteja per klikkaus.
 *   • dispose() poistaa meshin scenestä. Geometrioita/materiaaleja ei
 *     tuhota dispose-kutsulla — ne ovat jaettuja.
 */

import * as THREE from 'three';

// ── Gravitaatio ───────────────────────────────────────────────────────────────
const GRAVITY = 11.0;   // yksikköä/s²

// ── Nesteen jarrutus ─────────────────────────────────────────────────────────
const LIQUID_DRAG = 5.0;   // 1/s — eksponentiaalinen vaimenus nesteessä
const LIQUID_GRAV = 4.0;   // yksikköä/s² — pienennetty efektiivinen painovoima nesteessä

// ── Kiinteät aineet (putoavat pohjalle, jäävät näkyviin) ─────────────────────
const SOLID_SUBSTANCES = new Set(['Fe', 'Mg', 'Cu', 'CaCO3']);

// ── Ainekohtainen ulkonäkö ────────────────────────────────────────────────────
const SUBSTANCE_DEFS = {
    Fe:     { color: 0x6e6e6e, metalness: 0.85, roughness: 0.40 },
    Mg:     { color: 0xd4d4d4, metalness: 0.80, roughness: 0.48 },
    Cu:     { color: 0xb87333, metalness: 0.90, roughness: 0.30 },
    CaCO3:  { color: 0xf0ece0, metalness: 0.0,  roughness: 0.70 },
    NaOH:   { color: 0xd0f0d0, radius: 0.08, segments: 7 },
    NH3:    { color: 0xc8e4ff, radius: 0.08, segments: 7 },
    Luminol:{ color: 0xe0e0ff, radius: 0.07, segments: 7 },
    Yeast:  { color: 0xd4b896, radius: 0.06, segments: 7 },
};

const DEFAULT_DEF = { color: 0xeeeeee, radius: 0.08, segments: 7 };

// ── Geometria-/materiaalivarasto (luodaan laiskasti, jaettu kaikille tipuille) ─
const _geomCache = new Map();   // substance → BufferGeometry
const _matCache  = new Map();   // substance → Material

function _getShared(substance) {
    if (!_geomCache.has(substance)) {
        const def  = SUBSTANCE_DEFS[substance] ?? DEFAULT_DEF;
        let geom;
        if (substance === 'Fe') {
            // Rautanäyte: lieriömäinen tappimaisesti kapeneva kappale
            geom = new THREE.CylinderGeometry(0.035, 0.048, 0.40, 10);
        } else if (substance === 'Mg') {
            // Magnesiumpalanen: litistynyt suorakulmio
            geom = new THREE.BoxGeometry(0.06, 0.055, 0.22);
        } else if (substance === 'Cu') {
            // Kuparipalanen: litistetty suorakulmainen levy (kuten Mg, mutta kapeampi)
            geom = new THREE.BoxGeometry(0.055, 0.05, 0.20);
        } else if (substance === 'CaCO3') {
            // Kalsiumkarbonaattijauhe: pieni epämääräinen muru
            geom = new THREE.IcosahedronGeometry(0.06, 0);
        } else {
            // Pisaramainen muoto: pyöreä pohja, kapeneva yläosa
            const r = def.radius;
            const pts = [
                new THREE.Vector2(0,         -r * 1.0),
                new THREE.Vector2(r * 0.42,  -r * 0.62),
                new THREE.Vector2(r * 0.88,  -r * 0.08),
                new THREE.Vector2(r * 0.72,   r * 0.38),
                new THREE.Vector2(r * 0.38,   r * 0.78),
                new THREE.Vector2(0,           r * 1.05),
            ];
            geom = new THREE.LatheGeometry(pts, 14);
        }
        const _isMetal = substance === 'Fe' || substance === 'Cu' || substance === 'Mg';
        const mat = new THREE.MeshStandardMaterial({
            color:            def.color,
            roughness:        def.roughness ?? (_isMetal ? 0.45 : 0.55),
            metalness:        def.metalness ?? (_isMetal ? 0.75 : 0.0),
            envMapIntensity:  0.0,
            transparent: !SOLID_SUBSTANCES.has(substance),
            opacity:     SOLID_SUBSTANCES.has(substance) ? 1.0
                       : (substance === 'NaOH' || substance === 'NH3' || substance === 'Luminol' ? 0.75 : 1.0),
        });
        _geomCache.set(substance, geom);
        _matCache.set(substance, mat);
    }
    return { geom: _geomCache.get(substance), mat: _matCache.get(substance) };
}

// ── Luokka ────────────────────────────────────────────────────────────────────
export class Droplet {
    /**
     * @param {string}        substance  - e.g. 'Fe', 'Mg', 'NH3'
     * @param {THREE.Vector3} startPos   - spawn-positio
     * @param {number}        targetY    - Y-koordinaatti johon reagoida
     * @param {THREE.Scene}   scene
     * @param {function}      onLand     - (droplet: Droplet) => void
     */
    constructor(substance, startPos, targetY, liquidSurfaceY, scene, onLand, onSurfaceCross = null) {
        this.substance        = substance;
        this._targetY         = targetY;
        this._liquidSurfaceY  = liquidSurfaceY;
        this._scene           = scene;
        this._onLand          = onLand;
        this._onSurfaceCross  = onSurfaceCross;
        this._surfaceCrossed  = false;
        this._velY     = 0;
        this._landed   = false;
        // Kiinteiden kappaleiden pieni pyörimisnopeus pudotessa (rad/s)
        const solid = SOLID_SUBSTANCES.has(substance);
        this._rotX = solid ? (Math.random() - 0.5) * 2.0 : 0;
        this._rotY = solid ? (Math.random() - 0.5) * 1.5 : 0;
        this._rotZ = solid ? (Math.random() - 0.5) * 2.5 : 0;

        const { geom, mat } = _getShared(substance);
        this._mesh = new THREE.Mesh(geom, mat);
        this._mesh.position.copy(startPos);
        this._mesh.renderOrder = 10;
        scene.add(this._mesh);
    }

    get landed()   { return this._landed; }
    get position() { return this._mesh.position; }
    get mesh()     { return this._mesh; }
    get isSolid()  { return SOLID_SUBSTANCES.has(this.substance); }

    /**
     * Kloonaa jaetun materiaalin tämän instanssin omaksi materiaaliksi.
     * Tarvitaan kun kiinteän kappaleen väriä animoidaan yksilöllisesti.
     * Palauttaa uuden MeshStandardMaterial-instanssin.
     */
    cloneMaterial() {
        const shared = _matCache.get(this.substance);
        const cloned = shared.clone();
        this._mesh.material  = cloned;
        this._ownsMaterial   = true;
        return cloned;
    }

    /** Päivitä putoaminen kutsumalla joka frame. */
    update(dt) {
        if (this._landed) return;
        const inLiquid = this.isSolid &&
            this._mesh.position.y < this._liquidSurfaceY;
        if (inLiquid) {
            // Nesteessä: pienentynyt painovoima + voimakas viskoosinen jarrutus
            this._velY -= LIQUID_GRAV * dt;
            this._velY *= Math.exp(-LIQUID_DRAG * dt);
        } else {
            this._velY -= GRAVITY * dt;
        }
        this._mesh.position.y += this._velY * dt;

        // Pintarajan ylityksen tunnistus (kiinteät kappaleet)
        if (this.isSolid && !this._surfaceCrossed &&
            this._mesh.position.y < this._liquidSurfaceY) {
            this._surfaceCrossed = true;
            if (this._onSurfaceCross) this._onSurfaceCross(this);
        }

        // Kiinteät kappaleet pyörivät putoamisen aikana
        if (this._rotX !== 0) {
            this._mesh.rotation.x += this._rotX * dt;
            this._mesh.rotation.y += this._rotY * dt;
            this._mesh.rotation.z += this._rotZ * dt;
        }

        if (this._mesh.position.y <= this._targetY) {
            this._mesh.position.y = this._targetY;
            this._landed          = true;
            this._onLand(this);
        }
    }

    /**
     * Poistaa meshin scenestä.
     * Geometriaa/materiaalia ei tuhota — ne ovat jaettuja.
     */
    dispose() {
        if (this._mesh) {
            // Oma kloonattu materiaali täytyy vapauttaa itse
            if (this._ownsMaterial && this._mesh.material) {
                this._mesh.material.dispose();
            }
            this._scene.remove(this._mesh);
            this._mesh = null;
        }
    }
}
