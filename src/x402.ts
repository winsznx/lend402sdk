// =============================================================================
// @winsznx/lend402 — x402.ts
// x402 V2 protocol helpers required by the payment interceptor.
// Server-side helpers (buildPaymentRequiredBody, buildPaymentResponseHeader)
// are intentionally excluded — this file is agent/client-side only.
// =============================================================================

import {
  decodePaymentRequired,
  decodePaymentResponse,
  encodePaymentPayload,
  X402_HEADERS,
} from "x402-stacks";
import type {
  PaymentRequiredBody,
  PaymentOption,
  XPaymentHeader,
  XPaymentResponse,
} from "./types";
import { normalizeTxid } from "./network";

export const PAYMENT_REQUIRED_HEADER = X402_HEADERS.PAYMENT_REQUIRED;
export const PAYMENT_SIGNATURE_HEADER = X402_HEADERS.PAYMENT_SIGNATURE;
export const PAYMENT_RESPONSE_HEADER = X402_HEADERS.PAYMENT_RESPONSE;

export function parsePaymentRequiredHeader(encoded: string): PaymentRequiredBody {
  const decoded = decodePaymentRequired(encoded) as PaymentRequiredBody | null;

  if (!decoded || decoded.x402Version !== 2 || !Array.isArray(decoded.accepts)) {
    throw new Error("Malformed payment-required header");
  }

  return decoded;
}

export interface BuildPaymentSignatureHeaderOptions {
  resource: PaymentRequiredBody["resource"];
  accepted: PaymentOption;
  signedTransactionHex: string;
  /**
   * x402 V2 `payment-identifier` extension.
   * Set to the Stacks txid (0x-prefixed) computed from the signed transaction.
   * The gateway cross-checks this against the txid it derives independently.
   */
  paymentIdentifier?: string;
}

/** Builds the base64-encoded value of the payment-signature request header. */
export function buildPaymentSignatureHeader(
  opts: BuildPaymentSignatureHeaderOptions
): string {
  const header: XPaymentHeader = {
    x402Version: 2,
    resource: opts.resource,
    accepted: opts.accepted,
    payload: {
      transaction: opts.signedTransactionHex,
    },
    ...(opts.paymentIdentifier && {
      extensions: { "payment-identifier": opts.paymentIdentifier },
    }),
  };

  return encodePaymentPayload(header);
}

/** Decodes the payment-response header. */
export function parsePaymentResponseHeader(encoded: string): XPaymentResponse {
  const decoded = decodePaymentResponse(encoded) as XPaymentResponse | null;

  if (!decoded || !decoded.transaction) {
    throw new Error("Malformed payment-response header");
  }

  return {
    ...decoded,
    transaction: normalizeTxid(decoded.transaction),
  };
}
