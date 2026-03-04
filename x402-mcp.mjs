import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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

const server = new Server(
  { name: "x402-wallet", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "fetch_with_payment",
      description:
        "Fetch a URL. If the server responds with HTTP 402 Payment Required, automatically constructs and sends a Solana payment, then retries the request.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch" },
          method: { type: "string", description: "HTTP method", default: "GET" },
          body: { type: "string", description: "Request body (optional)" },
        },
        required: ["url"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "fetch_with_payment") {
    throw new Error(`Unknown tool: ${req.params.name}`);
  }

  const { url, method = "GET", body } = req.params.arguments;

  const res = await fetchWithPayment(url, {
    method,
    ...(body ? { body } : {}),
  });

  const text = await res.text();
  return {
    content: [{ type: "text", text: `HTTP ${res.status}\n\n${text}` }],
  };
});

await server.connect(new StdioServerTransport());
