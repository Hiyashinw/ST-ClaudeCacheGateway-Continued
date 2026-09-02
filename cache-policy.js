import { createHash } from 'node:crypto';

export const MARKER = '[[CACHE_BREAK]]';
export const SHORT_MARKER = '[[CACHE_BREAK_SHORT]]';
export const MAX_BREAKPOINTS = 4;
export const MAX_IGNORED_ANCHORS = 5;
export const INITIAL_EVALUATION_IGNORED_ANCHORS = 0;
export const ANCHOR_EVALUATION_REQUESTS = 3;
export const ANCHOR_EVALUATION_SAMPLE_SIZE = 3;
export const CACHE_POLICY_PROCESSING_STAGES = Object.freeze([
    'fixed-head',
    'ignore-tail',
    'cache-anchor',
    'tail-fill',
    'protected-tail-anchor',
    'last-gateway-cache-point-5m',
]);
export const DEFAULT_CACHE_POLICY_PROCESSING_ORDER = CACHE_POLICY_PROCESSING_STAGES;
export const DEFAULT_CACHE_POLICY = Object.freeze({
    fixedHeadBreakpointCount: 0,
    cacheAnchorMode: 'off',
    cacheAnchorIntervalBlocks: 3,
});

export const DEFAULT_CACHE_ENHANCEMENTS = Object.freeze({
    autoConvertLastAnchorTo5m: false,
    ignoreLastAnchorsMode: 'fixed',
    ignoreLastAnchorCount: 0,
});

const VALID_PROTOCOLS = new Set(['openai', 'anthropic']);
const VALID_ANCHOR_MODES = new Set(['off', 'single', 'rolling']);
const VALID_PROCESSING_STAGES = new Set(CACHE_POLICY_PROCESSING_STAGES);
const CACHE_CONTROL_KEY = 'cache_control';
const ANCHOR_STORE_STATE_VERSION = 1;

export class CachePolicyError extends Error {
    constructor(message, code = 'CACHE_POLICY_ERROR', details = {}) {
        super(message);
        this.name = 'CachePolicyError';
        this.code = code;
        this.statusCode = 400;
        this.details = details;
    }
}

