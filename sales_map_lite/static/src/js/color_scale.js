/** @odoo-module **/

/**
 * Classification and colouring of the map areas.
 *
 * The choice of classification method shapes the message of this map more than
 * the choice of colours does. Revenue distributions are almost always heavily
 * right-skewed: a few regions carry most of the turnover. Split the value range
 * into equal intervals and 90 percent of regions land in the lightest class,
 * leaving a map that shows only where the peak is and nothing about the
 * structure beneath it. Quantiles are therefore the default; equal intervals
 * stay available for comparing against absolute thresholds.
 */

/** Sequential palette (dark = high), following ColorBrewer "Blues". */
export const SEQUENTIAL = [
    "#eff3ff", "#c6dbef", "#9ecae1", "#6baed6", "#4292c6", "#2171b5", "#084594",
];

/**
 * Diverging palette for rates of change. Red for decline, blue for growth --
 * deliberately not red/green, which is indistinguishable under the most common
 * form of colour vision deficiency (deuteranopia).
 */
export const DIVERGING = [
    "#b2182b", "#ef8a62", "#fddbc7", "#f0f0f0", "#d1e5f0", "#67a9cf", "#2166ac",
];

export const CLASSIFICATIONS = [
    { key: "quantile", label: "Quantiles (equal group size)" },
    { key: "equal", label: "Equal intervals" },
];

/**
 * Build a classification from a set of values.
 *
 * @param {number[]} values
 * @param {object} options {classes, method, diverging}
 */
export function buildScale(values, options = {}) {
    const classes = Math.max(3, Math.min(options.classes ?? 5, 7));
    const method = options.method === "equal" ? "equal" : "quantile";
    const diverging = !!options.diverging;
    const palette = pickPalette(diverging ? DIVERGING : SEQUENTIAL, classes);

    const clean = values
        .filter((value) => Number.isFinite(value))
        .sort((a, b) => a - b);

    if (!clean.length) {
        return {
            breaks: [],
            colors: palette,
            method,
            diverging,
            colorFor: () => null,
        };
    }

    const breaks = diverging
        ? symmetricBreaks(clean, classes)
        : method === "equal"
        ? equalBreaks(clean, classes)
        : quantileBreaks(clean, classes);

    const colorFor = (value) => {
        if (!Number.isFinite(value)) {
            return null;
        }
        let index = 0;
        while (index < breaks.length && value > breaks[index]) {
            index++;
        }
        return palette[Math.min(index, palette.length - 1)];
    };

    return { breaks, colors: palette, method, diverging, colorFor };
}

/** Pick evenly spaced steps out of a seven-step palette. */
function pickPalette(palette, classes) {
    if (classes >= palette.length) {
        return palette.slice();
    }
    const picked = [];
    for (let index = 0; index < classes; index++) {
        const position = Math.round((index * (palette.length - 1)) / (classes - 1));
        picked.push(palette[position]);
    }
    return picked;
}

/**
 * Quantile breaks. Duplicate breaks are collapsed: where values cluster (many
 * regions sharing the same small turnover) empty classes would otherwise appear
 * and make the legend unreadable.
 */
function quantileBreaks(sorted, classes) {
    const breaks = [];
    for (let index = 1; index < classes; index++) {
        const position = (index / classes) * (sorted.length - 1);
        const lower = Math.floor(position);
        const upper = Math.ceil(position);
        const weight = position - lower;
        const value = sorted[lower] * (1 - weight) + sorted[upper] * weight;
        if (!breaks.length || value > breaks[breaks.length - 1]) {
            breaks.push(value);
        }
    }
    return breaks;
}

function equalBreaks(sorted, classes) {
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const step = (max - min) / classes;
    const breaks = [];
    for (let index = 1; index < classes; index++) {
        breaks.push(min + step * index);
    }
    return breaks;
}

/**
 * Symmetric breaks around zero for rates of change: only then does the neutral
 * colour actually sit at "no change", and a gain of 20 percent is as far from
 * the middle as a loss of 20 percent.
 */
function symmetricBreaks(sorted, classes) {
    const extreme = Math.max(
        Math.abs(sorted[0]),
        Math.abs(sorted[sorted.length - 1]),
        1,
    );
    const breaks = [];
    const steps = classes - 1;
    for (let index = 1; index <= steps; index++) {
        breaks.push(-extreme + (2 * extreme * index) / classes);
    }
    return breaks;
}

/**
 * Radius of a revenue point.
 *
 * The radius follows the square root of the value so the circle's *area*
 * carries the magnitude. Scaling the radius linearly makes areas grow
 * quadratically and wildly overstates large values -- one of the classic
 * failures of proportional symbol maps. The minimum radius keeps small values
 * visible, deliberately trading a little exactness for legibility.
 */
export function symbolRadius(value, maxValue, maxRadius = 18, minRadius = 2.5) {
    if (!value || !maxValue || value <= 0) {
        return 0;
    }
    return minRadius + (maxRadius - minRadius) * Math.sqrt(value / maxValue);
}

/** Black or white, whichever reads better on the given fill. */
export function contrastingText(hexColor) {
    if (!hexColor || hexColor.length < 7) {
        return "#000000";
    }
    const r = parseInt(hexColor.slice(1, 3), 16) / 255;
    const g = parseInt(hexColor.slice(3, 5), 16) / 255;
    const b = parseInt(hexColor.slice(5, 7), 16) / 255;
    const channel = (c) =>
        c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    const luminance =
        0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    return luminance > 0.45 ? "#111111" : "#ffffff";
}
