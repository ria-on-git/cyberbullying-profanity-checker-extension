const $ = id => document.getElementById(id);
let tabId, siteKey;
let statusRevision = 0;
let view = 'detections';
let dataRevision = 0;
const drafts = new Map();
const names = {detections: 'Detections', reports: 'Reports', feedback: 'Feedback'};
const selectedSite = () => $('scope').value === 'all' ? null : siteKey;

function showStatus(status) {
  if (!status) return;
  const messages = {
    loading: 'Scanning visible text…',
    disabled: 'Protection is off for this site.',
    offline: 'Detection service unavailable. Start the local API, then retry.',
    complete: status.warnings
      ? `Scan complete: ${status.warnings} warning${status.warnings === 1 ? '' : 's'} in ${status.scanned} text blocks.`
      : `Scan complete: no detections in ${status.scanned} text blocks.`
  };
  $('status').textContent = messages[status.phase] || 'Ready to scan.';
  if (status.phase === 'complete' && status.insufficient) {
    $('status').textContent += ` ${status.insufficient} had insufficient information.`;
  }
  $('status').dataset.phase = status.phase;
  $('status').setAttribute('aria-busy', String(status.phase === 'loading'));
  $('scan').textContent = status.phase === 'offline' ? 'Retry scan' : 'Scan current page';
  $('scan').disabled = status.phase === 'disabled';
}

async function records(action, extra = {}) {
  const response = await chrome.runtime.sendMessage({type: 'records', action, kind: view, site: selectedSite(), ...extra});
  if (!response || response.error) throw new Error(response?.error || 'Local records unavailable');
  return response;
}
function announce(text) { $('record-status').textContent = text; }
function run(action) {
  return action().catch(error => announce(`Could not complete local action: ${error.message}`));
}
function reviewForm(record) {
  const form = document.createElement('form');
  form.className = 'review';
  const value = drafts.get(record.id) || {
    reviewed: record.review.status === 'reviewed', toxicityLabel: record.review.toxicityLabel,
    profanityLabel: record.review.profanityLabel, notes: record.review.notes
  };
  function select(labelText, choices, selected) {
    const label = document.createElement('label'); label.textContent = labelText;
    const control = document.createElement('select');
    for (const [key, text] of choices) {
      const option = document.createElement('option'); option.value = key; option.textContent = text; control.append(option);
    }
    control.value = selected || ''; label.append(control); form.append(label); return control;
  }
  const toxicity = select('Human toxicity label ', [['', 'Unlabelled'], ['toxic', 'Toxic'], ['non_toxic', 'Non-toxic'], ['uncertain', 'Uncertain / needs context']], value.toxicityLabel);
  toxicity.dataset.label = 'toxicity';
  const profanity = select('Human profanity label ', [['', 'Unlabelled'], ['present', 'Present'], ['absent', 'Absent'], ['uncertain', 'Uncertain']], value.profanityLabel);
  profanity.dataset.label = 'profanity';
  const label = document.createElement('label'); label.textContent = 'Review notes';
  const notes = document.createElement('textarea'); notes.maxLength = 1000; notes.rows = 2;
  notes.value = value.notes; label.append(notes); form.append(label);
  const reviewedLabel = document.createElement('label');
  const reviewed = document.createElement('input'); reviewed.type = 'checkbox'; reviewed.checked = value.reviewed;
  reviewedLabel.append(reviewed, ' Reviewed by me'); form.append(reviewedLabel);
  function read() {return {reviewed: reviewed.checked, toxicityLabel: toxicity.value || null, profanityLabel: profanity.value || null, notes: notes.value};}
  form.oninput = form.onchange = () => drafts.set(record.id, read());
  const save = document.createElement('button'); save.type = 'submit'; save.textContent = 'Save review'; form.append(save);
  form.onsubmit = event => {
    event.preventDefault();
    const submitted = drafts.get(record.id) || read();
    save.disabled = true;
    run(async () => {
      await records('review', {kind: 'feedback', id: record.id, review: submitted});
      if (drafts.get(record.id) === submitted) drafts.delete(record.id);
      announce('Review saved locally. No model was retrained.'); await refresh();
    }).finally(() => {save.disabled = false;});
  };
  return form;
}
function renderRows(rows) {
  const active = document.activeElement;
  const focusedId = active.closest?.('[data-record-id]')?.dataset.recordId;
  const field = active.matches?.('textarea') ? 'textarea' : active.dataset?.label
    ? `[data-label="${active.dataset.label}"]` : active.matches?.('input[type=checkbox]') ? 'input[type=checkbox]' : null;
  const selection = active.matches?.('textarea') ? [active.selectionStart, active.selectionEnd] : null;
  $('items').replaceChildren();
  if (!rows.length) {const empty = document.createElement('p'); empty.textContent = `No ${view} saved in this scope.`; $('items').append(empty);}
  for (const record of rows) {
    const row = document.createElement('article'); row.className = 'item'; row.dataset.recordId = record.id;
    const text = document.createElement('div'); text.className = 'snippet'; text.textContent = record.text;
    const meta = document.createElement('small'); meta.textContent = `${record.site} · ${record.createdAt}`;
    const decision = document.createElement('div');
    decision.textContent = `Saved prediction: ${record.prediction.reason}. ML: ${record.prediction.assessment}; profanity: ${record.prediction.profanity ? 'present' : 'not detected'}.`;
    row.append(text, meta, decision);
    if (view === 'feedback') {
      const state = document.createElement('strong'); state.textContent = record.review.status === 'reviewed' ? 'Reviewed' : 'Unreviewed — no corrected label assumed';
      row.append(state, reviewForm(record));
    } else {
      const report = document.createElement('button'); report.type = 'button'; report.textContent = 'Save local report';
      report.onclick = () => run(async () => {
        const saved = await records('add', {kind: 'reports', record});
        announce(`${saved.created ? 'Report saved locally.' : 'Report already saved.'} The website has not been notified.`);
      });
      if (view === 'detections') row.append(report);
      const feedback = document.createElement('button'); feedback.type = 'button'; feedback.textContent = 'Mark prediction incorrect';
      feedback.onclick = () => run(async () => {
        const saved = await records('add', {kind: 'feedback', record});
        announce(saved.created ? 'Feedback saved as unreviewed. Review it in Feedback; no opposite label was assumed.' : 'Feedback already saved; its review was preserved.');
      });
      row.append(feedback);
    }
    $('items').append(row);
  }
  if (focusedId && field) {
    const control = document.querySelector(`[data-record-id="${focusedId}"] ${field}`);
    control?.focus({preventScroll: true});
    if (selection && control) control.setSelectionRange(...selection);
  }
}
async function refresh() {
  const current = ++dataRevision;
  const selectedView = view;
  const [data, saved] = await Promise.all([
    chrome.storage.local.get(['enabledSites', 'sensitivity']), records('list')
  ]);
  if (current !== dataRevision) return;
  $('counts').textContent = `${names[selectedView]}: ${saved.records.length} · ${selectedSite() ? 'this site' : 'all sites'} · limit ${saved.limit} per view globally`;
  if (siteKey) $('enabled').checked = data.enabledSites?.[siteKey] !== false;
  $('sensitivity').value = data.sensitivity || 'balanced';
  for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === view));
  $('export-reviewed').hidden = view !== 'feedback';
  $('clear').textContent = `Clear ${view} (${selectedSite() ? 'this site' : 'all sites'})`;
  renderRows(saved.records);
}

