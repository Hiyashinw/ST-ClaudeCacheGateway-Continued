import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AnchorStore,
    CachePolicyError,
    MARKER,
    SHORT_MARKER,
    assertCachePlan,
    canonicalStringify,
    countCacheControls,
    hashCanonical,
    normalizeCachePolicy,
    planCacheBreaks,
    preprocessAutomaticCacheBreaks,
} from '../cache-policy.js';

const OFF_POLICY = {
    fixedHeadBreakpointCount: 0,
    cacheAnchorMode: 'off',
    cacheAnchorIntervalBlocks: 3,
};

function blockBody(letters, markedLetters = letters, extra = {}) {
    const marked = new Set(markedLetters);
    return {
        model: 'test-model',
        ...extra,
        messages: [...letters].map((letter) => ({
            role: 'user',
            content: [{
                type: 'text',
                text: `${letter}${marked.has(letter) ? MARKER : ''}`,
            }],
        })),
    };
}

function selectedTexts(body) {
    const output = [];

    function inspect(content) {
        if (!Array.isArray(content)) {
            return;
        }

        for (const block of content) {
            if (block?.cache_control) {
                output.push(block.text ?? block.type ?? '<non-text>');
            }
        }
    }

    inspect(body.system);

    for (const message of body.messages || []) {
        inspect(message?.content);
    }

    return output;
}

function selectedLogicalIndexes(plan) {
    return plan.diagnostics.candidates
        .filter((candidate) => candidate.selected)
        .map((candidate) => candidate.logicalIndex);
}

test('normalizes and validates policy values', () => {
    assert.deepEqual(normalizeCachePolicy(), OFF_POLICY);
    assert.deepEqual(normalizeCachePolicy({
        fixedHeadBreakpointCount: '4',
        cacheAnchorMode: 'ROLLING',
        cacheAnchorIntervalBlocks: '1000',
    }), {
        fixedHeadBreakpointCount: 4,
        cacheAnchorMode: 'rolling',
        cacheAnchorIntervalBlocks: 1000,
    });
    assert.throws(
        () => normalizeCachePolicy({ fixedHeadBreakpointCount: 5 }),
        (error) => error instanceof CachePolicyError && error.code === 'INVALID_FIXED_HEAD_COUNT',
    );
    assert.throws(
        () => normalizeCachePolicy({ cacheAnchorMode: 'sometimes' }),
        (error) => error.code === 'INVALID_ANCHOR_MODE',
    );
});

test('canonical hashing is key-order independent and returns full SHA-256', () => {
    assert.equal(canonicalStringify({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}');
    assert.equal(hashCanonical({ b: 2, a: 1 }), hashCanonical({ a: 1, b: 2 }));
    assert.match(hashCanonical({ value: 1 }), /^[a-f0-9]{64}$/);
});

test('automatic preprocessing is disabled by default and never mutates its caller', () => {
    const input = {
        model: 'test-model',
        messages: [
            { role: 'system', content: 'system' },
            { role: 'assistant', content: 'assistant' },
        ],
    };
    const original = structuredClone(input);
    const byDefault = preprocessAutomaticCacheBreaks(input, { protocol: 'openai' });
    const explicitlyDisabled = preprocessAutomaticCacheBreaks(input, { protocol: 'openai', enabled: false });

    assert.deepEqual(byDefault.body, original);
    assert.deepEqual(explicitlyDisabled.body, original);
    assert.notEqual(byDefault.body, input);
    assert.deepEqual(byDefault.diagnostics, {
        enabled: false,
        mode: 'off',
        requestedMode: 'off',
        suppressed: false,
        suppressionReason: null,
        explicitMarkerCount: 0,
        existingCacheControlCount: 0,
        protocol: 'openai',
        added: 0,
        alreadyMarked: 0,
        unlandable: 0,
        paths: [],
    });
    assert.deepEqual(input, original);
});

test('OpenAI automatic preprocessing marks only the last system message and every assistant idempotently', () => {
    const input = {
        model: 'test-model',
        messages: [
            { role: 'system', content: 'old-system' },
            { role: 'assistant', content: 'assistant-one' },
            { role: 'system', content: [{ type: 'text', text: 'new-system' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'assistant-two' }] },
            { role: 'user', content: 'user' },
        ],
    };
    const original = structuredClone(input);
    const first = preprocessAutomaticCacheBreaks(input, { protocol: 'openai', enabled: true });

    assert.equal(first.diagnostics.added, 3);
    assert.equal(first.body.messages[0].content, 'old-system');
    assert.equal(first.body.messages[1].content, `assistant-one${MARKER}`);
    assert.deepEqual(first.body.messages[2].content.at(-1), { type: 'text', text: MARKER });
    assert.deepEqual(first.body.messages[3].content.at(-1), { type: 'text', text: MARKER });
    assert.deepEqual(first.diagnostics.paths.map(({ path, source, status }) => ({ path, source, status })), [
        { path: 'messages[2].content', source: 'openai-system', status: 'added' },
        { path: 'messages[1].content', source: 'assistant', status: 'added' },
        { path: 'messages[3].content', source: 'assistant', status: 'added' },
    ]);
    assert.equal(first.diagnostics.paths[0].markerPath, 'messages[2].content[1]');
    assert.deepEqual(input, original);

    const second = preprocessAutomaticCacheBreaks(first.body, { protocol: 'openai', enabled: true });
    assert.equal(second.diagnostics.added, 0);
    assert.equal(second.diagnostics.alreadyMarked, 3);
    assert.deepEqual(second.body, first.body);
});

test('Anthropic automatic markers land on top-level system and non-text assistant blocks', () => {
    const input = {
        model: 'claude-test',
        system: 'anthropic-system',
        tools: [{
            name: 'lookup',
            input_schema: {
                type: 'object',
                properties: { arbitrary: { type: 'object' } },
            },
        }],
        messages: [
            {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'tool-1', name: 'lookup', input: {} }],
            },
            { role: 'user', content: 'continue' },
            { role: 'assistant', content: 'assistant-text' },
        ],
    };
    const automatic = preprocessAutomaticCacheBreaks(input, { protocol: 'anthropic', enabled: true });

    assert.equal(automatic.diagnostics.added, 3);
    assert.deepEqual(automatic.body.messages[0].content.at(-1), { type: 'text', text: MARKER });
    assert.equal(automatic.body.messages[1].content, 'continue');
    assert.equal(automatic.body.messages[2].content, `assistant-text${MARKER}`);

    const plan = planCacheBreaks(automatic.body, { protocol: 'anthropic', policy: OFF_POLICY });
    const toolUse = plan.body.messages[0].content.find((block) => block.type === 'tool_use');
    assert.deepEqual(toolUse.cache_control, { type: 'ephemeral' });
    assert.equal(hasOwnCacheControlDeep(plan.body.tools[0].input_schema), false);
    assert.equal(JSON.stringify(plan.body).includes(MARKER), false);
    assert.equal(plan.diagnostics.cacheControlCount, 3);
});

function hasOwnCacheControlDeep(value) {
    if (Array.isArray(value)) {
        return value.some(hasOwnCacheControlDeep);
    }

    if (!value || typeof value !== 'object') {
        return false;
    }

    return Object.prototype.hasOwnProperty.call(value, 'cache_control')
        || Object.values(value).some(hasOwnCacheControlDeep);
}