function cloneJson(value) {
    if (value === undefined) {
        return undefined;
    }

    return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTextBlock(value) {
    return isObject(value) && value.type === 'text' && typeof value.text === 'string';
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function markerDefinitions(marker = MARKER, shortMarker = SHORT_MARKER) {
    const definitions = [
        { marker, kind: 'long' },
        { marker: shortMarker, kind: 'short' },
    ];

    for (const definition of definitions) {
        if (typeof definition.marker !== 'string' || definition.marker.length === 0) {
            throw new CachePolicyError('Cache markers must be non-empty strings.', 'INVALID_CACHE_MARKER');
        }
    }

    if (marker === shortMarker) {
        throw new CachePolicyError(
            'Long and short cache markers must be different strings.',
            'DUPLICATE_CACHE_MARKER',
        );
    }

    return definitions;
}

function findMarkers(text, definitions = markerDefinitions()) {
    if (typeof text !== 'string' || text.length === 0) {
        return [];
    }

    const found = [];

    for (const definition of definitions) {
        let fromIndex = 0;

        while (fromIndex <= text.length - definition.marker.length) {
            const index = text.indexOf(definition.marker, fromIndex);

            if (index < 0) {
                break;
            }

            found.push({ ...definition, index });
            fromIndex = index + definition.marker.length;
        }
    }

    return found.sort((left, right) => left.index - right.index || right.marker.length - left.marker.length);
}

function markerCount(text, definitions = markerDefinitions()) {
    return findMarkers(text, definitions).length;
}

function markerKindCounts(text, definitions = markerDefinitions()) {
    const counts = { long: 0, short: 0 };

    for (const match of findMarkers(text, definitions)) {
        counts[match.kind]++;
    }

    return counts;
}

function stripMarkers(text, definitions = markerDefinitions()) {
    if (typeof text !== 'string') {
        return text;
    }

    let stripped = text;

    for (const { marker } of definitions) {
        stripped = stripped.split(marker).join('');
    }

    return stripped;
}

function containsMarker(text, definitions = markerDefinitions()) {
    return findMarkers(text, definitions).length > 0;
}

function isMarkerOnlyText(text, definitions = markerDefinitions()) {
    return typeof text === 'string'
        && containsMarker(text, definitions)
        && stripMarkers(text, definitions).trim() === '';
}

function countMarkersInContent(content, definitions = markerDefinitions()) {
    if (typeof content === 'string') {
        return markerCount(content, definitions);
    }

    if (!Array.isArray(content)) {
        return 0;
    }

    return content.reduce((total, block) => (
        total + (isTextBlock(block) ? markerCount(block.text, definitions) : 0)
    ), 0);
}

function markerKindCountsInContent(content, definitions = markerDefinitions()) {
    const counts = { long: 0, short: 0 };
    const texts = typeof content === 'string'
        ? [content]
        : (Array.isArray(content) ? content.filter(isTextBlock).map((block) => block.text) : []);

    for (const text of texts) {
        const current = markerKindCounts(text, definitions);
        counts.long += current.long;
        counts.short += current.short;
    }

    return counts;
}

function isMarkerOnlyContent(content, definitions = markerDefinitions()) {
    if (typeof content === 'string') {
        return isMarkerOnlyText(content, definitions);
    }

    if (!Array.isArray(content) || content.length === 0) {
        return false;
    }

    return content.every((block) => isTextBlock(block) && stripMarkers(block.text, definitions).trim() === '')
        && content.some((block) => containsMarker(block.text, definitions));
}

function isMeaningfulContent(content) {
    if (typeof content === 'string') {
        return content.trim() !== '';
    }

    if (!Array.isArray(content)) {
        return content !== undefined && content !== null;
    }

    return content.some((block) => {
        if (isTextBlock(block)) {
            return block.text.trim() !== '';
        }

        return block !== undefined && block !== null;
    });
}

function messageHasNonContentPayload(message) {
    if (!isObject(message)) {
        return false;
    }

    return Object.entries(message).some(([key, value]) => {
        if (key === 'role' || key === 'content' || key === 'name') {
            return false;
        }

        if (Array.isArray(value)) {
            return value.length > 0;
        }

        return value !== undefined && value !== null && value !== '';
    });
}

function canonicalize(value, seen = new WeakSet()) {
    if (value === null || typeof value !== 'object') {
        if (typeof value === 'number' && !Number.isFinite(value)) {
            return null;
        }

        return value;
    }

    if (seen.has(value)) {
        throw new TypeError('Cannot canonicalize a cyclic value.');
    }

    seen.add(value);

    if (Array.isArray(value)) {
        const output = value.map((item) => {
            const normalized = canonicalize(item, seen);
            return normalized === undefined ? null : normalized;
        });
        seen.delete(value);
        return output;
    }

    const output = {};

    for (const key of Object.keys(value).sort()) {
        const normalized = canonicalize(value[key], seen);

        if (normalized !== undefined) {
            output[key] = normalized;
        }
    }

    seen.delete(value);
    return output;
}

export function canonicalStringify(value) {
    return JSON.stringify(canonicalize(value));
}

export function hashCanonical(value) {
    return createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

function isPromptCacheControlValue(value) {
    return isObject(value) && value.type === 'ephemeral';
}

function isPromptCacheControlContainerPath(path) {
    const isIndex = (value) => Number.isInteger(value) && value >= 0;

    if (path.length === 2
        && ['tools', 'functions', 'system'].includes(path[0])
        && isIndex(path[1])) {
        return true;
    }

    if (path[0] !== 'messages' || !isIndex(path[1]) || path.length < 4) {
        return false;
    }

    for (let index = 2; index < path.length; index += 2) {
        if (path[index] !== 'content' || !isIndex(path[index + 1])) {
            return false;
        }
    }

    return path.length % 2 === 0;
}

function normalizeFingerprintValue(value, definitions = markerDefinitions(), path = []) {
    if (typeof value === 'string') {
        return stripMarkers(value, definitions);
    }

    if (Array.isArray(value)) {
        return value.map((item, index) => normalizeFingerprintValue(item, definitions, [...path, index]));
    }

    if (!isObject(value)) {
        return value;
    }

    const output = {};

    for (const [key, child] of Object.entries(value)) {
        const isPromptCacheControl = key === CACHE_CONTROL_KEY
            && isPromptCacheControlContainerPath(path)
            && isPromptCacheControlValue(child);

        if (isPromptCacheControl || child === undefined) {
            continue;
        }

        output[key] = normalizeFingerprintValue(child, definitions, [...path, key]);
    }

    return output;
}

function stripCacheControlDeep(value, definitions = markerDefinitions()) {
    if (typeof value === 'string') {
        return stripMarkers(value, definitions);
    }

    if (Array.isArray(value)) {
        return value.map((item) => stripCacheControlDeep(item, definitions));
    }

    if (!isObject(value)) {
        return value;
    }

    const output = {};

    for (const [key, child] of Object.entries(value)) {
        if (key === CACHE_CONTROL_KEY || child === undefined) {
            continue;
        }

        output[key] = stripCacheControlDeep(child, definitions);
    }

    return output;
}

/**
 * Return a stable content hash for one prompt block.  Cache directives are
 * intentionally excluded: changing a block from a gateway-owned 1h boundary
 * to a 5m boundary must not make the block look like prompt content changed.
 */
export function hashPromptBlock(value, metadata = null, definitions = markerDefinitions()) {
    return hashCanonical({
        metadata: metadata || null,
        value: stripCacheControlDeep(value, definitions),
    });
}

export function normalizeCachePolicyProcessingOrder(value, { strict = false } = {}) {
    if (value === undefined || value === null || value === '') {
        return [...DEFAULT_CACHE_POLICY_PROCESSING_ORDER];
    }

    if (!Array.isArray(value)) {
        if (strict) {
            throw new CachePolicyError(
                'cachePolicyProcessingOrder must be an array containing every supported stage exactly once.',
                'INVALID_CACHE_POLICY_PROCESSING_ORDER',
                { cachePolicyProcessingOrder: value },
            );
        }

        return [...DEFAULT_CACHE_POLICY_PROCESSING_ORDER];
    }

    const normalized = value.map((stage) => String(stage ?? '').trim().toLowerCase());
    const valid = normalized.length === CACHE_POLICY_PROCESSING_STAGES.length
        && new Set(normalized).size === CACHE_POLICY_PROCESSING_STAGES.length
        && normalized.every((stage) => VALID_PROCESSING_STAGES.has(stage));

    if (!valid) {
        if (strict) {
            throw new CachePolicyError(
                'cachePolicyProcessingOrder must contain every supported stage exactly once.',
                'INVALID_CACHE_POLICY_PROCESSING_ORDER',
                {
                    cachePolicyProcessingOrder: value,
                    requiredStages: [...CACHE_POLICY_PROCESSING_STAGES],
                },
            );
        }

        return [...DEFAULT_CACHE_POLICY_PROCESSING_ORDER];
    }

    return normalized;
}

export function normalizeCachePolicy(input = {}) {
    const source = input || {};
    const fixedHeadBreakpointCount = Number(
        source.fixedHeadBreakpointCount ?? DEFAULT_CACHE_POLICY.fixedHeadBreakpointCount,
    );
    const cacheAnchorMode = String(source.cacheAnchorMode ?? DEFAULT_CACHE_POLICY.cacheAnchorMode).trim().toLowerCase();
    const cacheAnchorIntervalBlocks = Number(
        source.cacheAnchorIntervalBlocks ?? DEFAULT_CACHE_POLICY.cacheAnchorIntervalBlocks,
    );

    if (!Number.isInteger(fixedHeadBreakpointCount) || fixedHeadBreakpointCount < 0 || fixedHeadBreakpointCount > MAX_BREAKPOINTS) {
        throw new CachePolicyError(
            `fixedHeadBreakpointCount must be an integer from 0 to ${MAX_BREAKPOINTS}.`,
            'INVALID_FIXED_HEAD_COUNT',
            { fixedHeadBreakpointCount },
        );
    }

    if (!VALID_ANCHOR_MODES.has(cacheAnchorMode)) {
        throw new CachePolicyError(
            'cacheAnchorMode must be one of: off, single, rolling.',
            'INVALID_ANCHOR_MODE',
            { cacheAnchorMode },
        );
    }

    if (!Number.isInteger(cacheAnchorIntervalBlocks) || cacheAnchorIntervalBlocks < 1 || cacheAnchorIntervalBlocks > 1000) {
        throw new CachePolicyError(
            'cacheAnchorIntervalBlocks must be an integer from 1 to 1000.',
            'INVALID_ANCHOR_INTERVAL',
            { cacheAnchorIntervalBlocks },
        );
    }

    const result = {
        fixedHeadBreakpointCount,
        cacheAnchorMode,
        cacheAnchorIntervalBlocks,
    };

    // Keep the original three-field return shape for callers that only use the
    // historic cache policy.  The optional enhancements are added when one of
    // their fields is explicitly present, which keeps old integrations and
    // persisted configurations backwards compatible while allowing the new
    // planner options to travel through the same policy object.
    const enhancementKeys = [
        'autoConvertLastAnchorTo5m',
        'autoConvertLastAnchorToShortTtl',
        'lastAnchorShortTtl',
        'autoLastAnchor5m',
        'autoLastAnchorTo5m',
        'autoConvertLastAnchorToShort',
        'ignoreLastAnchorsMode',
        'anchorIgnoreMode',
        'ignoredAnchorsMode',
        'ignoreMode',
        'ignoreLastAnchorCount',
        'ignoredAnchorCount',
        'ignoreLastAnchorsCount',
        'ignoreTailAnchorCount',
        'ignoreLastAnchors',
        'ignoredAnchors',
    ];

    if (hasOwn(source, 'cachePolicyProcessingOrder')) {
        result.cachePolicyProcessingOrder = normalizeCachePolicyProcessingOrder(
            source.cachePolicyProcessingOrder,
            { strict: true },
        );
    } else {
        Object.defineProperty(result, 'cachePolicyProcessingOrder', {
            value: [...DEFAULT_CACHE_POLICY_PROCESSING_ORDER],
        });
    }

    if (enhancementKeys.some((key) => hasOwn(source, key))) {
        Object.assign(result, normalizeCacheEnhancements(source, { allowEvaluationOverflow: true }));
    } else {
        // Expose safe defaults without changing the enumerable shape expected
        // by older callers that deep-compare the historic three-field policy.
        Object.defineProperties(result, {
            autoConvertLastAnchorTo5m: { value: DEFAULT_CACHE_ENHANCEMENTS.autoConvertLastAnchorTo5m },
            ignoreLastAnchorsMode: { value: DEFAULT_CACHE_ENHANCEMENTS.ignoreLastAnchorsMode },
            ignoreLastAnchorCount: { value: DEFAULT_CACHE_ENHANCEMENTS.ignoreLastAnchorCount },
        });
    }

    return result;
}

function firstOwnValue(source, keys, fallback) {
    for (const key of keys) {
        if (hasOwn(source, key)) {
            return source[key];
        }
    }

    return fallback;
}

function normalizeBooleanOption(value, fallback = false, strict = false, field = 'option') {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    if (typeof value === 'boolean') {
        return value;
    }

    if (!strict) {
        const normalized = String(value).trim().toLowerCase();

        if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) {
            return true;
        }

        if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) {
            return false;
        }

        return fallback;
    }

    throw new CachePolicyError(`${field} must be a boolean.`, 'INVALID_CACHE_OPTION', { field, value });
}

export function normalizeIgnoredAnchorCount(value, { strict = false, allowEvaluationOverflow = false } = {}) {
    const number = Number(value ?? 0);
    const aboveMaximum = !allowEvaluationOverflow && number > MAX_IGNORED_ANCHORS;

    if (!Number.isInteger(number) || number < 0 || aboveMaximum) {
        if (strict) {
            const range = allowEvaluationOverflow
                ? 'a non-negative integer'
                : `an integer from 0 to ${MAX_IGNORED_ANCHORS}`;
            throw new CachePolicyError(
                `ignoreLastAnchorCount must be ${range}.`,
                'INVALID_IGNORED_ANCHOR_COUNT',
                {
                    ignoreLastAnchorCount: value,
                    maximum: allowEvaluationOverflow ? null : MAX_IGNORED_ANCHORS,
                },
            );
        }

        return 0;
    }

    return number;
}

export function normalizeIgnoredAnchorMode(value, { strict = false } = {}) {
    const raw = String(value ?? DEFAULT_CACHE_ENHANCEMENTS.ignoreLastAnchorsMode).trim().toLowerCase();
    const aliases = new Map([
        ['fixed', 'fixed'],
        ['number', 'fixed'],
        ['numeric', 'fixed'],
        ['manual', 'fixed'],
        ['evaluation', 'evaluation'],
        ['evaluate', 'evaluation'],
        ['eval', 'evaluation'],
        ['auto', 'evaluation'],
    ]);
    const normalized = aliases.get(raw);

    if (normalized) {
        return normalized;
    }

    if (strict) {
        throw new CachePolicyError(
            'ignoreLastAnchorsMode must be fixed or evaluation.',
            'INVALID_IGNORED_ANCHOR_MODE',
            { ignoreLastAnchorsMode: value },
        );
    }

    return DEFAULT_CACHE_ENHANCEMENTS.ignoreLastAnchorsMode;
}

export function normalizeCacheEnhancements(input = {}, { strict = false, allowEvaluationOverflow = false } = {}) {
    const source = input || {};
    const autoRaw = firstOwnValue(source, [
        'autoConvertLastAnchorTo5m',
        'autoConvertLastAnchorToShortTtl',
        'lastAnchorShortTtl',
        'autoLastAnchor5m',
        'autoLastAnchorTo5m',
        'autoConvertLastAnchorToShort',
    ], DEFAULT_CACHE_ENHANCEMENTS.autoConvertLastAnchorTo5m);
    const modeRaw = firstOwnValue(source, [
        'ignoreLastAnchorsMode',
        'anchorIgnoreMode',
        'ignoredAnchorsMode',
        'ignoreMode',
    ], DEFAULT_CACHE_ENHANCEMENTS.ignoreLastAnchorsMode);
    const countRaw = firstOwnValue(source, [
        'ignoreLastAnchorCount',
        'ignoredAnchorCount',
        'ignoreLastAnchorsCount',
        'ignoreTailAnchorCount',
        'ignoreLastAnchors',
        'ignoredAnchors',
    ], undefined);
    const mode = normalizeIgnoredAnchorMode(modeRaw, { strict });
    const count = countRaw === undefined
        ? (mode === 'evaluation' ? INITIAL_EVALUATION_IGNORED_ANCHORS : DEFAULT_CACHE_ENHANCEMENTS.ignoreLastAnchorCount)
        : normalizeIgnoredAnchorCount(countRaw, { strict, allowEvaluationOverflow });

    return {
        autoConvertLastAnchorTo5m: normalizeBooleanOption(
            autoRaw,
            DEFAULT_CACHE_ENHANCEMENTS.autoConvertLastAnchorTo5m,
            strict,
            'autoConvertLastAnchorTo5m',
        ),
        ignoreLastAnchorsMode: mode,
        ignoreLastAnchorCount: count,
    };
}

function normalizeEvaluationSample(snapshot = {}) {
    const blocks = Array.isArray(snapshot.blocks)
        ? snapshot.blocks.map((entry, index) => ({
            path: String(entry?.path ?? entry?.key ?? index),
            identity: String(entry?.identity ?? entry?.path ?? entry?.key ?? index),
            hash: entry?.hash === undefined || entry?.hash === null ? null : String(entry.hash),
        }))
        : [];
    const anchors = Array.isArray(snapshot.anchors)
        ? snapshot.anchors.map((entry, index) => {
            const blockIndex = Number(entry?.blockIndex);
            return {
                path: String(entry?.path ?? index),
                logicalIndex: Number.isInteger(Number(entry?.logicalIndex))
                    ? Number(entry.logicalIndex)
                    : null,
                blockIndex: Number.isInteger(blockIndex) && blockIndex >= 0 ? blockIndex : null,
            };
        })
        : [];

    return { blocks, anchors };
}

function evaluateAnchorSamples(samples) {
    if (samples.length !== ANCHOR_EVALUATION_SAMPLE_SIZE
        || samples.some((sample) => sample.blocks.length === 0)) {
        return { available: false, reason: 'hash-data-unavailable' };
    }

    const shortestLength = Math.min(...samples.map((sample) => sample.blocks.length));
    let stablePrefixLength = 0;

    while (stablePrefixLength < shortestLength) {
        const first = samples[0].blocks[stablePrefixLength];
        const stable = first.hash !== null && samples.every((sample) => {
            const block = sample.blocks[stablePrefixLength];
            return block.path === first.path
                && block.identity === first.identity
                && block.hash === first.hash;
        });

        if (!stable) {
            break;
        }

        stablePrefixLength += 1;
    }

    const allBlocksStable = samples.every((sample) => (
        sample.blocks.length === samples[0].blocks.length
        && stablePrefixLength === sample.blocks.length
    ));
    if (allBlocksStable) {
        return {
            available: true,
            reason: 'all-blocks-stable',
            stablePrefixLength,
            changedBlockIndex: null,
            ignoredAnchorCount: 0,
        };
    }

    const latestAnchors = samples.at(-1).anchors;
    if (latestAnchors.some((anchor) => anchor.blockIndex === null)) {
        return { available: false, reason: 'anchor-boundary-unavailable' };
    }

    const firstIgnoredAnchorIndex = latestAnchors.findIndex(
        (anchor) => anchor.blockIndex >= stablePrefixLength,
    );
    const ignoredAnchorCount = firstIgnoredAnchorIndex < 0
        ? 0
        : latestAnchors.length - firstIgnoredAnchorIndex;

    return {
        available: true,
        reason: 'block-prefix-changed',
        stablePrefixLength,
        changedBlockIndex: stablePrefixLength,
        firstIgnoredAnchorIndex: firstIgnoredAnchorIndex < 0 ? null : firstIgnoredAnchorIndex,
        ignoredAnchorCount,
    };
}

/**
 * Create the in-memory state used by the optional three-request anchor
 * evaluation mode.  The evaluator deliberately lives in the cache-policy
 * module so the request server and unit tests share exactly the same rules.
 */
export function createAnchorEvaluationState(initialCount = INITIAL_EVALUATION_IGNORED_ANCHORS) {
    const count = normalizeIgnoredAnchorCount(initialCount, { allowEvaluationOverflow: true });

    return {
        active: true,
        pendingReview: false,
        x: count,
        initialX: count,
        requestsCompleted: 0,
        cyclesCompleted: 0,
        requiredRequests: ANCHOR_EVALUATION_REQUESTS,
        sampleSize: ANCHOR_EVALUATION_SAMPLE_SIZE,
        samples: [],
        result: null,
        warning: null,
        notice: null,
    };
}

/**
 * Add one successful conversation to an evaluation.  The third sample is
 * compared with the first two as an ordered sequence of prompt-block hashes.
 * The first unstable block invalidates its own cache boundary and every later
 * candidate anchor because each later cache entry includes the changed prefix.
 */
export function recordAnchorEvaluation(state, snapshot = {}) {
    const current = state && typeof state === 'object'
        ? state
        : createAnchorEvaluationState();

    if (!current.active || current.pendingReview) {
        return {
            state: { ...current, samples: [...(current.samples || [])] },
            evaluated: false,
            completed: Number.isInteger(current.result) || Boolean(current.warning),
            reason: 'inactive',
        };
    }

    const samples = [
        ...(Array.isArray(current.samples) ? current.samples : []),
        normalizeEvaluationSample(snapshot),
    ];
    const next = {
        ...current,
        requestsCompleted: Number(current.requestsCompleted || 0) + 1,
        samples,
        notice: null,
    };

    if (samples.length < ANCHOR_EVALUATION_SAMPLE_SIZE) {
        return { state: next, evaluated: false, completed: false, reason: 'sampling' };
    }

    const evaluation = evaluateAnchorSamples(samples);
    const nextX = evaluation.available ? evaluation.ignoredAnchorCount : 0;
    next.x = nextX;
    next.cyclesCompleted = Number(current.cyclesCompleted || 0) + 1;
    next.samples = [];
    next.active = false;

    if (!evaluation.available) {
        next.pendingReview = true;
        next.result = null;
        next.warning = 'evaluation-data-unavailable';
        next.notice = '三次对话缺少可比较的块哈希或锚点边界，未自动填入结果，请检查预设后重新评估。';
    } else {
        next.pendingReview = nextX > MAX_IGNORED_ANCHORS;
        next.result = nextX;
        next.notice = nextX <= MAX_IGNORED_ANCHORS
            ? `已完成 ${ANCHOR_EVALUATION_REQUESTS} 次连续对话，建议忽略末尾 ${nextX} 个锚点。`
            : `已完成 ${ANCHOR_EVALUATION_REQUESTS} 次连续对话，评估结果为 ${nextX}，超出 0-${MAX_IGNORED_ANCHORS} 的合理范围，请检查预设。`;
        next.warning = nextX > MAX_IGNORED_ANCHORS ? 'evaluation-result-out-of-range' : null;
    }

    return {
        state: next,
        evaluated: true,
        completed: true,
        reason: evaluation.reason,
        previousX: Number(current.x || 0),
        x: nextX,
        result: next.result,
        stablePrefixLength: evaluation.stablePrefixLength ?? null,
        changedBlockIndex: evaluation.changedBlockIndex ?? null,
        firstIgnoredAnchorIndex: evaluation.firstIgnoredAnchorIndex ?? null,
        ignoredAnchorCount: evaluation.ignoredAnchorCount ?? null,
        warning: next.warning,
    };
}

function normalizeProtocol(protocol) {
    const normalized = String(protocol || 'openai').trim().toLowerCase();

    if (!VALID_PROTOCOLS.has(normalized)) {
        throw new CachePolicyError(
            'protocol must be either openai or anthropic.',
            'INVALID_CACHE_PROTOCOL',
            { protocol },
        );
    }

    return normalized;
}

function isLandableContentBlock(block, definitions = markerDefinitions()) {
    if (!isObject(block)) {
        return false;
    }

    if (!isTextBlock(block)) {
        return true;
    }

    return stripMarkers(block.text, definitions).trim() !== '';
}

function contentEndsWithMarker(content, definitions = markerDefinitions()) {
    function textEndsWithMarker(text) {
        const trimmed = typeof text === 'string' ? text.trimEnd() : '';
        return definitions.some(({ marker }) => trimmed.endsWith(marker));
    }

    if (typeof content === 'string') {
        return textEndsWithMarker(content);
    }

    if (!Array.isArray(content) || content.length === 0) {
        return false;
    }

    const last = content[content.length - 1];
    return isTextBlock(last) && textEndsWithMarker(last.text);
}

function countMarkersDeep(value, definitions = markerDefinitions()) {
    if (typeof value === 'string') {
        return markerCount(value, definitions);
    }

    if (Array.isArray(value)) {
        return value.reduce((total, item) => total + countMarkersDeep(item, definitions), 0);
    }

    if (!isObject(value)) {
        return 0;
    }

    return Object.values(value).reduce((total, child) => total + countMarkersDeep(child, definitions), 0);
}

function normalizeAutomaticMode(options) {
    if (hasOwn(options, 'mode')) {
        const mode = String(options.mode ?? '').trim().toLowerCase();

        if (!['off', 'on', 'auto'].includes(mode)) {
            throw new CachePolicyError(
                'Automatic cache breakpoint mode must be off, on, or auto.',
                'INVALID_AUTOMATIC_CACHE_BREAKPOINT_MODE',
                { mode: options.mode },
            );
        }

        return mode;
    }

    return options.enabled === true ? 'on' : 'off';
}

export function preprocessAutomaticCacheBreaks(body, options = {}) {
    if (!isObject(body)) {
        throw new CachePolicyError('Request body must be a JSON object.', 'INVALID_REQUEST_BODY');
    }

    const protocol = normalizeProtocol(options.protocol);
    const marker = options.marker ?? MARKER;
    const shortMarker = options.shortMarker ?? SHORT_MARKER;
    const definitions = markerDefinitions(marker, shortMarker);
    const mode = normalizeAutomaticMode(options);
    const explicitMarkerCount = countMarkersDeep(body, definitions);
    const existingCacheControlCount = collectCacheControls(body).controls.length;
    const suppressed = mode === 'auto' && (explicitMarkerCount > 0 || existingCacheControlCount > 0);
    const enabled = mode === 'on' || (mode === 'auto' && !suppressed);
    const suppressionReason = !suppressed
        ? null
        : (explicitMarkerCount > 0 && existingCacheControlCount > 0
            ? 'explicit-marker-and-cache-control'
            : (explicitMarkerCount > 0 ? 'explicit-marker' : 'existing-cache-control'));

    const nextBody = cloneJson(body);
    const diagnostics = {
        enabled,
        mode,
        requestedMode: mode,
        suppressed,
        suppressionReason,
        explicitMarkerCount,
        existingCacheControlCount,
        protocol,
        added: 0,
        alreadyMarked: 0,
        unlandable: 0,
        paths: [],
    };

    if (!enabled) {
        return { body: nextBody, diagnostics };
    }

    function record(path, source, status, markerPath = path) {
        diagnostics[status]++;
        diagnostics.paths.push({ path, markerPath, source, status });
    }

    function appendToContent(owner, key, path, source) {
        const content = owner?.[key];

        if (contentEndsWithMarker(content, definitions)) {
            record(path, source, 'alreadyMarked');
            return;
        }

        if (typeof content === 'string') {
            if (content.trim() === '') {
                record(path, source, 'unlandable');
                return;
            }

            owner[key] = `${content}${marker}`;
            record(path, source, 'added');
            return;
        }

        if (!Array.isArray(content)) {
            record(path, source, 'unlandable');
            return;
        }

        const hasTarget = content.some((block) => isLandableContentBlock(block, definitions));

        if (!hasTarget) {
            record(path, source, 'unlandable');
            return;
        }

        const markerPath = `${path}[${content.length}]`;
        content.push({ type: 'text', text: marker });
        record(path, source, 'added', markerPath);
    }

    const hasLandableTopLevelSystem = protocol === 'anthropic'
        && hasOwn(nextBody, 'system')
        && (typeof nextBody.system === 'string'
            ? nextBody.system.trim() !== ''
            : Array.isArray(nextBody.system)
                && nextBody.system.some((block) => isLandableContentBlock(block, definitions)));

    if (hasLandableTopLevelSystem) {
        appendToContent(nextBody, 'system', 'system', 'anthropic-system');
    }

    const messages = Array.isArray(nextBody.messages) ? nextBody.messages : [];

    if (protocol === 'anthropic'
        && options.anthropicSystemMessagesInMessages === true
        && !hasLandableTopLevelSystem) {
        let lastSystemIndex = -1;

        for (let index = 0; index < messages.length; index++) {
            if (messages[index]?.role === 'system') {
                lastSystemIndex = index;
            }
        }

        if (lastSystemIndex >= 0) {
            appendToContent(
                messages[lastSystemIndex],
                'content',
                `messages[${lastSystemIndex}].content`,
                'anthropic-system-message',
            );
        }
    }

    if (protocol === 'openai') {
        let lastSystemIndex = -1;

        for (let index = 0; index < messages.length; index++) {
            if (messages[index]?.role === 'system') {
                lastSystemIndex = index;
            }
        }

        if (lastSystemIndex >= 0) {
            appendToContent(
                messages[lastSystemIndex],
                'content',
                `messages[${lastSystemIndex}].content`,
                'openai-system',
            );
        }
    }

    for (let index = 0; index < messages.length; index++) {
        if (messages[index]?.role !== 'assistant') {
            continue;
        }

        appendToContent(messages[index], 'content', `messages[${index}].content`, 'assistant');
    }

    return { body: nextBody, diagnostics };
}

function addMarkerCandidate(normalization, target, source, kindCounts = { long: 1, short: 0 }) {
    const count = (kindCounts.long || 0) + (kindCounts.short || 0);
    normalization.totalMarkers += count;

    if (!isLandableContentBlock(target, normalization.markerDefinitions)) {
        normalization.unlandableMarkers += count;
        return;
    }

    const current = normalization.candidateByTarget.get(target);

    if (current) {
        current.markerCount += count;
        current.markerKindCounts.long += kindCounts.long || 0;
        current.markerKindCounts.short += kindCounts.short || 0;
        current.markerKinds = ['long', 'short'].filter((kind) => current.markerKindCounts[kind] > 0);

        if (!current.sources.includes(source)) {
            current.sources.push(source);
        }

        return;
    }

    const candidate = {
        target,
        markerCount: count,
        markerKindCounts: {
            long: kindCounts.long || 0,
            short: kindCounts.short || 0,
        },
        markerKinds: ['long', 'short'].filter((kind) => (kindCounts[kind] || 0) > 0),
        sources: [source],
    };
    normalization.candidateByTarget.set(target, candidate);
    normalization.rawCandidates.push(candidate);
}

function splitTextBlock(block, nextBlocks, normalization, source, definitions = markerDefinitions()) {
    const matches = findMarkers(block.text, definitions);

    if (matches.length === 0) {
        nextBlocks.push(block);
        return false;
    }

    const originalCacheControl = hasOwn(block, CACHE_CONTROL_KEY) ? cloneJson(block.cache_control) : undefined;
    const base = { ...block };
    delete base.text;
    delete base.cache_control;
    const emitted = [];
    let cursor = 0;

    for (const match of matches) {
        const part = block.text.slice(cursor, match.index);
        let target = null;

        if (part !== '') {
            target = { ...base, type: 'text', text: part };
            nextBlocks.push(target);
            emitted.push(target);
        } else {
            const previous = nextBlocks[nextBlocks.length - 1];
            target = isTextBlock(previous) ? previous : null;
        }

        addMarkerCandidate(normalization, target, source, {
            long: match.kind === 'long' ? 1 : 0,
            short: match.kind === 'short' ? 1 : 0,
        });
        cursor = match.index + match.marker.length;
    }

    const tail = block.text.slice(cursor);

    if (tail !== '') {
        const target = { ...base, type: 'text', text: tail };
        nextBlocks.push(target);
        emitted.push(target);
    }

    if (originalCacheControl !== undefined && emitted.length > 0) {
        emitted[emitted.length - 1].cache_control = originalCacheControl;
    }

    return true;
}

function findPreviousLandableBlock(blocks, definitions = markerDefinitions()) {
    for (let index = blocks.length - 1; index >= 0; index--) {
        if (isLandableContentBlock(blocks[index], definitions)) {
            return blocks[index];
        }
    }

    return null;
}

function migrateMarkerCarrierControl(block, target, carrierPath, targetPath = null) {
    if (!isObject(block)
        || !hasOwn(block, CACHE_CONTROL_KEY)
        || !isPromptCacheControlValue(block.cache_control)) {
        return false;
    }

    const carrierControl = cloneJson(block.cache_control);

    if (!target) {
        throw new CachePolicyError(
            `Caller cache_control at ${carrierPath} is attached to a standalone cache marker with no preceding cacheable target.`,
            'CACHE_MARKER_CONTROL_TARGET_MISSING',
            {
                carrierPath,
                targetPath,
                cacheControl: carrierControl,
            },
        );
    }

    if (hasOwn(target, CACHE_CONTROL_KEY)) {
        if (!cacheControlsSemanticallyEqual(target.cache_control, carrierControl)) {
            throw new CachePolicyError(
                `Caller cache_control at ${carrierPath} conflicts with the cache_control already present at its marker boundary.`,
                'CACHE_MARKER_CONTROL_CONFLICT',
                {
                    carrierPath,
                    targetPath,
                    carrierCacheControl: carrierControl,
                    targetCacheControl: cloneJson(target.cache_control),
                },
            );
        }

        return false;
    }

    target.cache_control = carrierControl;
    return true;
}

function migrateMarkerOnlyContentControls(content, target, source, targetPath = null) {
    if (!Array.isArray(content)) {
        return;
    }

    for (let index = 0; index < content.length; index++) {
        migrateMarkerCarrierControl(
            content[index],
            target,
            `${source}[${index}].cache_control`,
            targetPath,
        );
    }
}

function normalizeContent(content, normalization, source, definitions = markerDefinitions()) {
    if (typeof content === 'string') {
        if (!containsMarker(content, definitions)) {
            return { content, changed: false };
        }

        const nextBlocks = [];
        splitTextBlock({ type: 'text', text: content }, nextBlocks, normalization, source, definitions);
        return {
            content: nextBlocks.length > 0 ? nextBlocks : '',
            changed: true,
        };
    }

    if (!Array.isArray(content)) {
        return { content, changed: false };
    }

    const nextBlocks = [];
    let changed = false;

    for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
        const block = content[blockIndex];

        if (!isTextBlock(block) || !containsMarker(block.text, definitions)) {
            nextBlocks.push(block);
            continue;
        }

        changed = true;

        if (isMarkerOnlyText(block.text, definitions)) {
            const target = findPreviousLandableBlock(nextBlocks, definitions);
            const targetIndex = target ? nextBlocks.lastIndexOf(target) : -1;
            migrateMarkerCarrierControl(
                block,
                target,
                `${source}[${blockIndex}].cache_control`,
                targetIndex >= 0 ? `${source}[${targetIndex}].cache_control` : null,
            );
            addMarkerCandidate(
                normalization,
                target,
                `${source}:standalone-block`,
                markerKindCounts(block.text, definitions),
            );
            continue;
        }

        splitTextBlock(block, nextBlocks, normalization, `${source}:inline`, definitions);
    }

    return { content: nextBlocks, changed };
}

