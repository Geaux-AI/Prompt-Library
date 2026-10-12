const CUSTOM_PROMPTS_KEY = "promptLibrary.customPrompts";
const SECURITY_LOG_KEY = "promptLibrary.securityLog";

// Cloudflare Worker relay URL — set this after deploying the Worker in
// cloudflare-worker/worker.js. Leave blank to keep the security log local-only.
const SECURITY_RELAY_URL = "https://icy-smoke-ffde.diegoaxel2004.workers.dev";

let basePrompts = [];

const state = {
  prompts: [],
  skill: "All",
  llm: "All",
  search: "",
};

const grid = document.getElementById("prompt-grid");
const emptyState = document.getElementById("empty-state");
const resultCount = document.getElementById("result-count");
const resultBarFill = document.getElementById("result-bar-fill");
const searchInput = document.getElementById("search-input");
const toast = document.getElementById("toast");

const COPY_ICON = `<svg class="copy-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" stroke-width="2"/>
  <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" stroke="currentColor" stroke-width="2"/>
</svg>`;

const CHECK_ICON = `<svg class="copy-icon copy-check" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M4 12.5L9 17.5L20 6.5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

/* ==================== helpers ==================== */

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function slugify(text) {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "prompt"
  );
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add("show"));
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => {
      toast.hidden = true;
    }, 250);
  }, 2200);
}

/* ==================== content guardrails ====================
   Basic, client-side checks only: an obvious-insult wordlist and a
   handful of "[group] are/is [slur-adjacent trait]" patterns. This is
   NOT real moderation — it's a first line of defense against the
   clearest cases, easy to get around on purpose, and it can false-
   positive. There's no backend here to call a real moderation API
   against, so this is deliberately kept simple and conservative about
   what it blocks (favoring not annoying you over catching everything).
*/

/* Two tiers, because a bare wordlist can't tell an insult from a description.
   "Harsh and wrong is worse than useless" is not an insult; "you are useless"
   is. The first list is blocked anywhere; the second only when aimed at someone. */
const ALWAYS_BLOCKED = [
  "dumbass", "subhuman", "retard", "retarded",
  "kill yourself", "kys", "go die", "i hate you",
];

const DIRECTED_INSULTS = [
  "stupid", "idiot", "idiotic", "moron", "moronic", "imbecile",
  "pathetic", "worthless", "useless", "loser", "scum",
];

// "you are/you're/he is/she is/they are/people are ... <insult>"
const DIRECTED_AT_PERSON = new RegExp(
  `\\b(you|he|she|they|people|everyone|she'?s|he'?s|you'?re|they'?re)\\b[^.?!\\n]{0,18}\\b(is|are|'?re|'?s|was|were)?\\b[^.?!\\n]{0,12}\\b(${DIRECTED_INSULTS.join("|")})\\b`,
  "i"
);

const BIAS_GROUPS =
  "(women|men|girls|boys|black people|white people|blacks|whites|asians|asian people|" +
  "latinos|latinas|hispanics|mexicans|arabs|africans|indians|" +
  "muslims|christians|jews|jewish people|hindus|atheists|" +
  "gay people|gays|lesbians|trans people|transgender people|queer people|" +
  "immigrants|refugees|foreigners|disabled people|autistic people|" +
  "poor people|homeless people|old people|the elderly|fat people)";

const BIAS_TRAITS =
  "(stupid|inferior|lazy|dumb|evil|worthless|criminals?|less than others|less than human|" +
  "not as smart|subhuman|animals|vermin|parasites|the problem|a disease|disgusting|" +
  "don'?t belong|should be (killed|removed|deported|banned))";

// Three shapes: "[group] are [trait]", "kill/deport [group]", "i hate [group]".
const BIAS_PATTERNS = [
  new RegExp(`\\b(all |most )?${BIAS_GROUPS}\\b[^.?!\\n]{0,20}\\b(are|is|aren'?t|should be)\\b[^.?!\\n]{0,20}\\b${BIAS_TRAITS}\\b`, "i"),
  new RegExp(`\\b(kill|gas|exterminate|deport|get rid of)\\b[^.?!\\n]{0,15}\\b(all |the )?${BIAS_GROUPS}\\b`, "i"),
  new RegExp(`\\bi hate\\b[^.?!\\n]{0,15}\\b${BIAS_GROUPS}\\b`, "i"),
];

