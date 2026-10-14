import { APP_NAME, APP_VERSION } from "./config.js";
import {
  firebaseEnabled,
  initFirebase,
  signIn,
  signOutUser,
  consumeSyncError,
  listChats,
  saveChat,
  deleteChat,
  loadCloudSettings,
  saveCloudSettings,
} from "./db.js?v=20261013-local-sync";
import { loadSettings, saveSettings, listAllModels, streamChat } from "./providers.js?v=20261013-ai-types-2";
import { brandOf } from "./models.js?v=20261013-brand-logos-3";

const $ = (id) => document.getElementById(id);
const MODEL_KEY = "myai_model";

let settings = loadSettings();
const savedTaskMode = localStorage.getItem("myai_task_mode");
let taskMode = savedTaskMode === "general" ? "auto"
  : ["auto", "coding", "flash", "pro", "max", "image"].includes(savedTaskMode) ? savedTaskMode
    : "auto";
let currentUser = null;
let chats = [];
let chat = newChat();
let abort = null;
let pendingFiles = [];
let composerMode = "";
let processingFiles = false;
let sendAfterProcessing = false;
const generatedImages = new Map();
const modeDrafts = new Map();

function cloudSettingsPayload(value) {
  const { gemini, groq, openrouter, customToken, ...safeSettings } = value;
  return safeSettings;
}

let modelGroups = [];
let models = new Map();
let selected = "";
let modelsToken = 0;
let expandedModelGroup = "";
let expandedModelFamily = "";

const SUGGESTIONS = [
  "Jelaskan cara kerja Transformer (attention) dengan bahasa sederhana",
  "Buatkan kode Python untuk scraping judul berita",
  "Bantu aku belajar JavaScript dari nol, buat rencana 30 hari",
  "Apa beda Qwen, DeepSeek, Gemini, Claude, dan GPT?",
];
const BRAND_STRIP = ["qwen", "deepseek", "gemini", "claude", "gpt", "llama", "mistral", "grok", "kimi", "gemma"];

function newChat(mode = taskMode) {
  return { id: crypto.randomUUID(), title: "Chat baru", taskMode: mode, messages: [], updatedAt: Date.now() };
}

function chatMode(item) {
  return !item.taskMode || item.taskMode === "general" ? "auto" : item.taskMode;
}

// ---------- Logo ----------

function logoEl(text, label, small = false) {
  const span = document.createElement("span");
  span.className = "mlogo" + (small ? " sm" : "");
  const brand = brandOf(text);
  const fallback = () => (span.textContent = (label || "?").trim()[0].toUpperCase());
  if (!brand) {
    fallback();
    return span;
  }
  const img = new Image();
  img.src = brand.src;
  img.alt = "";
  img.loading = "lazy";
  if (brand.mono) img.className = "mono";
  img.onerror = () => {
    img.remove();
    fallback();
  };
  span.append(img);
  return span;
}

// ---------- Rendering ----------

const md = (s) => DOMPurify.sanitize(marked.parse(s || ""));

function thinkingIndicatorHTML(label = "Sedang berpikir") {
  const safeLabel = String(label).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  return `<div class="ai-thinking" role="status" aria-live="polite"><svg class="ai-thinking-star" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2c.6 4.9 2.5 7.4 4.6 8.6 1.3.8 3.1 1.2 5.4 1.4-2.3.2-4.1.6-5.4 1.4-2.1 1.2-4 3.7-4.6 8.6-.6-4.9-2.5-7.4-4.6-8.6-1.3-.8-3.1-1.2-5.4-1.4 2.3-.2 4.1-.6 5.4-1.4C9.5 9.4 11.4 6.9 12 2z"/></svg><span class="ai-thinking-text">${safeLabel}…</span></div>`;
}

function renderContent(m) {
  let think = m.reasoning || "";
  const text = (m.content || "").replace(/<think>([\s\S]*?)(?:<\/think>|$)/g, (_, t) => {
    think += t;
    return "";
  });
  let html = "";
  if (think.trim()) html += `<details class="think"><summary>Proses berpikir</summary>${md(think)}</details>`;
  html += md(text);
  return html;
}

function appendCitations(body, citations = []) {
  const unique = [...new Map(citations.filter((item) => /^https?:\/\//i.test(item.url)).map((item) => [item.url, item])).values()];
  if (!unique.length) return;
  const section = document.createElement("section");
  section.className = "citations";
  const title = document.createElement("strong");
  title.textContent = "Sumber";
  const list = document.createElement("ul");
  for (const citation of unique) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = new URL(citation.url).href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = citation.title || new URL(citation.url).hostname;
    item.append(link);
    list.append(item);
  }
  section.append(title, list);
  body.append(section);
}

function enhance(body) {
  body.querySelectorAll("pre code").forEach((code) => {
    if (window.hljs) hljs.highlightElement(code);
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.type = "button";
    btn.textContent = "Salin";
    btn.onclick = async () => {
      await navigator.clipboard.writeText(code.innerText);
      btn.textContent = "Tersalin!";
      setTimeout(() => (btn.textContent = "Salin"), 1500);
    };
    code.parentElement.append(btn);
  });
}

function appendMessageActions(messageEl, message) {
  if (!messageEl || message.role !== "assistant" || !message.content || messageEl.querySelector(".message-tools")) return;
  const tools = document.createElement("div");
  tools.className = "message-tools";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "message-tool-btn";
  copy.textContent = "⧉ Salin";
  copy.onclick = async () => {
    const cleanAnswer = String(message.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    try {
      await navigator.clipboard.writeText(cleanAnswer);
      copy.textContent = "✓ Tersalin";
      setTimeout(() => { copy.textContent = "⧉ Salin"; }, 1400);
    } catch {
      toast("Clipboard tidak tersedia. Coba buka aplikasi melalui localhost atau HTTPS.");
    }
  };
  tools.append(copy);
  // "Jawab ulang" hanya untuk balasan terakhir, seperti AI pada umumnya.
  if (chat.messages[chat.messages.length - 1] === message) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "message-tool-btn";
    retry.textContent = "↻ Jawab ulang";
    retry.onclick = () => regenerate();
    tools.append(retry);
  }
  messageEl.append(tools);
}

function bubble(m) {
  const el = document.createElement("div");
  el.className = `msg ${m.role}${m.error ? " error" : ""}`;
  if (m.role === "assistant" && m.model) {
    const label = document.createElement("div");
    label.className = "label";
    const name = document.createElement("span");
    name.textContent = m.model;
    label.append(logoEl(`${m.modelId || ""} ${m.model}`, m.model, true), name);
    el.append(label);
  }
  const body = document.createElement("div");
  body.className = "body";
  if (m.role === "user") {
    // Migrate older messages that had raw file contents appended to the visible prompt.
    let visibleText = m.content || "";
    let attachments = Array.isArray(m.attachments) ? m.attachments : [];
    if (!attachments.length && typeof visibleText === "string" && /\n\n\[File: [^\]]+\]\n/.test(visibleText)) {
      const firstFile = visibleText.search(/\n\n\[File: [^\]]+\]\n/);
      attachments = [...visibleText.matchAll(/\n\n\[File: ([^\]]+)\]\n/g)].map((match) => match[1]);
      visibleText = visibleText.slice(0, firstFile).trim();
    }
    if (attachments.length) {
      const chips = document.createElement("div");
      chips.className = "message-attachments";
      chips.setAttribute("aria-label", `${attachments.length} file dilampirkan`);
      const shown = attachments.slice(0, 6);
      for (const attachment of shown) {
        const fullName = typeof attachment === "string" ? attachment : attachment.name;
        const canPreview = attachment && typeof attachment === "object";
        const chip = document.createElement(canPreview ? "button" : "span");
        chip.className = "file-chip";
        chip.title = canPreview ? `Lihat ${fullName}` : fullName;
        if (canPreview) {
          chip.type = "button";
          chip.onclick = () => showAttachmentPreview(attachment);
        }
        const icon = document.createElement("span");
        icon.className = "fc-icon";
        icon.textContent = fileIcon(fullName);
        const label = document.createElement("span");
        label.className = "fc-name";
        label.textContent = String(fullName).split("/").pop();
        chip.append(icon, label);
        chips.append(chip);
      }
      if (attachments.length > shown.length) {
        const more = document.createElement("span");
        more.className = "message-attachments-more";
        more.textContent = `+${attachments.length - shown.length} file lainnya`;
        more.title = attachments.slice(shown.length).map((item) => typeof item === "string" ? item : item.name).join("\n");
        chips.append(more);
      }
      body.append(chips);
    }
    const textEl = document.createElement("span");
    textEl.textContent = visibleText || (attachments.length ? "Tolong analisis lampiran yang saya kirim." : "");
    body.append(textEl);
  } else {
    body.innerHTML = renderContent(m);
    appendCitations(body, m.citations);
    enhance(body);
  }
  el.append(body);
  appendGeneratedImages(body, m.id);
  appendMessageActions(el, m);
  return el;
}