async function queryStatus() {
  const current = ++statusRevision;
  try {
    const status = await chrome.tabs.sendMessage(tabId, {type: 'scanner-status'});
    if (current === statusRevision) showStatus(status);
  } catch {
    if (current !== statusRevision) return;
    if (!$('enabled').checked) showStatus({phase: 'disabled'});
    else {
      $('status').textContent = 'Scanner is not loaded. Click Scan current page to start.';
      $('status').dataset.phase = 'ready';
      $('scan').disabled = false;
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'scan-status' && sender.tab?.id === tabId) {
    statusRevision++;
    showStatus(message.status);
  }
});

chrome.tabs.query({active: true, currentWindow: true}, async ([tab]) => {
  tabId = tab?.id;
  try {
    const url = new URL(tab.url);
    siteKey = url.origin;
    if (!['http:', 'https:'].includes(url.protocol)) throw Error();
  } catch {
    $('status').textContent = 'This browser page cannot be scanned.';
    for (const id of ['scan', 'enabled', 'sensitivity']) $(id).disabled = true;
    $('scope').value = 'all';
    $('scope').querySelector('[value="site"]').disabled = true;
    await run(refresh);
    return;
  }
  $('site').textContent = new URL(siteKey).hostname;
  await run(refresh);
  await queryStatus();
  $('enabled').disabled = false;
  $('sensitivity').disabled = false;
});

$('enabled').onchange = async () => {
  const enabled = $('enabled').checked;
  statusRevision++;
  showStatus({phase: enabled ? 'loading' : 'disabled'});
  // Notify the page immediately; storage events also update any other tabs.
  chrome.tabs.sendMessage(tabId, {type: 'settings', enabled}).catch(() => {});
  const {enabledSites = {}} = await chrome.storage.local.get('enabledSites');
  enabledSites[siteKey] = enabled;
  await chrome.storage.local.set({enabledSites});
  if (enabled) {
    try { await chrome.tabs.sendMessage(tabId, {type: 'scanner-status'}); }
    catch { await startScan(); }
  }
};
$('sensitivity').onchange = async () => {
  const sensitivity = $('sensitivity').value;
  await chrome.storage.local.set({sensitivity});
  // The content script listens to storage; query status without resetting twice.
  await queryStatus();
};
async function startScan() {
  statusRevision++;
  showStatus({phase: 'loading'});
  try {
    await chrome.scripting.executeScript({target: {tabId}, files: ['content.js']});
    await queryStatus();
  } catch (error) {
    $('status').textContent = `Cannot scan this page: ${error.message}`;
    $('status').dataset.phase = 'unavailable';
    $('status').setAttribute('aria-busy', 'false');
  }
}
$('scan').onclick = startScan;
for (const button of document.querySelectorAll('[data-view]')) {
  button.onclick = () => {view = button.dataset.view; announce(''); run(refresh);};
}
$('scope').onchange = () => {announce(''); run(refresh);};
$('clear').onclick = () => run(async () => {
  const selected = view, site = selectedSite();
  const response = await records('clear', {kind: selected, site});
  if (selected === 'feedback') response.ids.forEach(id => drafts.delete(id));
  announce(`Cleared ${response.removed} ${selected} ${site ? 'on this site' : 'across all sites'}. Other views were kept.`);
  await refresh();
});
async function exportRecords(reviewedOnly) {
  const response = await records('export', {reviewedOnly});
  const data = response.export;
  const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = `cybershield-${data.kind}${reviewedOnly ? '-reviewed' : ''}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  announce(`Download started for ${data.records.length} ${reviewedOnly ? 'reviewed ' : ''}${data.kind} records. Export is a local file; no training was started.`);
}
$('export').onclick = () => run(() => exportRecords(false));
$('export-reviewed').onclick = () => run(() => exportRecords(true));
chrome.runtime.onMessage.addListener(message => {
  if (message.type === 'records-changed') run(refresh);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.enabledSites || changes.sensitivity)) {
    run(refresh);
    if (siteKey) queryStatus();
  }
});
