// approve-for-me — LLM auto-approval for the DSH approval seam.
// Dynamic Cordis HOST half. Paste this file's content as `code.host`
// (or the Host code in the Cordis panel). The plugin's running state is the
// mode switch: while it is running, every approval request that reaches the
// answerer chain is judged by an LLM safety reviewer; destructive high-risk
// commands fall through to the normal interactive answerer (the user prompt).

const PROVIDER = "deepseek-official";
const MODEL = "deepseek-v4-flash";
const MAX_TOKENS = 512;
const SUMMARY_MAX_CHARS = 12000;

// Exact-pattern destructive-command list. A match skips the LLM and asks the
// user directly. Keep this conservative: a false positive only means a human
// is asked, never a silent auto-approval.
const HIGH_RISK_PATTERNS = [
  /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\b/i,          // rm -r, rm -rf, rm -fr, rm -R, rm -rfv …
  /\brm\s+(?:-[a-zA-Z]+\s+)*\/\b/i,             // rm /, rm -rf /, rm -- / …
  /\bdrop\s+table\b/i,                          // drop table
  /\bdrop\s+database\b/i,                       // drop database
  /\bdrop\s+schema\b/i,                         // drop schema
  /\btruncate\s+(?:table\s+)?\w+/i,             // truncate table …
  /\bdelete\s+from\s+\w+/i,                     // delete from …
  /\bmkfs(?:\.\w+)?\b/i,                        // mkfs, mkfs.ext4 …
  /\bdd\s+if=/i,                                // dd if=/dev/… of=/dev/…
  /\bshred\s+(-\w|\/)/i,                        // shred -…, shred /…
  /\bwipefs\b/i,                                // wipefs
  /\bgit\s+push\s+(?:-f|--force)\b/i,           // git push -f / --force
  /\bgit\s+reset\s+--hard\b/i,                  // git reset --hard
  /\bchmod\s+-R\s+777\b/i,                      // chmod -R 777 …
  /\bchown\s+-R\b/i,                            // chown -R …
  /:\(\)\s*\{\s*:\|:&\s*\};:/i                  // fork bomb
];

function isHighRisk(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(text));
}

function findToolCall(events, callId, toolName) {
  let fallback;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== "tool/call") continue;
    const data = event.data;
    if (!data) continue;
    if (callId !== undefined && data.callId === callId) return data;
    if (fallback === undefined && data.name === toolName) fallback = data;
  }
  return fallback;
}

function actionText(req) {
  const session = req.agent && req.agent.session;
  if (session && Array.isArray(session.events)) {
    const call = findToolCall(session.events, req.callId, req.toolName);
    if (call) {
      const raw = call.arguments;
      if (typeof raw === "string") {
        try {
          const args = JSON.parse(raw);
          if (args && typeof args === "object") {
            if (typeof args.command === "string" && args.command.length > 0) return args.command;
            return JSON.stringify(args);
          }
        } catch (_) {
          return raw;
        }
      } else if (raw && typeof raw === "object") {
        if (typeof raw.command === "string" && raw.command.length > 0) return raw.command;
        return JSON.stringify(raw);
      }
    }
  }
  return typeof req.reason === "string" ? req.reason : "";
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

async function judgeWithLlm(req, llm, action) {
  const summary = buildSummary(req.agent.session.events, SUMMARY_MAX_CHARS);
  const system = [
    "You are a safety reviewer for an AI coding assistant's privileged-action requests.",
    "Decide whether the requested action is a reasonable, non-destructive step consistent with the user's stated intent in the conversation summary.",
    "Reply with exactly one word on its own line: ALLOW or REJECT. No explanation."
  ].join("\n");
  const lines = [
    "CONVERSATION SUMMARY:",
    summary.length > 0 ? summary : "(no prior conversation)",
    "",
    "REQUESTED ACTION:",
    "tool: " + req.toolName
  ];
  if (typeof req.reason === "string" && req.reason.length > 0) lines.push("reason: " + req.reason);
  if (typeof action === "string" && action.length > 0) lines.push("action: " + action);
  const messages = [{
    role: "user",
    content: [{ type: "text", text: lines.join("\n") }]
  }];
  const options = {
    provider: PROVIDER,
    model: MODEL,
    messages: messages,
    system: system,
    maxTokens: MAX_TOKENS,
    reasoningEffort: "off",
    sessionId: req.agent.session.id,
    purpose: "approval-auto"
  };
  if (req.signal) options.signal = req.signal;

  const stream = await llm.stream(options);
  let text = "";
  let finish = { kind: "stop" };
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== "object") continue;
    if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
    else if (chunk.type === "finish") finish = chunk.reason || { kind: "stop" };
  }
  if (finish.kind === "aborted") return req.signal && req.signal.aborted ? "cancelled" : undefined;
  if (finish.kind !== "stop" && finish.kind !== "max-tokens") return undefined;
  if (/REJECT/i.test(text)) return "rejected";
  if (/ALLOW/i.test(text)) return "allowed-once";
  return undefined;
}

return {
  name: "approve-for-me",
  inject: ["approval", "llm"],
  apply(ctx) {
    ctx.on("approval/request", async (req, next) => {
      try {
        if (!req || !req.agent || !req.agent.session) return next();
        if (req.signal && req.signal.aborted) return "cancelled";
        const action = actionText(req);
        if (isHighRisk(action) || isHighRisk(req.reason)) return next();
        const llm = ctx.llm;
        if (!llm) return next();
        const outcome = await judgeWithLlm(req, llm, action);
        if (outcome === undefined) return next();
        return outcome;
      } catch (_) {
        return next();
      }
    }, { prepend: true });
  }
};
