import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const MARKER = '[[CACHE_BREAK]]';
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

function assertFinalUpstreamBody(request, expectedTexts = ['A', 'E', 'F', 'G']) {
    assert.equal(request.rawBody.includes(MARKER), false, 'the wire JSON must not contain cache markers');
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

function writeJson(response, status, body) {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
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

async function startGatewayFixture({ upstreamMode, policy = DEFAULT_POLICY, upstreamExtraJson = {} }) {
    const upstream = await startMockUpstream();
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'st-cache-gateway-integration-'));
    let child = null;
    let exitPromise = Promise.resolve();

    try {
        await Promise.all([
            copyFile(join(PROJECT_DIR, 'server.js'), join(temporaryDirectory, 'server.js')),
            copyFile(join(PROJECT_DIR, 'cache-policy.js'), join(temporaryDirectory, 'cache-policy.js')),
            writeFile(join(temporaryDirectory, 'package.json'), '{"type":"module"}\n'),
            writeFile(join(temporaryDirectory, 'gateway-settings.json'), `${JSON.stringify({
                schemaVersion: 3,
                cacheTranslationEnabled: true,
                cacheTtl: 'provider-default',
                ...policy,
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
        ]) {
            delete environment[name];
        }
        Object.assign(environment, {
            HOST: '127.0.0.1',
            PORT: String(port),
            UPSTREAM_BASE_URL: upstream.baseUrl,
            UPSTREAM_MODE: upstreamMode,
            CACHE_TRANSLATION_ENABLED: 'true',
            CACHE_TTL: 'provider-default',
        });

        child = spawn(process.execPath, ['server.js'], {
            cwd: temporaryDirectory,
            env: environment,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        exitPromise = new Promise((resolve) => child.once('exit', resolve));
        const getOutput = collectProcessOutput(child);
        const baseUrl = `http://127.0.0.1:${port}`;
        await waitForGateway(baseUrl, child, getOutput);

        return {
            ...upstream,
            gatewayBaseUrl: baseUrl,
            async close() {
                await stopChild(child, exitPromise);
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
