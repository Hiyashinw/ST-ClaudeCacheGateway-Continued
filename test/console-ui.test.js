import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

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
        document: { createElement: fakeElement },
    });
    vm.runInContext(`${withoutBootstrap}\n;globalThis.__helpers = {\n`
        + 'tableCell, countCharacters, getOrderedBodySegments, promptTokensFromUsage, getPromptTokenEstimate, '
        + 'estimatedTokens, promptEstimateLabel\n};', context);
    return context.__helpers;
}

const helpers = loadConsoleHelpers();

test('request-log container cells keep explicit empty strings empty', () => {
    const row = fakeElement('tr');
    const cell = helpers.tableCell(row, '', 'log-action-cell', '详情');

    assert.equal(cell.textContent, '');
    assert.equal(cell.className, 'log-action-cell');
    assert.equal(cell.dataset.label, '详情');
    assert.equal(row.children[0], cell);
});

test('prompt token multiplier uses input plus twice the Anthropic cache-creation tokens', () => {
    const segments = Array.from({ length: 5 }, () => ({ text: '字'.repeat(2000) }));
    const usage = {
        inputTokens: 4000,
        anthropicCacheCreationInputTokens: 8000,
        anthropicCacheReadInputTokens: 16000,
        cachedTokens: 16000,
        cacheReadTokens: 16000,
    };

    assert.equal(helpers.promptTokensFromUsage(usage), 20000);
    const estimate = helpers.getPromptTokenEstimate(segments, usage);
    assert.equal(estimate.totalCharacters, 10000);
    assert.equal(estimate.tokensPerCharacter, 2);
    assert.deepEqual(Array.from(estimate.characterCounts), [2000, 2000, 2000, 2000, 2000]);
    assert.equal(helpers.estimatedTokens(estimate.characterCounts[0], estimate.tokensPerCharacter), 4000);
    assert.equal(helpers.promptEstimateLabel(2000, 4000), '2000字符 | 约4000token');
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
    assert.equal(helpers.promptTokensFromUsage({ inputTokens: 10, anthropicCacheCreationInputTokens: -1 }), null);
    assert.equal(helpers.promptTokensFromUsage({ inputTokens: 10, anthropicCacheCreationInputTokens: 'invalid' }), null);
    assert.equal(helpers.promptTokensFromUsage({ inputTokens: 10 }), 10);
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