test('automatic preprocessing diagnoses empty or null targets without adding markers', () => {
    const input = {
        model: 'test-model',
        messages: [
            { role: 'system', content: 'earlier-system' },
            { role: 'system', content: null },
            { role: 'assistant', content: '' },
            { role: 'assistant', content: null },
            { role: 'assistant', content: [] },
        ],
    };
    const result = preprocessAutomaticCacheBreaks(input, { protocol: 'openai', enabled: true });

    assert.equal(result.diagnostics.added, 0);
    assert.equal(result.diagnostics.unlandable, 4);
    assert.equal(result.diagnostics.paths.every((entry) => entry.status === 'unlandable'), true);
    assert.equal(result.body.messages[0].content, 'earlier-system');
    assert.equal(JSON.stringify(result.body).includes(MARKER), false);
});

test('automatic markers still normalize away and obey the final four-point limit', () => {
    const input = {
        model: 'test-model',
        messages: [
            { role: 'system', content: 'system' },
            ...Array.from({ length: 5 }, (_, index) => ({ role: 'assistant', content: `assistant-${index}` })),
        ],
    };
    const automatic = preprocessAutomaticCacheBreaks(input, { protocol: 'openai', enabled: true });
    const plan = planCacheBreaks(automatic.body, { protocol: 'openai', policy: OFF_POLICY });

    assert.equal(automatic.diagnostics.added, 6);
    assert.equal(plan.diagnostics.candidates.length, 6);
    assert.equal(plan.diagnostics.cacheControlCount, 4);
    assert.equal(JSON.stringify(plan.body).includes(MARKER), false);
    assert.doesNotThrow(() => assertCachePlan(plan.body));
});

test('automatic mode generates only when the original request has no explicit cache breakpoint', () => {
    const plain = {
        model: 'test-model',
        messages: [
            { role: 'system', content: 'system' },
            { role: 'assistant', content: 'assistant' },
        ],
    };
    const generated = preprocessAutomaticCacheBreaks(plain, { protocol: 'openai', mode: 'auto' });

    assert.equal(generated.diagnostics.enabled, true);
    assert.equal(generated.diagnostics.suppressed, false);
    assert.equal(generated.diagnostics.added, 2);

    const explicitMarker = structuredClone(plain);
    explicitMarker.messages[1].content += SHORT_MARKER;
    const markerSuppressed = preprocessAutomaticCacheBreaks(explicitMarker, { protocol: 'openai', mode: 'auto' });

    assert.equal(markerSuppressed.diagnostics.enabled, false);
    assert.equal(markerSuppressed.diagnostics.suppressed, true);
    assert.equal(markerSuppressed.diagnostics.suppressionReason, 'explicit-marker');
    assert.equal(markerSuppressed.diagnostics.explicitMarkerCount, 1);
    assert.equal(markerSuppressed.diagnostics.added, 0);
    assert.deepEqual(markerSuppressed.body, explicitMarker);

    const explicitControl = structuredClone(plain);
    explicitControl.messages[1].content = [{
        type: 'text',
        text: 'assistant',
        cache_control: { type: 'ephemeral', ttl: '5m' },
    }];
    const controlSuppressed = preprocessAutomaticCacheBreaks(explicitControl, {
        protocol: 'openai',
        mode: 'auto',
    });

    assert.equal(controlSuppressed.diagnostics.enabled, false);
    assert.equal(controlSuppressed.diagnostics.suppressionReason, 'existing-cache-control');
    assert.equal(controlSuppressed.diagnostics.existingCacheControlCount, 1);
    assert.equal(controlSuppressed.diagnostics.added, 0);
});

test('forced automatic mode treats either marker kind at a target tail as already marked', () => {
    const input = {
        model: 'test-model',
        messages: [
            { role: 'system', content: `system${SHORT_MARKER}` },
            { role: 'assistant', content: [{ type: 'text', text: SHORT_MARKER }] },
            { role: 'assistant', content: 'unmarked' },
        ],
    };
    const result = preprocessAutomaticCacheBreaks(input, { protocol: 'openai', mode: 'on' });

    assert.equal(result.diagnostics.enabled, true);
    assert.equal(result.diagnostics.alreadyMarked, 2);
    assert.equal(result.diagnostics.added, 1);
    assert.equal(result.body.messages[0].content, input.messages[0].content);
    assert.deepEqual(result.body.messages[1].content, input.messages[1].content);
    assert.equal(result.body.messages[2].content, `unmarked${MARKER}`);
    assert.throws(
        () => preprocessAutomaticCacheBreaks(input, { protocol: 'openai', mode: 'sometimes' }),
        (error) => error instanceof CachePolicyError
            && error.code === 'INVALID_AUTOMATIC_CACHE_BREAKPOINT_MODE',
    );
});

