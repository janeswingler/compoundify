const params = new URLSearchParams(window.location.search);
const urlParticipantID = params.get('participantID');
const storedParticipantID = localStorage.getItem('participantID');

let participantID = urlParticipantID || storedParticipantID;
if (!participantID) {
  participantID = (crypto.randomUUID && crypto.randomUUID()) || `p_${Date.now()}`;
}
const participantChanged = !!urlParticipantID && urlParticipantID !== storedParticipantID;
if (urlParticipantID) localStorage.setItem('participantID', participantID);

const systemID = params.get('systemID') || localStorage.getItem('systemID') || '';
if (systemID) localStorage.setItem('systemID', systemID);

let sessionID = params.get('sessionID') || localStorage.getItem('sessionID');
if (!sessionID || participantChanged) {
  sessionID = (crypto.randomUUID && crypto.randomUUID()) || `s_${Date.now()}`;
}
localStorage.setItem('sessionID', sessionID);

const SESSION_UNLOCK_SECONDS = 10;
const timerEl = document.getElementById('topbar-timer');
const returnBtn = document.getElementById('topbar-return');
const sessionStart = Date.now();
function updateSessionTimer() {
  const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  timerEl.textContent = `${mm}:${ss}`;
  if (elapsed >= SESSION_UNLOCK_SECONDS && returnBtn.disabled) {
    returnBtn.disabled = false;
  }
}
updateSessionTimer();
setInterval(updateSessionTimer, 1000);

// Return button: navigate to study-workflow page once enabled
returnBtn.addEventListener('click', () => {
  const returnUrl = `https://ai-chatbot-fv7e.onrender.com/study-workflow.html?participantID=${encodeURIComponent(participantID)}&systemID=${encodeURIComponent(systemID)}&sessionID=${encodeURIComponent(sessionID)}`;
  window.location.href = returnUrl;
});

// Persisted state keys
const TOPICS_KEY   = `cai_topics_${participantID}`;
const FORMULAS_KEY = `cai_formulas_${participantID}`;
const LEFT_W_KEY   = 'cai_left_w';
const RIGHT_W_KEY  = 'cai_right_w';

(function restoreColumnWidths() {
  const lw = localStorage.getItem(LEFT_W_KEY);
  const rw = localStorage.getItem(RIGHT_W_KEY);
  if (lw) document.documentElement.style.setProperty('--left-w', lw);
  if (rw) document.documentElement.style.setProperty('--right-w', rw);
})();

function initResizer(resizerId, side) {
  const resizer = document.getElementById(resizerId);
  const root    = document.documentElement;
  const MIN = 160, MAX = 600;

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX   = e.clientX;
    const startPx  = parseInt(getComputedStyle(root).getPropertyValue(
      side === 'left' ? '--left-w' : '--right-w'
    ));

    resizer.classList.add('is-dragging');
    document.body.style.cursor     = 'col-resize';
    document.body.style.userSelect = 'none';

    function onMove(e) {
      const delta = side === 'left' ? e.clientX - startX : startX - e.clientX;
      const newW  = Math.max(MIN, Math.min(MAX, startPx + delta)) + 'px';
      const prop  = side === 'left' ? '--left-w' : '--right-w';
      const key   = side === 'left' ? LEFT_W_KEY : RIGHT_W_KEY;
      root.style.setProperty(prop, newW);
      localStorage.setItem(key, newW);
    }

    function onUp() {
      resizer.classList.remove('is-dragging');
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  // Double-click to reset to default
  resizer.addEventListener('dblclick', () => {
    const defaultW = side === 'left' ? '260px' : '260px';
    const prop     = side === 'left' ? '--left-w' : '--right-w';
    const key      = side === 'left' ? LEFT_W_KEY : RIGHT_W_KEY;
    root.style.setProperty(prop, defaultW);
    localStorage.setItem(key, defaultW);
  });
}

initResizer('resizer-left',  'left');
initResizer('resizer-right', 'right');

let topics = JSON.parse(localStorage.getItem(TOPICS_KEY) || '[]');
// Ensure legacy topics have the new `problemsSolved` field
topics = topics.map(t => ({ id: t.id || `t${Date.now()}`, name: t.name, status: t.status || 'not_started', problemsSolved: typeof t.problemsSolved === 'number' ? t.problemsSolved : 0 }));
let formulas = JSON.parse(localStorage.getItem(FORMULAS_KEY) || '[]');
let conversationHistory = [];
let currentTopic = null;
let inQuizMode = false;
let msgCounter = 0;
let currentController = null;
let currentProblem = null;
let currentStepIndex = 0;
let practiceProblemCounter = 0;
let lastPracticeProblem = null;

const messagesEl     = document.getElementById('messages');
const userInput      = document.getElementById('user-input');
const sendBtn        = document.getElementById('send-btn');
const typingEl       = document.getElementById('typing-indicator');
const topbarTopic    = document.getElementById('topbar-topic');
const topicList      = document.getElementById('topic-list');
const overallBar     = document.getElementById('overall-bar');
const progressSummary = document.getElementById('progress-summary');
const formulaPills   = document.getElementById('formula-pills');
const notesList      = document.getElementById('notes-list');

const noteComposer          = document.getElementById('note-composer');
const noteComposerHeader    = document.getElementById('note-composer-header');
const noteComposerBody      = document.getElementById('note-composer-body');
const noteComposerFooter    = document.getElementById('note-composer-footer');
const noteComposerTitle     = document.getElementById('note-composer-title');
const noteComposerTitleInput = document.getElementById('note-composer-title-input');
const noteComposerContent   = document.getElementById('note-composer-content');
const noteComposerIsFormula = document.getElementById('note-composer-is-formula');

let notesData = [];
let editingNoteId = null;
let composerMinimized = false;
let composerExpanded = false;

userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 140) + 'px';
});

userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    logEvent('keypress', 'Enter Key');
    handleSend();
  }
});

const mathPanel      = document.getElementById('math-panel');
const mathField      = document.getElementById('math-field');
const mathToggleBtn  = document.getElementById('math-toggle-btn');
const mathToggleIcon = document.getElementById('math-toggle-icon');
const mathInsertBtn  = document.getElementById('math-insert-btn');

// Inject CSS into the shadow DOM to hide the toggle + menu buttons
function hideMathLiveToolbar() {
  if (!mathField.shadowRoot) return;
  if (mathField.shadowRoot.querySelector('#no-vkb')) return;
  const s = document.createElement('style');
  s.id = 'no-vkb';
  s.textContent = `
    .ML__virtual-keyboard-toggle,
    [part="virtual-keyboard-toggle"],
    [part="menu-toggle"],
    .ML__menu-toggle,
    .ML__toolbar { display: none !important; }
  `;
  mathField.shadowRoot.appendChild(s);
}

customElements.whenDefined('math-field').then(() => {
  mathField.mathVirtualKeyboardPolicy = 'off';
  requestAnimationFrame(hideMathLiveToolbar);
  mathField.addEventListener('focus', hideMathLiveToolbar);
});

// If the keyboard somehow opens, force-close it immediately
mathField.addEventListener('focusin', () => {
  if (window.mathVirtualKeyboard) window.mathVirtualKeyboard.visible = false;
});
mathField.addEventListener('virtual-keyboard-toggle', () => {
  if (window.mathVirtualKeyboard) window.mathVirtualKeyboard.visible = false;
});
window.addEventListener('virtual-keyboard-toggle', () => {
  if (window.mathVirtualKeyboard) window.mathVirtualKeyboard.visible = false;
});

// Panel is open by default; chevron points up (minimise). When closed, points down (restore).
const CHEVRON_UP   = `<polyline points="18 15 12 9 6 15"/>`;
const CHEVRON_DOWN = `<polyline points="6 9 12 15 18 9"/>`;

function showMathPanel(show) {
  mathPanel.style.display = show ? 'block' : 'none';
  mathToggleIcon.innerHTML = show ? CHEVRON_UP : CHEVRON_DOWN;
  mathToggleBtn.title = show ? 'Minimise math panel' : 'Show math panel';
  if (show) mathField.focus();
}