function ensureLastLandableTarget(message, definitions = markerDefinitions()) {
    if (typeof message?.content === 'string') {
        if (message.content.trim() === '') {
            return null;
        }

        const target = { type: 'text', text: message.content };
        message.content = [target];
        return target;
    }

    if (!Array.isArray(message?.content)) {
        return null;
    }

    for (let index = message.content.length - 1; index >= 0; index--) {
        const block = message.content[index];

        if (isLandableContentBlock(block, definitions)) {
            return block;
        }
    }

    return null;
}

function findPreviousMessageTarget(messages, role, definitions = markerDefinitions()) {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]?.role !== role) {
            continue;
        }

        const target = ensureLastLandableTarget(messages[index], definitions);

        if (target) {
            return target;
        }
    }

    return null;
}

function normalizeMarkers(body, protocol, definitions = markerDefinitions()) {
    const normalization = {
        body: cloneJson(body),
        markerDefinitions: definitions,
        rawCandidates: [],
        candidateByTarget: new Map(),
        totalMarkers: 0,
        unlandableMarkers: 0,
        changedGroups: new Set(),
        removedEmptyMessages: 0,
    };
    const nextBody = normalization.body;

    if (protocol === 'anthropic' && hasOwn(nextBody, 'system')) {
        const result = normalizeContent(nextBody.system, normalization, 'system', definitions);

        if (result.changed) {
            normalization.changedGroups.add('system');
            nextBody.system = result.content;

            if (!isMeaningfulContent(nextBody.system)) {
                delete nextBody.system;
            }
        }
    }

    if (!Array.isArray(nextBody.messages)) {
        return normalization;
    }

    const messages = [];

    for (let index = 0; index < nextBody.messages.length; index++) {
        const message = nextBody.messages[index];

        if (!isObject(message)) {
            messages.push(message);
            continue;
        }

        const count = countMarkersInContent(message.content, definitions);

        if (count > 0 && isMarkerOnlyContent(message.content, definitions)) {
            const target = findPreviousMessageTarget(messages, message.role, definitions);
            migrateMarkerOnlyContentControls(
                message.content,
                target,
                `messages[${index}].content`,
                target ? 'previous-message-boundary.cache_control' : null,
            );
            addMarkerCandidate(
                normalization,
                target,
                `messages[${index}]:standalone-message`,
                markerKindCountsInContent(message.content, definitions),
            );
            normalization.changedGroups.add(`messages[${index}]`);

            if (messageHasNonContentPayload(message)) {
                message.content = '';
                messages.push(message);
            } else {
                normalization.removedEmptyMessages++;
            }

            continue;
        }

        const result = normalizeContent(message.content, normalization, `messages[${index}].content`, definitions);

        if (result.changed) {
            message.content = result.content;
            normalization.changedGroups.add(`messages[${index}]`);
        }

        if (result.changed && !isMeaningfulContent(message.content) && !messageHasNonContentPayload(message)) {
            normalization.removedEmptyMessages++;
            continue;
        }

        messages.push(message);
    }

    nextBody.messages = messages;
    return normalization;
}

