const state = {
  runtime: null,
  requests: [],
  selected: null,
  selectedTab: 'body',
  page: 1,
  pageSize: 20,
  filters: {
    cache: '',
  },
  channelDrafts: [],
  processingOrderDraft: null,
  usagePreviewEditing: false,
};

const DEFAULT_CACHE_POLICY_PROCESSING_ORDER = [
  'fixed-head',
  'ignore-tail',
  'cache-anchor',
  'tail-fill',
  'protected-tail-anchor',
  'last-gateway-cache-point-5m',
];

const CACHE_POLICY_STAGE_INFO = {
  'fixed-head': { label: '固定头缓存点', description: '从完整候选头部锁定配置数量；默认放在忽略末尾之前。' },
  'ignore-tail': { label: '忽略末尾锚点', description: '阻止最新 x 个尚未被前置阶段锁定的候选。' },
  'cache-anchor': { label: '缓存锚点', description: '执行单锚点或滚动锚点的学习、复用与轮换。' },
  'tail-fill': { label: '普通尾点填充', description: '使用剩余预算选择普通候选；滚动队列冻结后默认跳过。' },
  'protected-tail-anchor': { label: '保护尾锚点', description: '尝试保留滚动模式首次冻结的最后锚点，直至其待淘汰。' },
  'last-gateway-cache-point-5m': { label: '末锚点自动使用 5 分钟', description: '把执行到此阶段时最后一个网关缓存点转为 5 分钟。' },
};

const DEFAULT_USAGE_PREVIEW_SAMPLE = {
  inputTokens: 148792,
  outputTokens: 546,
  cacheReadTokens: 141558,
  cacheWriteTokens: 6924,
  cacheHitRatePercent: 95.14,
};

const DEFAULT_REQUEST_CACHE_APPEARANCE = {
  prefixLock: { textColor: '#191919', backgroundColor: null },
  cacheAnchor: { textColor: '#191919', backgroundColor: null },
  cacheBudgetInsufficient: { textColor: '#B25E00', backgroundColor: '#FBF1E6' },
  blockHashChange: { textColor: '#B25E00', backgroundColor: '#FBF1E6' },
};

const DEFAULT_ANTHROPIC_OPTIMIZATION_MODEL_WHITELIST = ['claude-fable-5-1'];

const REQUEST_CACHE_APPEARANCE_FIELDS = [
  { key: 'prefixLock', cssKey: 'prefix-lock', label: 'Prefix 锁定' },
  { key: 'cacheAnchor', cssKey: 'cache-anchor', label: '缓存锚点' },
  { key: 'cacheBudgetInsufficient', cssKey: 'cache-budget-insufficient', label: '缓存点额度不足' },
  { key: 'blockHashChange', cssKey: 'block-hash-change', label: '块哈希变更数字' },
];

const USAGE_APPEARANCE_FIELDS = [
  { path: ['input'], cssKey: 'input', label: '输入' },
  { path: ['output'], cssKey: 'output', label: '输出' },
  { path: ['cacheRead'], cssKey: 'cache-read', label: '缓存命中' },
  { path: ['cacheWrite'], cssKey: 'cache-write', label: '缓存创建' },
  { path: ['hitRate', 'le50'], cssKey: 'rate-le50', label: '命中率 ≤ 50%' },
  { path: ['hitRate', 'le70'], cssKey: 'rate-le70', label: '命中率 ≤ 70%' },
  { path: ['hitRate', 'le90'], cssKey: 'rate-le90', label: '命中率 ≤ 90%' },
  { path: ['hitRate', 'le100'], cssKey: 'rate-le100', label: '命中率 > 90%' },
];

const pages = {
  dashboard: '网关概览',
  channels: '渠道配置',
  cache: '缓存策略',
  logs: '请求日志',
  advanced: '高级配置',
};

let customChannelSeq = 0;
let cachePolicyAutoApplyTimer = null;
let cachePolicyAutoApplySequence = 0;

function $(id) {
  return document.getElementById(id);
}

async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    throw new Error(formatApiError(await response.text()));
  }
  return response.json();
}

function formatApiError(raw) {
  let message = raw || '请求失败。';
  try {
    const parsed = JSON.parse(raw);
    message = parsed?.error || parsed?.message || message;
  } catch {
    // Keep the raw response text when the server did not return JSON.
  }

  const zh = {
    'Channel base URL is required.': '上游 URL 不能为空，请填写完整的 http/https 地址。',
    'Channel base URL is too long.': '上游 URL 太长，请检查后再保存。',
    'Channel base URL must be an absolute URL.': '上游 URL 必须是完整地址，例如 https://example.com/api/v1。',
    'Channel base URL must use http or https.': '上游 URL 只支持 http 或 https。',
    'Channel base URL must not include username or password.': '上游 URL 不能包含用户名或密码。',
    'Channel name must be 1-80 characters.': '渠道名称需要填写 1-80 个字符。',
    'Built-in channels cannot be deleted.': '内置渠道不能删除。',
    'Channel not found.': '渠道不存在，可能已被删除，请刷新后重试。',
    'Upstream exclude path is too long.': '排除参数路径太长，请检查后再保存。',
    'Too many upstream exclude paths.': '排除参数太多，请减少后再保存。',
    'Upstream headers must be a JSON object.': '请求头覆写必须是 JSON 对象。',
    'Upstream exclude header name is too long.': '排除请求头名称太长，请检查后再保存。',
    'Too many upstream exclude headers.': '排除请求头太多，请减少后再保存。',
  };
  if (message.startsWith('Invalid upstream header name:')) {
    return `请求头名称格式不正确：${message.replace('Invalid upstream header name:', '').trim()}`;
  }
  if (message.startsWith('Do not store secrets or protocol headers in channel profiles:')) {
    return `不能在 Profile 中保存密钥或协议请求头：${message.replace('Do not store secrets or protocol headers in channel profiles:', '').trim()}`;
  }
  if (message.startsWith('Upstream header value must be')) {
    return `请求头值只支持字符串、数字或布尔值。`;
  }
  if (message.startsWith('Invalid upstream header value:')) {
    return `请求头值格式不正确：${message.replace('Invalid upstream header value:', '').trim()}`;
  }
  if (message.startsWith('Invalid upstream exclude path:')) {
    return `排除参数路径格式不正确：${message.replace('Invalid upstream exclude path:', '').trim()}`;
  }

  return zh[message] || message;
}

function postJson(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function text(value, fallback = '-') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

function ttlLabel(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'manual') return '手动';
  if (normalized === '1h') return '1 小时';
  if (normalized === '5m') return '5 分钟';
  if (!normalized || normalized === 'auto' || normalized === 'default' || normalized === 'provider-default' || normalized === 'none') return '自动';
  return String(value);
}

function ttlSelectionValue(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'auto' || normalized === 'default' || normalized === 'provider-default' || normalized === 'none') return 'auto';
  return normalized;
}

function autoBreakpointMode(source = state.runtime) {
  const raw = source && typeof source === 'object'
    ? source.autoGenerateCacheBreakpointsMode ?? source.autoGenerateCacheBreakpoints
    : source;
  if (raw === true) return 'on';
  if (raw === false || raw === null || raw === undefined) return 'off';
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'auto') return 'auto';
  if (normalized === 'on' || normalized === 'true' || normalized === 'enabled') return 'on';
  return 'off';
}

function autoBreakpointModeLabel(value) {
  const mode = autoBreakpointMode(value);
  if (mode === 'auto') return '自动';
  if (mode === 'on') return '开启';
  return '关闭';
}

function systemMessageHandlingMode(source = state.runtime) {
  const raw = source && typeof source === 'object'
    ? source.systemMessageHandlingMode ?? source.moveSystemMessagesToTop
    : source;
  if (raw === true) return 'off';
  if (raw === false || raw === null || raw === undefined) return 'default';
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'anthropic') return 'default';
  if (normalized === 'off') return 'off';
  if (normalized === 'top') return 'top';
  return 'default';
}

function systemMessageHandlingLabel(value) {
  const mode = systemMessageHandlingMode(value);
  if (mode === 'off') return '关闭Anthropic优化';
  if (mode === 'top') return '统一将系统身份消息放至最顶部';
  return '默认';
}

function normalizeAnthropicOptimizationModelWhitelist(value) {
  const items = Array.isArray(value)
    ? value
    : String(value ?? '').split(/\r?\n|,/);
  const seen = new Set();
  const output = [];

  for (const item of items) {
    if (typeof item !== 'string') continue;
    const pattern = item.trim();
    if (!pattern) continue;
    const key = pattern.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(pattern);
  }

  return output;
}


function updateAnthropicOptimizationWhitelistDraftCount() {
  const count = $('anthropicOptimizationWhitelistDraftCount');
  const input = $('anthropicOptimizationModelWhitelistInput');
  if (!count || !input) return;
  count.textContent = `${normalizeAnthropicOptimizationModelWhitelist(input.value).length} 个项目`;
}

function autoBreakpointCaptureLabel(item) {
  const gateway = item?.gateway || {};
  const diagnostics = gateway.cachePolicy?.autoGeneratedBreakpoints || {};
  const mode = autoBreakpointMode(gateway);
  if (mode === 'off') return '关闭';
  const effectiveValue = gateway.autoGenerateCacheBreakpointsEffective ?? diagnostics.effectiveEnabled;
  const effective = typeof effectiveValue === 'boolean' ? effectiveValue : mode === 'on';
  const added = diagnostics.added ?? 0;
  if (mode === 'auto') {
    if (effective) return `自动 · 本次生成 · 新增 ${added}`;
    if (diagnostics.skippedReason === 'cache-translation-disabled') return '自动 · 本次暂停（缓存转译关闭）';
    const reason = diagnostics.suppressionReason === 'existing-cache-control'
      ? '已有 cache_control'
      : diagnostics.suppressionReason === 'explicit-marker-and-cache-control'
        ? '已有 marker 与 cache_control'
        : '已有 marker';
    return `自动 · 本次跳过（${reason}）`;
  }
  return effective ? `开启 · 新增 ${added}` : '开启 · 本次暂停';
}

const CACHE_BREAKPOINT_LIMIT = 4;