mathToggleBtn.addEventListener('click', () => {
  logEvent('click', 'Math Panel Toggle');
  showMathPanel(mathPanel.style.display === 'none');
});

const CLOSE_SVG = `<svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="1" y1="1" x2="7" y2="7"/><line x1="7" y1="1" x2="1" y2="7"/></svg>`;

// Strip an unpaired trailing backslash. MathJax otherwise renders it as a literal
// "\" glyph in the result band or chip — even paired backslashes (\\) pass through
// fine, so we only trim when the count is odd.
function sanitizeLatex(s) {
  if (!s) return '';
  s = String(s);
  const m = s.match(/\\+$/);
  if (m && m[0].length % 2 === 1) s = s.slice(0, -1);
  return s;
}

function addMathChip(latex) {
  latex = sanitizeLatex(latex);
  if (!latex) return;
  const chipsEl = document.getElementById('math-chips');
  chipsEl.style.display = 'flex';
  const chip = document.createElement('span');
  chip.className = 'math-chip';
  chip.dataset.latex = latex;
  chip.innerHTML = `<span class="math-chip__preview">\\(${latex}\\)</span><button class="math-chip__remove" type="button" title="Remove">${CLOSE_SVG}</button>`;
  chip.querySelector('.math-chip__remove').addEventListener('click', () => {
    chip.remove();
    if (chipsEl.children.length === 0) chipsEl.style.display = 'none';
  });
  chipsEl.appendChild(chip);
  MathJax.typesetPromise([chip]);
}

mathInsertBtn.addEventListener('click', () => {
  logEvent('click', 'Math Insert');
  const latex = lastResultLatex || mathField.value;
  if (!latex) return;
  addMathChip(latex);
  mathField.value = '';
  mathResultEl.style.display = 'none';
  lastResultLatex = '';
  mathField.focus();
});

document.getElementById('math-clear-btn').addEventListener('click', () => {
  logEvent('click', 'Math Clear');
  mathField.value = '';
  mathResultEl.style.display = 'none';
  lastResultLatex = '';
  mathField.focus();
});

// One-shot guard: suppress the next `input`-triggered clear (used after Calculate runs,
// since MathLive may fire an input event after our keydown handler returns).
let suppressInputClear = false;

// Enter triggers Calculate, but only when the math-field is focused — otherwise it would
// conflict with the chat textarea's Enter-to-send.
mathField.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    logEvent('keypress', 'Math Field Return');
    suppressInputClear = true;
    document.getElementById('math-calc-btn').click();
  }
});

// Option/Alt + C and Option/Alt + I are global shortcuts (work from anywhere in the UI).
// We listen at the window level on capture so MathLive's internal handler doesn't see
// the keystroke. We still belt-and-suspender with a setTimeout sweep in case Mac OS
// inserts a dead-key character (ˆ / ç) that bypasses preventDefault.
function sweepStrayDeadKey() {
  const v = mathField.value;
  if (v === 'ˆ' || v === 'ç' || v === '˙' || v === 'ø') mathField.value = '';
}
window.addEventListener('keydown', (e) => {
  if (!e.altKey) return;
  if (e.code === 'KeyC') {
    e.preventDefault();
    e.stopImmediatePropagation();
    logEvent('keypress', 'Math Option+C');
    document.getElementById('math-clear-btn').click();
    setTimeout(sweepStrayDeadKey, 0);
  } else if (e.code === 'KeyI') {
    e.preventDefault();
    e.stopImmediatePropagation();
    logEvent('keypress', 'Math Option+I');
    mathInsertBtn.click();
    setTimeout(sweepStrayDeadKey, 0);
  }
}, { capture: true });

// Clicking anywhere in the math panel (background, padding, label area) focuses the
// math-field so the user can start typing immediately. Buttons and chips are excluded.
mathPanel.addEventListener('mousedown', (e) => {
  if (e.target.closest('button, .math-chip, .math-symbols')) return;
  if (e.target === mathField) return;
  mathField.focus();
});

function extractBraces(str, start) {
  if (str[start] !== '{') return { content: '', end: start };
  let depth = 0, i = start, content = '';
  while (i < str.length) {
    const ch = str[i];
    if (ch === '{') {
      if (depth > 0) content += ch;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return { content, end: i };
      content += ch;
    } else if (depth > 0) {
      content += ch;
    }
    i++;
  }
  return { content, end: i };
}

// Extract a single argument after a LaTeX control word: braced group, a single backslash
// command, or a single character. Whitespace following a control word is a separator, not
// part of the argument. Returns { content, end } where `end` is the index of the last
// consumed character.
function extractArg(str, start) {
  let i = start;
  while (i < str.length && /\s/.test(str[i])) i++;
  if (i >= str.length) return { content: '', end: i - 1 };
  if (str[i] === '{') return extractBraces(str, i);
  if (str[i] === '\\') {
    let j = i + 1;
    while (j < str.length && /[a-zA-Z]/.test(str[j])) j++;
    return { content: str.slice(i, j), end: j - 1 };
  }
  return { content: str[i], end: i };
}

function latexToMathJs(latex) {
  let result = '', i = 0;
  const s = latex.trim();
  while (i < s.length) {
    if (s[i] === '\\') {
      let j = i + 1;
      while (j < s.length && /[a-zA-Z]/.test(s[j])) j++;
      const cmd = s.slice(i + 1, j);

      if (cmd === '') { i = j; continue; }

      if (cmd === 'frac') {
        const num = extractArg(s, j); j = num.end + 1;
        const den = extractArg(s, j); j = den.end + 1;
        const numMath = latexToMathJs(num.content);
        const denMath = latexToMathJs(den.content);
        if (!numMath.trim() || !denMath.trim()) throw new Error('Fill in placeholder');
        result += `((${numMath})/(${denMath}))`;
        i = j;
      } else if (cmd === 'sqrt') {
        if (s[j] === '[') {
          const nEnd = s.indexOf(']', j);
          const n = s.slice(j + 1, nEnd); j = nEnd + 1;
          const arg = extractArg(s, j); j = arg.end + 1;
          const argMath = latexToMathJs(arg.content);
          const nMath   = latexToMathJs(n);
          if (!argMath.trim() || !nMath.trim()) throw new Error('Fill in placeholder');
          result += `nthRoot(${argMath},${nMath})`; i = j;
        } else {
          const arg = extractArg(s, j); j = arg.end + 1;
          const argMath = latexToMathJs(arg.content);
          if (!argMath.trim()) throw new Error('Fill in placeholder');
          result += `sqrt(${argMath})`; i = j;
        }
      } else if (cmd === 'placeholder') {
        if (s[j] === '[') { const close = s.indexOf(']', j); j = close === -1 ? j + 1 : close + 1; }
        if (s[j] === '{') { const arg = extractBraces(s, j); j = arg.end + 1; }
        i = j;
      } else if (cmd === 'times' || cmd === 'cdot') { result += '*'; i = j; }
      else if (cmd === 'div') { result += '/';  i = j; }
      else if (cmd === 'left' || cmd === 'right') { i = j; }
      else { throw new Error('Unsupported: \\' + cmd); }
    } else if (s[i] === '^') {
      if (!result.trim()) throw new Error('Fill in placeholder');
      if (s[i + 1] === '{') {
        const arg = extractBraces(s, i + 1);
        const argMath = latexToMathJs(arg.content);
        if (!argMath.trim()) throw new Error('Fill in placeholder');
        result += `^(${argMath})`; i = arg.end + 1;
      } else { result += '^'; i++; }
    } else if (s[i] === '_') {
      if (s[i + 1] === '{') {
        const arg = extractBraces(s, i + 1);
        i = arg.end + 1;
      } else if (i + 1 < s.length) {
        i += 2;
      } else {
        i += 1;
      }
    } else if (s[i] === '{') {
      const arg = extractBraces(s, i);
      result += `(${latexToMathJs(arg.content)})`; i = arg.end + 1;
    } else {
      result += s[i]; i++;
    }
  }
  return result;
}

const mathResultEl      = document.getElementById('math-result');
const mathResultValue   = document.getElementById('math-result-value');
let lastResultLatex = '';

