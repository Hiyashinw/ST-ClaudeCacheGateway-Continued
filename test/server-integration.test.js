import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const MARKER = '[[CACHE_BREAK]]';
const SHORT_MARKER = '[[CACHE_BREAK_SHORT]]';
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = dirname(TEST_DIR);
const DEFAULT_POLICY = {
    fixedHeadBreakpointCount: 1,
    cacheAnchorMode: 'off',
    cacheAnchorIntervalBlocks: 3,
};

function markerBody(model = 'integration-model', letters = 'ABCDEFG') {
    return {
        model,
        max_tokens: 32,
        messages: [...letters].map((letter) => ({
            role: 'user',
            content: [{ type: 'text', text: `${letter}${MARKER}` }],
        })),
    };
}

function automaticOpenAiBody(model = 'automatic-openai-model') {
    return {
        model,
        max_tokens: 32,
        messages: [
            { role: 'system', content: [{ type: 'text', text: 'System first' }] },
            { role: 'system', content: [{ type: 'text', text: 'System last' }] },
            ...[1, 2, 3, 4, 5].flatMap((index) => [
                { role: 'user', content: [{ type: 'text', text: `U${index}` }] },
                { role: 'assistant', content: [{ type: 'text', text: `A${index}` }] },
            ]),
        ],
    };
}

function interleavedSystemOpenAiBody(model = 'interleaved-system-model') {
    return {
        model,
        max_tokens: 32,
        messages: [
            { role: 'system', content: 'Leading system' },
            { role: 'user', content: 'First user' },
            { role: 'user', content: 'Adjacent user' },
            { role: 'assistant', content: 'First assistant' },
            { role: 'assistant', content: 'Adjacent assistant' },
            { role: 'system', content: 'Later system' },
            { role: 'user', content: 'Second user' },
            { role: 'user', content: 'Adjacent second user' },
        ],
    };
}

function automaticAnthropicBody(model = 'automatic-anthropic-model') {
    return {
        model,
        max_tokens: 32,
        system: [
            { type: 'text', text: 'Native system first' },
            { type: 'text', text: 'Native system last' },
        ],
        messages: [1, 2, 3, 4, 5].flatMap((index) => [
            { role: 'user', content: [{ type: 'text', text: `N-U${index}` }] },
            { role: 'assistant', content: [{ type: 'text', text: `N-A${index}` }] },
        ]),
    };
}

function manualOpenAiBody(model = 'manual-openai-model') {
    return {
        model,
        max_tokens: 32,
        messages: [
            { role: 'system', content: [{ type: 'text', text: `Stable system${MARKER}` }] },
            { role: 'user', content: [{ type: 'text', text: 'Question' }] },
            { role: 'assistant', content: [{ type: 'text', text: `Recent answer${SHORT_MARKER}` }] },
        ],
    };
}

function manualAnthropicBody(model = 'manual-anthropic-model') {
    return {
        model,
        max_tokens: 32,
        system: [{ type: 'text', text: `Stable native system${MARKER}` }],
        messages: [
            { role: 'user', content: [{ type: 'text', text: 'Native question' }] },
            { role: 'assistant', content: [{ type: 'text', text: `Recent native answer${SHORT_MARKER}` }] },
        ],
    };
}

function findCacheControlledTexts(value, output = []) {
    if (Array.isArray(value)) {
        for (const item of value) {
            findCacheControlledTexts(item, output);
        }
        return output;
    }

    if (!value || typeof value !== 'object') {
        return output;
    }

    if (value.cache_control) {
        output.push(value.text ?? '<non-text>');
    }

    for (const [key, child] of Object.entries(value)) {
        if (key !== 'cache_control') {
            findCacheControlledTexts(child, output);
        }
    }

    return output;
}

function countCacheControls(value) {
    if (Array.isArray(value)) {
        return value.reduce((total, item) => total + countCacheControls(item), 0);
    }

    if (!value || typeof value !== 'object') {
        return 0;
    }

    return Object.entries(value).reduce(
        (total, [key, child]) => total + (key === 'cache_control' ? 1 : countCacheControls(child)),
        0,
    );
}

function findCacheControls(value, output = []) {
    if (Array.isArray(value)) {
        for (const item of value) {
            findCacheControls(item, output);
        }
        return output;
    }

    if (!value || typeof value !== 'object') {
        return output;
    }

    for (const [key, child] of Object.entries(value)) {
        if (key === 'cache_control') {
            output.push(child);
        } else {
            findCacheControls(child, output);
        }
    }

    return output;
}

function findPromptCacheControls(body) {
    return [
        ...findCacheControls(body?.tools),
        ...findCacheControls(body?.functions),
        ...findCacheControls(body?.system),
        ...findCacheControls(body?.messages),
    ];
}

function assertFinalUpstreamBody(request, expectedTexts = ['A', 'E', 'F', 'G']) {
    assert.equal(request.rawBody.includes(MARKER), false, 'the wire JSON must not contain cache markers');
    assert.equal(request.rawBody.includes(SHORT_MARKER), false, 'the wire JSON must not contain short cache markers');
    assert.ok(countCacheControls(request.body) <= 4, 'the wire JSON must contain at most four cache controls');
    const selectedPromptTexts = [
        ...findCacheControlledTexts(request.body?.system),
        ...findCacheControlledTexts(request.body?.messages),
    ];
    assert.deepEqual(
        selectedPromptTexts,
        expectedTexts,
        'fixed head 1 must preserve the first candidate and fill the remaining budget from the tail',
    );
}

function assertGatewayCacheTtl(request, expectedTtl) {
    const controls = findCacheControls(request.body);
    assert.ok(controls.length > 0, 'the test request must contain gateway cache controls');

    for (const control of controls) {
        assert.equal(control.type, 'ephemeral');
        if (expectedTtl === null) {
            assert.equal(
                Object.prototype.hasOwnProperty.call(control, 'ttl'),
                false,
                'Auto mode must omit cache_control.ttl',
            );
        } else {
            assert.equal(control.ttl, expectedTtl);
        }
    }
}

function writeJson(response, status, body) {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
}

function writeAnthropicSse(response, events) {
    response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
    });

    for (const event of events) {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }

    response.end();
}

async function startMockUpstream() {
    const requests = [];
    const server = createServer(async (request, response) => {
        try {
            const chunks = [];
            for await (const chunk of request) {
                chunks.push(chunk);
            }

            const rawBody = Buffer.concat(chunks).toString('utf8');
            const body = rawBody ? JSON.parse(rawBody) : null;
            requests.push({
                method: request.method,
                path: request.url,
                headers: { ...request.headers },
                rawBody,
                body,
            });

            if (request.url === '/v1/chat/completions') {
                writeJson(response, 200, {
                    id: 'chatcmpl-mock',
                    object: 'chat.completion',
                    created: 1,
                    model: body?.model,
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: 'ok' },
                        finish_reason: 'stop',
                    }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                });
                return;
            }

            if (request.url === '/v1/messages/count_tokens') {
                writeJson(response, 200, { input_tokens: 42 });
                return;
            }

            if (request.url === '/v1/messages') {
                if (['anthropic-thinking-model', 'anthropic-thinking-length-model'].includes(body?.model)) {
                    const stopReason = body.model === 'anthropic-thinking-length-model' ? 'max_tokens' : 'end_turn';
                    const content = [
                        { type: 'thinking', thinking: 'First thought. ', signature: 'opaque-thinking-signature' },
                        { type: 'redacted_thinking', data: 'opaque-redacted-thinking' },
                        { type: 'thinking', thinking: 'Second thought.', signature: 'opaque-second-signature' },
                        { type: 'text', text: 'Visible ' },
                        { type: 'text', text: 'answer.' },
                    ];

                    if (body.stream) {
                        writeAnthropicSse(response, [
                            {
                                type: 'message_start',
                                message: {
                                    id: 'msg_thinking_stream',
                                    type: 'message',
                                    role: 'assistant',
                                    model: body.model,
                                    content: [],
                                    usage: { input_tokens: 2, output_tokens: 0 },
                                },
                            },
                            {
                                type: 'content_block_start',
                                index: 0,
                                content_block: { type: 'thinking', thinking: '', signature: '' },
                            },
                            {
                                type: 'content_block_delta',
                                index: 0,
                                delta: { type: 'thinking_delta', thinking: 'Stream thought.' },
                            },
                            {
                                type: 'content_block_delta',
                                index: 0,
                                delta: { type: 'signature_delta', signature: 'opaque-stream-signature' },
                            },
                            { type: 'content_block_stop', index: 0 },
                            {
                                type: 'content_block_start',
                                index: 1,
                                content_block: { type: 'redacted_thinking', data: 'opaque-stream-redacted' },
                            },
                            { type: 'content_block_stop', index: 1 },
                            {
                                type: 'content_block_start',
                                index: 2,
                                content_block: { type: 'text', text: '' },
                            },
                            {
                                type: 'content_block_delta',
                                index: 2,
                                delta: { type: 'text_delta', text: 'Visible stream answer.' },
                            },
                            { type: 'content_block_stop', index: 2 },
                            {
                                type: 'message_delta',
                                delta: { stop_reason: stopReason, stop_sequence: null },
                                usage: { output_tokens: 4 },
                            },
                            { type: 'message_stop' },
                        ]);
                        return;
                    }

                    writeJson(response, 200, {
                        id: 'msg_thinking',
                        type: 'message',
                        role: 'assistant',
                        model: body.model,
                        content,
                        stop_reason: stopReason,
                        usage: { input_tokens: 2, output_tokens: 4 },
                    });
                    return;
                }

                writeJson(response, 200, {
                    id: 'msg_mock',
                    type: 'message',
                    role: 'assistant',
                    model: body?.model,
                    content: [{ type: 'text', text: 'ok' }],
                    stop_reason: 'end_turn',
                    usage: { input_tokens: 1, output_tokens: 1 },
                });
                return;
            }

            writeJson(response, 404, { error: `Unexpected mock path: ${request.url}` });
        } catch (error) {
            writeJson(response, 500, { error: error.message });
        }
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    return {
        requests,
        baseUrl: `http://127.0.0.1:${address.port}`,
        async close() {
            server.closeAllConnections?.();
            await new Promise((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
            });
        },
    };
}

