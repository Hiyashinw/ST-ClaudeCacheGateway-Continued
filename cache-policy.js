import { createHash } from 'node:crypto';

export const MARKER = '[[CACHE_BREAK]]';
export const MAX_BREAKPOINTS = 4;
export const DEFAULT_CACHE_POLICY = Object.freeze({
    fixedHeadBreakpointCount: 0,
    cacheAnchorMode: 'off',
    cacheAnchorIntervalBlocks: 3,
});

const VALID_PROTOCOLS = new Set(['openai', 'anthropic']);
const VALID_ANCHOR_MODES = new Set(['off', 'single', 'rolling']);
const CACHE_CONTROL_KEY = 'cache_control';

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

function markerCount(text, marker = MARKER) {
    return typeof text === 'string' ? text.split(marker).length - 1 : 0;
}

function stripMarkers(text, marker = MARKER) {
    return typeof text === 'string' ? text.split(marker).join('') : text;
}

function isMarkerOnlyText(text, marker = MARKER) {
    return typeof text === 'string'
        && text.includes(marker)
        && stripMarkers(text, marker).trim() === '';
}

function countMarkersInContent(content, marker = MARKER) {
    if (typeof content === 'string') {
        return markerCount(content, marker);
    }

    if (!Array.isArray(content)) {
        return 0;
    }

    return content.reduce((total, block) => total + (isTextBlock(block) ? markerCount(block.text, marker) : 0), 0);
}

function isMarkerOnlyContent(content, marker = MARKER) {
    if (typeof content === 'string') {
        return isMarkerOnlyText(content, marker);
    }

    if (!Array.isArray(content) || content.length === 0) {
        return false;
    }

    return content.every((block) => isTextBlock(block) && stripMarkers(block.text, marker).trim() === '')
        && content.some((block) => block.text.includes(marker));
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

function normalizeFingerprintValue(value, marker = MARKER, path = []) {
    if (typeof value === 'string') {
        return stripMarkers(value, marker);
    }

    if (Array.isArray(value)) {
        return value.map((item, index) => normalizeFingerprintValue(item, marker, [...path, index]));
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

        output[key] = normalizeFingerprintValue(child, marker, [...path, key]);
    }

    return output;
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

    return {
        fixedHeadBreakpointCount,
        cacheAnchorMode,
        cacheAnchorIntervalBlocks,
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

function addMarkerCandidate(normalization, target, source, count = 1) {
    normalization.totalMarkers += count;

    if (!target || !isTextBlock(target) || target.text.trim() === '') {
        normalization.unlandableMarkers += count;
        return;
    }

    const current = normalization.candidateByTarget.get(target);

    if (current) {
        current.markerCount += count;

        if (!current.sources.includes(source)) {
            current.sources.push(source);
        }

        return;
    }

    const candidate = {
        target,
        markerCount: count,
        sources: [source],
    };
    normalization.candidateByTarget.set(target, candidate);
    normalization.rawCandidates.push(candidate);
}

function splitTextBlock(block, nextBlocks, normalization, source, marker = MARKER) {
    const count = markerCount(block.text, marker);

    if (count === 0) {
        nextBlocks.push(block);
        return false;
    }

    const parts = block.text.split(marker);
    const originalCacheControl = hasOwn(block, CACHE_CONTROL_KEY) ? cloneJson(block.cache_control) : undefined;
    const base = { ...block };
    delete base.text;
    delete base.cache_control;
    const emitted = [];

    for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        const hasMarkerAfter = index < parts.length - 1;
        let target = null;

        if (part !== '') {
            target = { ...base, type: 'text', text: part };
            nextBlocks.push(target);
            emitted.push(target);
        } else {
            const previous = nextBlocks[nextBlocks.length - 1];
            target = isTextBlock(previous) ? previous : null;
        }

        if (hasMarkerAfter) {
            addMarkerCandidate(normalization, target, source, 1);
        }
    }

    if (originalCacheControl !== undefined && emitted.length > 0) {
        emitted[emitted.length - 1].cache_control = originalCacheControl;
    }

    return true;
}

function normalizeContent(content, normalization, source, marker = MARKER) {
    if (typeof content === 'string') {
        if (!content.includes(marker)) {
            return { content, changed: false };
        }

        const nextBlocks = [];
        splitTextBlock({ type: 'text', text: content }, nextBlocks, normalization, source, marker);
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

    for (const block of content) {
        if (!isTextBlock(block) || !block.text.includes(marker)) {
            nextBlocks.push(block);
            continue;
        }

        changed = true;

        if (isMarkerOnlyText(block.text, marker)) {
            const previous = nextBlocks[nextBlocks.length - 1];
            addMarkerCandidate(
                normalization,
                isTextBlock(previous) ? previous : null,
                `${source}:standalone-block`,
                markerCount(block.text, marker),
            );
            continue;
        }

        splitTextBlock(block, nextBlocks, normalization, `${source}:inline`, marker);
    }

    return { content: nextBlocks, changed };
}

function ensureLastTextTarget(message) {
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

        if (isTextBlock(block) && block.text.trim() !== '') {
            return block;
        }
    }

    return null;
}

function findPreviousMessageTarget(messages, role) {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]?.role !== role) {
            continue;
        }

        const target = ensureLastTextTarget(messages[index]);

        if (target) {
            return target;
        }
    }

    return null;
}