document.getElementById('math-calc-btn').addEventListener('click', () => {
  logEvent('click', 'Math Calculate');
  const latex = mathField.value;
  if (!latex) return;
  try {
    const expr = latexToMathJs(latex);
    if (!expr.trim()) throw new Error('Fill in placeholder');

    const raw = math.evaluate(expr);
    const formatted = math.format(raw, { precision: 10 });

    let latexOut;
    try {
      latexOut = (raw && typeof raw.toTex === 'function')
        ? raw.toTex({ precision: 10 })
        : math.parse(formatted).toTex({ parenthesis: 'auto' });
    } catch (_) {
      latexOut = String(formatted);
    }
    latexOut = sanitizeLatex(latexOut);

    lastResultLatex = latexOut;
    mathResultValue.innerHTML = `\\(${latexOut}\\)`;
    mathResultEl.style.display = 'flex';
    MathJax.typesetPromise([mathResultValue]);
  } catch (e) {
    mathResultValue.textContent = (e && e.message) ? e.message : 'Cannot evaluate';
    mathResultEl.style.display = 'flex';
    lastResultLatex = '';
  }
});

// Clear result when field changes (unless a Calculate just ran).
mathField.addEventListener('input', () => {
  if (suppressInputClear) {
    suppressInputClear = false;
    return;
  }
  mathResultEl.style.display = 'none';
  lastResultLatex = '';
});

// Find the last "atom" at the end of a LaTeX string: a balanced (...) group
// (with any \left / \right wrappers MathLive serialised), a balanced multi-arg
// \cmd{...}{...} block, a base value carrying a ^{...} / _{...} script, or a
// digit/letter run. Returns the substring, or '' if the string ends with
// whitespace or an operator.
//
// The walk has to be tight: any time `before = value.slice(0, value.length - atom.length)`
// produces malformed LaTeX (orphaned \left, half a \placeholder, an unmatched
// {), MathLive re-renders the literal command name as text and the user sees raw
// LaTeX. So we must always return an atom whose removal leaves valid LaTeX.
function findLastAtom(str) {
  function start(end) {
    while (end > 0 && /\s/.test(str[end - 1])) end--;
    if (end === 0) return 0;
    const last = str[end - 1];

    if (last === ')') {
      let depth = 1, k = end - 1;
      while (k > 0 && depth > 0) {
        k--;
        if (str[k] === ')') depth++;
        else if (str[k] === '(') depth--;
      }
      // Pull in a leading \left (with optional whitespace before the matched `(`)
      // so the atom owns its \right counterpart inside the slice.
      let p = k;
      while (p > 0 && /\s/.test(str[p - 1])) p--;
      if (p >= 5 && str.slice(p - 5, p) === '\\left') return p - 5;
      return k;
    }

    if (last === '}' || last === ']') {
      const closing = last;
      const opening = closing === '}' ? '{' : '[';
      let depth = 1, k = end - 1;
      while (k > 0 && depth > 0) {
        k--;
        if (str[k] === closing) depth++;
        else if (str[k] === opening) depth--;
      }
      // Walk back through any preceding {...} / [...] argument groups, so
      // multi-arg commands like \frac{a}{b} and \sqrt[n]{x} are treated as one
      // atom rather than just their final brace group.
      while (k > 0) {
        let q = k;
        while (q > 0 && /\s/.test(str[q - 1])) q--;
        if (q === 0) break;
        const c2 = str[q - 1];
        if (c2 !== '}' && c2 !== ']') break;
        const o2 = c2 === '}' ? '{' : '[';
        let d2 = 1, kk = q - 1;
        while (kk > 0 && d2 > 0) {
          kk--;
          if (str[kk] === c2) d2++;
          else if (str[kk] === o2) d2--;
        }
        k = kk;
      }
      // Pull in any leading \command letters (so \sqrt{2} becomes one atom).
      let cmdStart = k;
      while (cmdStart > 0 && /[a-zA-Z]/.test(str[cmdStart - 1])) cmdStart--;
      if (cmdStart > 0 && str[cmdStart - 1] === '\\') return cmdStart - 1;
      // If the brace group is a superscript / subscript, recurse so the base
      // value comes along (5^{2} → atom is 5^{2}, not just {2}). Without this,
      // before = "5^{" would be unbalanced and MathLive renders it as text.
      if (k > 0 && (str[k - 1] === '^' || str[k - 1] === '_')) {
        return start(k - 1);
      }
      return k;
    }

    if (/[0-9a-zA-Z.]/.test(last)) {
      let k = end - 1;
      while (k > 0 && /[0-9a-zA-Z.]/.test(str[k - 1])) k--;
      // If the run is preceded by `\`, it's a control word (\cdot, \div, \times,
      // …). Removing it would leave `before` ending with an orphan `\`, which
      // MathLive then merges with whatever insert lands next or renders as raw
      // text. Treat the control word as an operator — no atom.
      if (k > 0 && str[k - 1] === '\\') return end;
      // If the run sits on top of a script marker (5^2, x_1 with no braces),
      // recurse so the base value travels with it.
      if (k > 0 && (str[k - 1] === '^' || str[k - 1] === '_')) {
        return start(k - 1);
      }
      return k;
    }

    return end; // operator / unrecognised — no atom
  }

  if (!str) return '';
  let i = str.length;
  while (i > 0 && /\s/.test(str[i - 1])) i--;
  if (i === 0) return '';
  const k = start(i);
  if (k === i) return '';
  return str.slice(k, i);
}

// True if there's a real value (number / identifier / closing-grouped expression) on
// the left of the cursor. Heuristic: cursor sits at the end and the value's tail is
// not whitespace or an operator.
function hasValueOnLeft() {
  return findLastAtom(mathField.value) !== '';
}

// Insert a button payload. If the payload has a `#0` slot:
//   - With a value on the left, splice that value into the `#0` position.
//   - With nothing usable on the left, substitute `#0` with `#?` so MathLive renders
//     a real placeholder box at that position with the cursor in it.
function symButtonInsert(payload) {
  if (!payload) return;
  if (!payload.includes('#0')) {
    mathField.insert(payload);
    return;
  }
  const value = mathField.value;
  const atom = findLastAtom(value);
  if (atom) {
    const before = value.slice(0, value.length - atom.length);
    mathField.value = before;
    mathField.executeCommand('moveToMathFieldEnd');
    mathField.insert(payload.replace(/#0/g, atom));
  } else {
    mathField.insert(payload.replace(/#0/g, '#?'));
  }
}

document.querySelectorAll('.sym-btn').forEach(btn => {
  if (btn.id === 'math-negate-btn') return;
  btn.addEventListener('mousedown', e => {
    e.preventDefault();
    logEvent('click', 'Math Symbol: ' + btn.textContent.trim());
    if (btn.dataset.cmd) {
      mathField.executeCommand(btn.dataset.cmd);
    } else {
      symButtonInsert(btn.dataset.latex);
    }
    mathField.focus();
  });
});

// Unary minus: place `-` immediately in front of the value to the left. If nothing
// useful is to the left, just insert a `-` at the cursor.
document.getElementById('math-negate-btn').addEventListener('mousedown', (e) => {
  e.preventDefault();
  logEvent('click', 'Math Symbol: (-)');
  const value = mathField.value;
  const atom = findLastAtom(value);
  if (atom) {
    const before = value.slice(0, value.length - atom.length);
    mathField.value = before + '-' + atom;
    mathField.executeCommand('moveToMathFieldEnd');
  } else {
    mathField.insert('-');
  }
  mathField.focus();
});

sendBtn.addEventListener('click', () => {
  if (currentController) {
    currentController.abort();
  } else {
    handleSend();
  }
});

async function handleSend() {
  const chipsEl = document.getElementById('math-chips');
  const mathParts = [...chipsEl.querySelectorAll('.math-chip')].map(c => `$${c.dataset.latex}$`).join(' ');
  const textPart = userInput.value.trim();
  const message = [textPart, mathParts].filter(Boolean).join(' ');
  if (!message) return;

  chipsEl.innerHTML = '';
  chipsEl.style.display = 'none';
  appendUserMessage(message);
  userInput.value = '';
  userInput.style.height = 'auto';
  showTyping(true);

  const mode = inQuizMode ? 'quiz_eval' : 'normal';
  if (inQuizMode) inQuizMode = false;

  const controller = new AbortController();
  currentController = controller;
  sendBtn.classList.add('is-generating');
  sendBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';

  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        history: conversationHistory.slice(-12),
        input: message,
        participantID,
        systemID,
        sessionID,
        currentTopic,
        mode,
        retrievalMethod: 'semantic',
        problemContext: currentProblem ? {
          problem: currentProblem.problem,
          stepIndex: currentStepIndex,
          stepInstruction: currentProblem.steps[currentStepIndex] ? currentProblem.steps[currentStepIndex].instruction : null
        } : null
      }),
      signal: controller.signal
    });
    const data = await res.json();
    showTyping(false);
    appendBotMessage(data.response);
    conversationHistory.push({ role: 'user', content: message });
    conversationHistory.push({ role: 'assistant', content: data.response });

    if (mode === 'quiz_eval' && currentTopic) {
      const t = topics.find(t => t.name === currentTopic);
      if (t && t.status !== 'completed') {
        updateTopicStatus(t.id, 'completed');
      }
    }
  } catch (err) {
    showTyping(false);
    if (err.name !== 'AbortError') {
      appendBotMessage('Sorry, something went wrong. Please try again.');
      console.error(err);
    }
  } finally {
    currentController = null;
    sendBtn.classList.remove('is-generating');
    sendBtn.textContent = 'Send';
  }
}

