# @winsznx/lend402

Lend402 AI Agent SDK — x402 V2 JIT micro-lending interceptor for AI agents on Stacks.

When a paywalled API responds with HTTP 402, the interceptor automatically:

1. Parses the x402 V2 payment challenge
2. Calls `simulate-borrow` on the lend402-vault (read-only pre-flight)
3. Builds a `borrow-and-pay` Stacks contract-call transaction
4. Signs it with the agent's private key (`PostConditionMode.Deny`)
5. Base64-encodes the signed payload into the `payment-signature` header
6. Retries the original request — transparently, in a single `await`

## Install

```bash
npm install @winsznx/lend402
```

## Usage

```typescript
import { withPaymentInterceptor, mainnetConfig } from "@winsznx/lend402";
import { StacksMainnet } from "@stacks/network";

const agent = withPaymentInterceptor({
  ...mainnetConfig(),
  privateKey: process.env.AGENT_PRIVATE_KEY!,
  agentAddress: "SP1AGENT...",
  vaultContractAddress: "SP3VAULT...",
  vaultContractName: "lend402-vault",
  onEvent: (event) => console.log(event.type, event.data),
});

// Automatically pays any HTTP 402 via JIT borrow
const { data } = await agent.get("https://api.dataprovider.com/premium");
```

## API

### `withPaymentInterceptor(config, axiosConfig?)`

Creates a pre-configured Axios instance with the Lend402 interceptor attached.

### `mainnetConfig()`

Returns network-specific defaults for Stacks mainnet (`stacks:1`):
- `network`: `StacksMainnet`
- `caip2Network`: `"stacks:1"`
- `sbtcContractAddress` / `sbtcContractName`
- `usdcxContractAddress` / `usdcxContractName`

Spread into your `AgentClientConfig` and provide `privateKey`, `agentAddress`, and vault contract details.

### `testnetConfig()`

Same as `mainnetConfig()` but for Stacks testnet (`stacks:2147483648`).

## `AgentClientConfig`

| Field | Type | Description |
|---|---|---|
| `privateKey` | `string` | Agent's Stacks private key (hex, 32 bytes) |
| `agentAddress` | `string` | Agent's Stacks address |
| `network` | `StacksNetwork` | Stacks network instance |
| `caip2Network` | `Caip2NetworkId` | `"stacks:1"` or `"stacks:2147483648"` |
| `vaultContractAddress` | `string` | Deployed lend402-vault contract address |
| `vaultContractName` | `string` | lend402-vault contract name |
| `sbtcContractAddress` | `string` | sBTC SIP-010 contract address |
| `sbtcContractName` | `string` | sBTC token contract name |
| `usdcxContractAddress` | `string` | USDCx SIP-010 contract address |
| `usdcxContractName` | `string` | USDCx token contract name |
| `timeoutMs?` | `number` | Axios timeout in ms (default: 30000) |
| `maxPaymentRetries?` | `number` | Max 402 retries (default: 1) |
| `onEvent?` | `(event: AgentEvent) => void` | Real-time event callback |

## Error handling

The interceptor throws if the borrow or signing fails. The vault's `PostConditionMode.Deny` guarantee means no funds move on a failed transaction — the agent's treasury is unchanged.

```typescript
import { withPaymentInterceptor, mainnetConfig } from "@winsznx/lend402";

const agent = withPaymentInterceptor({
  ...mainnetConfig(),
  privateKey: process.env.AGENT_PRIVATE_KEY!,
  agentAddress: process.env.AGENT_ADDRESS!,
  vaultContractAddress: "SP3VAULT...",
  vaultContractName: "lend402-vault",
  onEvent: (event) => {
    if (event.type === "PAYMENT_CONFIRMED") {
      console.log("Settled:", event.data.txid);
    }
    if (event.type === "ERROR") {
      console.error("Agent error:", event.data.message);
    }
  },
});

try {
  const { data } = await agent.get("https://api.dataprovider.com/premium");
} catch (err) {
  // Payment failed — either insufficient sBTC collateral for the required
  // ratio, or the transaction was aborted on-chain by PostConditionMode.DENY.
  // The agent's treasury is unchanged. Inspect err.message for the stage
  // that failed: simulate-borrow, tx build, or the retried request itself.
  console.error(err);
}
```

### Event lifecycle

| Event type | When it fires |
|---|---|
| `REQUEST_SENT` | Every outbound request |
| `PAYMENT_REQUIRED_RECEIVED` | 402 intercepted, challenge parsed |
| `SIMULATE_BORROW_OK` | Collateral requirement confirmed |
| `TX_BUILT` | `borrow-and-pay` tx built and signed |
| `TX_SIGNED` | Serialized, txid computed |
| `PAYMENT_HEADER_ATTACHED` | `payment-signature` header encoded |
| `REQUEST_RETRIED` | Original request retried with payment |
| `PAYMENT_CONFIRMED` | `payment-response` header received |
| `DATA_RETRIEVED` | Origin response body forwarded to caller |
| `ERROR` | Any stage failure — treasury unchanged |

## License

MIT