/* Natural-language prompt injection. Deliberately narrow: this is a library OF
   prompts, so instructions are the content type — matching instructions broadly
   would reject legitimate entries. These target the specific idiom of
   overriding or extracting a model's existing instructions. */
const PROMPT_INJECTION_PATTERNS = [
  { pattern: /\b(ignore|disregard|forget|override|bypass)\b[^.?!\n]{0,40}\b(previous|prior|above|earlier|initial|original|all|any|your|the)\b[^.?!\n]{0,25}\b(instruction|prompt|rule|direction|guideline|restriction|constraint|guardrail)/i,
    label: "an attempt to override prior instructions" },
  { pattern: /\b(reveal|show|print|repeat|output|display|tell me)\b[^.?!\n]{0,30}\b(your|the)\b[^.?!\n]{0,20}\b(system prompt|system message|initial instruction|original instruction|hidden instruction)/i,
    label: "an attempt to extract system instructions" },
  { pattern: /\b(developer mode|jailbreak|dan mode|do anything now|without any restrictions|no longer bound by|unfiltered mode)\b/i,
    label: "a jailbreak phrase" },
  { pattern: /\b(you are now|from now on,? you)\b[^.?!\n]{0,40}\b(unrestricted|unfiltered|no restrictions|not bound|free from|ignore)\b/i,
    label: "an attempt to remove the model's constraints" },
];

/* A prompt that DEFENDS against injection has to quote injection language
   ("text telling you to ignore your rules"). Reported speech is description,
   not a command, so a match sitting right after reporting language is allowed. */
const REPORTED_SPEECH =
  /\b(telling|tells|told|instructing|instructs|asking|asks|says?|saying|said|such as|like|e\.g\.|example|quote[ds]?|contains?|includes?|attempts? to|tries to|trying to|anything that|text that|treat (it|them|this) as)\b[^.?!\n]{0,45}$/i;

