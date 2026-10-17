import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { log, logError, logWarn, withCorrelation } from "../logger.server";
import {
  syncProductToDestination,
  type WebhookProduct,
} from "../product-sync.server";
import {
  fetchSourceProductExtras,
  type SourceProductExtras,
} from "../source-product.server";

export const action = async ({ request }: ActionFunctionArgs) =>
  withCorrelation(async () => {
    const { topic, shop, payload, admin } = await authenticate.webhook(request);
    const product = payload as WebhookProduct;

    log("webhook", `received ${topic}`, { shop, product: product.id });

    try {
      const extras = await loadSourceExtras(admin, product.id);
      const result = await syncProductToDestination(product, "create", extras);

      log("webhook", `${topic} handled`, {
        product: product.id,
        action: result?.action ?? "skipped",
      });

      return new Response(null, { status: 200 });
    } catch (error) {
      logError("webhook", `${topic} failed`, {
        shop,
        product: product.id,
        error: String(error),
      });
      return new Response(null, { status: 500 });
    }
  });

async function loadSourceExtras(
  admin: Parameters<typeof fetchSourceProductExtras>[0] | undefined,
  productId: number | string | undefined,
): Promise<SourceProductExtras | null> {
  if (!admin || productId === undefined) {
    logWarn("webhook", "no admin session; skipping source extras", {
      product: productId,
    });
    return null;
  }

  try {
    return await fetchSourceProductExtras(admin, productId);
  } catch (error) {
    logWarn("webhook", "could not read source extras; continuing without them", {
      product: productId,
      error: String(error),
    });
    return null;
  }
}