async function getUnusedPort() {
    const server = createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
    return port;
}

function collectProcessOutput(child) {
    let output = '';
    const append = (chunk) => {
        output = `${output}${chunk}`.slice(-20_000);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    return () => output;
}

async function waitForGateway(baseUrl, child, getOutput) {
    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Gateway exited before becoming ready.\n${getOutput()}`);
        }

        try {
            const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
            if (response.ok) {
                return;
            }
        } catch {}

        await delay(50);
    }

    throw new Error(`Timed out waiting for the gateway.\n${getOutput()}`);
}

async function stopChild(child, exitPromise) {
    if (child.exitCode === null && child.signalCode === null) {
        child.kill();
    }

    await Promise.race([exitPromise, delay(3_000, undefined, { ref: false })]);

    if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await Promise.race([exitPromise, delay(3_000, undefined, { ref: false })]);
    }
}

async function startGatewayFixture({
    upstreamMode,
    policy = DEFAULT_POLICY,
    upstreamExtraJson = {},
    schemaVersion = 3,
    savedCacheTtl = 'provider-default',
    environmentCacheTtl = 'provider-default',
    autoGenerateCacheBreakpoints,
    autoGenerateCacheBreakpointsMode,
    captureRequests,
    systemMessageHandlingMode,
    moveSystemMessagesToTop,
}) {
    const upstream = await startMockUpstream();
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'st-cache-gateway-integration-'));
    const settingsPath = join(temporaryDirectory, 'gateway-settings.json');
    let child = null;
    let exitPromise = Promise.resolve();
    let closed = false;

    try {
        await Promise.all([
            copyFile(join(PROJECT_DIR, 'server.js'), join(temporaryDirectory, 'server.js')),
            copyFile(join(PROJECT_DIR, 'cache-policy.js'), join(temporaryDirectory, 'cache-policy.js')),
            writeFile(join(temporaryDirectory, 'package.json'), '{"type":"module"}\n'),
            writeFile(settingsPath, `${JSON.stringify({
                schemaVersion,
                cacheTranslationEnabled: true,
                cacheTtl: savedCacheTtl,
                ...policy,
                ...(autoGenerateCacheBreakpoints === undefined ? {} : { autoGenerateCacheBreakpoints }),
                ...(autoGenerateCacheBreakpointsMode === undefined ? {} : { autoGenerateCacheBreakpointsMode }),
                ...(captureRequests === undefined ? {} : { captureRequests }),
                ...(systemMessageHandlingMode === undefined ? {} : { systemMessageHandlingMode }),
                ...(moveSystemMessagesToTop === undefined ? {} : { moveSystemMessagesToTop }),
                activeChannelId: 'integration-upstream',
                channels: [{
                    id: 'integration-upstream',
                    name: 'Integration upstream',
                    kind: 'custom',
                    baseUrl: upstream.baseUrl,
                    upstreamMode,
                    upstreamExtraJson,
                    upstreamExcludePaths: [],
                    upstreamHeaders: {},
                    upstreamExcludeHeaders: [],
                }],
                upstreamMode,
                upstreamExtraJson,
                upstreamExcludePaths: [],
                upstreamHeaders: {},
                upstreamExcludeHeaders: [],
            }, null, 2)}\n`),
        ]);

        const port = await getUnusedPort();
        const environment = { ...process.env };
        for (const name of [
            'UPSTREAM_EXTRA_JSON',
            'UPSTREAM_EXCLUDE_PATHS',
            'UPSTREAM_HEADERS',
            'UPSTREAM_EXCLUDE_HEADERS',
            'UPSTREAM_API_KEY',
            'ANTHROPIC_BETA',
            'ANTHROPIC_VERSION',
            'CACHE_TTL',
        ]) {
            delete environment[name];
        }
        Object.assign(environment, {
            HOST: '127.0.0.1',
            PORT: String(port),
            UPSTREAM_BASE_URL: upstream.baseUrl,
            UPSTREAM_MODE: upstreamMode,
            CACHE_TRANSLATION_ENABLED: 'true',
        });

        if (environmentCacheTtl !== null) {
            environment.CACHE_TTL = environmentCacheTtl;
        }

        const baseUrl = `http://127.0.0.1:${port}`;

        const launchGateway = async () => {
            child = spawn(process.execPath, ['server.js'], {
                cwd: temporaryDirectory,
                env: environment,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
            exitPromise = new Promise((resolve) => child.once('exit', resolve));
            const getOutput = collectProcessOutput(child);
            await waitForGateway(baseUrl, child, getOutput);
        };

        await launchGateway();

        return {
            ...upstream,
            gatewayBaseUrl: baseUrl,
            settingsPath,
            async restart() {
                await stopChild(child, exitPromise);
                child = null;
                exitPromise = Promise.resolve();
                await launchGateway();
            },
            async close() {
                if (closed) {
                    return;
                }

                closed = true;
                if (child) {
                    await stopChild(child, exitPromise);
                }
                await upstream.close();
                await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
            },
        };
    } catch (error) {
        if (child) {
            await stopChild(child, exitPromise);
        }
        await upstream.close();
        await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        throw error;
    }
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    let body;

    try {
        body = JSON.parse(text);
    } catch {
        body = text;
    }

    assert.equal(response.ok, true, `${response.status} ${response.statusText}: ${text}`);
    return body;
}

function postJson(baseUrl, path, body) {
    return fetchJson(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function parseSseData(text) {
    return text
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))
        .map((data) => data === '[DONE]' ? data : JSON.parse(data));
}

test('OpenAI inbound -> OpenAI upstream sends the fixed-head final JSON', async (t) => {
    const fixture = await startGatewayFixture({ upstreamMode: 'openai' });
    t.after(() => fixture.close());

    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', markerBody());

    assert.equal(fixture.requests.length, 1);
    const request = fixture.requests[0];
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/v1/chat/completions');
    assertFinalUpstreamBody(request);
});

test('OpenAI inbound -> OpenAI upstream preserves message order except in global Top mode', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'openai',
        schemaVersion: 9,
        systemMessageHandlingMode: 'default',
    });
    t.after(() => fixture.close());

    const originalMessages = interleavedSystemOpenAiBody().messages;

    await postJson(
        fixture.gatewayBaseUrl,
        '/v1/chat/completions',
        interleavedSystemOpenAiBody('openai-system-default'),
    );
    assert.deepEqual(fixture.requests[0].body.messages, originalMessages);

    await postJson(fixture.gatewayBaseUrl, '/console/system-message-handling', { mode: 'off' });
    await postJson(
        fixture.gatewayBaseUrl,
        '/v1/chat/completions',
        interleavedSystemOpenAiBody('openai-system-off'),
    );
    assert.deepEqual(fixture.requests[1].body.messages, originalMessages);

    await postJson(fixture.gatewayBaseUrl, '/console/system-message-handling', { mode: 'top' });
    await postJson(
        fixture.gatewayBaseUrl,
        '/v1/chat/completions',
        interleavedSystemOpenAiBody('openai-system-top'),
    );
    assert.deepEqual(fixture.requests[2].body.messages, [
        { role: 'system', content: 'Leading system' },
        { role: 'system', content: 'Later system' },
        { role: 'user', content: 'First user' },
        { role: 'user', content: 'Adjacent user' },
        { role: 'assistant', content: 'First assistant' },
        { role: 'assistant', content: 'Adjacent assistant' },
        { role: 'user', content: 'Second user' },
        { role: 'user', content: 'Adjacent second user' },
    ]);
});