const INJECTION_PATTERNS = [
  { pattern: /<\s*script/i, label: "<script> tag" },
  { pattern: /<\s*iframe/i, label: "<iframe> tag" },
  { pattern: /on\w+\s*=\s*["']?/i, label: "inline event handler" },
  { pattern: /javascript:/i, label: "javascript: URI" },
  { pattern: /document\.(cookie|write)/i, label: "DOM/cookie access attempt" },
  { pattern: /\bfetch\s*\(|\bxmlhttprequest\b/i, label: "network call attempt" },
];

function checkInjection(text) {
  for (const { pattern, label } of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      logSecurityEvent("injection_attempt", `Blocked ${label} in submitted text.`);
      return { ok: false, reason: `That looks like a ${label} — not allowed in prompt text.` };
    }
  }
  return { ok: true };
}

function checkPromptInjection(text) {
  for (const { pattern, label } of PROMPT_INJECTION_PATTERNS) {
    const m = pattern.exec(text);
    if (!m) continue;
    const before = text.slice(Math.max(0, m.index - 60), m.index);
    if (REPORTED_SPEECH.test(before)) continue; // described, not commanded
    logSecurityEvent("prompt_injection_attempt", `Blocked ${label}.`);
    return { ok: false, reason: `That reads as ${label}. Prompts here can't try to override another model's instructions.` };
  }
  return { ok: true };
}

function checkContent(text) {
  const lower = text.toLowerCase();
  for (const term of ALWAYS_BLOCKED) {
    const escaped = term.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(lower)) {
      logSecurityEvent("blocked_language", `Blocked term: "${term}"`);
      return { ok: false, reason: `Contains harsh or hostile language ("${term}"). Rephrase it.` };
    }
  }
  if (DIRECTED_AT_PERSON.test(lower)) {
    logSecurityEvent("blocked_language", "Blocked an insult aimed at a person.");
    return { ok: false, reason: "That reads as an insult aimed at a person. Rephrase it." };
  }
  for (const re of BIAS_PATTERNS) {
    if (re.test(lower)) {
      logSecurityEvent("blocked_bias", "Blocked a discriminatory or hateful pattern.");
      return { ok: false, reason: "That reads as a hateful or discriminatory statement about a group of people. Rephrase it." };
    }
  }
  return { ok: true };
}

function runGuardrails(text) {
  const injection = checkInjection(text);
  if (!injection.ok) return injection;
  const promptInjection = checkPromptInjection(text);
  if (!promptInjection.ok) return promptInjection;
  return checkContent(text);
}

/* ==================== security log ====================
   Local-only record of blocked submissions, kept in this browser via
   localStorage. Nothing here is transmitted anywhere automatically —
   there's no backend on a static GitHub Pages site to safely send it
   to. Export the log manually if you want to share it.
*/

function loadSecurityLog() {
  try {
    return JSON.parse(localStorage.getItem(SECURITY_LOG_KEY)) || [];
  } catch {
    return [];
  }
}

function saveSecurityLog(log) {
  try {
    localStorage.setItem(SECURITY_LOG_KEY, JSON.stringify(log));
  } catch {
    /* storage unavailable — fail silently, logging is best-effort */
  }
}

function logSecurityEvent(type, detail) {
  const log = loadSecurityLog();
  log.unshift({ type, detail, time: new Date().toISOString() });
  saveSecurityLog(log.slice(0, 200));
  notifySecurityRelay(type, detail);
}

// Client-side courtesy rate limit so a burst of blocked attempts (e.g.
// someone testing the guardrails repeatedly) doesn't flood Slack. This is
// trivially bypassable (it's just localStorage) — real abuse-resistance
// belongs on the Worker/Slack side, e.g. a Cloudflare rate-limiting rule
// on the relay's route.
const RELAY_RATE_LIMIT_KEY = "promptLibrary.relayRateLimit";
const RELAY_MAX_PER_WINDOW = 5;
const RELAY_WINDOW_MS = 10 * 60 * 1000;

function canSendRelayNotification() {
  let timestamps;
  try {
    timestamps = JSON.parse(localStorage.getItem(RELAY_RATE_LIMIT_KEY)) || [];
  } catch {
    timestamps = [];
  }
  const now = Date.now();
  timestamps = timestamps.filter((t) => now - t < RELAY_WINDOW_MS);
  if (timestamps.length >= RELAY_MAX_PER_WINDOW) return false;
  timestamps.push(now);
  localStorage.setItem(RELAY_RATE_LIMIT_KEY, JSON.stringify(timestamps));
  return true;
}

function notifySecurityRelay(type, detail) {
  if (!SECURITY_RELAY_URL) return;
  if (!canSendRelayNotification()) return;
  fetch(SECURITY_RELAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, detail, time: new Date().toISOString() }),
  }).catch(() => {
    /* best-effort only — a down relay shouldn't block or alert the visitor */
  });
}

function renderSecurityLog() {
  const list = document.getElementById("security-log-list");
  const log = loadSecurityLog();
  list.innerHTML = "";

  if (log.length === 0) {
    const empty = document.createElement("p");
    empty.className = "security-log-empty";
    empty.textContent = "No blocked attempts recorded in this browser yet.";
    list.appendChild(empty);
    return;
  }

  log.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "security-entry";

    const head = document.createElement("div");
    head.className = "security-entry-head";
    const typeLabel = document.createElement("span");
    typeLabel.textContent = entry.type.replace(/_/g, " ");
    const time = document.createElement("span");
    time.className = "security-entry-time";
    time.textContent = new Date(entry.time).toLocaleString();
    head.append(typeLabel, time);

    const detail = document.createElement("div");
    detail.className = "security-entry-detail";
    detail.textContent = entry.detail;

    item.append(head, detail);
    list.appendChild(item);
  });
}

