/** @odoo-module **/

/**
 * Map projections for the dashboard.
 *
 * Two are provided, chosen by the active boundary scheme:
 *
 * **Lambert azimuthal equal-area**, parametrised as EPSG:3035
 * (ETRS89-LAEA Europe), for the European view. Why not Web Mercator, as web
 * maps normally use? Mercator inflates area with latitude: Scandinavia appears
 * roughly twice its true size, southern Europe correspondingly small. On a
 * choropleth map, where the area itself carries the message, that is
 * systematic misinformation -- and EPSG:3035 is precisely the projection
 * Eurostat mandates for pan-European statistical maps.
 *
 * **Equal Earth**, for the worldwide view. An equal-area pseudocylindrical
 * projection (Savric, Patterson & Jenny, 2018) that keeps continents
 * recognisably shaped while preserving relative areas. The usual alternatives
 * are worse here: Mercator makes Greenland rival Africa, and the azimuthal
 * projection above degenerates badly once it has to cover a whole hemisphere.
 *
 * Both compute on the sphere rather than the ellipsoid. The difference is a
 * few hundred metres, immaterial on a map whose pixels span kilometres.
 */

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Lambert azimuthal equal-area, centred like EPSG:3035
// ---------------------------------------------------------------------------

const LAEA_LAT0 = 52 * DEG;
const LAEA_LON0 = 10 * DEG;
const LAEA_SIN_LAT0 = Math.sin(LAEA_LAT0);
const LAEA_COS_LAT0 = Math.cos(LAEA_LAT0);

function projectLaea(lon, lat) {
    const phi = lat * DEG;
    const lambda = lon * DEG - LAEA_LON0;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const cosLambda = Math.cos(lambda);

    const denominator =
        1 + LAEA_SIN_LAT0 * sinPhi + LAEA_COS_LAT0 * cosPhi * cosLambda;
    // The denominator only vanishes at the exact antipode, where the
    // projection is undefined. Guard it so one stray point cannot fill the map
    // with NaN paths.
    if (denominator <= 1e-9) {
        return null;
    }
    const k = Math.sqrt(2 / denominator);
    return [
        k * cosPhi * Math.sin(lambda),
        k * (LAEA_COS_LAT0 * sinPhi - LAEA_SIN_LAT0 * cosPhi * cosLambda),
    ];
}

// ---------------------------------------------------------------------------
// Equal Earth
// ---------------------------------------------------------------------------

const EE_A1 = 1.340264;
const EE_A2 = -0.081106;
const EE_A3 = 0.000893;
const EE_A4 = 0.003796;
const EE_SQRT3_2 = Math.sqrt(3) / 2;