test('global Top hoists the final OpenAI messages after channel overrides without losing message metadata', async (t) => {
    const overriddenMessages = [
        { role: 'user', content: 'Override user', name: 'keep-user' },
        { role: 'system', content: 'Override system one', name: 'keep-system-one' },
        { role: 'assistant', content: 'Override assistant', name: 'keep-assistant' },
        {
            role: 'system',
            content: [{ type: 'text', text: 'Override system two' }],
            name: 'keep-system-two',
        },
    ];
    const fixture = await startGatewayFixture({
        upstreamMode: 'openai',
        schemaVersion: 9,
        systemMessageHandlingMode: 'top',
        upstreamExtraJson: { messages: overriddenMessages },
    });
    t.after(() => fixture.close());

    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', interleavedSystemOpenAiBody('openai-top-after-override'));

    assert.deepEqual(fixture.requests[0].body.messages, [
        overriddenMessages[1],
        overriddenMessages[3],
        overriddenMessages[0],
        overriddenMessages[2],
    ]);
});

test('schema 3 settings migrate automatic cache breaks to Off and request capture to disabled', async (t) => {
    const fixture = await startGatewayFixture({ upstreamMode: 'openai', schemaVersion: 3 });
    t.after(() => fixture.close());

    const state = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
    assert.equal(state.autoGenerateCacheBreakpoints, false);
    assert.equal(state.autoGenerateCacheBreakpointsMode, 'off');
    assert.equal(state.captureRequests, false);
    assert.equal(state.cacheTtl, 'auto');
});

test('schema 9 migrates the old automatic breakpoint boolean and persists the canonical mode', async (t) => {
    for (const testCase of [
        { name: 'legacy true becomes On', legacy: true, expected: 'on' },
        { name: 'legacy false becomes Off', legacy: false, expected: 'off' },
        { name: 'missing legacy setting becomes Off', legacy: undefined, expected: 'off' },
    ]) {
        await t.test(testCase.name, async () => {
            const fixture = await startGatewayFixture({
                upstreamMode: 'openai',
                schemaVersion: 5,
                autoGenerateCacheBreakpoints: testCase.legacy,
            });

            try {
                const state = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
                assert.equal(state.autoGenerateCacheBreakpointsMode, testCase.expected);
                assert.equal(state.autoGenerateCacheBreakpoints, testCase.expected !== 'off');

                await postJson(fixture.gatewayBaseUrl, '/console/capture', { enabled: false });
                const savedSettings = JSON.parse(await readFile(fixture.settingsPath, 'utf8'));
                assert.equal(savedSettings.schemaVersion, 9);
                assert.equal(savedSettings.autoGenerateCacheBreakpointsMode, testCase.expected);
                assert.equal(
                    Object.prototype.hasOwnProperty.call(savedSettings, 'autoGenerateCacheBreakpoints'),
                    false,
                    'schema 9 must persist only the canonical three-state field',
                );
            } finally {
                await fixture.close();
            }
        });
    }
});

test('schema 9 remaps schema 8 system-message modes to the corrected canonical meanings', async (t) => {
    for (const testCase of [
        { name: 'old Default becomes Default', legacy: 'default', expected: 'default' },
        { name: 'old Anthropic optimization becomes Default', legacy: 'anthropic', expected: 'default' },
        { name: 'old Top becomes Off', legacy: 'top', expected: 'off' },
    ]) {
        await t.test(testCase.name, async () => {
            const fixture = await startGatewayFixture({
                upstreamMode: 'anthropic',
                schemaVersion: 8,
                autoGenerateCacheBreakpointsMode: 'off',
                systemMessageHandlingMode: testCase.legacy,
            });

            try {
                const state = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
                assert.equal(state.systemMessageHandlingMode, testCase.expected);

                await postJson(fixture.gatewayBaseUrl, '/console/capture', { enabled: false });
                const savedSettings = JSON.parse(await readFile(fixture.settingsPath, 'utf8'));
                assert.equal(savedSettings.schemaVersion, 9);
                assert.equal(savedSettings.systemMessageHandlingMode, testCase.expected);
                assert.equal(
                    Object.prototype.hasOwnProperty.call(savedSettings, 'moveSystemMessagesToTop'),
                    false,
                    'schema 9 must persist only the canonical mode',
                );
            } finally {
                await fixture.close();
            }
        });
    }
});

test('schema 9 migrates schema 7 system-message booleans and persists only the canonical mode', async (t) => {
    for (const testCase of [
        { name: 'legacy true becomes Off', legacy: true, expected: 'off' },
        { name: 'legacy false becomes Default', legacy: false, expected: 'default' },
        { name: 'missing legacy setting becomes Default', legacy: undefined, expected: 'default' },
    ]) {
        await t.test(testCase.name, async () => {
            const fixture = await startGatewayFixture({
                upstreamMode: 'anthropic',
                schemaVersion: 7,
                autoGenerateCacheBreakpointsMode: 'off',
                moveSystemMessagesToTop: testCase.legacy,
            });

            try {
                const state = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
                assert.equal(state.systemMessageHandlingMode, testCase.expected);

                await postJson(fixture.gatewayBaseUrl, '/console/capture', { enabled: false });
                const savedSettings = JSON.parse(await readFile(fixture.settingsPath, 'utf8'));
                assert.equal(savedSettings.schemaVersion, 9);
                assert.equal(savedSettings.systemMessageHandlingMode, testCase.expected);
                assert.equal(
                    Object.prototype.hasOwnProperty.call(savedSettings, 'moveSystemMessagesToTop'),
                    false,
                    'schema 9 must not persist the legacy boolean field',
                );
            } finally {
                await fixture.close();
            }
        });
    }
});

test('system-message handling API strictly validates and persists every mode across restarts', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'anthropic',
        schemaVersion: 9,
        systemMessageHandlingMode: 'default',
    });
    t.after(() => fixture.close());

    for (const body of [
        {},
        [],
        { mode: null },
        { mode: true },
        { mode: 'anthropic' },
        { mode: 'optimized' },
        { mode: 'Top' },
        { mode: ' top ' },
    ]) {
        const response = await fetch(`${fixture.gatewayBaseUrl}/console/system-message-handling`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        assert.equal(response.status, 400, `body ${JSON.stringify(body)} must be rejected`);
    }

    let state = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
    assert.equal(state.systemMessageHandlingMode, 'default', 'invalid updates must not mutate the setting');

    for (const mode of ['off', 'top', 'default']) {
        state = await postJson(fixture.gatewayBaseUrl, '/console/system-message-handling', { mode });
        assert.equal(state.systemMessageHandlingMode, mode);

        const savedSettings = JSON.parse(await readFile(fixture.settingsPath, 'utf8'));
        assert.equal(savedSettings.schemaVersion, 9);
        assert.equal(savedSettings.systemMessageHandlingMode, mode);
        assert.equal(Object.prototype.hasOwnProperty.call(savedSettings, 'moveSystemMessagesToTop'), false);

        await fixture.restart();
        state = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
        assert.equal(state.systemMessageHandlingMode, mode);
    }
});

