// =============================================================================
// @winsznx/lend402 — types.ts
// All public types for the Lend402 Agent SDK.
// =============================================================================

import type {
  PaymentPayloadV2,
  PaymentRequiredV2,
  PaymentRequirementsV2,
  ResourceInfo,
  SettlementResponseV2,
} from "x402-stacks";
import type { StacksNetwork } from "@stacks/network";

// ---------------------------------------------------------------------------
// Network identifiers
// ---------------------------------------------------------------------------

export type Caip2NetworkId = "stacks:1" | "stacks:2147483648";

export type PaymentScheme = "exact";

// ---------------------------------------------------------------------------
// x402 V2 protocol shapes
// ---------------------------------------------------------------------------

/** Single payment option within a 402 challenge body */
export interface PaymentOption
  extends Omit<PaymentRequirementsV2, "scheme" | "network"> {
  scheme: PaymentScheme;
  network: Caip2NetworkId;
}

/** x402 V2 HTTP 402 response body */
export interface PaymentRequiredBody
  extends Omit<PaymentRequiredV2, "accepts" | "resource"> {
  x402Version: 2;
  resource: ResourceInfo;
  accepts: PaymentOption[];
}

/** Decoded content of the payment-signature request header */
export interface XPaymentHeader extends Omit<PaymentPayloadV2, "accepted"> {
  x402Version: 2;
  accepted: PaymentOption;
  payload: {
    transaction: string;
  };
}

/** Decoded content of the payment-response response header */
export interface XPaymentResponse extends SettlementResponseV2 {
  network: Caip2NetworkId;
  transaction: string;
  blockHeight: number;
  confirmedAt: number;
}

// ---------------------------------------------------------------------------
// Agent SDK configuration
// ---------------------------------------------------------------------------

/** Configuration for the Lend402 payment interceptor */
export interface AgentClientConfig {
  /** Agent's Stacks private key (hex, 32 bytes) */
  privateKey: string;
  /** Agent's Stacks address */
  agentAddress: string;
  /** Stacks network to use */
  network: StacksNetwork;
  /** CAIP-2 network identifier */
  caip2Network: Caip2NetworkId;
  /** Deployed lend402-vault contract address */
  vaultContractAddress: string;
  /** lend402-vault contract name */
  vaultContractName: string;
  /** sBTC SIP-010 contract address */
  sbtcContractAddress: string;
  /** sBTC token contract name */
  sbtcContractName: string;
  /** USDCx SIP-010 contract address */
  usdcxContractAddress: string;
  /** USDCx token contract name */
  usdcxContractName: string;
  /** Optional: override axios instance timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Optional: maximum retries on 402 (default: 1 — retry exactly once) */
  maxPaymentRetries?: number;
  /** Optional: callback for real-time event streaming */
  onEvent?: (event: AgentEvent) => void;
}

/** Structured event emitted at each stage of the JIT loan lifecycle */
export interface AgentEvent {
  type:
    | "REQUEST_SENT"
    | "PAYMENT_REQUIRED_RECEIVED"
    | "SIMULATE_BORROW_OK"
    | "TX_BUILT"
    | "TX_SIGNED"
    | "PAYMENT_HEADER_ATTACHED"
    | "REQUEST_RETRIED"
    | "PAYMENT_CONFIRMED"
    | "DATA_RETRIEVED"
    | "ERROR";
  timestamp: number;
  data: Record<string, unknown>;
}