test('manual marker kinds map to native long and short TTLs across supported content forms', () => {
    const body = {
        model: 'claude-test',
        system: `system${MARKER}`,
        messages: [
            { role: 'user', content: `inline${MARKER}` },
            {
                role: 'assistant',
                content: [
                    { type: 'tool_use', id: 'tool-1', name: 'lookup', input: {} },
                    { type: 'text', text: SHORT_MARKER },
                ],
            },
            { role: 'assistant', content: SHORT_MARKER },
        ],
    };
    const resolver = (_candidate, markerKind) => ({
        type: 'ephemeral',
        ttl: markerKind === 'short' ? '5m' : '1h',
    });
    const plan = planCacheBreaks(body, {
        protocol: 'anthropic',
        policy: OFF_POLICY,
        cacheControlForCandidate: resolver,
    });

    assert.deepEqual(plan.body.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
    assert.deepEqual(plan.body.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' });
    assert.deepEqual(plan.body.messages[1].content[0].cache_control, { type: 'ephemeral', ttl: '5m' });
    assert.equal(plan.body.messages.length, 2, 'standalone message with the same role lands on the prior assistant message');
    assert.equal(plan.diagnostics.removed, 4);
    assert.deepEqual(
        plan.diagnostics.candidates.map((candidate) => candidate.markerKinds),
        [['long'], ['long'], ['short']],
    );
    assert.equal(JSON.stringify(plan.body).includes(MARKER), false);
    assert.equal(JSON.stringify(plan.body).includes(SHORT_MARKER), false);
    assert.doesNotThrow(() => assertCachePlan(plan.body));
});

test('both marker kinds follow the global TTL outside manual mode', () => {
    const body = {
        model: 'test-model',
        messages: [
            { role: 'user', content: `long${MARKER}` },
            { role: 'user', content: `short${SHORT_MARKER}` },
            { role: 'user', content: `same-boundary${MARKER}${SHORT_MARKER}` },
        ],
    };
    const plan = planCacheBreaks(body, {
        policy: OFF_POLICY,
        cacheControl: { type: 'ephemeral', ttl: '1h' },
    });

    assert.equal(plan.diagnostics.cacheControlCount, 3);
    assert.equal(plan.diagnostics.candidates[2].markerCount, 2);
    assert.deepEqual(plan.diagnostics.candidates[2].markerKinds, ['long', 'short']);
    assert.deepEqual(
        plan.body.messages.map((message) => message.content[0].cache_control),
        Array.from({ length: 3 }, () => ({ type: 'ephemeral', ttl: '1h' })),
    );
});

test('manual mode rejects ambiguous marker kinds and conflicting caller controls', () => {
    const resolver = (_candidate, markerKind) => ({
        type: 'ephemeral',
        ttl: markerKind === 'short' ? '5m' : '1h',
    });
    const mixedBoundary = {
        messages: [{ role: 'user', content: `mixed${MARKER}${SHORT_MARKER}` }],
    };

    assert.throws(
        () => planCacheBreaks(mixedBoundary, {
            policy: OFF_POLICY,
            cacheControlForCandidate: resolver,
        }),
        (error) => error instanceof CachePolicyError
            && error.code === 'CACHE_MARKER_KIND_CONFLICT'
            && error.details.markerKinds.join(',') === 'long,short',
    );

    const existingConflict = {
        messages: [{
            role: 'user',
            content: [{
                type: 'text',
                text: `short${SHORT_MARKER}`,
                cache_control: { type: 'ephemeral', ttl: '1h' },
            }],
        }],
    };

    assert.throws(
        () => planCacheBreaks(existingConflict, {
            policy: OFF_POLICY,
            cacheControlForCandidate: resolver,
        }),
        (error) => error instanceof CachePolicyError
            && error.code === 'CACHE_MARKER_EXISTING_CONTROL_CONFLICT'
            && error.details.existingCacheControl.ttl === '1h'
            && error.details.expectedCacheControl.ttl === '5m',
    );
    assert.deepEqual(existingConflict.messages[0].content[0].cache_control, {
        type: 'ephemeral',
        ttl: '1h',
    }, 'caller-owned controls must not be rewritten');
});

test('manual short marker accepts a caller control with omitted ttl as the same effective 5m window', () => {
    const body = {
        messages: [{
            role: 'user',
            content: [{
                type: 'text',
                text: `short${SHORT_MARKER}`,
                cache_control: { type: 'ephemeral' },
            }],
        }],
    };
    const original = structuredClone(body);
    const plan = planCacheBreaks(body, {
        policy: OFF_POLICY,
        cacheControlForCandidate: (_candidate, markerKind) => ({
            type: 'ephemeral',
            ttl: markerKind === 'short' ? '5m' : '1h',
        }),
    });

    assert.deepEqual(plan.body.messages[0].content[0].cache_control, { type: 'ephemeral' });
    assert.equal(plan.diagnostics.injected, 0);
    assert.deepEqual(plan.diagnostics.candidates[0].reasons, ['existing-control']);
    assert.equal(assertCachePlan(plan.body).cacheControlTtls[0].effectiveTtl, '5m');
    assert.deepEqual(body, original, 'planning must preserve the caller request and its control');
});

test('manual mode validates a later existing-control marker even when earlier overflow fills legacy traversal', () => {
    const controlledBlock = (text, marker = '') => ({
        role: 'user',
        content: [{
            type: 'text',
            text: `${text}${marker}`,
            cache_control: { type: 'ephemeral', ttl: '1h' },
        }],
    });
    const body = {
        model: 'test-model',
        messages: [
            { role: 'user', content: `overflow-first${MARKER}` },
            controlledBlock('B'),
            controlledBlock('C'),
            controlledBlock('D'),
            controlledBlock('conflicting-short', SHORT_MARKER),
        ],
    };

    assert.throws(
        () => planCacheBreaks(body, {
            policy: OFF_POLICY,
            cacheControlForCandidate: (_candidate, markerKind) => ({
                type: 'ephemeral',
                ttl: markerKind === 'short' ? '5m' : '1h',
            }),
        }),
        (error) => error instanceof CachePolicyError
            && error.code === 'CACHE_MARKER_EXISTING_CONTROL_CONFLICT'
            && error.details.path === 'messages[4].content[0].cache_control',
    );
});

test('standalone marker-block controls migrate to Anthropic system and whole-message boundaries', () => {
    const body = {
        model: 'test-model',
        system: [
            { type: 'text', text: 'system' },
            {
                type: 'text',
                text: SHORT_MARKER,
                cache_control: { type: 'ephemeral' },
            },
        ],
        messages: [
            { role: 'assistant', content: 'assistant' },
            {
                role: 'assistant',
                content: [{
                    type: 'text',
                    text: SHORT_MARKER,
                    cache_control: { type: 'ephemeral', ttl: '5m' },
                }],
            },
        ],
    };
    const plan = planCacheBreaks(body, {
        protocol: 'anthropic',
        policy: OFF_POLICY,
        cacheControlForCandidate: (_candidate, markerKind) => ({
            type: 'ephemeral',
            ttl: markerKind === 'short' ? '5m' : '1h',
        }),
    });

    assert.equal(plan.body.system.length, 1);
    assert.deepEqual(plan.body.system[0].cache_control, { type: 'ephemeral' });
    assert.equal(plan.body.messages.length, 1);
    assert.deepEqual(plan.body.messages[0].content[0].cache_control, {
        type: 'ephemeral',
        ttl: '5m',
    });
    assert.equal(plan.diagnostics.existingBreakpoints, 2);
    assert.equal(plan.diagnostics.injected, 0);
    assert.equal(JSON.stringify(plan.body).includes(SHORT_MARKER), false);
});

test('long and short standalone marker messages land after tool-use and media blocks', () => {
    const body = {
        model: 'test-model',
        messages: [
            {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'tool-1', name: 'lookup', input: {} }],
            },
            { role: 'assistant', content: MARKER },
            {
                role: 'user',
                content: [{
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/png', data: 'AA==' },
                }],
            },
            { role: 'user', content: [{ type: 'text', text: SHORT_MARKER }] },
        ],
    };
    const original = structuredClone(body);
    const plan = planCacheBreaks(body, {
        protocol: 'anthropic',
        policy: OFF_POLICY,
        cacheControlForCandidate: (_candidate, markerKind) => ({
            type: 'ephemeral',
            ttl: markerKind === 'short' ? '5m' : '1h',
        }),
    });

    assert.equal(plan.body.messages.length, 2);
    assert.deepEqual(plan.body.messages[0].content[0].cache_control, {
        type: 'ephemeral',
        ttl: '1h',
    });
    assert.deepEqual(plan.body.messages[1].content[0].cache_control, {
        type: 'ephemeral',
        ttl: '5m',
    });
    assert.deepEqual(
        plan.diagnostics.candidates.map((candidate) => candidate.markerKinds),
        [['long'], ['short']],
    );
    assert.equal(plan.diagnostics.removedEmptyMessages, 2);
    assert.equal(JSON.stringify(plan.body).includes(MARKER), false);
    assert.equal(JSON.stringify(plan.body).includes(SHORT_MARKER), false);
    assert.deepEqual(body, original, 'planning must not mutate non-text caller blocks');
});

test('a migrated standalone marker control remains visible to Manual TTL conflict validation', () => {
    const body = {
        system: [
            { type: 'text', text: 'system' },
            {
                type: 'text',
                text: SHORT_MARKER,
                cache_control: { type: 'ephemeral', ttl: '1h' },
            },
        ],
        messages: [],
    };

    assert.throws(
        () => planCacheBreaks(body, {
            protocol: 'anthropic',
            policy: OFF_POLICY,
            cacheControlForCandidate: (_candidate, markerKind) => ({
                type: 'ephemeral',
                ttl: markerKind === 'short' ? '5m' : '1h',
            }),
        }),
        (error) => error instanceof CachePolicyError
            && error.code === 'CACHE_MARKER_EXISTING_CONTROL_CONFLICT'
            && error.details.path === 'system[0].cache_control',
    );
});