const PROMPT_DEFINITION_KEYS = new Set([
    'tools',
    'tool_choice',
    'functions',
    'function_call',
    'response_format',
]);

function buildBodyMeta(body, definitions = markerDefinitions()) {
    const meta = {};

    for (const [key, value] of Object.entries(body || {})) {
        if (!PROMPT_DEFINITION_KEYS.has(key)) {
            continue;
        }

        meta[key] = normalizeFingerprintValue(value, definitions, [key]);
    }

    return meta;
}

function contentUnits(
    content,
    basePath,
    group,
    messageMeta = null,
    fingerprintPath = [],
    definitions = markerDefinitions(),
) {
    if (typeof content === 'string') {
        return [{
            target: null,
            path: basePath,
            descriptor: { group, messageMeta, value: normalizeFingerprintValue(content, definitions, fingerprintPath) },
            logical: content.trim() !== '',
        }];
    }

    if (!Array.isArray(content)) {
        return [];
    }

    return content.map((block, index) => ({
        target: isObject(block) ? block : null,
        path: `${basePath}[${index}]`,
        descriptor: {
            group,
            messageMeta,
            value: normalizeFingerprintValue(block, definitions, [...fingerprintPath, index]),
        },
        logical: isTextBlock(block) ? block.text.trim() !== '' : block !== undefined && block !== null,
    }));
}

function enumeratePromptUnits(body, protocol, definitions = markerDefinitions()) {
    const units = [];

    if (protocol === 'anthropic') {
        units.push(...contentUnits(body?.system, 'system', 'system', null, ['system'], definitions));
    }

    for (let index = 0; index < (Array.isArray(body?.messages) ? body.messages.length : 0); index++) {
        const message = body.messages[index];
        const messageMeta = normalizeFingerprintValue(
            isObject(message) ? Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'content')) : message,
            definitions,
            ['messages', index],
        );
        units.push({
            target: null,
            path: `messages[${index}]`,
            descriptor: { group: `message:${index}:meta`, value: messageMeta },
            logical: !isMeaningfulContent(message?.content) && messageHasNonContentPayload(message),
        });
        units.push(...contentUnits(
            message?.content,
            `messages[${index}].content`,
            `message:${index}`,
            null,
            ['messages', index, 'content'],
            definitions,
        ));
    }

    return units;
}

function finalizeCandidates(normalization, protocol) {
    const rawByTarget = normalization.candidateByTarget;
    const units = enumeratePromptUnits(normalization.body, protocol, normalization.markerDefinitions);
    const prefix = [];
    const boundaryMarkerHistory = [];
    const candidates = [];
    const meta = buildBodyMeta(normalization.body, normalization.markerDefinitions);
    let logicalIndex = 0;

    for (const unit of units) {
        prefix.push(unit.descriptor);

        if (unit.logical) {
            logicalIndex++;
        }

        const raw = unit.target ? rawByTarget.get(unit.target) : null;

        if (!raw) {
            continue;
        }

        boundaryMarkerHistory.push({
            prefixLength: prefix.length,
            markerKinds: [...raw.markerKinds],
        });
        const prefixHash = hashCanonical({
            meta,
            prefix,
            boundaryMarkerHistory,
        });
        const contentPrefixHash = hashCanonical({ meta, prefix });
        const markerHistoryHash = hashCanonical(boundaryMarkerHistory.map((item) => item.markerKinds));
        candidates.push({
            ...raw,
            order: candidates.length,
            path: unit.path,
            logicalIndex,
            prefixHash,
            contentPrefixHash,
            markerHistoryHash,
            blockHash: hashPromptBlock(raw.target, {
                group: unit.group,
                messageMeta: unit.messageMeta,
            }, normalization.markerDefinitions),
        });
    }

    const finalizedTargets = new Set(candidates.map((candidate) => candidate.target));

    for (const raw of normalization.rawCandidates) {
        if (!finalizedTargets.has(raw.target)) {
            normalization.unlandableMarkers += raw.markerCount;
        }
    }

    return candidates;
}

function collectCacheControls(root) {
    const controls = [];
    const byTarget = new WeakMap();

    function recordOwnControl(value, path, location) {
        if (!isPromptCacheControlContainerPath(location)
            || !hasOwn(value, CACHE_CONTROL_KEY)
            || !isPromptCacheControlValue(value.cache_control)) {
            return;
        }

        const record = {
            target: value,
            path: path ? `${path}.cache_control` : CACHE_CONTROL_KEY,
            value: cloneJson(value.cache_control),
        };
        controls.push(record);
        byTarget.set(value, record);
    }

    function rootKeyRank(key) {
        if (key === 'tools' || key === 'functions') {
            return 0;
        }

        if (key === 'system') {
            return 1;
        }

        if (key === 'messages') {
            return 2;
        }

        return 3;
    }

    function visit(value, path, location, rootLevel = false) {
        if (Array.isArray(value)) {
            for (let index = 0; index < value.length; index++) {
                visit(value[index], `${path}[${index}]`, [...location, index]);
            }
            return;
        }

        if (!isObject(value)) {
            return;
        }

        if (!rootLevel) {
            recordOwnControl(value, path, location);
        }

        const entries = Object.entries(value);

        if (rootLevel) {
            entries.sort(([left], [right]) => rootKeyRank(left) - rootKeyRank(right));
        }

        for (const [key, child] of entries) {
            if (key === CACHE_CONTROL_KEY
                && isPromptCacheControlContainerPath(location)
                && isPromptCacheControlValue(child)) {
                continue;
            }

            visit(child, path ? `${path}.${key}` : key, [...location, key]);
        }

        if (rootLevel) {
            recordOwnControl(value, path, location);
        }
    }

    visit(root, '', [], true);
    return { controls, byTarget };
}

function getEffectiveClaudeCacheTtl(cacheControl) {
    if (!hasOwn(cacheControl, 'ttl') || cacheControl.ttl === '5m') {
        return '5m';
    }

    if (cacheControl.ttl === '1h') {
        return '1h';
    }

    return null;
}

function describeCacheControlTtls(controls) {
    return controls.map((control) => ({
        path: control.path,
        effectiveTtl: getEffectiveClaudeCacheTtl(control.value),
        explicitTtl: hasOwn(control.value, 'ttl') ? control.value.ttl : null,
    }));
}

function assertClaudeCacheTtlOrder(controls) {
    let firstFiveMinuteControl = null;

    for (const control of controls) {
        const effectiveTtl = getEffectiveClaudeCacheTtl(control.value);

        if (effectiveTtl === '5m' && firstFiveMinuteControl === null) {
            firstFiveMinuteControl = control;
            continue;
        }

        if (effectiveTtl === '1h' && firstFiveMinuteControl !== null) {
            const ttlOrder = describeCacheControlTtls(controls);
            throw new CachePolicyError(
                `Invalid cache TTL order: 1h cache_control at ${control.path} appears after 5m cache_control at ${firstFiveMinuteControl.path}. Claude requires every 1h cache breakpoint to appear before all 5m breakpoints.`,
                'CACHE_TTL_ORDER_INVALID',
                {
                    firstFiveMinutePath: firstFiveMinuteControl.path,
                    laterOneHourPath: control.path,
                    paths: controls.map((item) => item.path),
                    ttlOrder,
                },
            );
        }
    }

    return describeCacheControlTtls(controls);
}

function hasMarkerDeep(value, definitions = markerDefinitions()) {
    if (typeof value === 'string') {
        return containsMarker(value, definitions);
    }

    if (Array.isArray(value)) {
        return value.some((item) => hasMarkerDeep(item, definitions));
    }

    if (!isObject(value)) {
        return false;
    }

    return Object.values(value).some((child) => hasMarkerDeep(child, definitions));
}

export function assertCachePlan(body, options = {}) {
    const marker = options.marker ?? MARKER;
    const shortMarker = options.shortMarker ?? SHORT_MARKER;
    const definitions = markerDefinitions(marker, shortMarker);
    const maxBreakpoints = options.maxBreakpoints ?? MAX_BREAKPOINTS;
    const translationEnabled = options.translationEnabled !== false;
    const { controls } = collectCacheControls(body);

    if (controls.length > maxBreakpoints) {
        throw new CachePolicyError(
            `Request contains ${controls.length} cache_control entries; upstream accepts at most ${maxBreakpoints}.`,
            'CACHE_CONTROL_LIMIT_EXCEEDED',
            { cacheControlCount: controls.length, maxBreakpoints, paths: controls.map((control) => control.path) },
        );
    }

    const cacheControlTtls = assertClaudeCacheTtlOrder(controls);

    if (translationEnabled && hasMarkerDeep(body, definitions)) {
        throw new CachePolicyError(
            'Cache marker remained after cache policy transformation.',
            'CACHE_MARKER_REMAINING',
        );
    }

    return {
        cacheControlCount: controls.length,
        markerRemaining: hasMarkerDeep(body, definitions),
        cacheControlPaths: controls.map((control) => control.path),
        cacheControlTtls,
    };
}

function normalizeScope(scope, body, protocol) {
    const normalized = {
        channelId: String(scope?.channelId ?? 'default'),
        upstreamMode: String(scope?.upstreamMode ?? protocol),
        model: String(scope?.model ?? body?.model ?? ''),
        cacheTtl: String(scope?.cacheTtl ?? ''),
    };

    return {
        value: normalized,
        key: canonicalStringify(normalized),
        hash: hashCanonical(normalized),
    };
}

function cloneAnchor(anchor) {
    return {
        prefixHash: anchor.prefixHash,
        logicalIndex: anchor.logicalIndex,
        ...(anchor.contentPrefixHash ? { contentPrefixHash: anchor.contentPrefixHash } : {}),
        ...(anchor.markerHistoryHash ? { markerHistoryHash: anchor.markerHistoryHash } : {}),
        ...(anchor.markerKinds ? { markerKinds: [...anchor.markerKinds] } : {}),
        ...(anchor.blockHash ? { blockHash: anchor.blockHash } : {}),
    };
}

