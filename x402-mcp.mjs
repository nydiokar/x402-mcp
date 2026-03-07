import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";

const privateKeyBase58 = process.env.SOLANA_PRIVATE_KEY;
if (!privateKeyBase58) {
  console.error("SOLANA_PRIVATE_KEY env var is required");
  process.exit(1);
}

const keyBytes = base58.decode(privateKeyBase58);
const signer = await createKeyPairSignerFromBytes(keyBytes);

// Subclass ExactSvmScheme to default feePayer to the agent's own address
// when the server doesn't provide one (agent pays its own SOL tx fees).
class AgentExactSvmScheme extends ExactSvmScheme {
  async createPaymentPayload(x402Version, paymentRequirements, context) {
    const req = {
      ...paymentRequirements,
      extra: {
        feePayer: signer.address,
        ...paymentRequirements.extra,
      },
    };
    return super.createPaymentPayload(x402Version, req, context);
  }
}

const client = new x402Client();
client.register("solana:*", new AgentExactSvmScheme(signer));
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

// Derive the base URL (scheme+host+port) from a full URL string.
function baseUrl(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

// Poll a job until completed/failed, then return the result key to fetch.
async function pollJob(base, jobId, authHeaders, pollIntervalMs = 5000) {
  const monitorUrl = `${base}/api/v1/jobs/${jobId}`;
  while (true) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const res = await fetchWithPayment(monitorUrl, { headers: authHeaders });
    const json = await res.json();
    if (json.status === "completed") return json;
    if (json.status === "failed") throw new Error(`Job ${jobId} failed`);
    // still active — keep polling
  }
}

const server = new McpServer({ name: "x402-wallet", version: "1.0.0" });

server.registerTool(
  "fetch_with_payment",
  {
    description:
      "Fetch a URL. If the server responds with HTTP 402 Payment Required, automatically constructs and sends a Solana payment, then retries the request.",
    inputSchema: {
      url: z.string().describe("The URL to fetch"),
      method: z.string().default("GET").describe("HTTP method"),
      body: z.string().optional().describe("Request body (optional)"),
    },
  },
  async ({ url, method, body }) => {
    const headers = {};
    if (body) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetchWithPayment(url, {
      method,
      headers,
      ...(body ? { body } : {}),
    });

    // Handle 202 — async job queued. Poll until done, then fetch result.
    // Note: batch-hud always returns 200 (even with queued[] inside); 202 is only for:
    //   - GET /intel/wallet/:addr (cold wallet) → poll → re-GET same URL
    //   - POST /intel/token/:mint/holders       → poll → by-key holder-profiles:result:<requestId>
    //   - POST /intel/wallets/similarity        → poll → by-key similarity:result:<requestId>
    //   - POST /intel/token/:mint/holders/deep  → poll both → by-key each
    if (res.status === 202) {
      const data = await res.json();
      const base = baseUrl(url);

      // Bundled deep endpoint: { holderProfiles: { jobId, requestId }, similarity: { jobId, requestId } }
      if (data.holderProfiles || data.similarity) {
        const polls = [];
        if (data.holderProfiles?.jobId)
          polls.push(pollJob(base, data.holderProfiles.jobId, {}));
        if (data.similarity?.jobId)
          polls.push(pollJob(base, data.similarity.jobId, {}));
        await Promise.all(polls);

        const parts = [];
        if (data.holderProfiles?.requestId) {
          const key = `holder-profiles:result:${data.holderProfiles.requestId}`;
          const r = await fetchWithPayment(
            `${base}/api/v1/jobs/result/by-key?key=${encodeURIComponent(key)}`,
            {}
          );
          parts.push(`holderProfiles (${r.status}):\n${await r.text()}`);
        }
        if (data.similarity?.requestId) {
          const key = `similarity:result:${data.similarity.requestId}`;
          const r = await fetchWithPayment(
            `${base}/api/v1/jobs/result/by-key?key=${encodeURIComponent(key)}`,
            {}
          );
          parts.push(`similarity (${r.status}):\n${await r.text()}`);
        }
        return {
          content: [{ type: "text", text: parts.join("\n\n---\n\n") }],
        };
      }

      // Single job: { jobId, requestId, monitoringUrl }
      if (data.jobId) {
        const { jobId, requestId } = data;
        await pollJob(base, jobId, {});

        // GET /intel/wallet/:addr cold flow — re-call the original URL
        if (url.includes("/intel/wallet/") && !url.includes("/hud") && !url.includes("/tokens")) {
          const retry = await fetchWithPayment(url, { method: "GET" });
          const text = await retry.text();
          return {
            content: [{ type: "text", text: `HTTP ${retry.status}\n\n${text}` }],
          };
        }

        // POST holders or similarity — fetch result by key
        const jobType = url.includes("/similarity") ? "similarity" : "holder-profiles";
        const key = `${jobType}:result:${requestId}`;
        const resultRes = await fetchWithPayment(
          `${base}/api/v1/jobs/result/by-key?key=${encodeURIComponent(key)}`,
          {}
        );
        const text = await resultRes.text();
        return {
          content: [{ type: "text", text: `HTTP ${resultRes.status}\n\n${text}` }],
        };
      }

      // Unknown 202 shape — return raw so the caller can see what happened
      return {
        content: [{ type: "text", text: `HTTP 202\n\n${JSON.stringify(data, null, 2)}` }],
      };
    }

    // Handle 200 with queued[] inside (batch-hud) — return as-is, caller decides whether to re-poll
    // The huds map already has whatever was ready; queued[] lists wallets still being analyzed.

    const text = await res.text();
    return {
      content: [{ type: "text", text: `HTTP ${res.status}\n\n${text}` }],
    };
  }
);

await server.connect(new StdioServerTransport());