test('standalone marker control rejects an incompatible target control instead of overwriting it', () => {
    const body = {
        system: [
            {
                type: 'text',
                text: 'system',
                cache_control: { type: 'ephemeral', ttl: '1h' },
            },
            {
                type: 'text',
                text: MARKER,
                cache_control: { type: 'ephemeral', ttl: '5m' },
            },
        ],
        messages: [],
    };

    assert.throws(
        () => planCacheBreaks(body, { protocol: 'anthropic', policy: OFF_POLICY }),
        (error) => error instanceof CachePolicyError
            && error.code === 'CACHE_MARKER_CONTROL_CONFLICT'
            && error.details.targetPath === 'system[0].cache_control',
    );
    assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('standalone marker control without a preceding target fails explicitly', () => {
    const body = {
        system: [{
            type: 'text',
            text: SHORT_MARKER,
            cache_control: { type: 'ephemeral', ttl: '5m' },
        }],
        messages: [],
    };

    assert.throws(
        () => planCacheBreaks(body, { protocol: 'anthropic', policy: OFF_POLICY }),
        (error) => error instanceof CachePolicyError
            && error.code === 'CACHE_MARKER_CONTROL_TARGET_MISSING'
            && error.details.carrierPath === 'system[0].cache_control',
    );
});

test('an ambiguous manual marker boundary discarded by the four-point budget does not block the request', () => {
    const body = {
        model: 'test-model',
        messages: [
            ...['A', 'B', 'C', 'D'].map((text) => ({
                role: 'user',
                content: `${text}${MARKER}`,
            })),
            { role: 'user', content: `overflow${MARKER}${SHORT_MARKER}` },
        ],
    };
    const plan = planCacheBreaks(body, {
        policy: OFF_POLICY,
        cacheControlForCandidate: (_candidate, markerKind) => ({
            type: 'ephemeral',
            ttl: markerKind === 'short' ? '5m' : '1h',
        }),
    });

    assert.equal(plan.diagnostics.cacheControlCount, 4);
    assert.equal(plan.diagnostics.candidates.at(-1).selected, false);
    assert.deepEqual(plan.diagnostics.candidates.at(-1).markerKinds, ['long', 'short']);
    assert.equal(JSON.stringify(plan.body).includes(MARKER), false);
    assert.equal(JSON.stringify(plan.body).includes(SHORT_MARKER), false);
});

test('marker kind participates in the anchor boundary fingerprint', () => {
    const policy = {
        fixedHeadBreakpointCount: 0,
        cacheAnchorMode: 'single',
        cacheAnchorIntervalBlocks: 3,
    };
    const store = new AnchorStore();
    const longPlan = planCacheBreaks({
        model: 'test-model',
        messages: [{ role: 'user', content: `same${MARKER}` }],
    }, { policy, store });
    longPlan.commit();
    const shortPlan = planCacheBreaks({
        model: 'test-model',
        messages: [{ role: 'user', content: `same${SHORT_MARKER}` }],
    }, { policy, store });

    assert.notEqual(
        longPlan.diagnostics.candidates[0].prefixHash,
        shortPlan.diagnostics.candidates[0].prefixHash,
    );
    assert.equal(shortPlan.diagnostics.matchedContextId, null);
    assert.equal(shortPlan.diagnostics.anchorAction, 'learn');
});

test('a later anchor fingerprint includes the marker-kind history of earlier boundaries', () => {
    const policy = {
        fixedHeadBreakpointCount: 1,
        cacheAnchorMode: 'single',
        cacheAnchorIntervalBlocks: 3,
    };
    const store = new AnchorStore();
    const makeBody = (firstMarker) => ({
        model: 'test-model',
        messages: [
            { role: 'user', content: `A${firstMarker}` },
            { role: 'user', content: `B${MARKER}` },
        ],
    });
    const first = planCacheBreaks(makeBody(MARKER), { policy, store });
    const originalLaterHash = first.diagnostics.candidates[1].prefixHash;
    first.commit();

    const changedEarlierKind = planCacheBreaks(makeBody(SHORT_MARKER), { policy, store });

    assert.notEqual(changedEarlierKind.diagnostics.candidates[1].prefixHash, originalLaterHash);
    assert.equal(changedEarlierKind.diagnostics.matchedContextId, null);
    assert.equal(changedEarlierKind.diagnostics.anchorAction, 'learn');
});

test('legacy mode preserves the first four marker boundaries', () => {
    const input = blockBody('ABCDEFG');
    const original = structuredClone(input);
    const plan = planCacheBreaks(input, { protocol: 'openai', policy: OFF_POLICY });

    assert.deepEqual(selectedTexts(plan.body), ['A', 'B', 'C', 'D']);
    assert.deepEqual(selectedLogicalIndexes(plan), [1, 2, 3, 4]);
    assert.equal(plan.diagnostics.cacheControlCount, 4);
    assert.equal(plan.diagnostics.selectedBreakpointCount, 4);
    assert.equal(plan.diagnostics.selectedBreakpoints.length, 4);
    assert.equal(plan.diagnostics.overflowRemoved, 3);
    assert.equal(JSON.stringify(plan.body).includes(MARKER), false);
    assert.deepEqual(input, original, 'planning must not mutate the caller body');
});

test('fixed head policy keeps the head and fills remaining budget from the tail', () => {
    const plan = planCacheBreaks(blockBody('ABCDEFGH'), {
        policy: {
            fixedHeadBreakpointCount: 1,
            cacheAnchorMode: 'off',
            cacheAnchorIntervalBlocks: 3,
        },
    });

    assert.deepEqual(selectedTexts(plan.body), ['A', 'F', 'G', 'H']);
    assert.deepEqual(selectedLogicalIndexes(plan), [1, 6, 7, 8]);
    assert.equal(plan.diagnostics.candidates[0].reason, 'fixed-head');
    assert.equal(plan.diagnostics.candidates.at(-1).reason, 'tail');
});

test('fixed head H=0..4 follows the legacy-or-head-plus-tail selection matrix', () => {
    const expectedByHeadCount = new Map([
        [0, [1, 2, 3, 4]], // H=0 with anchors off is the legacy first-four behavior.
        [1, [1, 6, 7, 8]],
        [2, [1, 2, 7, 8]],
        [3, [1, 2, 3, 8]],
        [4, [1, 2, 3, 4]],
    ]);

    for (const [fixedHeadBreakpointCount, expected] of expectedByHeadCount) {
        const plan = planCacheBreaks(blockBody('ABCDEFGH'), {
            policy: {
                fixedHeadBreakpointCount,
                cacheAnchorMode: 'off',
                cacheAnchorIntervalBlocks: 3,
            },
        });
        assert.deepEqual(selectedLogicalIndexes(plan), expected, `H=${fixedHeadBreakpointCount}`);
    }
});

test('normalizes inline, content-array, and standalone message markers without empty messages', () => {
    const body = {
        model: 'test-model',
        messages: [
            { role: 'user', content: 'A' },
            { role: 'assistant', content: 'X' },
            { role: 'user', content: MARKER },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'B' },
                    { type: 'text', text: MARKER },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
                    { type: 'text', text: `C${MARKER}D${MARKER}` },
                ],
            },
        ],
    };
    const plan = planCacheBreaks(body, { policy: OFF_POLICY });

    assert.equal(plan.body.messages.length, 3);
    assert.equal(plan.body.messages.some((message) => !isNonEmptyMessage(message)), false);
    assert.equal(JSON.stringify(plan.body).includes(MARKER), false);
    assert.deepEqual(selectedTexts(plan.body), ['A', 'B', 'C', 'D']);
    assert.equal(plan.diagnostics.removedEmptyMessages, 1);
    assert.equal(plan.diagnostics.removed, 4);
});

