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
        + 'promptTokensFromUsage, usageStatistics, usageRateLabel, usageRateBand, renderUsageLines, getPromptTokenEstimate, renderRequestBodyStream, '
        + 'candidateBreakpoints, unusedCandidateBreakpoints, getBlockHashEntries, estimatedTokens, promptEstimateLabel, inputPromptTokenLabel, systemMessageHandlingMode, systemMessageHandlingLabel, '
        + 'prefixLockStatusLabel, requestCacheAnchorMode, cacheAnchorRequestLabel, anchorActionLabel, anchorReasonLabel, renderRequestCacheSummary, '
        + 'normalizeProcessingOrder, processingOrderRiskMessages, calculateUsagePreviewSample\n};', context);
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
function renderedText(root) {
    if (!root || typeof root !== 'object') return '';
    if (root.nodeType === 3) return String(root.textContent || '');
    return `${root.textContent || ''}${(root.children || []).map(renderedText).join('')}`;
}

test('request-log container cells keep explicit empty strings empty', () => {
    const row = fakeElement('tr');
    const cell = helpers.tableCell(row, '', 'log-action-cell', '详情');

    assert.equal(cell.textContent, '');
    assert.equal(cell.className, 'log-action-cell');
    assert.equal(cell.dataset.label, '详情');
    assert.equal(row.children[0], cell);
});

test('request-log Prefix and anchor summary uses Chinese rows and severity chips', () => {
    const root = fakeElement('td');
    helpers.renderRequestCacheSummary(root, {
        prefixLockEnabled: true,
        prefixLockAction: 'replaced',
        prefixLockReason: null,
        cacheAnchorMode: 'rolling',
        cacheTranslationEnabled: true,
        cachePolicyAction: 'promote',
        cachePolicyReason: 'deeper-anchor-mismatch',
        cacheContextHash: '6124045f59ab',
        prefixHash: 'd7c556a594deadbeef',
        changedBlockCount: 6,
    });

    assert.deepEqual(
        elementsByClass(root, 'request-cache-summary-label').map((entry) => entry.textContent),
        ['强制 Prefix 锁定', '缓存锚点', '锚点状态', '锚点上下文 ID', '块哈希变更'],
    );
    assert.deepEqual(
        elementsByClass(root, 'request-cache-summary-value').map(renderedText),
        ['开启 · 已应用', '滚动锚点', '晋升部分缓存锚点失效', '6124045f59', '6'],
    );

    const visible = renderedText(root);
    assert.doesNotMatch(visible, /d7c556a594|promote|deeper-anchor-mismatch/);
    assert.equal(elementsByClass(root, 'danger')[0].textContent, '部分缓存锚点失效');
    assert.equal(elementsByClass(root, 'warning')[0].textContent, '6');

    const offRoot = fakeElement('td');
    helpers.renderRequestCacheSummary(offRoot, {
        prefixLockEnabled: true,
        prefixLockAction: 'replaced',
        cacheAnchorMode: 'off',
        cachePolicyAction: 'promote',
        cachePolicyReason: 'deeper-anchor-mismatch',
        cacheContextHash: 'should-not-render',
        changedBlockCount: 0,
    });
    assert.deepEqual(
        elementsByClass(offRoot, 'request-cache-summary-label').map((entry) => entry.textContent),
        ['强制 Prefix 锁定'],
    );

    const fullyOffRoot = fakeElement('td');
    helpers.renderRequestCacheSummary(fullyOffRoot, {
        prefixLockEnabled: false,
        prefixLockAction: 'disabled',
        cacheAnchorMode: 'off',
        changedBlockCount: 8,
    });
    assert.deepEqual(elementsByClass(fullyOffRoot, 'request-cache-summary-label'), []);
});

test('request-log Prefix statuses cover every request outcome in Chinese', () => {
    const cases = [
        [{ prefixLockEnabled: false, prefixLockAction: 'skipped', prefixLockReason: 'cache-anchor-enabled' }, '关闭'],
        [{ prefixLockEnabled: true, prefixLockAction: 'created' }, '开启 · 已学习'],
        [{ prefixLockEnabled: true, prefixLockAction: 'replaced' }, '开启 · 已应用'],
        [{ prefixLockEnabled: true, prefixLockAction: 'cleared' }, '开启 · 已清空待学习'],
        [{ prefixLockEnabled: true, prefixLockAction: 'skipped', prefixLockReason: 'no-cache-control' }, '开启 · 本次无缓存点'],
        [{ prefixLockEnabled: true, prefixLockAction: 'skipped', prefixLockReason: 'mode-mismatch' }, '开启 · 上游格式不一致'],
        [{ prefixLockEnabled: true, prefixLockAction: 'skipped', prefixLockReason: 'cache-translation-disabled' }, '开启 · 已暂停'],
        [{ prefixLockEnabled: true, prefixLockAction: 'skipped', prefixLockReason: 'future-reason' }, '开启 · 本次跳过'],
        [{ prefixLockEnabled: true, prefixLockAction: 'future-action' }, '开启 · 状态未知'],
    ];

    for (const [item, expected] of cases) {
        assert.equal(helpers.prefixLockStatusLabel(item), expected);
    }
});