test('legacy system-message boolean API maps to canonical modes and keeps strict boolean validation', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'anthropic',
        schemaVersion: 9,
        systemMessageHandlingMode: 'default',
    });
    t.after(() => fixture.close());

    for (const body of [{}, [], { enabled: null }, { enabled: 1 }, { enabled: 'true' }]) {
        const response = await fetch(`${fixture.gatewayBaseUrl}/console/system-messages-to-top`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        assert.equal(response.status, 400, `body ${JSON.stringify(body)} must be rejected`);
    }

    let state = await postJson(fixture.gatewayBaseUrl, '/console/system-messages-to-top', { enabled: true });
    assert.equal(state.systemMessageHandlingMode, 'off');
    assert.equal(state.moveSystemMessagesToTop, true);

    state = await postJson(fixture.gatewayBaseUrl, '/console/system-messages-to-top', { enabled: false });
    assert.equal(state.systemMessageHandlingMode, 'default');
    assert.equal(state.moveSystemMessagesToTop, false);

    const savedSettings = JSON.parse(await readFile(fixture.settingsPath, 'utf8'));
    assert.equal(savedSettings.systemMessageHandlingMode, 'default');
    assert.equal(Object.prototype.hasOwnProperty.call(savedSettings, 'moveSystemMessagesToTop'), false);
});

test('changing system-message handling clears learned anchors and Prefix Lock content', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'anthropic',
        schemaVersion: 9,
        systemMessageHandlingMode: 'default',
        policy: {
            fixedHeadBreakpointCount: 1,
            cacheAnchorMode: 'single',
            cacheAnchorIntervalBlocks: 3,
        },
    });
    t.after(() => fixture.close());

    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', markerBody('system-order-anchor-clear'));
    let state = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
    assert.equal(state.cacheAnchorState.contextCount, 1);

    state = await postJson(fixture.gatewayBaseUrl, '/console/system-message-handling', { mode: 'off' });
    assert.equal(state.cacheAnchorState.contextCount, 0);

    await postJson(fixture.gatewayBaseUrl, '/console/prefix-lock', { enabled: true });
    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', markerBody('system-order-prefix-clear'));
    state = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
    assert.equal(state.prefixLockActive, true);

    state = await postJson(fixture.gatewayBaseUrl, '/console/system-message-handling', { mode: 'top' });
    assert.equal(state.prefixLockEnabled, true);
    assert.equal(state.prefixLockActive, false);
    assert.equal(state.prefixLockHash, null);
});

test('automatic breakpoint API validates mode atomically and accepts the legacy enabled boolean', async (t) => {
    const fixture = await startGatewayFixture({ upstreamMode: 'openai' });
    t.after(() => fixture.close());

    const automatic = await postJson(fixture.gatewayBaseUrl, '/console/auto-cache-breakpoints', { mode: 'auto' });
    assert.equal(automatic.autoGenerateCacheBreakpointsMode, 'auto');

    for (const body of [{}, { mode: 'sometimes' }, { mode: true }, { enabled: 'true' }]) {
        const response = await fetch(`${fixture.gatewayBaseUrl}/console/auto-cache-breakpoints`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        assert.equal(response.status, 400, `body ${JSON.stringify(body)} must be rejected`);
    }

    let state = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
    assert.equal(state.autoGenerateCacheBreakpointsMode, 'auto', 'invalid updates must not mutate the mode');

    const legacyOn = await postJson(fixture.gatewayBaseUrl, '/console/auto-cache-breakpoints', { enabled: true });
    assert.equal(legacyOn.autoGenerateCacheBreakpointsMode, 'on');
    const legacyOff = await postJson(fixture.gatewayBaseUrl, '/console/auto-cache-breakpoints', { enabled: false });
    assert.equal(legacyOff.autoGenerateCacheBreakpointsMode, 'off');

    const savedSettings = JSON.parse(await readFile(fixture.settingsPath, 'utf8'));
    assert.equal(savedSettings.schemaVersion, 9);
    assert.equal(savedSettings.autoGenerateCacheBreakpointsMode, 'off');
    state = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
    assert.equal(state.autoGenerateCacheBreakpoints, false);

    await postJson(fixture.gatewayBaseUrl, '/console/cache-policy', {
        fixedHeadBreakpointCount: 1,
        cacheAnchorMode: 'single',
        cacheAnchorIntervalBlocks: 3,
    });
    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', markerBody('mode-anchor-clear'));
    state = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
    assert.equal(state.cacheAnchorState.contextCount, 1);
    state = await postJson(fixture.gatewayBaseUrl, '/console/auto-cache-breakpoints', { mode: 'auto' });
    assert.equal(state.cacheAnchorState.contextCount, 0, 'changing generation mode must clear learned anchors');
});

test('TTL modes send no ttl for Auto and native ttl values for 5m and 1h', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'openai',
        schemaVersion: 4,
        savedCacheTtl: 'provider-default',
        environmentCacheTtl: null,
    });
    t.after(() => fixture.close());

    const initialState = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
    assert.equal(initialState.cacheTtl, 'auto');
    assert.deepEqual(initialState.cacheControl, { type: 'ephemeral' });

    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', markerBody('ttl-auto-initial'));
    assertGatewayCacheTtl(fixture.requests[0], null);

    const fiveMinutes = await postJson(fixture.gatewayBaseUrl, '/console/cache-ttl', { ttl: '5m' });
    assert.equal(fiveMinutes.cacheTtl, '5m');
    assert.deepEqual(fiveMinutes.cacheControl, { type: 'ephemeral', ttl: '5m' });
    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', markerBody('ttl-five-minutes'));
    assertGatewayCacheTtl(fixture.requests[1], '5m');

    const oneHour = await postJson(fixture.gatewayBaseUrl, '/console/cache-ttl', { ttl: '1h' });
    assert.equal(oneHour.cacheTtl, '1h');
    assert.deepEqual(oneHour.cacheControl, { type: 'ephemeral', ttl: '1h' });
    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', markerBody('ttl-one-hour'));
    assertGatewayCacheTtl(fixture.requests[2], '1h');

    const automatic = await postJson(fixture.gatewayBaseUrl, '/console/cache-ttl', { ttl: 'auto' });
    assert.equal(automatic.cacheTtl, 'auto');
    assert.deepEqual(automatic.cacheControl, { type: 'ephemeral' });
    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', markerBody('ttl-auto-final'));
    assertGatewayCacheTtl(fixture.requests[3], null);

    const savedSettings = JSON.parse(await readFile(fixture.settingsPath, 'utf8'));
    assert.equal(savedSettings.schemaVersion, 9);
    assert.equal(savedSettings.cacheTtl, 'auto');
});

test('Manual TTL maps long and short markers on all three final upstream request chains', async (t) => {
    const cases = [
        {
            name: 'OpenAI inbound to OpenAI upstream',
            upstreamMode: 'openai',
            path: '/v1/chat/completions',
            inboundPath: '/v1/chat/completions',
            body: manualOpenAiBody('manual-openai-wire'),
            expectedTexts: ['Stable system', 'Recent answer'],
        },
        {
            name: 'OpenAI inbound to Anthropic upstream',
            upstreamMode: 'anthropic',
            path: '/v1/messages',
            inboundPath: '/v1/chat/completions',
            body: manualOpenAiBody('manual-converted-wire'),
            expectedTexts: ['Stable system', 'Recent answer'],
        },
        {
            name: 'Anthropic native inbound',
            upstreamMode: 'anthropic',
            path: '/v1/messages',
            inboundPath: '/v1/messages',
            body: manualAnthropicBody('manual-native-wire'),
            expectedTexts: ['Stable native system', 'Recent native answer'],
        },
    ];

    for (const testCase of cases) {
        await t.test(testCase.name, async () => {
            const fixture = await startGatewayFixture({
                upstreamMode: testCase.upstreamMode,
                schemaVersion: 7,
                savedCacheTtl: 'manual',
                environmentCacheTtl: null,
            });

            try {
                const state = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
                assert.equal(state.cacheTtl, 'manual');
                assert.deepEqual(state.cacheControl, { type: 'ephemeral', ttl: '1h' });
                assert.deepEqual(state.shortCacheControl, { type: 'ephemeral', ttl: '5m' });

                await postJson(fixture.gatewayBaseUrl, testCase.inboundPath, testCase.body);
                assert.equal(fixture.requests.length, 1);
                const request = fixture.requests[0];
                assert.equal(request.path, testCase.path);
                assertFinalUpstreamBody(request, testCase.expectedTexts);
                assert.deepEqual(
                    findPromptCacheControls(request.body).map((control) => control.ttl),
                    ['1h', '5m'],
                );
            } finally {
                await fixture.close();
            }
        });
    }
});