function isNonEmptyMessage(message) {
    if (typeof message?.content === 'string') {
        return message.content.trim() !== '';
    }

    return Array.isArray(message?.content) && message.content.length > 0;
}

test('Anthropic system candidates precede message candidates and retain non-text blocks', () => {
    const body = {
        model: 'claude-test',
        system: `S1${MARKER}S2${MARKER}`,
        messages: [{
            role: 'user',
            content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
                { type: 'text', text: `U${MARKER}` },
            ],
        }],
    };
    const plan = planCacheBreaks(body, { protocol: 'anthropic', policy: OFF_POLICY });

    assert.deepEqual(selectedTexts(plan.body), ['S1', 'S2', 'U']);
    assert.equal(plan.body.messages[0].content[0].type, 'image');
    assert.equal(plan.diagnostics.cacheControlCount, 3);
    assert.doesNotThrow(() => assertCachePlan(plan.body, { translationEnabled: true }));
});

test('existing cache_control entries reserve budget and are represented in selected diagnostics', () => {
    const body = blockBody('ABCDE');
    body.tools = [{
        name: 'lookup',
        description: 'Lookup',
        input_schema: { type: 'object' },
        cache_control: { type: 'ephemeral' },
    }];
    const plan = planCacheBreaks(body, { policy: OFF_POLICY });

    assert.equal(plan.diagnostics.existingBreakpoints, 1);
    assert.equal(plan.diagnostics.injected, 3);
    assert.equal(plan.diagnostics.cacheControlCount, 4);
    assert.equal(plan.diagnostics.selectedBreakpoints.length, 4);
    assert.equal(plan.diagnostics.selectedBreakpoints.some((item) => item.reason === 'existing-control'), true);
    assert.equal(plan.diagnostics.selectedBreakpoints[0].path, 'tools[0].cache_control');
    assert.equal(assertCachePlan(plan.body).cacheControlPaths[0], 'tools[0].cache_control');
    assert.deepEqual(selectedTexts(plan.body), ['A', 'B', 'C']);
});

test('cache TTL ordering follows tools then system then messages and allows 1h before 5m', () => {
    const body = {
        model: 'ttl-order-valid',
        // Deliberately use a non-semantic root insertion order. The cache
        // collector must still evaluate Claude's tools -> system -> messages order.
        messages: [{
            role: 'user',
            content: [{ type: 'text', text: 'M', cache_control: { type: 'ephemeral', ttl: '5m' } }],
        }],
        system: [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral', ttl: '1h' } }],
        tools: [{
            name: 'lookup',
            input_schema: { type: 'object' },
            cache_control: { type: 'ephemeral', ttl: '1h' },
        }],
    };

    const assertion = assertCachePlan(body);
    assert.deepEqual(assertion.cacheControlPaths, [
        'tools[0].cache_control',
        'system[0].cache_control',
        'messages[0].content[0].cache_control',
    ]);
    assert.deepEqual(
        assertion.cacheControlTtls.map(({ effectiveTtl }) => effectiveTtl),
        ['1h', '1h', '5m'],
    );
});

test('cache TTL ordering treats omitted ttl as 5m and reports the later 1h paths', () => {
    const body = {
        model: 'ttl-order-invalid',
        system: [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }],
        messages: [{
            role: 'user',
            content: [{ type: 'text', text: 'M', cache_control: { type: 'ephemeral', ttl: '1h' } }],
        }],
    };

    assert.throws(
        () => assertCachePlan(body),
        (error) => {
            assert.ok(error instanceof CachePolicyError);
            assert.equal(error.code, 'CACHE_TTL_ORDER_INVALID');
            assert.equal(error.statusCode, 400);
            assert.match(error.message, /1h cache_control.*after 5m cache_control/i);
            assert.equal(error.details.firstFiveMinutePath, 'system[0].cache_control');
            assert.equal(error.details.laterOneHourPath, 'messages[0].content[0].cache_control');
            assert.deepEqual(error.details.paths, [
                'system[0].cache_control',
                'messages[0].content[0].cache_control',
            ]);
            assert.deepEqual(error.details.ttlOrder, [
                {
                    path: 'system[0].cache_control',
                    effectiveTtl: '5m',
                    explicitTtl: null,
                },
                {
                    path: 'messages[0].content[0].cache_control',
                    effectiveTtl: '1h',
                    explicitTtl: '1h',
                },
            ]);
            return true;
        },
    );
});

test('rejects more than four existing controls even when translation is disabled', () => {
    const body = {
        model: 'test-model',
        tools: Array.from({ length: 5 }, (_, index) => ({
            name: `tool-${index}`,
            cache_control: { type: 'ephemeral' },
        })),
        messages: [{ role: 'user', content: `A${MARKER}` }],
    };

    for (const enabled of [true, false]) {
        assert.throws(
            () => planCacheBreaks(body, { policy: OFF_POLICY, enabled }),
            (error) => error.code === 'CACHE_CONTROL_LIMIT_EXCEEDED' && error.statusCode === 400,
        );
    }
});

test('translation-disabled plans preserve markers but still validate controls', () => {
    const body = { model: 'test-model', messages: [{ role: 'user', content: `A${MARKER}` }] };
    const plan = planCacheBreaks(body, { enabled: false, policy: OFF_POLICY });

    assert.equal(plan.body.messages[0].content, `A${MARKER}`);
    assert.equal(plan.diagnostics.markerRemaining, true);
    assert.deepEqual(plan.diagnostics.selectedBreakpoints, []);
    assert.doesNotThrow(() => assertCachePlan(plan.body, { translationEnabled: false }));
    assert.throws(() => assertCachePlan(plan.body), (error) => error.code === 'CACHE_MARKER_REMAINING');
});

test('fixed head budget conflicts fail instead of silently dropping guaranteed points', () => {
    const body = blockBody('ABCDE', ['A', 'E']);

    for (const index of [1, 2, 3]) {
        body.messages[index].content[0].cache_control = { type: 'ephemeral' };
    }

    assert.throws(
        () => planCacheBreaks(body, {
            policy: {
                fixedHeadBreakpointCount: 2,
                cacheAnchorMode: 'off',
                cacheAnchorIntervalBlocks: 3,
            },
        }),
        (error) => error.code === 'FIXED_HEAD_BUDGET_CONFLICT',
    );
});

test('prefix fingerprints ignore sampling options but include tools, roles, and non-text blocks', () => {
    const base = {
        model: 'test-model',
        temperature: 0.1,
        max_tokens: 10,
        stream: false,
        tools: [{ name: 'one', description: 'first' }],
        messages: [{
            role: 'user',
            content: [
                { type: 'image_url', image_url: { url: 'one' } },
                { type: 'text', text: `A${MARKER}` },
            ],
        }],
    };
    const getHash = (value) => planCacheBreaks(value, { policy: OFF_POLICY }).diagnostics.candidates[0].prefixHash;
    const baseHash = getHash(base);

    assert.equal(getHash({ ...base, temperature: 0.9, max_tokens: 999, stream: true }), baseHash);
    assert.notEqual(getHash({ ...base, tools: [{ name: 'two', description: 'second' }] }), baseHash);
    assert.notEqual(getHash({ ...base, messages: [{ ...base.messages[0], role: 'assistant' }] }), baseHash);
    assert.notEqual(getHash({
        ...base,
        messages: [{
            ...base.messages[0],
            content: [
                { type: 'image_url', image_url: { url: 'two' } },
                { type: 'text', text: `A${MARKER}` },
            ],
        }],
    }), baseHash);

    const toolCallMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'one', arguments: '{"x":1}' } }],
    };
    const toolCallHash = getHash({ ...base, messages: [toolCallMessage, ...base.messages] });
    assert.notEqual(toolCallHash, getHash({
        ...base,
        messages: [{
            ...toolCallMessage,
            tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'one', arguments: '{"x":2}' } }],
        }, ...base.messages],
    }));
});