function integerInRange(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function booleanValue(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return fallback;
}

function normalizeProcessingOrder(value) {
  if (!Array.isArray(value)) return [...DEFAULT_CACHE_POLICY_PROCESSING_ORDER];
  const normalized = value.map((stage) => String(stage || '').trim().toLowerCase());
  const required = new Set(DEFAULT_CACHE_POLICY_PROCESSING_ORDER);
  if (normalized.length !== required.size
    || new Set(normalized).size !== required.size
    || normalized.some((stage) => !required.has(stage))) {
    return [...DEFAULT_CACHE_POLICY_PROCESSING_ORDER];
  }
  return normalized;
}

function cacheAnchorModeLabel(value) {
  if (value === 'single') return '单锚点';
  if (value === 'rolling') return '滚动锚点';
  return '关闭';
}

function getCachePolicy(runtime = state.runtime) {
  const nested = runtime?.cachePolicy || {};
  const anchorState = runtime?.cacheAnchorState || nested.cacheAnchorState || nested.anchorState || {};
  const fixedHeadBreakpointCount = integerInRange(
    runtime?.fixedHeadBreakpointCount ?? nested.fixedHeadBreakpointCount,
    0,
    CACHE_BREAKPOINT_LIMIT,
    0,
  );
  const rawMode = runtime?.cacheAnchorMode ?? nested.cacheAnchorMode ?? 'off';
  const cacheAnchorMode = ['off', 'single', 'rolling'].includes(rawMode) ? rawMode : 'off';
  const cacheAnchorIntervalBlocks = integerInRange(
    runtime?.cacheAnchorIntervalBlocks ?? nested.cacheAnchorIntervalBlocks,
    1,
    1000,
    3,
  );
  const cachePolicyProcessingOrder = normalizeProcessingOrder(
    runtime?.cachePolicyProcessingOrder ?? nested.cachePolicyProcessingOrder,
  );
  const autoConvertLastAnchorTo5m = booleanValue(
    runtime?.autoConvertLastAnchorTo5m
      ?? runtime?.autoConvertLastAnchorToShortTtl
      ?? nested.autoConvertLastAnchorTo5m,
    false,
  );
  const rawIgnoreMode = runtime?.ignoreLastAnchorsMode
    ?? runtime?.anchorIgnoreMode
    ?? nested.ignoreLastAnchorsMode
    ?? 'fixed';
  const ignoreLastAnchorsMode = ['fixed', 'evaluation'].includes(rawIgnoreMode) ? rawIgnoreMode : 'fixed';
  const ignoreLastAnchorCount = nonNegativeInteger(
    runtime?.ignoreLastAnchorCount
      ?? runtime?.ignoredAnchorCount
      ?? runtime?.configuredIgnoreLastAnchorCount
      ?? nested.ignoreLastAnchorCount,
    0,
  );

  return {
    fixedHeadBreakpointCount,
    cacheAnchorMode,
    cacheAnchorIntervalBlocks,
    cachePolicyProcessingOrder,
    autoConvertLastAnchorTo5m,
    ignoreLastAnchorsMode,
    ignoreLastAnchorCount,
    anchorState,
  };
}

function cachePolicyLabel(policy = getCachePolicy()) {
  if (policy.fixedHeadBreakpointCount === 0 && policy.cacheAnchorMode === 'off') return '旧版前 4 点';
  return `固定头 ${policy.fixedHeadBreakpointCount} · ${cacheAnchorModeLabel(policy.cacheAnchorMode)}`;
}

function upstreamModeLabel(value) {
  return value === 'anthropic' ? 'Anthropic native' : 'OpenAI-compatible';
}

function cacheResultLabel(value) {
  if (value === 'hit') return 'HIT';
  if (value === 'creation') return 'WRITE';
  if (value === 'none') return 'NONE';
  return 'UNKNOWN';
}

function cacheClass(value, status) {
  if (status && status >= 400) return 'cache-error';
  if (value === 'hit') return 'cache-hit';
  if (value === 'creation') return 'cache-creation';
  if (value === 'none') return 'cache-none';
  return 'cache-unknown';
}

function hasUsage(usage) {
  return usage && Object.values(usage).some((value) => value !== null && value !== undefined);
}

function formatUsage(usage) {
  if (!hasUsage(usage)) return '暂无 usage。';
  return JSON.stringify(usage, null, 2);
}

function cacheInjectLabel(item) {
  if (!item?.cacheTranslationEnabled) return '转译关闭';
  const injected = item?.injected ?? 0;
  const removed = item?.removed ?? 0;
  const count = item?.cacheControlCount ?? 0;
  if (injected > 0 || removed > 0 || count > 0) return `转换 ${removed} / 缓存点 ${count}`;
  return '未注入';
}

function normalizedDiagnosticCode(value) {
  return String(value || '').trim().toLowerCase().replaceAll('_', '-');
}

function prefixLockStatusLabel(item) {
  const enabled = item?.prefixLockEnabled;
  const action = normalizedDiagnosticCode(item?.prefixLockAction);
  const reason = normalizedDiagnosticCode(item?.prefixLockReason);

  if (enabled === false || action === 'disabled' || reason === 'cache-anchor-enabled') return '关闭';
  if (action === 'created') return '开启 · 已学习';
  if (action === 'replaced') return '开启 · 已应用';
  if (action === 'cleared') return enabled === true ? '开启 · 已清空待学习' : '关闭 · 已清空';
  if (action === 'learning') return '开启 · 待学习';
  if (action === 'skipped') {
    if (reason === 'cache-translation-disabled') return '开启 · 已暂停';
    if (reason === 'no-cache-control') return '开启 · 本次无缓存点';
    if (reason === 'mode-mismatch') return '开启 · 上游格式不一致';
    return enabled === true ? '开启 · 本次跳过' : '关闭';
  }
  if (action === 'enabled' || (enabled === true && !action)) return '开启';
  if (enabled === true) return '开启 · 状态未知';
  return action ? '状态未知' : '关闭';
}

function requestCacheAnchorMode(item, diagnostics = getCaptureCachePolicy(item)) {
  const value = item?.cacheAnchorMode ?? diagnostics?.policy?.cacheAnchorMode;
  if (value === null || value === undefined || value === '') return 'off';
  const normalized = normalizedDiagnosticCode(value);
  return ['off', 'single', 'rolling'].includes(normalized) ? normalized : 'unknown';
}

function cacheAnchorRequestLabel(item, diagnostics = getCaptureCachePolicy(item)) {
  const mode = requestCacheAnchorMode(item, diagnostics);
  if (mode === 'unknown') return '状态未知';
  if (mode === 'off') return '关闭';
  const label = cacheAnchorModeLabel(mode);
  return item?.cacheTranslationEnabled === false ? `${label} · 已暂停` : label;
}

function anchorActionLabel(value) {
  const labels = {
    learn: '学习',
    match: '复用',
    promote: '晋升',
    reset: '重新学习',
    'rotation-paused': '轮换暂停',
    'no-candidates': '无可用锚点',
    disabled: '已关闭',
    off: '已关闭',
  };
  return labels[normalizedDiagnosticCode(value)] || '未知状态';
}

function anchorReasonLabel(value) {
  if (!value) return null;
  const labels = {
    'deeper-anchor-mismatch': '部分缓存锚点失效',
    'caller-control-reserved': '调用方缓存点占用',
    'anchor-capacity-reduced': '可用锚点容量减少',
    'anchor-overlap-budget': '晋升锚点超出缓存点额度',
    'anchor-budget-unavailable': '缓存点额度不足',
    'protected-last-anchor-budget': '保护尾锚点额度不足',
  };
  return labels[normalizedDiagnosticCode(value)] || '其他原因';
}

function anchorReasonClass(value) {
  return normalizedDiagnosticCode(value) === 'deeper-anchor-mismatch' ? 'danger' : '';
}

function appendRequestCacheSummaryRow(root, label, appearanceKind = '') {
  const row = document.createElement('div');
  row.className = `request-cache-summary-row ${appearanceKind ? `request-cache-${appearanceKind}-row` : ''}`.trim();
  appendText(row, 'dt', label, 'request-cache-summary-label');
  const value = document.createElement('dd');
  value.className = `request-cache-summary-value ${appearanceKind ? `request-cache-${appearanceKind}-value` : ''}`.trim();
  row.appendChild(value);
  root.appendChild(row);
  return value;
}

function renderRequestCacheSummary(root, item) {
  clearNode(root);
  const summary = document.createElement('dl');
  summary.className = 'request-cache-summary';
  const diagnostics = getCaptureCachePolicy(item);
  const anchorMode = requestCacheAnchorMode(item, diagnostics);
  const showPrefix = item?.prefixLockEnabled === true;
  const showAnchor = ['single', 'rolling'].includes(anchorMode);

  let value;
  if (showPrefix) {
    value = appendRequestCacheSummaryRow(summary, '强制 Prefix 锁定', 'prefix-lock');
    appendText(value, 'span', prefixLockStatusLabel(item), 'request-cache-summary-text request-cache-appearance-value');
  }

  if (showAnchor) {
    value = appendRequestCacheSummaryRow(summary, '缓存锚点', 'cache-anchor');
    appendText(value, 'span', cacheAnchorRequestLabel(item, diagnostics), 'request-cache-summary-text request-cache-appearance-value');

    const anchorAction = normalizedDiagnosticCode(diagnostics.action);
    if (anchorAction && !['off', 'disabled'].includes(anchorAction)) {
      value = appendRequestCacheSummaryRow(summary, '锚点状态', 'cache-anchor');
      appendText(value, 'span', anchorActionLabel(anchorAction), 'request-cache-summary-text request-cache-appearance-value');
      if (diagnostics.reason) {
        const reasonClass = anchorReasonClass(diagnostics.reason);
        const budgetClass = normalizedDiagnosticCode(diagnostics.reason).includes('budget')
          ? 'request-cache-budget-insufficient-chip'
          : '';
        appendText(
          value,
          'span',
          anchorReasonLabel(diagnostics.reason),
          `request-cache-status-chip ${reasonClass} ${budgetClass}`.trim(),
        );
      }
    }

    if (diagnostics.contextHash) {
      value = appendRequestCacheSummaryRow(summary, '锚点上下文 ID', 'cache-anchor');
      appendText(value, 'span', compactHash(diagnostics.contextHash), 'request-cache-summary-id request-cache-appearance-value');
    }
  }

  if (showPrefix || showAnchor) {
    const changedBlockCount = Number(item?.changedBlockCount || 0);
    if (Number.isFinite(changedBlockCount) && changedBlockCount > 0) {
      value = appendRequestCacheSummaryRow(summary, '块哈希变更');
      appendText(value, 'span', changedBlockCount, 'request-cache-status-chip warning request-cache-summary-id request-cache-block-hash-change-chip');
    }
  }

  root.appendChild(summary);
  return summary;
}

function compactHash(value) {
  return value ? String(value).slice(0, 10) : '-';
}

function timeLabel(value) {
  if (!value) return '-';
  return new Date(value).toLocaleTimeString();
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function localDateStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function exportGatewayConfiguration() {
  const a = document.createElement('a');
  a.href = '/console/config/export?download=1';
  a.download = `st-claude-cache-gateway-config-${localDateStamp()}.json`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setStatus('配置下载已开始；文件中的 upstreamMode / upstreamBaseUrl 仅供参考，导入时不会覆盖当前连接。');
}

async function importGatewayConfiguration(file) {
  if (!file) return;
  const raw = await file.text();
  const configuration = JSON.parse(raw.replace(/^\uFEFF/, ''));
  await postJson('/console/config/import', configuration);
  state.usagePreviewEditing = false;
  await refreshAll();
  setStatus('配置已导入；当前 upstreamMode、upstreamBaseUrl、渠道 Profile 和 anchorState 均未被覆盖。');
}

async function restoreDefaultGatewayConfiguration() {
  if (!window.confirm('确认读取 default-gateway-settings.json 并恢复默认配置吗？当前上游模式、Base URL 与渠道 Profile 会保留，学习数据会清空。')) {
    return;
  }
  await postJson('/console/config/reset', {});
  state.usagePreviewEditing = false;
  await refreshAll();
  setStatus('已从 default-gateway-settings.json 恢复默认配置；当前上游连接保持不变。');
}

function setStatus(message) {
  const hint = $('selectedHint');
  if (hint) hint.textContent = message;
}

function clearNode(root) {
  root.replaceChildren();
}

function appendText(parent, tag, value, className) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text(value);
  parent.appendChild(el);
  return el;
}

function usageAppearanceStyle(appearance, path) {
  let current = appearance;
  for (const key of path) current = current?.[key];
  return current && typeof current === 'object' ? current : null;
}

function setUsageAppearanceVariables(appearance, root = document.documentElement) {
  if (!appearance || !root?.style?.setProperty) return;
  for (const field of USAGE_APPEARANCE_FIELDS) {
    const style = usageAppearanceStyle(appearance, field.path);
    if (!style) continue;
    root.style.setProperty(`--usage-${field.cssKey}-text`, style.textColor);
    root.style.setProperty(`--usage-${field.cssKey}-background`, style.backgroundColor || 'transparent');
  }
}

function usageAppearanceControl(field) {
  return document.querySelector(`[data-usage-style="${field.path.join('.')}"]`);
}

function collectUsageAppearanceDraft() {
  const appearance = { hitRate: {} };
  for (const field of USAGE_APPEARANCE_FIELDS) {
    const row = usageAppearanceControl(field);
    if (!row) continue;
    const value = {
      textColor: row.querySelector('[data-usage-text-color]').value.toUpperCase(),
      backgroundColor: row.querySelector('[data-usage-background-transparent]').checked
        ? null
        : row.querySelector('[data-usage-background-color]').value.toUpperCase(),
    };
    if (field.path.length === 1) appearance[field.path[0]] = value;
    else appearance[field.path[0]][field.path[1]] = value;
  }
  return appearance;
}

function collectUsagePreviewSample() {
  const token = (id, fallback) => {
    const value = Number($(id)?.value);
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  };
  const rate = Number($('usageSampleHitRate')?.value);
  return {
    inputTokens: token('usageSampleInputTokens', DEFAULT_USAGE_PREVIEW_SAMPLE.inputTokens),
    outputTokens: token('usageSampleOutputTokens', DEFAULT_USAGE_PREVIEW_SAMPLE.outputTokens),
    cacheReadTokens: token('usageSampleCacheReadTokens', DEFAULT_USAGE_PREVIEW_SAMPLE.cacheReadTokens),
    cacheWriteTokens: token('usageSampleCacheWriteTokens', DEFAULT_USAGE_PREVIEW_SAMPLE.cacheWriteTokens),
    cacheHitRatePercent: Number.isFinite(rate) && rate >= 0 && rate <= 100
      ? rate
      : DEFAULT_USAGE_PREVIEW_SAMPLE.cacheHitRatePercent,
  };
}

function renderUsagePreviewMode() {
  const editor = $('usagePreviewEditor');
  const preview = $('usageAppearancePreview');
  const done = $('usagePreviewDone');
  if (editor) editor.hidden = !state.usagePreviewEditing;
  if (preview) preview.hidden = state.usagePreviewEditing;
  if (done) done.hidden = !state.usagePreviewEditing;
}

function setUsagePreviewEditing(editing, focusId = null) {
  state.usagePreviewEditing = Boolean(editing);
  renderUsagePreviewMode();
  if (state.usagePreviewEditing && focusId) {
    queueMicrotask(() => $(focusId)?.focus());
  }
}

function calculateUsagePreviewSample(sample, changedField) {
  const next = {
    inputTokens: Math.max(0, Math.round(Number(sample?.inputTokens) || 0)),
    outputTokens: Math.max(0, Math.round(Number(sample?.outputTokens) || 0)),
    cacheReadTokens: Math.max(0, Math.round(Number(sample?.cacheReadTokens) || 0)),
    cacheWriteTokens: Math.max(0, Math.round(Number(sample?.cacheWriteTokens) || 0)),
    cacheHitRatePercent: Math.min(100, Math.max(0, Number(sample?.cacheHitRatePercent) || 0)),
  };

  if (changedField === 'cacheReadTokens') {
    next.cacheReadTokens = Math.min(next.inputTokens, next.cacheReadTokens);
    next.cacheHitRatePercent = next.inputTokens > 0
      ? Number(((next.cacheReadTokens / next.inputTokens) * 100).toFixed(2))
      : 0;
  } else if (changedField === 'inputTokens' || changedField === 'cacheHitRatePercent') {
    next.cacheHitRatePercent = Number(next.cacheHitRatePercent.toFixed(2));
    next.cacheReadTokens = Math.round(next.inputTokens * next.cacheHitRatePercent / 100);
  }

  return next;
}

function updateUsagePreviewDerived(changedField) {
  const next = calculateUsagePreviewSample(collectUsagePreviewSample(), changedField);
  renderUsagePreviewSampleControls(next);
  renderUsageAppearancePreview();
}

function usagePreviewFocusTarget(eventTarget) {
  const className = String(eventTarget?.className || '');
  if (className.includes('usage-value-input')) return 'usageSampleInputTokens';
  if (className.includes('usage-value-output')) return 'usageSampleOutputTokens';
  if (className.includes('usage-value-cache-read')) return 'usageSampleCacheReadTokens';
  if (className.includes('usage-value-cache-write')) return 'usageSampleCacheWriteTokens';
  if (className.includes('usage-rate-value') || className.includes('usage-rate-row')) return 'usageSampleHitRate';
  return 'usageSampleInputTokens';
}

function renderUsagePreviewSampleControls(sample = DEFAULT_USAGE_PREVIEW_SAMPLE) {
  if ($('usageSampleInputTokens')) $('usageSampleInputTokens').value = String(sample.inputTokens);
  if ($('usageSampleOutputTokens')) $('usageSampleOutputTokens').value = String(sample.outputTokens);
  if ($('usageSampleCacheReadTokens')) $('usageSampleCacheReadTokens').value = String(sample.cacheReadTokens);
  if ($('usageSampleCacheWriteTokens')) $('usageSampleCacheWriteTokens').value = String(sample.cacheWriteTokens);
  if ($('usageSampleHitRate')) $('usageSampleHitRate').value = String(sample.cacheHitRatePercent);
}

function renderUsageAppearancePreview(appearance = collectUsageAppearanceDraft()) {
  const preview = $('usageAppearancePreview');
  if (!preview) return;
  setUsageAppearanceVariables(appearance, preview);
  renderUsageLines(preview, collectUsagePreviewSample(), 'detail usage-preview');
}

function renderUsageAppearanceControls(appearance) {
  if (!appearance) return;
  for (const field of USAGE_APPEARANCE_FIELDS) {
    const row = usageAppearanceControl(field);
    const style = usageAppearanceStyle(appearance, field.path);
    if (!row || !style) continue;
    const textInput = row.querySelector('[data-usage-text-color]');
    const backgroundInput = row.querySelector('[data-usage-background-color]');
    const transparentInput = row.querySelector('[data-usage-background-transparent]');
    textInput.value = style.textColor;
    backgroundInput.value = style.backgroundColor || '#FFFFFF';
    transparentInput.checked = style.backgroundColor === null;
    backgroundInput.disabled = transparentInput.checked;
  }
  renderUsageAppearancePreview(appearance);
}

function setRequestCacheAppearanceVariables(appearance, root = document.documentElement) {
  if (!appearance || !root?.style?.setProperty) return;
  for (const field of REQUEST_CACHE_APPEARANCE_FIELDS) {
    const style = appearance?.[field.key];
    if (!style) continue;
    root.style.setProperty(`--request-cache-${field.cssKey}-text`, style.textColor);
    root.style.setProperty(`--request-cache-${field.cssKey}-background`, style.backgroundColor || 'transparent');
  }
}

function requestCacheAppearanceControl(field) {
  return document.querySelector(`[data-request-cache-style="${field.key}"]`);
}

function collectRequestCacheAppearanceDraft() {
  const appearance = {};
  for (const field of REQUEST_CACHE_APPEARANCE_FIELDS) {
    const row = requestCacheAppearanceControl(field);
    if (!row) continue;
    appearance[field.key] = {
      textColor: row.querySelector('[data-request-cache-text-color]').value.toUpperCase(),
      backgroundColor: row.querySelector('[data-request-cache-background-transparent]').checked
        ? null
        : row.querySelector('[data-request-cache-background-color]').value.toUpperCase(),
    };
  }
  return appearance;
}

function renderRequestCacheAppearancePreview(appearance = collectRequestCacheAppearanceDraft()) {
  const preview = $('requestCacheAppearancePreview');
  if (!preview) return;
  setRequestCacheAppearanceVariables(appearance, preview);
  const sample = {
    prefixLockEnabled: true,
    prefixLockAction: 'replaced',
    cacheAnchorMode: 'rolling',
    cacheTranslationEnabled: true,
    cachePolicyAction: 'rotation-paused',
    cachePolicyReason: 'anchor-budget-unavailable',
    cacheContextHash: '6124045f59ab',
    changedBlockCount: 2,
  };
  renderRequestCacheSummary(preview, sample);
  if (!preview.querySelector?.('.request-cache-summary')) {
    clearNode(preview);
    const fallback = document.createElement('div');
    fallback.className = 'request-cache-summary';
    for (const [label, value, kind] of [
      ['强制 Prefix 锁定', '开启 · 已应用', 'prefix-lock'],
      ['缓存锚点', '滚动锚点', 'cache-anchor'],
      ['锚点状态', '轮换暂停', 'cache-anchor'],
    ]) {
      const row = appendRequestCacheSummaryRow(fallback, label, kind);
      appendText(row, 'span', value, 'request-cache-summary-text request-cache-appearance-value');
    }
    let row = appendRequestCacheSummaryRow(fallback, '缓存点额度不足');
    appendText(row, 'span', '缓存点额度不足', 'request-cache-status-chip request-cache-budget-insufficient-chip');
    row = appendRequestCacheSummaryRow(fallback, '块哈希变更');
    appendText(row, 'span', '2', 'request-cache-status-chip request-cache-summary-id request-cache-block-hash-change-chip');
    preview.appendChild(fallback);
  }
}

function renderRequestCacheAppearanceControls(appearance) {
  if (!appearance) return;
  for (const field of REQUEST_CACHE_APPEARANCE_FIELDS) {
    const row = requestCacheAppearanceControl(field);
    const style = appearance[field.key];
    if (!row || !style) continue;
    const textInput = row.querySelector('[data-request-cache-text-color]');
    const backgroundInput = row.querySelector('[data-request-cache-background-color]');
    const transparentInput = row.querySelector('[data-request-cache-background-transparent]');
    textInput.value = style.textColor;
    backgroundInput.value = style.backgroundColor || '#FFFFFF';
    transparentInput.checked = style.backgroundColor === null;
    backgroundInput.disabled = transparentInput.checked;
  }
  renderRequestCacheAppearancePreview(appearance);
}

function renderKv(root, entries) {
  clearNode(root);
  for (const [key, value, options = {}] of entries) {
    const row = document.createElement('div');
    row.className = 'kv';
    appendText(row, 'span', key);
    const v = document.createElement('span');
    if (options.mono) v.className = 'kv-mono';
    if (options.link && value) {
      const a = document.createElement('a');
      a.href = '#';
      a.className = 'kv-mono prefix-link';
      a.textContent = String(value);
      a.onclick = options.link;
      v.appendChild(a);
    } else {
      v.textContent = text(value);
    }
    row.appendChild(v);
    root.appendChild(row);
  }
}

function setDrawerOpen(id, open) {
  const drawer = $(id);
  if (!drawer) return;
  drawer.classList.toggle('open', open);
  drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
}

function setMobileMenuHidden(hidden) {
  if (document.body.classList.contains('nav-open')) return;
  document.body.classList.toggle('mobile-menu-hidden', hidden);
}

function setMobileNavOpen(open) {
  document.body.classList.toggle('nav-open', open);
  document.body.classList.remove('mobile-menu-hidden');
  $('mobileMenuButton').setAttribute('aria-expanded', open ? 'true' : 'false');
}

function bindMobileMenuScroll() {
  let lastY = window.scrollY || 0;

  window.addEventListener('scroll', () => {
    if (window.innerWidth > 980 || document.body.classList.contains('nav-open')) return;

    const currentY = window.scrollY || 0;
    const delta = currentY - lastY;

    if (Math.abs(delta) < 8) return;

    if (delta > 0 && currentY > 80) {
      setMobileMenuHidden(true);
    } else if (delta < 0) {
      setMobileMenuHidden(false);
    }

    lastY = currentY;
  }, { passive: true });
}

function switchPage(page) {
  for (const item of document.querySelectorAll('.nav-item')) {
    item.classList.toggle('active', item.dataset.page === page);
  }
  for (const item of document.querySelectorAll('.page')) {
    item.classList.toggle('active', item.id === `page-${page}`);
  }
  $('pageTitle').textContent = pages[page] || page;
  setMobileNavOpen(false);
  if (page === 'logs') renderRequests();
}

function channelName(runtime) {
  if (!runtime) return '加载中';
  if (runtime.activeChannel?.name) return runtime.activeChannel.name;
  if (runtime.upstreamBaseUrl.includes('openrouter.ai')) return 'OpenRouter';
  if (runtime.upstreamBaseUrl.includes('anthropic.com')) return 'Anthropic';
  if (runtime.upstreamBaseUrl.includes('bedrock')) return 'Amazon Bedrock';
  if (runtime.upstreamBaseUrl.includes('googleapis.com')) return 'Google Vertex';
  return 'Custom/当前供应商';
}

function normalizeOpenRouterProvider(provider) {
  const normalized = typeof provider === 'string' ? provider.trim() : '';
  const aliases = {
    'Amazon Bedrock': 'amazon-bedrock',
    Anthropic: 'anthropic',
    'Google Vertex': 'google-vertex',
    'Google AI Studio': 'google-ai-studio',
  };
  return aliases[normalized] || normalized;
}

function providerFromExtraJson(extraJson) {
  const order = extraJson?.provider?.order;
  return Array.isArray(order) && order.length ? normalizeOpenRouterProvider(String(order[0])) : '';
}

function providerExtraJson(provider) {
  const normalized = normalizeOpenRouterProvider(provider);
  return normalized ? { provider: { order: [normalized], allow_fallbacks: false } } : {};
}

function readOpenRouterProvider(card) {
  const provider = card.querySelector('[data-channel-provider]')?.value || '';
  if (provider === '__custom') {
    return card.querySelector('[data-channel-provider-custom]')?.value.trim() || '';
  }
  return provider;
}

function getProfileById(id) {
  return state.runtime?.channels?.find((profile) => profile.id === id) || null;
}

function renderTopbar() {
  const runtime = state.runtime;
  if (!runtime) return;
  const policy = getCachePolicy(runtime);
  $('topChannel').textContent = `渠道：${channelName(runtime)}`;
  $('topCapture').textContent = `诊断：${runtime.captureRequests ? '开启' : '关闭'} / ${runtime.capturedRequests}`;
  $('topPrefix').textContent = runtime.prefixLockActive || runtime.prefixLockEnabled
    ? `Prefix：${runtime.prefixLockActive ? '开启' : '学习'}`
    : `锚点：${cacheAnchorModeLabel(policy.cacheAnchorMode)}`;
}

function setSegActive(rootId, value, dataKey = 'ttl') {
  const root = $(rootId);
  if (!root) return;
  for (const button of root.querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset[dataKey] === value);
  }
}

