import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const BASE_URL = (process.env.AGENTGATE_BASE_URL ?? "https://agentgate.eu").replace(/\/$/, "");
const API_KEY = process.env.AGENTGATE_API_KEY;

if (!API_KEY) {
  process.stderr.write("AgentGate MCP: AGENTGATE_API_KEY is not set. Add it to your Claude Desktop config.\n");
  process.exit(1);
}

async function api(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };

  // v1 POST endpoints require an idempotency key
  if (method === "POST" && path.startsWith("/api/v1/")) {
    headers["Idempotency-Key"] = randomUUID();
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error(`AgentGate HTTP ${res.status}`);
  }

  if (!res.ok) {
    // API returns { error: { code, message } }
    const err = data as { error?: { code?: string; message?: string } | string };
    const errObj = err?.error;
    const msg =
      typeof errObj === "string" ? errObj :
      typeof errObj === "object" && errObj !== null ? (errObj.message ?? errObj.code ?? JSON.stringify(errObj)) :
      `AgentGate HTTP ${res.status}`;
    throw new Error(msg);
  }

  return data as Record<string, unknown>;
}

function formatStatus(intent: Record<string, unknown>): string {
  const amount = ((intent.amountMinor as number) / 100).toFixed(2);
  const currency = intent.currency as string;
  const beneficiary = intent.beneficiaryName as string;

  const lines = [
    `ID: ${intent.id}`,
    `Montant: ${amount} ${currency} → ${beneficiary}`,
    `Statut: ${intent.status}`,
  ];

  if (intent.decisionReason) lines.push(`Motif: ${intent.decisionReason}`);
  if (intent.matchedPolicyName) lines.push(`Règle déclenchée: ${intent.matchedPolicyName}`);

  return lines.join("\n");
}

const server = new McpServer({
  name: "agentgate",
  version: "1.2.0",
});

// ─── Tool 0: get_info ─────────────────────────────────────────────────────
server.tool(
  "get_info",
  "Vérifie que la connexion à AgentGate fonctionne et retourne le nom de l'assistant IA et de l'organisation connectée.",
  {},
  async () => {
    const info = await api("GET", "/api/v1/me");
    const agent = info.agent as Record<string, unknown>;
    const org = info.organization as Record<string, unknown>;
    const lines = [
      `✅ Connexion AgentGate établie`,
      `Organisation : ${org.name}`,
      `Assistant : ${agent.name}${agent.sandbox ? " (mode sandbox)" : ""}`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ─── Tool 1: submit_payment ────────────────────────────────────────────────
server.tool(
  "submit_payment",
  [
    "Soumet une demande de paiement à AgentGate pour autorisation.",
    "Retourne le statut immédiat : APPROVED (approuvé automatiquement), REJECTED (refusé), ou PENDING_HUMAN_REVIEW (en attente de validation humaine).",
    "IMPORTANT : n'effectuez jamais un paiement sans avoir soumis une demande via cet outil et reçu APPROVED.",
  ].join(" "),
  {
    amount_minor: z.number().int().positive().describe("Montant en centimes (ex: 1000 = 10,00 €)"),
    currency: z.string().length(3).describe("Code devise ISO 4217 (ex: EUR, USD)"),
    beneficiary_name: z.string().min(1).describe("Nom du destinataire du paiement"),
    beneficiary_account: z.string().min(1).describe("Identifiant du compte destinataire (IBAN, email, identifiant)"),
    category: z.string().min(1).describe("Catégorie du paiement (ex: saas, invoice, salary, supplier, test)"),
    memo: z.string().optional().describe("Description facultative du motif du paiement"),
  },
  async ({ amount_minor, currency, beneficiary_name, beneficiary_account, category, memo }) => {
    const intent = await api("POST", "/api/v1/payment-intents", {
      amount_minor,
      currency,
      beneficiary: { name: beneficiary_name, account_identifier: beneficiary_account },
      category,
      ...(memo ? { memo } : {}),
    });

    let summary: string;
    if (intent.status === "APPROVED") {
      summary = "✅ APPROUVÉ — le paiement a été accepté automatiquement par vos règles.";
    } else if (intent.status === "REJECTED") {
      summary = `❌ REFUSÉ — la demande a été rejetée. Motif : ${intent.decisionReason ?? "violation de règle"}.`;
    } else if (intent.status === "PENDING_HUMAN_REVIEW") {
      summary = "⏳ EN ATTENTE — une validation humaine est requise. L'utilisateur doit approuver cette demande dans son tableau de bord AgentGate. Utilisez wait_for_decision pour attendre sa réponse.";
    } else {
      summary = `Statut : ${intent.status}`;
    }

    return {
      content: [{ type: "text", text: `Demande soumise.\n${formatStatus(intent)}\n\n${summary}` }],
    };
  }
);

// ─── Tool 2: get_payment_status ────────────────────────────────────────────
server.tool(
  "get_payment_status",
  "Récupère le statut actuel d'une demande de paiement à partir de son ID.",
  {
    payment_id: z.string().describe("L'ID de la demande de paiement retourné par submit_payment"),
  },
  async ({ payment_id }) => {
    const intent = await api("GET", `/api/v1/payment-intents/${payment_id}`);
    return { content: [{ type: "text", text: formatStatus(intent) }] };
  }
);

// ─── Tool 3: wait_for_decision ─────────────────────────────────────────────
server.tool(
  "wait_for_decision",
  "Attend qu'une demande de paiement en attente de validation humaine soit approuvée ou refusée. À utiliser après submit_payment quand le statut retourné est PENDING_HUMAN_REVIEW.",
  {
    payment_id: z.string().describe("L'ID de la demande à surveiller"),
    timeout_seconds: z.number().int().min(10).max(600).default(120).describe("Délai d'attente maximum en secondes (défaut : 120)"),
  },
  async ({ payment_id, timeout_seconds }) => {
    const deadline = Date.now() + timeout_seconds * 1000;

    while (Date.now() < deadline) {
      const intent = await api("GET", `/api/v1/payment-intents/${payment_id}`);
      const status = intent.status as string;

      if (status === "APPROVED") {
        return { content: [{ type: "text", text: `✅ APPROUVÉ — vous pouvez procéder.\n${formatStatus(intent)}` }] };
      }
      if (status === "REJECTED") {
        return { content: [{ type: "text", text: `❌ REFUSÉ — la demande a été rejetée.\n${formatStatus(intent)}` }] };
      }
      if (status === "CANCELLED") {
        return { content: [{ type: "text", text: `🚫 ANNULÉ — la demande a été annulée.\n${formatStatus(intent)}` }] };
      }

      await new Promise((r) => setTimeout(r, 5000));
    }

    return {
      content: [{ type: "text", text: `⏱ Délai dépassé — la demande ${payment_id} est toujours en attente après ${timeout_seconds}s. Vérifiez votre tableau de bord AgentGate pour approuver ou refuser, puis appelez get_payment_status.` }],
    };
  }
);

// ─── Tool 4: cancel_payment ────────────────────────────────────────────────
server.tool(
  "cancel_payment",
  "Annule une demande de paiement en attente.",
  {
    payment_id: z.string().describe("L'ID de la demande à annuler"),
  },
  async ({ payment_id }) => {
    const intent = await api("POST", `/api/v1/payment-intents/${payment_id}/cancel`);
    return { content: [{ type: "text", text: `Demande ${intent.id} annulée.` }] };
  }
);

// ─── Start ─────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