test('request-log anchor modes, actions and reasons have complete Chinese labels', () => {
    assert.equal(helpers.cacheAnchorRequestLabel({ cacheAnchorMode: 'off' }), '关闭');
    assert.equal(helpers.cacheAnchorRequestLabel({ cacheAnchorMode: 'single', cacheTranslationEnabled: true }), '单锚点');
    assert.equal(helpers.cacheAnchorRequestLabel({ cacheAnchorMode: 'rolling', cacheTranslationEnabled: false }), '滚动锚点 · 已暂停');
    assert.equal(helpers.cacheAnchorRequestLabel({ cacheAnchorMode: 'future-mode' }), '状态未知');

    const actions = {
        learn: '学习',
        match: '复用',
        promote: '晋升',
        reset: '重新学习',
        'rotation-paused': '轮换暂停',
        'no-candidates': '无可用锚点',
    };
    for (const [code, expected] of Object.entries(actions)) {
        assert.equal(helpers.anchorActionLabel(code), expected);
    }
    assert.equal(helpers.anchorActionLabel('future-action'), '未知状态');

    const reasons = {
        'deeper-anchor-mismatch': '部分缓存锚点失效',
        'caller-control-reserved': '调用方缓存点占用',
        'anchor-capacity-reduced': '可用锚点容量减少',
        'anchor-overlap-budget': '晋升锚点超出缓存点额度',
        'anchor-budget-unavailable': '缓存点额度不足',
        'protected-last-anchor-budget': '保护尾锚点额度不足',
    };
    for (const [code, expected] of Object.entries(reasons)) {
        assert.equal(helpers.anchorReasonLabel(code), expected);
    }
    assert.equal(helpers.anchorReasonLabel('future-reason'), '其他原因');
});

test('request-log Prefix and anchor CSS aligns rows and uses warning and danger colors', () => {
    assert.match(consoleCss, /\.request-cache-summary-row\s*\{[^}]*grid-template-columns:\s*9em minmax\(0, 1fr\)/s);
    assert.match(consoleCss, /\.request-cache-status-chip\.warning\s*\{[^}]*var\(--warning-soft\)[^}]*var\(--warning\)/s);
    assert.match(consoleCss, /\.request-cache-status-chip\.danger\s*\{[^}]*var\(--danger-soft\)[^}]*var\(--danger\)/s);
    assert.match(consoleCss, /@media \(max-width: 980px\)[\s\S]*\.request-cache-cell\s*\{\s*min-width:\s*0;/);
    assert.match(consoleCss, /@media \(max-width: 980px\)[\s\S]*\.request-cache-summary-row\s*\{[^}]*grid-template-columns:\s*8\.5em minmax\(0, 1fr\)/);
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
    assert.match(consoleCss, /\.cache-divider\.unused-cache-divider\s*\{[^}]*min-height:\s*24px;/s);
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
    assert.equal(elementsByClass(root, 'usage-metric').length, 4);
    assert.equal(elementsByClass(root, 'usage-grid-divider').length, 2);
    assert.equal(elementsByClass(root, 'usage-rate-row').length, 1);
    assert.deepEqual(
        elementsByClass(root, 'usage-label').map((entry) => entry.textContent),
        ['输入', '输出', '缓存命中', '创建', '缓存命中率'],
    );
    assert.deepEqual(
        elementsByClass(root, 'usage-value').map((entry) => entry.textContent),
        ['39579', '376', '39552', '0', '99.93%'],
    );
    assert.equal(helpers.usageRateBand(50), 'rate-le50');
    assert.equal(helpers.usageRateBand(50.01), 'rate-le70');
    assert.equal(helpers.usageRateBand(70), 'rate-le70');
    assert.equal(helpers.usageRateBand(70.01), 'rate-le90');
    assert.equal(helpers.usageRateBand(90), 'rate-le90');
    assert.equal(helpers.usageRateBand(90.01), 'rate-le100');
    assert.equal(helpers.usageRateBand(100), 'rate-le100');
    assert.equal(helpers.usageRateBand(null), null);

    const html = readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /有缓存读取/);
    assert.doesNotMatch(script, /有缓存读取/);
    assert.match(html, /detailUsageStats/);
    assert.match(script, /缓存命中率/);
    assert.doesNotMatch(script, /upstreamStatsLabel/);
});