test('tool schema cache_control fields affect anchors while ephemeral cache directives do not', () => {
    const store = new AnchorStore();
    const policy = {
        fixedHeadBreakpointCount: 0,
        cacheAnchorMode: 'single',
        cacheAnchorIntervalBlocks: 3,
    };
    const makeBody = (description, cacheControl) => ({
        model: 'test-model',
        tools: [{
            name: 'configure_cache',
            description: 'Configure an application cache.',
            input_schema: {
                type: 'object',
                properties: {
                    cache_control: {
                        type: 'string',
                        description,
                    },
                },
            },
            cache_control: cacheControl,
        }],
        messages: [{ role: 'user', content: `A${MARKER}` }],
    });

    const first = planCacheBreaks(makeBody('schema-v1', { type: 'ephemeral' }), { policy, store });
    const firstHash = first.diagnostics.candidates[0].prefixHash;
    assert.equal(first.diagnostics.existingBreakpoints, 1, 'the schema property is not a prompt cache directive');
    assert.equal(first.commit(), true);

    const ttlChanged = planCacheBreaks(makeBody('schema-v1', { type: 'ephemeral', ttl: '1h' }), { policy, store });
    assert.equal(ttlChanged.diagnostics.candidates[0].prefixHash, firstHash);
    assert.notEqual(ttlChanged.diagnostics.matchedContextId, null, 'ephemeral cache metadata is excluded from the prefix');

    const schemaChanged = planCacheBreaks(makeBody('schema-v2', { type: 'ephemeral', ttl: '1h' }), { policy, store });
    assert.notEqual(schemaChanged.diagnostics.candidates[0].prefixHash, firstHash);
    assert.equal(schemaChanged.diagnostics.matchedContextId, null, 'ordinary tool schema changes must invalidate the anchor match');
    assert.equal(schemaChanged.statePlan.operation, 'create');

    const nestedStore = new AnchorStore();
    const makeNestedDefaultBody = (ttl) => ({
        model: 'test-model',
        tools: [{
            name: 'configure_nested_policy',
            input_schema: {
                type: 'object',
                properties: {
                    policy: {
                        type: 'object',
                        default: {
                            cache_control: { type: 'ephemeral', ttl },
                        },
                    },
                },
            },
        }],
        messages: blockBody('ABCD').messages,
    });
    const nestedFiveMinutes = planCacheBreaks(makeNestedDefaultBody('5m'), { policy, store: nestedStore });
    const nestedHash = nestedFiveMinutes.diagnostics.candidates.at(-1).prefixHash;

    assert.equal(nestedFiveMinutes.diagnostics.existingBreakpoints, 0);
    assert.equal(nestedFiveMinutes.diagnostics.injected, 4, 'schema defaults do not consume the four-point budget');
    assert.equal(nestedFiveMinutes.diagnostics.cacheControlCount, 4);
    assert.equal(nestedFiveMinutes.commit(), true);

    const nestedOneHour = planCacheBreaks(makeNestedDefaultBody('1h'), { policy, store: nestedStore });
    assert.notEqual(nestedOneHour.diagnostics.candidates.at(-1).prefixHash, nestedHash);
    assert.equal(nestedOneHour.diagnostics.matchedContextId, null, 'directive-shaped schema data remains semantic');
});

test('single anchors are learned only on commit and survive suffix growth', () => {
    const store = new AnchorStore();
    const policy = {
        fixedHeadBreakpointCount: 1,
        cacheAnchorMode: 'single',
        cacheAnchorIntervalBlocks: 3,
    };
    const first = planCacheBreaks(blockBody('ABCDEF', ['A', 'F']), { policy, store });

    assert.equal(store.getStats().contextCount, 0, 'plan must not mutate anchor state');
    assert.equal(first.statePlan.operation, 'create');
    assert.equal(first.commit(false), false);
    assert.equal(store.getStats().contextCount, 0);
    assert.equal(first.commit(), true);
    assert.equal(store.getStats().contextCount, 1);

    const grown = planCacheBreaks(blockBody('ABCDEFGHIJ', ['A', 'F', 'I', 'J']), { policy, store });
    const anchor = grown.diagnostics.candidates.find((candidate) => candidate.logicalIndex === 6);

    assert.equal(anchor.selected, true);
    assert.equal(anchor.reasons.includes('active-anchor'), true);
    assert.equal(grown.diagnostics.matchedContextId !== null, true);
    assert.equal(grown.commit(), true);
    assert.equal(store.getStats().contextCount, 1);
});

test('single-anchor seed is the earliest selected non-fixed tail point', () => {
    const store = new AnchorStore();
    const policy = {
        fixedHeadBreakpointCount: 1,
        cacheAnchorMode: 'single',
        cacheAnchorIntervalBlocks: 3,
    };
    const first = planCacheBreaks(blockBody('ABCDEFG'), { policy, store });
    const learned = first.diagnostics.candidates.find((candidate) => candidate.logicalIndex === 5);

    assert.deepEqual(selectedLogicalIndexes(first), [1, 5, 6, 7]);
    assert.deepEqual(learned.reasons, ['learned-anchor', 'tail']);
    assert.deepEqual(first.statePlan.nextAnchors.map((anchor) => anchor.logicalIndex), [5]);
    assert.equal(first.commit(), true);

    const grown = planCacheBreaks(blockBody('ABCDEFGH'), { policy, store });
    const active = grown.diagnostics.candidates.find((candidate) => candidate.logicalIndex === 5);
    assert.deepEqual(selectedLogicalIndexes(grown), [1, 5, 7, 8]);
    assert.equal(active.reasons.includes('active-anchor'), true);
    assert.deepEqual(grown.statePlan.nextAnchors.map((anchor) => anchor.logicalIndex), [5]);

    const relearned = planCacheBreaks(blockBody('AXCDEFGH'), { policy, store });
    const newSeed = relearned.diagnostics.candidates.find((candidate) => candidate.logicalIndex === 6);
    assert.equal(relearned.diagnostics.matchedContextId, null);
    assert.deepEqual(selectedLogicalIndexes(relearned), [1, 6, 7, 8]);
    assert.equal(newSeed.reasons.includes('learned-anchor'), true);
    assert.deepEqual(relearned.statePlan.nextAnchors.map((anchor) => anchor.logicalIndex), [6]);

    const noSeed = planCacheBreaks(blockBody('ABCDEFG'), {
        policy: { ...policy, fixedHeadBreakpointCount: 4 },
        store: new AnchorStore(),
    });
    assert.deepEqual(selectedLogicalIndexes(noSeed), [1, 2, 3, 4]);
    assert.equal(noSeed.diagnostics.candidates.some((candidate) => candidate.reasons.includes('learned-anchor')), false);
    assert.equal(noSeed.diagnostics.pauseReason, 'anchor-budget-unavailable');
    assert.equal(noSeed.statePlan.operation, 'status');
    assert.deepEqual(noSeed.statePlan.nextAnchors, []);
});