test('non-Manual TTL modes apply the global TTL equally to long and short markers', async (t) => {
    const cases = [
        { ttl: 'auto', expected: [undefined, undefined] },
        { ttl: '5m', expected: ['5m', '5m'] },
        { ttl: '1h', expected: ['1h', '1h'] },
    ];

    for (const testCase of cases) {
        await t.test(testCase.ttl, async () => {
            const fixture = await startGatewayFixture({
                upstreamMode: 'openai',
                schemaVersion: 7,
                savedCacheTtl: testCase.ttl,
                environmentCacheTtl: null,
            });

            try {
                await postJson(
                    fixture.gatewayBaseUrl,
                    '/v1/chat/completions',
                    manualOpenAiBody(`uniform-${testCase.ttl}`),
                );
                assert.deepEqual(
                    findPromptCacheControls(fixture.requests[0].body).map((control) => control.ttl),
                    testCase.expected,
                );
            } finally {
                await fixture.close();
            }
        });
    }
});

test('Manual TTL rejects a short marker before a later long marker without contacting upstream', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'anthropic',
        schemaVersion: 7,
        savedCacheTtl: 'manual',
        environmentCacheTtl: null,
    });
    t.after(() => fixture.close());

    const body = manualAnthropicBody('manual-invalid-order');
    body.system[0].text = `Short first${SHORT_MARKER}`;
    body.messages[1].content[0].text = `Long later${MARKER}`;
    const response = await fetch(`${fixture.gatewayBaseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const responseBody = await response.json();

    assert.equal(response.status, 400);
    assert.equal(responseBody.code, 'CACHE_TTL_ORDER_INVALID');
    assert.equal(fixture.requests.length, 0);
});

test('changing TTL clears a learned Prefix Lock so cached controls cannot retain the old lifetime', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'openai',
        savedCacheTtl: '1h',
        environmentCacheTtl: null,
    });
    t.after(() => fixture.close());

    await postJson(fixture.gatewayBaseUrl, '/console/prefix-lock', { enabled: true });
    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', markerBody('ttl-prefix-lock'));
    let state = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
    assert.equal(state.prefixLockActive, true);

    state = await postJson(fixture.gatewayBaseUrl, '/console/cache-ttl', { ttl: '5m' });
    assert.equal(state.cacheTtl, '5m');
    assert.equal(state.prefixLockActive, false);
    assert.equal(state.prefixLockEnabled, true, 'TTL change should relearn rather than disable Prefix Lock');
});

test('explicit 5m TTL is applied to every gateway breakpoint after Anthropic conversion', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'anthropic',
        schemaVersion: 4,
        savedCacheTtl: '5m',
        environmentCacheTtl: null,
    });
    t.after(() => fixture.close());

    const state = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
    assert.equal(state.cacheTtl, '5m');
    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', markerBody('ttl-anthropic-five-minutes'));
    assert.equal(fixture.requests[0].path, '/v1/messages');
    assertGatewayCacheTtl(fixture.requests[0], '5m');
});

test('legacy default TTL aliases migrate to canonical Auto in state and saved settings', async (t) => {
    for (const legacyValue of ['', 'default', 'provider-default', 'none']) {
        await t.test(JSON.stringify(legacyValue), async () => {
            const fixture = await startGatewayFixture({
                upstreamMode: 'openai',
                schemaVersion: 4,
                savedCacheTtl: legacyValue,
                environmentCacheTtl: null,
            });

            try {
                const state = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
                assert.equal(state.cacheTtl, 'auto');
                assert.deepEqual(state.cacheControl, { type: 'ephemeral' });

                await postJson(fixture.gatewayBaseUrl, '/console/capture', { enabled: false });
                const savedSettings = JSON.parse(await readFile(fixture.settingsPath, 'utf8'));
                assert.equal(savedSettings.schemaVersion, 9);
                assert.equal(savedSettings.cacheTtl, 'auto');
            } finally {
                await fixture.close();
            }
        });
    }
});

test('unknown saved or environment TTL values safely fall back to Auto', async (t) => {
    const cases = [
        { name: 'saved setting', savedCacheTtl: '30m', environmentCacheTtl: null },
        { name: 'environment override', savedCacheTtl: '1h', environmentCacheTtl: '30m' },
    ];

    for (const testCase of cases) {
        await t.test(testCase.name, async () => {
            const fixture = await startGatewayFixture({
                upstreamMode: 'openai',
                schemaVersion: 4,
                ...testCase,
            });

            try {
                const state = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
                assert.equal(state.cacheTtl, 'auto');
                assert.deepEqual(state.cacheControl, { type: 'ephemeral' });
                await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', markerBody('ttl-invalid-fallback'));
                assertGatewayCacheTtl(fixture.requests[0], null);
            } finally {
                await fixture.close();
            }
        });
    }
});

test('cache TTL API rejects non-canonical and missing values without changing state', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'openai',
        savedCacheTtl: '1h',
        environmentCacheTtl: null,
    });
    t.after(() => fixture.close());

    for (const body of [
        {},
        { ttl: '' },
        { ttl: null },
        { ttl: 'provider-default' },
        { ttl: '30m' },
    ]) {
        const response = await fetch(`${fixture.gatewayBaseUrl}/console/cache-ttl`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        const responseBody = await response.json();
        assert.equal(response.status, 400, `body ${JSON.stringify(body)} must be rejected`);
        assert.match(responseBody.error, /auto, 5m, 1h, or manual/i);
    }

    const state = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
    assert.equal(state.cacheTtl, '1h');
    assert.deepEqual(state.cacheControl, { type: 'ephemeral', ttl: '1h' });
});

test('canonical TTL participates in anchor context isolation', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'openai',
        savedCacheTtl: 'auto',
        environmentCacheTtl: null,
        policy: {
            fixedHeadBreakpointCount: 1,
            cacheAnchorMode: 'single',
            cacheAnchorIntervalBlocks: 3,
        },
    });
    t.after(() => fixture.close());

    const body = markerBody('ttl-anchor-scope', 'ABCDEFG');
    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', body);
    let state = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
    assert.equal(state.cacheAnchorState.contextCount, 1);

    await postJson(fixture.gatewayBaseUrl, '/console/cache-ttl', { ttl: '5m' });
    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', body);
    state = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
    assert.equal(state.cacheAnchorState.contextCount, 2, '5m must use a distinct anchor scope from Auto');

    await postJson(fixture.gatewayBaseUrl, '/console/cache-ttl', { ttl: 'auto' });
    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', body);
    state = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
    assert.equal(state.cacheAnchorState.contextCount, 2, 'returning to Auto must reuse the canonical Auto scope');
});

test('OpenAI inbound -> OpenAI upstream auto-generates last-system and assistant candidates before H=1 selection', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'openai',
        schemaVersion: 4,
        autoGenerateCacheBreakpoints: true,
        captureRequests: false,
    });
    t.after(() => fixture.close());

    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', automaticOpenAiBody());

    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].path, '/v1/chat/completions');
    assertFinalUpstreamBody(fixture.requests[0], ['System last', 'A3', 'A4', 'A5']);
});

test('OpenAI inbound -> Anthropic upstream auto-generates candidates on the converted prompt before H=1 selection', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'anthropic',
        schemaVersion: 4,
        autoGenerateCacheBreakpoints: true,
        captureRequests: false,
    });
    t.after(() => fixture.close());

    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', automaticOpenAiBody('automatic-converted-model'));

    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].path, '/v1/messages');
    assertFinalUpstreamBody(fixture.requests[0], ['System last', 'A3', 'A4', 'A5']);
});

test('Anthropic native inbound auto-generates system and assistant candidates before H=1 selection', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'anthropic',
        schemaVersion: 4,
        autoGenerateCacheBreakpoints: true,
        captureRequests: false,
    });
    t.after(() => fixture.close());

    await postJson(fixture.gatewayBaseUrl, '/v1/messages', automaticAnthropicBody());

    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].path, '/v1/messages');
    assertFinalUpstreamBody(fixture.requests[0], ['Native system last', 'N-A3', 'N-A4', 'N-A5']);
});

test('rolling auto-generated breakpoints freeze the initial wire and replace only the oldest slot', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'openai',
        schemaVersion: 7,
        autoGenerateCacheBreakpointsMode: 'on',
        captureRequests: false,
        policy: {
            fixedHeadBreakpointCount: 1,
            cacheAnchorMode: 'rolling',
            cacheAnchorIntervalBlocks: 3,
        },
    });
    t.after(() => fixture.close());

    const first = automaticOpenAiBody('rolling-frozen-wire');
    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', first);
    assertFinalUpstreamBody(fixture.requests[0], ['System last', 'A3', 'A4', 'A5']);

    const belowInterval = structuredClone(first);
    belowInterval.messages.push(
        { role: 'user', content: [{ type: 'text', text: 'U6' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'A6' }] },
    );
    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', belowInterval);
    assertFinalUpstreamBody(
        fixture.requests[1],
        ['System last', 'A3', 'A4', 'A5'],
    );

    const reachesInterval = structuredClone(belowInterval);
    reachesInterval.messages.push(
        { role: 'user', content: [{ type: 'text', text: 'U7' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'A7' }] },
    );
    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', reachesInterval);
    assertFinalUpstreamBody(
        fixture.requests[2],
        ['System last', 'A4', 'A5', 'A7'],
    );

    const state = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
    assert.equal(state.cacheAnchorState.activeAnchorCount, 3);
});

test('Auto generation enables only when the final request has no explicit marker or cache control', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'openai',
        schemaVersion: 7,
        autoGenerateCacheBreakpointsMode: 'auto',
        captureRequests: true,
    });
    t.after(() => fixture.close());

    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', automaticOpenAiBody('adaptive-empty'));
    assertFinalUpstreamBody(fixture.requests[0], ['System last', 'A3', 'A4', 'A5']);
    let captureList = await fetchJson(`${fixture.gatewayBaseUrl}/console/requests`);
    let capture = await fetchJson(
        `${fixture.gatewayBaseUrl}/console/requests/${encodeURIComponent(captureList.requests[0].id)}`,
    );
    assert.equal(capture.gateway.autoGenerateCacheBreakpointsMode, 'auto');
    assert.equal(capture.gateway.autoGenerateCacheBreakpointsEffective, true);
    assert.equal(capture.gateway.cachePolicy.autoGeneratedBreakpoints.enabled, true);
    assert.equal(capture.gateway.cachePolicy.autoGeneratedBreakpoints.suppressionReason, null);

    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', manualOpenAiBody('adaptive-explicit-markers'));
    assertFinalUpstreamBody(fixture.requests[1], ['Stable system', 'Recent answer']);
    captureList = await fetchJson(`${fixture.gatewayBaseUrl}/console/requests`);
    capture = await fetchJson(
        `${fixture.gatewayBaseUrl}/console/requests/${encodeURIComponent(captureList.requests[0].id)}`,
    );
    assert.equal(capture.gateway.autoGenerateCacheBreakpointsMode, 'auto');
    assert.equal(capture.gateway.autoGenerateCacheBreakpointsEffective, false);
    assert.equal(capture.gateway.cachePolicy.autoGeneratedBreakpoints.explicitMarkerCount, 2);
    assert.equal(capture.gateway.cachePolicy.autoGeneratedBreakpoints.suppressionReason, 'explicit-marker');

    const callerControlled = automaticOpenAiBody('adaptive-existing-control');
    callerControlled.messages[0].content[0].cache_control = { type: 'ephemeral' };
    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', callerControlled);
    assert.equal(countCacheControls(fixture.requests[2].body), 1);
    captureList = await fetchJson(`${fixture.gatewayBaseUrl}/console/requests`);
    capture = await fetchJson(
        `${fixture.gatewayBaseUrl}/console/requests/${encodeURIComponent(captureList.requests[0].id)}`,
    );
    assert.equal(capture.gateway.autoGenerateCacheBreakpointsEffective, false);
    assert.equal(capture.gateway.cachePolicy.autoGeneratedBreakpoints.existingCacheControlCount, 1);
    assert.equal(capture.gateway.cachePolicy.autoGeneratedBreakpoints.suppressionReason, 'existing-cache-control');
});

test('request capture setting persists across a gateway restart while captures remain in-memory only', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'openai',
        schemaVersion: 4,
        autoGenerateCacheBreakpoints: false,
        captureRequests: false,
    });
    t.after(() => fixture.close());

    const enabled = await postJson(fixture.gatewayBaseUrl, '/console/capture', { enabled: true });
    assert.equal(enabled.captureRequests, true);

    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', markerBody('capture-persistence-model'));
    const beforeRestart = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
    assert.equal(beforeRestart.capturedRequests, 1);

    const savedSettings = JSON.parse(await readFile(fixture.settingsPath, 'utf8'));
    assert.equal(savedSettings.schemaVersion, 9);
    assert.equal(savedSettings.captureRequests, true, 'POST /console/capture must persist the setting');

    await fixture.restart();
    const afterRestart = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
    assert.equal(afterRestart.captureRequests, true);
    assert.equal(afterRestart.capturedRequests, 0, 'captured request bodies must not survive restart');
});

test('OpenAI inbound -> Anthropic upstream converts before applying the fixed-head policy', async (t) => {
    const fixture = await startGatewayFixture({ upstreamMode: 'anthropic' });
    t.after(() => fixture.close());

    const response = await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', markerBody());

    assert.equal(response.object, 'chat.completion');
    assert.equal(fixture.requests.length, 1);
    const request = fixture.requests[0];
    assert.equal(request.path, '/v1/messages');
    assert.equal(request.body.max_tokens, 32);
    assert.ok(request.headers['anthropic-version']);
    assertFinalUpstreamBody(request);
});

test('OpenAI inbound -> Anthropic applies the corrected system-message handling matrix in stable order', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'anthropic',
        schemaVersion: 9,
        systemMessageHandlingMode: 'default',
    });
    t.after(() => fixture.close());

    const initialState = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
    assert.equal(initialState.systemMessageHandlingMode, 'default');

    await postJson(
        fixture.gatewayBaseUrl,
        '/v1/chat/completions',
        interleavedSystemOpenAiBody('interleaved-system-default'),
    );
    assert.deepEqual(fixture.requests[0].body.system, [
        { type: 'text', text: 'Leading system' },
    ]);
    assert.deepEqual(fixture.requests[0].body.messages, [
        {
            role: 'user',
            content: [
                { type: 'text', text: 'First user' },
                { type: 'text', text: 'Adjacent user' },
            ],
        },
        {
            role: 'assistant',
            content: [
                { type: 'text', text: 'First assistant' },
                { type: 'text', text: 'Adjacent assistant' },
            ],
        },
        {
            role: 'user',
            content: [
                { type: 'text', text: 'Later system' },
                { type: 'text', text: 'Second user' },
                { type: 'text', text: 'Adjacent second user' },
            ],
        },
    ]);

    await postJson(fixture.gatewayBaseUrl, '/console/system-message-handling', { mode: 'off' });
    await postJson(
        fixture.gatewayBaseUrl,
        '/v1/chat/completions',
        interleavedSystemOpenAiBody('interleaved-system-off'),
    );
    assert.deepEqual(fixture.requests[1].body.system, [
        { type: 'text', text: 'Leading system' },
        { type: 'text', text: 'Later system' },
    ]);
    assert.deepEqual(fixture.requests[1].body.messages, [
        { role: 'user', content: 'First user' },
        { role: 'user', content: 'Adjacent user' },
        { role: 'assistant', content: 'First assistant' },
        { role: 'assistant', content: 'Adjacent assistant' },
        { role: 'user', content: 'Second user' },
        { role: 'user', content: 'Adjacent second user' },
    ]);

    await postJson(fixture.gatewayBaseUrl, '/console/system-message-handling', { mode: 'top' });
    await postJson(
        fixture.gatewayBaseUrl,
        '/v1/chat/completions',
        interleavedSystemOpenAiBody('interleaved-system-top'),
    );
    assert.deepEqual(fixture.requests[2].body.system, [
        { type: 'text', text: 'Leading system' },
        { type: 'text', text: 'Later system' },
    ]);
    assert.deepEqual(fixture.requests[2].body.messages, [
        { role: 'user', content: 'First user' },
        { role: 'user', content: 'Adjacent user' },
        { role: 'assistant', content: 'First assistant' },
        { role: 'assistant', content: 'Adjacent assistant' },
        { role: 'user', content: 'Second user' },
        { role: 'user', content: 'Adjacent second user' },
    ]);
});

test('Anthropic native inbound remains unchanged in every system-message handling mode', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'anthropic',
        schemaVersion: 9,
        systemMessageHandlingMode: 'default',
    });
    t.after(() => fixture.close());

    const system = [
        { type: 'text', text: 'Native system first' },
        { type: 'text', text: 'Native system second' },
    ];
    const messages = [
        { role: 'user', content: 'Native user first' },
        { role: 'user', content: 'Native user second' },
        { role: 'assistant', content: 'Native assistant first' },
        { role: 'assistant', content: 'Native assistant second' },
    ];

    for (const [index, mode] of ['default', 'off', 'top'].entries()) {
        if (mode !== 'default') {
            await postJson(fixture.gatewayBaseUrl, '/console/system-message-handling', { mode });
        }

        await postJson(fixture.gatewayBaseUrl, '/v1/messages', {
            model: `native-system-${mode}`,
            max_tokens: 32,
            system,
            messages,
        });

        assert.equal(fixture.requests[index].path, '/v1/messages');
        assert.deepEqual(fixture.requests[index].body.system, system);
        assert.deepEqual(fixture.requests[index].body.messages, messages);
    }
});

test('default Anthropic optimization preserves block order and cache controls while absorbing empty same-role messages', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'anthropic',
        schemaVersion: 9,
        systemMessageHandlingMode: 'default',
    });
    t.after(() => fixture.close());

    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', {
        model: 'anthropic-optimized-blocks',
        max_tokens: 32,
        messages: [
            { role: 'system', content: 'Leading system' },
            { role: 'user', content: '' },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'First user block', cache_control: { type: 'ephemeral' } },
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
                ],
            },
            { role: 'user', content: MARKER },
            {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'Keep this opaque block.', signature: 'test-signature' },
                    { type: 'text', text: 'Assistant answer' },
                ],
            },
            { role: 'assistant', content: '' },
        ],
    });

    assert.deepEqual(fixture.requests[0].body.system, [
        { type: 'text', text: 'Leading system' },
    ]);
    assert.deepEqual(fixture.requests[0].body.messages, [
        {
            role: 'user',
            content: [
                { type: 'text', text: 'First user block', cache_control: { type: 'ephemeral' } },
                {
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/png', data: 'AA==' },
                    cache_control: { type: 'ephemeral' },
                },
            ],
        },
        {
            role: 'assistant',
            content: [
                { type: 'thinking', thinking: 'Keep this opaque block.', signature: 'test-signature' },
                { type: 'text', text: 'Assistant answer' },
            ],
        },
    ]);
});

test('OpenAI inbound -> Anthropic non-stream response exposes thinking as reasoning_content', async (t) => {
    const fixture = await startGatewayFixture({ upstreamMode: 'anthropic' });
    t.after(() => fixture.close());

    const requestBody = {
        model: 'anthropic-thinking-model',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'Think before answering.' }],
    };
    const response = await fetchJson(`${fixture.gatewayBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'anthropic-beta': 'interleaved-thinking-2025-05-14',
        },
        body: JSON.stringify(requestBody),
    });

    assert.deepEqual(response.choices[0].message, {
        role: 'assistant',
        content: 'Visible answer.',
        reasoning_content: 'First thought. Second thought.',
    });
    assert.equal(response.choices[0].finish_reason, 'stop');
    assert.equal(
        JSON.stringify(response.choices[0].message).includes('opaque-'),
        false,
        'opaque signatures and redacted thinking must not be rendered as visible reasoning',
    );
    assert.equal(fixture.requests[0].headers['anthropic-beta'], 'interleaved-thinking-2025-05-14');

    const nativeResponse = await postJson(fixture.gatewayBaseUrl, '/v1/messages', requestBody);
    assert.deepEqual(
        nativeResponse.content.map((block) => block.type),
        ['thinking', 'redacted_thinking', 'thinking', 'text', 'text'],
        'Anthropic native responses must continue to pass every thinking block through unchanged',
    );
    assert.equal(nativeResponse.content[0].signature, 'opaque-thinking-signature');
    assert.equal(nativeResponse.content[1].data, 'opaque-redacted-thinking');
});