function snapshotInteger(value, field, { minimum = 0, fallback = null } = {}) {
    const number = Number(value);

    if (Number.isInteger(number) && number >= minimum) {
        return number;
    }

    if (fallback !== null) {
        return fallback;
    }

    throw new TypeError(`${field} must be an integer greater than or equal to ${minimum}.`);
}

function normalizeAnchorSnapshot(value, field = 'anchor') {
    if (!isObject(value) || typeof value.prefixHash !== 'string' || value.prefixHash.length === 0) {
        throw new TypeError(`${field}.prefixHash must be a non-empty string.`);
    }

    const markerKinds = value.markerKinds === undefined
        ? undefined
        : (Array.isArray(value.markerKinds)
            ? value.markerKinds.map((kind) => String(kind))
            : null);

    if (markerKinds === null) {
        throw new TypeError(`${field}.markerKinds must be an array when provided.`);
    }

    return cloneAnchor({
        prefixHash: value.prefixHash,
        logicalIndex: snapshotInteger(value.logicalIndex, `${field}.logicalIndex`),
        contentPrefixHash: typeof value.contentPrefixHash === 'string' ? value.contentPrefixHash : null,
        markerHistoryHash: typeof value.markerHistoryHash === 'string' ? value.markerHistoryHash : null,
        markerKinds,
        blockHash: typeof value.blockHash === 'string' ? value.blockHash : null,
    });
}

export class AnchorStore {
    constructor(options = {}) {
        const maxContexts = Number(options.maxContexts ?? 32);

        if (!Number.isInteger(maxContexts) || maxContexts < 1) {
            throw new TypeError('maxContexts must be a positive integer.');
        }

        this.maxContexts = maxContexts;
        this.contexts = new Map();
        this.generation = 0;
        this.planSequence = 0;
        this.commitSequence = 0;
        this.nextContextId = 1;
        this.lastAction = 'idle';
        this.lastPauseReason = null;
        this.lastReason = null;
        this.lastUpdatedAt = null;
    }

    clear(reason = 'manual-clear') {
        this.contexts.clear();
        this.generation++;
        this.lastAction = 'cleared';
        this.lastPauseReason = null;
        this.lastReason = reason || 'manual-clear';
        this.lastUpdatedAt = new Date().toISOString();
    }

    getStats() {
        let activeAnchorCount = 0;

        for (const context of this.contexts.values()) {
            activeAnchorCount += context.anchors.length;
        }

        const protectedLastAnchorCount = [...this.contexts.values()]
            .filter((context) => context.initialLastAnchor?.prefixHash)
            .length;

        return {
            generation: this.generation,
            contextCount: this.contexts.size,
            activeAnchorCount,
            protectedLastAnchorCount,
            pendingEvictionAnchorCount: 0,
            retiringAnchorCount: 0,
            maxContexts: this.maxContexts,
            lastAction: this.lastAction,
            lastPauseReason: this.lastPauseReason,
            lastReason: this.lastReason,
            lastUpdatedAt: this.lastUpdatedAt,
        };
    }

    exportState() {
        return {
            schemaVersion: ANCHOR_STORE_STATE_VERSION,
            maxContexts: this.maxContexts,
            generation: this.generation,
            planSequence: this.planSequence,
            commitSequence: this.commitSequence,
            nextContextId: this.nextContextId,
            lastAction: this.lastAction,
            lastPauseReason: this.lastPauseReason,
            lastReason: this.lastReason,
            lastUpdatedAt: this.lastUpdatedAt,
            contexts: [...this.contexts.values()].map((context) => ({
                id: context.id,
                scopeKey: context.scopeKey,
                scopeHash: context.scopeHash,
                anchorMode: context.anchorMode,
                anchors: context.anchors.map(cloneAnchor),
                initialLastAnchor: context.initialLastAnchor
                    ? cloneAnchor(context.initialLastAnchor)
                    : null,
                frontierDepth: context.frontierDepth,
                version: context.version,
                lastPlanSequence: context.lastPlanSequence,
                lastUsedOrder: context.lastUsedOrder,
            })),
        };
    }

    restoreState(snapshot) {
        if (!isObject(snapshot) || Number(snapshot.schemaVersion) !== ANCHOR_STORE_STATE_VERSION) {
            throw new TypeError(`AnchorStore snapshot schemaVersion must be ${ANCHOR_STORE_STATE_VERSION}.`);
        }

        const maxContexts = snapshotInteger(snapshot.maxContexts, 'maxContexts', { minimum: 1 });
        const rawContexts = Array.isArray(snapshot.contexts) ? snapshot.contexts : null;

        if (!rawContexts) {
            throw new TypeError('AnchorStore snapshot contexts must be an array.');
        }

        const contexts = new Map();
        for (const [index, raw] of rawContexts.entries()) {
            if (!isObject(raw) || typeof raw.id !== 'string' || raw.id.length === 0) {
                throw new TypeError(`contexts[${index}].id must be a non-empty string.`);
            }
            if (contexts.has(raw.id)) {
                throw new TypeError(`Duplicate AnchorStore context id: ${raw.id}.`);
            }
            if (typeof raw.scopeKey !== 'string' || typeof raw.scopeHash !== 'string') {
                throw new TypeError(`contexts[${index}] must include string scopeKey and scopeHash values.`);
            }
            if (!['single', 'rolling'].includes(raw.anchorMode)) {
                throw new TypeError(`contexts[${index}].anchorMode must be single or rolling.`);
            }
            if (!Array.isArray(raw.anchors)) {
                throw new TypeError(`contexts[${index}].anchors must be an array.`);
            }

            const context = {
                id: raw.id,
                scopeKey: raw.scopeKey,
                scopeHash: raw.scopeHash,
                anchorMode: raw.anchorMode,
                anchors: raw.anchors.map((anchor, anchorIndex) => (
                    normalizeAnchorSnapshot(anchor, `contexts[${index}].anchors[${anchorIndex}]`)
                )),
                initialLastAnchor: raw.initialLastAnchor
                    ? normalizeAnchorSnapshot(raw.initialLastAnchor, `contexts[${index}].initialLastAnchor`)
                    : null,
                frontierDepth: snapshotInteger(raw.frontierDepth, `contexts[${index}].frontierDepth`),
                version: snapshotInteger(raw.version, `contexts[${index}].version`, { minimum: 1 }),
                lastPlanSequence: snapshotInteger(raw.lastPlanSequence, `contexts[${index}].lastPlanSequence`),
                lastUsedOrder: snapshotInteger(raw.lastUsedOrder, `contexts[${index}].lastUsedOrder`),
            };
            contexts.set(context.id, context);
        }

        const keptContexts = [...contexts.values()]
            .sort((left, right) => left.lastUsedOrder - right.lastUsedOrder)
            .slice(-maxContexts);

        this.maxContexts = maxContexts;
        this.contexts = new Map(keptContexts.map((context) => [context.id, context]));
        this.generation = snapshotInteger(snapshot.generation, 'generation');
        this.planSequence = snapshotInteger(snapshot.planSequence, 'planSequence');
        this.commitSequence = Math.max(
            snapshotInteger(snapshot.commitSequence, 'commitSequence'),
            ...keptContexts.map((context) => context.lastUsedOrder),
            0,
        );
        this.nextContextId = snapshotInteger(snapshot.nextContextId, 'nextContextId', { minimum: 1 });
        this.lastAction = typeof snapshot.lastAction === 'string' ? snapshot.lastAction : 'idle';
        this.lastPauseReason = snapshot.lastPauseReason === null || typeof snapshot.lastPauseReason === 'string'
            ? snapshot.lastPauseReason
            : null;
        this.lastReason = snapshot.lastReason === null || typeof snapshot.lastReason === 'string'
            ? snapshot.lastReason
            : null;
        this.lastUpdatedAt = snapshot.lastUpdatedAt === null || typeof snapshot.lastUpdatedAt === 'string'
            ? snapshot.lastUpdatedAt
            : null;
        return true;
    }

    _nextPlanSequence() {
        this.planSequence++;
        return this.planSequence;
    }

    _findMatch(scopeKey, anchorMode, candidates) {
        const candidateByHash = new Map(candidates.map((candidate) => [candidate.prefixHash, candidate]));
        const candidateByContentPrefix = new Map(candidates
            .filter((candidate) => candidate.contentPrefixHash && candidate.markerHistoryHash)
            .map((candidate) => [
                `${candidate.contentPrefixHash}:${candidate.markerHistoryHash}`,
                candidate,
            ]));
        let best = null;

        for (const context of this.contexts.values()) {
            if (context.scopeKey !== scopeKey || context.anchorMode !== anchorMode) {
                continue;
            }

            const matched = [];

            for (const anchor of context.anchors) {
                let candidate = candidateByHash.get(anchor.prefixHash);

                // Rolling mode gets a narrow compatibility fallback for a
                // structurally equivalent boundary whose full prefix hash
                // changed only because message/container paths were rebuilt.
                // Marker history and the semantic content prefix must still
                // be identical, so ordinary prompt/schema changes remain
                // invalidating.
                if (!candidate
                    && anchorMode === 'rolling'
                    && anchor.contentPrefixHash
                    && anchor.markerHistoryHash) {
                    candidate = candidateByContentPrefix.get(
                        `${anchor.contentPrefixHash}:${anchor.markerHistoryHash}`,
                    );
                    if (candidate
                        && Array.isArray(anchor.markerKinds)
                        && JSON.stringify(anchor.markerKinds) !== JSON.stringify(candidate.markerKinds)) {
                        candidate = null;
                    }
                }

                if (!candidate) {
                    break;
                }

                matched.push({ anchor, candidate });
            }

            if (matched.length === 0) {
                continue;
            }

            const depth = matched[matched.length - 1].candidate.logicalIndex;

            if (!best
                || depth > best.depth
                || (depth === best.depth && context.lastUsedOrder > best.context.lastUsedOrder)) {
                best = { context, matched, depth };
            }
        }

        return best;
    }

    _commit(statePlan) {
        if (!statePlan || statePlan.store !== this || statePlan.operation === 'none') {
            return false;
        }

        if (statePlan.generation !== this.generation) {
            return false;
        }

        if (statePlan.operation === 'status') {
            this.lastAction = statePlan.action;
            this.lastPauseReason = statePlan.pauseReason || null;
            this.lastReason = statePlan.reason || statePlan.pauseReason || null;
            this.lastUpdatedAt = new Date().toISOString();
            return true;
        }

        let context = statePlan.contextId ? this.contexts.get(statePlan.contextId) : null;

        if (statePlan.contextId) {
            if (!context) {
                return false;
            }

            if (context.version !== statePlan.baseVersion) {
                const baseStillCurrent = canonicalStringify(context.anchors) === canonicalStringify(statePlan.baseAnchors);
                const strictlyExtendsFrontier = statePlan.nextContext.frontierDepth > context.frontierDepth;

                if (!baseStillCurrent || !strictlyExtendsFrontier) {
                    return false;
                }
            } else if (context.lastPlanSequence >= statePlan.planSequence) {
                return false;
            }
        } else {
            const observedHashes = new Set(statePlan.observedCandidateHashes);
            const compatibleAncestors = [...this.contexts.values()].filter((item) => (
                item.scopeKey === statePlan.scopeKey
                && item.anchorMode === statePlan.anchorMode
                && item.anchors.length > 0
                && item.anchors.every((anchor) => observedHashes.has(anchor.prefixHash))
            ));

            // A context committed after this cold plan was built already owns
            // the same append-only prefix. Creating another context here would
            // replace the entire frozen queue on the next match. Partial overlap
            // is deliberately allowed because it represents a real prefix fork.
            if (compatibleAncestors.length > 0) {
                return false;
            }
        }

        const nextContext = {
            id: context?.id || `ctx-${this.nextContextId++}`,
            scopeKey: statePlan.scopeKey,
            scopeHash: statePlan.scopeHash,
            anchorMode: statePlan.anchorMode,
            anchors: statePlan.nextContext.anchors.map(cloneAnchor),
            initialLastAnchor: statePlan.nextContext.initialLastAnchor
                ? cloneAnchor(statePlan.nextContext.initialLastAnchor)
                : context?.initialLastAnchor
                    ? cloneAnchor(context.initialLastAnchor)
                    : null,
            frontierDepth: statePlan.nextContext.frontierDepth,
            version: (context?.version || 0) + 1,
            lastPlanSequence: Math.max(context?.lastPlanSequence || 0, statePlan.planSequence),
            lastUsedOrder: ++this.commitSequence,
        };

        this.contexts.set(nextContext.id, nextContext);
        this.lastAction = statePlan.action;
        this.lastPauseReason = statePlan.pauseReason || null;
        this.lastReason = statePlan.reason || statePlan.pauseReason || null;
        this.lastUpdatedAt = new Date().toISOString();

        while (this.contexts.size > this.maxContexts) {
            const oldest = [...this.contexts.values()]
                .sort((left, right) => left.lastUsedOrder - right.lastUsedOrder)[0];
            this.contexts.delete(oldest.id);
        }

        return true;
    }
}