function normalizeMarkers(body, protocol, marker = MARKER) {
    const normalization = {
        body: cloneJson(body),
        rawCandidates: [],
        candidateByTarget: new Map(),
        totalMarkers: 0,
        unlandableMarkers: 0,
        changedGroups: new Set(),
        removedEmptyMessages: 0,
    };
    const nextBody = normalization.body;

    if (protocol === 'anthropic' && hasOwn(nextBody, 'system')) {
        const result = normalizeContent(nextBody.system, normalization, 'system', marker);

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

        const count = countMarkersInContent(message.content, marker);

        if (count > 0 && isMarkerOnlyContent(message.content, marker)) {
            const target = findPreviousMessageTarget(messages, message.role);
            addMarkerCandidate(normalization, target, `messages[${index}]:standalone-message`, count);
            normalization.changedGroups.add(`messages[${index}]`);

            if (messageHasNonContentPayload(message)) {
                message.content = '';
                messages.push(message);
            } else {
                normalization.removedEmptyMessages++;
            }

            continue;
        }

        const result = normalizeContent(message.content, normalization, `messages[${index}].content`, marker);

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

function buildBodyMeta(body) {
    const meta = {};

    for (const [key, value] of Object.entries(body || {})) {
        if (!PROMPT_DEFINITION_KEYS.has(key)) {
            continue;
        }

        meta[key] = normalizeFingerprintValue(value, MARKER, [key]);
    }

    return meta;
}

function contentUnits(content, basePath, group, messageMeta = null, fingerprintPath = []) {
    if (typeof content === 'string') {
        return [{
            target: null,
            path: basePath,
            descriptor: { group, messageMeta, value: normalizeFingerprintValue(content, MARKER, fingerprintPath) },
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
            value: normalizeFingerprintValue(block, MARKER, [...fingerprintPath, index]),
        },
        logical: isTextBlock(block) ? block.text.trim() !== '' : block !== undefined && block !== null,
    }));
}

function enumeratePromptUnits(body, protocol) {
    const units = [];

    if (protocol === 'anthropic') {
        units.push(...contentUnits(body?.system, 'system', 'system', null, ['system']));
    }

    for (let index = 0; index < (Array.isArray(body?.messages) ? body.messages.length : 0); index++) {
        const message = body.messages[index];
        const messageMeta = normalizeFingerprintValue(
            isObject(message) ? Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'content')) : message,
            MARKER,
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
        ));
    }

    return units;
}

