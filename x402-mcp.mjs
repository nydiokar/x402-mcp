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
    const res = await fetchWithPayment(url, {
      method,
      ...(body ? { body } : {}),
    });
    const text = await res.text();
    return {
      content: [{ type: "text", text: `HTTP ${res.status}\n\n${text}` }],
    };
  }
);

await server.connect(new StdioServerTransport());
