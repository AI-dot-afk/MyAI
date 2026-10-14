import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

async function loadEnv() {
  try {
    const source = await readFile(resolve(ROOT, ".env"), "utf8");
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
    }
  } catch {}
}

await loadEnv();

const providers = {
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    key: process.env.OPENROUTER_API_KEY,
    headers: { "HTTP-Referer": "http://localhost", "X-Title": "MyAI" },
  },
  aimlapi: {
    baseUrl: "https://api.aimlapi.com/v1",
    key: process.env.AIMLAPI_API_KEY,
    headers: {},
  },
  llm7: {
    baseUrl: "https://api.llm7.io/v1",
    key: process.env.LLM7_API_KEY,
    headers: {},
  },
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 40 * 1024 * 1024) throw new Error("Permintaan terlalu besar.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function providerHeaders(provider) {
  return {
    Authorization: `Bearer ${provider.key}`,
    "Content-Type": "application/json",
    ...provider.headers,
  };
}

async function proxyProvider(response, providerName, path, payload) {
  const provider = providers[providerName];
  if (!provider || !provider.key) {
    sendJson(response, 503, { error: { message: `Provider ${providerName} belum tersedia di server.` } });
    return;
  }
  const upstream = await fetch(`${provider.baseUrl}${path}`, {
    method: "POST",
    headers: providerHeaders(provider),
    body: JSON.stringify(payload),
  });
  response.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  if (!upstream.body) {
    response.end();
    return;
  }
  Readable.fromWeb(upstream.body).pipe(response);
}

async function fetchModels(providerName) {
  const provider = providers[providerName];
  if (!provider?.key) return [];
  const response = await fetch(`${provider.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${provider.key}`, ...provider.headers },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`${providerName} HTTP ${response.status}`);
  const result = await response.json();
  return Array.isArray(result.data) ? result.data : Array.isArray(result.models) ? result.models : [];
}

async function managedModelGroups() {
  const groups = [];
  const errors = [];
  const results = await Promise.allSettled([
    fetchModels("openrouter"),
    fetchModels("aimlapi"),
    fetchModels("llm7"),
  ]);

  if (results[0].status === "fulfilled") {
    const free = [];
    const paid = [];
    const imageModels = [];
    for (const model of results[0].value) {
      if (!model?.id || /embedding|moderation|guard|tts|audio|:batch/i.test(model.id)) continue;
      const output = model.architecture?.output_modalities || ["text"];
      const item = { id: model.id, name: String(model.name || model.id).replace(/^[^:]+:\s*/, "").replace(/\s*\(free\)$/i, "") };
      if (output.includes("image")) imageModels.push({ ...item, imageGeneration: true });
      if (!output.includes("text")) continue;
      const promptPrice = Number(model.pricing?.prompt);
      const completionPrice = Number(model.pricing?.completion);
      if (promptPrice === 0 && completionPrice === 0) free.push(item);
      else paid.push(item);
    }
    groups.push({ provider: "openrouter", label: "OpenRouter Gratis", tag: "Katalog API gratis", models: [{ id: "openrouter/free", name: "Auto (gratis)" }, ...free] });
    if (paid.length) groups.push({ provider: "openrouter", label: "OpenRouter Premium", tag: "Katalog API berbayar", models: paid });
    if (imageModels.length) groups.push({ provider: "openrouter-image", label: "OpenRouter Image", tag: "Katalog API gambar", models: imageModels });
  } else {
    errors.push(`OpenRouter: ${results[0].reason?.message || results[0].reason}`);
    groups.push({ provider: "openrouter", label: "OpenRouter Gratis", tag: "API otomatis", models: [{ id: "openrouter/free", name: "Auto (gratis)" }] });
  }

  if (results[1].status === "fulfilled") {
    const models = results[1].value
      .filter((model) => model?.id && !/embedding|moderation|guard|tts|audio|image|video/i.test(model.id))
      .slice(0, 500)
      .map((model) => ({ id: model.id, name: model.name || model.id }));
    if (models.length) groups.push({ provider: "aimlapi", label: "AI/ML API", tag: "Katalog API", models });
  } else {
    errors.push(`AI/ML API: ${results[1].reason?.message || results[1].reason}`);
  }

  const llm7Models = results[2].status === "fulfilled"
    ? results[2].value.filter((model) => model?.id).map((model) => ({ id: model.id, name: model.name || model.id }))
    : [];
  groups.push({ provider: "llm7", label: "LLM7", tag: "API otomatis", models: llm7Models.length ? llm7Models : [{ id: "default", name: "LLM7 Default" }] });
  if (results[2].status === "rejected") errors.push(`LLM7: ${results[2].reason?.message || results[2].reason}`);

  return { groups, errors };
}

async function serveStatic(request, response, pathname) {
  const relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const filePath = resolve(ROOT, relativePath);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    const data = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(data);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Tidak ditemukan");
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { providers: Object.fromEntries(Object.entries(providers).map(([name, value]) => [name, Boolean(value.key)])) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/models") {
      sendJson(response, 200, await managedModelGroups());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/chat/completions") {
      const body = await readJson(request);
      const provider = body.provider;
      delete body.provider;
      await proxyProvider(response, provider, "/chat/completions", body);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/images") {
      const body = await readJson(request);
      delete body.provider;
      await proxyProvider(response, "openrouter", "/images", body);
      return;
    }
    await serveStatic(request, response, url.pathname);
  } catch (error) {
    if (!response.headersSent) sendJson(response, 500, { error: { message: error.message || "Server gagal memproses permintaan." } });
    else response.destroy(error);
  }
});

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT) || 8080;
server.listen(port, host, () => console.log(`MyAI siap di http://${host}:${port}`));