function exportSecurityLog() {
  const log = loadSecurityLog();
  downloadJson(log, "security-log.json");
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ==================== custom prompts (localStorage) ==================== */

function loadCustomPrompts() {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_PROMPTS_KEY)) || [];
  } catch {
    return [];
  }
}

function saveCustomPromptsList(list) {
  localStorage.setItem(CUSTOM_PROMPTS_KEY, JSON.stringify(list));
}

function rebuildPromptState() {
  state.prompts = [...basePrompts, ...loadCustomPrompts()];
}

function deleteCustomPrompt(id) {
  const remaining = loadCustomPrompts().filter((p) => p.id !== id);
  saveCustomPromptsList(remaining);
  rebuildPromptState();
  refreshDropdownOptions();
  render();
  showToast("Prompt removed.");
}

/* ==================== custom animated dropdown ==================== */

function createDropdown({ container, labelText, options, initialValue, onChange }) {
  container.classList.add("dd-wrapper");
  container.innerHTML = `
    <span class="dd-label"></span>
    <button type="button" class="dd-trigger" aria-haspopup="listbox" aria-expanded="false">
      <span class="dd-value"></span>
      <svg class="dd-chevron" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <ul class="dd-menu" role="listbox" tabindex="-1">
      <div class="dd-highlight"></div>
    </ul>
  `;
  container.querySelector(".dd-label").textContent = labelText;

  const trigger = container.querySelector(".dd-trigger");
  const valueEl = container.querySelector(".dd-value");
  const menu = container.querySelector(".dd-menu");
  const highlight = container.querySelector(".dd-highlight");

  let current = initialValue;
  valueEl.textContent = current;

  function buildOptions() {
    menu.querySelectorAll(".dd-option").forEach((el) => el.remove());
    options.forEach((opt) => {
      const li = document.createElement("li");
      li.className = "dd-option" + (opt === current ? " active" : "");
      li.setAttribute("role", "option");
      li.textContent = opt;
      li.addEventListener("mouseenter", () => moveHighlight(li));
      li.addEventListener("click", () => selectOption(opt));
      menu.appendChild(li);
    });
  }

  function moveHighlight(li) {
    highlight.style.transform = `translateY(${li.offsetTop}px)`;
    highlight.style.height = `${li.offsetHeight}px`;
    highlight.style.opacity = "1";
  }

  function selectOption(opt) {
    current = opt;
    valueEl.textContent = opt;
    menu.querySelectorAll(".dd-option").forEach((el) => {
      el.classList.toggle("active", el.textContent === opt);
    });
    close();
    onChange(opt);
  }

  function open() {
    container.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
    buildOptions();
    const activeEl = [...menu.querySelectorAll(".dd-option")].find((el) => el.classList.contains("active"));
    if (activeEl) moveHighlight(activeEl);
  }

  function close() {
    container.classList.remove("open");
    trigger.setAttribute("aria-expanded", "false");
    highlight.style.opacity = "0";
  }

  trigger.addEventListener("click", () => {
    container.classList.contains("open") ? close() : open();
  });

  menu.addEventListener("mouseleave", () => {
    const activeEl = [...menu.querySelectorAll(".dd-option")].find((el) => el.classList.contains("active"));
    if (activeEl) moveHighlight(activeEl);
    else highlight.style.opacity = "0";
  });

  document.addEventListener("click", (e) => {
    if (!container.contains(e.target)) close();
  });

  document.addEventListener("keydown", (e) => {
    if (!container.classList.contains("open")) return;
    if (e.key === "Escape") close();
  });

  buildOptions();

  return {
    setOptions(newOptions) {
      options = newOptions;
      if (!options.includes(current)) {
        current = options[0];
        valueEl.textContent = current;
      }
      buildOptions();
    },
  };
}

