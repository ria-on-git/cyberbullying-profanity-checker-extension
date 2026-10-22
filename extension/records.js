/* One transactional store for every tab and popup. No feedback trains a model. */
(() => {
  const KINDS = ['detections', 'reports', 'feedback'];
  const LIMIT = 200;
  const toxicityLabels = [null, 'toxic', 'non_toxic', 'uncertain'];
  const profanityLabels = [null, 'present', 'absent', 'uncertain'];
  let ready;
  const request = req => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const finished = tx => new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error('Local transaction aborted'));
    tx.onerror = () => {}; // onabort reports the failed transaction.
  });
  function origin(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin.length > 300) throw new Error('Invalid site');
    return url.origin;
  }
  function scope(value) {return value === null ? null : origin(value);}
  function kind(value) {
    if (!KINDS.includes(value)) throw new Error('Invalid record view');
    return value;
  }
  const finite = value => Number.isFinite(value) ? value : null;
  async function normalize(input, legacy = false) {
    if (!input || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000) throw new Error('Invalid record text');
    const site = origin(input.site);
    const text = input.text.trim();
    const source = input.prediction || input;
    const terms = Array.isArray(source.matched_terms) ? source.matched_terms : (Array.isArray(source.profanity) ? source.profanity : []);
    const prediction = {
      toxic: typeof source.toxic === 'boolean' ? source.toxic : null,
      profanity: typeof source.profanity === 'boolean' ? source.profanity : terms.length > 0,
      matched_terms: [...new Set(terms.filter(t => typeof t === 'string').map(t => t.slice(0, 50)))].sort().slice(0, 20),
      assessment: ['potential_abuse', 'not_flagged', 'insufficient_information'].includes(source.assessment) ? source.assessment : 'legacy_unknown',
      reason: String(source.reason || input.reason || 'Legacy detection; decision details unavailable').slice(0, 1000),
      margin: finite(source.margin), threshold: finite(source.threshold),
      sensitivity: ['relaxed', 'balanced', 'strict'].includes(source.sensitivity) ? source.sensitivity : null,
      ml_eligible: typeof source.ml_eligible === 'boolean' ? source.ml_eligible : null,
      policy_version: finite(source.policy_version)
    };
    // Same origin + whitespace-equivalent text + same decision is one record,
    // across tabs, reloads and sensitivity changes. Different decisions remain distinct.
    const identity = JSON.stringify([site, text.normalize('NFC').replace(/\s+/gu, ' '),
      prediction.toxic, prediction.profanity, prediction.assessment, prediction.matched_terms]);
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
    const id = [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');
    const record = {id, site, text, prediction, createdAt: new Date().toISOString()};
    if (legacy) record.legacyTime = String(input.time || '').slice(0, 100);
    return record;
  }
  async function initialize() {
    const opening = indexedDB.open('cybershield-local', 1);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      const records = db.createObjectStore('records', {keyPath: 'key'});
      records.createIndex('kind', 'kind');
      db.createObjectStore('meta', {keyPath: 'key'});
    };
    const db = await request(opening);
    db.onversionchange = () => {db.close(); ready = undefined;};
    const legacy = await chrome.storage.local.get(['history', 'reports', 'feedback']);
    const imported = [];
    for (const [oldKey, bucket] of [['history', 'detections'], ['reports', 'reports'], ['feedback', 'feedback']]) {
      for (const input of Array.isArray(legacy[oldKey]) ? legacy[oldKey].slice(-LIMIT) : []) {
        try {imported.push({...await normalize(input, true), kind: bucket});}
        catch { /* Malformed legacy entries cannot be used as labeled examples. */ }
      }
    }
    const tx = db.transaction(['records', 'meta'], 'readwrite');
    const done = finished(tx);
    const records = tx.objectStore('records'), meta = tx.objectStore('meta');
    const migrated = meta.get('migrated');
    migrated.onsuccess = () => {
      if (migrated.result) return;
      let sequence = 0;
      for (const item of imported) {
        const record = {...item, key: `${item.kind}:${item.id}`, sequence: ++sequence};
        if (record.kind === 'feedback') record.review = {status: 'unreviewed', toxicityLabel: null, profanityLabel: null, notes: '', reviewedAt: null};
        records.put(record);
      }
      meta.put({key: 'sequence', value: sequence});
      meta.put({key: 'migrated', value: true});
    };
    await done;
    // Remove the old arrays only after the transaction commits. A worker restart
    // repeats cleanup, never imports a second time or resurrects cleared records.
    await chrome.storage.local.remove(['history', 'reports', 'feedback']);
    return db;
  }
  function database() {
    if (!ready) ready = initialize().catch(error => {ready = undefined; throw error;});
    return ready;
  }
  function notify() {
    chrome.runtime.sendMessage({type: 'records-changed'}).catch(() => {});
  }
  async function add(bucket, input) {
    const entry = await normalize(input);
    const db = await database();
    const tx = db.transaction(['records', 'meta'], 'readwrite'), done = finished(tx);
    const records = tx.objectStore('records'), meta = tx.objectStore('meta');
    let stored, created = false;
    const rows = records.index('kind').getAll(bucket);
    rows.onsuccess = () => {
      stored = rows.result.find(row => row.id === entry.id);
      if (stored) return;
      const sequence = meta.get('sequence');
      sequence.onsuccess = () => {
        stored = {...entry, kind: bucket, key: `${bucket}:${entry.id}`, sequence: (sequence.result?.value || 0) + 1};
        if (bucket === 'feedback') stored.review = {status: 'unreviewed', toxicityLabel: null, profanityLabel: null, notes: '', reviewedAt: null};
        records.put(stored);
        meta.put({key: 'sequence', value: stored.sequence});
        rows.result.sort((a, b) => a.sequence - b.sequence).slice(0, Math.max(0, rows.result.length + 1 - LIMIT))
          .forEach(row => records.delete(row.key));
        created = true;
      };
    };
    await done;
    if (created) notify();
    return {record: stored, created};
  }
  async function list(bucket, site) {
    const db = await database();
    const tx = db.transaction('records', 'readonly'), done = finished(tx);
    const rows = await request(tx.objectStore('records').index('kind').getAll(bucket));
    await done;
    return rows.filter(row => site === null || row.site === site).sort((a, b) => b.sequence - a.sequence);
  }
  async function clear(bucket, site) {
    const db = await database();
    const tx = db.transaction('records', 'readwrite'), done = finished(tx);
    const records = tx.objectStore('records');
    const ids = [];
    const rows = records.index('kind').getAll(bucket);
    rows.onsuccess = () => {
      rows.result.filter(row => site === null || row.site === site).forEach(row => {records.delete(row.key); ids.push(row.id);});
    };
    await done; notify();
    return {removed: ids.length, ids};
  }
  async function review(id, value) {
    if (!/^[a-f0-9]{64}$/.test(id || '') || !value || typeof value.reviewed !== 'boolean' ||
        !toxicityLabels.includes(value.toxicityLabel) || !profanityLabels.includes(value.profanityLabel) ||
        typeof value.notes !== 'string' || value.notes.length > 1000) throw new Error('Invalid feedback review');
    const db = await database();
    const tx = db.transaction('records', 'readwrite'), done = finished(tx);
    const records = tx.objectStore('records');
    let stored;
    const found = records.get(`feedback:${id}`);
    found.onsuccess = () => {
      if (!found.result) {tx.abort(); return;}
      stored = {...found.result, review: {status: value.reviewed ? 'reviewed' : 'unreviewed',
        toxicityLabel: value.toxicityLabel, profanityLabel: value.profanityLabel,
        notes: value.notes.trim(), reviewedAt: value.reviewed ? new Date().toISOString() : null}};
      records.put(stored);
    };
    await done; notify();
    return {record: stored};
  }
  async function dispatch(message) {
    const bucket = kind(message.kind);
    if (message.action === 'add') return add(bucket, message.record);
    if (message.action === 'review') {
      if (bucket !== 'feedback') throw new Error('Only feedback can be reviewed');
      return review(message.id, message.review);
    }
    const site = scope(message.site);
    if (message.action === 'clear') return clear(bucket, site);
    if (message.action === 'list') return {records: await list(bucket, site), limit: LIMIT};
    if (message.action === 'export') {
      if (typeof message.reviewedOnly !== 'boolean' || (message.reviewedOnly && bucket !== 'feedback')) throw new Error('Invalid export selection');
      const rows = await list(bucket, site);
      return {export: {schemaVersion: 1, exportedAt: new Date().toISOString(), kind: bucket,
        site, reviewedOnly: message.reviewedOnly,
        notice: 'Local records only. Reports do not notify websites. Feedback labels are explicit human review, never inferred by flipping a prediction. No automatic training.',
        records: rows.filter(row => !message.reviewedOnly || row.review.status === 'reviewed')}};
    }
    throw new Error('Unknown record operation');
  }
  globalThis.CyberShieldRecords = {dispatch};
})();