document.getElementById('quiz-btn').addEventListener('click', async () => {
  if (!currentTopic) {
    if (!topics || topics.length === 0) {
      appendBotMessage('Please add at least one topic in the left panel, then I can quiz you on it.');
    } else {
      appendBotMessage('Please select a topic from the left panel first, then I can quiz you on it.');
    }
    return;
  }
  showTyping(true);
  try {
    const res = await fetch('/quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: currentTopic, participantID, history: conversationHistory.slice(-6) })
    });
    const quiz = await res.json();
    showTyping(false);
    appendQuizCard(quiz);
    inQuizMode = true;
    logEvent('click', 'Quick Check');
  } catch (err) {
    showTyping(false);
    appendBotMessage('Could not generate a quiz question. Please try again.');
  }
});

document.getElementById('practice-btn').addEventListener('click', async () => {
  if (!currentTopic) {
    if (!topics || topics.length === 0) {
      appendBotMessage('Please add at least one topic in the left panel, then I can generate a practice problem for you.');
    } else {
      appendBotMessage('Please select a topic from the left panel first, then I can generate a practice problem for you.');
    }
    return;
  }
  showTyping(true);
  try {
    const res = await fetch('/practice-problem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: currentTopic,
        participantID,
        history: conversationHistory.slice(-6),
        previousProblem: lastPracticeProblem ? {
          problem: lastPracticeProblem.problem,
          steps: lastPracticeProblem.steps
        } : null
      })
    });
    const problem = await res.json();
    showTyping(false);
    problem.__practiceId = `practice-${Date.now()}-${++practiceProblemCounter}`;
    currentProblem = problem;
    lastPracticeProblem = problem;
    currentStepIndex = 0;
    appendProblemStep(problem, 0, problem.__practiceId);
    logEvent('click', 'Practice Problem');
  } catch (err) {
    showTyping(false);
    appendBotMessage('Could not generate a practice problem. Please try again.');
  }
});


function openAddTopicModal() {
  document.getElementById('add-topic-modal').style.display = 'flex';
  document.getElementById('new-topic-input').focus();
}

topicList.addEventListener('click', (e) => {
  const addBtn = e.target.closest('[data-action="add-topic"]');
  if (!addBtn) return;
  openAddTopicModal();
});

document.getElementById('modal-cancel-btn').addEventListener('click', () => {
  document.getElementById('add-topic-modal').style.display = 'none';
});

document.getElementById('modal-confirm-btn').addEventListener('click', () => {
    const name = document.getElementById('new-topic-input').value.trim();
  if (!name) return;
  topics.push({ id: `t${Date.now()}`, name, status: 'not_started', problemsSolved: 0 });
  saveTopics();
  renderTopics();
  document.getElementById('new-topic-input').value = '';
  document.getElementById('add-topic-modal').style.display = 'none';
});

function openCreateNoteModal() {
  openNoteComposer();
}

notesList.addEventListener('click', (e) => {
  const createBtn = e.target.closest('[data-action="create-note"]');
  if (!createBtn) return;
  openCreateNoteModal();
});

function openNoteComposer(note = null) {
  editingNoteId = note?._id || null;
  setComposerExpanded(false);
  setComposerMinimized(false);
  noteComposer.setAttribute('aria-hidden', 'false');
  noteComposer.style.display = 'flex';

  noteComposerTitle.textContent = note ? 'Edit Note' : 'Create Note';
  noteComposerTitleInput.value = note?.title || '';
  noteComposerContent.value = note?.content || '';
  noteComposerIsFormula.checked = !!note?.isFormula;
  noteComposerContent.focus();
}

function closeNoteComposer() {
  noteComposer.style.display = 'none';
  noteComposer.setAttribute('aria-hidden', 'true');
  editingNoteId = null;
  setComposerExpanded(false);
  setComposerMinimized(false);
  noteComposerTitleInput.value = '';
  noteComposerContent.value = '';
  noteComposerIsFormula.checked = false;
}

function setComposerMinimized(minimized) {
  composerMinimized = minimized;
  noteComposer.classList.toggle('note-composer--minimized', minimized);
  document.getElementById('note-composer-min-btn').textContent = minimized ? '▢' : '_';
  document.getElementById('note-composer-min-btn').title = minimized ? 'Restore' : 'Minimise';
}

function setComposerExpanded(expanded) {
  composerExpanded = expanded;
  noteComposer.classList.toggle('note-composer--expanded', expanded);
  document.getElementById('note-composer-expand-btn').textContent = expanded ? '❐' : '□';
  document.getElementById('note-composer-expand-btn').title = expanded ? 'Exit expanded view' : 'Expand';
}

document.getElementById('note-composer-close-btn').addEventListener('click', closeNoteComposer);
document.getElementById('note-composer-cancel-btn').addEventListener('click', closeNoteComposer);

document.getElementById('note-composer-min-btn').addEventListener('click', () => {
  setComposerMinimized(!composerMinimized);
});

document.getElementById('note-composer-expand-btn').addEventListener('click', () => {
  setComposerExpanded(!composerExpanded);
});

noteComposerHeader.addEventListener('dblclick', () => {
  if (composerMinimized) {
    setComposerMinimized(false);
    return;
  }
  setComposerExpanded(!composerExpanded);
});

document.getElementById('note-composer-save-btn').addEventListener('click', async () => {
  const content = noteComposerContent.value.trim();
  if (!content) return;

  const title = noteComposerTitleInput.value.trim() || 'Untitled';
  const isFormula = noteComposerIsFormula.checked;

  if (editingNoteId) {
    await updateNote(editingNoteId, { title, content, isFormula });
  } else {
    await saveNote(content, isFormula, null, title);
  }

  closeNoteComposer();
});