function renderCaptureControls() {
  const runtime = state.runtime;
  if (!runtime) return;

  $('mockCaptureState').textContent = runtime.captureRequests ? '已开启' : '已关闭';
  $('mockCaptureState').style.color = runtime.captureRequests ? 'var(--text-main)' : 'var(--text-muted)';
  $('quickCaptureSwitch').checked = Boolean(runtime.captureRequests);
  $('logsCaptureState').textContent = runtime.captureRequests ? '已开启' : '已关闭';
  $('logsCaptureState').style.color = runtime.captureRequests ? 'var(--text-main)' : 'var(--text-muted)';
  $('logsCaptureSwitch').checked = Boolean(runtime.captureRequests);
  if ($('maxRequestCaptures')) $('maxRequestCaptures').value = String(runtime.maxRequestCaptures || 20);
  const logPersistence = runtime.persistence?.requestLogs || {};
  const persistenceMessage = logPersistence.lastError
    ? `本地日志写入失败：${logPersistence.lastError}`
    : logPersistence.lastSavedAt
      ? `完整诊断日志已保存到本地；最近保存：${new Date(logPersistence.lastSavedAt).toLocaleString()}。日志可能包含私密提示词。`
      : `${logPersistence.notice || '完整诊断日志将在首次捕获后保存到本地。'} 日志可能包含私密提示词。`;
  if ($('requestLogPersistenceStatus')) {
    $('requestLogPersistenceStatus').textContent = persistenceMessage;
    $('requestLogPersistenceStatus').className = `note log-persistence-note ${logPersistence.lastError ? 'danger' : ''}`.trim();
  }
}

function renderDashboard() {
  const runtime = state.runtime;
  if (!runtime) return;
  const policy = getCachePolicy(runtime);
  $('sidebarAddress').textContent = `${runtime.host}:${runtime.port}`;
  $('statCacheTranslation').textContent = runtime.cacheTranslationEnabled ? '开启' : '关闭';
  $('cacheTranslationSwitch').checked = Boolean(runtime.cacheTranslationEnabled);
  $('statUpstreamMode').textContent = upstreamModeLabel(runtime.upstreamMode);
  $('statUpstreamUrl').textContent = runtime.upstreamBaseUrl;
  $('statTtl').textContent = ttlLabel(runtime.cacheTtl);
  $('statPrefixHash').textContent = compactHash(runtime.prefixLockHash);
  $('statPrefixDetail').textContent = runtime.prefixLockActive ? `${runtime.prefixLockReplacements || 0} 次替换 · ${runtime.prefixLockFirstCacheControlPath || '-'}` : '尚未锁定';
  renderCaptureControls();
  $('mockLockState').textContent = runtime.prefixLockActive ? '开启' : runtime.prefixLockEnabled ? '学习' : '关闭';
  $('mockLockState').style.color = runtime.prefixLockEnabled ? 'var(--success)' : 'var(--text-muted)';
  $('quickPrefixSwitch').checked = Boolean(runtime.prefixLockEnabled);
  $('mockTtlState').textContent = ttlLabel(runtime.cacheTtl);
  setSegActive('quickTtlSeg', ttlSelectionValue(runtime.cacheTtl));

  renderKv($('runtimeKv'), [
    ['本地 URL', `http://${runtime.host}:${runtime.port}`, { mono: true }],
    ['缓存转译', runtime.cacheTranslationEnabled ? '开启' : '关闭'],
    ['系统身份消息处理', systemMessageHandlingLabel(runtime)],
    ['自动断点', autoBreakpointModeLabel(runtime)],
    ['上游连接', runtime.upstreamBaseUrl, { mono: true }],
    ['上游格式', upstreamModeLabel(runtime.upstreamMode)],
    ['当前渠道', channelName(runtime)],
    ['断点保留', cachePolicyLabel(policy)],
    ['最新 Prefix Hash', runtime.prefixLockHash || '-', { mono: true }],
    ['额外 JSON 键', runtime.upstreamExtraJsonEnabled ? runtime.upstreamExtraJsonKeys.join(', ') : '关闭'],
  ]);
}

function buildChannelPayload(card, profile) {
  const provider = readOpenRouterProvider(card);
  return {
    name: profile.kind === 'builtin' ? profile.name : card.querySelector('[data-channel-name]')?.value,
    baseUrl: card.querySelector('[data-channel-url]')?.value,
    upstreamMode: card.querySelector('[data-channel-mode]')?.value,
    upstreamExtraJson: profile.id === 'openrouter' ? providerExtraJson(provider) : profile.upstreamExtraJson || {},
    upstreamExcludePaths: profile.upstreamExcludePaths || [],
    upstreamHeaders: profile.upstreamHeaders || {},
    upstreamExcludeHeaders: profile.upstreamExcludeHeaders || [],
  };
}

async function saveChannelProfile(card, profile) {
  const payload = buildChannelPayload(card, profile);
  if (profile.isDraft) {
    await postJson('/console/channels', payload);
    state.channelDrafts = state.channelDrafts.filter((draft) => draft.id !== profile.id);
  } else {
    await postJson(`/console/channels/${encodeURIComponent(profile.id)}`, payload);
  }
  await refreshAll();
  setStatus(`渠道已保存：${payload.name || profile.name}`);
}

async function activateChannelProfile(card, profile) {
  const payload = buildChannelPayload(card, profile);
  if (profile.isDraft) {
    await postJson('/console/channels', payload);
    state.channelDrafts = state.channelDrafts.filter((draft) => draft.id !== profile.id);
    await refreshAll();
    setStatus(`渠道已保存并启用：${payload.name || profile.name}`);
    return;
  }
  await saveChannelProfile(card, profile);
  await postJson(`/console/channels/${encodeURIComponent(profile.id)}/activate`, {});
  await refreshAll();
  setStatus(`当前渠道已切换为：${profile.name}`);
}

async function deleteChannelProfile(profile) {
  if (profile.isDraft) {
    state.channelDrafts = state.channelDrafts.filter((draft) => draft.id !== profile.id);
    renderChannels();
    setStatus(`已移除草稿渠道：${profile.name}`);
    return;
  }
  await postJson(`/console/channels/${encodeURIComponent(profile.id)}/delete`, {});
  await refreshAll();
  setStatus(`已删除渠道：${profile.name}`);
}

function renderChannelCard(profile) {
  const card = document.createElement('article');
  card.className = `channel-card ${profile.id === state.runtime.activeChannelId ? 'active' : ''}`.trim();
  card.dataset.channel = profile.id;

  if (profile.kind !== 'builtin') {
    const del = appendText(card, 'button', '×', 'card-del');
    del.type = 'button';
    del.title = '删除渠道';
    del.setAttribute('aria-label', `删除渠道：${profile.name}`);
    del.onclick = (event) => {
      event.stopPropagation();
      deleteChannelProfile(profile).catch((error) => setStatus(error.message));
    };
  }

  const title = document.createElement('h3');
  if (profile.kind === 'builtin') {
    title.textContent = profile.name;
  } else {
    title.className = 'editable-title';
    const nameButton = appendText(title, 'button', profile.name || '自定义渠道', 'name-display');
    nameButton.type = 'button';
    nameButton.title = '点击编辑渠道名称';
    const nameInput = document.createElement('input');
    nameInput.className = 'name-input';
    nameInput.dataset.channelName = 'true';
    nameInput.value = profile.name;
    nameInput.placeholder = '渠道名称';
    nameInput.hidden = true;

    const finishNameEdit = () => {
      const nextName = nameInput.value.trim() || profile.name || '自定义渠道';
      nameInput.value = nextName;
      nameButton.textContent = nextName;
      nameInput.hidden = true;
      nameButton.hidden = false;
    };
    const startNameEdit = () => {
      nameButton.hidden = true;
      nameInput.hidden = false;
      nameInput.focus();
      nameInput.select();
    };

    nameButton.onclick = startNameEdit;
    nameInput.onblur = finishNameEdit;
    nameInput.onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        nameInput.blur();
      } else if (event.key === 'Escape') {
        nameInput.value = nameButton.textContent;
        nameInput.blur();
      }
    };

    title.appendChild(nameButton);
    title.appendChild(nameInput);
  }
  card.appendChild(title);

  const form = document.createElement('div');
  form.className = 'channel-form';
  const row = document.createElement('div');
  row.className = profile.id === 'openrouter' ? 'form-row' : '';

  const urlLabel = document.createElement('label');
  urlLabel.textContent = '上游 URL';
  const urlInput = document.createElement('input');
  urlInput.dataset.channelUrl = 'true';
  urlInput.value = profile.baseUrl;
  urlInput.placeholder = '';
  urlLabel.appendChild(urlInput);
  row.appendChild(urlLabel);

  if (profile.id === 'openrouter') {
    const providerLabelEl = document.createElement('label');
    providerLabelEl.textContent = '锁定供应商';
    const providerSelect = document.createElement('select');
    providerSelect.dataset.channelProvider = 'true';
    const currentProvider = providerFromExtraJson(profile.upstreamExtraJson);
    const providerOptions = [
      ['', '无（不锁定）'],
      ['amazon-bedrock', 'Amazon Bedrock'],
      ['anthropic', 'Anthropic'],
      ['google-vertex', 'Google Vertex'],
    ];
    const isKnownProvider = providerOptions.some(([value]) => value === currentProvider);
    for (const [value, label] of providerOptions) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      providerSelect.appendChild(option);
    }
    const customOption = document.createElement('option');
    customOption.value = '__custom';
    customOption.textContent = '自定义供应商…';
    providerSelect.appendChild(customOption);
    providerSelect.value = isKnownProvider ? currentProvider : '__custom';
    providerLabelEl.appendChild(providerSelect);
    row.appendChild(providerLabelEl);

    const customProviderLabel = document.createElement('label');
    customProviderLabel.className = 'custom-provider-field';
    customProviderLabel.textContent = '自定义供应商名称';
    const customProviderInput = document.createElement('input');
    customProviderInput.dataset.channelProviderCustom = 'true';
    customProviderInput.placeholder = '例如 DeepInfra / Fireworks / Novita';
    customProviderInput.value = isKnownProvider ? '' : currentProvider;
    customProviderLabel.appendChild(customProviderInput);
    customProviderLabel.hidden = providerSelect.value !== '__custom';
    providerSelect.onchange = () => {
      customProviderLabel.hidden = providerSelect.value !== '__custom';
      if (!customProviderLabel.hidden) customProviderInput.focus();
    };
    form.appendChild(customProviderLabel);
  }
  form.appendChild(row);

  const modeLabel = document.createElement('label');
  modeLabel.textContent = '上游格式';
  const modeSelect = document.createElement('select');
  modeSelect.dataset.channelMode = 'true';
  for (const [value, label] of [['anthropic', 'Anthropic native /v1/messages'], ['openai', 'OpenAI-compatible']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    modeSelect.appendChild(option);
  }
  modeSelect.value = profile.upstreamMode;
  modeLabel.appendChild(modeSelect);
  form.appendChild(modeLabel);
  card.appendChild(form);

  const actions = document.createElement('div');
  actions.className = 'channel-actions';
  const activate = appendText(actions, 'button', profile.id === state.runtime.activeChannelId ? '已启用' : '启用渠道', profile.id === state.runtime.activeChannelId ? 'primary' : '');
  activate.disabled = profile.id === state.runtime.activeChannelId;
  activate.onclick = () => activateChannelProfile(card, profile).catch((error) => setStatus(error.message));
  const save = appendText(actions, 'button', '保存配置', '');
  save.onclick = () => saveChannelProfile(card, profile).catch((error) => setStatus(error.message));
  card.appendChild(actions);

  return card;
}

