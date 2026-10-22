importScripts('records.js');
const API = 'http://127.0.0.1:5000';
const requests = new Map();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type === 'records') {
    CyberShieldRecords.dispatch(message).then(respond).catch(error => respond({error: error.message}));
    return true;
  }
  const key = sender.tab?.id;
  if (message.type === 'cancel-predictions') {
    requests.get(key)?.abort();
    requests.delete(key);
    return;
  }
  if (message.type !== 'predict') return;
  requests.get(key)?.abort();
  const controller = new AbortController();
  requests.set(key, controller);
  const timeout = setTimeout(() => controller.abort(), 12000);
  fetch(`${API}/predict`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({texts: message.texts, sensitivity: message.sensitivity}),
    signal: controller.signal
  }).then(async response => {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    respond({results: data.results});
  }).catch(error => respond({error: `Local detection service unavailable: ${error.message}`}))
    .finally(() => {
      clearTimeout(timeout);
      if (requests.get(key) === controller) requests.delete(key);
    });
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  requests.get(tabId)?.abort();
  requests.delete(tabId);
});