function renderTopics() {
  topicList.innerHTML = '';

  if (topics.length === 0) {
    topicList.innerHTML = '<p class="empty-hint">No topics yet.<br>Upload a document or add manually.</p>';
    overallBar.style.width = '0%';
    progressSummary.textContent = '0 / 0 topics';
    appendAddTopicRow();
    return;
  }

  const completed = topics.filter(t => t.status === 'completed').length;
  const pct = Math.round((completed / topics.length) * 100);
  overallBar.style.width = pct + '%';
  progressSummary.textContent = `${completed} / ${topics.length} topics`;

  const hint = document.createElement('p');
  hint.className = 'topic-hint';
  hint.textContent = 'Click a topic to start a guided chat.';
  topicList.appendChild(hint);

  topics.forEach((topic, idx) => {
    const item = document.createElement('div');
    const isActive = currentTopic === topic.name;
    item.className = `topic-item topic-item--${topic.status}${isActive ? ' topic-item--active' : ''}`;
    item.dataset.id = topic.id;
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', `Study topic: ${topic.name}`);
    item.title = 'Click to start this topic';

    // Play icon (visual indicator)
    const bullet = document.createElement('span');
    bullet.className = 'topic-bullet';
    bullet.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
    bullet.title = 'Start this topic';

    // Label wrapper for text
    const labelWrapper = document.createElement('div');
    labelWrapper.className = 'topic-label-wrapper';

    // Topic name label
    const label = document.createElement('span');
    label.className = 'topic-label';
    label.textContent = topic.name;

    labelWrapper.appendChild(label);

    // Checkbox (right side)
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'topic-checkbox';
    check.checked = topic.status === 'completed';
    check.title = 'Mark topic completed';
    check.addEventListener('click', (ev) => {
      ev.stopPropagation();
      updateTopicStatus(topic.id, check.checked ? 'completed' : 'not_started');
    });

    // Delete button (always visible)
    const del = document.createElement('button');
    del.className = 'topic-del';
    del.type = 'button';
    del.title = 'Remove topic';
    del.setAttribute('aria-label', 'Remove topic');
    del.innerHTML = TRASH_SVG;
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      topics.splice(idx, 1);
      saveTopics();
      renderTopics();
    });

    // Top row: bullet + label wrapper + checkbox + delete
    const topRow = document.createElement('div');
    topRow.className = 'topic-top-row';
    topRow.appendChild(bullet);
    topRow.appendChild(labelWrapper);
    topRow.appendChild(check);
    topRow.appendChild(del);

    // Problems solved row
    const problemsRow = document.createElement('div');
    problemsRow.className = 'topic-problems-row';
    const problemsLabel = document.createElement('span');
    problemsLabel.className = 'topic-problems-label';
    problemsLabel.textContent = 'Problems solved:';
    const problemsCount = document.createElement('span');
    problemsCount.className = 'topic-problems-count';
    problemsCount.textContent = topic.problemsSolved || 0;
    problemsRow.appendChild(problemsLabel);
    problemsRow.appendChild(problemsCount);

    // Practice problem button row
    const practiceRow = document.createElement('div');
    practiceRow.className = 'topic-practice-row';
    const practiceBtn = document.createElement('button');
    practiceBtn.type = 'button';
    practiceBtn.className = 'btn-practice-topic';
    practiceBtn.textContent = 'Practice Problem';
    practiceBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      // Set current topic
      currentTopic = topic.name;
      topbarTopic.textContent = topic.name;

      // Show typing indicator
      showTyping(true);

      // Generate practice problem
      try {
        const res = await fetch('/practice-problem', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            topic: topic.name,
            participantID,
            history: conversationHistory.slice(-6),
            previousProblem: lastPracticeProblem ? {
              problem: lastPracticeProblem.problem,
              steps: lastPracticeProblem.steps
            } : null
          })
        });
        const problem = await res.json();
        showTyping(false);
        problem.__practiceId = `practice-${Date.now()}-${++practiceProblemCounter}`;
        currentProblem = problem;
        lastPracticeProblem = problem;
        currentStepIndex = 0;
        appendProblemStep(problem, 0, problem.__practiceId);
        logEvent('click', 'Practice Problem');
      } catch (err) {
        showTyping(false);
        appendBotMessage('Could not generate a practice problem. Please try again.');
      }
    });
    practiceRow.appendChild(practiceBtn);

    item.appendChild(topRow);
    item.appendChild(problemsRow);
    item.appendChild(practiceRow);

    item.addEventListener('click', () => selectTopic(topic));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectTopic(topic);
      }
    });
    topicList.appendChild(item);
  });

  appendAddTopicRow();

  // Update topbar
  if (currentTopic) topbarTopic.textContent = currentTopic;
}

function appendAddTopicRow() {
  const addRow = document.createElement('button');
  addRow.type = 'button';
  addRow.className = 'topic-item topic-item--add';
  addRow.dataset.action = 'add-topic';
  addRow.textContent = 'Add topic';
  topicList.appendChild(addRow);
}

function selectTopic(topic) {
  currentTopic = topic.name;
  topbarTopic.textContent = topic.name;

  if (topic.status === 'not_started') {
    updateTopicStatus(topic.id, 'in_progress');
  }

  // Send a chat message to start covering this topic
  const msg = `Let's study: ${topic.name}`;
  appendUserMessage(msg);
  conversationHistory.push({ role: 'user', content: msg });
  showTyping(true);

  fetch('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      history: conversationHistory.slice(-8),
      input: msg,
      participantID,
      systemID,
      sessionID,
      currentTopic: topic.name,
      mode: 'normal',
      retrievalMethod: 'semantic'
    })
  })
    .then(r => r.json())
    .then(data => {
      showTyping(false);
      appendBotMessage(data.response);
      conversationHistory.push({ role: 'assistant', content: data.response });
    })
    .catch(() => { showTyping(false); });

  logEvent('click', `Topic: ${topic.name}`);
}

function updateTopicStatus(id, status) {
  const t = topics.find(t => t.id === id);
  if (t) {
    t.status = status;
    saveTopics();
    renderTopics();
  }
}

function incrementProblemsSolvedByName(name) {
  const t = topics.find(t => t.name === name);
  if (t) {
    t.problemsSolved = (t.problemsSolved || 0) + 1;
    saveTopics();
    renderTopics();
  }
}

function saveTopics() {
  localStorage.setItem(TOPICS_KEY, JSON.stringify(topics));
}

async function saveNote(content, isFormula = false, messageRef = null, title = 'Untitled') {
  try {
    const res = await fetch('/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        participantID,
        systemID,
        sessionID,
        title,
        content,
        topic: currentTopic,
        isFormula,
        messageRef,
        isHighlight: !!messageRef
      })
    });
    const note = await res.json();
    notesData.push(note);
    renderNotesUI();
  } catch (err) {
    console.error('Failed to save note', err);
  }
}

const LINK_SVG = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
const TRASH_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formulaToInlineMath(content) {
  const trimmed = String(content || '').trim();
  if (!trimmed) return '';

  const bare = trimmed
    .replace(/^\$\$([\s\S]+)\$\$$/, '$1')
    .replace(/^\$([\s\S]+)\$$/, '$1')
    .replace(/^\\\(([\s\S]+)\\\)$/, '$1')
    .replace(/^\\\[([\s\S]+)\\\]$/, '$1')
    .trim();

  return `\\(${escapeHtml(bare)}\\)`;
}

function appendNoteItem(note) {
  const item = document.createElement('div');
  item.className = `note-item${note.isFormula ? ' note-item--formula' : ''}${note.isHighlight ? ' note-item--highlight' : ''}`;
  item.dataset.id = note._id;
  item.title = 'Double-click to edit note';

  // Header row: title + delete button
  const header = document.createElement('div');
  header.className = 'note-header';

  const title = document.createElement('div');
  title.className = 'note-title';
  title.textContent = note.title || 'Untitled';
  title.title = 'Double-click to edit title';
  header.appendChild(title);

  const del = document.createElement('button');
  del.className = 'note-del';
  del.type = 'button';
  del.title = 'Delete note';
  del.setAttribute('aria-label', 'Delete note');
  del.innerHTML = TRASH_SVG;
  del.addEventListener('click', () => deleteNote(note._id, item));
  header.appendChild(del);
  item.appendChild(header);

  // Content
  const text = document.createElement('p');
  text.className = 'note-content';
  if (note.isFormula) {
    text.innerHTML = formulaToInlineMath(note.content);
    MathJax.typesetPromise([text]);
  } else {
    text.textContent = note.content;
  }
  text.title = 'Double-click to edit note content';
  item.appendChild(text);

  item.addEventListener('dblclick', (e) => {
    if (e.target.closest('.note-del, .note-msglink')) return;
    openNoteComposer(note);
  });

  // Back-link to source message
  if (note.messageRef) {
    const target = document.getElementById(note.messageRef);
    const link = document.createElement('button');
    if (target) {
      link.className = 'note-msglink';
      link.innerHTML = `${LINK_SVG} View in chat`;
      link.addEventListener('click', () => {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('message--flash');
        setTimeout(() => target.classList.remove('message--flash'), 1800);
      });
    } else {
      link.className = 'note-msglink note-msglink--dead';
      link.innerHTML = `${LINK_SVG} View in chat`;
      link.title = 'Message not in current session';
    }
    item.appendChild(link);
  }

  notesList.appendChild(item);
}