function candidateForAnchor(anchor, candidateByHash) {
    return candidateByHash.get(anchor.prefixHash) || null;
}

function buildAnchorDecision({
    store,
    scopeInfo,
    candidates,
    eligibleCandidates = candidates,
    policy,
    maxAnchorCount,
    callerOwnedTargets,
}) {
    const mode = policy.cacheAnchorMode;

    if (mode === 'off') {
        return {
            action: 'off',
            required: [],
            active: [],
            nextAnchors: [],
            pendingEviction: null,
            matchedContext: null,
            resetReason: null,
            canPersist: false,
            protectedLastAnchor: null,
        };
    }

    if (!(store instanceof AnchorStore)) {
        throw new CachePolicyError(
            'An AnchorStore is required when cacheAnchorMode is enabled.',
            'ANCHOR_STORE_REQUIRED',
        );
    }

    if (candidates.length === 0) {
        return {
            action: 'no-candidates',
            required: [],
            active: [],
            nextAnchors: [],
            pendingEviction: null,
            matchedContext: null,
            resetReason: null,
            canPersist: false,
            protectedLastAnchor: null,
        };
    }

    const match = store._findMatch(scopeInfo.key, mode, candidates);

    if (!match) {
        return {
            action: 'learn',
            required: [],
            active: [],
            nextAnchors: [],
            pendingEviction: null,
            matchedContext: null,
            resetReason: null,
            canPersist: false,
            needsSeed: true,
            protectedLastAnchor: null,
        };
    }

    const matchedAnchors = match.matched.map(({ anchor, candidate }) => ({
        anchor: cloneAnchor(anchor),
        candidate,
    }));
    const resetReason = matchedAnchors.length < match.context.anchors.length ? 'deeper-anchor-mismatch' : null;
    const protectedLastAnchor = match.context.initialLastAnchor
        ? cloneAnchor(match.context.initialLastAnchor)
        : matchedAnchors.at(-1)?.anchor || null;

    if (mode === 'single') {
        const current = matchedAnchors[matchedAnchors.length - 1];
        return {
            action: resetReason ? 'reset' : 'match',
            required: [{ candidate: current.candidate, reason: 'active-anchor' }],
            active: [current],
            nextAnchors: [current.anchor],
            pendingEviction: null,
            matchedContext: match.context,
            resetReason,
            canPersist: true,
            protectedLastAnchor,
        };
    }

    const callerOwnedMatched = matchedAnchors
        .filter((item) => callerOwnedTargets.has(item.candidate.target));
    const activeAnchors = matchedAnchors
        .filter((item) => !callerOwnedTargets.has(item.candidate.target));
    const capacityEvictions = [];

    while (activeAnchors.length > maxAnchorCount) {
        capacityEvictions.push(activeAnchors.shift());
    }

    const rollingResetReason = resetReason
        || (callerOwnedMatched.length > 0 ? 'caller-control-reserved' : null)
        || (capacityEvictions.length > 0 ? 'anchor-capacity-reduced' : null);

    if (activeAnchors.length === 0) {
        return {
            action: 'reset',
            required: [],
            active: [],
            nextAnchors: [],
            pendingEviction: null,
            matchedContext: match.context,
            resetReason: rollingResetReason,
            canPersist: false,
            needsSeed: true,
            protectedLastAnchor,
        };
    }

    const current = activeAnchors[activeAnchors.length - 1];
    const promotion = eligibleCandidates.find((candidate) => (
        !callerOwnedTargets.has(candidate.target)
        && candidate.logicalIndex > current.candidate.logicalIndex
        && candidate.logicalIndex - current.candidate.logicalIndex >= policy.cacheAnchorIntervalBlocks
    ));

    if (!promotion) {
        return {
            action: rollingResetReason ? 'reset' : 'match',
            required: activeAnchors.map((item) => ({ candidate: item.candidate, reason: 'active-anchor' })),
            active: activeAnchors,
            nextAnchors: activeAnchors.map((item) => item.anchor),
            pendingEviction: capacityEvictions[0] || null,
            matchedContext: match.context,
            resetReason: rollingResetReason,
            canPersist: true,
            protectedLastAnchor,
        };
    }

    const combined = [
        ...activeAnchors.map((item) => ({ ...item, reason: 'active-anchor' })),
        {
            anchor: {
                prefixHash: promotion.prefixHash,
                logicalIndex: promotion.logicalIndex,
                contentPrefixHash: promotion.contentPrefixHash,
                markerHistoryHash: promotion.markerHistoryHash,
                markerKinds: promotion.markerKinds,
                blockHash: promotion.blockHash,
            },
            candidate: promotion,
            reason: 'promoted-anchor',
        },
    ];
    // A full rolling queue makes room before selecting the new boundary, so a
    // promotion changes only its oldest slot instead of moving every tail slot.
    const promotedEviction = combined.length > maxAnchorCount ? combined.shift() : null;
    const pendingEviction = capacityEvictions[0] || promotedEviction;

    if (pendingEviction) {
        pendingEviction.reason = 'pending-eviction';
    }

    return {
        action: 'promote',
        required: combined.map((item) => ({ candidate: item.candidate, reason: item.reason })),
        active: activeAnchors,
        nextAnchors: combined.map((item) => item.anchor),
        pendingEviction,
        matchedContext: match.context,
        resetReason: rollingResetReason,
        canPersist: true,
        protectedLastAnchor,
    };
}

function uniqueNewTargets(items, selectedTargets) {
    const seen = new Set(selectedTargets);
    let count = 0;

    for (const item of items) {
        const candidate = item.candidate || item;

        if (!seen.has(candidate.target)) {
            seen.add(candidate.target);
            count++;
        }
    }

    return count;
}

function makeStatePlan({ store, scopeInfo, candidates, decision, selectedTargets, pauseReason }) {
    if (!(store instanceof AnchorStore) || decision.action === 'off' || decision.action === 'no-candidates') {
        return {
            store,
            operation: 'none',
            generation: store?.generation ?? 0,
            action: decision.action,
            pauseReason,
        };
    }

    const requiredSelected = decision.required.every((item) => selectedTargets.has(item.candidate.target));
    const matched = decision.matchedContext;
    let operation = 'none';
    let nextAnchors = decision.nextAnchors;
    let action = decision.action;

    if (decision.canPersist && requiredSelected && nextAnchors.length > 0) {
        if (!matched) {
            operation = 'create';
        } else {
            const changed = canonicalStringify(matched.anchors) !== canonicalStringify(nextAnchors);
            operation = changed ? 'update' : 'touch';
        }
    } else if (matched) {
        operation = 'touch';
        nextAnchors = matched.anchors.map(cloneAnchor);
        action = pauseReason ? 'rotation-paused' : 'match';
    } else if (pauseReason) {
        operation = 'status';
        action = 'rotation-paused';
    }

    const frontierDepth = nextAnchors.length > 0 ? nextAnchors[nextAnchors.length - 1].logicalIndex : 0;
    const protectedStillActive = decision.protectedLastAnchor
        && nextAnchors.some((anchor) => (
            anchor.prefixHash === decision.protectedLastAnchor.prefixHash
            || (anchor.blockHash && anchor.blockHash === decision.protectedLastAnchor.blockHash)
        ));
    const nextProtectedLastAnchor = protectedStillActive
        ? cloneAnchor(decision.protectedLastAnchor)
        : (nextAnchors.length > 0 ? cloneAnchor(nextAnchors[nextAnchors.length - 1]) : null);

    return {
        store,
        operation,
        generation: store.generation,
        planSequence: store._nextPlanSequence(),
        contextId: matched?.id || null,
        baseVersion: matched?.version || 0,
        baseAnchors: matched?.anchors.map(cloneAnchor) || [],
        scopeKey: scopeInfo.key,
        scopeHash: scopeInfo.hash,
        anchorMode: decision.matchedContext?.anchorMode || null,
        observedCandidateHashes: candidates.map((candidate) => candidate.prefixHash),
        nextContext: {
            anchors: nextAnchors.map(cloneAnchor),
            initialLastAnchor: nextProtectedLastAnchor,
            frontierDepth,
        },
        action,
        pauseReason,
        reason: pauseReason || decision.resetReason || null,
    };
}

function publicStatePlan(statePlan, mode) {
    return {
        operation: statePlan.operation,
        generation: statePlan.generation,
        planSequence: statePlan.planSequence ?? null,
        contextId: statePlan.contextId ?? null,
        baseVersion: statePlan.baseVersion ?? null,
        scopeHash: statePlan.scopeHash ?? null,
        anchorMode: mode,
        nextAnchors: statePlan.nextContext?.anchors.map((anchor) => ({
            prefixHash: anchor.prefixHash,
            logicalIndex: anchor.logicalIndex,
        })) || [],
        initialLastAnchor: statePlan.nextContext?.initialLastAnchor
            ? {
                prefixHash: statePlan.nextContext.initialLastAnchor.prefixHash,
                logicalIndex: statePlan.nextContext.initialLastAnchor.logicalIndex,
            }
            : null,
        action: statePlan.action,
        pauseReason: statePlan.pauseReason || null,
    };
}

function resolveCacheControl(cacheControl) {
    const value = typeof cacheControl === 'function' ? cacheControl() : cacheControl;
    return cloneJson(value ?? { type: 'ephemeral' });
}

function normalizeCacheControlSemantics(cacheControl) {
    const normalized = cloneJson(cacheControl);

    if (!isPromptCacheControlValue(normalized)) {
        return normalized;
    }

    const effectiveTtl = getEffectiveClaudeCacheTtl(normalized);

    if (effectiveTtl !== null) {
        normalized.ttl = effectiveTtl;
    }

    return normalized;
}

function cacheControlsSemanticallyEqual(left, right) {
    return canonicalStringify(normalizeCacheControlSemantics(left))
        === canonicalStringify(normalizeCacheControlSemantics(right));
}

function resolveCandidateCacheControl(candidate, options) {
    if (typeof options.cacheControlForCandidate !== 'function') {
        return resolveCacheControl(options.cacheControl);
    }

    const resolved = candidate.markerKinds.map((markerKind) => ({
        markerKind,
        value: resolveCacheControl(() => options.cacheControlForCandidate(candidate, markerKind)),
    }));
    const firstResolved = resolved[0]?.value;
    const hasConflict = resolved.some((item) => !cacheControlsSemanticallyEqual(item.value, firstResolved));

    if (hasConflict) {
        throw new CachePolicyError(
            `Cache boundary at ${candidate.path} contains marker kinds that resolve to different cache_control values. Use only one marker kind at a boundary.`,
            'CACHE_MARKER_KIND_CONFLICT',
            {
                path: candidate.path,
                markerKinds: [...candidate.markerKinds],
                resolvedCacheControls: resolved,
            },
        );
    }

    return resolved[0]?.value ?? resolveCacheControl(options.cacheControl);
}

function applyLastAnchorShortTtl({
    enabled,
    body,
    candidates,
    selectedTargets,
    callerOwnedTargets,
    candidateCacheControls,
}) {
    const diagnostics = {
        enabled: Boolean(enabled),
        applied: false,
        path: null,
        from: null,
        to: null,
        reason: enabled ? 'no-anchor' : 'disabled',
    };

    if (!enabled) {
        return diagnostics;
    }

    const gatewayPoints = candidates
        .filter((candidate) => (
            selectedTargets.has(candidate.target) && !callerOwnedTargets.has(candidate.target)
        ))
        .sort((left, right) => left.order - right.order);
    const lastAnchor = gatewayPoints.at(-1);

    if (!lastAnchor) {
        diagnostics.reason = 'no-gateway-cache-point';
        return diagnostics;
    }

    const currentControl = candidateCacheControls.get(lastAnchor.target)
        || lastAnchor.target?.cache_control;
    const currentTtl = getEffectiveClaudeCacheTtl(currentControl || {});

    if (currentTtl !== '1h') {
        diagnostics.reason = currentTtl === '5m' ? 'already-5m' : 'not-1h';
        diagnostics.path = `${lastAnchor.path}.cache_control`;
        return diagnostics;
    }

    const controls = collectCacheControls(body || {}).controls;
    const selectedControlIndex = controls.findIndex((control) => control.target === lastAnchor.target);
    const laterOneHour = selectedControlIndex >= 0 && controls
        .slice(selectedControlIndex + 1)
        .some((control) => getEffectiveClaudeCacheTtl(control.value) === '1h');

    if (laterOneHour) {
        const laterCallerOneHour = controls
            .slice(selectedControlIndex + 1)
            .some((control) => (
                callerOwnedTargets.has(control.target)
                && getEffectiveClaudeCacheTtl(control.value) === '1h'
            ));
        diagnostics.reason = laterCallerOneHour ? 'caller-later-1h' : 'ttl-order';
        diagnostics.path = `${lastAnchor.path}.cache_control`;
        return diagnostics;
    }

    const nextControl = {
        ...cloneJson(currentControl),
        ttl: '5m',
    };
    lastAnchor.target.cache_control = nextControl;
    candidateCacheControls.set(lastAnchor.target, nextControl);
    diagnostics.applied = true;
    diagnostics.path = `${lastAnchor.path}.cache_control`;
    diagnostics.from = '1h';
    diagnostics.to = '5m';
    diagnostics.reason = 'last-anchor-converted';
    return diagnostics;
}

