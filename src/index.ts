// =============================================================================
// @winsznx/lend402 — public API
// =============================================================================

export type {
  AgentClientConfig,
  AgentEvent,
  Caip2NetworkId,
  PaymentOption,
  PaymentRequiredBody,
  PaymentScheme,
  XPaymentHeader,
  XPaymentResponse,
} from "./types";

export {
  DEFAULT_DIA_ORACLE_CONTRACT,
  DEFAULT_SBTC_CONTRACT,
  DEFAULT_USDCX_CONTRACT,
  DIA_SBTC_PAIR,
  normalizeTxid,
  splitContractId,
} from "./network";

export type { Lend402Network } from "./network";

export {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  PAYMENT_RESPONSE_HEADER,
  buildPaymentSignatureHeader,
  parsePaymentRequiredHeader,
  parsePaymentResponseHeader,
} from "./x402";

export type { BuildPaymentSignatureHeaderOptions } from "./x402";

export { withPaymentInterceptor, mainnetConfig, testnetConfig } from "./interceptor";
