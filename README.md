# mcp-x402

MCP server that gives Claude Code a `fetch_with_payment` tool. Automatically handles HTTP 402 responses by constructing a Solana payment and retrying.

## Setup

Add to `~/.claude/settings.json` (or `.claude/settings.json` in your project):

```json
{
  "mcpServers": {
    "x402-wallet": {
      "command": "node",
      "args": ["C:/Users/YOUR_USERNAME/mcp-x402/x402-mcp.mjs"],
      "env": {
        "SOLANA_PRIVATE_KEY": "<your 88-char base58 keypair>"
      }
    }
  }
}
```

The private key must be a **64-byte Ed25519 keypair** encoded as base58 — the format exported by `solana-keygen` (88 chars). Not just a 32-byte private key.

## Test your 402 server first

```bash
SOLANA_PRIVATE_KEY="<key>" node -e "
import('@x402/fetch').then(async ({ wrapFetchWithPayment, x402Client }) => {
  const { registerExactSvmScheme } = await import('@x402/svm/exact/client');
  const { createKeyPairSignerFromBytes } = await import('@solana/kit');
  const { base58 } = await import('@scure/base');
  const signer = await createKeyPairSignerFromBytes(base58.decode(process.env.SOLANA_PRIVATE_KEY));
  const client = new x402Client();
  registerExactSvmScheme(client, { signer });
  const fetch402 = wrapFetchWithPayment(fetch, client);
  const res = await fetch402('http://localhost:3000/your-endpoint');
  console.log(res.status, await res.text());
});
"
```