function semanticCachePathRank(path) {
    if (path.startsWith('tools[') || path.startsWith('functions[')) {
        return 0;
    }

    if (path === 'system.cache_control' || path.startsWith('system[')) {
        return 1;
    }

    if (path.startsWith('messages[')) {
        return 2;
    }

    return 3;
}

function sortBreakpointDiagnostics(items) {
    return items.sort((left, right) => semanticCachePathRank(left.path) - semanticCachePathRank(right.path));
}

function disabledPlan(body, protocol, policy, marker, shortMarker, maxBreakpoints) {
    const nextBody = cloneJson(body);
    const assertion = assertCachePlan(nextBody, {
        marker,
        shortMarker,
        maxBreakpoints,
        translationEnabled: false,
    });
    const plan = {
        body: nextBody,
        diagnostics: {
            disabled: true,
            protocol,
            policy,
            processingOrder: [...policy.cachePolicyProcessingOrder],
            processingStages: [],
            existingBreakpoints: assertion.cacheControlCount,
            injected: 0,
            selectedBreakpoints: sortBreakpointDiagnostics(assertion.cacheControlPaths.map((path) => ({
                path,
                selected: true,
                action: 'existing-control',
                reason: 'existing-control',
                reasons: ['existing-control'],
                source: 'existing-control',
                prefixHash: null,
                contextHash: null,
            }))),
            selectedBreakpointCount: assertion.cacheControlCount,
            removed: 0,
            overflowRemoved: 0,
            changedMessages: 0,
            modifiedMessages: [],
            candidates: [],
            existingControls: assertion.cacheControlPaths,
            cacheControlCount: assertion.cacheControlCount,
            markerRemaining: assertion.markerRemaining,
            anchorAction: 'disabled',
            action: 'disabled',
            pauseReason: null,
            reason: null,
            contextHash: null,
        },
        statePlan: {
            operation: 'none',
            action: 'disabled',
            pauseReason: null,
        },
        _statePlan: null,
        _commitAttempted: false,
    };
    plan.commit = (success = true) => commitCachePlan(plan, success);
    return plan;
}