function renderAddChannelCard() {
  const card = document.createElement('article');
  card.className = 'channel-card add-card';
  card.id = 'addChannelCard';
  const plus = appendText(card, 'div', '+', 'add-plus');
  plus.setAttribute('aria-hidden', 'true');
  appendText(card, 'h3', '自定义渠道');
  card.onclick = () => addCustomChannel().catch((error) => setStatus(error.message));
  return card;
}

function renderChannels() {
  const runtime = state.runtime;
  if (!runtime) return;
  const grid = $('channelGrid');
  clearNode(grid);
  for (const profile of runtime.channels || []) {
    grid.appendChild(renderChannelCard(profile));
  }
  for (const profile of state.channelDrafts) {
    grid.appendChild(renderChannelCard(profile));
  }
  grid.appendChild(renderAddChannelCard());
  $('channelStateBadge').textContent = `${channelName(runtime)} · ${upstreamModeLabel(runtime.upstreamMode)}`;
}

function processingOrderRiskMessages(order) {
  const normalized = normalizeProcessingOrder(order);
  const indexOf = (stage) => normalized.indexOf(stage);
  const warnings = [];

  if (indexOf('ignore-tail') < indexOf('fixed-head')) {
    warnings.push('忽略末尾早于固定头：固定头候选可能先被阻止。');
  }
  if (indexOf('tail-fill') < indexOf('cache-anchor')) {
    warnings.push('普通尾点早于缓存锚点：尾点可能先占满四点预算。');
  }
  if (indexOf('protected-tail-anchor') < indexOf('cache-anchor')) {
    warnings.push('保护尾锚点早于缓存锚点：执行时可能还没有可保护的锚点。');
  }
  if (indexOf('ignore-tail') > indexOf('tail-fill')) {
    warnings.push('忽略末尾晚于普通尾点：已被尾点阶段锁定的候选不会再被忽略。');
  }
  if (indexOf('last-gateway-cache-point-5m') !== normalized.length - 1) {
    warnings.push('末缓存点 5m 不在最后：可能无点可处理，或之后新增的末点仍保持原 TTL。');
  }

  return warnings;
}

function moveProcessingStage(stage, offset) {
  const order = normalizeProcessingOrder(state.processingOrderDraft);
  const index = order.indexOf(stage);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= order.length) return;
  [order[index], order[target]] = [order[target], order[index]];
  state.processingOrderDraft = order;
  renderCacheProcessingOrder();
  scheduleCachePolicyAutoApply();
}

function renderCacheProcessingOrder(order = state.processingOrderDraft) {
  const root = $('cacheProcessingOrderList');
  if (!root) return;
  const normalized = normalizeProcessingOrder(order);
  state.processingOrderDraft = normalized;
  clearNode(root);

  for (const [index, stage] of normalized.entries()) {
    const info = CACHE_POLICY_STAGE_INFO[stage];
    const fixedNumber = DEFAULT_CACHE_POLICY_PROCESSING_ORDER.indexOf(stage) + 1;
    const isInactive = stage === 'last-gateway-cache-point-5m'
      && !$('autoConvertLastAnchorTo5m')?.checked;
    const row = document.createElement('div');
    row.className = `processing-order-item ${isInactive ? 'inactive' : ''}`.trim();
    row.draggable = true;
    row.dataset.stage = stage;
    row.tabIndex = 0;
    appendText(row, 'span', fixedNumber, 'processing-order-index');
    appendText(row, 'span', '⋮⋮', 'processing-order-drag');
    const content = document.createElement('div');
    content.className = 'processing-order-content';
    appendText(content, 'strong', `${info.label}${isInactive ? '（未启用）' : ''}`);
    appendText(content, 'span', info.description);
    row.appendChild(content);
    const actions = document.createElement('div');
    actions.className = 'processing-order-actions';
    const up = appendText(actions, 'button', '上移', 'ghost small');
    const down = appendText(actions, 'button', '下移', 'ghost small');
    up.type = 'button';
    down.type = 'button';
    up.disabled = index === 0;
    down.disabled = index === normalized.length - 1;
    up.onclick = () => moveProcessingStage(stage, -1);
    down.onclick = () => moveProcessingStage(stage, 1);
    row.appendChild(actions);
    row.ondragstart = (event) => {
      event.dataTransfer?.setData('text/plain', stage);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    };
    row.ondragend = () => row.classList.remove('dragging');
    row.ondragover = (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    };
    row.ondrop = (event) => {
      event.preventDefault();
      const sourceStage = event.dataTransfer?.getData('text/plain');
      if (!sourceStage || sourceStage === stage) return;
      const next = normalizeProcessingOrder(state.processingOrderDraft);
      const sourceIndex = next.indexOf(sourceStage);
      const targetIndex = next.indexOf(stage);
      if (sourceIndex < 0 || targetIndex < 0) return;
      next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, sourceStage);
      state.processingOrderDraft = next;
      renderCacheProcessingOrder();
      scheduleCachePolicyAutoApply();
    };
    root.appendChild(row);
  }

  const warnings = processingOrderRiskMessages(normalized);
  const warningRoot = $('cacheProcessingOrderWarning');
  if (warningRoot) {
    warningRoot.textContent = warnings.length
      ? warnings.join(' ')
      : '当前为推荐顺序：固定头先保护，末缓存点 5m 最后处理。';
    warningRoot.className = `processing-order-warning ${warnings.length ? 'warning' : 'success'}`;
  }
}

function readCachePolicyForm() {
  return {
    fixedHeadBreakpointCount: integerInRange($('fixedHeadBreakpointCount')?.value, 0, CACHE_BREAKPOINT_LIMIT, 0),
    cacheAnchorMode: ['off', 'single', 'rolling'].includes($('cacheAnchorMode')?.value) ? $('cacheAnchorMode').value : 'off',
    cacheAnchorIntervalBlocks: integerInRange($('cacheAnchorIntervalBlocks')?.value, 1, 1000, 3),
    cachePolicyProcessingOrder: normalizeProcessingOrder(state.processingOrderDraft),
    autoConvertLastAnchorTo5m: Boolean($('autoConvertLastAnchorTo5m')?.checked),
    ignoreLastAnchorsMode: ['fixed', 'evaluation'].includes($('ignoreLastAnchorsMode')?.value) ? $('ignoreLastAnchorsMode').value : 'fixed',
    ignoreLastAnchorCount: nonNegativeInteger($('ignoreLastAnchorCount')?.value, 0),
  };
}

function renderCachePolicyBudget(useDraft = false) {
  const current = getCachePolicy();
  const policy = useDraft ? readCachePolicyForm() : current;
  const intervalInput = $('cacheAnchorIntervalBlocks');
  if (intervalInput) intervalInput.disabled = policy.cacheAnchorMode !== 'rolling';

  const root = $('cachePolicyBudget');
  if (!root) return;
  clearNode(root);

  if (policy.fixedHeadBreakpointCount === 0 && policy.cacheAnchorMode === 'off') {
    for (let index = 0; index < CACHE_BREAKPOINT_LIMIT; index += 1) {
      appendText(root, 'span', `前点 ${index + 1}`, 'budget-slot head');
    }
    $('cachePolicyBudgetText').textContent = '兼容模式 · 保留最前 4 个候选点';
    $('cachePolicyHint').textContent = '固定头为 0 且锚点关闭时，选择行为与旧版本完全一致：保留最前 4 个断点。';
    return;
  }

  const samePolicy = policy.fixedHeadBreakpointCount === current.fixedHeadBreakpointCount
    && policy.cacheAnchorMode === current.cacheAnchorMode
    && policy.cacheAnchorIntervalBlocks === current.cacheAnchorIntervalBlocks;
  const anchorState = samePolicy ? current.anchorState : {};
  const activeCount = Math.max(0, Number(anchorState.activeAnchorCount) || 0);
  const retiringCount = Math.max(0, Number(anchorState.retiringAnchorCount ?? anchorState.pendingEvictionAnchorCount) || 0);
  const capacity = CACHE_BREAKPOINT_LIMIT - policy.fixedHeadBreakpointCount;
  let slotsLeft = CACHE_BREAKPOINT_LIMIT;

  for (let index = 0; index < policy.fixedHeadBreakpointCount; index += 1) {
    appendText(root, 'span', `固定头 ${index + 1}`, 'budget-slot head');
    slotsLeft -= 1;
  }
  while (slotsLeft > 0) {
    const label = policy.cacheAnchorMode === 'off'
      ? '最新尾点'
      : policy.cacheAnchorMode === 'single' && slotsLeft === capacity
        ? '锚点优先'
        : '锚点 / 尾点共享';
    appendText(root, 'span', label, policy.cacheAnchorMode !== 'off' ? 'budget-slot anchor' : 'budget-slot');
    slotsLeft -= 1;
  }

  $('cachePolicyBudgetText').textContent = `固定头 ${policy.fixedHeadBreakpointCount} · 单请求共享 ${capacity} · 内存锚点 ${activeCount}+${retiringCount}`;
  if (capacity === 0 && policy.cacheAnchorMode !== 'off') {
    $('cachePolicyHint').textContent = '固定头已占满全部 4 点，锚点当前没有可用配额；减少固定头数量后才能学习或轮换。';
  } else {
    $('cachePolicyHint').textContent = `固定头、锚点和最新普通尾点按优先级共用 4 点；调用方已有 cache_control 还会先占用其中的位置。${policy.cacheAnchorMode === 'rolling' ? ` 滚动间隔：${policy.cacheAnchorIntervalBlocks} 块。` : ''}`;
  }
}

function renderCache() {
  const runtime = state.runtime;
  if (!runtime) return;
  const policy = getCachePolicy(runtime);
  const anchorState = policy.anchorState;
  setSegActive('cacheTtlSeg', ttlSelectionValue(runtime.cacheTtl));
  setSegActive('autoGenerateCacheBreakpointsSeg', autoBreakpointMode(runtime), 'autoBreakpoints');
  setSegActive('systemMessageHandlingSeg', systemMessageHandlingMode(runtime), 'systemMessageMode');
  $('fixedHeadBreakpointCount').value = String(policy.fixedHeadBreakpointCount);
  $('cacheAnchorMode').value = policy.cacheAnchorMode;
  $('cacheAnchorIntervalBlocks').value = String(policy.cacheAnchorIntervalBlocks);
  $('autoConvertLastAnchorTo5m').checked = policy.autoConvertLastAnchorTo5m;
  $('ignoreLastAnchorsMode').value = policy.ignoreLastAnchorsMode;
  $('ignoreLastAnchorCount').value = String(policy.ignoreLastAnchorCount);
  state.processingOrderDraft = [...policy.cachePolicyProcessingOrder];
  renderCacheProcessingOrder();
  if ($('cachePolicyAutoSaveState') && !cachePolicyAutoApplyTimer) {
    $('cachePolicyAutoSaveState').textContent = '修改后自动应用';
    $('cachePolicyAutoSaveState').className = 'badge success';
  }
  const evaluation = runtime.anchorIgnoreEvaluation || {};
  const evaluationActive = policy.ignoreLastAnchorsMode === 'evaluation' && Boolean(evaluation.active);
  const evaluationResult = Number.isInteger(evaluation.result) ? evaluation.result : null;
  $('ignoreLastAnchorCount').disabled = policy.ignoreLastAnchorsMode === 'evaluation';
  $('anchorIgnoreEvaluationStart').textContent = evaluation.pendingReview ? '重新评估' : evaluationActive ? '评估中' : '开始评估';
  $('anchorIgnoreEvaluationStart').disabled = evaluationActive;
  $('anchorIgnoreEvaluationAccept').hidden = !evaluation.pendingReview || evaluationResult === null;
  $('anchorIgnoreEvaluationAccept').textContent = evaluationResult === null ? '填入结果' : `仍填入 x=${evaluationResult}`;
  const evaluationStatus = $('anchorIgnoreEvaluationStatus');
  if (evaluationStatus) {
    const messages = [];
    if (evaluationActive) {
      messages.push(`评估进行中：已完成 ${evaluation.requestsCompleted || 0} / ${evaluation.requiredRequests || 3} 次对话，当前 x=0，还需 ${evaluation.requestsRemaining ?? 3} 次。`);
    } else if (evaluation.pendingReview) {
      messages.push(evaluation.notice || `评估结果为 x=${evaluation.result ?? evaluation.x}，请检查预设后决定是否填入。`);
    } else if (evaluation.notice) {
      messages.push(evaluation.notice);
    } else if (policy.ignoreLastAnchorsMode === 'fixed' && policy.ignoreLastAnchorCount > 5) {
      messages.push(`当前 x=${policy.ignoreLastAnchorCount}，已超出建议范围 0–5。`);
    }
    evaluationStatus.textContent = messages.join(' ');
    const warning = evaluation.pendingReview
      || (policy.ignoreLastAnchorsMode === 'fixed' && policy.ignoreLastAnchorCount > 5);
    evaluationStatus.className = `anchor-ignore-status ${warning ? 'warning' : evaluationActive ? 'success' : ''}`.trim();
  }
  const noAnchorCapacity = policy.cacheAnchorMode !== 'off' && policy.fixedHeadBreakpointCount >= CACHE_BREAKPOINT_LIMIT;
  $('cachePolicyBadge').textContent = noAnchorCapacity ? '锚点无配额' : cachePolicyLabel(policy);
  $('cachePolicyBadge').classList.toggle('off', policy.fixedHeadBreakpointCount === 0 && policy.cacheAnchorMode === 'off');
  $('cachePolicyBadge').classList.toggle('warning', noAnchorCapacity);
  renderCachePolicyBudget();
  const runtimePersistence = runtime.persistence?.runtimeState || {};
  renderKv($('cacheAnchorKv'), [
    ['本地上下文', `${anchorState.contextCount ?? 0} / ${anchorState.maxContexts ?? 32}`],
    ['活动锚点', anchorState.activeAnchorCount ?? 0],
    ['待淘汰锚点', anchorState.retiringAnchorCount ?? anchorState.pendingEvictionAnchorCount ?? 0],
    ['最近动作', anchorState.lastAction],
    ['最近原因', anchorState.lastReason],
    ['暂停原因', anchorState.lastPauseReason ?? anchorState.pauseReason],
    ['最近更新', anchorState.lastUpdatedAt ? new Date(anchorState.lastUpdatedAt).toLocaleString() : '-'],
    ['本地保存', runtimePersistence.lastError
      ? `失败：${runtimePersistence.lastError}`
      : runtimePersistence.lastSavedAt
        ? new Date(runtimePersistence.lastSavedAt).toLocaleString()
        : runtimePersistence.notice || '等待首次保存'],
  ]);
  $('prefixLockSwitch').checked = runtime.prefixLockEnabled;
  $('prefixLockBadge').textContent = runtime.prefixLockActive ? '开启' : runtime.prefixLockEnabled ? '学习' : '关闭';
  $('prefixLockBadge').classList.toggle('off', !runtime.prefixLockEnabled);
  renderKv($('prefixLockKv'), [
    ['锁定前缀 ID', runtime.prefixLockHash, { link: openPrefixModal }],
    ['缓存点路径', runtime.prefixLockFirstCacheControlPath, { mono: true }],
    ['已替换次数', runtime.prefixLockReplacements],
    ['最近动作', runtime.prefixLockLastAction],
    ['跳过原因', runtime.prefixLockLastSkipReason],
  ]);
}