test('Usage appearance controls expose every metric and CSS variable', () => {
    const html = readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'hitRate.le50', 'hitRate.le70', 'hitRate.le90', 'hitRate.le100']) {
        assert.match(html, new RegExp(`data-usage-style="${key.replace('.', '\\.')}"`));
    }
    assert.match(html, /id="usageAppearanceApply"/);
    assert.match(html, /id="usageAppearanceReset"/);
    assert.match(consoleCss, /--usage-input-text:\s*#127852/i);
    assert.match(consoleCss, /--usage-output-text:\s*#7c3aed/i);
    assert.match(consoleCss, /grid-template-columns:\s*minmax\(0, 1fr\) 1px minmax\(0, 1fr\)/);
    assert.match(consoleCss, /font-variant-numeric:\s*tabular-nums/);
});

test('Usage preview editing keeps input, cache read, and hit rate synchronized', () => {
    const plain = (value) => JSON.parse(JSON.stringify(value));
    assert.deepEqual(plain(helpers.calculateUsagePreviewSample({
        inputTokens: 200,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 5,
        cacheHitRatePercent: 25,
    }, 'inputTokens')), {
        inputTokens: 200,
        outputTokens: 10,
        cacheReadTokens: 50,
        cacheWriteTokens: 5,
        cacheHitRatePercent: 25,
    });
    assert.deepEqual(plain(helpers.calculateUsagePreviewSample({
        inputTokens: 200,
        outputTokens: 10,
        cacheReadTokens: 60,
        cacheWriteTokens: 5,
        cacheHitRatePercent: 1,
    }, 'cacheReadTokens')), {
        inputTokens: 200,
        outputTokens: 10,
        cacheReadTokens: 60,
        cacheWriteTokens: 5,
        cacheHitRatePercent: 30,
    });
    assert.deepEqual(plain(helpers.calculateUsagePreviewSample({
        inputTokens: 80,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 5,
        cacheHitRatePercent: 12.5,
    }, 'cacheHitRatePercent')), {
        inputTokens: 80,
        outputTokens: 10,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        cacheHitRatePercent: 12.5,
    });

    const html = readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
    assert.match(html, /id="usagePreviewEditor"[^>]*hidden/);
    assert.match(html, /id="usageAppearancePreview"[^>]*usage-preview-clickable/);
    assert.match(html, /id="usagePreviewDone"/);
    assert.match(script, /usageAppearancePreview'\)\.onclick/);
});

test('processing-order UI uses option titles, fixed stage numbers, disabled 5m styling, and automatic apply', () => {
    const html = readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
    assert.match(script, /'fixed-head': \{ label: '固定头缓存点'/);
    assert.match(script, /'ignore-tail': \{ label: '忽略末尾锚点'/);
    assert.match(script, /'cache-anchor': \{ label: '缓存锚点'/);
    assert.match(script, /'last-gateway-cache-point-5m': \{ label: '末锚点自动使用 5 分钟'/);
    assert.match(script, /DEFAULT_CACHE_POLICY_PROCESSING_ORDER\.indexOf\(stage\) \+ 1/);
    assert.match(script, /isInactive = stage === 'last-gateway-cache-point-5m'/);
    assert.match(script, /（未启用）/);
    assert.match(consoleCss, /\.processing-order-item\.inactive/);
    assert.doesNotMatch(html, /id="cachePolicyApply"/);
    assert.match(html, /id="cachePolicyAutoSaveState">修改后自动应用/);
    assert.match(script, /scheduleCachePolicyAutoApply/);

    assert.deepEqual(
        Array.from(helpers.normalizeProcessingOrder(['ignore-tail'])),
        ['fixed-head', 'ignore-tail', 'cache-anchor', 'tail-fill', 'protected-tail-anchor', 'last-gateway-cache-point-5m'],
    );
    assert.ok(helpers.processingOrderRiskMessages([
        'ignore-tail',
        'fixed-head',
        'tail-fill',
        'cache-anchor',
        'protected-tail-anchor',
        'last-gateway-cache-point-5m',
    ]).length >= 2);
});

test('Prefix and anchor appearance plus configuration management controls are exposed', () => {
    const html = readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
    for (const key of ['prefixLock', 'cacheAnchor', 'cacheBudgetInsufficient', 'blockHashChange']) {
        assert.match(html, new RegExp(`data-request-cache-style="${key}"`));
    }
    assert.match(consoleCss, /--request-cache-prefix-lock-text:\s*#191919/i);
    assert.match(consoleCss, /--request-cache-cache-anchor-text:\s*#191919/i);
    assert.match(consoleCss, /--request-cache-cache-budget-insufficient-text:\s*#b25e00/i);
    assert.match(consoleCss, /--request-cache-block-hash-change-text:\s*#b25e00/i);
    assert.match(consoleCss, /\.request-cache-budget-insufficient-chip/);
    assert.match(consoleCss, /\.request-cache-block-hash-change-chip/);
    assert.match(html, /id="requestCacheAppearancePreview"/);
    assert.match(html, /id="configImport"/);
    assert.match(html, /id="configExport"/);
    assert.match(html, /id="configRestoreDefault"/);
    assert.match(script, /\/console\/config\/export/);
    assert.match(script, /\/console\/config\/import/);
    assert.match(script, /\/console\/config\/reset/);
    assert.match(script, /document\.body\.appendChild\(a\)/);
    assert.match(script, /renderUsagePreviewSampleControls\(DEFAULT_USAGE_PREVIEW_SAMPLE\)/);
    assert.match(script, /renderUsageAppearancePreview\(\)/);
});

test('unselected cache candidates render at their original message positions only in the full body view', () => {
    const selectedIndexes = new Set([0, 7, 8, 9]);
    const messages = Array.from({ length: 10 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: [{
            type: 'text',
            text: String.fromCharCode(65 + index),
            ...(selectedIndexes.has(index) ? { cache_control: { type: 'ephemeral' } } : {}),
        }],
    }));
    const candidates = messages.map((_, index) => ({
        order: index,
        path: `messages[${index}].content[0].cache_control`,
        selected: selectedIndexes.has(index),
        reason: selectedIndexes.has(index) ? 'tail' : 'overflow',
    }));
    const selectedBreakpoints = candidates.filter((candidate) => candidate.selected);
    const capture = {
        upstream: {
            mode: 'openai',
            body: { messages },
            cache: {
                cacheControlCount: 4,
                selectedBreakpoints,
                cacheControlPaths: selectedBreakpoints.map((entry) => entry.path),
            },
        },
        gateway: { cachePolicy: { candidates, selectedBreakpoints }, cacheTtl: 'auto' },
        response: { usage: { inputTokens: 100 } },
    };
    const root = fakeElement('div');
    helpers.renderRequestBodyStream(root, capture);

    const cards = elementsByClass(root, 'msg-card');
    assert.equal(cards.length, 10);
    assert.equal(elementsByClass(root, 'unused-cache-divider').length, 6);
    assert.equal(elementsByClass(root, 'cache-divider').length, 10);
    for (let index = 0; index < 10; index++) {
        const unused = elementsByClass(cards[index], 'unused-cache-divider');
        assert.equal(unused.length, selectedIndexes.has(index) ? 0 : 1);
        if (unused.length) {
            assert.equal(elementsByClass(unused[0], 'unused-cache-title')[0].textContent, '未使用缓存点');
            assert.equal(elementsByClass(unused[0], 'cache-icon').length, 0);
            assert.equal(elementsByClass(unused[0], 'cache-sub').length, 0);
        }
    }

    assert.equal(helpers.candidateBreakpoints(capture).length, 10);
    assert.equal(helpers.unusedCandidateBreakpoints(capture).length, 6);
    const prefixRoot = fakeElement('div');
    helpers.renderRequestBodyStream(prefixRoot, capture, true);
    assert.equal(elementsByClass(prefixRoot, 'unused-cache-divider').length, 0);
});

test('unused cache points are not capacity placeholders when every candidate is selected', () => {
    const candidates = [0, 1].map((index) => ({
        order: index,
        path: `messages[${index}].content[0].cache_control`,
        selected: true,
        reason: 'tail',
    }));
    const capture = {
        upstream: {
            mode: 'openai',
            body: {
                messages: candidates.map((_, index) => ({
                    role: 'user',
                    content: [{ type: 'text', text: String(index), cache_control: { type: 'ephemeral' } }],
                })),
            },
            cache: { selectedBreakpoints: candidates },
        },
        gateway: { cachePolicy: { candidates, selectedBreakpoints: candidates } },
        response: { usage: { inputTokens: 10 } },
    };
    const root = fakeElement('div');
    helpers.renderRequestBodyStream(root, capture);
    assert.equal(elementsByClass(root, 'unused-cache-divider').length, 0);
    assert.equal(elementsByClass(root, 'cache-divider').length, 2);
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

