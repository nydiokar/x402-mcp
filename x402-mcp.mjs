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
      "Fetch a URL using HTTP with automatic x402 payment handling. " +
      "If the server responds with HTTP 402 Payment Required, automatically constructs and sends a Solana USDC payment, then retries the request. " +
      "Returns the raw HTTP status and response body so you can decide what to do next. " +
      "For async APIs that return HTTP 202, read the response body for jobId/monitoringUrl and poll separately.",
    inputSchema: {
      url: z.string().describe("The full URL to fetch"),
      method: z.string().default("GET").describe("HTTP method (GET, POST, etc.)"),
      body: z.string().optional().describe("Request body as a string (for POST/PUT). Will set Content-Type: application/json automatically."),
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

    const text = await res.text();
    return {
      content: [{ type: "text", text: `HTTP ${res.status}\n\n${text}` }],
    };
  }
);

await server.connect(new StdioServerTransport());
