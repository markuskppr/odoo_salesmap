/** @odoo-module **/

/**
 * Point-in-polygon matching in the browser.
 *
 * The Lite edition has no server-side Python, so locating a customer inside
 * a NUTS region happens client side: ray casting against the shipped
 * GeoJSON, with holes respected (Vatican inside Rome) and a bounding-box
 * prefilter so a few hundred customers against a few hundred polygons stay
 * in the low milliseconds.
 */

function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0];
        const yi = ring[i][1];
        const xj = ring[j][0];
        const yj = ring[j][1];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

/** polygon = [outerRing, hole1, hole2, ...] */
function pointInPolygon(x, y, polygon) {
    if (!polygon.length || !pointInRing(x, y, polygon[0])) {
        return false;
    }
    for (let i = 1; i < polygon.length; i++) {
        if (pointInRing(x, y, polygon[i])) {
            return false;
        }
    }
    return true;
}

function polygonsOf(geometry) {
    if (!geometry) {
        return [];
    }
    if (geometry.type === "Polygon") {
        return [geometry.coordinates];
    }
    if (geometry.type === "MultiPolygon") {
        return geometry.coordinates;
    }
    return [];
}

function ringBBox(ring, box) {
    for (const [x, y] of ring) {
        if (x < box[0]) box[0] = x;
        if (y < box[1]) box[1] = y;
        if (x > box[2]) box[2] = x;
        if (y > box[3]) box[3] = y;
    }
}

/**
 * Spatial lookup over a FeatureCollection, keyed by a property.
 *
 * Each polygon carries its own bounding box, so a MultiPolygon country
 * (France with overseas parts) does not produce one world-spanning box that
 * defeats the prefilter.
 */
export class FeatureIndex {
    constructor(features, keyProperty = "code") {
        this.entries = [];
        for (const feature of features || []) {
            const key = feature.properties?.[keyProperty];
            if (!key) {
                continue;
            }
            for (const polygon of polygonsOf(feature.geometry)) {
                if (!polygon.length) {
                    continue;
                }
                const box = [Infinity, Infinity, -Infinity, -Infinity];
                ringBBox(polygon[0], box);
                this.entries.push({ key, polygon, box });
            }
        }
    }

    /** Key of the polygon containing (lon, lat), or null. */
    lookup(lon, lat) {
        for (const entry of this.entries) {
            const b = entry.box;
            if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) {
                continue;
            }
            if (pointInPolygon(lon, lat, entry.polygon)) {
                return entry.key;
            }
        }
        return null;
    }
}

/** NUTS codes are prefix-hierarchical: DE11 -> DE1 -> DE. */
export function nutsAncestor(code, level) {
    const length = { country: 2, nuts1: 3, nuts2: 4 }[level];
    if (!code || !length || code.length < length) {
        return null;
    }
    return code.slice(0, length);
}

/** NUTS deviates from ISO for Greece and the UK. */
const NUTS_TO_ISO = { EL: "GR", UK: "GB" };
export function isoCountryOfNuts(code) {
    if (!code) {
        return null;
    }
    const prefix = code.slice(0, 2);
    return NUTS_TO_ISO[prefix] || prefix;
}
export function nutsPrefixOfIso(iso) {
    const inverse = { GR: "EL", GB: "UK" };
    return inverse[iso] || iso;
}