function appendGeneratedImages(body, messageId) {
  for (const [index, src] of (generatedImages.get(messageId) || []).entries()) {
    const image = document.createElement("img");
    image.className = "generated-image";
    image.src = src;
    image.alt = `Gambar hasil ${index + 1}`;
    const download = document.createElement("a");
    download.className = "btn small";
    download.href = src;
    download.download = `myai-image-${index + 1}.png`;
    download.textContent = "Unduh gambar";
    body.append(image, download);
  }
}

function renderWelcome() {
  const wrap = document.createElement("div");
  wrap.className = "welcome";
  wrap.innerHTML = `<img src="assets/mark.svg" alt="" class="welcome-logo" /><h1>Halo! Aku <span class="brand-name"></span></h1><p class="muted">Asisten AI pribadimu — ditenagai model-model terbaru dunia.</p>`;
  wrap.querySelector(".brand-name").textContent = APP_NAME;

  const strip = document.createElement("div");
  strip.className = "brand-strip";
  for (const b of BRAND_STRIP) strip.append(logoEl(b, b));
  wrap.append(strip);

  const suggestions = $("suggestions");
  suggestions.replaceChildren();
  for (const s of SUGGESTIONS) {
    const b = document.createElement("button");
    b.className = "suggestion";
    b.type = "button";
    b.textContent = s;
    b.onclick = () => send(s);
    suggestions.append(b);
  }

  $("messages").append(wrap);
}

function renderMessages() {
  $("messages").innerHTML = "";
  const empty = !chat.messages.length;
  $("chatWrap").classList.toggle("empty", empty);
  if (empty) renderWelcome();
  else for (const m of chat.messages) $("messages").append(bubble(m));
  scrollBottom();
}

function scrollBottom() {
  const box = $("messages");
  const wrap = $("chatWrap");
  if (wrap.classList.contains("empty")) wrap.scrollTop = wrap.scrollHeight;
  box.scrollTop = box.scrollHeight;
}