function renderAdvanced() {
  const runtime = state.runtime;
  if (!runtime) return;
  $('upstreamExtraJson').value = runtime.upstreamExtraJsonText || '{}';
  $('upstreamExcludePaths').value = runtime.upstreamExcludePathsText || '';
  $('upstreamHeaders').value = runtime.upstreamHeadersText || '{}';
  $('upstreamExcludeHeaders').value = runtime.upstreamExcludeHeadersText || '';
  const includeText = runtime.upstreamExtraJsonEnabled ? `包含 ${runtime.upstreamExtraJsonKeys.length}` : '包含 0';
  const excludeText = runtime.upstreamExcludePathsEnabled ? `排除 ${runtime.upstreamExcludePaths.length}` : '排除 0';
  $('extraJsonBadge').textContent = `${includeText} / ${excludeText}`;
  $('extraJsonBadge').className = `badge ${runtime.upstreamExtraJsonEnabled || runtime.upstreamExcludePathsEnabled ? 'success' : ''}`;
  const headerIncludeText = runtime.upstreamHeadersEnabled ? `包含 ${runtime.upstreamHeadersKeys.length}` : '包含 0';
  const headerExcludeText = runtime.upstreamExcludeHeadersEnabled ? `排除 ${runtime.upstreamExcludeHeaders.length}` : '排除 0';
  $('headerOverrideBadge').textContent = `${headerIncludeText} / ${headerExcludeText}`;
  $('headerOverrideBadge').className = `badge ${runtime.upstreamHeadersEnabled || runtime.upstreamExcludeHeadersEnabled ? 'success' : ''}`;
  $('usageAppearanceBadge').textContent = '全局配置';
  $('usageAppearanceBadge').className = 'badge success';
  renderUsagePreviewSampleControls(runtime.usagePreviewSample || DEFAULT_USAGE_PREVIEW_SAMPLE);
  renderUsageAppearanceControls(runtime.usageAppearance);
  renderUsagePreviewMode();
  $('requestCacheAppearanceBadge').textContent = '全局配置';
  $('requestCacheAppearanceBadge').className = 'badge success';
  renderRequestCacheAppearanceControls(runtime.requestCacheAppearance || DEFAULT_REQUEST_CACHE_APPEARANCE);
  $('cacheControl').textContent = JSON.stringify({
    cacheTranslationEnabled: runtime.cacheTranslationEnabled,
    systemMessageHandlingMode: systemMessageHandlingMode(runtime),
    autoGenerateCacheBreakpointsMode: autoBreakpointMode(runtime),
    upstreamMode: runtime.upstreamMode,
    upstreamBaseUrl: runtime.upstreamBaseUrl,
    cacheControl: runtime.cacheControl,
    cachePolicy: {
      fixedHeadBreakpointCount: getCachePolicy(runtime).fixedHeadBreakpointCount,
      cacheAnchorMode: getCachePolicy(runtime).cacheAnchorMode,
      cacheAnchorIntervalBlocks: getCachePolicy(runtime).cacheAnchorIntervalBlocks,
      cachePolicyProcessingOrder: getCachePolicy(runtime).cachePolicyProcessingOrder,
      autoConvertLastAnchorTo5m: getCachePolicy(runtime).autoConvertLastAnchorTo5m,
      ignoreLastAnchorsMode: getCachePolicy(runtime).ignoreLastAnchorsMode,
      ignoreLastAnchorCount: getCachePolicy(runtime).ignoreLastAnchorCount,
      anchorIgnoreEvaluation: runtime.anchorIgnoreEvaluation,
      anchorState: getCachePolicy(runtime).anchorState,
    },
    anthropicInboundEnabled: runtime.anthropicInboundEnabled,
    prefixLock: {
      enabled: runtime.prefixLockEnabled,
      active: runtime.prefixLockActive,
      hash: runtime.prefixLockHash,
      action: runtime.prefixLockLastAction,
    },
    upstreamExtraJson: runtime.upstreamExtraJson,
    upstreamExcludePaths: runtime.upstreamExcludePaths,
    upstreamHeaders: runtime.upstreamHeaders,
    upstreamExcludeHeaders: runtime.upstreamExcludeHeaders,
    usageAppearance: runtime.usageAppearance,
    usagePreviewSample: runtime.usagePreviewSample,
    requestCacheAppearance: runtime.requestCacheAppearance,
    maxRequestCaptures: runtime.maxRequestCaptures,
    persistence: runtime.persistence,
  }, null, 2);
}

function filteredRequests() {
  return state.requests.filter((item) => {
    if (state.filters.cache && item.cacheResult !== state.filters.cache) return false;
    return true;
  });
}

function tableCell(row, value, className, label) {
  const td = document.createElement('td');
  if (className) td.className = className;
  if (label) td.dataset.label = label;
  td.textContent = value === '' ? '' : text(value);
  row.appendChild(td);
  return td;
}

function renderRequests() {
  const rows = $('requestRows');
  const items = filteredRequests();
  const pageSize = Number(state.pageSize);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  state.page = Math.min(Math.max(1, state.page), totalPages);
  const start = (state.page - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);
  clearNode(rows);

  if (!pageItems.length) {
    const tr = document.createElement('tr');
    const td = tableCell(tr, '还没有匹配的诊断请求。先开启诊断，再从酒馆发一条消息。');
    td.colSpan = 8;
    rows.appendChild(tr);
  }

  for (const item of pageItems) {
    const tr = document.createElement('tr');

    const action = tableCell(tr, '', 'log-action-cell', '详情');
    const button = appendText(action, 'button', '详情', 'small primary');
    button.onclick = () => viewRequest(item.id);

    tableCell(tr, timeLabel(item.capturedAt), '', '时间');

    const model = tableCell(tr, '', '', '模型');
    appendText(model, 'strong', text(item.model, '未知模型'));
    model.appendChild(document.createElement('br'));
    appendText(model, 'small', upstreamModeLabel(item.upstreamMode));

    tableCell(tr, text(item.responseStatus), '', '状态');

    const injection = tableCell(tr, '', '', '缓存注入');
    appendText(injection, 'span', cacheInjectLabel(item), `badge ${item.injected > 0 || item.cacheControlCount > 0 ? 'success' : ''}`.trim());
    if (item.injected || item.overflowRemoved) {
      injection.appendChild(document.createElement('br'));
      appendText(injection, 'small', `注入 ${item.injected || 0} / 溢出 ${item.overflowRemoved || 0}`);
    }
    const summaryBreakpoints = selectedBreakpoints(item);
    if (summaryBreakpoints.length) {
      injection.appendChild(document.createElement('br'));
      appendText(injection, 'small', summaryBreakpoints.map(breakpointReasonsLabel).join(' / '));
    }

    const prefix = tableCell(tr, '', 'request-cache-cell', 'Prefix 锁定 / 缓存锚点');
    renderRequestCacheSummary(prefix, item);

    const stats = tableCell(tr, '', '', 'Usage');
    renderUsageLines(stats, {
      inputTokens: nonNegativeNumber(item.inputTokens),
      outputTokens: nonNegativeNumber(item.outputTokens),
      cacheWriteTokens: nonNegativeNumber(item.cacheWriteTokens),
      cacheReadTokens: nonNegativeNumber(item.cacheReadTokens),
      cacheHitRatePercent: nonNegativeNumber(item.cacheHitRatePercent),
    }, 'compact');

    const channel = tableCell(tr, '', '', '渠道');
    channel.append(document.createTextNode(item.channelName || channelName(state.runtime)));
    if (item.upstreamMode) {
      channel.appendChild(document.createElement('br'));
      appendText(channel, 'small', upstreamModeLabel(item.upstreamMode));
    }

    rows.appendChild(tr);
  }

  $('pageInfo').textContent = `${state.page} / ${totalPages} · 共 ${items.length}`;
  $('prevPage').disabled = state.page <= 1;
  $('nextPage').disabled = state.page >= totalPages;
}

function renderAll() {
  setUsageAppearanceVariables(state.runtime?.usageAppearance);
  setRequestCacheAppearanceVariables(state.runtime?.requestCacheAppearance);
  renderTopbar();
  renderDashboard();
  renderCaptureControls();
  renderChannels();
  renderCache();
  renderAdvanced();
  renderRequests();
}

async function loadState() {
  state.runtime = await api('/console/state');
}

async function loadRequests() {
  const data = await api('/console/requests');
  state.requests = data.requests || [];
}

async function refreshAll() {
  await loadState();
  await loadRequests();
  renderAll();
}

function selectedSummary() {
  const item = state.selected;
  const usage = item?.response?.usage || {};
  const mode = item?.upstream?.mode || item?.gateway?.upstreamMode || 'openai';
  return {
    id: item?.id,
    capturedAt: item?.capturedAt,
    upstream: item?.upstream?.url,
    status: item?.response?.status,
    cacheResult: item?.response?.cacheResult,
    provider: item?.response?.upstreamProvider,
    cache: item?.upstream?.cache,
    cachePolicy: getCaptureCachePolicy(item),
    prefixLock: item?.gateway?.prefixLock,
    upstreamExtraJson: item?.gateway?.upstreamExtraJsonApplied,
    usage,
    usageStatistics: usageStatistics(usage, mode),
    blockHashComparison: item?.upstream?.blockHashComparison,
  };
}

function renderMetaGrid(root, entries) {
  clearNode(root);
  for (const [label, value, className] of entries) {
    const cell = document.createElement('div');
    cell.className = 'meta-cell';
    appendText(cell, 'span', label, 'meta-label');
    appendText(cell, 'span', value, `meta-value ${className || ''}`.trim());
    root.appendChild(cell);
  }
}

function contentText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

function hasCacheControl(value) {
  return Boolean(value && typeof value === 'object' && value.cache_control);
}

function getCaptureCachePolicy(capture) {
  const nested = capture?.gateway?.cachePolicy
    || capture?.cachePolicy
    || capture?.upstream?.cache?.cachePolicy
    || capture?.upstream?.cache?.selection;
  if (nested) return nested;
  if (capture?.selectedBreakpoints || capture?.cachePolicyAction || capture?.cachePolicyReason || capture?.cacheContextHash) {
    return {
      selectedBreakpoints: capture.selectedBreakpoints || [],
      action: capture.cachePolicyAction || null,
      reason: capture.cachePolicyReason || null,
      contextHash: capture.cacheContextHash || null,
      candidateCount: capture.cacheCandidateCount ?? null,
    };
  }
  return {};
}

function cachePolicyCandidateCount(diagnostics) {
  if (diagnostics?.candidateCount !== undefined && diagnostics?.candidateCount !== null) return diagnostics.candidateCount;
  return Array.isArray(diagnostics?.candidates) ? diagnostics.candidates.length : null;
}

function breakpointReasonLabel(value) {
  const normalized = String(value || 'selected').trim().toLowerCase().replaceAll('_', '-');
  const labels = {
    'fixed-head': '固定头',
    fixed: '固定头',
    'active-anchor': '活动锚点',
    anchor: '活动锚点',
    'learned-anchor': '新学习锚点',
    'promoted-anchor': '晋升锚点',
    promoted: '晋升锚点',
    'retiring-anchor': '待淘汰锚点',
    retiring: '待淘汰锚点',
    'pending-eviction': '待淘汰锚点',
    tail: '最新尾点',
    'latest-tail': '最新尾点',
    existing: '调用方已有',
    'existing-cache-control': '调用方已有',
    'existing-control': '调用方已有',
    legacy: '兼容前点',
    'legacy-head': '兼容前点',
    selected: '已选缓存点',
  };
  return labels[normalized] || value || '已选缓存点';
}

function breakpointReasonClass(value) {
  const normalized = String(value || '').toLowerCase().replaceAll('_', '-');
  if (normalized.includes('fixed')) return 'fixed-head';
  if (normalized.includes('retir') || normalized.includes('evict')) return 'retiring-anchor';
  return '';
}

function breakpointReasonsLabel(entry) {
  const reasons = Array.isArray(entry?.reasons) && entry.reasons.length ? entry.reasons : [entry?.reason];
  return [...new Set(reasons.filter(Boolean).map(breakpointReasonLabel))].join(' + ') || '已选缓存点';
}

function selectedBreakpoints(capture, segments = []) {
  const diagnostics = getCaptureCachePolicy(capture);
  const cache = capture?.upstream?.cache || {};
  const normalizeEntries = (raw) => Array.isArray(raw) ? raw.map((entry) => {
    if (typeof entry === 'string') return { path: entry, reason: null, reasons: [], prefixHash: null };
    return {
      path: entry?.path || entry?.cacheControlPath || entry?.targetPath || '',
      reason: entry?.reason || entry?.selectionReason || entry?.kind || null,
      reasons: Array.isArray(entry?.reasons) ? entry.reasons : [],
      prefixHash: entry?.prefixHash || entry?.hash || null,
      blockHash: entry?.blockHash || null,
      previousHash: entry?.previousHash || null,
      changed: Boolean(entry?.changed),
      ttlOverride: entry?.ttlOverride || null,
    };
  }).filter((entry) => entry.path) : [];
  const diagnosticSelected = Array.isArray(diagnostics.selectedBreakpoints)
    ? diagnostics.selectedBreakpoints
    : Array.isArray(diagnostics.selected)
      ? diagnostics.selected
      : Array.isArray(diagnostics.candidates)
        ? diagnostics.candidates.filter((candidate) => candidate?.selected)
        : [];
  const selected = normalizeEntries(diagnosticSelected.length ? diagnosticSelected : cache.selectedBreakpoints || []);
  const actual = normalizeEntries(cache.breakpoints || cache.cacheControlPaths || []);
  let entries = selected;

  if (selected.length && selected.length === actual.length) {
    entries = selected.map((entry, index) => ({ ...entry, path: actual[index].path || entry.path }));
  } else {
    for (const entry of actual) {
      if (!entries.some((selectedEntry) => pathMatches(entry.path.replace(/\.cache_control$/, ''), selectedEntry.path))) entries.push(entry);
    }
  }

  for (const segment of segments) {
    if (segment.cache && !entries.some((entry) => pathMatches(segment.path, entry.path))) {
      entries.push({ path: `${segment.path}.cache_control`, reason: null, reasons: [], prefixHash: null });
    }
  }

  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.path}\u0000${entry.reason || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function breakpointPathsMatch(left, right) {
  const normalize = (value) => String(value || '').replace(/\.cache_control$/, '');
  return Boolean(left && right) && normalize(left) === normalize(right);
}

function candidateBreakpoints(capture) {
  const candidates = getCaptureCachePolicy(capture)?.candidates;
  if (!Array.isArray(candidates)) return [];
  return candidates
    .map((entry, index) => ({
      path: entry?.path || entry?.cacheControlPath || entry?.targetPath || '',
      order: Number.isFinite(Number(entry?.order)) ? Number(entry.order) : index,
      selected: entry?.selected === true ? true : entry?.selected === false ? false : null,
      ignored: Boolean(entry?.ignored),
      reason: entry?.reason || null,
      reasons: Array.isArray(entry?.reasons) ? entry.reasons : [],
    }))
    .filter((entry) => entry.path)
    .sort((left, right) => left.order - right.order);
}

function unusedCandidateBreakpoints(capture, selected = selectedBreakpoints(capture)) {
  return candidateBreakpoints(capture).filter((candidate) => (
    candidate.selected === false
    && !selected.some((breakpoint) => breakpointPathsMatch(candidate.path, breakpoint.path))
  ));
}

function getBlockHashEntries(capture) {
  const raw = capture?.upstream?.blockHashes
    || capture?.upstream?.cache?.blockHashes
    || capture?.upstream?.blockHashComparison?.entries
    || capture?.gateway?.cachePolicy?.blockHashes
    || [];
  return Array.isArray(raw) ? raw.filter((entry) => entry?.path) : [];
}

function blockHashByPath(capture) {
  return new Map(getBlockHashEntries(capture).map((entry) => [entry.path, entry]));
}

function getOrderedBodySegments(body, mode) {
  const segments = [];
  const add = (role, value, path, label, cacheOwner = value, serializedText, metadata = {}) => {
    const cacheControl = hasCacheControl(value)
      ? value.cache_control
      : hasCacheControl(cacheOwner)
        ? cacheOwner.cache_control
        : null;
    segments.push({
      ...metadata,
      role,
      value,
      path,
      label,
      cache: Boolean(cacheControl),
      cacheTtl: cacheControl
        ? (Object.prototype.hasOwnProperty.call(cacheControl, 'ttl') ? cacheControl.ttl : 'auto')
        : null,
      text: serializedText === undefined ? contentText(value) : serializedText,
    });
  };

  const serializeDefinition = (value) => {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? contentText(value) : serialized;
  };

  const addDefinition = (value, path, label) => {
    if (value === null || value === undefined) return;
    add('definition', value, path, label, value, serializeDefinition(value));
  };

  const addDefinitionCollection = (value, path, label) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        const name = entry?.function?.name || entry?.name;
        addDefinition(entry, `${path}[${index}]`, `${path}[${index}]${name ? ` · ${name}` : ` · ${label} ${index + 1}`}`);
      });
      return;
    }
    addDefinition(value, path, `${path} · ${label}`);
  };

  if (!body || typeof body !== 'object') return segments;

  // Tool and function definitions are part of the model input and precede the
  // conversational prompt in both cache semantics and the diagnostic view.
  addDefinitionCollection(body.tools, 'tools', '工具定义');
  addDefinitionCollection(body.functions, 'functions', '旧版函数定义');
  addDefinition(body.tool_choice, 'tool_choice', 'tool_choice · 工具选择策略');
  addDefinition(body.function_call, 'function_call', 'function_call · 旧版函数调用策略');

  if (mode === 'anthropic') {
    if (Array.isArray(body.system)) {
      body.system.forEach((block, index) => add('system', block, `system[${index}]`, `block ${index}`));
    } else if (body.system) {
      add('system', body.system, 'system', 'system');
    }
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  messages.forEach((message, messageIndex) => {
    const role = message?.role || 'message';
    const messagePath = `messages[${messageIndex}]`;
    if (Array.isArray(message?.content)) {
      if (!message.content.length) {
        add(role, '', messagePath, messagePath, message, '', { messageIndex, messagePath, contentBlockIndex: null });
      }
      message.content.forEach((block, blockIndex) => add(
        role,
        block,
        `${messagePath}.content[${blockIndex}]`,
        `${messagePath} · block ${blockIndex}`,
        block,
        undefined,
        { messageIndex, messagePath, contentBlockIndex: blockIndex },
      ));
    } else {
      add(role, message?.content ?? message, messagePath, messagePath, message, undefined, {
        messageIndex,
        messagePath,
        contentBlockIndex: null,
      });
    }
  });

  // Structured-output schemas also consume prompt tokens. Keep an explicit
  // allow-list so transport, sampling and generation controls remain excluded.
  const responseFormatLabel = body.response_format?.json_schema
    ? 'response_format · JSON Schema'
    : 'response_format · 响应格式';
  addDefinition(body.response_format, 'response_format', responseFormatLabel);
  addDefinition(body.json_schema, 'json_schema', 'json_schema · JSON Schema');
  addDefinition(body.response_schema, 'response_schema', 'response_schema · 响应 Schema');
  addDefinition(body.output_schema, 'output_schema', 'output_schema · 输出 Schema');
  addDefinition(body.output_config?.format, 'output_config.format', 'output_config.format · 输出格式');

  return segments;
}