async function deleteNote(id, el) {
  try {
    await fetch(`/notes/${id}`, { method: 'DELETE' });
    notesData = notesData.filter(n => n._id !== id);
    renderNotesUI();
  } catch (err) {
    console.error(err);
  }
}

async function updateNote(id, payload) {
  try {
    const res = await fetch(`/notes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) return null;
    const updated = await res.json();
    notesData = notesData.map(n => n._id === id ? updated : n);
    renderNotesUI();
    return updated;
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function loadNotes() {
  try {
    const res = await fetch(`/notes/${participantID}`);
    notesData = await res.json();
    renderNotesUI();
  } catch (err) { console.error(err); }
}

function renderNotesUI() {
  notesList.innerHTML = '';
  if (notesData.length === 0) {
    notesList.innerHTML = '<p class="empty-hint">Highlight text in a chat message and click "Save", or create your own note.</p>';
    appendCreateNoteRow();
    return;
  }

  notesData.forEach(n => appendNoteItem(n));
  appendCreateNoteRow();
  notesList.scrollTop = notesList.scrollHeight;
}

function appendCreateNoteRow() {
  const addRow = document.createElement('button');
  addRow.type = 'button';
  addRow.className = 'note-create-row';
  addRow.dataset.action = 'create-note';
  addRow.textContent = 'Create note';
  notesList.appendChild(addRow);
}

function renderFormulaPills() {
  const formulasOnly = notesData.filter(n => n.isFormula);
  formulaPills.innerHTML = '';

  if (formulasOnly.length === 0) {
    formulaPills.innerHTML = '<p class="empty-hint">Save a formula from the chat or notes.</p>';
    formulas = [];
    localStorage.setItem(FORMULAS_KEY, JSON.stringify(formulas));
    return;
  }

  formulasOnly.forEach(note => {
    const pill = document.createElement('span');
    pill.className = 'formula-pill';
    pill.dataset.id = note._id;
    pill.title = note.content;
    pill.textContent = note.content.length > 30 ? note.content.slice(0, 30) + '…' : note.content;
    formulaPills.appendChild(pill);
  });

  formulas = formulasOnly.map(f => ({ id: f._id, content: f.content }));
  localStorage.setItem(FORMULAS_KEY, JSON.stringify(formulas));
}

document.getElementById('export-notes-btn').addEventListener('click', async () => {
  try {
    const res = await fetch(`/notes/${participantID}`);
    const notes = await res.json();
    if (notes.length === 0) { alert('No notes to export.'); return; }

    let text = `compoundify — Study Notes\nParticipant: ${participantID}\nExported: ${new Date().toLocaleString()}\n\n`;
    let lastStack = null;
    notes.forEach(n => {
      const noteStack = n.stack || 'General';
      if (noteStack !== lastStack) {
        text += `\n── Stack: ${noteStack} ──\n`;
        lastStack = noteStack;
      }
      text += `[${n.title || 'Untitled'}] ${n.isFormula ? '[FORMULA] ' : ''}${n.content}\n`;
    });

    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `compoundify-notes-${participantID}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('Export failed.');
  }
});

function appendUploadPrompt(filename, chunkCount) {
  const wrap = document.createElement('div');
  wrap.className = 'message message--bot';

  const card = document.createElement('div');
  card.className = 'upload-card';

  const msg = document.createElement('p');
  msg.className = 'upload-card__msg';
  msg.innerHTML = `Document <strong>${filename}</strong> uploaded.`;

  const subject = filename.replace(/\.[^.]+$/, '');

  const btnRow = document.createElement('div');
  btnRow.className = 'upload-card__btns';

  const generateBtn = document.createElement('button');
  generateBtn.textContent = 'Generate Learning Plan';
  generateBtn.className = 'btn-primary btn-sm';

  let generating = false;
  generateBtn.addEventListener('click', async () => {
    const subjectValue = subject.trim();
    if (!subjectValue || generating) return;
    generating = true;
    btnRow.classList.add('is-loading');
    generateBtn.innerHTML = '<span class="btn-dots"><span></span><span></span><span></span></span>';
    try {
      const res = await fetch('/generate-topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: subjectValue, participantID })
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => 'Unknown error');
        console.error('Generate topics failed:', res.status, errText);
        card.innerHTML = '';
        const fail = document.createElement('p');
        fail.className = 'upload-card__msg';
        fail.textContent = 'Could not generate a learning plan. Try again later.';
        card.appendChild(fail);
        return;
      }

      const data = await res.json().catch(e => {
        console.error('Failed parsing generate-topics response', e);
        return null;
      });

      if (!data || !data.topics || !Array.isArray(data.topics)) {
        console.error('Invalid topics response', data);
        card.innerHTML = '';
        const fail = document.createElement('p');
        fail.className = 'upload-card__msg';
        fail.textContent = 'Received unexpected response from server.';
        card.appendChild(fail);
        return;
      }

      topics = data.topics.map((name, i) => ({ id: `t${Date.now()}${i}`, name, status: 'not_started', problemsSolved: 0 }));
      saveTopics();
      renderTopics();
      card.innerHTML = '';
      const done = document.createElement('p');
      done.className = 'upload-card__msg';
      done.innerHTML = `Learning plan for <strong>${subjectValue}</strong> ready — ${topics.length} topics added to the left panel.`;
      card.appendChild(done);
    } catch (err) {
      console.error('Generate topics error:', err);
      card.innerHTML = '';
      const fail = document.createElement('p');
      fail.className = 'upload-card__msg';
      fail.textContent = 'Could not generate a learning plan. Please try again.';
      card.appendChild(fail);
    }
    finally {
      generating = false;
      btnRow.classList.remove('is-loading');
      generateBtn.textContent = 'Generate Learning Plan';
    }
  });

  btnRow.appendChild(generateBtn);
  card.appendChild(msg);
  card.appendChild(btnRow);
  wrap.appendChild(card);
  messagesEl.appendChild(wrap);
  scrollChat();
}

function appendUserMessage(text) {
  const wrap = document.createElement('div');
  wrap.className = 'message message--user';
  wrap.id = `msg-u-${++msgCounter}`;
  const bubble = document.createElement('div');
  bubble.className = 'message__bubble';
  // Render any $...$ or \(...\) math in user messages
  const mathBlocks = [];
  let protected_ = text
    .replace(/\$\$[\s\S]*?\$\$/g, m => { mathBlocks.push(m); return `%%MATH${mathBlocks.length - 1}%%`; })
    .replace(/\$[^$\n]+\$/g,      m => { mathBlocks.push(m); return `%%MATH${mathBlocks.length - 1}%%`; })
    .replace(/\\\[[\s\S]*?\\\]/g, m => { mathBlocks.push(m); return `%%MATH${mathBlocks.length - 1}%%`; })
    .replace(/\\\([\s\S]*?\\\)/g, m => { mathBlocks.push(m); return `%%MATH${mathBlocks.length - 1}%%`; });
  let escaped = protected_.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  escaped = escaped.replace(/%%MATH(\d+)%%/g, (_, i) => mathBlocks[parseInt(i)]);
  bubble.innerHTML = escaped;
  MathJax.typesetPromise([bubble]);
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollChat();
}