test('OpenAI inbound -> Anthropic stream separates thinking_delta from visible content', async (t) => {
    const fixture = await startGatewayFixture({ upstreamMode: 'anthropic', captureRequests: true });
    t.after(() => fixture.close());

    const requestBody = {
        model: 'anthropic-thinking-model',
        max_tokens: 32,
        stream: true,
        messages: [{ role: 'user', content: 'Think before answering.' }],
    };
    const response = await fetch(`${fixture.gatewayBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
    });
    const streamText = await response.text();
    const payloads = parseSseData(streamText);
    const chunks = payloads.filter((payload) => payload !== '[DONE]');
    const reasoning = chunks.map((chunk) => chunk.choices[0].delta.reasoning_content || '').join('');
    const content = chunks.map((chunk) => chunk.choices[0].delta.content || '').join('');
    const finishChunks = chunks.filter((chunk) => chunk.choices[0].finish_reason !== null);

    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.equal(reasoning, 'Stream thought.');
    assert.equal(content, 'Visible stream answer.');
    assert.equal(finishChunks.length, 1);
    assert.deepEqual(finishChunks[0].choices[0], {
        index: 0,
        delta: {},
        finish_reason: 'stop',
    });
    assert.equal(payloads.at(-2), finishChunks[0]);
    assert.equal(payloads.at(-1), '[DONE]');
    assert.equal(
        JSON.stringify(chunks).includes('opaque-'),
        false,
        'signature_delta and redacted_thinking must not be exposed as reasoning text',
    );
    assert.ok(
        chunks.every((chunk) => !(
            typeof chunk.choices[0].delta.reasoning_content === 'string'
            && typeof chunk.choices[0].delta.content === 'string'
        )),
        'each converted delta must contain either reasoning or visible content, never both',
    );

    const captureList = await fetchJson(`${fixture.gatewayBaseUrl}/console/requests`);
    assert.equal(captureList.requests.length, 1);
    const capture = await fetchJson(
        `${fixture.gatewayBaseUrl}/console/requests/${encodeURIComponent(captureList.requests[0].id)}`,
    );
    assert.equal(capture.response.usage.outputTokens, 4, 'message_delta usage must still be captured');

    const truncatedResponse = await fetch(`${fixture.gatewayBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...requestBody, model: 'anthropic-thinking-length-model' }),
    });
    const truncatedPayloads = parseSseData(await truncatedResponse.text());
    const truncatedFinishChunks = truncatedPayloads
        .filter((payload) => payload !== '[DONE]')
        .filter((chunk) => chunk.choices[0].finish_reason !== null);
    assert.equal(truncatedFinishChunks.length, 1);
    assert.equal(truncatedFinishChunks[0].choices[0].finish_reason, 'length');
    assert.deepEqual(truncatedFinishChunks[0].choices[0].delta, {});
    assert.equal(truncatedPayloads.at(-2), truncatedFinishChunks[0]);
    assert.equal(truncatedPayloads.at(-1), '[DONE]');

    const nativeResponse = await fetch(`${fixture.gatewayBaseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
    });
    const nativeStreamText = await nativeResponse.text();
    assert.match(nativeStreamText, /"type":"thinking_delta","thinking":"Stream thought\."/);
    assert.match(nativeStreamText, /"type":"signature_delta","signature":"opaque-stream-signature"/);
    assert.match(nativeStreamText, /"type":"redacted_thinking","data":"opaque-stream-redacted"/);
});

test('OpenAI inbound -> Anthropic upstream selects breakpoints after channel JSON is merged', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'anthropic',
        upstreamExtraJson: {
            system: [{ type: 'text', text: `S${MARKER}` }],
        },
    });
    t.after(() => fixture.close());

    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', markerBody());

    assert.equal(fixture.requests.length, 1);
    const request = fixture.requests[0];
    assert.equal(request.path, '/v1/messages');
    assert.equal(request.body.system[0].text, 'S');
    assertFinalUpstreamBody(request, ['S', 'E', 'F', 'G']);
});

test('default Anthropic optimization merges consecutive roles after channel JSON overrides the messages array', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'anthropic',
        schemaVersion: 9,
        systemMessageHandlingMode: 'default',
        upstreamExtraJson: {
            messages: [
                { role: 'user', content: 'Override user one' },
                { role: 'user', content: [{ type: 'text', text: 'Override user two' }] },
                { role: 'assistant', content: 'Override assistant one' },
                { role: 'assistant', content: 'Override assistant two' },
            ],
        },
    });
    t.after(() => fixture.close());

    await postJson(fixture.gatewayBaseUrl, '/v1/chat/completions', interleavedSystemOpenAiBody('optimized-after-override'));

    assert.deepEqual(fixture.requests[0].body.messages, [
        {
            role: 'user',
            content: [
                { type: 'text', text: 'Override user one' },
                { type: 'text', text: 'Override user two' },
            ],
        },
        {
            role: 'assistant',
            content: [
                { type: 'text', text: 'Override assistant one' },
                { type: 'text', text: 'Override assistant two' },
            ],
        },
    ]);
});

test('OpenAI inbound -> Anthropic rejects an invalid messages override before contacting upstream', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'anthropic',
        upstreamExtraJson: { messages: null },
    });
    t.after(() => fixture.close());

    const response = await fetch(`${fixture.gatewayBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(markerBody()),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.code, 'INVALID_FINAL_MESSAGES');
    assert.match(body.error, /messages array/i);
    assert.equal(fixture.requests.length, 0, 'invalid merged JSON must never reach the upstream');
});