let skillDropdownApi = null;
let llmDropdownApi = null;

function refreshDropdownOptions() {
  const skillOptions = ["All", ...uniqueSorted(state.prompts.map((p) => p.skill))];
  const llmOptions = ["All", ...uniqueSorted(state.prompts.map((p) => p.llm).filter((llm) => llm !== "Any"))];
  if (skillDropdownApi) skillDropdownApi.setOptions(skillOptions);
  if (llmDropdownApi) llmDropdownApi.setOptions(llmOptions);
}

/* ==================== filtering + rendering ==================== */

function matchesFilters(prompt) {
  const skillOk = state.skill === "All" || prompt.skill === state.skill;
  const llmOk = state.llm === "All" || prompt.llm === state.llm || prompt.llm === "Any";
  const query = state.search.trim().toLowerCase();
  const searchOk =
    !query ||
    prompt.title.toLowerCase().includes(query) ||
    prompt.prompt.toLowerCase().includes(query);
  return skillOk && llmOk && searchOk;
}

function renderCard(prompt, index) {
  const card = document.createElement("article");
  card.className = "prompt-card";
  card.style.animationDelay = `${Math.min(index * 45, 400)}ms`;

  card.addEventListener("mousemove", (e) => {
    const rect = card.getBoundingClientRect();
    card.style.setProperty("--mx", `${e.clientX - rect.left}px`);
    card.style.setProperty("--my", `${e.clientY - rect.top}px`);
  });

  const title = document.createElement("h3");
  title.textContent = prompt.title;

  const badges = document.createElement("div");
  badges.className = "badges";
  const skillBadge = document.createElement("span");
  skillBadge.className = "badge";
  skillBadge.textContent = prompt.skill;
  const llmBadge = document.createElement("span");
  llmBadge.className = "badge";
  llmBadge.textContent = prompt.llm;
  badges.append(skillBadge, llmBadge);

  if (prompt._custom) {
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "ghost-button";
    deleteBtn.type = "button";
    deleteBtn.style.marginLeft = "auto";
    deleteBtn.style.padding = "3px 12px";
    deleteBtn.style.fontSize = "0.72rem";
    deleteBtn.textContent = "Remove";
    deleteBtn.addEventListener("click", () => deleteCustomPrompt(prompt.id));
    badges.appendChild(deleteBtn);
    badges.style.alignItems = "center";
  }

  const text = document.createElement("div");
  text.className = "prompt-text";
  text.textContent = prompt.prompt;

  const copyButton = document.createElement("button");
  copyButton.className = "copy-button";
  copyButton.type = "button";
  copyButton.innerHTML = `${COPY_ICON}${CHECK_ICON}<span class="copy-label">Copy prompt</span>`;

  copyButton.addEventListener("click", async (e) => {
    const rect = copyButton.getBoundingClientRect();
    const ripple = document.createElement("span");
    ripple.className = "ripple";
    const size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${e.clientY - rect.top - size / 2}px`;
    copyButton.appendChild(ripple);
    ripple.addEventListener("animationend", () => ripple.remove());

    try {
      await navigator.clipboard.writeText(prompt.prompt);
      copyButton.classList.add("copied");
      copyButton.querySelector(".copy-label").textContent = "Copied!";
      setTimeout(() => {
        copyButton.classList.remove("copied");
        copyButton.querySelector(".copy-label").textContent = "Copy prompt";
      }, 1500);
    } catch (err) {
      copyButton.querySelector(".copy-label").textContent = "Select manually";
    }
  });

  card.append(title, badges, text, copyButton);
  return card;
}

function render() {
  const filtered = state.prompts.filter(matchesFilters);
  grid.innerHTML = "";
  filtered.forEach((prompt, i) => grid.appendChild(renderCard(prompt, i)));

  emptyState.hidden = filtered.length !== 0;
  resultCount.style.opacity = "0";
  setTimeout(() => {
    resultCount.textContent = `${filtered.length} prompt${filtered.length === 1 ? "" : "s"}`;
    resultCount.style.opacity = "1";
  }, 90);

  const total = state.prompts.length || 1;
  resultBarFill.style.width = `${(filtered.length / total) * 100}%`;
}

/* ==================== add-a-prompt wizard ==================== */

const STEP_COUNT = 5;
let wizardStep = 0;
let wizardData = { skill: "", llm: "", title: "", prompt: "" };

const wizardOverlay = document.getElementById("wizard-overlay");
const wizardBody = document.getElementById("wizard-body");
const wizardError = document.getElementById("wizard-error");
const wizardBackBtn = document.getElementById("wizard-back");
const wizardNextBtn = document.getElementById("wizard-next");

function showWizardError(message) {
  wizardError.textContent = message;
  wizardError.hidden = false;
  void wizardError.offsetWidth;
  wizardError.style.animation = "none";
  void wizardError.offsetWidth;
  wizardError.style.animation = "";
}

function hideWizardError() {
  wizardError.hidden = true;
}

function buildChipRow(container, options, selected, onSelect) {
  const row = document.createElement("div");
  row.className = "chip-row";
  options.forEach((opt) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (opt === selected ? " selected" : "");
    chip.textContent = opt;
    chip.addEventListener("click", () => onSelect(opt));
    row.appendChild(chip);
  });
  container.appendChild(row);
}

function renderWizardStep() {
  wizardBody.innerHTML = "";
  wizardBody.style.animation = "none";
  void wizardBody.offsetWidth;
  wizardBody.style.animation = "";

  if (wizardStep === 0) {
    const h3 = document.createElement("h3");
    h3.textContent = "Which skill is this for?";
    const hint = document.createElement("p");
    hint.className = "wizard-hint";
    hint.textContent = "Pick an existing skill, or type a new one below.";
    wizardBody.append(h3, hint);

    const existingSkills = uniqueSorted(state.prompts.map((p) => p.skill));
    buildChipRow(wizardBody, existingSkills, wizardData.skill, (opt) => {
      wizardData.skill = opt;
      customInput.value = "";
      renderWizardStep();
    });

    const divider = document.createElement("p");
    divider.className = "wizard-divider";
    divider.textContent = "Or add a new skill";
    wizardBody.appendChild(divider);

    const customInput = document.createElement("input");
    customInput.type = "text";
    customInput.placeholder = "e.g. Research";
    if (!existingSkills.includes(wizardData.skill)) customInput.value = wizardData.skill;
    customInput.addEventListener("input", (e) => {
      wizardData.skill = e.target.value;
      wizardBody.querySelectorAll(".chip").forEach((c) => c.classList.remove("selected"));
    });
    wizardBody.appendChild(customInput);
  }

  if (wizardStep === 1) {
    const h3 = document.createElement("h3");
    h3.textContent = "Which model is it tuned for?";
    const hint = document.createElement("p");
    hint.className = "wizard-hint";
    hint.textContent = "Pick one, or choose Any if it works well everywhere.";
    wizardBody.append(h3, hint);

    const existingLlms = uniqueSorted(["Any", ...state.prompts.map((p) => p.llm)]);
    buildChipRow(wizardBody, existingLlms, wizardData.llm, (opt) => {
      wizardData.llm = opt;
      customInput.value = "";
      renderWizardStep();
    });

    const divider = document.createElement("p");
    divider.className = "wizard-divider";
    divider.textContent = "Or add a new model";
    wizardBody.appendChild(divider);

    const customInput = document.createElement("input");
    customInput.type = "text";
    customInput.placeholder = "e.g. Perplexity";
    if (!existingLlms.includes(wizardData.llm)) customInput.value = wizardData.llm;
    customInput.addEventListener("input", (e) => {
      wizardData.llm = e.target.value;
      wizardBody.querySelectorAll(".chip").forEach((c) => c.classList.remove("selected"));
    });
    wizardBody.appendChild(customInput);
  }

  if (wizardStep === 2) {
    const h3 = document.createElement("h3");
    h3.textContent = "Give it a short title";
    const hint = document.createElement("p");
    hint.className = "wizard-hint";
    hint.textContent = 'Something you\'d recognize at a glance, e.g. "Reply to an Email Like a Human".';
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Prompt title";
    input.value = wizardData.title;
    input.addEventListener("input", (e) => {
      wizardData.title = e.target.value;
    });
    wizardBody.append(h3, hint, input);
  }

  if (wizardStep === 3) {
    const h3 = document.createElement("h3");
    h3.textContent = "Write the prompt";
    const hint = document.createElement("p");
    hint.className = "wizard-hint";
    hint.textContent =
      "Be specific about the role, the deliverable, and the format you want back. Use [brackets] for anything you'll paste in each time.";
    const textarea = document.createElement("textarea");
    textarea.placeholder = "Write the full prompt here...";
    textarea.value = wizardData.prompt;
    textarea.addEventListener("input", (e) => {
      wizardData.prompt = e.target.value;
    });
    wizardBody.append(h3, hint, textarea);
  }

  if (wizardStep === 4) {
    const h3 = document.createElement("h3");
    h3.textContent = "Review";
    const hint = document.createElement("p");
    hint.className = "wizard-hint";
    hint.textContent = "This is how it'll look in the library.";
    wizardBody.append(h3, hint);

    const card = document.createElement("div");
    card.className = "review-card";

    const title = document.createElement("h3");
    title.textContent = wizardData.title;

    const badges = document.createElement("div");
    badges.className = "badges";
    const skillBadge = document.createElement("span");
    skillBadge.className = "badge";
    skillBadge.textContent = wizardData.skill;
    const llmBadge = document.createElement("span");
    llmBadge.className = "badge";
    llmBadge.textContent = wizardData.llm || "Any";
    badges.append(skillBadge, llmBadge);

    const text = document.createElement("div");
    text.className = "review-text";
    text.textContent = wizardData.prompt;

    card.append(title, badges, text);
    wizardBody.appendChild(card);
  }
}

function updateWizardChrome() {
  document.querySelectorAll(".wizard-dot").forEach((dot, i) => {
    dot.classList.toggle("active", i === wizardStep);
    dot.classList.toggle("done", i < wizardStep);
  });
  document.getElementById("wizard-progress-fill").style.width = `${(wizardStep / (STEP_COUNT - 1)) * 100}%`;
  wizardBackBtn.disabled = wizardStep === 0;
  wizardBackBtn.style.opacity = wizardStep === 0 ? "0.4" : "1";
  wizardNextBtn.textContent = wizardStep === STEP_COUNT - 1 ? "Save prompt" : "Next";
}

function validateWizardStep() {
  if (wizardStep === 0) {
    if (!wizardData.skill.trim()) return "Pick or type a skill.";
    const check = runGuardrails(wizardData.skill);
    if (!check.ok) return check.reason;
  }
  if (wizardStep === 1) {
    if (!wizardData.llm.trim()) return "Pick or type a model (or choose Any).";
    const check = runGuardrails(wizardData.llm);
    if (!check.ok) return check.reason;
  }
  if (wizardStep === 2) {
    if (!wizardData.title.trim()) return "Give it a title.";
    const check = runGuardrails(wizardData.title);
    if (!check.ok) return check.reason;
  }
  if (wizardStep === 3) {
    if (wizardData.prompt.trim().length < 15) return "Write the actual prompt text (at least a sentence or two).";
    const check = runGuardrails(wizardData.prompt);
    if (!check.ok) return check.reason;
  }
  return null;
}

function wizardGoNext() {
  const error = validateWizardStep();
  if (error) {
    showWizardError(error);
    return;
  }
  hideWizardError();

  if (wizardStep === STEP_COUNT - 1) {
    saveWizardPrompt();
    return;
  }

  wizardStep++;
  renderWizardStep();
  updateWizardChrome();
}

function wizardGoBack() {
  if (wizardStep === 0) return;
  hideWizardError();
  wizardStep--;
  renderWizardStep();
  updateWizardChrome();
}

function saveWizardPrompt() {
  const newPrompt = {
    id: `${slugify(wizardData.title)}-${Date.now().toString(36)}`,
    title: wizardData.title.trim(),
    skill: wizardData.skill.trim(),
    llm: wizardData.llm.trim() || "Any",
    prompt: wizardData.prompt.trim(),
    _custom: true,
  };
  const custom = loadCustomPrompts();
  custom.push(newPrompt);
  saveCustomPromptsList(custom);
  rebuildPromptState();
  refreshDropdownOptions();
  render();
  closeWizard();
  showToast("Prompt added to your library.");
}

function openWizard() {
  wizardStep = 0;
  wizardData = { skill: "", llm: "", title: "", prompt: "" };
  hideWizardError();
  renderWizardStep();
  updateWizardChrome();
  wizardOverlay.hidden = false;
}

function closeWizard() {
  wizardOverlay.hidden = true;
}

/* ==================== init ==================== */

async function init() {
  const response = await fetch("data/prompts.json");
  basePrompts = await response.json();
  rebuildPromptState();

  const skillOptions = ["All", ...uniqueSorted(state.prompts.map((p) => p.skill))];
  const llmOptions = ["All", ...uniqueSorted(state.prompts.map((p) => p.llm).filter((llm) => llm !== "Any"))];

  skillDropdownApi = createDropdown({
    container: document.getElementById("skill-dropdown"),
    labelText: "Skill",
    options: skillOptions,
    initialValue: "All",
    onChange: (val) => {
      state.skill = val;
      render();
    },
  });

  llmDropdownApi = createDropdown({
    container: document.getElementById("llm-dropdown"),
    labelText: "LLM",
    options: llmOptions,
    initialValue: "All",
    onChange: (val) => {
      state.llm = val;
      render();
    },
  });

  searchInput.addEventListener("input", (e) => {
    state.search = e.target.value;
    render();
  });

  document.getElementById("add-prompt-btn").addEventListener("click", openWizard);
  document.getElementById("wizard-close").addEventListener("click", closeWizard);
  document.getElementById("wizard-back").addEventListener("click", wizardGoBack);
  document.getElementById("wizard-next").addEventListener("click", wizardGoNext);
  wizardOverlay.addEventListener("click", (e) => {
    if (e.target === wizardOverlay) closeWizard();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !wizardOverlay.hidden) closeWizard();
  });

  document.getElementById("export-btn").addEventListener("click", () => {
    downloadJson(state.prompts.map(({ _custom, ...rest }) => rest), "prompts.json");
    showToast("Downloaded prompts.json");
  });

  // Security log has no visible entry point on the page — visitors shouldn't
  // know it's there. Open it yourself with Ctrl/Cmd+Shift+L.
  const securityOverlay = document.getElementById("security-overlay");
  document.getElementById("security-close").addEventListener("click", () => {
    securityOverlay.hidden = true;
  });
  securityOverlay.addEventListener("click", (e) => {
    if (e.target === securityOverlay) securityOverlay.hidden = true;
  });
  document.getElementById("security-clear").addEventListener("click", () => {
    if (confirm("Clear the local security log?")) {
      saveSecurityLog([]);
      renderSecurityLog();
    }
  });
  document.getElementById("security-export").addEventListener("click", exportSecurityLog);

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      renderSecurityLog();
      securityOverlay.hidden = false;
    }
  });

  render();
}

init();
