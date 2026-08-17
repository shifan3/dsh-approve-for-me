// dsh-approve-for-me — static host plugin (ESM, no runtime dependencies).
//
// Adds an "auto-approve" permission preset via the bundle patch in
// cordis.patch.yml. When the session is in that preset, this prepended
// `approval/request` answerer auto-approves clearly low-risk actions via an
// LLM safety classifier. Dangerous hard-rule matches (system paths /
// destructive commands) and uncertain / timeout / error cases fall through
// to the interactive answerer (the user prompt), i.e. fail-closed.

export const name = "approve-for-me";
export const inject = ["llm"];

const DEFAULTS = {
  enabled: true,
  provider: "deepseek-official",
  model: "deepseek-v4-flash",
  presetName: "auto-approve",
  maxTokens: 256,
  summaryMaxChars: 12000,
  timeoutMs: 15000,
  reasoningEffort: "off",
  temperature: 0
};

const SYSTEM_PROMPT = [
  "You are a safety reviewer for an AI coding assistant's privileged-action requests.",
  "Decide whether the requested action is a reasonable, non-destructive step consistent with the user's stated intent in the conversation summary.",
  "Reply with exactly one word on its own line: ALLOW or REJECT. No explanation.",
  "When unsure, reply REJECT."
].join("\n");

/** Fold the last permission/preset event from the session log. */
function foldPreset(events) {
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== "permission/preset") continue;
    const preset = event.data && event.data.preset;
    return typeof preset === "string" ? preset : undefined;
  }
  return undefined;
}

/** Parse tool-call arguments for the exact callId, newest first. */
function extractArgs(events, callId) {
  if (callId === undefined || !Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== "tool/call") continue;
    if (event.data && event.data.callId !== callId) continue;
    const raw = event.data && event.data.arguments;
    if (typeof raw !== "string") return undefined;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return { raw };
    }
  }
  return undefined;
}

/** System/protected directories across Windows / macOS / Linux. */
function isSystemPath(path) {
  if (typeof path !== "string" || path.length === 0) return false;
  const norm = path.replace(/\\/g, "/").toLowerCase();

  // Windows: drive-root system directories
  if (/^[a-z]:\/(?:windows|program files|program files \(x86\)|programdata|boot|recovery|system volume information)(?:\/|$)/.test(norm)) return true;
  // Windows: startup folder (writes auto-execute)
  if (norm.includes("/appdata/roaming/microsoft/windows/start menu/programs/startup")) return true;

  // macOS / Linux: root-level system/protected directories
  if (/^\/(?:etc|usr|bin|sbin|lib|lib64|var|boot|opt|proc|sys|dev|root|system|library|private|applications)(?:\/|$)/.test(norm)) return true;

  return false;
}

/** Destructive / dangerous commands across Windows / macOS / Linux. */
function isDestructiveCommand(cmd) {
  if (typeof cmd !== "string" || cmd.length === 0) return false;
  const c = cmd.toLowerCase();
  return (
    // recursive/force remove (POSIX rm -r / rm -rf / rm -fr … and root-targeted rm)
    /\brm\s+-[a-z]*[r][a-z]*\b/.test(c) ||
    /\brm\s+(?:-[a-z]+\s+)*\/\b/.test(c) ||
    // recursive/force delete (Windows)
    /\bdel\s+\/[sfq]\b/.test(c) ||
    /\brmdir\s+\/[sq]\b/.test(c) ||
    /\bremove-item\b[^\n]*\b-recurse\b[^\n]*\b-force\b/.test(c) ||
    // SQL / database destruction
    /\bdrop\s+table\b/.test(c) ||
    /\bdrop\s+database\b/.test(c) ||
    /\bdrop\s+schema\b/.test(c) ||
    /\btruncate\s+(?:table\s+)?\w+/.test(c) ||
    /\bdelete\s+from\s+\w+/.test(c) ||
    // disk / format / overwrite
    /\bformat\s+[a-z]:/.test(c) ||
    /\bdiskpart\b/.test(c) ||
    /\bmkfs(?:\.\w+)?\b/.test(c) ||
    /\bdd\s+if=/.test(c) ||
    // secure erase
    /\bshred\b/.test(c) ||
    /\bsrm\b/.test(c) ||
    /\bwipefs?\b/.test(c) ||
    // shutdown / reboot / poweroff
    /\b(?:shutdown|reboot|poweroff|halt)\b/.test(c) ||
    /\bcrontab\s+-r\b/.test(c) ||
    // destructive git / broad permission changes
    /\bgit\s+push\s+(?:-f|--force)\b/.test(c) ||
    /\bgit\s+reset\s+--hard\b/.test(c) ||
    /\bchmod\s+-R\s+777\b/.test(c) ||
    /\bchown\s+-R\b/.test(c) ||
    // fork bomb
    /:\(\)\s*\{\s*:\|:&\s*\};:/.test(c)
  );
}