function projectEqualEarth(lon, lat) {
    const phi = lat * DEG;
    const lambda = lon * DEG;
    const theta = Math.asin(EE_SQRT3_2 * Math.sin(phi));
    const theta2 = theta * theta;
    const theta6 = theta2 * theta2 * theta2;
    return [
        (lambda * Math.cos(theta)) /
            (EE_SQRT3_2 *
                (EE_A1 +
                    3 * EE_A2 * theta2 +
                    theta6 * (7 * EE_A3 + 9 * EE_A4 * theta2))),
        theta * (EE_A1 + EE_A2 * theta2 + theta6 * (EE_A3 + EE_A4 * theta2)),
    ];
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export const PROJECTIONS = {
    laea: { project: projectLaea, label: "Europe (LAEA, EPSG:3035)" },
    equalEarth: { project: projectEqualEarth, label: "World (Equal Earth)" },
};

/**
 * Projection appropriate for a map level.
 *
 * The NUTS levels are Europe-only and get the Eurostat-mandated LAEA;
 * worldwide data (countries, custom regions) must not use the Europe-centred
 * azimuthal projection, because areas far from the centre are distorted
 * beyond usefulness.
 */
export function projectionFor(level) {
    return level === "nuts1" || level === "nuts2" || level === "nuts3"
        ? PROJECTIONS.laea
        : PROJECTIONS.equalEarth;
}

/** Project (lon, lat) in degrees. y points north. */
export function project(lon, lat, projection = PROJECTIONS.laea) {
    return projection.project(lon, lat);
}

/**
 * Convert a set of GeoJSON features into SVG paths.
 *
 * Projection runs exactly once per geometry; zoom and pan are handled purely by
 * the SVG transform on the group. That is why the map stays fluid with
 * thousands of areas: zooming recomputes nothing.
 *
 * Pass ``existingTransform`` to draw another layer in the same frame -- for
 * instance country outlines underneath sales territories. Without it each layer
 * would fit itself independently and they would not line up.
 */
export function buildPaths(features, viewport, existingTransform = null) {
    const projection = viewport.projection || PROJECTIONS.laea;
    const projected = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const feature of features) {
        const polygons = normalizePolygons(feature.geometry);
        const rings = [];
        for (const polygon of polygons) {
            for (const ring of polygon) {
                const points = [];
                for (const position of ring) {
                    const point = projection.project(position[0], position[1]);
                    if (!point) {
                        continue;
                    }
                    points.push(point);
                    if (point[0] < minX) minX = point[0];
                    if (point[0] > maxX) maxX = point[0];
                    if (point[1] < minY) minY = point[1];
                    if (point[1] > maxY) maxY = point[1];
                }
                if (points.length > 2) {
                    rings.push(points);
                }
            }
        }
        projected.push({ feature, rings });
    }

    if (!Number.isFinite(minX)) {
        return { items: [], transform: existingTransform };
    }

    const transform =
        existingTransform ||
        fitTransform(
            { minX, minY, maxX, maxY },
            viewport.width,
            viewport.height,
            viewport.padding ?? 8,
            projection,
        );

    const items = projected.map(({ feature, rings }) => ({
        properties: feature.properties,
        d: ringsToPath(rings, transform),
    }));
    return { items, transform };
}

/** Scale and offset that fit the bounding box into the viewport. */
function fitTransform(bounds, width, height, padding, projection) {
    const spanX = bounds.maxX - bounds.minX || 1e-6;
    const spanY = bounds.maxY - bounds.minY || 1e-6;
    const scale = Math.min(
        (width - 2 * padding) / spanX,
        (height - 2 * padding) / spanY,
    );
    return {
        scale,
        // y is mirrored: SVG grows downwards, geography northwards.
        offsetX:
            padding + (width - 2 * padding - spanX * scale) / 2 - bounds.minX * scale,
        offsetY:
            padding + (height - 2 * padding - spanY * scale) / 2 + bounds.maxY * scale,
        bounds,
        projection,
    };
}

/** Apply a transform to a projected point. */
export function toScreen(point, transform) {
    return [
        point[0] * transform.scale + transform.offsetX,
        transform.offsetY - point[1] * transform.scale,
    ];
}

/** Project and transform in one step (for the point layer). */
export function projectToScreen(lon, lat, transform, projection = null) {
    const active = projection || transform.projection || PROJECTIONS.laea;
    const point = active.project(lon, lat);
    return point ? toScreen(point, transform) : null;
}

function ringsToPath(rings, transform) {
    const parts = [];
    for (const ring of rings) {
        let path = "";
        let previousX = null;
        let previousY = null;
        for (let index = 0; index < ring.length; index++) {
            const [x, y] = toScreen(ring[index], transform);
            // Round to a tenth of a pixel and drop points that land on their
            // predecessor: for small areas that removes up to two thirds of the
            // vertices with no visible difference.
            const roundedX = Math.round(x * 10) / 10;
            const roundedY = Math.round(y * 10) / 10;
            if (roundedX === previousX && roundedY === previousY) {
                continue;
            }
            path += `${index === 0 || path === "" ? "M" : "L"}${roundedX} ${roundedY}`;
            previousX = roundedX;
            previousY = roundedY;
        }
        if (path) {
            parts.push(`${path}Z`);
        }
    }
    return parts.join("");
}

function normalizePolygons(geometry) {
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
