// =============================================================================
// @winsznx/lend402 — interceptor.ts
// Lend402 JIT Micro-Lending — AI Agent SDK
// x402 V2 Protocol / Stacks Nakamoto / Clarity 4
// =============================================================================
// This module wraps Axios with a 402 Payment Required interceptor.
// When a paywalled API rejects with 402, the interceptor:
//   1. Parses the JSON 402 response body to extract the payment challenge
//   2. Calls simulate-borrow (read-only) or falls back to a live DIA quote
//   3. Builds a Stacks contract-call to lend402-vault::borrow-and-pay
//   4. Signs the serialized transaction with the agent's private key
//   5. Base64-encodes the signed payload into payment-signature header (x402 V2)
//   6. Retries the original request with the header attached
// =============================================================================

import axios, {
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";
import {
  makeContractCall,
  uintCV,
  stringAsciiCV,
  principalCV,
  AnchorMode,
  PostConditionMode,
  FungibleConditionCode,
  createAssetInfo,
  makeContractFungiblePostCondition,
  makeStandardFungiblePostCondition,
  StacksTransaction,
  SignedContractCallOptions,
  txidFromData,
  callReadOnlyFunction,
  cvToJSON,
} from "@stacks/transactions";
import { StacksMainnet, StacksTestnet } from "@stacks/network";
import type { AgentClientConfig, AgentEvent, PaymentOption, PaymentRequiredBody } from "./types";
import {
  DEFAULT_DIA_ORACLE_CONTRACT,
  DEFAULT_SBTC_CONTRACT,
  DEFAULT_USDCX_CONTRACT,
  DIA_SBTC_PAIR,
  splitContractId,
} from "./network";
import {
  buildPaymentSignatureHeader,
  parsePaymentRequiredHeader,
  parsePaymentResponseHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} from "./x402";

// ---------------------------------------------------------------------------
// INTERNAL TYPES
// ---------------------------------------------------------------------------

interface SimulateBorrowResult {
  required_collateral_sbtc: bigint;
  origination_fee_usdcx: bigint;
  net_payment_usdcx: bigint;
  sbtc_price_usd8: bigint;
  usdcx_price_usd8: bigint;
  collateral_ratio_bps: bigint;
}

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 55_000;
const DEFAULT_MAX_RETRIES = 1;
const COLLATERAL_RATIO_BPS = 15_000n;
const PROTOCOL_FEE_BPS = 30n;
const USDCX_PRICE_USD8 = 100_000_000n;
const MAX_ORACLE_AGE_SECONDS = 60n;

// ---------------------------------------------------------------------------
// HELPER UTILITIES
// ---------------------------------------------------------------------------

function parseAmountUsdcx(option: PaymentOption): number {
  const explicitPrice = option.extra?.priceUsdcx;
  if (typeof explicitPrice === "number" && Number.isFinite(explicitPrice)) {
    return explicitPrice;
  }

  if (/^\d+$/.test(option.amount)) {
    return Number.parseInt(option.amount, 10);
  }

  return Math.round(Number.parseFloat(option.amount) * 1_000_000);
}

function getNetworkKey(
  caip2Network: AgentClientConfig["caip2Network"]
): "mainnet" | "testnet" {
  return caip2Network === "stacks:1" ? "mainnet" : "testnet";
}

function buildLiveBorrowPreview(
  amountUsdcx: bigint,
  sbtcPriceUsd8: bigint
): SimulateBorrowResult {
  const requiredUsdcxValue =
    (amountUsdcx * COLLATERAL_RATIO_BPS) / 10_000n;
  const collateralNumerator = requiredUsdcxValue * USDCX_PRICE_USD8 * 100n;
  const requiredCollateralSbtc =
    (collateralNumerator + sbtcPriceUsd8 - 1n) / sbtcPriceUsd8;
  const originationFeeUsdcx = (amountUsdcx * PROTOCOL_FEE_BPS) / 10_000n;

  return {
    required_collateral_sbtc: requiredCollateralSbtc,
    origination_fee_usdcx: originationFeeUsdcx,
    net_payment_usdcx: amountUsdcx - originationFeeUsdcx,
    sbtc_price_usd8: sbtcPriceUsd8,
    usdcx_price_usd8: USDCX_PRICE_USD8,
    collateral_ratio_bps: COLLATERAL_RATIO_BPS,
  };
}

async function getLiveSbtcPriceUsd8(config: AgentClientConfig): Promise<bigint> {
  const contractId =
    DEFAULT_DIA_ORACLE_CONTRACT[getNetworkKey(config.caip2Network)];
  const { address, name } = splitContractId(contractId);

  const result = await callReadOnlyFunction({
    contractAddress: address,
    contractName: name,
    functionName: "get-value",
    functionArgs: [stringAsciiCV(DIA_SBTC_PAIR)],
    network: config.network,
    senderAddress: config.agentAddress,
  });

  const json = cvToJSON(result);

  if (json.type !== "(ok tuple)" && !json.success) {
    throw new Error(`DIA get-value returned error: ${JSON.stringify(json)}`);
  }

  // cvToJSON wraps ok-tuple as { value: { type: "(tuple ...)", value: { fields } } }
  const inner = json.value as { value?: Record<string, { value: string }> };
  const fields: Record<string, { value: string }> = inner.value ?? (json.value as Record<string, { value: string }>);
  const priceUsd8 = BigInt(fields.value.value);
  const timestamp = BigInt(fields.timestamp.value);
  const now = BigInt(Math.floor(Date.now() / 1000));

  if (priceUsd8 <= 0n) {
    throw new Error("DIA oracle returned zero sBTC price");
  }

  if (now > timestamp && now - timestamp > MAX_ORACLE_AGE_SECONDS) {
    throw new Error("DIA oracle price is stale");
  }

  return priceUsd8;
}

function emit(
  onEvent: AgentClientConfig["onEvent"],
  type: AgentEvent["type"],
  data: Record<string, unknown>
): void {
  if (onEvent) {
    onEvent({ type, timestamp: Date.now(), data });
  }
}

// ---------------------------------------------------------------------------
// STACKS READ-ONLY: simulate-borrow
// ---------------------------------------------------------------------------

async function simulateBorrow(
  amountUsdcx: bigint,
  config: AgentClientConfig
): Promise<SimulateBorrowResult> {
  try {
    const result = await callReadOnlyFunction({
      contractAddress: config.vaultContractAddress,
      contractName: config.vaultContractName,
      functionName: "simulate-borrow",
      functionArgs: [uintCV(amountUsdcx)],
      network: config.network,
      senderAddress: config.agentAddress,
    });

    const json = cvToJSON(result);

    if (json.type !== "(ok tuple)" && !json.success) {
      throw new Error(
        `simulate-borrow returned error: ${JSON.stringify(json.value)}`
      );
    }

    // cvToJSON wraps ok-tuple as { value: { type: "(tuple ...)", value: { fields } } }
    const inner = json.value as { value?: Record<string, { value: string }> };
    const v: Record<string, { value: string }> = inner.value ?? (json.value as Record<string, { value: string }>);

    return {
      required_collateral_sbtc: BigInt(v["required-collateral-sbtc"].value),
      origination_fee_usdcx: BigInt(v["origination-fee-usdcx"].value),
      net_payment_usdcx: BigInt(v["net-payment-usdcx"].value),
      sbtc_price_usd8: BigInt(v["sbtc-price-usd8"].value),
      usdcx_price_usd8: BigInt(v["usdcx-price-usd8"].value),
      collateral_ratio_bps: BigInt(v["collateral-ratio-bps"].value),
    };
  } catch {
    const sbtcPriceUsd8 = await getLiveSbtcPriceUsd8(config);
    return buildLiveBorrowPreview(amountUsdcx, sbtcPriceUsd8);
  }
}

// ---------------------------------------------------------------------------
// STACKS TX BUILDER: borrow-and-pay
// ---------------------------------------------------------------------------

async function buildAndSignBorrowAndPay(
  amountUsdcx: bigint,
  merchantAddress: string,
  collateralSbtc: bigint,
  netPayment: bigint,
  config: AgentClientConfig
): Promise<StacksTransaction> {
  const sbtcAssetInfo = createAssetInfo(
    config.sbtcContractAddress,
    config.sbtcContractName,
    "sbtc-token"
  );

  const usdcxAssetInfo = createAssetInfo(
    config.usdcxContractAddress,
    config.usdcxContractName,
    "usdcx-token"
  );

  const txOptions: SignedContractCallOptions = {
    contractAddress: config.vaultContractAddress,
    contractName: config.vaultContractName,
    functionName: "borrow-and-pay",
    functionArgs: [
      uintCV(amountUsdcx),
      principalCV(merchantAddress),
      uintCV(collateralSbtc),
    ],
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Deny,
    postConditions: [
      makeStandardFungiblePostCondition(
        config.agentAddress,
        FungibleConditionCode.Equal,
        collateralSbtc,
        sbtcAssetInfo
      ),
      makeContractFungiblePostCondition(
        config.vaultContractAddress,
        config.vaultContractName,
        FungibleConditionCode.Equal,
        netPayment,
        usdcxAssetInfo
      ),
    ],
    senderKey: config.privateKey,
    network: config.network,
    fee: 2000n,
  };

  const tx = await makeContractCall(txOptions);
  return tx;
}

// ---------------------------------------------------------------------------
// THE INTERCEPTOR
// ---------------------------------------------------------------------------

function attachPaymentInterceptor(
  axiosInstance: AxiosInstance,
  config: AgentClientConfig
): void {
  const maxRetries = config.maxPaymentRetries ?? DEFAULT_MAX_RETRIES;

  axiosInstance.interceptors.response.use(
    (response: AxiosResponse) => {
      const paymentResponse = response.headers[PAYMENT_RESPONSE_HEADER];
      if (paymentResponse) {
        const pr = parsePaymentResponseHeader(paymentResponse);
        emit(config.onEvent, "PAYMENT_CONFIRMED", {
          txid: pr.transaction,
          block_height: pr.blockHeight,
          confirmed_at: pr.confirmedAt,
          payer: pr.payer,
        });
      }
      return response;
    },

    async (error: unknown) => {
      if (!axios.isAxiosError(error)) throw error;

      const originalRequest = error.config as InternalAxiosRequestConfig & {
        _paymentRetryCount?: number;
      };

      if (error.response?.status !== 402) throw error;

      const retryCount = originalRequest._paymentRetryCount ?? 0;
      if (retryCount >= maxRetries) {
        const settlementError =
          (error.response?.data as Record<string, unknown>)?.error;
        const detail = typeof settlementError === "string" ? `: ${settlementError}` : "";
        throw new Error(
          `Lend402: max payment retries (${maxRetries}) exceeded for ${originalRequest.url}${detail}`
        );
      }
      originalRequest._paymentRetryCount = retryCount + 1;

      // ── Stage 1: Parse the x402 V2 challenge ─────────────────────────────
      const header402 = error.response.headers[PAYMENT_REQUIRED_HEADER];
      const body402: PaymentRequiredBody = header402
        ? parsePaymentRequiredHeader(header402)
        : (error.response.data as PaymentRequiredBody);

      if (!body402 || body402.x402Version !== 2 || !Array.isArray(body402.accepts)) {
        throw new Error(
          "Lend402: 402 response body is not a valid x402 V2 PaymentRequiredBody"
        );
      }

      const option = body402.accepts.find(
        (o) => o.scheme === "exact" && o.network === config.caip2Network
      );
      if (!option) {
        throw new Error(
          `Lend402: no acceptable payment option for network ${config.caip2Network}`
        );
      }

      if (option.network !== config.caip2Network) {
        throw new Error(
          `Lend402: network mismatch — agent is on ${config.caip2Network}, merchant requires ${option.network}`
        );
      }

      const priceUsdcx = parseAmountUsdcx(option);

      emit(config.onEvent, "PAYMENT_REQUIRED_RECEIVED", {
        resource: body402.resource.url,
        amount_usdcx: priceUsdcx,
        merchant_address: option.payTo,
        network: option.network,
      });

      const amountUsdcx = BigInt(priceUsdcx);

      // ── Stage 2: Simulate borrow ──────────────────────────────────────────
      let simulation: SimulateBorrowResult;
      try {
        simulation = await simulateBorrow(amountUsdcx, config);
      } catch (simErr) {
        throw new Error(
          `Lend402: simulate-borrow failed: ${(simErr as Error).message}`
        );
      }

      emit(config.onEvent, "SIMULATE_BORROW_OK", {
        required_collateral_sbtc: simulation.required_collateral_sbtc.toString(),
        origination_fee_usdcx: simulation.origination_fee_usdcx.toString(),
        net_payment_usdcx: simulation.net_payment_usdcx.toString(),
        sbtc_price_usd8: simulation.sbtc_price_usd8.toString(),
        collateral_ratio_bps: simulation.collateral_ratio_bps.toString(),
      });

      // ── Stage 3: Build the contract-call transaction ──────────────────────
      // Add 1 sat buffer to absorb oracle price drift between simulation and
      // on-chain execution. The contract enforces max(passed, min_required),
      // so without a buffer a small price tick can cause a post-condition mismatch.
      const collateralSbtc = simulation.required_collateral_sbtc + 1n;

      let signedTx: StacksTransaction;
      try {
        signedTx = await buildAndSignBorrowAndPay(
          amountUsdcx,
          option.payTo,
          collateralSbtc,
          simulation.net_payment_usdcx,
          config
        );
      } catch (buildErr) {
        throw new Error(
          `Lend402: failed to build borrow-and-pay tx: ${(buildErr as Error).message}`
        );
      }

      emit(config.onEvent, "TX_BUILT", {
        amount_usdcx: amountUsdcx.toString(),
        collateral_sbtc: collateralSbtc.toString(),
        merchant: option.payTo,
      });

      // ── Stage 4: Serialize the signed transaction ─────────────────────────
      const serialized = Buffer.from(signedTx.serialize()).toString("hex");
      const txid = `0x${txidFromData(Buffer.from(serialized, "hex"))}`;

      emit(config.onEvent, "TX_SIGNED", {
        tx_hex_preview: serialized.slice(0, 32) + "…",
        byte_length: serialized.length / 2,
        payment_identifier: txid,
      });

      // ── Stage 5: Encode into payment-signature header (x402 V2) ──────────
      const encodedPayment = buildPaymentSignatureHeader({
        resource: body402.resource,
        accepted: option,
        signedTransactionHex: serialized,
        paymentIdentifier: txid,
      });

      emit(config.onEvent, "PAYMENT_HEADER_ATTACHED", {
        agent_address: config.agentAddress,
        resource: body402.resource.url,
      });

      // ── Stage 6: Retry original request ───────────────────────────────────
      if (!originalRequest.headers) {
        originalRequest.headers = {} as InternalAxiosRequestConfig["headers"];
      }
      originalRequest.headers[PAYMENT_SIGNATURE_HEADER] = encodedPayment;

      emit(config.onEvent, "REQUEST_RETRIED", {
        url: originalRequest.url,
        retry_count: originalRequest._paymentRetryCount,
      });

      return axiosInstance(originalRequest);
    }
  );
}

// ---------------------------------------------------------------------------
// PUBLIC FACTORY: withPaymentInterceptor
// ---------------------------------------------------------------------------

/**
 * Creates a pre-configured Axios instance with the Lend402 x402 payment
 * interceptor attached.
 *
 * @example
 * ```typescript
 * const agent = withPaymentInterceptor({
 *   ...mainnetConfig(),
 *   privateKey: process.env.AGENT_PRIVATE_KEY!,
 *   agentAddress: "SP1AGENT...",
 *   vaultContractAddress: "SP3VAULT...",
 *   vaultContractName: "lend402-vault",
 *   onEvent: (event) => console.log(event.type, event.data),
 * });
 *
 * const { data } = await agent.get("https://api.dataprovider.com/premium");
 * ```
 */
export function withPaymentInterceptor(
  config: AgentClientConfig,
  axiosConfig?: AxiosRequestConfig
): AxiosInstance {
  const instance = axios.create({
    timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...axiosConfig,
  });

  instance.interceptors.request.use((req: InternalAxiosRequestConfig) => {
    emit(config.onEvent, "REQUEST_SENT", { url: req.url, method: req.method });
    return req;
  });

  attachPaymentInterceptor(instance, config);
  return instance;
}

// ---------------------------------------------------------------------------
// NETWORK FACTORY HELPERS
// ---------------------------------------------------------------------------

type NetworkDefaults = Pick<
  AgentClientConfig,
  | "network"
  | "caip2Network"
  | "sbtcContractAddress"
  | "sbtcContractName"
  | "usdcxContractAddress"
  | "usdcxContractName"
>;

/**
 * Returns network-specific defaults for Stacks mainnet.
 * Spread into your `AgentClientConfig` and supply `privateKey`,
 * `agentAddress`, and vault contract details.
 */
export function mainnetConfig(): NetworkDefaults {
  const sbtc = splitContractId(DEFAULT_SBTC_CONTRACT.mainnet);
  const usdcx = splitContractId(DEFAULT_USDCX_CONTRACT.mainnet);

  return {
    network: new StacksMainnet(),
    caip2Network: "stacks:1",
    sbtcContractAddress: sbtc.address,
    sbtcContractName: sbtc.name,
    usdcxContractAddress: usdcx.address,
    usdcxContractName: usdcx.name,
  };
}

/**
 * Returns network-specific defaults for Stacks testnet.
 * Spread into your `AgentClientConfig` and supply `privateKey`,
 * `agentAddress`, and vault contract details.
 */
export function testnetConfig(): NetworkDefaults {
  const sbtc = splitContractId(DEFAULT_SBTC_CONTRACT.testnet);
  const usdcx = splitContractId(DEFAULT_USDCX_CONTRACT.testnet);

  return {
    network: new StacksTestnet(),
    caip2Network: "stacks:2147483648",
    sbtcContractAddress: sbtc.address,
    sbtcContractName: sbtc.name,
    usdcxContractAddress: usdcx.address,
    usdcxContractName: usdcx.name,
  };
}
