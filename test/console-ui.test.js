import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const consoleCss = readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');

function fakeElement(tagName) {
    return {
        tagName,
        className: '',
        dataset: {},
        textContent: '',
        children: [],
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        append(...children) {
            this.children.push(...children);
        },
        replaceChildren(...children) {
            this.children = [...children];
        },
    };
}

function loadConsoleHelpers() {
    const consolePath = new URL('../public/console.js', import.meta.url);
    const source = readFileSync(consolePath, 'utf8');
    const withoutBootstrap = source.replace(
        /\r?\nbindEvents\(\);\r?\nbindMobileMenuScroll\(\);[\s\S]*$/,
        '',
    );
    assert.notEqual(withoutBootstrap, source, 'console bootstrap must be stripped for isolated helper tests');

    const context = vm.createContext({
        console,
        document: {
            createElement: fakeElement,
            createTextNode: (value) => ({ nodeType: 3, textContent: String(value) }),
        },
    });
    vm.runInContext(`${withoutBootstrap}\n;globalThis.__helpers = {\n`
        + 'tableCell, countCharacters, getOrderedBodySegments, groupBodySegmentsForDisplay, displayGroupCharacterCount, '
        + 'promptTokensFromUsage, usageStatistics, usageRateLabel, renderUsageLines, getPromptTokenEstimate, renderRequestBodyStream, '
        + 'getBlockHashEntries, estimatedTokens, promptEstimateLabel, inputPromptTokenLabel, systemMessageHandlingMode, systemMessageHandlingLabel\n};', context);
    return context.__helpers;
}

const helpers = loadConsoleHelpers();

function elementsByClass(root, className) {
    const matches = [];
    const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        if (String(node.className || '').split(/\s+/).includes(className)) matches.push(node);
        for (const child of node.children || []) visit(child);
    };
    visit(root);
    return matches;
}

test('request-log container cells keep explicit empty strings empty', () => {
    const row = fakeElement('tr');
    const cell = helpers.tableCell(row, '', 'log-action-cell', '详情');

    assert.equal(cell.textContent, '');
    assert.equal(cell.className, 'log-action-cell');
    assert.equal(cell.dataset.label, '详情');
    assert.equal(row.children[0], cell);
});

test('Anthropic prompt tokens include uncached, cache-read and cache-created input', () => {
    const segments = Array.from({ length: 5 }, () => ({ text: '字'.repeat(2000) }));
    const usage = {
        inputTokens: 4000,
        anthropicCacheCreationInputTokens: 8000,
        anthropicCacheReadInputTokens: 16000,
        cachedTokens: 16000,
        cacheReadTokens: 16000,
    };

    assert.equal(helpers.promptTokensFromUsage(usage, 'anthropic'), 28000);
    const estimate = helpers.getPromptTokenEstimate(segments, usage, 'anthropic');
    assert.equal(estimate.totalCharacters, 10000);
    assert.equal(estimate.tokensPerCharacter, 2.8);
    assert.deepEqual(Array.from(estimate.characterCounts), [2000, 2000, 2000, 2000, 2000]);
    assert.equal(helpers.estimatedTokens(estimate.characterCounts[0], estimate.tokensPerCharacter), 5600);
    assert.equal(helpers.promptEstimateLabel(2000, 5600), '2000字符 | 约5600token');
    assert.equal(helpers.inputPromptTokenLabel(estimate.promptTokens), '28000 token');
    assert.equal(helpers.inputPromptTokenLabel(null), '暂不可用');
});

test('OpenAI prompt tokens do not add Anthropic cache fields', () => {
    const usage = {
        inputTokens: 4000,
        anthropicCacheCreationInputTokens: 8000,
        anthropicCacheReadInputTokens: 16000,
    };

    assert.equal(helpers.promptTokensFromUsage(usage, 'openai'), 4000);
    assert.equal(helpers.promptTokensFromUsage(usage), 4000);
    assert.equal(helpers.getPromptTokenEstimate([{ text: '字'.repeat(2000) }], usage, 'openai').tokensPerCharacter, 2);
});