test('H=2 seed excludes both fixed head points before choosing the earliest selected tail', () => {
    const plan = planCacheBreaks(blockBody('ABCDEFG'), {
        policy: {
            fixedHeadBreakpointCount: 2,
            cacheAnchorMode: 'single',
            cacheAnchorIntervalBlocks: 3,
        },
        store: new AnchorStore(),
    });
    const seed = plan.diagnostics.candidates.find((candidate) => candidate.logicalIndex === 6);

    assert.deepEqual(selectedLogicalIndexes(plan), [1, 2, 6, 7]);
    assert.deepEqual(seed.reasons, ['learned-anchor', 'tail']);
    assert.deepEqual(plan.statePlan.nextAnchors.map((anchor) => anchor.logicalIndex), [6]);
});

test('only an existing control on a selected marker candidate can seed without extra budget', () => {
    const policy = {
        fixedHeadBreakpointCount: 1,
        cacheAnchorMode: 'single',
        cacheAnchorIntervalBlocks: 3,
    };
    const existingCandidateBody = blockBody('ABCDEFG');
    existingCandidateBody.tools = [
        { name: 'tool-one', cache_control: { type: 'ephemeral' } },
        { name: 'tool-two', cache_control: { type: 'ephemeral' } },
    ];
    existingCandidateBody.messages[4].content[0].cache_control = { type: 'ephemeral' };
    const existingCandidatePlan = planCacheBreaks(existingCandidateBody, {
        policy,
        store: new AnchorStore(),
    });
    const zeroBudgetSeed = existingCandidatePlan.diagnostics.candidates
        .find((candidate) => candidate.logicalIndex === 5);

    assert.equal(existingCandidatePlan.diagnostics.existingBreakpoints, 3);
    assert.equal(existingCandidatePlan.diagnostics.injected, 1);
    assert.deepEqual(selectedLogicalIndexes(existingCandidatePlan), [1, 5]);
    assert.equal(zeroBudgetSeed.reasons.includes('existing-control'), true);
    assert.equal(zeroBudgetSeed.reasons.includes('learned-anchor'), true);
    assert.deepEqual(existingCandidatePlan.statePlan.nextAnchors.map((anchor) => anchor.logicalIndex), [5]);

    const toolOnlyBody = blockBody('ABCDEFG');
    toolOnlyBody.tools = [{ name: 'tool-only', cache_control: { type: 'ephemeral' } }];
    const toolOnlyPlan = planCacheBreaks(toolOnlyBody, {
        policy,
        store: new AnchorStore(),
    });

    assert.equal(toolOnlyPlan.diagnostics.existingBreakpoints, 1);
    assert.deepEqual(selectedLogicalIndexes(toolOnlyPlan), [1, 6, 7]);
    assert.deepEqual(toolOnlyPlan.statePlan.nextAnchors.map((anchor) => anchor.logicalIndex), [6]);
});

test('single anchor prefix changes create an isolated context without deleting the old one', () => {
    const store = new AnchorStore();
    const policy = {
        fixedHeadBreakpointCount: 1,
        cacheAnchorMode: 'single',
        cacheAnchorIntervalBlocks: 3,
    };
    const first = planCacheBreaks(blockBody('ABCDEF', ['A', 'F']), { policy, store });
    first.commit();
    const changed = blockBody('ABXDEFJ', ['A', 'F', 'J']);
    const second = planCacheBreaks(changed, { policy, store });

    assert.equal(second.diagnostics.matchedContextId, null);
    assert.equal(second.statePlan.operation, 'create');
    second.commit();
    assert.equal(store.getStats().contextCount, 2);
});

test('single anchors relearn after their marker is deleted or the context is shortened', () => {
    const store = new AnchorStore();
    const policy = {
        fixedHeadBreakpointCount: 1,
        cacheAnchorMode: 'single',
        cacheAnchorIntervalBlocks: 3,
    };
    planCacheBreaks(blockBody('ABCDEF', ['A', 'F']), { policy, store }).commit();

    const markerDeleted = planCacheBreaks(blockBody('ABCDEFG', ['A', 'G']), { policy, store });
    assert.equal(markerDeleted.diagnostics.matchedContextId, null);
    assert.equal(markerDeleted.diagnostics.action, 'learn');
    assert.deepEqual(markerDeleted.statePlan.nextAnchors.map((anchor) => anchor.logicalIndex), [7]);
    markerDeleted.commit();

    const shortened = planCacheBreaks(blockBody('ABCD', ['A', 'D']), { policy, store });
    assert.equal(shortened.diagnostics.matchedContextId, null);
    assert.equal(shortened.diagnostics.action, 'learn');
    assert.deepEqual(shortened.statePlan.nextAnchors.map((anchor) => anchor.logicalIndex), [4]);
});

test('anchor contexts are isolated by channel, protocol, model, and cache TTL', () => {
    const store = new AnchorStore();
    const policy = {
        fixedHeadBreakpointCount: 0,
        cacheAnchorMode: 'single',
        cacheAnchorIntervalBlocks: 3,
    };
    const makeScopedPlan = ({
        channelId = 'channel-a',
        protocol = 'openai',
        model = 'model-a',
        cacheTtl = '1h',
    } = {}) => planCacheBreaks({ ...blockBody('ABCDEF', ['A', 'F']), model }, {
        protocol,
        policy,
        store,
        scope: { channelId, upstreamMode: protocol, model, cacheTtl },
    });

    makeScopedPlan().commit();

    for (const variant of [
        { channelId: 'channel-b' },
        { protocol: 'anthropic' },
        { model: 'model-b' },
        { cacheTtl: '5m' },
    ]) {
        const isolated = makeScopedPlan(variant);
        assert.equal(isolated.diagnostics.matchedContextId, null, JSON.stringify(variant));
        assert.equal(isolated.statePlan.operation, 'create', JSON.stringify(variant));
    }
});

test('rolling anchors reproduce the gradual F/I/L window rotation', () => {
    const store = new AnchorStore();
    const policy = {
        fixedHeadBreakpointCount: 1,
        cacheAnchorMode: 'rolling',
        cacheAnchorIntervalBlocks: 3,
    };
    const calls = [
        ['ABCDEF', ['A', 'F'], [1, 6], 'learn'],
        ['ABCDEFGHIJ', ['A', 'F', 'I', 'J'], [1, 6, 9, 10], 'promote'],
        ['ABCDEFGHIJKLM', ['A', 'F', 'I', 'L', 'M'], [1, 6, 9, 12], 'promote'],
        ['ABCDEFGHIJKLMN', ['A', 'F', 'I', 'L', 'M'], [1, 9, 12, 13], 'match'],
    ];

    for (const [letters, marks, expected, action] of calls) {
        const plan = planCacheBreaks(blockBody(letters, marks), { policy, store });
        assert.deepEqual(selectedLogicalIndexes(plan), expected);
        assert.equal(plan.diagnostics.action, action);
        assert.equal(plan.commit(), true);
    }

    assert.equal(store.getStats().activeAnchorCount, 2);
});