function groupBodySegmentsForDisplay(segments) {
  const groups = [];

  for (const [segmentIndex, segment] of segments.entries()) {
    const isMessage = Number.isInteger(segment?.messageIndex) && segment.messageIndex >= 0;
    const previous = groups[groups.length - 1];

    if (isMessage && previous?.messageIndex === segment.messageIndex) {
      previous.segments.push(segment);
      previous.endIndex = segmentIndex;
      previous.label = `${previous.path} · ${previous.segments.length} blocks`;
      continue;
    }

    groups.push({
      role: segment.role,
      path: isMessage ? segment.messagePath : segment.path,
      label: isMessage && Number.isInteger(segment.contentBlockIndex)
        ? `${segment.messagePath} · 1 block`
        : segment.label,
      messageIndex: isMessage ? segment.messageIndex : null,
      startIndex: segmentIndex,
      endIndex: segmentIndex,
      segments: [segment],
    });
  }

  return groups;
}

function displayGroupCharacterCount(group) {
  return (group?.segments || []).reduce((sum, segment) => sum + countCharacters(segment?.text), 0);
}

function pathMatches(segmentPath, cachePath) {
  if (!cachePath) return false;
  return cachePath === segmentPath || cachePath === `${segmentPath}.cache_control` || cachePath.startsWith(`${segmentPath}.`);
}

function countCharacters(value) {
  return Array.from(contentText(value)).length;
}

function nonNegativeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function promptTokensFromUsage(usage, upstreamMode = 'openai') {
  const inputTokens = nonNegativeNumber(usage?.inputTokens);
  if (inputTokens === null) return null;

  // OpenAI's prompt_tokens/inputTokens is already the complete input count.
  // Anthropic reports uncached, cache-read and cache-created input separately.
  if (upstreamMode !== 'anthropic') return inputTokens;

  const rawCacheRead = usage?.anthropicCacheReadInputTokens;
  const cacheReadTokens = rawCacheRead === null || rawCacheRead === undefined
    ? 0
    : nonNegativeNumber(rawCacheRead);
  const rawCacheCreation = usage?.anthropicCacheCreationInputTokens;
  const cacheCreationTokens = rawCacheCreation === null || rawCacheCreation === undefined
    ? 0
    : nonNegativeNumber(rawCacheCreation);
  if (cacheReadTokens === null || cacheCreationTokens === null) return null;

  return inputTokens + cacheReadTokens + cacheCreationTokens;
}

function usageStatistics(usage = {}, upstreamMode = 'openai') {
  const inputTokens = promptTokensFromUsage(usage, upstreamMode);
  const outputTokens = nonNegativeNumber(usage?.outputTokens);
  const cacheReadTokens = nonNegativeNumber(
    upstreamMode === 'anthropic'
      ? usage?.anthropicCacheReadInputTokens ?? usage?.cacheReadTokens
      : usage?.cachedTokens ?? usage?.cacheReadTokens,
  );
  const cacheWriteTokens = nonNegativeNumber(
    upstreamMode === 'anthropic'
      ? usage?.anthropicCacheCreationInputTokens ?? usage?.cacheWriteTokens
      : usage?.cacheWriteTokens,
  );
  const denominator = inputTokens !== null
    ? inputTokens
    : (cacheReadTokens || 0) + (cacheWriteTokens || 0);
  const cacheHitRate = cacheReadTokens !== null && denominator > 0
    ? cacheReadTokens / denominator
    : null;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheHitRate,
    cacheHitRatePercent: cacheHitRate === null ? null : Number((cacheHitRate * 100).toFixed(2)),
  };
}

function usageRateLabel(value) {
  return value === null || value === undefined ? '暂不可用' : `${Number(value.toFixed(2))}%`;
}

function usageNumberLabel(value) {
  return value === null || value === undefined ? '暂不可用' : String(value);
}

function usageRateBand(value) {
  const rate = nonNegativeNumber(value);
  if (rate === null) return null;
  if (rate <= 50) return 'rate-le50';
  if (rate <= 70) return 'rate-le70';
  if (rate <= 90) return 'rate-le90';
  return 'rate-le100';
}

function appendUsageMetric(root, label, value, kind) {
  const metric = document.createElement('div');
  metric.className = `usage-metric usage-metric-${kind}`;
  appendText(metric, 'span', label, 'usage-label');
  const available = value !== null && value !== undefined;
  appendText(
    metric,
    'strong',
    usageNumberLabel(value),
    `usage-value usage-value-${kind} ${available ? '' : 'unavailable'}`.trim(),
  );
  root.appendChild(metric);
  return metric;
}

function appendUsageDivider(root) {
  const divider = document.createElement('span');
  divider.className = 'usage-grid-divider';
  divider.setAttribute?.('aria-hidden', 'true');
  root.appendChild(divider);
}

function renderUsageLines(root, stats, variant = '') {
  clearNode(root);
  root.className = `usage-lines ${variant}`.trim();

  const grid = document.createElement('div');
  grid.className = 'usage-grid';
  appendUsageMetric(grid, '输入', stats.inputTokens, 'input');
  appendUsageDivider(grid);
  appendUsageMetric(grid, '输出', stats.outputTokens, 'output');
  appendUsageMetric(grid, '缓存命中', stats.cacheReadTokens, 'cache-read');
  appendUsageDivider(grid);
  appendUsageMetric(grid, '创建', stats.cacheWriteTokens, 'cache-write');

  const rate = document.createElement('div');
  rate.className = 'usage-rate-row';
  appendText(rate, 'span', '缓存命中率', 'usage-label');
  const band = usageRateBand(stats.cacheHitRatePercent);
  appendText(
    rate,
    'strong',
    usageRateLabel(stats.cacheHitRatePercent),
    `usage-value usage-rate-value ${band || 'unavailable'}`,
  );
  grid.appendChild(rate);
  root.appendChild(grid);
  return stats;
}

function getPromptTokenEstimate(segments, usage, upstreamMode = 'openai') {
  const characterCounts = segments.map((segment) => countCharacters(segment?.text ?? segment?.value ?? segment));
  const totalCharacters = characterCounts.reduce((sum, count) => sum + count, 0);
  const promptTokens = promptTokensFromUsage(usage, upstreamMode);
  const tokensPerCharacter = totalCharacters > 0 && promptTokens !== null
    ? promptTokens / totalCharacters
    : null;

  return { characterCounts, totalCharacters, promptTokens, tokensPerCharacter };
}

function estimatedTokens(characterCount, tokensPerCharacter) {
  return tokensPerCharacter === null ? null : Math.round(characterCount * tokensPerCharacter);
}

function promptEstimateLabel(characterCount, tokenCount) {
  return tokenCount === null
    ? `${characterCount}字符 | token 暂不可估`
    : `${characterCount}字符 | 约${tokenCount}token`;
}

function inputPromptTokenLabel(tokenCount) {
  return tokenCount === null ? '暂不可用' : `${tokenCount} token`;
}

function tokenMultiplierLabel(tokensPerCharacter) {
  if (tokensPerCharacter === null) return '暂不可估（缺少有效 usage 或字符）';
  return `${Number(tokensPerCharacter.toFixed(4))} token/字符`;
}

function breakpointsForSegment(segment, breakpoints, includeActualFallback = true) {
  const matches = breakpoints.filter((breakpoint) => pathMatches(segment.path, breakpoint.path));
  if (includeActualFallback && !matches.length && segment.cache) {
    matches.push({ path: `${segment.path}.cache_control`, reason: null, reasons: [], prefixHash: null });
  }
  return matches;
}

function blockHashInfoForSegment(segment, hashByPath) {
  return hashByPath?.get(segment.path)
    || hashByPath?.get(`${segment.path}.content`)
    || null;
}

function renderHeaderBlockHashes(root, segments, hashByPath) {
  const entries = segments
    .map((segment, index) => ({
      segment,
      index,
      info: blockHashInfoForSegment(segment, hashByPath),
    }))
    .filter((entry) => entry.info?.hash);
  if (!entries.length) return;

  const hashes = document.createElement('span');
  hashes.className = 'msg-head-hashes';
  const multiple = entries.length > 1;

  for (const { segment, index, info } of entries) {
    const blockIndex = Number.isInteger(segment.contentBlockIndex) ? segment.contentBlockIndex : index;
    const label = multiple ? `b${blockIndex}` : 'Hash';
    const hash = appendText(
      hashes,
      'span',
      `${label} ${compactHash(info.hash)}`,
      `msg-head-hash ${info.changed ? 'changed' : ''}`.trim(),
    );
    hash.dataset.hash = String(info.hash);
    hash.dataset.hashChanged = info.changed ? 'true' : 'false';
    hash.title = info.previousHash
      ? `当前 SHA-256: ${info.hash}\n上次 SHA-256: ${info.previousHash}`
      : `当前 SHA-256: ${info.hash}${info.compared ? '\n上次请求中不存在此块' : '\n首次请求基线'}`;
  }

  root.appendChild(hashes);
}

function renderMessageCard(root, group, index, isPrefix, tokensPerCharacter = null, options = {}) {
  const segments = group.segments || [group];
  const segmentBreakpoints = segments.map((segment) => breakpointsForSegment(segment, options.breakpoints || []));
  const segmentUnusedBreakpoints = segments.map((segment) => breakpointsForSegment(segment, options.unusedBreakpoints || [], false));
  const hasCacheBreakpoints = segmentBreakpoints.some((matches) => matches.length > 0)
    || segmentUnusedBreakpoints.some((matches) => matches.length > 0);
  const card = document.createElement('div');
  card.className = `msg-card ${isPrefix ? 'is-prefix' : ''} ${hasCacheBreakpoints ? 'has-cache-breakpoints' : ''}`.trim();
  const head = document.createElement('div');
  head.className = 'msg-card-head';
  const left = document.createElement('span');
  left.className = 'msg-left';
  const role = document.createElement('span');
  role.className = 'msg-role';
  const dot = document.createElement('span');
  dot.className = `role-dot ${group.role}`;
  role.appendChild(dot);
  role.append(document.createTextNode(String(group.role).toUpperCase()));
  left.appendChild(role);
  appendText(left, 'span', `#${index} · ${group.label || group.path}`, 'msg-index');
  const right = document.createElement('span');
  right.className = 'msg-right';
  renderHeaderBlockHashes(right, segments, options.blockHashByPath);
  const characterCount = displayGroupCharacterCount(group);
  appendText(right, 'span', promptEstimateLabel(characterCount, estimatedTokens(characterCount, tokensPerCharacter)), 'msg-meta');
  appendText(right, 'span', '▾', 'msg-caret');
  head.append(left, right);
  head.onclick = () => card.classList.toggle('collapsed');
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.onclick = (event) => event.stopPropagation();
  const showBlockLabels = segments.some((segment) => Number.isInteger(segment.contentBlockIndex));

  for (const [segmentIndex, segment] of segments.entries()) {
    const block = document.createElement('div');
    block.className = 'msg-content-block';
    block.dataset.path = segment.path;
    if (showBlockLabels) appendText(block, 'div', `block ${segment.contentBlockIndex} · ${segment.path}`, 'msg-index');
    appendText(block, 'div', segment.text || '（空内容）', 'msg-content-text');
    body.appendChild(block);

    for (const breakpoint of segmentBreakpoints[segmentIndex]) {
      const ordinal = Math.max(1, (options.breakpoints || []).indexOf(breakpoint) + 1);
      renderCacheDivider(
        body,
        options.cache || {},
        breakpoint,
        ordinal,
        Math.max(1, (options.breakpoints || []).length),
        segment.cacheTtl ?? options.cacheTtl,
      );
    }
    for (const breakpoint of segmentUnusedBreakpoints[segmentIndex]) {
      renderUnusedCacheDivider(body, breakpoint);
    }
  }

  card.append(head, body);
  root.appendChild(card);
}

function renderCacheDivider(root, cache, breakpoint = {}, ordinal = 1, total = 1, cacheTtl = null) {
  const divider = document.createElement('div');
  divider.className = `cache-divider ${breakpointReasonClass(breakpoint.reason)}`.trim();
  const icon = document.createElement('div');
  icon.className = 'cache-icon';
  icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4.5" y="10.5" width="15" height="10" rx="2.4" fill="currentColor"></rect><path d="M7.5 10.5V7.5C7.5 5.01 9.51 3 12 3C14.49 3 16.5 5.01 16.5 7.5V10.5" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"></path><circle cx="12" cy="15" r="1.6" fill="#fff"></circle><rect x="11.2" y="15.4" width="1.6" height="3" rx="0.8" fill="#fff"></rect></svg>';
  const textWrap = document.createElement('div');
  textWrap.className = 'cache-text';
  appendText(textWrap, 'span', `缓存点 ${ordinal}/${total} · ${breakpointReasonsLabel(breakpoint)} · cache_control(ephemeral, ${ttlLabel(cacheTtl)})`, 'cache-title');
  const hash = breakpoint.prefixHash || (ordinal === 1 ? cache?.prefixHash : null);
  appendText(textWrap, 'span', `${breakpoint.path || '路径未记录'} · Prefix ${compactHash(hash)}`, 'cache-sub');
  divider.append(icon, textWrap);
  root.appendChild(divider);
}

function renderUnusedCacheDivider(root) {
  const divider = document.createElement('div');
  divider.className = 'cache-divider unused-cache-divider';
  appendText(divider, 'span', '未使用缓存点', 'unused-cache-title');
  root.appendChild(divider);
}

function renderBreakpointDiagnostics(root, capture) {
  clearNode(root);
  const body = capture?.upstream?.body;
  const mode = capture?.upstream?.mode || capture?.gateway?.upstreamMode;
  const segments = getOrderedBodySegments(body, mode);
  const breakpoints = selectedBreakpoints(capture, segments);
  const diagnostics = getCaptureCachePolicy(capture);

  if (!breakpoints.length) {
    appendText(root, 'span', '此诊断记录没有最终 cache_control，或旧版记录未提供断点路径。', 'breakpoint-chip empty');
  } else {
    breakpoints.forEach((breakpoint, index) => {
      const chip = document.createElement('span');
      chip.className = 'breakpoint-chip';
      appendText(chip, 'strong', `#${index + 1} ${breakpointReasonsLabel(breakpoint)}`);
      appendText(chip, 'code', breakpoint.path);
      root.appendChild(chip);
    });
  }

  const metadata = [];
  const candidateCount = cachePolicyCandidateCount(diagnostics);
  if (candidateCount !== null) metadata.push(`候选 ${candidateCount}`);
  if (diagnostics.contextHash) metadata.push(`上下文 ${compactHash(diagnostics.contextHash)}`);
  if (diagnostics.action) metadata.push(`动作 ${diagnostics.action}`);
  if (diagnostics.reason) metadata.push(`原因 ${diagnostics.reason}`);
  const blockHashes = getBlockHashEntries(capture);
  const changedBlockCount = capture?.upstream?.cache?.changedBlockCount
    ?? capture?.upstream?.blockHashComparison?.changedBlockCount
    ?? blockHashes.filter((entry) => entry.changed).length;
  if (blockHashes.length) metadata.push(`块哈希 ${blockHashes.length}`);
  if (changedBlockCount > 0) metadata.push(`变更 ${changedBlockCount}`);
  if (metadata.length) appendText(root, 'span', metadata.join(' · '), 'breakpoint-chip');
}

