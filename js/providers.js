import { latestOnly, prettify } from "./models.js";

const SETTINGS_KEY = "myai_settings";
const MODEL_CATALOG_KEY = "myai_model_catalog";
const DEFAULT_SETTINGS = {
  showPaid: false,
  localModels: false,
  systemPrompt: "Kamu adalah asisten AI yang ramah, cerdas, dan membantu. Jawab dalam bahasa yang dipakai pengguna. Gunakan Markdown untuk format.",
  temperature: 0.7,
};

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      return {
        showPaid: Boolean(saved.showPaid),
        localModels: Boolean(saved.localModels),
        systemPrompt: typeof saved.systemPrompt === "string" ? saved.systemPrompt : DEFAULT_SETTINGS.systemPrompt,
        temperature: Number.isFinite(Number(saved.temperature)) ? Number(saved.temperature) : DEFAULT_SETTINGS.temperature,
      };
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

async function errorText(res) {
  const raw = await res.text();
  try {
    const j = JSON.parse(raw);
    return `${res.status}: ${j.error?.message || j.message || raw}`;
  } catch {
    return `${res.status}: ${raw.slice(0, 300)}`;
  }
}

async function* readSSE(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const parseLine = (line) => {
    if (!line.startsWith("data:")) return null;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return { done: true };
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buf += decoder.decode();
      break;
    }
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const event = parseLine(line);
      if (event?.done) return;
      if (event) yield event;
    }
  }
  const event = parseLine(buf.trim());
  if (event && !event.done) yield event;
}

// ---------- OpenAI-compatible (OpenRouter, Groq) ----------

async function* openAIStream(url, key, model, messages, opts, signal, extraHeaders = {}, baseBody = {}) {
  const openAIMessages = messages.map(({ images, ...message }) => images?.length
    ? { ...message, content: [{ type: "text", text: message.content }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))] }
    : message);
  const post = (extra) => {
    const headers = { "Content-Type": "application/json", ...extraHeaders };
    if (key) headers.Authorization = `Bearer ${key}`;
    return fetch(url, {
      method: "POST",
      signal,
      headers,
      body: JSON.stringify({
        model,
        messages: openAIMessages,
        stream: true,
        temperature: opts.temperature,
        ...baseBody,
        ...extra,
      }),
    });
  };
  let res = await post();
  if (res.status === 429 || res.status === 413) {
    const msg = await errorText(res);
    // Tier gratis Groq membatasi token output per menit; ulangi dengan max_tokens di bawah batas itu.
    const limit = Number(msg.match(/output tokens per minute[^]*?Limit (\d+)/i)?.[1]);
    if (!limit) throw new Error(msg);
    res = await post({ max_tokens: Math.floor(limit * 0.9) });
  }
  if (!res.ok) throw new Error(await errorText(res));
  for await (const j of readSSE(res)) {
    if (j.error) throw new Error(j.error.message || "Error dari server");
    const annotations = j.choices?.[0]?.delta?.annotations || j.choices?.[0]?.message?.annotations || [];
    for (const annotation of annotations) {
      if (annotation.type === "url_citation" && annotation.url_citation?.url) {
        yield { citation: { url: annotation.url_citation.url, title: annotation.url_citation.title } };
      }
    }
    const d = j.choices?.[0]?.delta;
    if (d?.reasoning) yield { reasoning: d.reasoning };
    if (d?.content) yield { content: d.content };
  }
}

async function catalogFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Request katalog melewati batas waktu 12 detik.");
    if (error instanceof TypeError) throw new Error("Tidak bisa menghubungi API katalog (periksa koneksi atau CORS).");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function listOpenRouter() {
  const res = await catalogFetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error("OpenRouter: " + await errorText(res));
  const { data = [] } = await res.json();
  const free = [];
  const paid = [];
  for (const model of data) {
    const modalities = model.architecture?.output_modalities || ["text"];
    if (modalities.some((modality) => modality !== "text") || /safety|guard|:batch/i.test(model.id)) continue;
    const promptPrice = Number(model.pricing?.prompt);
    const completionPrice = Number(model.pricing?.completion);
    const item = {
      id: model.id,
      name: (model.name || model.id).replace(/^[^:]+:\s*/, "").replace(/\s*\(free\)$/i, ""),
    };
    if (promptPrice === 0 && completionPrice === 0) free.push(item);
    else if (promptPrice > 0 || completionPrice > 0) paid.push(item);
  }
  return { free, paid };
}