test('Anthropic message content blocks form one display card without changing the token denominator', () => {
    const body = {
        system: [{ type: 'text', text: '系统规则' }],
        messages: [
            {
                role: 'user',
                content: [
                    { type: 'text', text: '第一段' },
                    { type: 'text', text: '第二段', cache_control: { type: 'ephemeral' } },
                    { type: 'tool_result', tool_use_id: 'tool-1', content: '工具结果' },
                ],
            },
            { role: 'assistant', content: [{ type: 'text', text: '回答' }] },
        ],
    };
    const segments = helpers.getOrderedBodySegments(body, 'anthropic');
    const groups = helpers.groupBodySegmentsForDisplay(segments);
    const messageGroups = groups.filter((group) => group.messageIndex !== null);

    assert.equal(segments.length, 5);
    assert.equal(groups.length, 3, 'top-level system keeps its own card and each message gets one card');
    assert.equal(messageGroups.length, 2);
    assert.deepEqual(Array.from(messageGroups[0].segments, (segment) => segment.path), [
        'messages[0].content[0]',
        'messages[0].content[1]',
        'messages[0].content[2]',
    ]);
    assert.equal(messageGroups[0].role, 'user');
    assert.equal(messageGroups[0].label, 'messages[0] · 3 blocks');

    const flatCharacterCount = helpers.getPromptTokenEstimate(segments, { inputTokens: 100 }, 'anthropic').totalCharacters;
    const groupedCharacterCount = groups.reduce(
        (sum, group) => sum + helpers.displayGroupCharacterCount(group),
        0,
    );
    assert.equal(groupedCharacterCount, flatCharacterCount, 'grouping must count every block exactly once');
});

test('request-body renderer keeps block paths and cache dividers inside one message card', () => {
    const capture = {
        upstream: {
            mode: 'anthropic',
            body: {
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: '第一段' },
                        { type: 'text', text: '第二段', cache_control: { type: 'ephemeral' } },
                        { type: 'text', text: '第三段' },
                    ],
                }, {
                    role: 'assistant',
                    content: [{ type: 'text', text: '无断点回答' }],
                }],
            },
            cache: {
                breakpoints: [{ path: 'messages[0].content[1].cache_control' }],
                prefixHash: '1234567890abcdef',
            },
        },
        gateway: {
            upstreamMode: 'anthropic',
            cacheTtl: 'auto',
            cachePolicy: {
                selectedBreakpoints: [{
                    path: 'messages[0].content[1]',
                    reason: 'existing-cache-control',
                    prefixHash: '1234567890abcdef',
                }],
            },
        },
        response: { usage: { inputTokens: 10 } },
    };
    const root = fakeElement('div');

    helpers.renderRequestBodyStream(root, capture);

    const cards = elementsByClass(root, 'msg-card');
    assert.equal(cards.length, 2);
    assert.ok(elementsByClass(cards[0], 'has-cache-breakpoints').length === 1);
    assert.ok(elementsByClass(cards[1], 'has-cache-breakpoints').length === 0);
    assert.equal(elementsByClass(cards[1], 'cache-divider').length, 0);
    const blocks = elementsByClass(cards[0], 'msg-content-block');
    assert.equal(blocks.length, 3);
    assert.deepEqual(blocks.map((block) => block.dataset.path), [
        'messages[0].content[0]',
        'messages[0].content[1]',
        'messages[0].content[2]',
    ]);
    const dividers = elementsByClass(cards[0], 'cache-divider');
    assert.equal(dividers.length, 1);
    assert.ok(elementsByClass(dividers[0], 'cache-sub')[0].textContent.includes('messages[0].content[1]'));
    const messageBody = elementsByClass(cards[0], 'msg-body')[0];
    assert.ok(messageBody.children.includes(dividers[0]), 'divider must remain outside the hidden content block');
    assert.equal(blocks.some((block) => elementsByClass(block, 'cache-divider').length > 0), false);
});