test('Anthropic wire rejects a gateway-generated 1h breakpoint after a caller-owned implicit 5m breakpoint', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'anthropic',
        savedCacheTtl: '1h',
        environmentCacheTtl: null,
    });
    t.after(() => fixture.close());

    const requestBody = markerBody('mixed-ttl-wire-rejection');
    requestBody.messages[0].content[0].cache_control = { type: 'ephemeral' };
    const response = await fetch(`${fixture.gatewayBaseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
    });
    const responseBody = await response.json();

    assert.equal(response.status, 400);
    assert.equal(responseBody.code, 'CACHE_TTL_ORDER_INVALID');
    assert.match(responseBody.error, /1h cache_control.*after 5m cache_control/i);
    assert.equal(responseBody.details.firstFiveMinutePath, 'messages[0].content[0].cache_control');
    assert.equal(responseBody.details.laterOneHourPath, 'messages[4].content[0].cache_control');
    assert.deepEqual(responseBody.details.paths, [
        'messages[0].content[0].cache_control',
        'messages[4].content[0].cache_control',
        'messages[5].content[0].cache_control',
        'messages[6].content[0].cache_control',
    ]);
    assert.equal(fixture.requests.length, 0, 'invalid mixed TTL order must never reach the upstream wire');
});

test('Anthropic native inbound selects breakpoints after channel JSON is merged', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'anthropic',
        upstreamExtraJson: {
            system: [{ type: 'text', text: `S${MARKER}` }],
        },
    });
    t.after(() => fixture.close());

    await postJson(fixture.gatewayBaseUrl, '/v1/messages', markerBody('native-merged-model'));

    assert.equal(fixture.requests.length, 1);
    const request = fixture.requests[0];
    assert.equal(request.path, '/v1/messages');
    assert.equal(request.body.system[0].text, 'S');
    assertFinalUpstreamBody(request, ['S', 'E', 'F', 'G']);
});

test('Anthropic count_tokens does not commit anchors before native Anthropic forwarding', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'anthropic',
        upstreamExtraJson: {
            system: [{ type: 'text', text: `S${MARKER}` }],
        },
        policy: {
            fixedHeadBreakpointCount: 1,
            cacheAnchorMode: 'single',
            cacheAnchorIntervalBlocks: 3,
        },
    });
    t.after(() => fixture.close());

    const before = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
    assert.equal(before.cacheAnchorState.contextCount, 0);

    const body = markerBody('native-anthropic-model');
    const tokenCount = await postJson(fixture.gatewayBaseUrl, '/v1/messages/count_tokens', body);
    assert.equal(tokenCount.input_tokens, 42);
    assert.equal(fixture.requests[0].path, '/v1/messages/count_tokens');
    assertFinalUpstreamBody(fixture.requests[0], ['S', 'E', 'F', 'G']);

    const afterCount = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
    assert.equal(afterCount.cacheAnchorState.contextCount, 0, 'count_tokens must not learn an anchor');
    assert.equal(afterCount.cacheAnchorState.activeAnchorCount, 0);

    const response = await postJson(fixture.gatewayBaseUrl, '/v1/messages', body);
    assert.equal(response.type, 'message');
    assert.equal(fixture.requests[1].path, '/v1/messages');
    assertFinalUpstreamBody(fixture.requests[1], ['S', 'E', 'F', 'G']);

    const afterMessage = await fetchJson(`${fixture.gatewayBaseUrl}/console/state`);
    assert.equal(afterMessage.cacheAnchorState.contextCount, 1, 'a successful model request must learn the anchor');
    assert.equal(afterMessage.cacheAnchorState.activeAnchorCount, 1);
});

test('single mode learns the first non-fixed breakpoint that actually survived the initial budget', async (t) => {
    const fixture = await startGatewayFixture({
        upstreamMode: 'openai',
        policy: {
            fixedHeadBreakpointCount: 1,
            cacheAnchorMode: 'single',
            cacheAnchorIntervalBlocks: 3,
        },
    });
    t.after(() => fixture.close());

    await postJson(fixture.gatewayBaseUrl, '/console/capture', { enabled: true });

    await postJson(
        fixture.gatewayBaseUrl,
        '/v1/chat/completions',
        markerBody('selected-anchor-regression', 'ABCDEFG'),
    );
    assertFinalUpstreamBody(fixture.requests[0], ['A', 'E', 'F', 'G']);

    await postJson(
        fixture.gatewayBaseUrl,
        '/v1/chat/completions',
        markerBody('selected-anchor-regression', 'ABCDEFGHIJ'),
    );
    assert.equal(fixture.requests[1].rawBody.includes(MARKER), false);
    assert.ok(countCacheControls(fixture.requests[1].body) <= 4);

    const captureList = await fetchJson(`${fixture.gatewayBaseUrl}/console/requests`);
    assert.equal(captureList.requests.length, 2);
    const secondCapture = await fetchJson(
        `${fixture.gatewayBaseUrl}/console/requests/${encodeURIComponent(captureList.requests[0].id)}`,
    );
    const candidates = secondCapture.gateway.cachePolicy.candidates;
    const firstSurvivingTail = candidates.find((candidate) => candidate.logicalIndex === 5);
    const initialLastCandidate = candidates.find((candidate) => candidate.logicalIndex === 7);

    assert.ok(firstSurvivingTail, 'the second capture must include the original E boundary');
    assert.ok(initialLastCandidate, 'the second capture must include the original G boundary');
    assert.equal(
        firstSurvivingTail.reasons.includes('active-anchor'),
        true,
        `E was the first non-fixed breakpoint in the initial A/E/F/G wire plan and must become the anchor; E reasons=${firstSurvivingTail.reasons.join(',')}, G reasons=${initialLastCandidate.reasons.join(',')}`,
    );
    assert.equal(firstSurvivingTail.selected, true);
    assert.equal(
        initialLastCandidate.reasons.includes('active-anchor'),
        false,
        'G must not become the anchor merely because it was the last marker candidate in the first request',
    );
});

test('cache policy API is atomic and mutually exclusive with Prefix Lock', async (t) => {
    const fixture = await startGatewayFixture({ upstreamMode: 'openai' });
    t.after(() => fixture.close());

    const anchored = await postJson(fixture.gatewayBaseUrl, '/console/cache-policy', {
        fixedHeadBreakpointCount: 1,
        cacheAnchorMode: 'rolling',
        cacheAnchorIntervalBlocks: 3,
    });
    assert.equal(anchored.cacheAnchorMode, 'rolling');
    assert.equal(anchored.prefixLockEnabled, false);

    const locked = await postJson(fixture.gatewayBaseUrl, '/console/prefix-lock', { enabled: true });
    assert.equal(locked.prefixLockEnabled, true);
    assert.equal(locked.cacheAnchorMode, 'off');
    assert.equal(locked.cacheAnchorState.contextCount, 0);

    const single = await postJson(fixture.gatewayBaseUrl, '/console/cache-policy', {
        fixedHeadBreakpointCount: 1,
        cacheAnchorMode: 'single',
        cacheAnchorIntervalBlocks: 3,
    });
    assert.equal(single.cacheAnchorMode, 'single');
    assert.equal(single.prefixLockEnabled, false);

    const invalid = await fetch(`${fixture.gatewayBaseUrl}/console/cache-policy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cacheAnchorMode: 'off' }),
    });
    assert.equal(invalid.status, 400, 'partial policy updates must be rejected');
});