async function listOpenRouterImageModels() {
  const res = await catalogFetch("https://openrouter.ai/api/v1/images/models");
  if (!res.ok) throw new Error("OpenRouter Image: " + await errorText(res));
  const { data = [] } = await res.json();
  return data
    .filter((model) => model.id && model.architecture?.output_modalities?.includes("image"))
    .map((model) => ({ id: model.id, name: model.name || model.id }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function listGroq(key) {
  const res = await catalogFetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error("Groq: " + await errorText(res));
  const { data = [] } = await res.json();
  return data
    .filter((model) => !/whisper|tts|guard|playai|orpheus/i.test(model.id))
    .map((model) => ({ id: model.id, name: prettify(model.id) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function listGemini(key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key)}`;
  const res = await catalogFetch(url);
  if (!res.ok) throw new Error("Gemini: " + await errorText(res));
  const { models = [] } = await res.json();
  return models
    .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
    .filter((model) => /gemini|gemma/i.test(model.name) && !/tts|image|embedding|live|native-audio|robotics|computer-use/i.test(model.name))
    .map((model) => ({ id: model.name.replace(/^models\//, ""), name: model.displayName || prettify(model.name) }))
    .sort((left, right) => right.id.localeCompare(left.id));
}

// ---------- Google Gemini ----------

async function* geminiStream(key, model, messages, opts, signal) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [
        { text: m.content },
        ...(m.images || []).map((image) => {
          const [, mimeType, data] = image.match(/^data:([^;]+);base64,(.+)$/) || [];
          if (!mimeType || !data) throw new Error("Format gambar tidak valid.");
          return { inlineData: { mimeType, data } };
        }),
      ],
    }));
  const body = {
    contents,
    generationConfig: { temperature: opts.temperature },
    ...(opts.webSearch ? { tools: [{ googleSearch: {} }] } : {}),
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorText(res));
  const cited = new Set();
  for await (const j of readSSE(res)) {
    for (const part of j.candidates?.[0]?.content?.parts || []) {
      if (!part.text) continue;
      if (part.thought) yield { reasoning: part.text };
      else yield { content: part.text };
    }
    for (const source of j.candidates?.[0]?.groundingMetadata?.groundingChunks || []) {
      if (source.web?.uri && !cited.has(source.web.uri)) {
        cited.add(source.web.uri);
        yield { citation: { url: source.web.uri, title: source.web.title } };
      }
    }
  }
}

async function* geminiImageStream(key, messages, opts, signal) {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  const contents = messages.filter((message) => message.role !== "system").map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [
      { text: message.content },
      ...(message.images || []).map((image) => {
        const [, mimeType, data] = image.match(/^data:([^;]+);base64,(.+)$/) || [];
        if (!mimeType || !data) throw new Error("Format gambar referensi tidak valid.");
        return { inlineData: { mimeType, data } };
      }),
    ],
  }));
  const body = {
    contents,
    generationConfig: {
      temperature: opts.temperature,
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: "1:1", imageSize: "1K" },
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent?key=" + encodeURIComponent(key), {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorText(res));
  const result = await res.json();
  let hasImage = false;
  for (const part of result.candidates?.[0]?.content?.parts || []) {
    if (part.text) yield { content: part.text };
    if (part.inlineData?.data) {
      hasImage = true;
      yield { image: `data:${part.inlineData.mimeType || "image/png"};base64,${part.inlineData.data}` };
    }
  }
  if (!hasImage) throw new Error("Gemini tidak mengembalikan gambar. Coba ubah prompt atau periksa akses model image.");
}

async function* openRouterImageStream(model, messages, opts, signal) {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  const userMessages = messages.filter((message) => message.role === "user");
  const prompt = [system, ...userMessages.map((message) => message.content)].filter(Boolean).join("\n\n");
  const references = userMessages.flatMap((message) => message.images || []).map((url) => ({
    type: "image_url",
    image_url: { url },
  }));
  const res = await fetch("/api/images", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "openrouter",
      model,
      prompt,
      output_format: "png",
      ...(references.length ? { input_references: references } : {}),
    }),
  });
  if (!res.ok) throw new Error(await errorText(res));
  const result = await res.json();
  let hasImage = false;
  for (const item of result.data || []) {
    if (item.b64_json) {
      hasImage = true;
      yield { image: `data:${item.media_type || "image/png"};base64,${item.b64_json}` };
    } else if (item.url && /^https?:\/\//i.test(item.url)) {
      hasImage = true;
      yield { image: item.url };
    }
  }
  if (!hasImage) throw new Error("OpenRouter tidak mengembalikan gambar. Coba model lain atau periksa dukungan akun.");
}

// ---------- Lokal di browser (WebLLM / WebGPU) ----------

let webllm = null;
let engine = null;
let loadedModel = null;

async function getWebLLM() {
  webllm ??= await import("https://esm.run/@mlc-ai/web-llm");
  return webllm;
}

const LOCAL_PRIORITY = ["qwen", "deepseek", "llama", "gemma", "phi", "mistral", "smollm"];
const LOCAL_EXCLUDE = /embed|hermes|wizard|redpajama|tinyllama|stablelm|jpn|-base-|^phi-1|^phi-2|-1k$/i;
const QUANT_PREF = ["q4f16_1", "q4f32_1", "q0f16", "q0f32"];

async function listLocal() {
  const w = await getWebLLM();
  const rank = (id) => {
    const i = LOCAL_PRIORITY.findIndex((k) => id.toLowerCase().startsWith(k));
    return i < 0 ? LOCAL_PRIORITY.length : i;
  };
  const series = (name) => name.replace(/\s+[AE]?\d+(\.\d+)?[BMT]\b.*$/i, "");
  const quantRank = (id) => {
    const i = QUANT_PREF.findIndex((q) => id.includes(`-${q}-`));
    return i < 0 ? QUANT_PREF.length : i;
  };
  // Satu model bisa punya beberapa varian kuantisasi; ambil yang paling ringan & umum.
  const byBase = new Map();
  for (const m of w.prebuiltAppConfig.model_list) {
    if (LOCAL_EXCLUDE.test(m.model_id)) continue;
    const base = m.model_id.replace(/-q\d+f\d+(_\d+)?-MLC.*$/i, "");
    const cur = byBase.get(base);
    if (!cur || quantRank(m.model_id) < quantRank(cur.model_id)) byBase.set(base, m);
  }
  const list = [...byBase.values()].map((m) => ({
    id: m.model_id,
    name: prettify(m.model_id),
    info: m.vram_required_MB ? `~${(m.vram_required_MB / 1024).toFixed(1)} GB VRAM` : "",
    vram: m.vram_required_MB || 0,
  }));
  return latestOnly(list).sort(
    (a, b) =>
      rank(a.id) - rank(b.id) ||
      series(b.name).localeCompare(series(a.name), undefined, { numeric: true }) ||
      a.vram - b.vram
  );
}

async function* localStream(model, messages, opts, signal) {
  if (messages.some((message) => message.images?.length)) {
    throw new Error("Model lokal ini belum mendukung analisis gambar. Pilih model vision dari Gemini atau OpenRouter.");
  }
  if (!navigator.gpu) {
    throw new Error("Browser ini belum mendukung WebGPU. Gunakan Chrome/Edge terbaru di laptop/PC, atau pilih model API (Gemini/Groq/OpenRouter).");
  }
  const w = await getWebLLM();
  if (!engine) {
    engine = await w.CreateMLCEngine(model, { initProgressCallback: opts.onProgress });
    loadedModel = model;
  } else if (loadedModel !== model) {
    engine.setInitProgressCallback(opts.onProgress);
    await engine.reload(model);
    loadedModel = model;
  }
  const chunks = await engine.chat.completions.create({ messages, stream: true, temperature: opts.temperature });
  for await (const c of chunks) {
    if (signal.aborted) {
      engine.interruptGenerate();
      break;
    }
    const t = c.choices?.[0]?.delta?.content;
    if (t) yield { content: t };
  }
}

// ---------- API publik ----------

function readCatalogCache() {
  try {
    const cache = JSON.parse(localStorage.getItem(MODEL_CATALOG_KEY) || "{}");
    return Array.isArray(cache.groups) ? cache.groups : [];
  } catch {
    return [];
  }
}

function writeCatalogCache(groups) {
  try {
    const apiGroups = groups.filter((group) => group.tag.startsWith("Katalog API") && group.models.length);
    localStorage.setItem(MODEL_CATALOG_KEY, JSON.stringify({ savedAt: Date.now(), groups: apiGroups }));
  } catch {}
}

export async function listAllModels(s) {
  const groups = [
    { provider: "openrouter", label: "OpenRouter Gratis", tag: "API otomatis", models: [{ id: "openrouter/free", name: "Auto (gratis)" }] },
    { provider: "llm7", label: "LLM7", tag: "API otomatis", models: [{ id: "default", name: "LLM7 Default" }] },
  ];
  const errors = [];
  const replaceGroup = (group) => {
    if (!group?.models?.length || (group.label === "OpenRouter Premium" && !s.showPaid)) return;
    const index = groups.findIndex((item) => item.provider === group.provider && item.label === group.label);
    if (index >= 0) groups[index] = group;
    else groups.push(group);
  };

  for (const group of readCatalogCache()) replaceGroup(group);

  try {
    const response = await catalogFetch("/api/models");
    if (!response.ok) throw new Error(await errorText(response));
    const result = await response.json();
    for (const group of result.groups || []) replaceGroup(group);
    for (const error of result.errors || []) errors.push(error);
    writeCatalogCache(groups);
  } catch (error) {
    errors.push(`Server model: ${error.message || error}`);
  }

  if (s.localModels) {
    try {
      groups.push({ provider: "local", label: "Lokal di browser", tag: "WebGPU · unduh model saat dipakai", models: await listLocal() });
    } catch (error) {
      errors.push(`Katalog model lokal gagal dimuat: ${error.message || error}`);
    }
  }

  return { groups: groups.filter((group) => group.models.length), errors };
}

export function streamChat(provider, model, messages, opts, signal) {
  if (opts.imageGeneration) {
    if (provider === "openrouter-image") return openRouterImageStream(model, messages, opts, signal);
    throw new Error("Pilih model OpenRouter Image untuk membuat gambar.");
  }
  switch (provider) {
    case "openrouter":
      return openAIStream("/api/chat/completions", "", model, messages, opts, signal, {}, {
        provider,
        ...(opts.webSearch ? { plugins: [{ id: "web", max_results: opts.researchMode ? 10 : 5 }] } : {}),
      });
    case "aimlapi":
    case "llm7":
      return openAIStream("/api/chat/completions", "", model, messages, opts, signal, {}, { provider });
    case "local":
      return localStream(model, messages, opts, signal);
    default:
      throw new Error("Provider tidak dikenal: " + provider);
  }
}