test('collapsed message cards keep cache dividers visible while ordinary bodies stay hidden', () => {
    assert.match(consoleCss, /\.msg-card\.collapsed:not\(\.has-cache-breakpoints\) \.msg-body\s*\{\s*display:\s*none;/);
    assert.match(consoleCss, /\.msg-card\.collapsed\.has-cache-breakpoints \.msg-content-block\s*\{\s*display:\s*none;/);
    assert.doesNotMatch(consoleCss, /\.msg-card\.collapsed \.msg-body\s*\{\s*display:\s*none;/);
});

test('display grouping never hides genuinely adjacent same-role messages', () => {
    const segments = helpers.getOrderedBodySegments({
        messages: [
            { role: 'user', content: [{ type: 'text', text: '第一条用户消息' }] },
            { role: 'user', content: [{ type: 'text', text: '第二条用户消息' }] },
        ],
    }, 'anthropic');
    const groups = helpers.groupBodySegmentsForDisplay(segments);

    assert.equal(groups.length, 2);
    assert.deepEqual(Array.from(groups, (group) => group.messageIndex), [0, 1]);
    assert.deepEqual(Array.from(groups, (group) => group.path), ['messages[0]', 'messages[1]']);
});

test('character counting uses Unicode code points and unavailable usage stays explicit', () => {
    assert.equal(helpers.countCharacters('A😀中'), 3);

    const withoutUsage = helpers.getPromptTokenEstimate([{ text: '内容' }], {});
    assert.equal(withoutUsage.totalCharacters, 2);
    assert.equal(withoutUsage.promptTokens, null);
    assert.equal(withoutUsage.tokensPerCharacter, null);
    assert.equal(helpers.estimatedTokens(2, withoutUsage.tokensPerCharacter), null);
    assert.equal(helpers.promptEstimateLabel(2, null), '2字符 | token 暂不可估');

    const withoutCharacters = helpers.getPromptTokenEstimate([{ text: '' }], {
        inputTokens: 10,
        anthropicCacheCreationInputTokens: 20,
    });
    assert.equal(withoutCharacters.totalCharacters, 0);
    assert.equal(withoutCharacters.tokensPerCharacter, null);
    assert.equal(helpers.promptEstimateLabel(0, null), '0字符 | token 暂不可估');
});

test('invalid usage fields cannot produce a misleading multiplier', () => {
    assert.equal(helpers.promptTokensFromUsage({ anthropicCacheCreationInputTokens: 20 }), null);
    assert.equal(helpers.promptTokensFromUsage({ inputTokens: 10, anthropicCacheCreationInputTokens: -1 }, 'anthropic'), null);
    assert.equal(helpers.promptTokensFromUsage({ inputTokens: 10, anthropicCacheCreationInputTokens: 'invalid' }, 'anthropic'), null);
    assert.equal(helpers.promptTokensFromUsage({ inputTokens: 10, anthropicCacheReadInputTokens: -1 }, 'anthropic'), null);
    assert.equal(helpers.promptTokensFromUsage({ inputTokens: 10, anthropicCacheReadInputTokens: 'invalid' }, 'anthropic'), null);
    assert.equal(helpers.promptTokensFromUsage({
        inputTokens: 10,
        anthropicCacheCreationInputTokens: 'ignored by OpenAI',
        anthropicCacheReadInputTokens: -1,
    }, 'openai'), 10);
    assert.equal(helpers.promptTokensFromUsage({ inputTokens: 10 }), 10);
    assert.equal(helpers.promptTokensFromUsage({ inputTokens: 10 }, 'anthropic'), 10);
});

test('tool and structured-output definitions join the denominator without control parameters', () => {
    const tools = [{
        type: 'function',
        function: {
            name: 'lookup_archive',
            description: '检索历史档案'.repeat(500),
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: '检索关键词'.repeat(500) },
                },
                required: ['query'],
            },
        },
    }];
    const functions = [{
        name: 'legacy_search',
        description: '旧版检索函数',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
    }];
    const responseFormat = {
        type: 'json_schema',
        json_schema: {
            name: 'answer',
            schema: { type: 'object', properties: { result: { type: 'string' } } },
        },
    };
    const body = {
        model: 'control-field-that-must-not-count'.repeat(500),
        max_tokens: 8192,
        stream: true,
        tools,
        functions,
        tool_choice: 'auto',
        function_call: 'auto',
        messages: [{ role: 'user', content: '问题正文'.repeat(250) }],
        response_format: responseFormat,
        output_config: {
            effort: 'max',
            format: { type: 'json_schema', schema: { type: 'string' } },
        },
    };

    const segments = helpers.getOrderedBodySegments(body, 'openai');
    assert.deepEqual(Array.from(segments, (segment) => segment.path), [
        'tools[0]',
        'functions[0]',
        'tool_choice',
        'function_call',
        'messages[0]',
        'response_format',
        'output_config.format',
    ]);
    assert.equal(segments[0].label, 'tools[0] · lookup_archive');
    assert.equal(segments[0].text, JSON.stringify(tools[0]));
    assert.equal(segments[1].text, JSON.stringify(functions[0]));
    assert.equal(segments[5].text, JSON.stringify(responseFormat));
    assert.ok(!segments.some((segment) => ['model', 'max_tokens', 'stream', 'output_config.effort'].includes(segment.path)));

    const expectedCharacters = segments.reduce(
        (sum, segment) => sum + helpers.countCharacters(segment.text),
        0,
    );
    const estimate = helpers.getPromptTokenEstimate(segments, { inputTokens: expectedCharacters });
    assert.equal(estimate.totalCharacters, expectedCharacters);
    assert.equal(estimate.tokensPerCharacter, 1);

    const messageOnlyCharacters = helpers.countCharacters(body.messages[0].content);
    assert.ok(expectedCharacters > messageOnlyCharacters * 5, 'large tool schema must materially expand the denominator');
    assert.ok(expectedCharacters / messageOnlyCharacters > 5, 'the previous message-only multiplier would be substantially inflated');
});