export function planCacheBreaks(body, options = {}) {
    if (!isObject(body)) {
        throw new CachePolicyError('Request body must be a JSON object.', 'INVALID_REQUEST_BODY');
    }

    const protocol = normalizeProtocol(options.protocol);
    const policy = normalizeCachePolicy({
        ...(options.policy || {}),
        ...(options.cachePolicyProcessingOrder === undefined
            ? {}
            : { cachePolicyProcessingOrder: options.cachePolicyProcessingOrder }),
    });
    const enhancements = normalizeCacheEnhancements({
        ...(options.policy || {}),
        ...options,
    }, { allowEvaluationOverflow: true });
    const marker = options.marker ?? MARKER;
    const shortMarker = options.shortMarker ?? SHORT_MARKER;
    const definitions = markerDefinitions(marker, shortMarker);
    const maxBreakpoints = options.maxBreakpoints ?? MAX_BREAKPOINTS;
    const enabled = options.enabled !== false;

    if (!enabled) {
        return disabledPlan(body, protocol, policy, marker, shortMarker, maxBreakpoints);
    }

    // Validate the caller-owned controls before marker normalization can remove
    // an otherwise empty marker carrier.
    assertCachePlan(body, {
        marker,
        shortMarker,
        maxBreakpoints,
        translationEnabled: false,
    });

    const normalization = normalizeMarkers(body, protocol, definitions);
    const candidates = finalizeCandidates(normalization, protocol);
    const existing = collectCacheControls(normalization.body);
    const candidateCacheControls = new Map();

    const requestedIgnoredAnchorCount = enhancements.ignoreLastAnchorCount;
    const ignoredTargets = new Set();

    if (existing.controls.length > maxBreakpoints) {
        assertCachePlan(normalization.body, {
            marker,
            shortMarker,
            maxBreakpoints,
            translationEnabled: false,
        });
    }

    const legacyMode = policy.fixedHeadBreakpointCount === 0 && policy.cacheAnchorMode === 'off';
    const selectedTargets = new Set(existing.controls.map((control) => control.target));
    const callerOwnedTargets = new Set(existing.controls.map((record) => record.target));
    const fixedTargets = new Set();
    const selectionReasons = new Map();
    const scopeInfo = normalizeScope(options.scope, normalization.body, protocol);
    const processingOrder = [...policy.cachePolicyProcessingOrder];
    const processingStages = [];
    let injected = 0;
    let pauseReason = null;
    let anchorStageExecuted = false;
    let protectedLastAnchorHeld = false;
    let protectedLastAnchorReleased = false;
    let lastAnchorTtlConversion = {
        enabled: Boolean(enhancements.autoConvertLastAnchorTo5m),
        applied: false,
        path: null,
        from: null,
        to: null,
        reason: enhancements.autoConvertLastAnchorTo5m ? 'not-processed' : 'disabled',
    };

    function availableCandidates() {
        return candidates.filter((candidate) => !ignoredTargets.has(candidate.target));
    }

    function getCandidateCacheControl(candidate) {
        if (!candidateCacheControls.has(candidate.target)) {
            candidateCacheControls.set(candidate.target, resolveCandidateCacheControl(candidate, options));
        }

        return candidateCacheControls.get(candidate.target);
    }

    function validateExistingCandidateControl(candidate) {
        const existingControl = existing.byTarget.get(candidate.target);

        if (!existingControl || typeof options.cacheControlForCandidate !== 'function') {
            return;
        }

        const expectedCacheControl = getCandidateCacheControl(candidate);

        if (!cacheControlsSemanticallyEqual(existingControl.value, expectedCacheControl)) {
            throw new CachePolicyError(
                `Caller cache_control at ${existingControl.path} conflicts with the cache marker at the same boundary.`,
                'CACHE_MARKER_EXISTING_CONTROL_CONFLICT',
                {
                    path: existingControl.path,
                    markerKinds: [...candidate.markerKinds],
                    existingCacheControl: existingControl.value,
                    expectedCacheControl,
                },
            );
        }
    }

    // Caller-owned cache controls are immutable and always precede every
    // configurable gateway stage.
    for (const candidate of candidates) {
        validateExistingCandidateControl(candidate);
    }

    function selectCandidate(candidate, reason) {
        if (ignoredTargets.has(candidate.target) && !existing.byTarget.has(candidate.target)) {
            return false;
        }

        if (!selectedTargets.has(candidate.target) && selectedTargets.size >= maxBreakpoints) {
            return false;
        }

        const expectedCacheControl = getCandidateCacheControl(candidate);
        const reasons = selectionReasons.get(candidate.target) || [];

        if (!reasons.includes(reason)) {
            reasons.push(reason);
        }

        selectionReasons.set(candidate.target, reasons);

        if (selectedTargets.has(candidate.target)) {
            return true;
        }

        candidate.target.cache_control = expectedCacheControl;
        selectedTargets.add(candidate.target);
        injected++;
        return true;
    }

    function candidateDiagnosticPath(candidate) {
        return `${candidate.path}.cache_control`;
    }

    function runProcessingStage(stage, index, callback) {
        const selectedBefore = new Set(selectedTargets);
        const ignoredBefore = new Set(ignoredTargets);
        const details = callback() || {};
        const selectedAdded = candidates
            .filter((candidate) => selectedTargets.has(candidate.target) && !selectedBefore.has(candidate.target))
            .map(candidateDiagnosticPath);
        const ignoredAdded = candidates
            .filter((candidate) => ignoredTargets.has(candidate.target) && !ignoredBefore.has(candidate.target))
            .map(candidateDiagnosticPath);
        const record = {
            stage,
            index,
            selectedBefore: selectedBefore.size,
            selectedAfter: selectedTargets.size,
            selectedAdded,
            ignoredAdded,
            ...details,
        };
        processingStages.push(record);
        return record;
    }

    let anchorDecision = {
        action: 'off',
        required: [],
        active: [],
        nextAnchors: [],
        pendingEviction: null,
        matchedContext: null,
        resetReason: null,
        canPersist: false,
        protectedLastAnchor: null,
    };

    const stageHandlers = {
        'fixed-head': () => {
            const fixedCandidates = candidates.slice(0, policy.fixedHeadBreakpointCount);
            const callerRequired = uniqueNewTargets(fixedCandidates, callerOwnedTargets);

            if (callerOwnedTargets.size + callerRequired > maxBreakpoints) {
                throw new CachePolicyError(
                    'Existing cache_control entries leave insufficient budget for the configured fixed head breakpoints.',
                    'FIXED_HEAD_BUDGET_CONFLICT',
                    {
                        existingBreakpoints: existing.controls.length,
                        fixedHeadBreakpointCount: policy.fixedHeadBreakpointCount,
                        requiredAdditionalBreakpoints: callerRequired,
                        maxBreakpoints,
                    },
                );
            }

            const blocked = [];
            const unavailable = [];
            for (const candidate of fixedCandidates) {
                if (selectCandidate(candidate, 'fixed-head')) {
                    fixedTargets.add(candidate.target);
                } else if (ignoredTargets.has(candidate.target)) {
                    blocked.push(candidateDiagnosticPath(candidate));
                } else {
                    unavailable.push(candidateDiagnosticPath(candidate));
                }
            }

            return {
                requested: fixedCandidates.length,
                protected: fixedCandidates.filter((candidate) => fixedTargets.has(candidate.target)).length,
                blocked,
                unavailable,
            };
        },
        'ignore-tail': () => {
            const ignoredStart = Math.max(0, candidates.length - requestedIgnoredAnchorCount);
            const requestedCandidates = candidates.slice(ignoredStart);
            const protectedPaths = [];

            for (const candidate of requestedCandidates) {
                if (selectedTargets.has(candidate.target)) {
                    protectedPaths.push(candidateDiagnosticPath(candidate));
                    continue;
                }
                ignoredTargets.add(candidate.target);
            }

            return {
                requested: requestedIgnoredAnchorCount,
                considered: requestedCandidates.length,
                effective: requestedCandidates.length - protectedPaths.length,
                protectedPaths,
            };
        },
        'cache-anchor': () => {
            anchorStageExecuted = true;
            const eligibleCandidates = availableCandidates();
            const reservedBreakpointCount = selectedTargets.size;
            anchorDecision = buildAnchorDecision({
                store: options.store,
                scopeInfo,
                candidates,
                eligibleCandidates,
                policy,
                maxAnchorCount: Math.max(0, maxBreakpoints - reservedBreakpointCount),
                callerOwnedTargets,
            });

            if (!anchorDecision.needsSeed) {
                let anchorItems = anchorDecision.required;
                const neededAnchors = uniqueNewTargets(anchorItems, selectedTargets);

                if (selectedTargets.size + neededAnchors > maxBreakpoints) {
                    pauseReason = anchorDecision.action === 'promote'
                        ? 'anchor-overlap-budget'
                        : 'anchor-budget-unavailable';
                    anchorItems = anchorDecision.active
                        .slice()
                        .reverse()
                        .map((item) => ({ candidate: item.candidate, reason: 'active-anchor' }));
                }

                for (const item of anchorItems) {
                    if (!selectCandidate(item.candidate, item.reason)) {
                        pauseReason ||= 'anchor-budget-unavailable';
                    }
                }
            }

            return {
                action: anchorDecision.action,
                needsSeed: Boolean(anchorDecision.needsSeed),
                pauseReason,
            };
        },
        'tail-fill': () => {
            const eligibleCandidates = availableCandidates();
            const shouldFill = legacyMode
                || policy.cacheAnchorMode !== 'rolling'
                || !anchorStageExecuted
                || anchorDecision.needsSeed;

            if (!shouldFill) {
                return { skippedReason: 'rolling-queue-frozen' };
            }

            const traversal = legacyMode ? eligibleCandidates : [...eligibleCandidates].reverse();
            for (const candidate of traversal) {
                if (selectedTargets.size >= maxBreakpoints) {
                    break;
                }
                if (selectedTargets.has(candidate.target)) {
                    continue;
                }
                const reason = existing.byTarget.has(candidate.target)
                    ? 'existing-control'
                    : (legacyMode ? 'legacy-head' : 'tail');
                selectCandidate(candidate, reason);
            }

            return { mode: legacyMode ? 'legacy-head' : 'tail' };
        },
        'protected-tail-anchor': () => {
            if (policy.cacheAnchorMode !== 'rolling' || !anchorDecision.protectedLastAnchor) {
                return { skippedReason: anchorStageExecuted ? 'no-protected-anchor' : 'anchor-stage-not-run' };
            }

            const protectedAnchor = anchorDecision.protectedLastAnchor;
            const protectedCandidate = candidates.find((candidate) => (
                candidate.prefixHash === protectedAnchor.prefixHash
                || (protectedAnchor.blockHash && candidate.blockHash === protectedAnchor.blockHash)
            ));
            const isPendingEviction = Boolean(
                anchorDecision.pendingEviction
                && (anchorDecision.pendingEviction.anchor?.prefixHash === protectedAnchor.prefixHash
                    || (anchorDecision.pendingEviction.anchor?.blockHash
                        && anchorDecision.pendingEviction.anchor.blockHash === protectedAnchor.blockHash)),
            );

            if (protectedCandidate && !isPendingEviction && !selectedTargets.has(protectedCandidate.target)) {
                protectedLastAnchorHeld = selectCandidate(protectedCandidate, 'active-anchor');
                if (!protectedLastAnchorHeld) {
                    pauseReason ||= ignoredTargets.has(protectedCandidate.target)
                        ? 'protected-last-anchor-ignored'
                        : 'protected-last-anchor-budget';
                }
            } else if (isPendingEviction) {
                protectedLastAnchorReleased = true;
            } else if (protectedCandidate && selectedTargets.has(protectedCandidate.target)) {
                protectedLastAnchorHeld = true;
            }

            return {
                held: protectedLastAnchorHeld,
                released: protectedLastAnchorReleased,
                pauseReason,
            };
        },
        'last-gateway-cache-point-5m': () => {
            lastAnchorTtlConversion = applyLastAnchorShortTtl({
                enabled: enhancements.autoConvertLastAnchorTo5m,
                body: normalization.body,
                candidates,
                selectedTargets,
                callerOwnedTargets,
                candidateCacheControls,
            });
            return { conversion: cloneJson(lastAnchorTtlConversion) };
        },
    };

    for (const [index, stage] of processingOrder.entries()) {
        runProcessingStage(stage, index, stageHandlers[stage]);
    }

    if (!legacyMode && anchorDecision.needsSeed) {
        const learnedCandidates = candidates.filter((candidate) => (
            selectedTargets.has(candidate.target) && !fixedTargets.has(candidate.target)
        ));
        const learned = policy.cacheAnchorMode === 'rolling'
            ? learnedCandidates.filter((candidate) => !callerOwnedTargets.has(candidate.target))
            : learnedCandidates.slice(0, 1);

        if (learned.length > 0) {
            for (const candidate of learned) {
                const currentReasons = selectionReasons.get(candidate.target) || [];
                selectionReasons.set(candidate.target, [
                    'learned-anchor',
                    ...currentReasons.filter((reason) => reason !== 'learned-anchor'),
                ]);
            }

            anchorDecision = {
                ...anchorDecision,
                required: learned.map((candidate) => ({ candidate, reason: 'learned-anchor' })),
                nextAnchors: learned.map((candidate) => ({
                    prefixHash: candidate.prefixHash,
                    logicalIndex: candidate.logicalIndex,
                    contentPrefixHash: candidate.contentPrefixHash,
                    markerHistoryHash: candidate.markerHistoryHash,
                    markerKinds: candidate.markerKinds,
                    blockHash: candidate.blockHash,
                })),
                protectedLastAnchor: learned.at(-1)
                    ? {
                        prefixHash: learned.at(-1).prefixHash,
                        logicalIndex: learned.at(-1).logicalIndex,
                        contentPrefixHash: learned.at(-1).contentPrefixHash,
                        markerHistoryHash: learned.at(-1).markerHistoryHash,
                        markerKinds: learned.at(-1).markerKinds,
                        blockHash: learned.at(-1).blockHash,
                    }
                    : null,
                canPersist: true,
                needsSeed: false,
            };
        } else {
            pauseReason = 'anchor-budget-unavailable';
        }

        const anchorStage = processingStages.find((stage) => stage.stage === 'cache-anchor');
        if (anchorStage) {
            anchorStage.action = anchorDecision.action;
            anchorStage.needsSeed = Boolean(anchorDecision.needsSeed);
            anchorStage.learnedPaths = learned.map(candidateDiagnosticPath);
            anchorStage.pauseReason = pauseReason;
        }
    }

    const statePlan = makeStatePlan({
        store: options.store,
        scopeInfo,
        candidates,
        decision: anchorDecision,
        selectedTargets,
        pauseReason,
    });

    if (statePlan.anchorMode === null) {
        statePlan.anchorMode = policy.cacheAnchorMode;
    }

    const assertion = assertCachePlan(normalization.body, {
        marker,
        shortMarker,
        maxBreakpoints,
        translationEnabled: true,
    });
    const candidateDiagnostics = candidates.map((candidate) => {
        const existingControl = existing.byTarget.has(candidate.target);
        const reasons = selectionReasons.get(candidate.target) || [];
        const selected = selectedTargets.has(candidate.target);

        if (selected && existingControl && !reasons.includes('existing-control')) {
            reasons.unshift('existing-control');
        }

        return {
            order: candidate.order,
            path: `${candidate.path}.cache_control`,
            logicalIndex: candidate.logicalIndex,
            prefixHash: candidate.prefixHash,
            contextHash: candidate.prefixHash.slice(0, 12),
            markerCount: candidate.markerCount,
            markerKinds: [...candidate.markerKinds],
            markerKindCounts: { ...candidate.markerKindCounts },
            blockHash: candidate.blockHash,
            contentPrefixHash: candidate.contentPrefixHash,
            markerHistoryHash: candidate.markerHistoryHash,
            markerKinds: [...candidate.markerKinds],
            ignored: ignoredTargets.has(candidate.target),
            sources: [...candidate.sources],
            selected,
            reason: reasons[0] || (ignoredTargets.has(candidate.target) ? 'ignored-tail' : 'overflow'),
            reasons: reasons.length > 0
                ? reasons
                : [ignoredTargets.has(candidate.target) ? 'ignored-tail' : 'overflow'],
            ttlOverride: lastAnchorTtlConversion.path === `${candidate.path}.cache_control`
                ? lastAnchorTtlConversion.to
                : null,
        };
    });
    const selectedMarkerCount = candidateDiagnostics
        .filter((candidate) => candidate.selected)
        .reduce((total, candidate) => total + candidate.markerCount, 0);
    const anchorTransitionSelected = anchorDecision.required
        .every((item) => selectedTargets.has(item.candidate.target));
    const anchorTransitionApplied = !pauseReason && anchorTransitionSelected;
    const plannedActiveAnchorCount = anchorTransitionApplied
        ? anchorDecision.nextAnchors.length
        : anchorDecision.matchedContext?.anchors.length || 0;
    const selectedCandidateByPath = new Map(candidateDiagnostics
        .filter((candidate) => candidate.selected)
        .map((candidate) => [candidate.path, candidate]));
    const selectedBreakpoints = assertion.cacheControlPaths.map((path) => {
        const candidate = selectedCandidateByPath.get(path);

        if (candidate) {
            return {
                path,
                selected: true,
                action: candidate.reason,
                reason: candidate.reason,
                reasons: [...candidate.reasons],
                source: 'marker',
                prefixHash: candidate.prefixHash,
                contextHash: candidate.contextHash,
                logicalIndex: candidate.logicalIndex,
                markerKinds: [...candidate.markerKinds],
                blockHash: candidate.blockHash,
                contentPrefixHash: candidate.contentPrefixHash,
                markerHistoryHash: candidate.markerHistoryHash,
                ignored: false,
                ttlOverride: candidateDiagnostics.find((item) => item.path === path)?.ttlOverride || null,
            };
        }

        return {
            path,
            selected: true,
            action: 'existing-control',
            reason: 'existing-control',
            reasons: ['existing-control'],
            source: 'existing-control',
            prefixHash: null,
            contextHash: null,
            logicalIndex: null,
            markerKinds: [],
        };
    });
    sortBreakpointDiagnostics(selectedBreakpoints);

    const pendingEvictionAnchor = anchorDecision.pendingEviction?.anchor || null;
    const protectedLastAnchor = statePlan.nextContext?.initialLastAnchor || null;
    const decisionProtectedLastAnchor = anchorDecision.protectedLastAnchor || protectedLastAnchor;
    const protectedLastAnchorPendingEviction = Boolean(
        pendingEvictionAnchor
        && decisionProtectedLastAnchor
        && (pendingEvictionAnchor.prefixHash === decisionProtectedLastAnchor.prefixHash
            || (pendingEvictionAnchor.blockHash
                && pendingEvictionAnchor.blockHash === decisionProtectedLastAnchor.blockHash)),
    );
    const diagnostics = {
        disabled: false,
        protocol,
        policy,
        processingOrder,
        processingStages,
        legacyMode,
        existingBreakpoints: existing.controls.length,
        injected,
        selectedBreakpoints,
        selectedBreakpointCount: assertion.cacheControlCount,
        removed: normalization.totalMarkers,
        overflowRemoved: Math.max(0, normalization.totalMarkers - selectedMarkerCount),
        changedMessages: normalization.changedGroups.size,
        modifiedMessages: [...normalization.changedGroups],
        removedEmptyMessages: normalization.removedEmptyMessages,
        unlandableMarkers: normalization.unlandableMarkers,
        candidates: candidateDiagnostics,
        existingControls: existing.controls.map((control) => control.path),
        cacheControlCount: assertion.cacheControlCount,
        markerRemaining: assertion.markerRemaining,
        anchorAction: pauseReason ? 'rotation-paused' : anchorDecision.action,
        action: pauseReason ? 'rotation-paused' : anchorDecision.action,
        pauseReason,
        reason: pauseReason || anchorDecision.resetReason || null,
        resetReason: anchorDecision.resetReason,
        contextHash: scopeInfo.hash.slice(0, 12),
        matchedContextId: anchorDecision.matchedContext?.id || null,
        activeAnchorCount: plannedActiveAnchorCount,
        pendingEvictionAnchorCount: anchorTransitionApplied && anchorDecision.pendingEviction ? 1 : 0,
        pendingEvictionAnchor: pendingEvictionAnchor
            ? {
                prefixHash: pendingEvictionAnchor.prefixHash,
                logicalIndex: pendingEvictionAnchor.logicalIndex,
                ...(pendingEvictionAnchor.blockHash ? { blockHash: pendingEvictionAnchor.blockHash } : {}),
            }
            : null,
        protectedLastAnchorPendingEviction,
        protectedLastAnchor: statePlan.nextContext?.initialLastAnchor
            ? {
                prefixHash: statePlan.nextContext.initialLastAnchor.prefixHash,
                logicalIndex: statePlan.nextContext.initialLastAnchor.logicalIndex,
                ...(statePlan.nextContext.initialLastAnchor.blockHash
                    ? { blockHash: statePlan.nextContext.initialLastAnchor.blockHash }
                    : {}),
            }
            : null,
        ignoredAnchorMode: enhancements.ignoreLastAnchorsMode,
        ignoredAnchorCount: requestedIgnoredAnchorCount,
        ignoredCandidateCount: [...ignoredTargets].length,
        ignoredCandidateLogicalIndexes: candidates
            .filter((candidate) => ignoredTargets.has(candidate.target))
            .map((candidate) => candidate.logicalIndex),
        lastAnchorTtlConversion,
        protectedLastAnchorHeld,
        protectedLastAnchorReleased,
    };
    const plan = {
        body: normalization.body,
        diagnostics,
        statePlan: publicStatePlan(statePlan, policy.cacheAnchorMode),
        _statePlan: statePlan,
        _commitAttempted: false,
    };
    plan.commit = (success = true) => commitCachePlan(plan, success);
    return plan;
}

export function commitCachePlan(plan, success = true) {
    if (!success || !plan || plan._commitAttempted) {
        return false;
    }

    plan._commitAttempted = true;
    const statePlan = plan._statePlan;

    if (!statePlan || !(statePlan.store instanceof AnchorStore)) {
        return false;
    }

    return statePlan.store._commit(statePlan);
}

export function countCacheControls(body) {
    return collectCacheControls(body).controls.length;
}