/** Hard-rule gate: system path or destructive command → never auto-approve. */
function isDefinitelyDangerous(args) {
  if (!args || typeof args !== "object") return false;
  const filePath = typeof args.file_path === "string"
    ? args.file_path
    : typeof args.path === "string"
      ? args.path
      : undefined;
  const command = typeof args.command === "string" ? args.command : undefined;
  if (filePath !== undefined && isSystemPath(filePath)) return true;
  if (command !== undefined && isDestructiveCommand(command)) return true;
  return false;
}

/** Compact action text from parsed tool args plus the request reason. */
function actionText(req, args) {
  const parts = [];
  if (args && typeof args === "object") {
    if (typeof args.command === "string" && args.command.length > 0) parts.push("command: " + args.command);
    if (typeof args.file_path === "string" && args.file_path.length > 0) parts.push("file_path: " + args.file_path);
    else if (typeof args.path === "string" && args.path.length > 0) parts.push("path: " + args.path);
    if (typeof args.content === "string") parts.push("content: " + args.content.slice(0, 1000));
  }
  if (typeof req.reason === "string" && req.reason.length > 0) parts.push("reason: " + req.reason);
  return parts.join("\n");
}

function messageText(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "tool-call" && typeof block.name === "string") parts.push("[tool " + block.name + "]");
    else if (block.type === "tool-result") parts.push("[tool result]");
  }
  return parts.join(" ").trim();
}

function toolCallLine(data) {
  if (!data || typeof data !== "object") return "";
  const name = typeof data.name === "string" ? data.name : "tool";
  let preview = "";
  if (typeof data.arguments === "string" && data.arguments.length > 0) {
    try {
      const args = JSON.parse(data.arguments);
      preview = args && typeof args === "object" && typeof args.command === "string"
        ? " " + args.command
        : " " + JSON.stringify(args);
    } catch (_) {
      preview = " " + data.arguments;
    }
  }
  return "[tool " + name + "]" + preview;
}

function buildSummary(events, maxChars) {
  if (!Array.isArray(events)) return "";
  const picked = [];
  let budget = maxChars;
  for (let index = events.length - 1; index >= 0 && budget > 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    let text = "";
    if (event.type === "user/message") {
      text = messageText(event.data && event.data.content);
    } else if (event.type === "assistant/message") {
      text = messageText(event.data && event.data.message && event.data.message.content);
    } else if (event.type === "tool/call") {
      text = toolCallLine(event.data);
    } else {
      continue;
    }
    if (text.length === 0) continue;
    if (text.length > budget) text = text.slice(0, budget);
    budget -= text.length;
    picked.push(text);
  }
  return picked.reverse().join("\n");
}

async function judgeWithLlm(req, llm, cfg, action) {
  const summary = buildSummary(req.agent.session.events, cfg.summaryMaxChars);
  const lines = [
    "CONVERSATION SUMMARY:",
    summary.length > 0 ? summary : "(no prior conversation)",
    "",
    "REQUESTED ACTION:",
    "tool: " + req.toolName
  ];
  if (typeof action === "string" && action.length > 0) lines.push(action);
  const messages = [{
    role: "user",
    content: [{ type: "text", text: lines.join("\n") }]
  }];

  const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;
  const stream = await llm.stream({
    provider: cfg.provider,
    model: cfg.model,
    messages,
    system: SYSTEM_PROMPT,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    reasoningEffort: cfg.reasoningEffort,
    sessionId: req.agent.session.id,
    purpose: "approval-auto",
    signal
  });

  let text = "";
  let finish = { kind: "stop" };
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== "object") continue;
    if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
    else if (chunk.type === "finish") finish = chunk.reason || { kind: "stop" };
  }

  // The model could not deliver a usable verdict: fall back to the user.
  if (finish.kind === "aborted") return req.signal && req.signal.aborted ? "cancelled" : undefined;
  if (finish.kind !== "stop" && finish.kind !== "max-tokens") return undefined;
  if (/REJECT/i.test(text)) return "rejected";
  if (/ALLOW/i.test(text)) return "allowed-once";
  return undefined;
}

export function apply(ctx, config) {
  const cfg = Object.assign({}, DEFAULTS, config || {});
  if (cfg.enabled === false) return;

  ctx.on("approval/request", async (req, next) => {
    try {
      if (!req || !req.agent || !req.agent.session) return next();
      if (req.signal && req.signal.aborted) return "cancelled";

      // Only take over while the session is in the auto-approve preset.
      if (foldPreset(req.agent.session.events) !== cfg.presetName) return next();

      const args = extractArgs(req.agent.session.events, req.callId);

      // Hard rules: definitely dangerous → human, no LLM call.
      if (isDefinitelyDangerous(args)) return next();

      const llm = ctx.llm;
      if (!llm) return next();

      const action = actionText(req, args);
      const outcome = await judgeWithLlm(req, llm, cfg, action);
      if (outcome === undefined) return next();
      return outcome;
    } catch (_) {
      return next();
    }
  }, { prepend: true });
}