function finalizeCandidates(normalization, protocol) {
    const rawByTarget = normalization.candidateByTarget;
    const units = enumeratePromptUnits(normalization.body, protocol);
    const prefix = [];
    const candidates = [];
    const meta = buildBodyMeta(normalization.body);
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

        const prefixHash = hashCanonical({ meta, prefix });
        candidates.push({
            ...raw,
            order: candidates.length,
            path: unit.path,
            logicalIndex,
            prefixHash,
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

function hasMarkerDeep(value, marker = MARKER) {
    if (typeof value === 'string') {
        return value.includes(marker);
    }

    if (Array.isArray(value)) {
        return value.some((item) => hasMarkerDeep(item, marker));
    }

    if (!isObject(value)) {
        return false;
    }

    return Object.values(value).some((child) => hasMarkerDeep(child, marker));
}

export function assertCachePlan(body, options = {}) {
    const marker = options.marker ?? MARKER;
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

    if (translationEnabled && hasMarkerDeep(body, marker)) {
        throw new CachePolicyError(
            'Cache marker remained after cache policy transformation.',
            'CACHE_MARKER_REMAINING',
        );
    }

    return {
        cacheControlCount: controls.length,
        markerRemaining: hasMarkerDeep(body, marker),
        cacheControlPaths: controls.map((control) => control.path),
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
    };
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

        return {
            generation: this.generation,
            contextCount: this.contexts.size,
            activeAnchorCount,
            pendingEvictionAnchorCount: 0,
            retiringAnchorCount: 0,
            maxContexts: this.maxContexts,
            lastAction: this.lastAction,
            lastPauseReason: this.lastPauseReason,
            lastReason: this.lastReason,
            lastUpdatedAt: this.lastUpdatedAt,
        };
    }

    _nextPlanSequence() {
        this.planSequence++;
        return this.planSequence;
    }

    _findMatch(scopeKey, anchorMode, candidates) {
        const candidateByHash = new Map(candidates.map((candidate) => [candidate.prefixHash, candidate]));
        let best = null;

        for (const context of this.contexts.values()) {
            if (context.scopeKey !== scopeKey || context.anchorMode !== anchorMode) {
                continue;
            }

            const matched = [];

            for (const anchor of context.anchors) {
                const candidate = candidateByHash.get(anchor.prefixHash);

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
            const related = [...this.contexts.values()].filter((item) => (
                item.scopeKey === statePlan.scopeKey
                && item.anchorMode === statePlan.anchorMode
                && item.anchors.some((anchor) => observedHashes.has(anchor.prefixHash))
            ));
            const newestRelated = related.sort((left, right) => right.frontierDepth - left.frontierDepth)[0];

            if (newestRelated && newestRelated.frontierDepth >= statePlan.nextContext.frontierDepth) {
                return false;
            }
        }

        const nextContext = {
            id: context?.id || `ctx-${this.nextContextId++}`,
            scopeKey: statePlan.scopeKey,
            scopeHash: statePlan.scopeHash,
            anchorMode: statePlan.anchorMode,
            anchors: statePlan.nextContext.anchors.map(cloneAnchor),
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

function buildAnchorDecision({ store, scopeInfo, candidates, policy }) {
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
        };
    }

    const matchedAnchors = match.matched.map(({ anchor, candidate }) => ({
        anchor: cloneAnchor(anchor),
        candidate,
    }));
    const resetReason = matchedAnchors.length < match.context.anchors.length ? 'deeper-anchor-mismatch' : null;

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
        };
    }

    const current = matchedAnchors[matchedAnchors.length - 1];
    const promotion = candidates.find((candidate) => (
        candidate.logicalIndex > current.candidate.logicalIndex
        && candidate.logicalIndex - current.candidate.logicalIndex >= policy.cacheAnchorIntervalBlocks
    ));

    if (!promotion) {
        return {
            action: resetReason ? 'reset' : 'match',
            required: matchedAnchors.map((item) => ({ candidate: item.candidate, reason: 'active-anchor' })),
            active: matchedAnchors,
            nextAnchors: matchedAnchors.map((item) => item.anchor),
            pendingEviction: null,
            matchedContext: match.context,
            resetReason,
            canPersist: true,
        };
    }

    const combined = [
        ...matchedAnchors.map((item) => ({ ...item, reason: 'active-anchor' })),
        {
            anchor: { prefixHash: promotion.prefixHash, logicalIndex: promotion.logicalIndex },
            candidate: promotion,
            reason: 'promoted-anchor',
        },
    ];
    const pendingEviction = combined.length > 2 ? combined[0] : null;

    if (pendingEviction) {
        pendingEviction.reason = 'pending-eviction';
    }

    return {
        action: 'promote',
        required: combined.map((item) => ({ candidate: item.candidate, reason: item.reason })),
        active: matchedAnchors,
        nextAnchors: combined.slice(-2).map((item) => item.anchor),
        pendingEviction,
        matchedContext: match.context,
        resetReason,
        canPersist: true,
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
        action: statePlan.action,
        pauseReason: statePlan.pauseReason || null,
    };
}

function resolveCacheControl(cacheControl) {
    const value = typeof cacheControl === 'function' ? cacheControl() : cacheControl;
    return cloneJson(value ?? { type: 'ephemeral' });
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

function disabledPlan(body, protocol, policy, marker, maxBreakpoints) {
    const nextBody = cloneJson(body);
    const assertion = assertCachePlan(nextBody, {
        marker,
        maxBreakpoints,
        translationEnabled: false,
    });
    const plan = {
        body: nextBody,
        diagnostics: {
            disabled: true,
            protocol,
            policy,
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
    const policy = normalizeCachePolicy(options.policy);
    const marker = options.marker ?? MARKER;
    const maxBreakpoints = options.maxBreakpoints ?? MAX_BREAKPOINTS;
    const enabled = options.enabled !== false;

    if (!enabled) {
        return disabledPlan(body, protocol, policy, marker, maxBreakpoints);
    }

    // Validate the caller-owned controls before marker normalization can remove
    // an otherwise empty marker carrier.
    assertCachePlan(body, {
        marker,
        maxBreakpoints,
        translationEnabled: false,
    });

    const normalization = normalizeMarkers(body, protocol, marker);
    const candidates = finalizeCandidates(normalization, protocol);
    const existing = collectCacheControls(normalization.body);

    if (existing.controls.length > maxBreakpoints) {
        assertCachePlan(normalization.body, { marker, maxBreakpoints, translationEnabled: false });
    }

    const legacyMode = policy.fixedHeadBreakpointCount === 0 && policy.cacheAnchorMode === 'off';
    const selectedTargets = new Set(existing.controls.map((control) => control.target));
    const selectionReasons = new Map();
    const scopeInfo = normalizeScope(options.scope, normalization.body, protocol);
    let injected = 0;
    let pauseReason = null;

    function selectCandidate(candidate, reason) {
        if (!selectedTargets.has(candidate.target) && selectedTargets.size >= maxBreakpoints) {
            return false;
        }

        const reasons = selectionReasons.get(candidate.target) || [];

        if (!reasons.includes(reason)) {
            reasons.push(reason);
        }

        selectionReasons.set(candidate.target, reasons);

        if (selectedTargets.has(candidate.target)) {
            return true;
        }

        candidate.target.cache_control = resolveCacheControl(options.cacheControl);
        selectedTargets.add(candidate.target);
        injected++;
        return true;
    }

    if (legacyMode) {
        for (const candidate of candidates) {
            if (!selectCandidate(candidate, existing.byTarget.has(candidate.target) ? 'existing-control' : 'legacy-head')) {
                break;
            }
        }
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
    };

    if (!legacyMode) {
        const fixedCandidates = candidates.slice(0, policy.fixedHeadBreakpointCount);
        const neededFixed = uniqueNewTargets(fixedCandidates, selectedTargets);

        if (selectedTargets.size + neededFixed > maxBreakpoints) {
            throw new CachePolicyError(
                'Existing cache_control entries leave insufficient budget for the configured fixed head breakpoints.',
                'FIXED_HEAD_BUDGET_CONFLICT',
                {
                    existingBreakpoints: existing.controls.length,
                    fixedHeadBreakpointCount: policy.fixedHeadBreakpointCount,
                    requiredAdditionalBreakpoints: neededFixed,
                    maxBreakpoints,
                },
            );
        }

        for (const candidate of fixedCandidates) {
            selectCandidate(candidate, 'fixed-head');
        }

        anchorDecision = buildAnchorDecision({
            store: options.store,
            scopeInfo,
            candidates,
            policy,
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

        for (let index = candidates.length - 1; index >= 0 && selectedTargets.size < maxBreakpoints; index--) {
            selectCandidate(candidates[index], 'tail');
        }

        if (anchorDecision.needsSeed) {
            const fixedTargets = new Set(fixedCandidates.map((candidate) => candidate.target));
            const learned = candidates.find((candidate) => (
                selectedTargets.has(candidate.target) && !fixedTargets.has(candidate.target)
            ));

            if (learned) {
                const currentReasons = selectionReasons.get(learned.target) || [];
                selectionReasons.set(learned.target, [
                    'learned-anchor',
                    ...currentReasons.filter((reason) => reason !== 'learned-anchor'),
                ]);
                anchorDecision = {
                    ...anchorDecision,
                    required: [{ candidate: learned, reason: 'learned-anchor' }],
                    nextAnchors: [{ prefixHash: learned.prefixHash, logicalIndex: learned.logicalIndex }],
                    canPersist: true,
                    needsSeed: false,
                };
            } else {
                pauseReason = 'anchor-budget-unavailable';
            }
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
            sources: [...candidate.sources],
            selected,
            reason: reasons[0] || 'overflow',
            reasons: reasons.length > 0 ? reasons : ['overflow'],
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
        };
    });
    sortBreakpointDiagnostics(selectedBreakpoints);

    const diagnostics = {
        disabled: false,
        protocol,
        policy,
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