function renderRequestBodyStream(root, capture, prefixOnly = false) {
  clearNode(root);
  const body = capture?.upstream?.body;
  const mode = capture?.upstream?.mode || capture?.gateway?.upstreamMode;
  const cache = capture?.upstream?.cache || {};
  const segments = getOrderedBodySegments(body, mode);
  const promptEstimate = getPromptTokenEstimate(segments, capture?.response?.usage, mode);
  const breakpoints = selectedBreakpoints(capture, segments);
  const unusedBreakpoints = prefixOnly ? [] : unusedCandidateBreakpoints(capture, breakpoints);
  const firstCachePath = cache.firstCacheControlPath;
  let cacheIndex = segments.findIndex((segment) => segment.cache || pathMatches(segment.path, firstCachePath) || breakpoints.some((breakpoint) => pathMatches(segment.path, breakpoint.path)));
  if (cacheIndex < 0 && prefixOnly) cacheIndex = segments.length - 1;
  const visible = prefixOnly && cacheIndex >= 0 ? segments.slice(0, cacheIndex + 1) : segments;
  const displayGroups = groupBodySegmentsForDisplay(visible);

  if (!displayGroups.length) {
    appendText(root, 'div', '没有可视化请求体。可在“原始 JSON”中查看完整诊断。', 'empty-hint');
    return;
  }

  displayGroups.forEach((group, index) => {
    const isPrefix = cacheIndex >= 0 && group.endIndex <= cacheIndex;
    renderMessageCard(root, group, index, isPrefix, promptEstimate.tokensPerCharacter, {
      breakpoints,
      unusedBreakpoints,
      cache,
      cacheTtl: capture?.gateway?.cacheTtl,
      blockHashByPath: blockHashByPath(capture),
    });
  });
}

function renderUsageStats(root, usage, upstreamMode = 'openai') {
  const stats = usageStatistics(usage, upstreamMode);
  const hasAny = [
    stats.inputTokens,
    stats.outputTokens,
    stats.cacheReadTokens,
    stats.cacheWriteTokens,
  ].some((value) => value !== null && value !== undefined && value !== '');
  if (!hasAny) {
    clearNode(root);
    root.className = 'usage-stats empty';
    appendText(root, 'span', '上游没有返回可用的 Usage 数据。', 'usage-empty');
    return stats;
  }

  renderUsageLines(root, stats, 'detail usage-stats');
  return stats;
}

function renderDetail() {
  const item = state.selected;
  if (!item) return;
  const usage = item.response?.usage || {};
  const promptSegments = getOrderedBodySegments(
    item.upstream?.body || item.gateway?.transformedBody,
    item.upstream?.mode || item.gateway?.upstreamMode,
  );
  const upstreamMode = item.upstream?.mode || item.gateway?.upstreamMode || 'openai';
  const promptEstimate = getPromptTokenEstimate(
    promptSegments,
    usage,
    upstreamMode,
  );
  const usageStats = usageStatistics(usage, upstreamMode);
  $('drawerTitle').textContent = item.upstream?.body?.model || item.gateway?.transformedBody?.model || item.id;
  $('drawerEyebrow').textContent = item.gateway?.channelName || channelName(state.runtime);
  $('detailId').textContent = `ID: ${item.id}`;
  const detailPolicy = getCaptureCachePolicy(item);
  const detailAnchorMode = requestCacheAnchorMode(item, detailPolicy);
  const detailPrefixSummary = {
    prefixLockEnabled: item.gateway?.prefixLock?.enabled ?? false,
    prefixLockAction: item.gateway?.prefixLock?.action,
    prefixLockReason: item.gateway?.prefixLock?.reason,
  };
  const detailMeta = [
    ['响应状态', item.response?.status],
    ['缓存转译', item.gateway?.cacheTranslationEnabled ? '开启' : '关闭'],
    ['系统身份消息处理', systemMessageHandlingLabel(item.gateway)],
    ['自动断点', autoBreakpointCaptureLabel(item)],
    ['注入断点', item.gateway?.conversion?.injected ?? 0, (item.gateway?.conversion?.injected ?? 0) > 0 ? 'success' : ''],
    ['转换标记', item.gateway?.conversion?.removed ?? 0],
    ['缓存点数量', item.upstream?.cache?.cacheControlCount ?? 0],
    ['候选断点', cachePolicyCandidateCount(detailPolicy) ?? '未记录'],
  ];
  if (detailPrefixSummary.prefixLockEnabled === true) {
    detailMeta.push(['Prefix 锁定', prefixLockStatusLabel(detailPrefixSummary), 'request-cache-prefix-detail']);
  }
  if (['single', 'rolling'].includes(detailAnchorMode)) {
    detailMeta.push(
      ['缓存锚点', cacheAnchorRequestLabel({
        cacheAnchorMode: detailAnchorMode,
        cacheTranslationEnabled: item.gateway?.cacheTranslationEnabled,
      }, detailPolicy), 'request-cache-anchor-detail'],
      ['锚点状态', anchorActionLabel(detailPolicy.action), 'request-cache-anchor-detail'],
    );
  }
  detailMeta.push(
    ['Usage', hasUsage(usage) ? '已返回' : '未返回'],
    ['输入 token', usageStats.inputTokens === null ? '暂不可用' : usageStats.inputTokens],
    ['输出 token', usageStats.outputTokens === null ? '暂不可用' : usageStats.outputTokens],
    ['缓存命中率', usageRateLabel(usageStats.cacheHitRatePercent)],
    ['缓存创建 / 缓存命中', `${usageNumberLabel(usageStats.cacheWriteTokens)} / ${usageNumberLabel(usageStats.cacheReadTokens)}`],
    ['Token 倍率', tokenMultiplierLabel(promptEstimate.tokensPerCharacter)],
    ['请求渠道', item.gateway?.channelName || channelName(state.runtime)],
  );
  renderMetaGrid($('detailMetaGrid'), detailMeta);

  const tabPayloads = {
    usage: hasUsage(usage) ? usage : { message: '暂无 usage。' },
    headers: {
      inbound: item.inbound?.headersSummary,
      upstream: item.upstream?.headersSummary,
      response: item.response?.headersSummary,
    },
    upstreamBody: item.upstream?.body || item.gateway?.transformedBody || {},
    raw: item,
    summary: selectedSummary(),
  };

  const showBody = state.selectedTab === 'body';
  const showUsage = state.selectedTab === 'usage';
  $('detailBodyTab').hidden = !showBody;
  $('detailUsageStats').hidden = !showUsage;
  $('detailPre').hidden = showBody;
  if (showBody) {
    renderBreakpointDiagnostics($('detailBreakpointSummary'), item);
    renderRequestBodyStream($('detailBodyStream'), item);
  } else {
    if (showUsage) renderUsageStats($('detailUsageStats'), usage, upstreamMode);
    $('detailPre').textContent = showUsage
      ? formatUsage(usage)
      : JSON.stringify(tabPayloads[state.selectedTab] ?? tabPayloads.summary, null, 2);
  }
  $('download').disabled = false;
  setStatus(`已选择：${item.id}`);
}

async function viewRequest(id) {
  state.selected = await api(`/console/requests/${encodeURIComponent(id)}`);
  state.selectedTab = 'body';
  const detailScroll = document.querySelector('.detail-scroll');
  if (detailScroll) detailScroll.scrollTop = 0;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.tab === 'body');
  }
  renderDetail();
  setDrawerOpen('detailDrawer', true);
}

function closeDrawer() {
  setDrawerOpen('detailDrawer', false);
}

function closePrefixModal() {
  setDrawerOpen('prefixModal', false);
}

function closeGuide() {
  setDrawerOpen('guideModal', false);
}

function openAnthropicOptimizationWhitelist() {
  const input = $('anthropicOptimizationModelWhitelistInput');
  if (!input) return;
  const models = normalizeAnthropicOptimizationModelWhitelist(
    state.runtime?.anthropicOptimizationModelWhitelist ?? DEFAULT_ANTHROPIC_OPTIMIZATION_MODEL_WHITELIST,
  );
  input.value = models.join('\n');
  updateAnthropicOptimizationWhitelistDraftCount();
  setDrawerOpen('anthropicOptimizationWhitelistModal', true);
  input.focus();
}

function closeAnthropicOptimizationWhitelist() {
  setDrawerOpen('anthropicOptimizationWhitelistModal', false);
}

async function saveAnthropicOptimizationWhitelist() {
  const input = $('anthropicOptimizationModelWhitelistInput');
  const models = normalizeAnthropicOptimizationModelWhitelist(input?.value || '');
  await postJson('/console/anthropic-optimization-whitelist', { models });
  await refreshAll();
  closeAnthropicOptimizationWhitelist();
  setStatus(`忽略Anthropic优化的模型白名单已保存（${models.length} 个项目）`);
}

async function applyTtl(value) {
  await postJson('/console/cache-ttl', { ttl: value });
  await refreshAll();
  setStatus(`TTL 已切换为 ${ttlLabel(value)}`);
}

function scheduleCachePolicyAutoApply(delay = 650) {
  if (cachePolicyAutoApplyTimer) clearTimeout(cachePolicyAutoApplyTimer);
  const sequence = ++cachePolicyAutoApplySequence;
  const badge = $('cachePolicyAutoSaveState');
  if (badge) {
    badge.textContent = '等待自动应用';
    badge.className = 'badge warning';
  }
  cachePolicyAutoApplyTimer = setTimeout(async () => {
    cachePolicyAutoApplyTimer = null;
    if (badge) {
      badge.textContent = '正在自动应用';
      badge.className = 'badge warning';
    }
    try {
      const applied = await applyCachePolicy();
      if (sequence !== cachePolicyAutoApplySequence) return;
      if (badge) {
        badge.textContent = applied === false ? '已取消，保持原策略' : '已自动应用';
        badge.className = `badge ${applied === false ? '' : 'success'}`.trim();
      }
    } catch (error) {
      if (sequence !== cachePolicyAutoApplySequence) return;
      await refreshAll().catch(() => {});
      if (badge) {
        badge.textContent = '自动应用失败';
        badge.className = 'badge danger';
      }
      setStatus(error.message);
    }
  }, delay);
}

async function applyCachePolicy() {
  const rawHead = Number($('fixedHeadBreakpointCount').value);
  const rawInterval = Number($('cacheAnchorIntervalBlocks').value);
  const mode = $('cacheAnchorMode').value;
  const ignoreMode = $('ignoreLastAnchorsMode').value;
  const rawIgnored = Number($('ignoreLastAnchorCount').value);
  const autoLastAnchor5m = Boolean($('autoConvertLastAnchorTo5m').checked);
  const nextProcessingOrder = normalizeProcessingOrder(state.processingOrderDraft);
  if (!Number.isInteger(rawHead) || rawHead < 0 || rawHead > CACHE_BREAKPOINT_LIMIT) throw new Error('固定头缓存点必须是 0–4 的整数。');
  if (!['off', 'single', 'rolling'].includes(mode)) throw new Error('缓存锚点模式无效。');
  if (!Number.isInteger(rawInterval) || rawInterval < 1 || rawInterval > 1000) throw new Error('滚动间隔必须是 1–1000 的整数。');
  if (!['fixed', 'evaluation'].includes(ignoreMode)) throw new Error('末尾锚点忽略模式无效。');
  if (!Number.isInteger(rawIgnored) || rawIgnored < 0) throw new Error('忽略末尾锚点数量必须是非负整数。');

  const button = $('cachePolicyApply');
  const previous = getCachePolicy();
  const orderChanged = JSON.stringify(nextProcessingOrder) !== JSON.stringify(previous.cachePolicyProcessingOrder);
  const changed = rawHead !== previous.fixedHeadBreakpointCount
    || mode !== previous.cacheAnchorMode
    || rawInterval !== previous.cacheAnchorIntervalBlocks
    || orderChanged
    || autoLastAnchor5m !== previous.autoConvertLastAnchorTo5m
    || ignoreMode !== previous.ignoreLastAnchorsMode
    || rawIgnored !== previous.ignoreLastAnchorCount;
  const requiresOutOfRangeConfirmation = ignoreMode === 'fixed'
    && rawIgnored > 5
    && rawIgnored !== previous.ignoreLastAnchorCount;
  if (requiresOutOfRangeConfirmation
    && !window.confirm(`x=${rawIgnored} 超出建议范围 0–5，确认仍然填入吗？`)) {
    await refreshAll();
    return false;
  }
  if (orderChanged
    && !window.confirm('处理顺序变化会立即清空缓存锚点与 Prefix 锁定学习数据，并可能产生高风险组合。确认应用吗？')) {
    await refreshAll();
    return false;
  }
  if (button) button.disabled = true;
  try {
    await postJson('/console/cache-policy', {
      fixedHeadBreakpointCount: rawHead,
      cacheAnchorMode: mode,
      cacheAnchorIntervalBlocks: rawInterval,
      cachePolicyProcessingOrder: nextProcessingOrder,
      autoConvertLastAnchorTo5m: autoLastAnchor5m,
      ignoreLastAnchorsMode: ignoreMode,
      ignoreLastAnchorCount: rawIgnored,
      confirmOutOfRange: requiresOutOfRangeConfirmation,
    });
    await refreshAll();
    const suffix = mode === 'off'
      ? ''
      : changed
        ? '；Prefix Lock 已关闭，下一次成功请求将学习锚点'
        : '；锚点状态保持不变';
    const ignoreLabel = ignoreMode === 'evaluation' ? '评估模式' : `忽略末尾 ${rawIgnored}`;
    setStatus(`断点保留策略已自动应用：固定头 ${rawHead}，${cacheAnchorModeLabel(mode)}，${ignoreLabel}${orderChanged ? '；处理顺序已更新并清空学习数据' : suffix}`);
    return true;
  } finally {
    if (button) button.disabled = false;
  }
}

async function clearCacheAnchors() {
  await api('/console/cache-anchors/clear', { method: 'POST' });
  await refreshAll();
  setStatus('缓存锚点已清空，下一次成功请求会重新学习');
}

async function addCustomChannel() {
  customChannelSeq += 1;
  const draft = {
    id: `draft-channel-${customChannelSeq}`,
    name: `自定义渠道 ${customChannelSeq}`,
    kind: 'custom',
    baseUrl: '',
    upstreamMode: 'anthropic',
    upstreamExtraJson: {},
    upstreamExcludePaths: [],
    upstreamHeaders: {},
    upstreamExcludeHeaders: [],
    isDraft: true,
  };
  state.channelDrafts.push(draft);
  renderChannels();
  setStatus('请填写上游 URL 后保存配置。');
  const card = document.querySelector(`[data-channel="${draft.id}"]`);
  const urlInput = card?.querySelector('[data-channel-url]');
  if (urlInput) urlInput.focus();
}

async function openPrefixModal(event) {
  if (event) event.preventDefault();
  const runtime = state.runtime;
  const hash = runtime?.prefixLockHash;
  $('prefixModalTitle').textContent = hash || '未锁定';
  $('prefixModalHint').textContent = hash ? `Prefix ID: ${hash}` : 'Prefix 未锁定';
  renderMetaGrid($('prefixMetaGrid'), [
    ['Prefix Hash', hash || '-'],
    ['缓存点路径', runtime?.prefixLockFirstCacheControlPath || '-'],
    ['替换次数', runtime?.prefixLockReplacements || 0],
  ]);
  clearNode($('prefixBodyStream'));

  const match = hash && state.requests.find((item) => item.prefixHash === hash || item.prefixLockHash === hash);
  if (match) {
    const full = await api(`/console/requests/${encodeURIComponent(match.id)}`);
    renderRequestBodyStream($('prefixBodyStream'), full, true);
  } else {
    appendText($('prefixBodyStream'), 'div', '当前状态没有直接暴露锁定前缀正文。开启诊断并发送一次命中该 Prefix 的请求后，可以从最近请求复原展示。', 'empty-hint');
  }
  setDrawerOpen('prefixModal', true);
}