test('rolling-anchor seed comes from the earliest point in the selected latest-four window', () => {
    const store = new AnchorStore();
    const policy = {
        fixedHeadBreakpointCount: 0,
        cacheAnchorMode: 'rolling',
        cacheAnchorIntervalBlocks: 3,
    };
    const first = planCacheBreaks(blockBody('ABCDEFG'), { policy, store });
    const seed = first.diagnostics.candidates.find((candidate) => candidate.logicalIndex === 4);
    const initiallyLearned = first.diagnostics.candidates
        .filter((candidate) => candidate.reasons.includes('learned-anchor'));
    const initiallyPromoted = first.diagnostics.candidates
        .filter((candidate) => candidate.reasons.includes('promoted-anchor'));

    assert.deepEqual(selectedLogicalIndexes(first), [4, 5, 6, 7]);
    assert.deepEqual(seed.reasons, ['learned-anchor', 'tail']);
    assert.equal(initiallyLearned.length, 1);
    assert.equal(initiallyPromoted.length, 0);
    assert.deepEqual(first.statePlan.nextAnchors.map((anchor) => anchor.logicalIndex), [4]);
    assert.equal(first.commit(), true);

    const promoted = planCacheBreaks(blockBody('ABCDEFGHIJ'), { policy, store });
    const nextAnchor = promoted.diagnostics.candidates.find((candidate) => candidate.logicalIndex === 7);
    assert.deepEqual(selectedLogicalIndexes(promoted), [4, 7, 9, 10]);
    assert.equal(nextAnchor.reasons.includes('promoted-anchor'), true);
    assert.deepEqual(promoted.statePlan.nextAnchors.map((anchor) => anchor.logicalIndex), [4, 7]);
});

test('a rolling plan promotes at most one anchor even when several intervals are available', () => {
    const store = new AnchorStore();
    const policy = {
        fixedHeadBreakpointCount: 0,
        cacheAnchorMode: 'rolling',
        cacheAnchorIntervalBlocks: 3,
    };
    planCacheBreaks(blockBody('ABCDEF', ['F']), { policy, store }).commit();

    const longPlan = planCacheBreaks(blockBody('ABCDEFGHIJKLMNO', ['F', 'I', 'L', 'O']), { policy, store });
    const promoted = longPlan.diagnostics.candidates
        .filter((candidate) => candidate.reasons.includes('promoted-anchor'));

    assert.equal(promoted.length, 1);
    assert.equal(promoted[0].logicalIndex, 9);
    assert.deepEqual(longPlan.statePlan.nextAnchors.map((anchor) => anchor.logicalIndex), [6, 9]);
});

test('rolling promotion pauses when existing controls consume overlap budget', () => {
    const store = new AnchorStore();
    const policy = {
        fixedHeadBreakpointCount: 1,
        cacheAnchorMode: 'rolling',
        cacheAnchorIntervalBlocks: 3,
    };
    planCacheBreaks(blockBody('ABCDEF', ['A', 'F']), { policy, store }).commit();
    planCacheBreaks(blockBody('ABCDEFGHIJ', ['A', 'F', 'I', 'J']), { policy, store }).commit();
    const nextBody = blockBody('ABCDEFGHIJKLM', ['A', 'F', 'I', 'L', 'M']);
    nextBody.messages[1].content[0].cache_control = { type: 'ephemeral' };
    const paused = planCacheBreaks(nextBody, { policy, store });

    assert.equal(paused.diagnostics.action, 'rotation-paused');
    assert.equal(paused.diagnostics.pauseReason, 'anchor-overlap-budget');
    assert.equal(paused.diagnostics.pendingEvictionAnchorCount, 0);
    assert.deepEqual(selectedLogicalIndexes(paused), [1, 6, 9]);
    assert.equal(paused.diagnostics.cacheControlCount, 4);
    assert.equal(paused.commit(), true);
    assert.equal(store.getStats().activeAnchorCount, 2);
    assert.equal(store.getStats().lastPauseReason, 'anchor-overlap-budget');
});

test('zero anchor budget records status only after a successful commit', () => {
    const store = new AnchorStore();
    const policy = {
        fixedHeadBreakpointCount: 4,
        cacheAnchorMode: 'single',
        cacheAnchorIntervalBlocks: 3,
    };
    const plan = planCacheBreaks(blockBody('ABCDE'), { policy, store });

    assert.equal(plan.statePlan.operation, 'status');
    assert.equal(plan.diagnostics.activeAnchorCount, 0);
    assert.equal(store.getStats().lastAction, 'idle');
    assert.equal(plan.commit(), true);
    assert.equal(store.getStats().contextCount, 0);
    assert.equal(store.getStats().lastAction, 'rotation-paused');
    assert.equal(store.getStats().lastReason, 'anchor-budget-unavailable');
});

test('clear increments generation, keeps its reason, and blocks in-flight resurrection', () => {
    const store = new AnchorStore();
    const policy = {
        fixedHeadBreakpointCount: 1,
        cacheAnchorMode: 'single',
        cacheAnchorIntervalBlocks: 3,
    };
    const plan = planCacheBreaks(blockBody('AB', ['A', 'B']), { policy, store });
    const generation = store.getStats().generation;

    store.clear('policy-changed');
    assert.equal(store.getStats().generation, generation + 1);
    assert.equal(store.getStats().lastReason, 'policy-changed');
    assert.equal(plan.commit(), false);
    assert.equal(store.getStats().contextCount, 0);
});

test('AnchorStore applies strict frontier extension but rejects a delayed regression', () => {
    const store = new AnchorStore();
    const policy = {
        fixedHeadBreakpointCount: 1,
        cacheAnchorMode: 'rolling',
        cacheAnchorIntervalBlocks: 3,
    };
    planCacheBreaks(blockBody('ABCDEF', ['A', 'F']), { policy, store }).commit();

    const long = planCacheBreaks(blockBody('ABCDEFGHI', ['A', 'F', 'I']), { policy, store });
    const short = planCacheBreaks(blockBody('ABCDEFGH', ['A', 'F']), { policy, store });
    assert.equal(short.commit(), true);
    assert.equal(long.commit(), true, 'a longer frontier may extend an unchanged stale base');

    const delayedShort = planCacheBreaks(blockBody('ABCDEFGHIJ', ['A', 'F', 'I', 'J']), { policy, store });
    const extending = planCacheBreaks(blockBody('ABCDEFGHIJKL', ['A', 'F', 'I', 'L']), { policy, store });
    assert.equal(extending.commit(), true);
    assert.equal(delayedShort.commit(), false, 'a late shorter request must not roll anchors back');
});

test('AnchorStore enforces its LRU context cap after successful commits', () => {
    const store = new AnchorStore();
    const policy = {
        fixedHeadBreakpointCount: 0,
        cacheAnchorMode: 'single',
        cacheAnchorIntervalBlocks: 3,
    };

    for (let index = 0; index < 33; index++) {
        const plan = planCacheBreaks(blockBody('A', ['A']), {
            policy,
            store,
            scope: { channelId: `channel-${index}`, upstreamMode: 'openai', model: 'test-model', cacheTtl: '1h' },
        });
        assert.equal(plan.commit(), true);
    }

    assert.equal(store.maxContexts, 32);
    assert.equal(store.getStats().contextCount, 32);
});

test('recursive cache-control counting covers definitions as well as prompt blocks', () => {
    const body = {
        tools: [{ cache_control: { type: 'ephemeral' } }],
        messages: [{
            role: 'user',
            content: [{ type: 'text', text: 'A', cache_control: { type: 'ephemeral' } }],
        }],
    };

    assert.equal(countCacheControls(body), 2);
});