function renderChatList() {
  const list = $("chatList");
  list.innerHTML = "";
  const query = $("chatSearch").value.trim().toLowerCase();
  for (const c of chats.filter((item) => chatMode(item) === taskMode && (!query || item.title.toLowerCase().includes(query)))) {
    const item = document.createElement("div");
    item.className = "chat-item" + (c.id === chat.id ? " active" : "");
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = c.title;
    const del = document.createElement("button");
    del.className = "del";
    del.title = "Hapus";
    del.textContent = "✕";
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Hapus chat "${c.title}"?`)) return;
      let syncError;
      try {
        syncError = await deleteChat(c.id);
      } catch (error) {
        toast("Gagal menghapus chat dari browser: " + error.message);
        return;
      }
      if (syncError) toast("Chat dihapus dari browser, tetapi gagal dihapus dari cloud: " + syncErrorMessage(syncError, "chat"));
      chats = chats.filter((x) => x.id !== c.id);
      if (c.id === chat.id) chat = newChat(taskMode);
      renderChatList();
      renderMessages();
    };
    item.append(title, del);
    item.onclick = () => {
      if (abort) return;
      chat = structuredClone(c);
      chat.taskMode = chatMode(chat);
      renderChatList();
      renderMessages();
      closeSidebar();
    };
    list.append(item);
  }
}

function renderAccount(user) {
  const box = $("account");
  box.innerHTML = "";
  if (!firebaseEnabled) {
    box.textContent = "Mode lokal (Firebase belum disetel)";
    return;
  }
  if (!user) {
    const btn = document.createElement("button");
    btn.className = "btn block";
    btn.textContent = "Masuk dengan Google";
    btn.onclick = async () => {
      try {
        await signIn();
      } catch (e) {
        if (/popup-closed-by-user|cancelled-popup-request|cancelled/.test(e.code || e.message)) return;
        toast("Gagal masuk: " + e.message);
      }
    };
    box.append(btn);
    return;
  }
  if (user.photoURL) {
    const img = document.createElement("img");
    img.src = user.photoURL;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    box.append(img);
  }
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = user.displayName || user.email;
  const out = document.createElement("button");
  out.className = "btn small ghost";
  out.textContent = "Keluar";
  out.onclick = () => signOutUser();
  box.append(name, out);
}

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 6000);
}

function explainAIError(error) {
  const message = error?.message || String(error);
  const status = Number(message.match(/(?:^|\s)(\d{3}):/)?.[1]);
  if (/run out of funds|insufficient (?:funds|balance)|top up|billing/i.test(message)) return "Saldo AI/ML API habis. Isi saldo provider atau pilih OpenRouter/LLM7.";
  if (status === 401 || status === 403) return "Akses provider ditolak. Periksa kunci API server atau pilih model lain.";
  if (status === 404) return "Model tidak ditemukan atau tidak tersedia untuk akun ini. Pilih model lain.";
  if (status === 429) return "Batas pemakaian tercapai. Tunggu sebentar atau pilih provider/model lain.";
  if (/failed to fetch|networkerror|load failed/i.test(message)) return "Koneksi ke layanan AI gagal. Periksa internet, lalu coba lagi.";
  if (/cors/i.test(message)) return "Browser memblokir koneksi (CORS). Provider perlu mengizinkan domain aplikasi ini.";
  return message;
}

// ---------- Pemilih model ----------

function updateModelBtn() {
  const m = models.get(selected);
  const logo = $("modelBtnLogo");
  if (!m) {
    logo.replaceWith(Object.assign(document.createElement("span"), { id: "modelBtnLogo", className: "mlogo", textContent: "?" }));
    $("modelBtnName").textContent = modelGroups.length ? "Pilih model" : "Belum ada model — buka Pengaturan";
    return;
  }
  const el = logoEl(`${m.id} ${m.name}`, m.name);
  el.id = "modelBtnLogo";
  logo.replaceWith(el);
  $("modelBtnName").textContent = m.name;
}

function isCodingModel(model) {
  return /coder|coding|codegemma|codestral|devstral|starcoder|programmer/i.test(`${model.id} ${model.name}`);
}

function isPaidModel(model) {
  return /premium|berbayar/i.test(`${model.groupLabel || ""} ${model.tag || ""}`);
}

function isMaxModel(model) {
  return /openrouter\/free|pro|reasoning|thinking|70b|large|ultra/i.test(`${model.id} ${model.name}`);
}

function modeModelPattern(mode) {
  if (mode === "flash") return /flash|fast|(?:^|[-/])mini(?:[-/]|$)|lite|haiku|instant|small/i;
  if (mode === "pro") return /pro|sonnet|opus|gpt-4|reasoning|thinking|70b|large/i;
  return null;
}

function modelGroupsForTask(mode = taskMode) {
  const chatGroups = modelGroups.filter((group) => group.provider !== "openrouter-image");
  if (mode === "image") return modelGroups.filter((group) => group.provider === "openrouter-image");
  if (mode === "coding") {
    const codingGroups = chatGroups
      .map((group) => ({ ...group, models: group.models.filter(isCodingModel) }))
      .filter((group) => group.models.length);
    if (codingGroups.length) return codingGroups;
  }
  if (mode === "max") {
    const availableGroups = chatGroups
      .filter((group) => !/premium|berbayar/i.test(`${group.label} ${group.tag}`))
      .map((group) => ({ ...group, models: group.models.filter((model) => !isPaidModel({ ...model, groupLabel: group.label, tag: group.tag })) }))
      .filter((group) => group.models.length);
    if (availableGroups.length) return availableGroups;
  }
  const pattern = modeModelPattern(mode);
  if (pattern) {
    const matchedGroups = chatGroups
      .map((group) => ({ ...group, models: group.models.filter((model) => pattern.test(`${model.id} ${model.name}`)) }))
      .filter((group) => group.models.length);
    if (matchedGroups.length) return matchedGroups;
  }
  return chatGroups;
}

function renderModelList() {
  const q = $("modelSearch").value.trim().toLowerCase();
  const list = $("modelList");
  list.innerHTML = "";
  let count = 0;
  const visibleGroups = modelGroupsForTask();
  if (taskMode === "coding" && !modelGroups.some((group) => group.models.some(isCodingModel))) {
    const note = document.createElement("div");
    note.className = "model-empty";
    note.textContent = "Belum ada model khusus coding di katalog. Model umum tersedia sebagai fallback.";
    list.append(note);
  }

  const renderModelItem = (group, model) => {
    const value = `${group.provider}::${model.id}`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "model-item" + (value === selected ? " selected" : "");
    btn.setAttribute("role", "option");
    btn.dataset.value = value;
    const text = document.createElement("span");
    text.className = "mi-text";
    const name = document.createElement("span");
    name.className = "mi-name";
    name.textContent = model.name;
    const sub = document.createElement("span");
    sub.className = "mi-sub";
    sub.textContent = model.info || model.id;
    text.append(name, sub);
    btn.append(logoEl(`${model.id} ${model.name}`, model.name), text);
    btn.onclick = () => selectModel(value);
    list.append(btn);
    count++;
  };

  for (const g of visibleGroups) {
    const items = g.models.filter((m) => !q || `${m.name} ${m.id} ${g.label}`.toLowerCase().includes(q));
    if (!items.length) continue;
    const groupKey = `${g.provider}::${g.label}`;
    const expanded = Boolean(q) || expandedModelGroup === groupKey;
    const head = document.createElement("button");
    head.type = "button";
    head.className = "model-group-head";
    head.setAttribute("aria-expanded", String(expanded));
    const title = document.createElement("span");
    title.className = "model-group-title";
    title.append(logoEl(`${g.provider} ${g.label}`, g.label, true));
    const label = document.createElement("span");
    label.className = "model-group-label";
    label.textContent = g.label;
    title.append(label);
    const chevron = document.createElement("span");
    chevron.className = "model-group-chevron";
    chevron.textContent = expanded ? "⌄" : "›";
    head.append(title, chevron);
    head.onclick = (event) => {
      event.stopPropagation();
      expandedModelGroup = expandedModelGroup === groupKey ? "" : groupKey;
      renderModelList();
    };
    list.append(head);
    if (!expanded) continue;
    if (g.provider === "openrouter" && g.label === "OpenRouter Gratis") {
      const families = new Map();
      for (const model of items) {
        const owner = model.id === "openrouter/free"
          ? "Auto"
          : model.id.includes("/")
            ? model.id.split("/")[0]
            : model.name.split(/\s+/)[0];
        const family = owner.split(/[-_]/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
        if (!families.has(family)) families.set(family, []);
        families.get(family).push(model);
      }
      for (const [family, familyModels] of [...families.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const familyKey = `${g.provider}::${family}`;
        const familyExpanded = Boolean(q) || expandedModelFamily === familyKey;
        const familyButton = document.createElement("button");
        familyButton.type = "button";
        familyButton.className = "model-family-head";
        familyButton.setAttribute("aria-expanded", String(familyExpanded));
        const familyTitle = document.createElement("span");
        familyTitle.className = "model-family-title";
        familyTitle.append(logoEl(family === "Auto" ? "openrouter" : family, family, true));
        const familyName = document.createElement("span");
        familyName.textContent = family;
        familyTitle.append(familyName);
        const familyCount = document.createElement("span");
        familyCount.textContent = String(familyModels.length);
        familyButton.append(familyTitle, familyCount);
        familyButton.onclick = (event) => {
          event.stopPropagation();
          expandedModelFamily = expandedModelFamily === familyKey ? "" : familyKey;
          renderModelList();
        };
        list.append(familyButton);
        if (familyExpanded) familyModels.forEach((model) => renderModelItem(g, model));
      }
    } else {
      items.forEach((model) => renderModelItem(g, model));
    }
  }
  if (!count) {
    const hasHiddenModels = visibleGroups.some((group) => group.models.length > 0);
    if (!hasHiddenModels || q) {
      const empty = document.createElement("div");
      empty.className = "model-empty";
      empty.textContent = taskMode === "image"
        ? "Belum ada model gambar. Klik Muat semua model API untuk memuat katalog gambar."
        : modelGroups.length ? "Model tidak ditemukan." : "Belum ada model. Pastikan server MyAI sedang berjalan.";
      list.append(empty);
    }
  }
}

function selectModel(value) {
  selected = value;
  localStorage.setItem(MODEL_KEY, value);
  localStorage.setItem(`myai_model_${taskMode}`, value);
  updateModelBtn();
  closeModelMenu();
}

function openModelMenu() {
  $("modelMenu").classList.remove("hidden");
  $("modelBtn").setAttribute("aria-expanded", "true");
  $("modelSearch").value = "";
  expandedModelGroup = "";
  expandedModelFamily = "";
  // Buka otomatis grup yang berisi model aktif (atau grup pertama) agar daftar tidak tampak kosong.
  const visibleGroups = modelGroupsForTask();
  const selectedGroup = visibleGroups.find((group) => group.models.some((model) => `${group.provider}::${model.id}` === selected));
  expandedModelGroup = selectedGroup
    ? `${selectedGroup.provider}::${selectedGroup.label}`
    : visibleGroups.length ? `${visibleGroups[0].provider}::${visibleGroups[0].label}` : "";
  renderModelList();
  $("modelList").querySelector(".selected")?.scrollIntoView({ block: "center" });
  $("modelSearch").focus();
}

function closeModelMenu() {
  $("modelMenu").classList.add("hidden");
  $("modelBtn").setAttribute("aria-expanded", "false");
}

async function loadModels(preferredProvider = "", includeCatalog = false) {
  const token = ++modelsToken;
  $("modelBtnName").textContent = "Memuat model…";
  const { groups, errors } = await listAllModels(settings, { includeCatalog });
  if (token !== modelsToken) return { activeModel: null, errors: [] };
  modelGroups = groups;
  models = new Map();
  for (const g of groups) {
    for (const m of g.models) models.set(`${g.provider}::${m.id}`, { ...m, provider: g.provider, groupLabel: g.label, tag: g.tag });
  }
  const saved = localStorage.getItem(MODEL_KEY);
  const savedForTask = localStorage.getItem(`myai_model_${taskMode}`);
  const available = new Set(modelGroupsForTask().flatMap((group) => group.models.map((model) => `${group.provider}::${model.id}`)));
  const preferred = preferredProvider
    ? [...models.keys()].find((key) => key.startsWith(`${preferredProvider}::`) && available.has(key))
    : "";
  const codingPreferred = taskMode === "coding"
    ? [...available].find((key) => isCodingModel(models.get(key)))
    : "";
  const qualityPattern = modeModelPattern(taskMode);
  const qualityPreferred = qualityPattern
    ? [...available].find((key) => qualityPattern.test(`${models.get(key)?.id} ${models.get(key)?.name}`))
    : "";
  const maxPreferred = taskMode === "max"
    ? [...available].find((key) => /openrouter\/free/i.test(key)) || [...available].find((key) => isMaxModel(models.get(key)))
    : "";
  selected = preferred || (available.has(savedForTask) ? savedForTask : "") || codingPreferred || maxPreferred || qualityPreferred ||
    (available.has(selected) ? selected : available.has(saved) ? saved : available.values().next().value || "");
  updateModelBtn();
  if (!$("modelMenu").classList.contains("hidden")) renderModelList();
  if (errors.length && !includeCatalog) toast("Sebagian model gagal dimuat: " + errors.join(" | "));
  return { activeModel: models.get(selected) || null, errors };
}

async function refreshModelCatalog() {
  const button = $("refreshModelsBtn");
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = "Memuat katalog API…";
  try {
    const { errors } = await loadModels("", true);
    const count = modelGroups
      .filter((group) => group.tag.startsWith("Katalog API"))
      .reduce((total, group) => total + group.models.length, 0);
    toast(errors.length
      ? `Katalog parsial: ${count} model dimuat. ${errors.join(" | ")}`
      : `Katalog API berhasil dimuat: ${count} model.`);
  } catch (error) {
    toast("Gagal memuat katalog model: " + (error.message || error));
  } finally {
    button.disabled = false;
    button.textContent = "Muat semua model API";
  }
}

// ---------- Chat ----------

function showProgress(report) {
  $("progress").classList.remove("hidden");
  $("progressFill").style.width = `${Math.round((report.progress || 0) * 100)}%`;
  $("progressText").textContent = report.text || "Memuat model…";
}

function setBusy(busy) {
  const btn = $("sendBtn");
  btn.textContent = busy ? "■" : "↑";
  btn.setAttribute("aria-label", busy ? "Hentikan" : "Kirim");
  btn.title = busy ? "Hentikan jawaban" : "Kirim pesan";
  btn.classList.toggle("danger", busy);
  btn.classList.toggle("primary", !busy);
  if (!busy) updateSendBtn();
  else btn.classList.remove("idle");
}

// Tombol kirim tampak nonaktif (abu) saat tidak ada yang bisa dikirim,
// seperti composer AI pada umumnya.
function updateSendBtn() {
  const btn = $("sendBtn");
  if (!btn || abort) return;
  const canSend = Boolean($("input").value.trim() || pendingFiles.length);
  btn.classList.toggle("idle", !canSend);
}

function setComposerMode(mode) {
  composerMode = mode;
  const imageModeActive = !mode && taskMode === "image";
  $("modeStatus").classList.toggle("hidden", !mode && !imageModeActive);
  $("modeLabel").textContent = mode === "image"
    ? "Generasi gambar memakai kuota/biaya provider. Unduh hasil untuk menyimpannya sebelum tab ditutup."
    : imageModeActive
      ? "Generasi gambar dapat memakai kuota atau biaya provider. Periksa tarif model sebelum membuat gambar."
    : mode === "research"
      ? "Riset web aktif. Biaya pencarian dapat berlaku."
      : mode === "web"
        ? "Pencarian web aktif. Biaya pencarian dapat berlaku."
        : "";
}

function modeDraftTextKey(mode) {
  return `myai_draft_${mode}_text`;
}

function modeDraftFilesKey(mode) {
  return `myai_draft_${mode}_files`;
}

function saveModeDraft(mode = taskMode, saveFiles = false) {
  const input = $("input");
  const existing = modeDrafts.get(mode);
  const files = saveFiles || !existing ? pendingFiles : existing.files;
  const draft = { text: input?.value || "", files: Array.isArray(files) ? files : [] };
  modeDrafts.set(mode, draft);
  try { localStorage.setItem(modeDraftTextKey(mode), draft.text); } catch { /* memory copy remains available */ }
  if (saveFiles || !existing) {
    try { localStorage.setItem(modeDraftFilesKey(mode), JSON.stringify(draft.files)); } catch { /* memory copy remains available */ }
  }
}

function clearModeDraft(mode = taskMode) {
  modeDrafts.delete(mode);
  try {
    localStorage.removeItem(modeDraftTextKey(mode));
    localStorage.removeItem(modeDraftFilesKey(mode));
    localStorage.removeItem(`myai_draft_${mode}`); // clean up drafts saved by the earlier format
  } catch { /* storage may be disabled */ }
}

function restoreModeDraft(mode) {
  const input = $("input");
  let draft = modeDrafts.get(mode);
  if (!draft) {
    try {
      const savedText = localStorage.getItem(modeDraftTextKey(mode));
      const savedFiles = localStorage.getItem(modeDraftFilesKey(mode));
      if (savedText !== null || savedFiles !== null) {
        draft = { text: savedText || "", files: savedFiles ? JSON.parse(savedFiles) : [] };
      } else {
        // Migrate any draft created by an earlier repair build.
        const raw = localStorage.getItem(`myai_draft_${mode}`);
        draft = raw ? JSON.parse(raw) : null;
      }
    } catch { draft = null; }
  }
  if (!draft || typeof draft !== "object") draft = { text: "", files: [] };
  input.value = typeof draft.text === "string" ? draft.text : "";
  pendingFiles = Array.isArray(draft.files) ? draft.files : [];
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  renderAttachmentList();
  saveModeDraft(mode, true);
}

function setTaskMode(mode, notify = true) {
  if (!["auto", "coding", "flash", "pro", "max", "image"].includes(mode)) return;
  if (abort && mode !== taskMode) {
    if (notify) toast("Selesaikan atau hentikan jawaban sebelum berpindah segmen.");
    return;
  }
  const previousMode = taskMode;
  if (mode !== previousMode) saveModeDraft(previousMode);
  const previousModel = models.get(selected);
  taskMode = mode;
  localStorage.setItem("myai_task_mode", mode);
  const modeLabels = { auto: "Auto", coding: "Coding", flash: "Flash", pro: "Pro", max: "Max", image: "Gambar" };
  const modeIcons = { auto: "✦", coding: "{ }", flash: "ϟ", pro: "◇", max: "◆", image: "▧" };
  $("taskModeLabel").textContent = modeLabels[mode];
  $("taskModeIcon").textContent = modeIcons[mode];
  $("taskModeMenu").classList.add("hidden");
  $("taskModeBtn").setAttribute("aria-expanded", "false");
  document.querySelectorAll("#taskModeMenu [data-mode]").forEach((button) => {
    button.setAttribute("aria-checked", String(button.dataset.mode === mode));
  });
  setComposerMode("");
  const available = modelGroupsForTask().flatMap((group) => group.models.map((model) => `${group.provider}::${model.id}`));
  const saved = localStorage.getItem(`myai_model_${mode}`);
  const preferredModel = mode === "coding"
    ? available.find((key) => isCodingModel(models.get(key)))
    : mode === "image"
      ? available[0]
      : mode === "max"
        ? available.find((key) => /openrouter\/free/i.test(key)) || available.find((key) => isMaxModel(models.get(key)))
        : modeModelPattern(mode)
          ? available.find((key) => modeModelPattern(mode).test(`${models.get(key)?.id} ${models.get(key)?.name}`))
          : "";
  const autoSwitchFromPaid = mode === "max" && isPaidModel(previousModel);
  selected = autoSwitchFromPaid
    ? preferredModel || available.find((key) => models.get(key)?.provider !== "local") || available[0] || ""
    : available.includes(saved) && !isPaidModel(models.get(saved))
      ? saved
      : preferredModel || (available.includes(selected) ? selected : available[0] || selected);
  if (selected) {
    localStorage.setItem(MODEL_KEY, selected);
    localStorage.setItem(`myai_model_${mode}`, selected);
  }
  updateModelBtn();
  if (!$ ("modelMenu").classList.contains("hidden")) renderModelList();
  const input = $("input");
  restoreModeDraft(mode);
  chat = chats.find((item) => chatMode(item) === mode) || newChat(mode);
  renderChatList();
  renderMessages();
  closeSidebar();
  input.focus();
  $("input").placeholder = mode === "coding"
    ? "Jelaskan masalah coding yang ingin diselesaikan…"
    : mode === "image"
      ? "Deskripsikan gambar yang ingin dibuat…"
      : mode === "flash"
        ? "Tulis pertanyaan singkat…"
        : mode === "pro" || mode === "max"
          ? "Jelaskan tugas yang perlu dianalisis…"
          : "Tanyakan apa saja…";
  if (notify && autoSwitchFromPaid) toast(`Model berbayar dialihkan ke opsi Max lain: ${models.get(selected)?.name || "model tersedia"}.`);
  if (notify && mode === "image") toast("Mode Gambar aktif. Pilih model OpenRouter Image dari katalog.");
}

async function persist() {
  chat.updatedAt = Date.now();
  try {
    // Persist the visible conversation only. File contents can be large or private;
    // they stay in memory for follow-up prompts during this tab session.
    const durableChat = structuredClone(chat);
    for (const message of durableChat.messages || []) {
      delete message.modelContent;
      delete message.images;
      if (Array.isArray(message.attachments)) {
        message.attachments = message.attachments.map((item) => typeof item === "string" ? item : item.name);
      }
    }
    const syncError = await saveChat(durableChat);
    if (syncError) toast("Chat tersimpan di browser, tetapi gagal disinkronkan: " + syncErrorMessage(syncError, "chat"));
  } catch (e) {
    toast("Gagal menyimpan chat: " + e.message);
  }
  chats = [structuredClone(chat), ...chats.filter((c) => c.id !== chat.id)];
  renderChatList();
}

async function send(text) {
  text = text.trim();
  if ((!text && !pendingFiles.length) || abort) return;
  const submittedText = text;
  const filesForMessage = pendingFiles.slice();
  const visiblePrompt = submittedText || "Tolong analisis lampiran yang saya kirim.";
  // Keep context compact and predictable for providers with smaller context windows.
  const MAX_ATTACHMENT_CONTEXT_CHARS = 240000;
  let usedContextChars = 0;
  let contextWasTrimmed = false;
  const fileContext = filesForMessage.map((file) => {
    const raw = typeof file.content === "string" ? file.content : "[Lampiran visual]";
    const remaining = Math.max(0, MAX_ATTACHMENT_CONTEXT_CHARS - usedContextChars);
    const content = raw.slice(0, remaining);
    if (content.length < raw.length) contextWasTrimmed = true;
    usedContextChars += content.length;
    return `\n\n[File: ${file.name}]\n${content}`;
  }).join("");
  const modelPrompt = `${visiblePrompt}${fileContext}`;

  const input = $("input");
  if (input.value.trim() === submittedText) {
    input.value = "";
    input.style.height = "auto";
  }
  const allImages = filesForMessage.flatMap((file) => file.images || []);
  const images = allImages.slice(0, 10);
  if (allImages.length > images.length) toast("Maksimal 10 gambar dikirim dalam satu pertanyaan; gambar sisanya dilewati.");
  setComposerMode("");

  if (!chat.messages.length) chat.title = visiblePrompt.slice(0, 48) || "Analisis lampiran";
  chat.messages.push({
    role: "user",
    content: visiblePrompt,
    modelContent: modelPrompt,
    images,
    attachments: filesForMessage.slice(0, 120).map((file) => ({
      name: file.name,
      content: file.content,
      images: file.images || [],
    })),
  });
  pendingFiles = [];
  renderAttachmentList();
  clearModeDraft(taskMode);
  updateSendBtn();
  if (contextWasTrimmed) toast("Sebagian isi lampiran dipotong agar permintaan tetap ringkas untuk model.");
  await respond();
}

// Bangun konteks dari pesan yang sudah ada (pesan terakhir harus dari pengguna),
// lalu streaming jawaban asisten. Dipakai oleh send() dan "Jawab ulang".
async function respond() {
  const last = chat.messages[chat.messages.length - 1];
  if (!last || last.role !== "user") return;

  const requestMode = composerMode;
  const webSearch = requestMode === "web" || requestMode === "research";
  const imageGeneration = requestMode === "image" || taskMode === "image";
  const m = models.get(selected);
  const imageProvider = m?.provider;

  const failInline = async (message) => {
    chat.messages.push({ id: crypto.randomUUID(), role: "assistant", content: `**${message}**\n\nCoba pilih model lain, lalu klik *Jawab ulang* di bawah pesan ini.`, error: true, model: APP_NAME });
    renderMessages();
    await persist();
  };
  if (!m) {
    await failInline("Belum ada model AI yang aktif, jadi pertanyaanmu belum bisa dijawab.");
    toast("Server AI belum menyediakan model. Jalankan MyAI dengan npm start.");
    return;
  }
  if (imageGeneration && imageProvider !== "openrouter-image") {
    await failInline("Pilih model OpenRouter Image untuk membuat gambar.");
    return;
  }
  if (!imageGeneration && m.provider === "local" && (last.images || []).length) {
    await failInline("Lampiran gambar memerlukan model vision API, bukan model lokal.");
    return;
  }
  if (webSearch && m.provider !== "openrouter") {
    await failInline("Pencarian web membutuhkan model OpenRouter.");
    return;
  }

  const context = [];
  if (settings.systemPrompt) context.push({ role: "system", content: settings.systemPrompt });
  if (taskMode === "coding" && !imageGeneration) {
    context.push({ role: "system", content: "Mode Coding aktif. Utamakan solusi teknis yang benar, kode siap pakai, penjelasan singkat, dan sebutkan asumsi atau risiko. Gunakan blok kode dengan bahasa yang sesuai." });
  }
  if (taskMode === "flash" && !imageGeneration) {
    context.push({ role: "system", content: "Mode Flash aktif. Jawab langsung, ringkas, dan fokus pada inti. Gunakan daftar hanya jika membantu." });
  }
  if (taskMode === "pro" && !imageGeneration) {
    context.push({ role: "system", content: "Mode Pro aktif. Analisis permintaan dengan cermat, susun jawaban terstruktur, jelaskan asumsi, dan verifikasi detail penting sebelum menyimpulkan." });
  }
  if (taskMode === "max" && !imageGeneration) {
    context.push({ role: "system", content: "Mode Max aktif. Berikan jawaban paling menyeluruh yang dapat dilakukan model terpilih; periksa alternatif, batasan, dan biaya sebelum merekomendasikan tindakan." });
  }
  for (const msg of chat.messages) {
    if (msg.error) continue;
    const priorContent = typeof msg.modelContent === "string" ? msg.modelContent : msg.content;
    context.push({
      role: msg.role,
      content: (priorContent || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim(),
      ...(Array.isArray(msg.images) && msg.images.length ? { images: msg.images } : {}),
    });
  }

  const reply = { id: crypto.randomUUID(), role: "assistant", content: "", reasoning: "", model: m.name, modelId: m.id };
  chat.messages.push(reply);
  renderMessages();

  const body = $("messages").lastElementChild.querySelector(".body");
  body.innerHTML = thinkingIndicatorHTML("Sedang menyiapkan jawaban");

  abort = new AbortController();
  setBusy(true);
  let frame = 0;
  try {
    const stream = streamChat(imageGeneration ? imageProvider : m.provider, m.id, context, {
      settings,
      temperature: Number(settings.temperature),
      onProgress: showProgress,
      webSearch,
      researchMode: requestMode === "research",
      imageGeneration,
      imageProvider,
    }, abort.signal);
    for await (const chunk of stream) {
      $("progress").classList.add("hidden");
      if (chunk.content) reply.content += chunk.content;
      if (chunk.reasoning) reply.reasoning += chunk.reasoning;
      if (chunk.citation) (reply.citations ||= []).push(chunk.citation);
      if (chunk.image) generatedImages.set(reply.id, [...(generatedImages.get(reply.id) || []), chunk.image]);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const hasOutput = Boolean(reply.content || reply.reasoning);
        body.innerHTML = hasOutput
          ? renderContent(reply) + '<span class="typing"></span>'
          : thinkingIndicatorHTML("Sedang berpikir");
        scrollBottom();
      });
    }
  } catch (e) {
    if (e.name !== "AbortError") {
      reply.error = true;
      const message = explainAIError(e);
      reply.content += `\n\n**Tidak dapat menjawab:** ${message}`;
      toast(message);
    }
  } finally {
    cancelAnimationFrame(frame);
    abort = null;
    setBusy(false);
    $("progress").classList.add("hidden");
    if (!reply.content && !reply.reasoning) reply.content = "_(dihentikan)_";
    body.innerHTML = renderContent(reply);
    appendCitations(body, reply.citations);
    appendGeneratedImages(body, reply.id);
    body.parentElement.classList.toggle("error", !!reply.error);
    enhance(body);
    appendMessageActions(body.parentElement, reply);
    scrollBottom();
    await persist();
  }
}

// Jawab ulang: hapus balasan asisten terakhir, lalu minta jawaban baru
// untuk pertanyaan pengguna yang sama (konteks lampiran ikut terbawa).
async function regenerate() {
  if (abort) return;
  while (chat.messages.length && chat.messages[chat.messages.length - 1].role === "assistant") {
    chat.messages.pop();
  }
  if (!chat.messages.length) return;
  renderMessages();
  await respond();
}

// ---------- Pengaturan ----------

function openSettings() {
  const f = $("settingsForm");
  f.showPaid.checked = settings.showPaid;
  f.localModels.checked = Boolean(settings.localModels);
  f.systemPrompt.value = settings.systemPrompt;
  f.temperature.value = settings.temperature;
  $("tempValue").textContent = settings.temperature;
  $("syncNote").textContent = currentUser
    ? `Preferensi tersinkron ke akun ${currentUser.email}. Kunci API tetap aman di server.`
    : "Kunci API dikelola otomatis oleh server dan tidak disimpan di browser.";
  $("settingsDialog").showModal();
}

function withSyncTimeout(promise, timeoutMs = 8000) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Firebase tidak memberi konfirmasi tepat waktu.");
      error.code = "sync-timeout";
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function syncErrorMessage(error, resource = "settings") {
  if (error?.code === "sync-timeout") {
    return "Firebase belum merespons setelah 8 detik. Pengaturan tetap tersimpan di browser; periksa koneksi dan Rules, lalu coba lagi.";
  }
  const code = error?.code || "";
  if (/permission-denied$/.test(code)) {
    if (resource === "chat") {
      return "Firestore menolak akses riwayat. Pastikan Rules mengizinkan path users/{uid}/chats/{chatId} untuk UID yang login.";
    }
    return "Firestore menolak akses. Publikasikan firestore.rules di project yang sama dengan js/config.js dan pastikan akun login menulis ke path users/{uid}/private/settings.";
  }
  if (/unauthenticated$/.test(code)) return "Sesi Firebase tidak valid. Keluar lalu masuk kembali sebelum menyinkronkan.";
  if (/unavailable|network-request-failed$/.test(code)) return "Firestore tidak dapat dijangkau. Periksa koneksi internet lalu coba lagi.";
  if (/failed-precondition$/.test(code)) return "Firestore belum siap. Pastikan database Firestore sudah dibuat di Firebase Console.";
  return error?.message || String(error);
}

async function onSettingsSubmit(e) {
  e.preventDefault();
  const f = $("settingsForm");
  settings = {
    showPaid: f.showPaid.checked,
    localModels: f.localModels.checked,
    systemPrompt: f.systemPrompt.value,
    temperature: Number(f.temperature.value),
  };
  try {
    saveSettings(settings);
  } catch (error) {
    toast("Gagal menyimpan pengaturan di browser: " + error.message);
    return;
  }
  const { activeModel } = await loadModels("openrouter");
  if (!chat.messages.length) renderMessages();
  if (!currentUser) {
    $("settingsDialog").close();
    toast(`Pengaturan tersimpan. Model aktif: ${activeModel?.name || "belum ada"}. Masuk untuk menyinkronkan preferensi akun.`);
    return;
  }

  const saveButton = f.querySelector('button[type="submit"]');
  saveButton.disabled = true;
  saveButton.textContent = "Menyinkronkan…";
  $("settingsDialog").close();
  toast("Pengaturan tersimpan di browser. Sinkronisasi akun sedang berlangsung…");
  try {
    await withSyncTimeout(saveCloudSettings(cloudSettingsPayload(settings)));
    toast(`Pengaturan tersinkron. Model aktif: ${activeModel?.name || "belum ada"}.`);
  } catch (error) {
    const message = syncErrorMessage(error);
    $("syncNote").textContent = `Pengaturan lokal tersimpan, tetapi sinkronisasi gagal: ${message}`;
    toast("Gagal sinkron ke akun: " + message);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Simpan";
  }
}

// Saat login: ambil preferensi dari akun; API key hanya dikelola server.
async function syncSettings() {
  try {
    const cloud = await withSyncTimeout(loadCloudSettings());
    if (cloud) {
      settings = { ...settings, ...cloudSettingsPayload(cloud) };
      saveSettings(settings);
      toast("Pengaturan akun dimuat. API sudah terhubung otomatis.");
      return true;
    }
    await withSyncTimeout(saveCloudSettings(cloudSettingsPayload(settings)));
  } catch (e) {
    toast("Gagal memuat pengaturan akun: " + syncErrorMessage(e));
  }
  return false;
}

// ---------- Sidebar (mobile) ----------

function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("backdrop").classList.remove("show");
}

// ---------- Init ----------

function applyTheme(theme) {
  const chosen = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = chosen;
  localStorage.setItem("myai_theme", chosen);
  const label = chosen === "dark" ? "☀️" : "🌙";
  ["themeToggle", "landingTheme"].forEach((id) => {
    const el = $(id);
    if (el) { el.textContent = label; el.title = chosen === "dark" ? "Aktifkan tema terang" : "Aktifkan tema gelap"; }
  });
}

function enterApp() {
  $("landing").classList.add("hidden");
  if ($("loginDialog").open) $("loginDialog").close();
}

async function handleGoogleLogin() {
  if (!firebaseEnabled) {
    $("loginError").textContent = "Firebase belum dikonfigurasi. Periksa js/config.js.";
    $("loginError").classList.remove("hidden");
    return;
  }
  try {
    await signIn();
    enterApp();
  } catch (e) {
    if (/popup-closed-by-user|cancelled-popup-request|cancelled/.test(e.code || e.message)) return;
    $("loginError").textContent = "Gagal masuk: " + (e.message || "Coba lagi.");
    $("loginError").classList.remove("hidden");
  }
}

function fileIcon(name = "") {
  const types = [
    [/\.(png|jpe?g|gif|webp|bmp|svg)$/i, "🖼️"],
    [/\.pdf$/i, "📕"],
    [/\.(docx?|odt|rtf)$/i, "📘"],
    [/\.(xlsx?|csv|ods)$/i, "📊"],
    [/\.(pptx?|odp)$/i, "📽️"],
    [/\.(zip|rar|7z|tar|gz)$/i, "🗜️"],
    [/\.(js|ts|jsx|tsx|py|java|c|cpp|h|css|html?|json|sql|ya?ml|xml|sh)$/i, "📜"],
  ];
  return (types.find(([pattern]) => pattern.test(name)) || [null, "📄"])[1];
}

function showAttachmentPreview(file) {
  const dialog = $("previewDialog");
  const body = $("previewBody");
  const name = String(file?.name || "Lampiran").split("/").pop();
  $("previewTitle").textContent = name;
  body.replaceChildren();
  if (file?.images?.[0]) {
    const image = document.createElement("img");
    image.src = file.images[0];
    image.alt = `Pratinjau ${name}`;
    body.append(image);
  } else if (file?.content) {
    const preview = document.createElement("pre");
    preview.textContent = file.content;
    body.append(preview);
  } else {
    const empty = document.createElement("p");
    empty.className = "preview-empty";
    empty.textContent = "Pratinjau tidak tersedia untuk format ini.";
    body.append(empty);
  }
  dialog.showModal();
}

async function readUploadedFile(file) {
  const maxBytes = 8 * 1024 * 1024;
  if (file.size > maxBytes) throw new Error(`${file.name}: ukuran maksimal 8 MB.`);
  const ext = file.name.split(".").pop().toLowerCase();
  if (["docx", "xlsx", "pptx"].includes(ext)) {
    const JSZip = (await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm")).default;
    const archive = await JSZip.loadAsync(await file.arrayBuffer());
    const readXml = async (path) => {
      const entry = archive.file(path);
      return entry ? new DOMParser().parseFromString(await entry.async("text"), "application/xml") : null;
    };
    const textNodes = (xml, tag) => [...(xml?.getElementsByTagNameNS("*", tag) || [])].map((node) => node.textContent).join("");
    let content = "";
    if (ext === "docx") {
      const xml = await readXml("word/document.xml");
      content = [...(xml?.getElementsByTagNameNS("*", "p") || [])]
        .map((paragraph) => textNodes(paragraph, "t"))
        .filter(Boolean)
        .join("\n");
    } else if (ext === "pptx") {
      const slides = Object.keys(archive.files)
        .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
        .sort((leftPath, rightPath) => Number(leftPath.match(/slide(\d+)/)[1]) - Number(rightPath.match(/slide(\d+)/)[1]));
      for (const path of slides.slice(0, 100)) {
        const xml = await readXml(path);
        const paragraphs = [...(xml?.getElementsByTagNameNS("*", "p") || [])]
          .map((paragraph) => textNodes(paragraph, "t"))
          .filter(Boolean);
        content += `\n[${path.split("/").pop()}]\n${paragraphs.join("\n")}`;
      }
    } else {
      const sharedXml = await readXml("xl/sharedStrings.xml");
      const shared = [...(sharedXml?.getElementsByTagNameNS("*", "si") || [])]
        .map((item) => textNodes(item, "t"));
      const sheets = Object.keys(archive.files).filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path)).sort();
      for (const path of sheets) {
        const xml = await readXml(path);
        const rows = [...(xml?.getElementsByTagNameNS("*", "row") || [])].map((row) =>
          [...row.getElementsByTagNameNS("*", "c")].map((cell) => {
            const value = cell.getElementsByTagNameNS("*", "v")[0]?.textContent || textNodes(cell, "t");
            return cell.getAttribute("t") === "s" ? shared[Number(value)] || "" : value;
          }).join("\t")
        );
        content += `\n[Lembar ${path.split("/").pop()}]\n${rows.join("\n")}`;
      }
    }
    if (!content.trim()) throw new Error(`${file.name}: tidak ada teks yang dapat dibaca.`);
    return { name: file.name, content: content.slice(0, 100000) };
  }
  if (ext === "zip") {
    const JSZip = (await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm")).default;
    const archive = await JSZip.loadAsync(await file.arrayBuffer());
    const entries = Object.values(archive.files).filter(x => !x.dir && !x.name.startsWith("__MACOSX/") && !x.name.split("/").some(part => part.startsWith(".")));
    if (!entries.length) throw new Error(`${file.name}: ZIP tidak berisi file yang bisa dibaca.`);
    const results = [];
    for (const entry of entries.slice(0, 40)) {
      const ext = entry.name.split(".").pop().toLowerCase();
      const supported = ["txt","md","csv","json","html","htm","xml","js","ts","jsx","tsx","css","py","java","c","cpp","h","sql","yaml","yml","log","docx","xlsx","pptx"];
      if (supported.includes(ext) || ext === "pdf") {
        const blob = await entry.async("blob");
        const nested = new File([blob], entry.name.split("/").pop(), { type: ext === "pdf" ? "application/pdf" : "text/plain" });
        try { const parsed = await readUploadedFile(nested); results.push(`[Isi arsip: ${entry.name}]\n${parsed.content}`); } catch {}
      }
    }
    if (!results.length) throw new Error(`${file.name}: ZIP terbaca, tetapi tidak ditemukan dokumen teks/PDF yang didukung.`);
    return { name: file.name, content: results.join("\n\n").slice(0, 100000) };
  }
  if (/^(png|jpe?g|gif|webp|bmp|svg)$/i.test(ext)) {
    const image = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error(`${file.name}: gambar gagal dibaca.`));
      reader.readAsDataURL(file);
    });
    return { name: file.name, content: "[Gambar dilampirkan untuk dianalisis.]", images: [image] };
  }
  if (ext === "pdf") {
    const pdfjs = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    let content = "";
    for (let n = 1; n <= Math.min(doc.numPages, 40); n++) {
      const page = await doc.getPage(n);
      const data = await page.getTextContent();
      content += `\n[Halaman ${n}] ` + data.items.map(x => x.str).join(" ");
    }
    return { name: file.name, content: content.slice(0, 100000) };
  }
  const content = await file.text();
  if (content.includes("\u0000")) {
    return { name: file.name, content: `[File biner ${file.type || ext || "tanpa tipe"}, ukuran ${file.size} byte. Isi tidak dapat diubah menjadi teks.]` };
  }
  return { name: file.name, content: content.slice(0, 100000) };
}

function renderAttachmentList() {
  const wrap = $("attachmentList");
  if (!wrap) return;
  wrap.replaceChildren();
  wrap.classList.toggle("hidden", pendingFiles.length === 0);
  const visibleCount = pendingFiles.length > 8 ? 6 : pendingFiles.length;
  pendingFiles.slice(0, visibleCount).forEach((file, index) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    const displayName = String(file.name || "Lampiran").split("/").pop();
    const open = document.createElement("button");
    open.type = "button";
    open.className = "attachment-open";
    open.title = `Lihat ${file.name || displayName}`;
    open.onclick = () => showAttachmentPreview(file);
    const icon = document.createElement("span");
    icon.textContent = fileIcon(displayName);
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = displayName;
    open.append(icon, name);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.textContent = "×";
    remove.title = "Hapus lampiran";
    remove.setAttribute("aria-label", `Hapus ${displayName}`);
    remove.onclick = () => { pendingFiles.splice(index, 1); renderAttachmentList(); };
    chip.append(open, remove);
    wrap.append(chip);
  });
  if (pendingFiles.length > visibleCount) {
    const more = document.createElement("span");
    more.className = "attachment-chip attachment-more";
    more.textContent = `+ ${pendingFiles.length - visibleCount} file lainnya`;
    more.title = pendingFiles.slice(visibleCount).map((file) => file.name).join("\n");
    wrap.append(more);
  }
  if (pendingFiles.length > 1) {
    const clear = document.createElement("button");
    clear.className = "attachment-clear-all";
    clear.type = "button";
    clear.textContent = "Hapus semua";
    clear.onclick = () => { pendingFiles = []; renderAttachmentList(); };
    wrap.append(clear);
  }
  saveModeDraft(taskMode, true);
  updateSendBtn();
}

function readFileLibrary() {
  try {
    const files = JSON.parse(localStorage.getItem("myai_file_library") || "[]");
    return Array.isArray(files) ? files : [];
  } catch {
    return [];
  }
}

function bindEvents() {
  applyTheme(localStorage.getItem("myai_theme") || "light");
  setTaskMode(taskMode, false);
  $("taskModeBtn").onclick = (event) => {
    event.stopPropagation();
    const menu = $("taskModeMenu");
    menu.classList.toggle("hidden");
    $("taskModeBtn").setAttribute("aria-expanded", String(!menu.classList.contains("hidden")));
  };
  document.querySelectorAll("#taskModeMenu [data-mode]").forEach((button) => {
    button.onclick = () => setTaskMode(button.dataset.mode);
  });
  $("chatSearch").addEventListener("input", renderChatList);
  $("searchChats").onclick = () => {
    const search = $("chatSearch");
    search.classList.toggle("hidden");
    if (search.classList.contains("hidden")) {
      search.value = "";
      renderChatList();
    } else {
      search.focus();
    }
  };
  $("openImageMode").onclick = () => setTaskMode("image");
  $("openFiles").onclick = () => $("fileInput").click();
  $("themeToggle").onclick = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  $("landingTheme").onclick = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  $("landingLogin").onclick = () => {
    $("loginError").classList.add("hidden");
    $("loginDialog").showModal();
  };
  $("loginGoogle").onclick = handleGoogleLogin;
  $("loginGuest").onclick = enterApp;
  $("landingGuest").onclick = enterApp;
  $("closeLogin").onclick = () => $("loginDialog").close();
  $("closePreview").onclick = () => $("previewDialog").close();
  $("settingsBtn").onclick = openSettings;
  $("closeSettings").onclick = () => $("settingsDialog").close();
  $("cancelSettings").onclick = () => $("settingsDialog").close();
  $("settingsForm").addEventListener("submit", onSettingsSubmit);
  $("settingsForm").temperature.addEventListener("input", (event) => {
    $("tempValue").textContent = event.target.value;
  });

  const input = $("input");
  const attachMenu = $("attachMenu");
  $("attachBtn").onclick = (event) => {
    event.stopPropagation();
    attachMenu.classList.toggle("hidden");
    $("attachBtn").setAttribute("aria-expanded", String(!attachMenu.classList.contains("hidden")));
  };
  attachMenu.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    attachMenu.classList.add("hidden");
    $("attachBtn").setAttribute("aria-expanded", "false");
    if (button.dataset.action === "folder") $("folderInput").click();
    else $("fileInput").click();
  });
  const sketchDialog = $("sketchDialog");
  const canvas = $("sketchCanvas");
  const context2d = canvas.getContext("2d");
  let drawing = false;
  const clearSketch = () => {
    context2d.fillStyle = "#ffffff";
    context2d.fillRect(0, 0, canvas.width, canvas.height);
  };
  const canvasPoint = (event) => {
    const bounds = canvas.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) * canvas.width / bounds.width, y: (event.clientY - bounds.top) * canvas.height / bounds.height };
  };
  canvas.addEventListener("pointerdown", (event) => {
    drawing = true;
    canvas.setPointerCapture(event.pointerId);
    const point = canvasPoint(event);
    context2d.beginPath();
    context2d.moveTo(point.x, point.y);
    context2d.lineCap = "round";
    context2d.lineJoin = "round";
    context2d.strokeStyle = $("sketchColor").value;
    context2d.lineWidth = Number($("sketchSize").value) * canvas.width / canvas.getBoundingClientRect().width;
    context2d.lineTo(point.x + 0.1, point.y + 0.1);
    context2d.stroke();
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!drawing) return;
    const point = canvasPoint(event);
    context2d.lineTo(point.x, point.y);
    context2d.stroke();
  });
  canvas.addEventListener("pointerup", () => { drawing = false; });
  canvas.addEventListener("pointercancel", () => { drawing = false; });
  $("clearSketch").onclick = clearSketch;
  $("closeSketch").onclick = () => sketchDialog.close();
  $("cancelSketch").onclick = () => sketchDialog.close();
  $("attachSketch").onclick = () => {
    pendingFiles.push({ name: "Sketsa.png", content: "Sketsa buatan pengguna.", images: [canvas.toDataURL("image/png")] });
    renderAttachmentList();
    sketchDialog.close();
    toast("Sketsa ditambahkan sebagai lampiran.");
  };
  clearSketch();
  $("clearMode").onclick = () => setComposerMode("");
  document.addEventListener("click", (event) => {
    if (!attachMenu.contains(event.target) && event.target !== $("attachBtn")) {
      attachMenu.classList.add("hidden");
      $("attachBtn").setAttribute("aria-expanded", "false");
    }
  });
  const processFiles = async (fileList) => {
    if (processingFiles) {
      toast("Lampiran sedang diproses. Tunggu sampai selesai.");
      return;
    }
    const MAX_FILES_PER_BATCH = 100;
    const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
    const blockedPath = /(^|\/)(?:node_modules|\.git|vendor|dist|build|coverage|\.next|\.nuxt|target|__pycache__|\.venv|venv)(?:\/|$)/i;
    const sensitivePath = /(^|\/)(?:\.env(?:\.[^/]*)?|id_rsa(?:\.[^/]*)?|id_ed25519(?:\.[^/]*)?|credentials(?:\.[^/]*)?|secrets?\.(?:json|ya?ml)|[^/]+\.(?:pem|key|p12|pfx))$/i;
    const hiddenNoise = /(^|\/)(?:\.DS_Store|Thumbs\.db|desktop\.ini)$/i;
    const all = [...fileList];
    const candidates = all.filter((file) => {
      const path = file.webkitRelativePath || file.name;
      return !blockedPath.test(path) && !sensitivePath.test(path) && !hiddenNoise.test(path);
    });
    let skipped = all.length - candidates.length;
    const files = [];
    let totalBytes = 0;
    for (const file of candidates) {
      if (files.length >= MAX_FILES_PER_BATCH || totalBytes + file.size > MAX_TOTAL_BYTES) {
        skipped++;
        continue;
      }
      files.push(file);
      totalBytes += file.size;
    }
    if (!files.length) {
      toast(all.length ? "Tidak ada file yang didukung di pilihan itu. File rahasia, metadata, dan folder dependensi dilewati." : "Tidak ada file yang dipilih.");
      return;
    }

    processingFiles = true;
    const progressWrap = $("attachmentProcessing");
    const progressLabel = $("attachmentProcessingText");
    const attachButton = $("attachBtn");
    progressWrap?.classList.remove("hidden");
    if (attachButton) attachButton.disabled = true;
    const addedFiles = [];
    const errors = [];
    try {
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        if (progressLabel) progressLabel.textContent = `Membaca ${index + 1} dari ${files.length} · ${file.name.split("/").pop()}`;
        try {
          const parsed = await readUploadedFile(file);
          // Preserve folder-relative paths so identical filenames remain distinguishable to the model.
          parsed.name = file.webkitRelativePath || parsed.name || file.name;
          pendingFiles.push(parsed);
          addedFiles.push(parsed);
        } catch (err) {
          skipped++;
          if (errors.length < 3) errors.push(err.message || `${file.name}: gagal dibaca`);
        }
      }

      renderAttachmentList();
      const library = readFileLibrary();
      for (const file of addedFiles) {
        if (!library.some((saved) => saved.name === file.name)) {
          library.unshift({ name: file.name, content: file.content || "", images: [] });
        }
      }
      try {
        // Keep the browser library modest; full attachment data may exceed localStorage quota.
        localStorage.setItem("myai_file_library", JSON.stringify(library.slice(0, 15)));
      } catch {
        // In-memory attachments still work for this chat even if browser storage is full.
      }

      const folderSelected = files.some((file) => Boolean(file.webkitRelativePath));
      const source = folderSelected ? "Folder" : "Lampiran";
      let summary = `${source} selesai: ${addedFiles.length} file siap dipakai.`;
      if (skipped) summary += ` ${skipped} file dilewati.`;
      toast(summary);
      if (errors.length) console.info("MyAI: beberapa lampiran dilewati", errors);
    } finally {
      processingFiles = false;
      progressWrap?.classList.add("hidden");
      if (attachButton) attachButton.disabled = false;
      if (progressLabel) progressLabel.textContent = "Membaca file…";
      updateSendBtn();
      if (sendAfterProcessing) {
        sendAfterProcessing = false;
        send(input.value);
      }
    }
  };
  $("fileInput").addEventListener("change", async (event) => {
    await processFiles(event.target.files);
    event.target.value = "";
  });
  $("folderInput").addEventListener("change", async (event) => {
    await processFiles(event.target.files);
    event.target.value = "";
  });
  const autosize = () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 220) + "px";
  };
  input.addEventListener("input", () => {
    autosize();
    saveModeDraft(taskMode, false);
    updateSendBtn();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    if (abort) {
      abort.abort();
      return;
    }
    if (processingFiles) {
      // File masih dibaca: antrekan pengiriman, kirim otomatis begitu selesai.
      sendAfterProcessing = true;
      const progressLabel = $("attachmentProcessingText");
      if (progressLabel && !/dikirim/.test(progressLabel.textContent)) {
        progressLabel.textContent += " — pesan terkirim otomatis setelah selesai";
      }
      return;
    }
    send(input.value);
  });
  $("newChat").onclick = () => {
    if (abort) return;
    chat = newChat(taskMode);
    renderChatList();
    renderMessages();
    closeSidebar();
    input.focus();
  };

  $("modelBtn").onclick = () => ($("modelMenu").classList.contains("hidden") ? openModelMenu() : closeModelMenu());
  $("refreshModelsBtn").onclick = refreshModelCatalog;
  $("modelSearch").addEventListener("input", renderModelList);
  $("modelSearch").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const first = $("modelList").querySelector(".model-item");
      if (first) selectModel(first.dataset.value);
    }
  });
  document.addEventListener("click", (e) => {
    if (!$("modelPicker").contains(e.target)) closeModelMenu();
    if (!$ ("taskModePicker").contains(e.target)) {
      $("taskModeMenu").classList.add("hidden");
      $("taskModeBtn").setAttribute("aria-expanded", "false");
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeModelMenu();
      attachMenu.classList.add("hidden");
      $("attachBtn").setAttribute("aria-expanded", "false");
      $("taskModeMenu").classList.add("hidden");
      $("taskModeBtn").setAttribute("aria-expanded", "false");
    }
  });

  $("toggleSidebar").onclick = () => {
    const app = document.querySelector(".app");
    const sidebar = $("sidebar");
    if (window.matchMedia("(max-width: 800px)").matches) {
      sidebar.classList.toggle("open");
      $("backdrop").classList.toggle("show", sidebar.classList.contains("open"));
    } else {
      app.classList.toggle("sidebar-collapsed");
    }
    $("toggleSidebar").setAttribute("aria-expanded", String(window.matchMedia("(max-width: 800px)").matches
      ? sidebar.classList.contains("open")
      : !app.classList.contains("sidebar-collapsed")));
  };
  $("backdrop").onclick = closeSidebar;
}

async function main() {
  document.title = APP_NAME;
  $("appName").textContent = APP_NAME;
  $("appVersion").textContent = "v" + APP_VERSION;
  bindEvents();
  renderMessages();
  loadModels();
  await initFirebase(async (user) => {
    currentUser = user;
    renderAccount(user);
    if (user) enterApp();
    if (user && (await syncSettings())) loadModels();
    try {
      chats = await listChats();
      const syncError = consumeSyncError();
      if (syncError) toast("Riwayat cloud gagal dimuat; chat lokal ditampilkan: " + syncErrorMessage(syncError, "chat"));
    } catch (e) {
      chats = [];
      toast("Gagal memuat riwayat: " + e.message);
    }
    chat = newChat(taskMode);
    renderChatList();
    renderMessages();
  });
}

main().catch((e) => toast("Gagal memulai aplikasi: " + e.message));