function bindEvents() {
  for (const item of document.querySelectorAll('.nav-item')) item.onclick = () => switchPage(item.dataset.page);
  $('mobileMenuButton').onclick = () => setMobileNavOpen(!document.body.classList.contains('nav-open'));
  $('sidebarBackdrop').onclick = () => setMobileNavOpen(false);

  $('refreshAll').onclick = () => refreshAll().catch((error) => setStatus(error.message));
  $('dashboardRefresh').onclick = $('refreshAll').onclick;
  $('cacheTranslationSwitch').onchange = async () => { await postJson('/console/cache-translation', { enabled: $('cacheTranslationSwitch').checked }); await refreshAll(); setStatus($('cacheTranslationSwitch').checked ? '缓存转译已开启' : '缓存转译已关闭，高级配置仍会生效'); };
  for (const button of document.querySelectorAll('#systemMessageHandlingSeg button')) {
    button.onclick = async () => {
      const mode = button.dataset.systemMessageMode;
      await postJson('/console/system-message-handling', { mode });
      await refreshAll();
      const detail = mode === 'default'
        ? 'OpenAI 原样传输；转为 Anthropic 时保序映射并合并同角色发言（白名单模型保留跨轮 SYSTEM）'
        : mode === 'top'
          ? '所有 OpenAI-compatible 消息链都会把系统身份消息统一移至最前'
          : 'OpenAI 原样传输；转为 Anthropic 时默认上移 SYSTEM，白名单模型保留原始顺序';
      setStatus(`系统身份消息处理已切换为${systemMessageHandlingLabel(mode)}：${detail}`);
    };
  }
  for (const button of document.querySelectorAll('#autoGenerateCacheBreakpointsSeg button')) {
    button.onclick = async () => {
      const mode = button.dataset.autoBreakpoints;
      await postJson('/console/auto-cache-breakpoints', { mode, enabled: mode === 'on' });
      await refreshAll();
      const action = mode === 'auto'
        ? '自动缓存断点已设为自动：存在显式断点时跳过生成，否则开启生成'
        : `自动缓存断点已${mode === 'on' ? '开启' : '关闭'}`;
      setStatus(`${action}，锚点与 Prefix Lock 将重新学习`);
    };
  }
  $('quickCaptureSwitch').onchange = async () => { await postJson('/console/capture', { enabled: $('quickCaptureSwitch').checked }); await refreshAll(); setStatus($('quickCaptureSwitch').checked ? '诊断已开启' : '诊断已关闭'); };
  $('quickPrefixSwitch').onchange = async () => { await postJson('/console/prefix-lock', { enabled: $('quickPrefixSwitch').checked }); await refreshAll(); setStatus($('quickPrefixSwitch').checked ? 'Prefix Lock 已开启，缓存锚点已关闭并清空' : 'Prefix Lock 已关闭并清空'); };
  $('quickPrefixRefresh').onclick = async () => { await api('/console/prefix-lock/clear', { method: 'POST' }); await postJson('/console/prefix-lock', { enabled: true }); await refreshAll(); setStatus('Prefix Lock 已清空并重新开启，缓存锚点已关闭'); };

  for (const button of document.querySelectorAll('#quickTtlSeg button, #cacheTtlSeg button')) button.onclick = () => applyTtl(button.dataset.ttl);
  $('fixedHeadBreakpointCount').onchange = () => { renderCachePolicyBudget(true); scheduleCachePolicyAutoApply(200); };
  $('cacheAnchorMode').onchange = () => { renderCachePolicyBudget(true); scheduleCachePolicyAutoApply(200); };
  $('cacheAnchorIntervalBlocks').oninput = () => { renderCachePolicyBudget(true); scheduleCachePolicyAutoApply(); };
  $('autoConvertLastAnchorTo5m').onchange = () => { renderCacheProcessingOrder(); scheduleCachePolicyAutoApply(200); };
  $('ignoreLastAnchorsMode').onchange = () => {
    const evaluationMode = $('ignoreLastAnchorsMode').value === 'evaluation';
    $('ignoreLastAnchorCount').disabled = evaluationMode;
    scheduleCachePolicyAutoApply(200);
  };
  $('ignoreLastAnchorCount').oninput = () => { renderCachePolicyBudget(true); scheduleCachePolicyAutoApply(); };
  $('cacheProcessingOrderReset').onclick = () => {
    state.processingOrderDraft = [...DEFAULT_CACHE_POLICY_PROCESSING_ORDER];
    renderCacheProcessingOrder();
    scheduleCachePolicyAutoApply(200);
    setStatus('处理顺序已恢复为默认并等待自动应用。');
  };
  $('anchorIgnoreEvaluationStart').onclick = async () => {
    try {
      const result = await postJson('/console/anchor-ignore-evaluation', { action: 'start' });
      await refreshAll();
      setStatus(result.evaluationNotice || `评估模式已开启，x 已设为 0，请连续进行 3 次对话。`);
    } catch (error) {
      setStatus(error.message);
    }
  };
  $('anchorIgnoreEvaluationAccept').onclick = async () => {
    try {
      await postJson('/console/anchor-ignore-evaluation', {
        action: 'accept',
        confirmOutOfRange: true,
      });
      await refreshAll();
      setStatus('评估结果已填入忽略末尾锚点数量。');
    } catch (error) {
      setStatus(error.message);
    }
  };
  $('cacheAnchorsClear').onclick = () => clearCacheAnchors().catch((error) => setStatus(error.message));
  $('prefixLockSwitch').onchange = async () => { await postJson('/console/prefix-lock', { enabled: $('prefixLockSwitch').checked }); await refreshAll(); setStatus($('prefixLockSwitch').checked ? 'Prefix Lock 已开启，缓存锚点已关闭并清空' : 'Prefix Lock 已关闭并清空'); };
  $('prefixLockRefresh').onclick = async () => { await refreshAll(); setStatus('Prefix Lock 状态已刷新'); };
  $('prefixLockClear').onclick = async () => { await api('/console/prefix-lock/clear', { method: 'POST' }); await refreshAll(); setStatus('Prefix Lock 已清空'); };
  $('prefixModalClear').onclick = $('prefixLockClear').onclick;

  $('logsCaptureSwitch').onchange = async () => { await postJson('/console/capture', { enabled: $('logsCaptureSwitch').checked }); await refreshAll(); setStatus($('logsCaptureSwitch').checked ? '诊断已开启' : '诊断已关闭'); };
  $('clear').onclick = async () => { await api('/console/clear', { method: 'POST' }); state.selected = null; await refreshAll(); setStatus('日志已清空'); };
  $('refreshCaptures').onclick = async () => { await loadRequests(); renderRequests(); setStatus('日志已刷新'); };
  $('filterCache').onchange = () => { state.filters.cache = $('filterCache').value; state.page = 1; renderRequests(); };
  $('pageSize').onchange = () => { state.pageSize = Number($('pageSize').value); state.page = 1; renderRequests(); };
  $('maxRequestCaptures').onchange = async () => {
    const value = Number($('maxRequestCaptures').value);
    if (!Number.isInteger(value) || value < 1 || value > 1000) {
      renderCaptureControls();
      setStatus('最大保留日志数量必须是 1–1000 的整数。');
      return;
    }
    await postJson('/console/request-log-settings', { maxRequestCaptures: value });
    await refreshAll();
    setStatus(`请求日志最大保留数量已设为 ${value}，超出部分已删除。`);
  };
  $('prevPage').onclick = () => { state.page -= 1; renderRequests(); };
  $('nextPage').onclick = () => { state.page += 1; renderRequests(); };

  for (const row of document.querySelectorAll('[data-usage-style]')) {
    const textInput = row.querySelector('[data-usage-text-color]');
    const backgroundInput = row.querySelector('[data-usage-background-color]');
    const transparentInput = row.querySelector('[data-usage-background-transparent]');
    const updatePreview = () => {
      backgroundInput.disabled = transparentInput.checked;
      renderUsageAppearancePreview();
    };
    textInput.oninput = updatePreview;
    backgroundInput.oninput = updatePreview;
    transparentInput.onchange = updatePreview;
  }
  $('usageAppearancePreview').onclick = (event) => {
    setUsagePreviewEditing(true, usagePreviewFocusTarget(event.target));
  };
  $('usagePreviewDone').onclick = () => {
    setUsagePreviewEditing(false);
    renderUsageAppearancePreview();
  };
  $('usageSampleInputTokens').oninput = () => updateUsagePreviewDerived('inputTokens');
  $('usageSampleOutputTokens').oninput = () => renderUsageAppearancePreview();
  $('usageSampleCacheReadTokens').oninput = () => updateUsagePreviewDerived('cacheReadTokens');
  $('usageSampleCacheWriteTokens').oninput = () => renderUsageAppearancePreview();
  $('usageSampleHitRate').oninput = () => updateUsagePreviewDerived('cacheHitRatePercent');
  $('usageAppearanceApply').onclick = async () => {
    await postJson('/console/usage-appearance', {
      value: collectUsageAppearanceDraft(),
      previewSample: collectUsagePreviewSample(),
    });
    state.usagePreviewEditing = false;
    await refreshAll();
    setStatus('Usage 外观与示例数据已应用');
  };
  $('usageAppearanceReset').onclick = async () => {
    await postJson('/console/usage-appearance', { reset: true });
    await refreshAll();
    setStatus('Usage 配色已恢复默认，示例数据保持不变');
  };
  $('usagePreviewSampleReset').onclick = async () => {
    state.usagePreviewEditing = false;
    renderUsagePreviewSampleControls(DEFAULT_USAGE_PREVIEW_SAMPLE);
    renderUsagePreviewMode();
    renderUsageAppearancePreview();
    setStatus('Usage 示例数据已即时恢复默认，正在保存。');
    try {
      await postJson('/console/usage-appearance', { resetSample: true });
      if (state.runtime) state.runtime.usagePreviewSample = { ...DEFAULT_USAGE_PREVIEW_SAMPLE };
      setStatus('Usage 示例数据已恢复默认并保存');
    } catch (error) {
      await refreshAll().catch(() => {});
      setStatus(`Usage 示例数据保存失败：${error.message}`);
    }
  };

  for (const row of document.querySelectorAll('[data-request-cache-style]')) {
    const textInput = row.querySelector('[data-request-cache-text-color]');
    const backgroundInput = row.querySelector('[data-request-cache-background-color]');
    const transparentInput = row.querySelector('[data-request-cache-background-transparent]');
    const updatePreview = () => {
      backgroundInput.disabled = transparentInput.checked;
      renderRequestCacheAppearancePreview();
    };
    textInput.oninput = updatePreview;
    backgroundInput.oninput = updatePreview;
    transparentInput.onchange = updatePreview;
  }
  $('requestCacheAppearanceApply').onclick = async () => {
    await postJson('/console/request-cache-appearance', { value: collectRequestCacheAppearanceDraft() });
    await refreshAll();
    setStatus('Prefix 锁定 / 缓存锚点配色已应用');
  };
  $('requestCacheAppearanceReset').onclick = async () => {
    await postJson('/console/request-cache-appearance', { reset: true });
    await refreshAll();
    setStatus('Prefix 锁定 / 缓存锚点配色已恢复默认');
  };

  $('configExport').onclick = () => {
    try {
      exportGatewayConfiguration();
    } catch (error) {
      setStatus(`配置导出失败：${error.message}`);
    }
  };
  $('configImport').onclick = () => $('configImportFile').click();
  $('configImportFile').onchange = async () => {
    const [file] = $('configImportFile').files || [];
    try {
      await importGatewayConfiguration(file);
    } catch (error) {
      setStatus(`配置导入失败：${error.message}`);
    } finally {
      $('configImportFile').value = '';
    }
  };
  $('configRestoreDefault').onclick = () => restoreDefaultGatewayConfiguration().catch((error) => setStatus(error.message));

  $('extraJsonOff').onclick = async () => { await postJson('/console/upstream-extra-json', { value: {} }); await refreshAll(); setStatus('包含主体参数已清空'); };
  $('extraJsonFormat').onclick = () => { $('upstreamExtraJson').value = JSON.stringify(JSON.parse($('upstreamExtraJson').value || '{}'), null, 2); setStatus('包含主体参数已格式化'); };
  $('extraJsonApply').onclick = async () => { await postJson('/console/upstream-extra-json', { json: $('upstreamExtraJson').value }); await refreshAll(); setStatus('包含主体参数已应用'); };
  $('excludePathsOff').onclick = async () => { await postJson('/console/upstream-exclude-paths', { paths: [] }); await refreshAll(); setStatus('排除主体参数已清空'); };
  $('excludePathsApply').onclick = async () => { await postJson('/console/upstream-exclude-paths', { value: $('upstreamExcludePaths').value }); await refreshAll(); setStatus('排除主体参数已应用'); };
  $('headersOff').onclick = async () => { await postJson('/console/upstream-headers', { headers: {} }); await refreshAll(); setStatus('包含请求头已清空'); };
  $('headersFormat').onclick = () => { $('upstreamHeaders').value = JSON.stringify(JSON.parse($('upstreamHeaders').value || '{}'), null, 2); setStatus('请求头 JSON 已格式化'); };
  $('headersApply').onclick = async () => { await postJson('/console/upstream-headers', { headers: $('upstreamHeaders').value }); await refreshAll(); setStatus('包含请求头已应用'); };
  $('excludeHeadersOff').onclick = async () => { await postJson('/console/upstream-exclude-headers', { headers: [] }); await refreshAll(); setStatus('排除请求头已清空'); };
  $('excludeHeadersApply').onclick = async () => { await postJson('/console/upstream-exclude-headers', { value: $('upstreamExcludeHeaders').value }); await refreshAll(); setStatus('排除请求头已应用'); };

  $('closeDrawer').onclick = closeDrawer;
  $('drawerBackdrop').onclick = closeDrawer;
  $('closePrefixModal').onclick = closePrefixModal;
  $('prefixBackdrop').onclick = closePrefixModal;
  $('openAnthropicOptimizationWhitelist').onclick = openAnthropicOptimizationWhitelist;
  $('closeAnthropicOptimizationWhitelist').onclick = closeAnthropicOptimizationWhitelist;
  $('anthropicOptimizationWhitelistBackdrop').onclick = closeAnthropicOptimizationWhitelist;
  $('cancelAnthropicOptimizationWhitelist').onclick = closeAnthropicOptimizationWhitelist;
  $('anthropicOptimizationModelWhitelistInput').oninput = updateAnthropicOptimizationWhitelistDraftCount;
  $('saveAnthropicOptimizationWhitelist').onclick = () => saveAnthropicOptimizationWhitelist().catch((error) => setStatus(error.message));
  $('openGuide').onclick = () => setDrawerOpen('guideModal', true);
  $('closeGuide').onclick = closeGuide;
  $('guideBackdrop').onclick = closeGuide;

  for (const tab of document.querySelectorAll('.tab')) {
    tab.onclick = () => {
      state.selectedTab = tab.dataset.tab;
      for (const item of document.querySelectorAll('.tab')) item.classList.toggle('active', item === tab);
      renderDetail();
      const detailScroll = document.querySelector('.detail-scroll');
      if (detailScroll) detailScroll.scrollTop = 0;
    };
  }
  $('expandAllMessages').onclick = () => document.querySelectorAll('#detailBodyStream .msg-card').forEach((card) => card.classList.remove('collapsed'));
  $('collapseAllMessages').onclick = () => document.querySelectorAll('#detailBodyStream .msg-card').forEach((card) => card.classList.add('collapsed'));
  $('download').onclick = () => state.selected && downloadJson(state.selected, `st-claude-cache-gateway-request-${state.selected.id}.json`);

  for (const item of document.querySelectorAll('.guide-toc-item')) {
    item.onclick = (event) => {
      event.preventDefault();
      document.querySelectorAll('.guide-toc-item').forEach((link) => link.classList.remove('active'));
      item.classList.add('active');
      const target = document.querySelector(item.getAttribute('href'));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  }
}

bindEvents();
bindMobileMenuScroll();
refreshAll().catch((error) => {
  setStatus(error.message);
  $('cacheControl').textContent = error.message;
});