function appendBotMessage(text) {
  const wrap = document.createElement('div');
  wrap.className = 'message message--bot';
  wrap.id = `msg-${++msgCounter}`;

  const bubble = document.createElement('div');
  bubble.className = 'message__bubble';

  // Protect math blocks before marked parses them
  const mathBlocks = [];
  let protected_ = text
    .replace(/\\\[[\s\S]*?\\\]/g, m => { mathBlocks.push(m); return `%%MATH${mathBlocks.length - 1}%%`; })
    .replace(/\\\([\s\S]*?\\\)/g, m => { mathBlocks.push(m); return `%%MATH${mathBlocks.length - 1}%%`; });
  let rendered = marked.parse(protected_);
  rendered = rendered.replace(/%%MATH(\d+)%%/g, (_, i) => mathBlocks[parseInt(i)]);
  bubble.innerHTML = rendered;
  MathJax.typesetPromise([bubble]);

  // Save-to-notes button on each bot message
  const saveBtn = document.createElement('button');
  saveBtn.className = 'msg-save-btn';
  saveBtn.title = 'Save to notes';
  saveBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> Save`;
  saveBtn.addEventListener('click', () => {
    saveNote(text, false, null);
    saveBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Saved`;
    saveBtn.disabled = true;
  });

  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  actions.appendChild(saveBtn);

  wrap.appendChild(bubble);
  wrap.appendChild(actions);
  messagesEl.appendChild(wrap);
  scrollChat();
}

function appendQuizCard(quiz) {
  const wrap = document.createElement('div');
  wrap.className = 'message message--bot';

  const card = document.createElement('div');
  card.className = 'quiz-card';

  const header = document.createElement('div');
  header.className = 'quiz-card__header';
  header.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> Quick Check — ${currentTopic}`;

  const question = document.createElement('p');
  question.className = 'quiz-card__question';
  question.textContent = quiz.question;

  const hint = document.createElement('p');
  hint.className = 'quiz-card__hint';
  hint.textContent = quiz.hint || '';

  card.appendChild(header);
  card.appendChild(question);
  if (quiz.hint) card.appendChild(hint);

  wrap.appendChild(card);
  messagesEl.appendChild(wrap);
  scrollChat();

  // Focus input for answer
  userInput.focus();
  userInput.placeholder = 'Type your answer…';
}

function appendProblemStep(problem, stepIndex, practiceId = problem.__practiceId || `practice-${currentTopic || 'topic'}`) {
  const wrap = document.createElement('div');
  wrap.className = 'message message--bot';
  wrap.id = `problem-step-${practiceId}-${stepIndex}`;

  const card = document.createElement('div');
  card.className = 'problem-card';

  // Problem title (only on first step)
  if (stepIndex === 0) {
    const titleDiv = document.createElement('div');
    titleDiv.className = 'problem-card__title';
    titleDiv.textContent = `Problem: ${problem.problem}`;
    card.appendChild(titleDiv);
  }

  // Step header
  const header = document.createElement('div');
  header.className = 'problem-card__header';
  header.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Step ${stepIndex + 1} of ${problem.steps.length}`;
  card.appendChild(header);

  const instruction = document.createElement('p');
  instruction.className = 'problem-card__instruction';
  instruction.textContent = problem.steps[stepIndex].instruction;

  const inputArea = document.createElement('div');
  inputArea.className = 'problem-card__input-area';

  const label = document.createElement('label');
  label.className = 'sr-only';
  label.textContent = `Your answer for step ${stepIndex + 1}`;

  const input = document.createElement('textarea');
  input.className = 'problem-card__input';
  input.placeholder = 'Type your answer…';
  input.rows = 2;
  input.id = `step-input-${practiceId}-${stepIndex}`;

  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn-primary btn-sm';
  submitBtn.textContent = 'Submit Answer';
  submitBtn.addEventListener('click', async () => {
    const answer = input.value.trim();
    if (!answer) return;
    submitStepAnswer(problem, stepIndex, answer, practiceId);
  });

  inputArea.appendChild(label);
  inputArea.appendChild(input);
  inputArea.appendChild(submitBtn);

  card.appendChild(instruction);
  card.appendChild(inputArea);
  wrap.appendChild(card);
  messagesEl.appendChild(wrap);
  scrollChat();
  // Track current problem/step for chat context and retries
  currentProblem = problem;
  currentStepIndex = stepIndex;
  input.focus();
}

async function submitStepAnswer(problem, stepIndex, answer, practiceId = problem.__practiceId || `practice-${currentTopic || 'topic'}`) {
  const step = problem.steps[stepIndex];
  try {
    const res = await fetch('/evaluate-step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: currentTopic,
        stepNumber: stepIndex + 1,
        instruction: step.instruction,
        expectedAnswer: step.answer,
        studentAnswer: answer,
        hint: step.hint || '',
        participantID
      })
    });
    const feedback = await res.json();

    const stepCard = document.getElementById(`problem-step-${practiceId}-${stepIndex}`);
    const feedbackDiv = document.createElement('div');
    feedbackDiv.className = 'problem-card__feedback';

    if (!stepCard) {
      return;
    }

    const existingFeedback = stepCard.querySelectorAll('.problem-card__feedback');
    existingFeedback.forEach(node => node.remove());

    // Include the student's answer in the feedback if incorrect
    if (!feedback.correct) {
      feedbackDiv.innerHTML = `<strong>${feedback.correct ? '✓ Correct!' : '✗ Not quite'}</strong><p><strong>Your answer:</strong> "${answer}"</p><p>${feedback.feedback}</p>`;
    } else {
      feedbackDiv.innerHTML = `<strong>${feedback.correct ? '✓ Correct!' : '✗ Not quite'}</strong><p>${feedback.feedback}</p>`;
    }
    stepCard.querySelector('.problem-card').appendChild(feedbackDiv);

    const inputArea = stepCard.querySelector('.problem-card__input-area');
    const inputField = inputArea.querySelector('.problem-card__input');

    if (feedback.correct) {
      // On success, hide the input area and offer next step or finish
      inputArea.style.display = 'none';

      if (stepIndex < problem.steps.length - 1) {
        const nextBtn = document.createElement('button');
        nextBtn.className = 'btn-primary btn-sm';
        nextBtn.textContent = `Next Step (${stepIndex + 2}/${problem.steps.length})`;
        nextBtn.addEventListener('click', () => {
          // advance global index and render next step
          currentStepIndex = stepIndex + 1;
          appendProblemStep(problem, stepIndex + 1, practiceId);
        });
        stepCard.querySelector('.problem-card').appendChild(nextBtn);
      } else {
        const doneDiv = document.createElement('div');
        doneDiv.className = 'problem-card__done';
        doneDiv.innerHTML = `<strong>Problem complete!</strong><p>You worked through all steps correctly. Great work!</p>`;
        stepCard.querySelector('.problem-card').appendChild(doneDiv);
        conversationHistory.push({ role: 'user', content: `Worked through a practice problem on ${currentTopic}` });
        // Track progress: increment problems solved for this topic
        if (currentTopic) incrementProblemsSolvedByName(currentTopic);
        currentProblem = null;
        currentStepIndex = 0;
      }
    } else {
      // Incorrect: clear the input and keep it visible so user can retry
      const inputField = document.getElementById(`step-input-${practiceId}-${stepIndex}`);
      if (inputField) {
        inputField.value = '';
        inputField.focus();
      }
      inputArea.style.display = '';

      const controls = document.createElement('div');
      controls.className = 'problem-card__retry-controls';

      const showAnswerBtn = document.createElement('button');
      showAnswerBtn.className = 'btn-ghost btn-sm';
      showAnswerBtn.textContent = 'Show Answer';
      showAnswerBtn.addEventListener('click', () => {
        // Reveal a student-facing answer example and let the user continue with the problem if they want.
        const reveal = document.createElement('div');
        reveal.className = 'problem-card__reveal';
        reveal.innerHTML = `<strong>Sample answer:</strong><p>${step.answer}</p>`;
        stepCard.querySelector('.problem-card').appendChild(reveal);
        inputArea.style.display = 'none';
        controls.remove();

        if (stepIndex < problem.steps.length - 1) {
          const continueBtn = document.createElement('button');
          continueBtn.className = 'btn-primary btn-sm';
          continueBtn.textContent = `Continue to Next Step (${stepIndex + 2}/${problem.steps.length})`;
          continueBtn.addEventListener('click', () => {
            currentStepIndex = stepIndex + 1;
            appendProblemStep(problem, stepIndex + 1, practiceId);
          });
          stepCard.querySelector('.problem-card').appendChild(continueBtn);
        } else {
          const ended = document.createElement('div');
          ended.className = 'problem-card__done';
          ended.innerHTML = `<strong>Problem complete.</strong><p>You can start a new problem whenever you're ready.</p>`;
          stepCard.querySelector('.problem-card').appendChild(ended);
          conversationHistory.push({ role: 'user', content: `Worked through a practice problem on ${currentTopic}` });
          // Track progress: increment problems solved for this topic
          if (currentTopic) incrementProblemsSolvedByName(currentTopic);
          currentProblem = null;
          currentStepIndex = 0;
        }
      });

      const tryAgainNote = document.createElement('span');
      tryAgainNote.className = 'problem-card__tryagain';
      tryAgainNote.textContent = 'You can edit your answer and submit again as many times as you like.';

      controls.appendChild(showAnswerBtn);
      controls.appendChild(tryAgainNote);
      stepCard.querySelector('.problem-card').appendChild(controls);
    }
  } catch (err) {
    appendBotMessage('Could not evaluate your answer. Please try again.');
  }
}


