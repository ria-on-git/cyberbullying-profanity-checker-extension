(() => {
  if (window.__cybershieldLoaded) {
    window.dispatchEvent(new Event('cybershield-rescan'));
    return;
  }
  window.__cybershieldLoaded = true;
  const site = location.origin;
  const selector = 'p, li, blockquote, article, [role="comment"], [data-testid*="comment"], [class*="comment"], [class*="message"]';
  const excluded = '[data-cybershield-ui], input, textarea, select, button, label, [contenteditable], form, nav, header, footer, [role="navigation"], [role="menu"], [hidden], [inert], [aria-hidden="true"], script, style, noscript, template';
  const states = new Map();
  const dirty = new Set();
  const ownStyleWrites = new WeakMap();
  let enabled = false;
  let sensitivity = 'balanced';
  let revision = 0;
  let timer;
  let activeRun = null;
  let status = {phase: 'loading', scanned: 0, warnings: 0, insufficient: 0};

  function publish(phase) {
    status = {phase, scanned: states.size,
      warnings: [...states.values()].filter(s => s.host?.isConnected).length,
      insufficient: [...states.values()].filter(s => s.result?.assessment === 'insufficient_information').length};
    chrome.runtime.sendMessage({type: 'scan-status', status}).catch(() => {});
  }

  function visible(el) {
    if (!el.isConnected || !el.getClientRects().length) return false;
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' ||
          style.visibility === 'collapse' || Number(style.opacity) === 0 ||
          style.contentVisibility === 'hidden') return false;
    }
    return true;
  }

  function suitable(el) {
    return el.matches(selector) && !el.closest(excluded) && visible(el);
  }

  function readText(el) {
    if (!suitable(el)) return null;
    // Only leaf blocks: no parent/child duplicate warnings.
    if ([...el.querySelectorAll(selector)].some(suitable)) return null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement.closest(excluded) || !visible(node.parentElement)
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    let text = '';
    while (walker.nextNode()) text += walker.currentNode.nodeValue;
    text = text.replace(/\s+/g, ' ').trim();
    return text && text.length <= 1000 ? text : null;
  }

  function clearWarning(state) {
    state.host?.remove();
    state.host = null;
    for (const saved of state.savedStyles || []) {
      const owned = state.ownedStyles.find(s => s.property === saved.property);
      const style = state.element.style;
      // Respect page style changes made since our highlight was applied.
      if (style.getPropertyValue(saved.property) === owned.value &&
          style.getPropertyPriority(saved.property) === owned.priority) {
        if (saved.value) style.setProperty(saved.property, saved.value, saved.priority);
        else style.removeProperty(saved.property);
      }
    }
    if (state.savedStyles) ownStyleWrites.set(state.element, state.element.getAttribute('style'));
    state.savedStyles = null;
  }

  function invalidate(el) {
    const state = states.get(el);
    if (state) clearWarning(state);
    states.delete(el);
    if (enabled && el.isConnected) dirty.add(el);
  }

  function collect(root) {
    if (!(root instanceof Element) || root.closest('[data-cybershield-ui]')) return;
    if (root.matches(selector)) dirty.add(root);
    root.querySelectorAll(selector).forEach(el => dirty.add(el));
  }

  function schedule() {
    if (!enabled) return;
    clearTimeout(timer);
    timer = setTimeout(scan, 100);
  }

  async function saveRecord(kind, record) {
    const response = await chrome.runtime.sendMessage({type: 'records', action: 'add', kind, record});
    if (!response || response.error) throw new Error(response?.error || 'Local save failed');
    return response;
  }

  function mark(state, result) {
    const reason = result.reason;
    const el = state.element;
    const record = {site, text: state.text, prediction: result};

    state.savedStyles = ['outline', 'outline-offset'].map(property => ({
      property, value: el.style.getPropertyValue(property),
      priority: el.style.getPropertyPriority(property)
    }));
    el.style.setProperty('outline', '2px solid #dc7455', 'important');
    el.style.setProperty('outline-offset', '3px', 'important');
    state.ownedStyles = state.savedStyles.map(({property}) => ({
      property, value: el.style.getPropertyValue(property),
      priority: el.style.getPropertyPriority(property)
    }));
    ownStyleWrites.set(el, el.getAttribute('style'));

    const host = document.createElement('div');
    host.dataset.cybershieldUi = '1';
    host.dataset.cybershieldWarning = '1';
    host.style.setProperty('all', 'initial', 'important');
    host.style.setProperty('display', 'block', 'important');

    const root = host.attachShadow({mode: 'closed'});
    const style = document.createElement('style');

    style.textContent = `
      :host {
        color-scheme: light;
      }

      .warning {
        all: initial;
        display: block;
        box-sizing: border-box;
        margin: 8px 0;
        padding: 10px;
        background: #fff5e9;
        color: #253040;
        border: 1px solid #dba17c;
        border-radius: 8px;
        font: 13px/1.5 system-ui, sans-serif;
        overflow-wrap: anywhere;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 8px;
      }

      button {
        all: initial;
        box-sizing: border-box;
        padding: 5px 9px;
        border: 1px solid #9aa8b7;
        border-radius: 5px;
        background: #ffffff;
        color: #253040;
        font: 13px system-ui, sans-serif;
        cursor: pointer;
      }

      button:focus-visible {
        outline: 2px solid #245bb2;
      }

      .details[hidden] { display: none; }

      .details {
        margin-top: 8px;
        white-space: pre-wrap;
      }
    `;

    const box = document.createElement('div');
    box.className = 'warning';

    const title = document.createElement('div');
    title.textContent = `⚠ ${reason}`;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const details = document.createElement('div');
    details.className = 'details';
    details.hidden = true;

    const margin = Number.isFinite(result.margin)
      ? result.margin.toFixed(3)
      : 'unavailable';

    details.textContent = [
      `Decision: ${result.reason}`,
      `ML assessment: ${result.assessment === 'potential_abuse'
        ? 'Potential abuse' : result.assessment === 'insufficient_information'
          ? 'Insufficient information' : 'No ML toxicity flag'}`,
      `Sensitivity: ${result.sensitivity}; threshold: ${result.threshold}`,
      `SVM margin: ${margin} (not a probability)`,
      `Profanity terms: ${result.matched_terms?.join(', ') || 'none'}`,
      'Profanity alone does not establish bullying.',
      'This is a screening result, not proof of cyberbullying.'
    ].join('\n');
    const actionStatus = document.createElement('div');
    actionStatus.setAttribute('role', 'status');


    function button(label, action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;

      b.onclick = async () => {
        try {
          await action();
        } catch (error) {
          console.info('CyberShield:', error);
          actionStatus.textContent = 'Could not save. Please try again.';
        }
      };

      actions.append(b);
    }

    button('Why?', () => {
      details.hidden = !details.hidden;
    });

    button('Report', async () => {
      await saveRecord('reports', record);
      actionStatus.textContent = 'Report saved locally. The website has not been notified.';
    });

    button('Incorrect', async () => {
      await saveRecord('feedback', record);

      state.dismissed = true;
      clearWarning(state);
      if (enabled && !activeRun) publish('complete');
    });

    button('Ignore', () => {
      state.dismissed = true;
      clearWarning(state);
      if (enabled && !activeRun) publish('complete');
    });

    box.setAttribute('role', 'note');
    box.append(title, actions, actionStatus, details);
    root.append(style, box);

    state.host = host;
    el.insertAdjacentElement('afterend', host);

    saveRecord('detections', record).catch(error => {
      console.info('CyberShield storage:', error);
      actionStatus.textContent = 'Detection could not be saved locally.';
    });
  }


  function reset(nextEnabled = enabled, nextSensitivity = sensitivity) {
    revision++;
    enabled = nextEnabled;
    sensitivity = nextSensitivity;
    clearTimeout(timer);
    activeRun = null;
    chrome.runtime.sendMessage({type: 'cancel-predictions'}).catch(() => {});
    for (const state of states.values()) clearWarning(state);
    states.clear();
    dirty.clear();
    if (!enabled) { publish('disabled'); return; }
    // Full discovery only on initial/manual scan or settings changes.
    collect(document.documentElement);
    publish('loading');
    schedule();
  }

  function validResult(result) {
    // Fail closed on inconsistent/old API responses instead of showing a
    // warning whose explanation says "No flag".
    return result && typeof result.toxic === 'boolean' &&
      typeof result.profanity === 'boolean' &&
      result.flagged === (result.toxic || result.profanity) &&
      result.toxic === (result.assessment === 'potential_abuse') &&
      ['potential_abuse', 'not_flagged', 'insufficient_information'].includes(result.assessment) &&
      result.sensitivity === sensitivity && typeof result.reason === 'string' &&
      (!result.flagged || (result.reason.trim() && !/no flag/i.test(result.reason)));
  }

  async function scan() {
    if (!enabled || activeRun) return;
    const run = {revision};
    activeRun = run;
    let failed = false;
    publish('loading');
    try {
      while (dirty.size && enabled && activeRun === run) {
        const batch = [];
        for (const el of dirty) {
          dirty.delete(el);
          const text = readText(el);
          const old = states.get(el);
          if (old?.text === text) continue;
          if (old) { clearWarning(old); states.delete(el); }
          if (!text) continue;
          const state = {element: el, text, host: null, result: null};
          states.set(el, state);
          batch.push(state);
          if (batch.length === 30) break;
        }
        if (!batch.length) continue;
        const response = await chrome.runtime.sendMessage({
          type: 'predict', texts: batch.map(s => s.text), sensitivity
        });
        if (!enabled || activeRun !== run || revision !== run.revision) return;
        if (response?.error || !Array.isArray(response?.results) ||
            response.results.length !== batch.length || !response.results.every(validResult)) {
          throw new Error(response?.error || 'Inconsistent detection response');
        }
        batch.forEach((state, i) => {
          const el = state.element;
          if (states.get(el) !== state || readText(el) !== state.text) return;
          state.result = response.results[i];
          if (state.result.flagged) mark(state, state.result);
        });
      }
    } catch (error) {
      if (activeRun !== run) return;
      console.info('CyberShield:', error);
      failed = true;
      // Keep failed texts retryable, without an automatic offline retry loop.
      for (const [el, state] of states) {
        if (!state.result) { states.delete(el); dirty.add(el); }
      }
      publish('offline');
    } finally {
      if (activeRun === run) {
        activeRun = null;
        if (!failed) {
          if (dirty.size) schedule();
          else publish('complete');
        }
      }
    }
  }

  const observer = new MutationObserver(changes => {
    if (!enabled) return;
    let changed = false;
    for (const change of changes) {
      const target = change.target.nodeType === Node.ELEMENT_NODE
        ? change.target : change.target.parentElement;
      if (!target || target.closest('[data-cybershield-ui]')) continue;
      if (change.type === 'attributes' && change.attributeName === 'style' &&
          ownStyleWrites.has(target) && ownStyleWrites.get(target) === target.getAttribute('style')) continue;
      if (change.type === 'childList' &&
          [...change.addedNodes, ...change.removedNodes].every(node =>
            node.nodeType === Node.ELEMENT_NODE && node.matches('[data-cybershield-ui]'))) continue;
      changed = true;
      // Invalidate affected ancestors immediately, including in-flight states.
      for (let node = target; node; node = node.parentElement) {
        if (node.matches(selector)) invalidate(node);
      }
      if (change.type === 'attributes') {
        for (const el of states.keys()) {
          if (target.contains(el)) invalidate(el);
        }
        collect(target);
      }
      if (change.type === 'childList') {
        for (const node of change.removedNodes) {
          if (!(node instanceof Element)) continue;
          for (const el of states.keys()) {
            if (node === el || node.contains(el)) invalidate(el);
          }
        }
        change.addedNodes.forEach(node => collect(node));
      }
    }
    if (!changed) return;
    // Only tracked elements are checked for removal, never a full-page query.
    for (const el of states.keys()) {
      if (!el.isConnected) { invalidate(el); dirty.delete(el); }
    }
    if (dirty.size) {
      publish('loading');
      schedule();
    } else if (status.phase !== 'offline') {
      publish(activeRun ? 'loading' : 'complete');
    }
  });
  observer.observe(document.documentElement, {childList: true, subtree: true,
    characterData: true, attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'contenteditable', 'inert', 'role', 'data-testid']});

  window.addEventListener('cybershield-rescan', () => reset());
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type === 'scanner-status') respond(status);
    if (message.type === 'settings') {
      reset(typeof message.enabled === 'boolean' ? message.enabled : enabled,
        message.sensitivity || sensitivity);
      respond(status);
    }
    if (message.type === 'scan') { reset(); respond(status); }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const nextEnabled = changes.enabledSites ? changes.enabledSites.newValue?.[site] !== false : enabled;
    const nextSensitivity = changes.sensitivity ? changes.sensitivity.newValue || 'balanced' : sensitivity;
    if (nextEnabled !== enabled || nextSensitivity !== sensitivity) reset(nextEnabled, nextSensitivity);
  });
  const initialRevision = revision;
  chrome.storage.local.get(['enabledSites', 'sensitivity']).then(data => {
    if (revision === initialRevision) reset(data.enabledSites?.[site] !== false, data.sensitivity || 'balanced');
  }).catch(error => { console.info('CyberShield:', error); publish('offline'); });
})();