test('system-message handling control exposes all three modes and their tradeoffs', () => {
    const html = readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');

    assert.match(html, /系统身份消息处理/);
    assert.match(html, /data-system-message-mode="default">默认/);
    assert.match(html, /data-system-message-mode="off">关闭Anthropic优化/);
    assert.match(html, /data-system-message-mode="top">统一将系统身份消息放至最顶部/);
    assert.match(html, /合并相邻同角色发言/);
    assert.match(html, /保持 OpenAI-compatible 原始角色与顺序/);
    assert.match(html, /可能破坏上下文语义/);
    assert.doesNotMatch(html, /moveSystemMessagesToTopSwitch/);
    assert.match(script, /systemMessageHandlingMode/);
    assert.match(script, /\/console\/system-message-handling/);
});

test('system-message handling helpers normalize canonical and legacy runtime state', () => {
    assert.equal(helpers.systemMessageHandlingMode({}), 'default');
    assert.equal(helpers.systemMessageHandlingMode({ moveSystemMessagesToTop: false }), 'default');
    assert.equal(helpers.systemMessageHandlingMode({ moveSystemMessagesToTop: true }), 'off');
    assert.equal(helpers.systemMessageHandlingMode({ systemMessageHandlingMode: 'anthropic' }), 'default');
    assert.equal(helpers.systemMessageHandlingMode({ systemMessageHandlingMode: 'off' }), 'off');
    assert.equal(helpers.systemMessageHandlingMode({ systemMessageHandlingMode: 'invalid' }), 'default');
    assert.equal(helpers.systemMessageHandlingLabel('default'), '默认');
    assert.equal(helpers.systemMessageHandlingLabel('off'), '关闭Anthropic优化');
    assert.equal(helpers.systemMessageHandlingLabel('top'), '统一将系统身份消息放至最顶部');
});