const selTooltip = document.getElementById('sel-tooltip');
let selState = { text: '', msgId: null, isFormula: false };

function normalizeSelectedText(text) {
  if (!text) return '';
  let out = String(text)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/`{1,3}/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  // Remove outer math delimiters when present
  out = out
    .replace(/^\$\$([\s\S]+)\$\$$/, '$1')
    .replace(/^\$([\s\S]+)\$$/, '$1')
    .replace(/^\\\(([\s\S]+)\\\)$/, '$1')
    .replace(/^\\\[([\s\S]+)\\\]$/, '$1')
    .trim();

  return out;
}

function extractFormulaFromMathElement(mathEl) {
  if (!mathEl) return '';

  const ann = mathEl.querySelector('annotation[encoding="application/x-tex"]');
  const tex = ann?.textContent?.trim();
  if (tex) return normalizeSelectedText(tex);

  const aria = mathEl.getAttribute('aria-label');
  if (aria) return normalizeSelectedText(aria);

  return normalizeSelectedText(mathEl.textContent || '');
}

function showSelectionTooltip(text, msgId, rect, isFormula = false) {
  selState = { text, msgId, isFormula };
  requestAnimationFrame(() => {
    selTooltip.style.display = 'flex';
    const x = rect.left + rect.width / 2 - selTooltip.offsetWidth / 2;
    const y = rect.top - selTooltip.offsetHeight - 10;
    selTooltip.style.left = Math.max(8, x) + 'px';
    selTooltip.style.top = Math.max(8, y) + 'px';
  });
}

function clearFormulaSelectionCue() {
  messagesEl.querySelectorAll('.formula-selection-cue').forEach((el) => {
    el.classList.remove('formula-selection-cue');
  });
}

function cueFormulaSelection(formulaEl) {
  if (!formulaEl) return;
  clearFormulaSelectionCue();
  formulaEl.classList.add('formula-selection-cue');
  setTimeout(() => formulaEl.classList.remove('formula-selection-cue'), 1200);
}

function hideSelTooltip() {
  selTooltip.style.display = 'none';
  selState = { text: '', msgId: null, isFormula: false };
  clearFormulaSelectionCue();
}

messagesEl.addEventListener('mouseup', (e) => {
  const sel = window.getSelection();
  if (!sel) { hideSelTooltip(); return; }

  const baseNode = (sel.anchorNode?.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode) || e.target;
  const formulaEl = baseNode?.closest?.('mjx-container');

  // Fallback for formula clicks where browser selection is collapsed on MathJax output.
  if (sel.isCollapsed && formulaEl) {
    const wrap = formulaEl.closest('.message--bot, .message--user');
    if (!wrap) { hideSelTooltip(); return; }

    const formulaText = extractFormulaFromMathElement(formulaEl);
    if (!formulaText) { hideSelTooltip(); return; }

    const rect = formulaEl.getBoundingClientRect();
    cueFormulaSelection(formulaEl);
    showSelectionTooltip(formulaText, wrap.id, rect, true);
    return;
  }

  if (sel.isCollapsed) { hideSelTooltip(); return; }

  const text = normalizeSelectedText(sel.toString());
  if (!text) { hideSelTooltip(); return; }

  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const wrap = (node.nodeType === 3 ? node.parentElement : node).closest('.message--bot, .message--user');
  if (!wrap) { hideSelTooltip(); return; }

  const formulaNodes = [...wrap.querySelectorAll('mjx-container')].filter((el) => {
    try {
      return range.intersectsNode(el);
    } catch {
      return false;
    }
  });
  if (formulaNodes.length) {
    cueFormulaSelection(formulaNodes[0]);
  }

  const isFormula = formulaNodes.length > 0
    || !!(sel.anchorNode?.parentElement?.closest?.('mjx-container') || sel.focusNode?.parentElement?.closest?.('mjx-container'));
  showSelectionTooltip(text, wrap.id, range.getBoundingClientRect(), isFormula);
});

// Hide on click outside tooltip
document.addEventListener('mousedown', (e) => {
  if (!selTooltip.contains(e.target)) hideSelTooltip();
});

// Prevent mousedown inside tooltip from clearing the selection
selTooltip.addEventListener('mousedown', (e) => e.preventDefault());

selTooltip.addEventListener('click', async () => {
  const { text, msgId, isFormula } = selState;
  if (!text) return;
  hideSelTooltip();
  window.getSelection().removeAllRanges();
  await saveNote(text, isFormula, msgId);
});

// ── Highlight feature notification banner ────────────────────────────────
const highlightToast = document.getElementById('highlight-toast');
const highlightToastClose = document.getElementById('highlight-toast-close');
if (highlightToast) {
  highlightToast.classList.add('is-visible');
  highlightToastClose?.addEventListener('click', () => {
    highlightToast.classList.remove('is-visible');
  });
}

function showTyping(show) {
  typingEl.style.display = show ? 'flex' : 'none';
  if (show) scrollChat();
}

function scrollChat() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

document.getElementById('upload-doc-btn').addEventListener('click', () => {
  document.getElementById('file-input').click();
});

document.getElementById('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const btn = document.getElementById('upload-doc-btn');
  btn.classList.add('uploading');
  btn.title = 'Uploading…';
  const formData = new FormData();
  formData.append('document', file);
  try {
    const res = await fetch('/upload-document', { method: 'POST', body: formData });
    const data = await res.json();
    if (res.ok) {
      appendUploadPrompt(data.filename, data.chunkCount);
    } else {
      alert('Upload failed: ' + data.error);
    }
  } catch (err) {
    alert('Upload failed.');
  } finally {
    btn.classList.remove('uploading');
    btn.title = 'Attach a document (PDF or TXT)';
    e.target.value = '';
  }
});

function logEvent(type, element) {
  fetch('/log-event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ participantID, systemID, sessionID, eventType: type, elementName: element, timestamp: new Date() })
  }).catch(() => {});
}

sendBtn.addEventListener('click', () => {
  if (!currentController) logEvent('click', 'Send Button');
});

async function init() {
  renderTopics();
  await loadNotes();

  // Load conversation history
  try {
    const res = await fetch('/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participantID, limit: 10 })
    });
    const data = await res.json();
    if (data.history && data.history.length > 0) {
      data.history.forEach(entry => {
        appendUserMessage(entry.userInput);
        appendBotMessage(entry.botResponse);
        conversationHistory.push({ role: 'user', content: entry.userInput });
        conversationHistory.push({ role: 'assistant', content: entry.botResponse });
        if (entry.currentTopic && !currentTopic) {
          currentTopic = entry.currentTopic;
          topbarTopic.textContent = currentTopic;
        }
      });
    } else {
      // First visit — welcome message
      appendBotMessage('Hi, welcome to Compoundify!\n\n- Generate a learning plan on the left, or add topics yourself.\n- Click on a topic to get started!');
    }
  } catch (err) {
    console.error(err);
  }
}

init();