test('Usage statistics expose input, output and cache hit rate without the old read badge', () => {
    const anthropic = helpers.usageStatistics({
        inputTokens: 100,
        outputTokens: 20,
        anthropicCacheReadInputTokens: 900,
        anthropicCacheCreationInputTokens: 0,
    }, 'anthropic');
    assert.equal(anthropic.inputTokens, 1000);
    assert.equal(anthropic.outputTokens, 20);
    assert.equal(anthropic.cacheHitRatePercent, 90);
    assert.equal(helpers.usageRateLabel(90), '90%');

    const root = fakeElement('div');
    helpers.renderUsageLines(root, {
        inputTokens: 39579,
        outputTokens: 376,
        cacheWriteTokens: 0,
        cacheReadTokens: 39552,
        cacheHitRatePercent: 99.93,
    }, 'compact');
    assert.equal(elementsByClass(root, 'usage-line').length, 3);
    assert.deepEqual(
        elementsByClass(root, 'usage-value').map((entry) => entry.textContent),
        ['39579', '376', '0', '39552', '99.93%'],
    );

    const html = readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /有缓存读取/);
    assert.doesNotMatch(script, /有缓存读取/);
    assert.match(html, /detailUsageStats/);
    assert.match(script, /缓存命中率/);
    assert.doesNotMatch(script, /upstreamStatsLabel/);
});

test('block hash entries are available to the diagnostic renderer', () => {
    const entries = helpers.getBlockHashEntries({
        upstream: {
            blockHashes: [{ path: 'messages[0].content[0]', hash: 'abc', changed: true }],
        },
    });
    assert.deepEqual(entries, [{ path: 'messages[0].content[0]', hash: 'abc', changed: true }]);
});

test('changed prompt blocks render their short hash in the message header only', () => {
    const root = fakeElement('div');
    helpers.renderRequestBodyStream(root, {
        upstream: {
            mode: 'openai',
            body: {
                messages: [{ role: 'user', content: [{ type: 'text', text: 'changed block' }] }],
            },
            blockHashes: [{
                path: 'messages[0].content[0]',
                hash: 'abcdef1234567890',
                previousHash: '0000000000000000',
                changed: true,
            }],
        },
        response: { usage: { inputTokens: 10 } },
    });
    const changed = elementsByClass(root, 'changed')
        .filter((entry) => String(entry.className).includes('msg-head-hash'));
    assert.equal(changed.length, 1);
    assert.equal(changed[0].dataset.hashChanged, 'true');
    assert.equal(changed[0].textContent, 'Hash abcdef1234');
    assert.equal(elementsByClass(root, 'msg-block-hash').length, 0);
    assert.equal(elementsByClass(root, 'hash-changed').length, 0);
});

test('multi-block messages expose every block hash in one header and bold only changed entries', () => {
    const root = fakeElement('div');
    helpers.renderRequestBodyStream(root, {
        upstream: {
            mode: 'openai',
            body: {
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: 'stable' },
                        { type: 'text', text: 'new' },
                    ],
                }],
            },
            blockHashes: [
                { path: 'messages[0].content[0]', hash: '1111111111abcdef', changed: false },
                { path: 'messages[0].content[1]', hash: '2222222222abcdef', changed: true, compared: true },
            ],
        },
        response: { usage: { inputTokens: 10 } },
    });

    const hashes = elementsByClass(root, 'msg-head-hash');
    assert.deepEqual(hashes.map((entry) => entry.textContent), ['b0 1111111111', 'b1 2222222222']);
    assert.equal(hashes[0].dataset.hashChanged, 'false');
    assert.equal(hashes[1].dataset.hashChanged, 'true');
});

